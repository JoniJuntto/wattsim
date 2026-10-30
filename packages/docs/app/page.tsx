import { HomeLayout } from 'fumadocs-ui/layouts/home';
import Link from 'next/link';
import { baseOptions } from '@/lib/layout.shared';

const tasks = [
  ['Test your CSMS against 1000 chargers', '/docs/guides/load-test', 'A fleet scenario, a virtual clock, JUnit in CI.'],
  ['Record a real charger and replay it', '/docs/guides/record-replay', 'Proxy, trace file, replay, scenario export.'],
  ['Check a charger for spec conformance', '/docs/guides/conformance', 'Point a charger at the CSMS simulator.'],
  ['Drive wattsim from Claude via MCP', '/docs/guides/mcp', 'One command, then ask for stations in plain words.'],
] as const;

export default function HomePage() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto w-full max-w-4xl px-4 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">wattsim</h1>
        <p className="mt-4 max-w-2xl text-fd-muted-foreground">
          An OCPP 1.6J, 2.0.1 and 2.1 simulator for testing a CSMS: charge points driven by a scenario language or a
          browser UI, a CSMS simulator that checks real chargers against the spec, a recording proxy, and an MCP server.
          Every message is validated against the OCA schemas, faults are injected deterministically, and runs use a
          virtual clock so a four hour charge finishes in a second of CI.
        </p>
        <div className="mt-6 flex gap-3 text-sm">
          <Link
            href="/docs/getting-started"
            className="rounded-md bg-fd-primary px-4 py-2 font-medium text-fd-primary-foreground"
          >
            Getting started
          </Link>
          <Link href="/docs/reference/dsl" className="rounded-md border px-4 py-2 font-medium">
            DSL reference
          </Link>
        </div>
        <h2 className="mt-14 text-sm font-medium uppercase tracking-wide text-fd-muted-foreground">Guides</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {tasks.map(([title, href, blurb]) => (
            <li key={href}>
              <Link href={href} className="block h-full rounded-lg border p-4 transition-colors hover:bg-fd-accent">
                <span className="font-medium">{title}</span>
                <span className="mt-1 block text-sm text-fd-muted-foreground">{blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </HomeLayout>
  );
}
