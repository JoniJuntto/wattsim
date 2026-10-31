import { Html } from '@react-three/drei';
import { useTick } from '../hooks';
import type { Fx, Lot } from '../sim/world';

const SLOTS = Array.from({ length: 10 }, (_, i) => `pop${i}`);
const LIFE_MS = 2600;

/** Numbers rising off the lot: takings, fines, reputation. A fixed pool of labels; each pop keeps its slot. */
export function Pops({ lot }: { lot: Lot }) {
  useTick(lot.w, 150);
  const now = performance.now();
  const bySlot = new Map<number, Fx>();
  for (const e of lot.w.fxs) {
    if (e.text && e.at && e.lot === lot.id && now - e.real < LIFE_MS) bySlot.set(e.id % SLOTS.length, e);
  }
  return (
    <>
      {SLOTS.map((slot, i) => {
        const e = bySlot.get(i);
        return (
          <Html
            key={slot}
            center
            position={[e?.at?.[0] ?? 0, 3.4, e?.at?.[1] ?? 0]}
            className="pointer-events-none"
            zIndexRange={[20, 0]}
          >
            {e && (
              <div key={e.id} className={`pop ${e.tone === 'bad' ? 'text-red-300' : 'text-emerald-200'}`}>
                {e.text}
              </div>
            )}
          </Html>
        );
      })}
    </>
  );
}
