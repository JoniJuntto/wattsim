import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type {
  FindingsBinsView,
  FleetSeriesView,
  FleetStationsView,
  RunDetail,
  RunSummary,
  RunTimeline,
  ScheduleView,
  StationSeriesView,
  StationView,
} from '../src/types';
import { type Api, boot, StreamClient, until } from './helpers';

let api: Api;
let stream: StreamClient;
let csmsUrl: string;

beforeAll(async () => {
  api = await boot({ fleetBinMs: 50 });
  stream = await StreamClient.open(api.url);
  csmsUrl = ((await (await api.post('/api/loopback')).json()) as { url: string }).url;
});

afterAll(async () => {
  stream.close();
  await api.server.stop();
});

const json = async <T>(res: Response | Promise<Response>): Promise<T> => {
  const r = await res;
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
};
const act = (id: string, body: unknown) => api.post(`/api/stations/${id}/actions`, body);
const latest = (id: string): StationView | undefined =>
  stream
    .of('station')
    .filter((m) => m.station.id === id)
    .at(-1)?.station;

describe('time series endpoints', () => {
  test('a charging EVSE is sampled, streamed as series points and served downsampled', async () => {
    await api.post('/api/stations', {
      id: 'TS-1',
      version: 'ocpp1.6',
      csmsUrl,
      evses: 2,
      meterIntervalMs: 50,
      maxCurrentA: 16,
    });
    await until(() => latest('TS-1')?.booted === true, 3000, 'boot');
    await act('TS-1', { type: 'plug', evse: 1, ev: { batteryKwh: 40, soc: 0.2, targetSoc: 0.9 } });
    expect((await act('TS-1', { type: 'start', evse: 1 })).status).toBe(200);
    await until(() => latest('TS-1')?.evses[0]?.status === 'Charging', 2000, 'Charging');
    await until(
      () => stream.of('series').some((m) => m.stationId === 'TS-1' && m.points.some((p) => p.kw > 0)),
      2000,
      'a series point with power',
    );
    await Bun.sleep(400);

    const points = stream.of('series').flatMap((m) => (m.stationId === 'TS-1' ? m.points : []));
    const charging = points.filter((p) => p.evse === 1 && p.kw > 0);
    expect(charging.length).toBeGreaterThan(2);
    const p = charging.at(-1);
    expect(p?.status).toBe('Charging');
    expect(p?.a[0]).toBeGreaterThan(0);
    expect(p?.v).toEqual([230, 230, 230]);
    expect(p?.soc).toBeGreaterThan(0.19);
    expect(p?.targetSoc).toBe(0.9);
    expect(p?.offeredKw).toBeCloseTo(11.04, 2);

    const now = Date.now();
    const all = await json<StationSeriesView>(api.get(`/api/stations/TS-1/series?from=${now - 60_000}&to=${now}`));
    expect(all.step).toBe(0);
    expect(all.evses.map((e) => e.evse)).toEqual([1, 2]);
    const e1 = all.evses[0];
    expect(e1?.t.length).toBeGreaterThan(2);
    expect(e1?.status).toContain('Charging');
    // Energy only rises while charging.
    const wh = e1?.wh ?? [];
    for (let i = 1; i < wh.length; i++) expect(wh[i] as number).toBeGreaterThanOrEqual(wh[i - 1] as number);
    // The idle EVSE kept one sample.
    expect(all.evses[1]?.t.length).toBe(1);
    expect(all.fullResolutionFrom).toBeNull();

    const coarse = await json<StationSeriesView>(
      api.get(`/api/stations/TS-1/series?from=${new Date(now - 60_000).toISOString()}&to=${now}&step=30000`),
    );
    expect(coarse.step).toBe(30_000);
    expect(coarse.evses[0]?.t.length).toBeLessThanOrEqual(1 + 2 * 2);
    expect(Math.max(...(coarse.evses[0]?.kw ?? []))).toBe(Math.max(...(e1?.kw ?? [])));

    expect((await api.get('/api/stations/TS-1/series?from=10&to=5')).status).toBe(400);
    expect((await api.get('/api/stations/TS-1/series?step=-1')).status).toBe(400);
    expect((await api.get('/api/stations/nope/series')).status).toBe(404);
  });

  test('the composite schedule ahead follows a charging profile', async () => {
    const free = await json<ScheduleView>(api.get('/api/stations/TS-1/schedule?evse=1&duration=3600'));
    expect(free.profiles).toBe(0);
    expect(free.periods).toEqual([{ startS: 0, kw: free.ratedKw }]);
    expect(free.durationMs).toBe(3_600_000);
    const grid = await json<ScheduleView>(api.get('/api/stations/TS-1/schedule?evse=0'));
    expect(grid.evse).toBe(0);
    expect(grid.durationMs).toBe(86_400_000);
    expect(grid.ratedKw).toBeCloseTo(2 * 11.04, 2);
    expect((await api.get('/api/stations/TS-1/schedule?evse=9')).status).toBe(400);
    expect((await api.get('/api/stations/TS-1/schedule?duration=0')).status).toBe(400);
  });

  test('fleet bins and the per-station heatmap', async () => {
    await until(() => stream.of('fleet').length >= 3, 2000, 'fleet bins');
    const bin = stream.of('fleet').at(-1)?.bin;
    expect(bin?.stations).toBe(1);
    expect(bin?.counts.reduce((a, b) => a + b, 0)).toBe(2);
    const now = Date.now();
    const series = await json<FleetSeriesView>(api.get(`/api/fleet/series?from=${now - 10_000}&to=${now}`));
    expect(series.t.length).toBeGreaterThan(2);
    expect(series.statuses).toContain('Charging');
    expect(Math.max(...series.kw)).toBeGreaterThan(0);
    const charging = series.counts[series.statuses.indexOf('Charging')] ?? [];
    expect(charging.at(-1)).toBe(1);

    const power = await json<FleetStationsView>(
      api.get(`/api/fleet/stations?from=${now - 5_000}&to=${now}&bins=10&metric=power`),
    );
    const row = power.rows.find((r) => r.id === 'TS-1');
    expect(row?.values.length).toBe(10);
    expect(row?.energyWh).toBeGreaterThanOrEqual(0);
    expect(Math.max(...(row?.values.filter((v): v is number => v !== null) ?? [0]))).toBeGreaterThan(0);
    const status = await json<FleetStationsView>(
      api.get(`/api/fleet/stations?from=${now - 5_000}&to=${now}&bins=10&metric=status`),
    );
    const last = status.rows.find((r) => r.id === 'TS-1')?.values.at(-1);
    expect(status.statuses[last as number]).toBe('Charging');
    expect((await api.get('/api/fleet/stations?metric=nope')).status).toBe(400);
    expect((await api.get('/api/fleet/stations?bins=100000')).status).toBe(400);
  });

  test('test CSMS findings binned over time', async () => {
    const now = Date.now();
    const bins = await json<FindingsBinsView>(
      api.get(`/api/csms/findings/bins?from=${now - 120_000}&to=${now + 1}&step=60000`),
    );
    expect(bins.t.length).toBe(3);
    expect(bins.byRule.length).toBe(bins.rules.length);
    expect(bins.matrix.length).toBe(bins.stations.length);
    expect(bins.errors.reduce((a, b) => a + b, 0) + bins.warnings.reduce((a, b) => a + b, 0)).toBe(bins.total);
  });
});

describe('run timeline', () => {
  test('a virtual run has one lane per station with statuses, transactions and failed asserts', async () => {
    const source = `wattsim 1

station "TL-1" {
  version 1.6
  boot
  ev plug evse 1
  start evse 1
  wait 10min
  stop evse 1
  expect result BootNotification {status: "Rejected"} within 1s
}
`;
    const started = await json<RunSummary>(api.post('/api/runs', { source, name: 'timeline' }));
    let run: RunDetail | undefined;
    await until(
      () => {
        void json<RunDetail>(api.get(`/api/runs/${started.id}`)).then((r) => {
          run = r;
        });
        return run !== undefined && run.status !== 'running';
      },
      10_000,
      'run end',
    );
    const t = await json<RunTimeline>(api.get(`/api/runs/${started.id}/timeline`));
    expect(t.lanes.map((l) => l.station)).toEqual(['TL-1']);
    const lane = t.lanes[0];
    expect(lane?.result).toBe('failed');
    expect(lane?.statuses.map((s) => s.status)).toContain('Charging');
    expect(lane?.transactions.length).toBe(1);
    const tx = lane?.transactions[0];
    expect(tx?.open).toBe(false);
    // Virtual time: the 10 min wait is in the timeline although the run took far less.
    expect((tx?.to ?? 0) - (tx?.from ?? 0)).toBeGreaterThanOrEqual(10 * 60_000);
    expect(lane?.marks.some((m) => m.kind === 'assert')).toBe(true);
    expect(t.to).toBeGreaterThan(t.from);
    expect((await api.get('/api/runs/nope/timeline')).status).toBe(404);
  });
});
