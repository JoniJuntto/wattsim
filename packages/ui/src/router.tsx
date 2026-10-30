import { createRootRoute, createRoute, createRouter, Link, Outlet } from '@tanstack/react-router';
import { TopBar } from '@/components/app/top-bar';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { FleetPage } from '@/routes/fleet';
import { StationPage } from '@/routes/station';

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
  component: StationPage,
});

const routeTree = rootRoute.addChildren([fleetRoute, stationRoute]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
