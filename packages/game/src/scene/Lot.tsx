import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import { useTick } from '../hooks';
import { AISLE_GAP, BATTERY, BUILDING, baysOf, MDB, TRANSFORMER } from '../sim/layout';
import { deviceName, type Lot } from '../sim/world';
import type { SceneProps } from './Scene';

const PAINT = '#d8dee6';

export function LotModel({ lot, selected, onSelect }: SceneProps) {
  useTick(lot.w, 500);
  const u = lot.upgrades;
  const aisles = Array.from({ length: u.aisles }, (_, i) => i * AISLE_GAP);
  const extra = (u.aisles - 1) * AISLE_GAP;
  return (
    <group>
      {/* grass, asphalt, aisle */}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#3d6b45" />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[-3, 0, -3 + extra / 2]} receiveShadow>
        <planeGeometry args={[78, 44 + extra]} />
        <meshStandardMaterial color="#4a5058" roughness={0.95} />
      </mesh>
      {aisles.map((z) => (
        <group key={z}>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.005, z]}>
            <planeGeometry args={[72, 6]} />
            <meshStandardMaterial color="#545a63" roughness={0.9} />
          </mesh>
          {Array.from({ length: 14 }, (_, i) => -32 + i * 5).map((x) => (
            <mesh key={x} rotation-x={-Math.PI / 2} position={[x, 0.01, z]}>
              <planeGeometry args={[2.2, 0.15]} />
              <meshStandardMaterial color="#e3c35a" />
            </mesh>
          ))}
        </group>
      ))}
      {extra > 0 &&
        [-30, 30].map((x) => (
          <mesh key={x} rotation-x={-Math.PI / 2} position={[x, 0.006, AISLE_GAP / 2]}>
            <planeGeometry args={[5, AISLE_GAP]} />
            <meshStandardMaterial color="#545a63" roughness={0.9} />
          </mesh>
        ))}
      {baysOf(u).map((b) => {
        const has = !!u.chargers[b.id];
        return (
          <group key={b.id} position={[b.pos[0], 0.01, b.pos[1]]}>
            <mesh rotation-x={-Math.PI / 2}>
              <planeGeometry args={[2.9, 5]} />
              <meshStandardMaterial color={has ? '#1f4d3a' : '#2c3138'} transparent opacity={has ? 0.9 : 0} />
            </mesh>
            {[-1.6, 1.6].map((dx) => (
              <mesh key={dx} rotation-x={-Math.PI / 2} position={[dx, 0.005, 0]}>
                <planeGeometry args={[0.12, 5]} />
                <meshStandardMaterial color={PAINT} />
              </mesh>
            ))}
          </group>
        );
      })}
      <Building lot={lot} />
      <Transformer />
      <Switchboard lot={lot} selected={selected} onSelect={onSelect} />
      {u.battery && <Battery lot={lot} />}
      {u.pv && <Carport />}
    </group>
  );
}

function Building({ lot }: { lot: Lot }) {
  const fan = useRef<Mesh>(null);
  const windows = useRef<MeshStandardMaterial>(null);
  useFrame((_, dt) => {
    const on = lot.site.models.get('HVAC') && (lot.state.nodes.HVAC?.powerW[0] ?? 0) > 1;
    if (fan.current && on) fan.current.rotation.y += dt * 12;
    if (windows.current) windows.current.emissiveIntensity = lot.hour > 17.5 ? 1.2 : 0.15;
  });
  const { x, z, w, d, h } = BUILDING;
  return (
    <group position={[x, 0, z]}>
      <mesh position-y={h / 2} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={lot.kind.building.colour} roughness={0.8} />
      </mesh>
      {[1.8, 4.4].map((y) => (
        <mesh key={y} position={[0, y, d / 2 + 0.01]}>
          <planeGeometry args={[w - 2, 1.1]} />
          <meshStandardMaterial ref={windows} color="#203247" emissive="#ffd58a" emissiveIntensity={0.15} />
        </mesh>
      ))}
      <group position={[6, h, 0]}>
        <mesh position-y={0.7} castShadow>
          <boxGeometry args={[4, 1.4, 3]} />
          <meshStandardMaterial color="#b4bcc6" />
        </mesh>
        <mesh ref={fan} position-y={1.45}>
          <cylinderGeometry args={[1, 1, 0.1, 6]} />
          <meshStandardMaterial color="#59626d" />
        </mesh>
      </group>
      <Label y={h + 2.5}>{lot.kind.building.name}</Label>
    </group>
  );
}

function Transformer() {
  return (
    <group position={[TRANSFORMER[0], 0, TRANSFORMER[1]]}>
      <mesh position-y={1.2} castShadow>
        <boxGeometry args={[3, 2.4, 2.2]} />
        <meshStandardMaterial color="#5f7a5b" />
      </mesh>
      {[-1.1, -0.55, 0, 0.55, 1.1].map((dx) => (
        <mesh key={dx} position={[dx, 1.1, 1.25]} castShadow>
          <boxGeometry args={[0.12, 1.8, 0.3]} />
          <meshStandardMaterial color="#4d6649" />
        </mesh>
      ))}
      <Label y={3.4}>Transformer 400 kVA</Label>
    </group>
  );
}

function Switchboard({ lot, selected, onSelect }: SceneProps) {
  const lamps = lot.protective();
  const w = Math.max(3.2, lamps.length * 0.7 + 0.4);
  return (
    <group position={[MDB[0], 0, MDB[1]]}>
      <mesh position-y={1.1} castShadow>
        <boxGeometry args={[w, 2.2, 1]} />
        <meshStandardMaterial color="#c2c8cf" />
      </mesh>
      {lamps.map((id, i) => (
        <DeviceLamp
          key={id}
          lot={lot}
          id={id}
          x={-w / 2 + 0.5 + i * 0.7}
          active={selected?.kind === 'device' && selected.id === id}
          onSelect={onSelect}
        />
      ))}
      <Label y={3}>Switchboard</Label>
    </group>
  );
}

function DeviceLamp(props: { lot: Lot; id: string; x: number; active: boolean; onSelect: SceneProps['onSelect'] }) {
  const mat = useRef<MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    const n = props.lot.state.nodes[props.id];
    const heat = Math.max(...(n?.thermal ?? [0]));
    const c = n?.tripped ? '#ff3b3b' : heat > 0.6 ? '#ffb020' : '#2fe08a';
    mat.current?.color.set(c);
    mat.current?.emissive.set(c);
    if (mat.current) mat.current.emissiveIntensity = n?.tripped ? 1 + Math.sin(clock.elapsedTime * 8) : 0.9;
  });
  return (
    <group position={[props.x, 1.4, 0.55]}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a three.js object; the HUD's protection panel is the keyboard path */}
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          props.onSelect({ kind: 'device', lot: props.lot.id, id: props.id });
        }}
        onPointerOver={() => {
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
        }}
      >
        <boxGeometry args={[0.5, 0.9, 0.2]} />
        <meshStandardMaterial ref={mat} />
      </mesh>
      {props.active && (
        <Html center position={[0, 1.2, 0]} className="pointer-events-none">
          <div className="panel whitespace-nowrap px-2 py-0.5 text-xs">{deviceName(props.id)}</div>
        </Html>
      )}
    </group>
  );
}

function Battery({ lot }: { lot: Lot }) {
  const fill = useRef<Group>(null);
  useFrame(() => {
    const soc = (lot.site.models.get('BAT') as { soc?: number } | undefined)?.soc ?? 0;
    if (fill.current) fill.current.scale.x = Math.max(0.01, soc);
  });
  return (
    <group position={[BATTERY[0], 0, BATTERY[1]]}>
      <mesh position-y={1.3} castShadow>
        <boxGeometry args={[6, 2.6, 2.4]} />
        <meshStandardMaterial color="#e9edf1" />
      </mesh>
      <group ref={fill} position={[-2.5, 1.3, 1.22]}>
        <mesh position-x={2.5}>
          <planeGeometry args={[5, 0.5]} />
          <meshStandardMaterial color="#38e8c6" emissive="#38e8c6" emissiveIntensity={0.6} />
        </mesh>
      </group>
      <Label y={3.6}>Battery 120 kWh</Label>
    </group>
  );
}

function Carport() {
  return (
    <group position={[0, 0, 7.2]}>
      <mesh position-y={3.4} rotation-x={-0.08} castShadow>
        <boxGeometry args={[20, 0.15, 6.4]} />
        <meshStandardMaterial color="#1d3557" metalness={0.4} roughness={0.3} />
      </mesh>
      {[-9.5, -3.2, 3.2, 9.5].map((x) => (
        <mesh key={x} position={[x, 1.7, 2.8]} castShadow>
          <cylinderGeometry args={[0.12, 0.12, 3.4]} />
          <meshStandardMaterial color="#aab2bc" />
        </mesh>
      ))}
    </group>
  );
}

function Label({ y, children }: { y: number; children: string }) {
  return (
    <Html center position={[0, y, 0]} className="pointer-events-none" zIndexRange={[10, 0]}>
      <div className="whitespace-nowrap rounded bg-black/45 px-1.5 py-0.5 text-[11px] text-slate-200">{children}</div>
    </Html>
  );
}
