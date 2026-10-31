import { useEffect, useState } from 'react';
import { clock, loadColour, STATUS_COLOUR, useTick } from '../hooks';
import { DISCOUNT, deviceName, type Lot, type Selection, type Ticket, type World } from '../sim/world';

const SPEEDS = [
  { label: '1×', v: 60 },
  { label: '2×', v: 120 },
  { label: '4×', v: 240 },
  { label: '8×', v: 480 },
];

export function TopBar(props: { world: World; onLog: () => void; onHelp: () => void; onBusiness: () => void }) {
  const { world, onLog, onHelp } = props;
  useTick(world);
  const lot = world.lot;
  const f0 = lot.state.nodes.F0;
  const kw = lot.state.supply.powerW.reduce((a, b) => a + b, 0) / 1000;
  const pv = lot.state.nodes.PV;
  const bat = lot.site.models.get('BAT') as { soc?: number } | undefined;
  return (
    <div className="panel pointer-events-auto flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2 text-sm">
      <div className="font-semibold tracking-wide text-[var(--color-volt)]">WATTSIM OPERATOR</div>
      <div className="num text-slate-300">
        Day {world.day} · <span className="text-white">{clock(world.now)}</span>
      </div>
      <fieldset className="m-0 flex gap-1 border-0 p-0" aria-label="Game speed">
        <SpeedButton active={world.paused} onClick={() => world.setPaused(!world.paused)} label="Pause (space)">
          {world.paused ? '▶' : '❚❚'}
        </SpeedButton>
        {SPEEDS.map((s, i) => (
          <SpeedButton
            key={s.v}
            active={!world.paused && world.speed === s.v}
            onClick={() => world.setSpeed(s.v)}
            label={`Speed ${s.label} (${i + 1})`}
          >
            {s.label}
          </SpeedButton>
        ))}
      </fieldset>
      <LotTabs world={world} />
      <Stat label="Money" value={`€${Math.round(world.money).toLocaleString('en')}`} warn={world.money < 0} />
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">Reputation</span>
        <Meter pct={world.reputation} colour={world.reputation < 30 ? '#ff5d5d' : '#3fb950'} width={80} />
        <span className="num w-7 text-right">{Math.round(world.reputation)}</span>
      </div>
      <div className="flex items-center gap-2" title="Main fuse loading, worst phase">
        <span className="text-xs text-slate-400">Site</span>
        <Meter pct={f0?.loadingPct ?? 0} colour={loadColour(f0?.loadingPct)} width={90} />
        <span className="num">
          {kw.toFixed(0)} kW · {Math.round(f0?.loadingPct ?? 0)} %
        </span>
      </div>
      {pv && <Stat label="Solar" value={`${(-pv.powerW.reduce((a, b) => a + b, 0) / 1000).toFixed(0)} kW`} />}
      {bat && <Stat label="Battery" value={`${Math.round((bat.soc ?? 0) * 100)} %`} />}
      {lot.upgrades.dlm && (
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={lot.dlmOn}
            onChange={(e) => {
              lot.setDlm(e.target.checked);
              world.changed();
            }}
          />
          Auto-DLM
        </label>
      )}
      <div className="ml-auto flex gap-1">
        <button type="button" className="btn-primary !px-3 !py-1 !text-xs" onClick={props.onBusiness}>
          Business
        </button>
        <button type="button" className="btn" onClick={onLog}>
          OCPP log
        </button>
        <button type="button" className="btn" onClick={onHelp} aria-label="Help">
          ?
        </button>
      </div>
    </div>
  );
}

/** One tab per car park owned, with a lamp for trouble there. */
function LotTabs({ world }: { world: World }) {
  return (
    <div className="flex gap-1" role="tablist" aria-label="Car parks">
      {world.lots.map((l) => {
        const trouble = l.protective().some((id) => l.state.nodes[id]?.tripped)
          ? 'bg-red-500'
          : [...l.chargers.values()].some((c) => c.fault) || l.tickets.some((k) => k.state === 'open')
            ? 'bg-amber-400'
            : 'bg-emerald-400';
        return (
          <button
            key={l.id}
            type="button"
            role="tab"
            aria-selected={l.id === world.lot.id}
            onClick={() => world.setView(l.id)}
            className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs ${l.id === world.lot.id ? 'bg-white/20' : 'bg-white/5 hover:bg-white/15'}`}
            title={l.name}
          >
            <span className={`h-2 w-2 rounded-full ${trouble}`} />
            {l.id}
          </button>
        );
      })}
    </div>
  );
}

function SpeedButton(props: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
      className={`num min-w-8 rounded px-2 py-0.5 text-xs ${props.active ? 'bg-teal-400 text-black' : 'bg-white/5 hover:bg-white/15'}`}
    >
      {props.children}
    </button>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xs text-slate-400">{label}</span>
      <span className={`num ${warn ? 'text-[var(--color-trip)]' : ''}`}>{value}</span>
    </div>
  );
}

export function Meter({ pct, colour, width = 120 }: { pct: number; colour: string; width?: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-white/10" style={{ width }}>
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: colour }}
      />
    </div>
  );
}

/** The switchboard at a glance: one lamp per protective device, click to inspect. */
export function Protection({ world, onSelect }: { world: World; onSelect: (s: Selection) => void }) {
  useTick(world);
  const lot = world.lot;
  return (
    <div className="panel pointer-events-auto flex w-72 flex-col gap-1 p-2 text-xs">
      <div className="px-1 font-semibold">{lot.name}</div>
      {lot.protective().map((id) => {
        const name = deviceName(id);
        const n = lot.state.nodes[id];
        const heat = Math.max(...(n?.thermal ?? [0]));
        const lamp = n?.tripped ? 'bg-red-500 animate-pulse' : heat > 0.6 ? 'bg-amber-400' : 'bg-emerald-400';
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect({ kind: 'device', lot: lot.id, id })}
            className="grid grid-cols-[0.6rem_1fr_3.5rem_3rem] items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10"
          >
            <span className={`h-2.5 w-2.5 rounded-full ${lamp}`} />
            <span className="truncate">{name}</span>
            <Meter pct={n?.loadingPct ?? 0} colour={loadColour(n?.loadingPct)} width={56} />
            <span className="num text-right">{n?.tripped ? 'TRIP' : `${Math.round(n?.loadingPct ?? 0)} %`}</span>
          </button>
        );
      })}
      <div className="mt-1 flex flex-wrap gap-1 border-t border-white/10 pt-1.5">
        {[...lot.chargers.values()].map((c) => {
          const status = c.powered ? (c.station.evses[0]?.status ?? '') : 'Unavailable';
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect({ kind: 'charger', id: c.id })}
              className="num flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] hover:bg-white/15"
            >
              <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOUR[status] ?? '#6e7681' }} />
              {c.bay.id}
              {c.type.dc ? ' DC' : ''}
              {c.fault ? ' ⚠' : ''}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const TICKET_TITLE: Record<Ticket['kind'], string> = {
  'not-charging': 'Not charging',
  stuck: 'Cable stuck',
  rush: 'Leaving early',
  billing: 'Billing dispute',
};

/** Customer service: drivers' tickets with a countdown, and the replies the operator can give. */
export function Inbox({ world, onSelect }: { world: World; onSelect: (s: Selection) => void }) {
  useTick(world, 300);
  // Open ones first; a closed one stays briefly so its outcome can be read.
  const live = world.tickets.filter((k) => k.state === 'open' || k.state === 'promised');
  const list = [...live, ...world.tickets.filter((k) => !live.includes(k)).slice(0, 1)].slice(0, 3);
  const open = world.tickets.filter((k) => k.state === 'open').length;
  if (list.length === 0) return null;
  return (
    <section className="panel pointer-events-auto flex w-72 flex-col gap-2 p-2 text-xs" aria-label="Customer service">
      <div className="flex items-center justify-between px-1">
        <span className="font-semibold">Customer service</span>
        <span className={`num rounded-full px-1.5 ${open > 0 ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>
          {open} open
        </span>
      </div>
      {list.map((k) => (
        <TicketCard key={k.id} world={world} k={k} onSelect={onSelect} />
      ))}
    </section>
  );
}

function TicketCard({ world, k, onSelect }: { world: World; k: Ticket; onSelect: (s: Selection) => void }) {
  const open = k.state === 'open';
  const left = Math.max(0, (k.due - world.now) / (k.due - k.t || 1));
  const car = world.lots.find((l) => l.id === k.lot)?.car(k.car);
  const border = open
    ? 'border-amber-400'
    : k.state === 'promised'
      ? 'border-sky-400'
      : k.state === 'solved'
        ? 'border-emerald-400/60'
        : 'border-red-500/70';
  return (
    <article className={`rounded border-l-4 ${border} bg-white/5 p-2 ${open ? '' : 'opacity-75'}`}>
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <span className="font-semibold">
          {k.from} · {TICKET_TITLE[k.kind]}
        </span>
        {k.charger && (
          <button
            type="button"
            className="num rounded bg-white/10 px-1 hover:bg-teal-400 hover:text-black"
            onClick={() => onSelect({ kind: 'charger', id: k.charger as string })}
          >
            {k.charger}
          </button>
        )}
      </div>
      {k.handledBy && <p className="text-[10px] text-slate-400">Handled by {k.handledBy}</p>}
      {(open || k.state === 'promised') && <p className="leading-snug text-slate-300">“{k.text}”</p>}
      {k.kind === 'billing' && open && (
        <p className="num mt-1 text-slate-400">
          Meter (TransactionEvent): €{k.metered?.toFixed(2)} · billed €{k.billed?.toFixed(2)}
        </p>
      )}
      {k.state === 'promised' && car && (
        <p className="num mt-1 text-sky-300">
          Promised {Math.round(car.targetSoc * 100)} % by {clock(car.departAt)}: now {Math.round(car.soc * 100)} %
        </p>
      )}
      {k.outcome && k.state !== 'promised' && <p className="mt-1 italic text-slate-400">↳ {k.outcome}</p>}
      {open && (
        <>
          <div className="my-1.5 h-1 overflow-hidden rounded bg-white/10">
            <div className="h-full bg-amber-400" style={{ width: `${left * 100}%` }} />
          </div>
          <div className="flex flex-wrap gap-1">
            {k.kind === 'rush' && (
              <>
                <Reply onClick={() => world.answer(k.id, 'promise')}>Promise it</Reply>
                <Reply onClick={() => world.answer(k.id, 'decline')}>Can't promise</Reply>
              </>
            )}
            {k.kind === 'billing' && (
              <>
                <Reply onClick={() => world.answer(k.id, 'refund')}>
                  Refund €{((k.billed ?? 0) - (k.billed === k.metered ? 0 : (k.metered ?? 0))).toFixed(2)}
                </Reply>
                <Reply onClick={() => world.answer(k.id, 'decline')}>Bill is correct</Reply>
              </>
            )}
            {k.kind === 'not-charging' && (
              <Reply onClick={() => world.answer(k.id, 'discount')}>Apologise, €{DISCOUNT} off</Reply>
            )}
            {(k.kind === 'not-charging' || k.kind === 'stuck') && (
              <span className="self-center text-slate-400">Fix the charger to close it.</span>
            )}
          </div>
        </>
      )}
    </article>
  );
}

function Reply({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded bg-white/10 px-2 py-1 hover:bg-teal-400 hover:text-black"
    >
      {children}
    </button>
  );
}

const LEVEL = { info: 'border-sky-400/60', warn: 'border-amber-400', crit: 'border-red-500' };

export function Alerts({ world, onSelect }: { world: World; onSelect: (s: Selection) => void }) {
  useTick(world, 400);
  return (
    <div className="pointer-events-auto flex max-h-full w-72 flex-col gap-1.5 overflow-y-auto pr-1" aria-live="polite">
      {world.alerts.slice(0, 4).map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={!a.target}
          onClick={() => a.target && onSelect(a.target)}
          className={`panel border-l-4 ${LEVEL[a.level]} px-3 py-1.5 text-left text-xs leading-snug enabled:hover:bg-white/10`}
        >
          <span className="num mr-2 text-slate-400">{clock(a.t)}</span>
          {a.lot && world.lots.length > 1 && <span className="num mr-1 rounded bg-white/10 px-1">{a.lot}</span>}
          {a.text}
        </button>
      ))}
    </div>
  );
}

export function Inspector({ world, selected }: { world: World; selected: Selection }) {
  useTick(world);
  return (
    <div className="panel pointer-events-auto w-80 p-4 text-sm">
      {selected.kind === 'charger' ? (
        <ChargerPanel world={world} id={selected.id} />
      ) : (
        <DevicePanel world={world} lot={world.lots.find((l) => l.id === selected.lot) ?? world.lot} id={selected.id} />
      )}
    </div>
  );
}

const FIX_HINT = {
  reset: 'Often cleared by a remote Reset.',
  tech: 'Hardware fault: send a technician.',
  unlock: 'Send UnlockConnector to release the cable.',
};

function ChargerPanel({ world, id }: { world: World; id: string }) {
  const found = world.find(id);
  const [limit, setLimit] = useState(found?.ch.manualA ?? 32);
  useEffect(() => setLimit(world.find(id)?.ch.manualA ?? 32), [world, id]);
  if (!found) return null;
  const { lot, ch } = found;
  const max = ch.type.maxA;
  const evse = ch.station.evses[0];
  const online = world.csms.online(id);
  const car = lot.car(ch.car);
  const status = evse?.status ?? '?';
  const amps = evse?.tx ? (evse.meter.currentA ?? 0) : 0;
  const phases = evse?.phases ?? evse?.ev?.config.phases ?? 3;
  const techFree = lot.techs.some((t) => !t.job);
  const busyTech = lot.techs.find((t) => t.job?.charger === id);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{id}</h2>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium text-black"
          style={{ background: STATUS_COLOUR[status] ?? '#999' }}
        >
          {ch.powered ? status : 'No power'}
        </span>
      </div>
      <div className="text-xs text-slate-400">
        {ch.type.name} · OCPP 2.0.1 ·{' '}
        <span className={online ? 'text-emerald-400' : 'text-red-400'}>{online ? 'online' : 'offline'}</span> ·{' '}
        {ch.type.dc ? 'own DC breaker' : `row ${ch.bay.row + 1} feeder · wired ${ch.bay.phases}`}
      </div>
      {ch.fault && (
        <div className="rounded border border-red-500/60 bg-red-500/10 px-2 py-1.5 text-xs">
          <b>{ch.fault.code}</b> since {clock(ch.fault.since)}. {FIX_HINT[ch.fault.fix]}
        </div>
      )}
      {ch.hung && (
        <div className="rounded border border-amber-400/60 bg-amber-400/10 px-2 py-1.5 text-xs">
          The modem is hung: it will not reconnect until a technician replaces it. It keeps charging offline.
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 text-center">
        <Big label="Power" value={`${(evse?.meter.power ?? 0).toFixed(1)}`} unit="kW" />
        <Big label="Current" value={`${amps.toFixed(1)}`} unit={`A × ${phases}`} />
        <Big label="Offer" value={`${(evse?.offeredKw ?? 0).toFixed(1)}`} unit="kW" />
      </div>
      {car ? (
        <div className="rounded bg-white/5 p-2 text-xs">
          <div className="mb-1 flex justify-between gap-2">
            <span>
              {car.driver} · {car.preset.name} {car.preset.batteryKwh} kWh ·{' '}
              {ch.type.dc
                ? `DC up to ${car.preset.dcKw} kW`
                : `${car.preset.phases === 1 ? '1-phase' : '3-phase'} ${Math.min(car.preset.maxCurrentA, car.preset.cableMaxA ?? 32)} A`}
            </span>
            <span className="num">leaves {clock(car.departAt)}</span>
          </div>
          <div className="relative h-2.5 rounded bg-white/10">
            <div className="h-full rounded bg-teal-400" style={{ width: `${car.soc * 100}%` }} />
            <div className="absolute top-[-3px] h-4 w-0.5 bg-white" style={{ left: `${car.targetSoc * 100}%` }} />
          </div>
          <div className="num mt-1 text-slate-400">
            {Math.round(car.soc * 100)} % now, wants {Math.round(car.targetSoc * 100)} %
            {car.stuck ? ' · STUCK' : car.halted ? ' · session stopped' : ''}
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-500">No car.</div>
      )}
      <div>
        <div className="mb-1 flex justify-between text-xs">
          <label htmlFor="limit">Current limit (SetChargingProfile)</label>
          <span className="num">{limit >= max ? 'none' : `${limit} A`}</span>
        </div>
        <input
          id="limit"
          type="range"
          min={0}
          max={max}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          onPointerUp={(e) => {
            const a = Number(e.currentTarget.value);
            void world.act(id, (l) => l.setLimit(id, a));
          }}
          onKeyUp={(e) => {
            const a = Number(e.currentTarget.value);
            void world.act(id, (l) => l.setLimit(id, a));
          }}
          className="w-full accent-teal-400"
        />
        {lot.upgrades.dlm && lot.dlmOn && (
          <div className="text-[11px] text-slate-400">Auto-DLM may lower it further (now {ch.sentA} A sent).</div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {evse?.tx || !car ? (
          <Action onClick={() => world.act(id, (l) => l.stopSession(id))} disabled={!evse?.tx}>
            Stop session
          </Action>
        ) : (
          <Action
            onClick={() => world.act(id, (l) => l.remoteStart(id))}
            disabled={!online || ch.starting || car.stuck}
          >
            Remote start
          </Action>
        )}
        <Action onClick={() => world.act(id, (l) => l.reset(id))} disabled={!online}>
          {ch.resetting ? 'Resetting…' : 'Reset'}
        </Action>
        <Action onClick={() => world.act(id, (l) => l.unlock(id))} disabled={!online}>
          Unlock connector
        </Action>
        <Action onClick={() => world.act(id, (l) => l.setAvailable(id, ch.disabled))} disabled={!online}>
          {ch.disabled ? 'Make available' : 'Take out of service'}
        </Action>
        <Action
          className="col-span-2"
          onClick={() => world.act(id, (l) => l.dispatch(id))}
          disabled={!techFree || !!busyTech || (!ch.fault && !ch.hung)}
        >
          {busyTech
            ? `${busyTech.name} is on it…`
            : lot.techs.length === 0
              ? 'No technician at this lot (hire one)'
              : 'Send technician'}
        </Action>
      </div>
    </div>
  );
}

function DevicePanel({ world, lot, id }: { world: World; lot: Lot; id: string }) {
  const n = lot.state.nodes[id];
  if (!n) return null;
  const heat = n.thermal ?? [0, 0, 0];
  const kw = n.powerW.reduce((a, b) => a + b, 0) / 1000;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{deviceName(id)}</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium text-black ${n.tripped ? 'bg-red-500' : 'bg-emerald-400'}`}
        >
          {n.tripped ? 'TRIPPED' : 'closed'}
        </span>
      </div>
      <div className="text-xs text-slate-400">
        {lot.name} · {id === 'F0' ? 'gG fuse' : id.startsWith('QD') ? 'MCCB' : 'MCB curve C'} · {n.ratingA} A ·{' '}
        {kw.toFixed(1)} kW
      </div>
      <div className="flex flex-col gap-1.5">
        {(['L1', 'L2', 'L3'] as const).map((p, k) => {
          const a = n.currentA[k] ?? 0;
          const pct = (a / (n.ratingA ?? 1)) * 100;
          return (
            <div key={p} className="grid grid-cols-[2rem_1fr_4.5rem] items-center gap-2 text-xs">
              <span className="text-slate-400">{p}</span>
              <Meter pct={pct} colour={loadColour(pct)} width={170} />
              <span className="num text-right">{a.toFixed(1)} A</span>
            </div>
          );
        })}
      </div>
      <div>
        <div className="mb-1 text-xs text-slate-400">Thermal memory (100 % = trip)</div>
        <div className="flex gap-1.5">
          {heat.map((h, k) => (
            <Meter key={['L1', 'L2', 'L3'][k]} pct={h * 100} colour={h > 0.6 ? '#ff5d5d' : '#f5b83d'} width={88} />
          ))}
        </div>
      </div>
      {id === 'QB' && (
        <div className="text-xs text-slate-400">
          Building load {((lot.state.nodes.BLD?.powerW ?? [0]).reduce((a, b) => a + b, 0) / 1000).toFixed(0)} kW ·
          cooling {(lot.state.nodes.HVAC?.powerW[0] ?? 0) > 1 ? 'on' : 'off'}
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <Action
          onClick={() => {
            lot.reclose(id);
            world.changed();
          }}
          disabled={!n.tripped}
        >
          {id === 'F0' ? 'Replace fuse' : 'Reclose'}
        </Action>
        <Action
          onClick={() => {
            lot.trip(id);
            world.changed();
          }}
          disabled={n.tripped || id === 'F0'}
        >
          Open
        </Action>
      </div>
    </div>
  );
}

function Big({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded bg-white/5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="num text-lg leading-tight">{value}</div>
      <div className="text-[10px] text-slate-400">{unit}</div>
    </div>
  );
}

function Action(props: { onClick: () => unknown; disabled?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => void props.onClick()}
      className={`rounded bg-white/10 px-2 py-1.5 text-xs enabled:hover:bg-teal-400 enabled:hover:text-black disabled:opacity-35 ${props.className ?? ''}`}
    >
      {props.children}
    </button>
  );
}

export function OcppLog({ world, station }: { world: World; station?: string }) {
  useTick(world, 400);
  const prefix = `${world.lot.id}-`;
  const rows = world.csms.log
    .filter((e) => (station ? e.station === station : e.station.startsWith(prefix)))
    .slice(-80)
    .reverse();
  return (
    <div className="panel pointer-events-auto h-56 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed">
      <div className="mb-1 text-xs text-slate-400">
        OCPP 2.0.1 frames {station ? `for ${station}` : `at ${world.lot.name} (select a charger to filter)`}
      </div>
      {rows.map((e) => (
        <div key={e.n} className="truncate">
          <span className="text-slate-500">{new Date(e.t).toISOString().slice(11, 19)}</span>{' '}
          <span className="text-slate-300">{e.station}</span>{' '}
          <span className={e.dir === 'up' ? 'text-sky-400' : 'text-amber-300'}>{e.dir === 'up' ? '→' : '←'}</span>{' '}
          <span className={e.kind === 'error' ? 'text-red-400' : e.kind === 'call' ? 'text-white' : 'text-slate-400'}>
            {e.action}
            {e.kind === 'result' ? ' ✓' : e.kind === 'error' ? ' ✗' : ''}
          </span>{' '}
          <span className="text-slate-500">{JSON.stringify(e.payload)}</span>
        </div>
      ))}
    </div>
  );
}
