import { useTick } from '../hooks';
import { LOT_KINDS } from '../sim/layout';
import { DEMAND_PER_KW, FORECASTS, forecastText, goalText, LOT_STARS, TRIP_FINE, type World } from '../sim/world';
import { Business } from './Business';

function Modal(props: { children: React.ReactNode; title: string; wide?: boolean; onClose?: () => void }) {
  return (
    <div className="pointer-events-auto fixed inset-0 z-40 grid place-items-center bg-black/55 p-4">
      <div
        role="dialog"
        aria-label={props.title}
        className={`panel max-h-full w-full overflow-y-auto p-6 ${props.wide ? 'max-w-5xl' : 'max-w-3xl'}`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">{props.title}</h1>
          {props.onClose && (
            <button type="button" className="btn" onClick={props.onClose}>
              Close
            </button>
          )}
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function Intro({ onStart }: { onStart: () => void }) {
  return (
    <Modal title="Wattsim Operator">
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-slate-300">
        <p>
          You run the EV charging at an office car park: six 22 kW chargers on two feeders, a 160 A grid connection and
          an office building that shares it. Every charger is a real simulated OCPP 2.0.1 station, and the cables, fuses
          and breakers are an electrical model with real trip curves.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Every day has <b>three goals</b> (top right). Each one met pays a bonus and earns a star; stars unlock new
            car parks. From day 2 there is a <b>forecast</b> for tomorrow (a heatwave, a price spike, a taxi rush):
            prepare for it overnight.
          </li>
          <li>
            Now and then the clock stops for a <b>decision</b>: a breaker about to trip, a grid operator asking you to
            cut load, a TV crew. Every answer costs something.
          </li>
          <li>
            Drivers arrive, plug in and want a state of charge before they leave. Unhappy drivers cost reputation.
          </li>
          <li>
            Each feeder breaker is only 50 A: three big cars at 32 A will trip it, and everything on that row goes dark.
            Watch the cable colours and the breaker lamps on the switchboard; click a lamp to reclose.
          </li>
          <li>
            Click a charger to throttle it (SetChargingProfile), stop or reset it, unlock a stuck cable, or send a
            technician. Every action is an OCPP message: open the OCPP log to see them.
          </li>
          <li>
            Drivers contact customer service: a car that stopped charging, a cable that will not release, someone who
            has to leave early, a bill they dispute. Answer before their patience runs out; check disputes against the
            meter before you refund.
          </li>
          <li>
            You earn per kWh and pay the grid price, €{DEMAND_PER_KW}/kW for each lot's daily peak, €{TRIP_FINE} per
            trip and your staff's wages.
          </li>
          <li>
            Open <b>Business</b> any time: buy AC and DC chargers, automatic load management, bigger feeders or a lot
            expansion, hire technicians, electricians and support agents, and buy more car parks. They all run at once;
            switch between them with the tabs at the top.
          </li>
        </ul>
        <p className="text-xs text-slate-400">
          Drag to pan, right-drag to rotate, scroll to zoom. Space pauses, 1–4 set the speed.
        </p>
        <button type="button" className="btn-primary self-end" onClick={onStart}>
          Open the car park
        </button>
      </div>
    </Modal>
  );
}

export function Summary({ world }: { world: World }) {
  useTick(world, 300);
  const l = world.ledger;
  const result = l.revenue + l.bonus - l.energyCost - l.demandCharge - l.fines - l.wages - l.refunds;
  const stars = world.history.at(-1) ?? 0;
  const next = Object.values(LOT_KINDS)
    .filter((k) => !world.lots.some((x) => x.kind.id === k.id) && (LOT_STARS[k.id] ?? 0) > world.stars)
    .sort((a, b) => (LOT_STARS[a.id] ?? 0) - (LOT_STARS[b.id] ?? 0))[0];
  return (
    <Modal title={`End of day ${world.day}`} wide>
      <div className="mb-5 flex flex-wrap items-start gap-6">
        <div className="text-center">
          <div className="text-4xl tracking-widest" role="img" aria-label={`${stars} of 3 stars`}>
            {[0, 1, 2].map((i) => (
              <span key={i} className={i < stars ? 'text-amber-300' : 'text-white/15'}>
                ★
              </span>
            ))}
          </div>
          <div className="num text-xs text-slate-400">
            ★ {world.stars} in all{next ? ` · ${next.name} at ★${LOT_STARS[next.id]}` : ''}
          </div>
        </div>
        <ul className="flex-1 space-y-1 text-sm">
          {world.goals.map((g) => (
            <li key={g.id} className="flex justify-between gap-3">
              <span className={g.state === 'met' ? 'text-emerald-300' : 'text-slate-500 line-through'}>
                {g.state === 'met' ? '✓' : '✗'} {goalText(g)}
              </span>
              <span className="num">{g.state === 'met' ? `+€${g.bonus}` : ''}</span>
            </li>
          ))}
        </ul>
        {world.forecast && (
          <div className="w-full rounded border border-amber-400/40 bg-amber-400/10 p-3 text-sm sm:w-72">
            <div className="text-xs uppercase tracking-wide text-amber-300">
              Tomorrow: {FORECASTS[world.forecast.id].title}
            </div>
            <p className="mt-1 text-amber-100">{forecastText(world, world.forecast)}</p>
            <p className="mt-1 text-xs text-slate-400">Prepare below before you start the day.</p>
          </div>
        )}
      </div>
      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <div className="text-sm">
          <Row k="Energy delivered" v={`${l.energyKwh.toFixed(0)} kWh`} />
          <Row k="Revenue" v={`€${l.revenue.toFixed(0)}`} />
          <Row k="Grid energy" v={`−€${l.energyCost.toFixed(0)}`} />
          <Row k="Peak demand charges" v={`−€${l.demandCharge.toFixed(0)}`} />
          <Row k={`Trips (${l.trips})`} v={`−€${l.fines.toFixed(0)}`} />
          <Row k="Wages" v={`−€${l.wages.toFixed(0)}`} />
          <Row k="Refunds and discounts" v={`−€${l.refunds.toFixed(0)}`} />
          <Row k="Goal bonuses and deals" v={`+€${l.bonus.toFixed(0)}`} />
          <Row k="Operating result" v={`${result >= 0 ? '' : '−'}€${Math.abs(result).toFixed(0)}`} strong />
          <Row k="Invested today" v={`€${l.invested.toFixed(0)}`} />
          <div className="my-3 border-t border-white/10" />
          <Row k="Happy drivers" v={String(l.happy)} />
          <Row k="Left short of their target" v={String(l.unhappy)} />
          <Row k="Gave up waiting" v={String(l.turnedAway)} />
          <Row k="Customer tickets solved / failed" v={`${l.ticketsSolved} / ${l.ticketsFailed}`} />
          <div className="my-3 border-t border-white/10" />
          <div className="mb-1 text-xs uppercase tracking-wide text-slate-400">
            Per car park (DLM score: wattsim grid)
          </div>
          {world.lots.map((lot) => (
            <div key={lot.id} className="mb-2 rounded bg-white/5 p-2 text-xs">
              <div className="font-semibold">{lot.name}</div>
              <div className="num text-slate-300">
                {lot.stats.energyKwh.toFixed(0)} kWh · €{lot.stats.revenue.toFixed(0)} · peak{' '}
                {lot.stats.peakKw.toFixed(0)} kW · {lot.stats.trips} trips · {lot.stats.happy}/
                {lot.stats.happy + lot.stats.unhappy} happy
              </div>
              {lot.score && (
                <div className="num text-slate-400">
                  unmet {(lot.score.unmetWh / 1000).toFixed(0)} kWh · main fuse peak{' '}
                  {(lot.score.nodes.F0?.peakUtilisationPct ?? 0).toFixed(0)} % · fairness{' '}
                  {lot.score.fairness.mean.toFixed(2)}
                </div>
              )}
            </div>
          ))}
        </div>
        <Business world={world} />
      </div>
      <div className="mt-5 flex justify-end">
        <button type="button" className="btn-primary" onClick={() => void world.nextDay()}>
          Start day {world.day + 1}
        </button>
      </div>
    </Modal>
  );
}

/** The business panel during the day; the game pauses while it is open. */
export function BusinessModal({ world, onClose }: { world: World; onClose: () => void }) {
  return (
    <Modal title="Business" wide onClose={onClose}>
      <Business world={world} />
    </Modal>
  );
}

/** A decision the clock stopped for: no closing it without an answer. */
export function DilemmaModal({ world }: { world: World }) {
  const d = world.dilemma;
  if (!d) return null;
  return (
    <Modal title={d.title}>
      <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">
        {world.lots.find((l) => l.id === d.lot)?.name} · {new Date(world.now).toISOString().slice(11, 16)}
      </p>
      <p className="mb-4 text-sm leading-relaxed text-slate-300">{d.text}</p>
      <div className="grid gap-2">
        {d.options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            onClick={() => world.choose(i)}
            className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-left hover:border-teal-400 hover:bg-teal-400/10"
          >
            <div className="font-semibold">{o.label}</div>
            <div className="text-xs text-slate-400">{o.detail}</div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function GameOver({ world, onRestart }: { world: World; onRestart: () => void }) {
  return (
    <Modal title="Game over">
      <p className="mb-4 text-sm text-slate-300">
        {world.alerts[0]?.text} You kept {world.lots.length > 1 ? 'your car parks' : 'the lot'} running until day{' '}
        {world.day}, {new Date(world.now).toISOString().slice(11, 16)}.
      </p>
      <button type="button" className="btn-primary" onClick={onRestart}>
        Try again
      </button>
    </Modal>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-0.5 ${strong ? 'font-semibold' : ''}`}>
      <span className="text-slate-300">{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}
