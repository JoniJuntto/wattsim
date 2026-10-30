import './index.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/hooks/use-theme';
import { router } from '@/router';
import { LiveProvider } from '@/state/live';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

async function start() {
  // Dev-only fake server: `?mock` in the URL (remembered for the tab). Tree-shaken out of production builds.
  if (import.meta.env.DEV) {
    const params = new URLSearchParams(window.location.search);
    if (params.has('mock')) sessionStorage.setItem('wattsim-mock', '1');
    if (params.has('nomock')) sessionStorage.removeItem('wattsim-mock');
    if (sessionStorage.getItem('wattsim-mock')) {
      const { installMock } = await import('./dev/mock');
      installMock();
    }
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing from index.html');
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <LiveProvider>
            <TooltipProvider delayDuration={300}>
              <RouterProvider router={router} />
              <Toaster position="bottom-right" closeButton />
            </TooltipProvider>
          </LiveProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

void start();
