import { useState } from 'react';
import { useTick } from '../hooks';
import { CHARGER_TYPES, type ChargerTypeId } from '../sim/layout';
import { type Lot, ROLES, type Role, type World } from '../sim/world';

type Tab = 'chargers' | 'upgrades' | 'staff' | 'lots';
const TABS: Array<[Tab, string]> = [
  ['chargers', 'Charger shop'],
  ['upgrades', 'Site upgrades'],
  ['staff', 'Staff'],
  ['lots', 'Car parks'],
];

const euro = (n: number) => `€${Math.round(n).toLocaleString('en')}`;

/** Everything the company can spend money on, for the lot on screen (switchable here). */
export function Business({ world }: { world: World }) {
  useTick(world, 300);
  const [tab, setTab] = useState<Tab>('chargers');
  const lot = world.lot;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Business">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded px-3 py-1 text-sm ${tab === id ? 'bg-teal-400 text-black' : 'bg-white/5 hover:bg-white/15'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="num ml-auto text-sm">{euro(world.money)}</span>
      </div>
      {(tab === 'chargers' || tab === 'upgrades') && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-slate-400">For</span>
          {world.lots.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => world.setView(l.id)}
              className={`rounded px-2 py-0.5 ${l.id === lot.id ? 'bg-white/20' : 'bg-white/5 hover:bg-white/15'}`}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}
      {tab === 'chargers' && <ChargerShop world={world} lot={lot} />}
      {tab === 'upgrades' && <Upgrades world={world} lot={lot} />}
      {tab === 'staff' && <StaffTab world={world} />}
      {tab === 'lots' && <Lots world={world} />}
    </div>
  );
}

function ChargerShop({ world, lot }: { world: World; lot: Lot }) {
  const free = lot.freeBays();
  const [bay, setBay] = useState('');
  const at = free.some((b) => b.id === bay) ? bay : (free[0]?.id ?? '');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-slate-300">
        <label htmlFor="bay">Bay</label>
        <select
          id="bay"
          value={at}
          onChange={(e) => setBay(e.target.value)}
          className="rounded bg-white/10 px-2 py-1"
          disabled={free.length === 0}
        >
          {free.map((b) => (
            <option key={b.id} value={b.id} className="bg-slate-900">
              {b.id} (row {b.row + 1})
            </option>
          ))}
        </select>
        <span className="text-slate-400">
          {free.length} free · grid connection {lot.upgrades.mainA} A
          {free.length === 0 ? ' · expand the lot for more bays' : ''}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {Object.values(CHARGER_TYPES).map((t) => {
          const tight = t.dc && t.maxA > lot.upgrades.mainA * 0.6;
          return (
            <div key={t.id} className="flex flex-col gap-1 rounded bg-white/5 p-3">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{t.name}</span>
                <span className="num text-xs text-slate-400">{t.maxA} A/phase</span>
              </div>
              <p className="text-xs text-slate-400">
                {t.dc
                  ? `Drivers in a hurry pick it and pay ${Math.round((t.tariff - 1) * 100)} % more. On its own ${t.breakerA} A breaker straight off the switchboard.`
                  : t.kw === 11
                    ? 'Cheap, gentle on the feeder. Fine for drivers who stay all day.'
                    : 'The standard post. Three on one 50 A feeder will trip it at full power.'}
              </p>
              {tight && (
                <p className="text-xs text-amber-300">
                  At full power it takes {t.maxA} A of your {lot.upgrades.mainA} A connection, before the building.
                </p>
              )}
              <button
                type="button"
                className="btn mt-1 self-start"
                disabled={!at || t.price > world.money}
                onClick={() => void lot.buyCharger(t.id as ChargerTypeId, at).then(() => world.changed())}
              >
                Buy for {euro(t.price)}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Upgrades({ world, lot }: { world: World; lot: Lot }) {
  return (
    <div className="flex flex-col gap-2">
      {lot.shop().map((item) => (
        <div key={item.id} className="flex items-center gap-3 rounded bg-white/5 p-2">
          <div className="flex-1">
            <div className="text-sm">{item.name}</div>
            <div className="text-xs text-slate-400">{item.detail}</div>
          </div>
          <button
            type="button"
            className="btn whitespace-nowrap"
            disabled={!item.available || item.price > world.money}
            onClick={() => {
              lot.buy(item.id);
              world.changed();
            }}
          >
            {item.available ? euro(item.price) : 'Done'}
          </button>
        </div>
      ))}
    </div>
  );
}

function StaffTab({ world }: { world: World }) {
  const [where, setWhere] = useState(world.lot.id);
  const wages = world.staff.reduce((a, s) => a + ROLES[s.role].wage, 0);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-2 flex justify-between text-sm">
          <span className="font-semibold">Team</span>
          <span className="num text-slate-400">wages {euro(wages)}/day</span>
        </div>
        <div className="flex flex-col gap-1">
          {world.staff.length === 0 && <p className="text-xs text-slate-400">Nobody yet.</p>}
          {world.staff.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded bg-white/5 px-2 py-1.5 text-xs">
              <span className="flex-1">
                <b>{s.name}</b> · {ROLES[s.role].title}
                {s.lot ? ` · ${world.lots.find((l) => l.id === s.lot)?.name ?? s.lot}` : ' · all car parks'}
              </span>
              <span className="num text-slate-400">{euro(ROLES[s.role].wage)}</span>
              <button type="button" className="btn" onClick={() => world.fire(s.id)}>
                Let go
              </button>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm">
          <span className="font-semibold">Hire</span>
          <label htmlFor="where" className="ml-auto text-xs text-slate-400">
            Stationed at
          </label>
          <select
            id="where"
            value={where}
            onChange={(e) => setWhere(e.target.value)}
            className="rounded bg-white/10 px-2 py-1 text-xs"
          >
            {world.lots.map((l) => (
              <option key={l.id} value={l.id} className="bg-slate-900">
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          {(Object.keys(ROLES) as Role[]).map((role) => {
            const r = ROLES[role];
            return (
              <div key={role} className="rounded bg-white/5 p-2">
                <div className="flex items-baseline justify-between text-sm">
                  <span>{r.title}</span>
                  <span className="num text-xs text-slate-400">{euro(r.wage)}/day</span>
                </div>
                <p className="text-xs text-slate-400">{r.blurb}</p>
                <button
                  type="button"
                  className="btn mt-1"
                  disabled={r.hireFee > world.money}
                  onClick={() => world.hire(role, where)}
                >
                  Hire ({euro(r.hireFee)} fee)
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Lots({ world }: { world: World }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        {world.lots.map((l) => (
          <div key={l.id} className="flex items-center gap-3 rounded bg-white/5 p-2 text-sm">
            <span className="flex-1">
              <b>{l.name}</b>
              <span className="text-xs text-slate-400">
                {' '}
                · {l.chargers.size} chargers · {l.upgrades.mainA} A · {l.upgrades.aisles} aisle
                {l.upgrades.aisles > 1 ? 's' : ''}
                {l.upgrades.dlm ? ' · DLM' : ''}
              </span>
            </span>
            <button type="button" className="btn" onClick={() => world.setView(l.id)} disabled={l.id === world.lot.id}>
              {l.id === world.lot.id ? 'On screen' : 'Show'}
            </button>
          </div>
        ))}
      </div>
      <div className="text-sm font-semibold">For sale</div>
      {world.forSale().length === 0 && <p className="text-xs text-slate-400">You own every car park in town.</p>}
      {world.forSale().map((k) => (
        <div key={k.id} className="flex items-center gap-3 rounded bg-white/5 p-3">
          <div className="flex-1">
            <div className="text-sm font-semibold">{k.name}</div>
            <div className="text-xs text-slate-400">{k.blurb}</div>
            <div className="num mt-1 text-xs text-slate-300">
              {Object.values(k.start.chargers)
                .map((t) => CHARGER_TYPES[t].kw + (CHARGER_TYPES[t].dc ? ' DC' : ''))
                .join(' · ')}{' '}
              kW · {k.start.mainA} A · €{k.kwhPrice.toFixed(2)}/kWh
            </div>
          </div>
          <button
            type="button"
            className="btn-primary whitespace-nowrap"
            disabled={k.price > world.money}
            onClick={() => void world.buyLot(k.id)}
          >
            Buy {euro(k.price)}
          </button>
        </div>
      ))}
    </div>
  );
}
