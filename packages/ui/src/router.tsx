import { createRootRoute, createRoute, createRouter, Link, lazyRouteComponent, Outlet } from '@tanstack/react-router';
import { isWindow, type TimeWindow } from '@/api/charts';
import { TopBar } from '@/components/app/top-bar';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { CsmsPage } from '@/routes/csms';
import { CsmsSessionPage } from '@/routes/csms-session';
import { FleetPage } from '@/routes/fleet';
import { StationPage } from '@/routes/station';

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
/** `?frame=<OCPP message id>`: open the exchange with that frame in the log. */
const frameSearch = (s: Record<string, unknown>): { frame?: string } => {
  const frame = str(s.frame);
  return frame === undefined ? {} : { frame };
};

const rootRoute = createRootRoute({
  component: () => (
    <div className="flex min-h-dvh flex-col">
      <TopBar />
      <Outlet />
    </div>
  ),
  notFoundComponent: () => (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>No page here</EmptyTitle>
        <EmptyDescription>This address is not part of the wattsim console.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link to="/">Go to the fleet</Link>
        </Button>
      </EmptyContent>
    </Empty>
  ),
});

const fleetRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: FleetPage });

export type StationSearch = { frame?: string; view?: 'telemetry'; window?: TimeWindow };

export const stationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'stations/$stationId',
  /** `view=telemetry` shows the charts instead of the controls; `window` their time range. */
  validateSearch: (s: Record<string, unknown>): StationSearch => {
    const out: StationSearch = frameSearch(s);
    if (s.view === 'telemetry') out.view = 'telemetry';
    if (isWindow(s.window)) out.window = s.window;
    return out;
  },
  component: StationPage,
});

export const scenariosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'scenarios',
  /** `scenario`: the saved scenario in the editor; `run`: the run shown on the right. */
  validateSearch: (s: Record<string, unknown>): { scenario?: string; run?: string } => {
    const out: { scenario?: string; run?: string } = {};
    const scenario = str(s.scenario);
    const run = str(s.run);
    if (scenario !== undefined) out.scenario = scenario;
    if (run !== undefined) out.run = run;
    return out;
  },
  // CodeMirror lives in its own chunk, loaded with the page.
  component: lazyRouteComponent(() => import('@/routes/scenarios'), 'ScenariosPage'),
});

export type CsmsSearch = { rule?: string; station?: string; from?: number; to?: number };

export const csmsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'csms',
  /** A filter on the finding list, set by clicking the findings charts. */
  validateSearch: (s: Record<string, unknown>): CsmsSearch => {
    const out: CsmsSearch = {};
    const rule = str(s.rule);
    const station = str(s.station);
    if (rule !== undefined) out.rule = rule;
    if (station !== undefined) out.station = station;
    const from = Number(s.from);
    const to = Number(s.to);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      out.from = from;
      out.to = to;
    }
    return out;
  },
  component: CsmsPage,
});

export const csmsSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'csms/sessions/$identity',
  validateSearch: frameSearch,
  component: CsmsSessionPage,
});

const routeTree = rootRoute.addChildren([fleetRoute, stationRoute, scenariosRoute, csmsRoute, csmsSessionRoute]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
