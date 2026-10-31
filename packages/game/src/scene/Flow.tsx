/**
 * Electricity flow: each cable run is a strip whose width follows its current and colour its loading; dots move along
 * it at a speed that follows power (backwards where PV or the battery feed the board). A dead run goes grey and still.
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Color, type InstancedMesh, type Mesh, MeshStandardMaterial, Object3D } from 'three';
import { loadColour, useTick } from '../hooks';
import { type P2, type Run, runs } from '../sim/layout';
import type { Lot } from '../sim/world';

const DOT_SPACING = 1.6;
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Runs whose positive power flows from their last point back to the first. */
const SOURCES = new Set(['PV', 'BAT']);

type Seg = { a: P2; b: P2; len: number; at: number };

function segments(pts: P2[]): { segs: Seg[]; total: number } {
  let at = 0;
  const segs: Seg[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as P2;
    const b = pts[i] as P2;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, len, at });
    at += len;
  }
  return { segs, total: at };
}

function pointAt(segs: Seg[], d: number): P2 {
  for (const s of segs) {
    if (d <= s.at + s.len) {
      const f = s.len > 0 ? (d - s.at) / s.len : 0;
      return [s.a[0] + (s.b[0] - s.a[0]) * f, s.a[1] + (s.b[1] - s.a[1]) * f];
    }
  }
  const last = segs[segs.length - 1];
  return last ? last.b : [0, 0];
}

/** What the scene needs of a node each frame: current (A), power (W), loading (%), live. */
function reading(lot: Lot, run: Run) {
  const n = lot.state.nodes[run.node];
  const r = lot.state.nodes[run.ratingOf];
  const amps = n ? Math.max(...n.currentA) : 0;
  const watts = n ? n.powerW.reduce((a, b) => a + b, 0) : 0;
  const pct = SOURCES.has(run.node) ? (Math.abs(watts) / 60_000) * 100 : r?.loadingPct;
  return { amps, watts, pct, live: n?.energized ?? false };
}

export function Flow({ lot }: { lot: Lot }) {
  useTick(lot.w, 1000);
  const u = lot.upgrades;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the runs change only with these upgrades
  const list = useMemo(() => runs(u), [u.chargers.length, u.pv, u.battery]);
  return (
    <>
      {list.map((r) => (
        <Cable key={r.node} lot={lot} run={r} />
      ))}
      <Dots lot={lot} list={list} />
    </>
  );
}

function Cable({ lot, run }: { lot: Lot; run: Run }) {
  const { segs } = useMemo(() => segments(run.pts), [run]);
  const strips = useRef<Array<Mesh | null>>([]);
  // One material per run: a single colour update covers all its strips.
  const mat = useMemo(() => new MeshStandardMaterial({ color: '#3a3f46' }), []);
  const colour = useMemo(() => new Color(), []);
  useFrame(() => {
    const { amps, pct, live } = reading(lot, run);
    colour.set(live ? loadColour(pct) : '#3a3f46');
    mat.color.copy(colour).multiplyScalar(live ? 0.55 : 1);
    mat.emissive.copy(colour);
    mat.emissiveIntensity = live ? 0.15 + 0.5 * Math.min(1, amps / 60) : 0;
    const w = 0.12 + 0.45 * Math.min(1, amps / 100);
    for (const s of strips.current) if (s) s.scale.x = w;
  });
  return (
    <>
      {segs.map((s, i) => (
        <mesh
          key={`${s.a}-${s.b}`}
          ref={(m) => {
            strips.current[i] = m;
          }}
          material={mat}
          position={[(s.a[0] + s.b[0]) / 2, 0.04, (s.a[1] + s.b[1]) / 2]}
          rotation={[-Math.PI / 2, 0, Math.atan2(s.b[0] - s.a[0], s.b[1] - s.a[1])]}
        >
          <planeGeometry args={[1, s.len + 0.12]} />
        </mesh>
      ))}
    </>
  );
}

function Dots({ lot, list }: { lot: Lot; list: Run[] }) {
  const mesh = useRef<InstancedMesh>(null);
  const layout = useMemo(() => {
    const out: Array<{ run: Run; segs: Seg[]; total: number; offsets: number[] }> = [];
    for (const run of list) {
      const { segs, total } = segments(run.pts);
      const n = Math.max(2, Math.floor(total / DOT_SPACING));
      out.push({ run, segs, total, offsets: Array.from({ length: n }, (_, i) => (i * total) / n) });
    }
    return out;
  }, [list]);
  const count = layout.reduce((a, l) => a + l.offsets.length, 0);
  const tmp = useMemo(() => new Object3D(), []);
  const colour = useMemo(() => new Color(), []);
  useFrame((_, dt) => {
    const m = mesh.current;
    if (!m) return;
    let i = 0;
    for (const l of layout) {
      const { amps, watts, pct, live } = reading(lot, l.run);
      const flowing = live && amps > 0.3;
      const sign = (SOURCES.has(l.run.node) ? -1 : 1) * Math.sign(watts);
      const speed = REDUCED ? 0 : (1.5 + 7 * Math.min(1, Math.abs(watts) / 60_000)) * sign;
      const size = flowing ? 0.1 + 0.22 * Math.min(1, amps / 80) : 0;
      colour.set(loadColour(pct));
      for (let k = 0; k < l.offsets.length; k++) {
        const d = ((((l.offsets[k] as number) + speed * dt) % l.total) + l.total) % l.total;
        l.offsets[k] = d;
        const [x, z] = pointAt(l.segs, d);
        tmp.position.set(x, 0.18, z);
        tmp.scale.setScalar(size);
        tmp.updateMatrix();
        m.setMatrixAt(i, tmp.matrix);
        m.setColorAt(i, colour);
        i++;
      }
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh key={count} ref={mesh} args={[undefined, undefined, count]}>
      <sphereGeometry args={[1, 10, 8]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
