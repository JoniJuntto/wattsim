import { MapControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import { Color, type DirectionalLight, type HemisphereLight } from 'three';
import { useTick } from '../hooks';
import type { Lot, Selection, World } from '../sim/world';
import { Cars, Techs } from './Cars';
import { Chargers } from './Chargers';
import { Flow } from './Flow';
import { LotModel } from './Lot';
import { Pops } from './Pops';

export type SceneProps = { lot: Lot; selected: Selection | null; onSelect: (s: Selection | null) => void };

/** The lot on screen; switching lots remounts its scene. */
function View(props: { world: World } & Omit<SceneProps, 'lot'>) {
  useTick(props.world, 300);
  const lot = props.world.lot;
  return (
    <group key={lot.id}>
      <LotModel lot={lot} selected={props.selected} onSelect={props.onSelect} />
      <Flow lot={lot} />
      <Chargers lot={lot} selected={props.selected} onSelect={props.onSelect} />
      <Cars lot={lot} />
      <Techs lot={lot} />
      <Pops lot={lot} />
    </group>
  );
}

export function Scene(props: { world: World } & Omit<SceneProps, 'lot'>) {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [-22, 40, 36], fov: 42, near: 0.5, far: 400 }}
      onPointerMissed={() => props.onSelect(null)}
    >
      <Loop world={props.world} />
      <Sky world={props.world} />
      <MapControls target={[-12, 0, -2]} maxPolarAngle={1.25} minDistance={14} maxDistance={110} />
      <View {...props} />
    </Canvas>
  );
}

/** Drives the simulation from the render loop. */
function Loop({ world }: { world: World }) {
  useFrame((_, dt) => world.frame(dt * 1000));
  return null;
}

const DAWN = new Color('#f2a66b');
const NOON = new Color('#9cc7e8');
const DUSK = new Color('#1c2440');

/** Sky colour and sun follow the clock: the day starts at dawn and ends in the dark. */
function Sky({ world }: { world: World }) {
  const sun = useRef<DirectionalLight>(null);
  const hemi = useRef<HemisphereLight>(null);
  const scene = useThree((s) => s.scene);
  const bg = useRef(new Color());
  useFrame(() => {
    const h = world.hour;
    const day = Math.max(0, Math.sin(((h - 6) / 14) * Math.PI));
    if (h < 12) bg.current.copy(DAWN).lerp(NOON, Math.min(1, (h - 6.5) / 3));
    else bg.current.copy(NOON).lerp(DUSK, Math.max(0, (h - 16) / 4.5));
    scene.background = bg.current;
    if (sun.current) {
      sun.current.intensity = 1.2 + 2.6 * day;
      const a = ((h - 6) / 14) * Math.PI;
      sun.current.position.set(Math.cos(a) * -60, 20 + Math.sin(a) * 50, 25);
    }
    if (hemi.current) hemi.current.intensity = 1.1 + 1.2 * day;
  });
  return (
    <>
      <hemisphereLight ref={hemi} args={['#cfe3ff', '#20262e', 0.8]} />
      <directionalLight
        ref={sun}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-45}
        shadow-camera-right={45}
        shadow-camera-top={35}
        shadow-camera-bottom={-35}
      />
    </>
  );
}
