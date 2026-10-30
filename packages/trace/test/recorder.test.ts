import { afterEach, beforeEach, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { FakeCsms } from '../../core/test/fake-csms';
import type { TraceEntry } from '../src/index';
import { Recorder, readTrace } from '../src/index';
import { actionsOf, recordSession16, tmpPath } from './helpers';

const schema = await Bun.file(`${import.meta.dir}/../schemas/open-ocpp-trace/trace-v1.schema.json`).json();
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

let csms: FakeCsms;
beforeEach(async () => {
  csms = await FakeCsms.start();
});
afterEach(async () => {
  await csms.stop();
});

const comparable = (e: TraceEntry) => ({
  ts: e.ts,
  dir: e.dir,
  identity: e.identity,
  version: e.version,
  raw: e.raw,
  frame: e.frame,
});

test.each(['oot', 'frames'] as const)('a recorded Station session round-trips through a %s file', async (format) => {
  const path = await tmpPath(`session.${format}.jsonl`);
  const recorder = new Recorder({ path, format });
  const { entries } = await recordSession16(csms.url, (id) => csms.call(id, 'GetConfiguration', {}), { recorder });
  await recorder.close();

  expect(actionsOf(entries, 'out')).toEqual([
    'BootNotification',
    'StatusNotification',
    'Authorize',
    'StatusNotification',
    'StartTransaction',
    'StatusNotification',
    'MeterValues',
    'StopTransaction',
    'StatusNotification',
    'StatusNotification',
  ]);
  expect(actionsOf(entries, 'in')).toEqual(['GetConfiguration']);
  // Every frame the CSMS saw is in the recording, in order.
  expect(entries.filter((e) => e.dir === 'out').map((e) => e.frame)).toEqual(csms.received);
  expect(entries.filter((e) => e.dir === 'in').map((e) => e.frame)).toEqual(csms.sent);
  expect(recorder.skipped).toBe(0);

  const back = await readTrace(path);
  expect(back.map(comparable)).toEqual(entries.map(comparable));
  expect(back.map((e) => e.line)).toEqual(entries.map((_, i) => i + 1));
  if (format === 'oot') {
    const text = await Bun.file(path).text();
    for (const line of text.split('\n').filter(Boolean)) expect(validate(JSON.parse(line))).toBe(true);
  }
});

test('responses in the Open OCPP Trace file carry the action of their CALL', async () => {
  const path = await tmpPath('actions.jsonl');
  const recorder = new Recorder({ path });
  await recordSession16(csms.url, (id) => csms.call(id, 'GetConfiguration', {}), { recorder });
  await recorder.close();
  const records = (await Bun.file(path).text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const getConfigResult = records.find((r) => r.messageType === 'CALLRESULT' && r.direction === 'cp-to-csms');
  expect(getConfigResult.action).toBe('GetConfiguration');
  expect(records.every((r) => r.chargePointId === 'CP-REC' && r.ocppVersion === '1.6')).toBe(true);
});
