import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import StaticSearchDialog from '@/components/search';

export const metadata: Metadata = {
  title: { template: '%s | wattsim', default: 'wattsim' },
  description:
    'A spec-strict, scriptable OCPP 1.6/2.0.1/2.1 simulator with deterministic fault injection and realistic EV physics.',
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider search={{ SearchDialog: StaticSearchDialog }}>{children}</RootProvider>
      </body>
    </html>
  );
}
