import { createRootRoute, createRoute, createRouter, Link, lazyRouteComponent, Outlet } from '@tanstack/react-router';
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

export const stationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'stations/$stationId',
  validateSearch: frameSearch,
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

export const csmsRoute = createRoute({ getParentRoute: () => rootRoute, path: 'csms', component: CsmsPage });

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
