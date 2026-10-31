import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { MeshStandardMaterial } from 'three';
import { STATUS_COLOUR, useTick } from '../hooks';
import type { Charger } from '../sim/world';
import type { SceneProps } from './Scene';

export function Chargers({ lot, selected, onSelect }: SceneProps) {
  useTick(lot.w, 300);
  return (
    <>
      {[...lot.chargers.values()].map((ch) => (
        <Post
          key={ch.id}
          ch={ch}
          online={lot.csms.online(ch.id)}
          active={selected?.kind === 'charger' && selected.id === ch.id}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

const SIZES = {
  ac11: { w: 0.5, h: 1.2, d: 0.3, colour: '#e8ecef' },
  ac22: { w: 0.6, h: 1.7, d: 0.4, colour: '#e8ecef' },
  dc50: { w: 1, h: 1.9, d: 0.7, colour: '#d5dde3' },
  dc150: { w: 1.2, h: 2.4, d: 0.9, colour: '#2a3138' },
};

function Post({
  ch,
  online,
  active,
  onSelect,
}: {
  ch: Charger;
  online: boolean;
  active: boolean;
  onSelect: SceneProps['onSelect'];
}) {
  const screen = useRef<MeshStandardMaterial>(null);
  const evse = ch.station.evses[0];
  const status = ch.powered ? (evse?.status ?? 'Unavailable') : 'Unavailable';
  useFrame(({ clock }) => {
    const m = screen.current;
    if (!m) return;
    const c = STATUS_COLOUR[ch.powered ? (ch.station.evses[0]?.status ?? '') : 'Unavailable'] ?? '#6e7681';
    m.color.set(c);
    m.emissive.set(c);
    // Dead: dark. Offline: blinking. Otherwise steady, pulsing while charging.
    const blink = !ch.powered ? 0 : !online ? (Math.sin(clock.elapsedTime * 6) > 0 ? 1.4 : 0.1) : 1;
    const pulse = ch.station.evses[0]?.status === 'Charging' ? 0.8 + 0.4 * Math.sin(clock.elapsedTime * 3) : 1;
    m.emissiveIntensity = blink * pulse;
  });
  const [x, z] = ch.bay.charger;
  const face = ch.bay.facing === 1 ? Math.PI : 0;
  const kw = evse?.meter.power ?? 0;
  const size = SIZES[ch.type.id];
  return (
    <group position={[x, 0, z]} rotation-y={face}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a three.js object; the HUD's charger buttons are the keyboard path */}
      <group
        onClick={(e) => {
          e.stopPropagation();
          onSelect({ kind: 'charger', id: ch.id });
        }}
        onPointerOver={() => {
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
        }}
      >
        {/* AC: a slim post (a short wallbox for 11 kW); DC: a wide cabinet, the HPC one taller and dark */}
        <mesh position-y={size.h / 2} castShadow>
          <boxGeometry args={[size.w, size.h, size.d]} />
          <meshStandardMaterial color={size.colour} roughness={0.5} />
        </mesh>
        <mesh position={[0, size.h * 0.68, size.d / 2 + 0.01]}>
          <planeGeometry args={[size.w * 0.7, size.h * 0.32]} />
          <meshStandardMaterial ref={screen} />
        </mesh>
        <mesh position={[0, size.h + 0.04, 0]}>
          <boxGeometry args={[size.w + 0.06, 0.08, size.d + 0.06]} />
          <meshStandardMaterial color={ch.type.dc ? '#38e8c6' : '#38424d'} />
        </mesh>
      </group>
      {active && (
        <mesh rotation-x={-Math.PI / 2} position-y={0.03}>
          <ringGeometry args={[0.9, 1.15, 40]} />
          <meshBasicMaterial color="#38e8c6" />
        </mesh>
      )}
      <Html center position={[0, size.h + 0.9, 0]} className="pointer-events-none" zIndexRange={[20, 0]}>
        <div
          className={`num whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] leading-tight ${
            active ? 'bg-teal-400/90 text-black' : 'bg-black/55 text-slate-100'
          }`}
        >
          {ch.bay.id} · {ch.type.kw}
          {ch.type.dc ? ' DC' : ''}
          {ch.fault ? ' ⚠' : ''}
          {status === 'Charging' ? ` · ${kw.toFixed(1)} kW` : ''}
          {!ch.powered ? ' · no power' : !online ? ' · offline' : ''}
        </div>
      </Html>
    </group>
  );
}
