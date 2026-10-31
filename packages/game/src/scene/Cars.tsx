import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group, Mesh, MeshBasicMaterial } from 'three';
import { useTick } from '../hooks';
import { bayById, QUEUE } from '../sim/layout';
import { type Car, type Lot, pathAt } from '../sim/world';

export function Cars({ lot }: { lot: Lot }) {
  useTick(lot.w, 250);
  return (
    <>
      {lot.cars.map((c) => (
        <CarModel key={c.id} lot={lot} car={c} />
      ))}
    </>
  );
}

/** Where a car is and which way it points (radians about y; 0 = nose to +z). */
function pose(lot: Lot, car: Car): [x: number, z: number, heading: number] {
  const t = lot.now;
  if (car.path && (car.state !== 'waiting' || t < car.path.t0 + car.path.dur)) {
    const [x, z] = pathAt(car.path, t);
    const [x2, z2] = pathAt(car.path, Math.min(t + 400, car.path.t0 + car.path.dur));
    const [x0, z0] = pathAt(car.path, t - 400);
    const dx = x2 - x0;
    const dz = z2 - z0;
    return [x, z, Math.hypot(dx, dz) > 1e-3 ? Math.atan2(dx, dz) : Math.PI / 2];
  }
  if (car.state === 'waiting') {
    const i = lot.cars.filter((c) => c.state === 'waiting').indexOf(car);
    return [QUEUE[0] - i * 5.5, QUEUE[1] + 1.5, Math.PI / 2];
  }
  const bay = bayById(car.bay ?? '');
  if (!bay) return [0, 0, 0];
  return [bay.pos[0], bay.pos[1], bay.facing === 1 ? 0 : Math.PI];
}

function CarModel({ lot, car }: { lot: Lot; car: Car }) {
  const g = useRef<Group>(null);
  const bar = useRef<Mesh>(null);
  const barMat = useRef<MeshBasicMaterial>(null);
  const target = useRef<Mesh>(null);
  useFrame(() => {
    const [x, z, h] = pose(lot, car);
    g.current?.position.set(x, 0, z);
    if (g.current) g.current.rotation.y = h;
    const parked = car.state === 'parked';
    if (bar.current) {
      bar.current.visible = parked;
      bar.current.scale.x = Math.max(0.02, car.soc);
      bar.current.position.x = -1 + car.soc;
    }
    if (target.current) {
      target.current.visible = parked;
      target.current.position.x = -1 + 2 * car.targetSoc;
    }
    if (barMat.current) {
      const left = (car.departAt - lot.now) / 3_600_000;
      const ch = lot.chargers.get(car.bay ?? '');
      const kw = ch?.station.evses[0]?.meter.power ?? 0;
      const needKwh = (car.targetSoc - car.soc) * car.preset.batteryKwh;
      const late = needKwh > 0.2 && (kw <= 0.1 || needKwh / kw > left);
      barMat.current.color.set(car.soc >= car.targetSoc - 0.01 ? '#3fb950' : late ? '#ff5d5d' : '#38e8c6');
    }
  });
  const big = car.preset.name === 'SUV' || car.preset.name === 'Van';
  const len = big ? 4.7 : car.preset.name === 'Hatchback' ? 3.9 : 4.4;
  const tall = car.preset.name === 'Van' ? 1.3 : big ? 0.85 : 0.62;
  return (
    <group ref={g}>
      <mesh position-y={0.25 + tall / 2} castShadow>
        <boxGeometry args={[1.85, tall, len]} />
        <meshStandardMaterial color={car.colour} metalness={0.35} roughness={0.45} />
      </mesh>
      {car.preset.name !== 'Van' && (
        <mesh position={[0, 0.25 + tall + 0.25, -0.2]} castShadow>
          <boxGeometry args={[1.6, 0.5, len * 0.5]} />
          <meshStandardMaterial color="#1a2430" metalness={0.6} roughness={0.2} />
        </mesh>
      )}
      {[-0.95, 0.95].flatMap((x) =>
        [-len * 0.32, len * 0.32].map((z) => (
          <mesh key={`${x}${z}`} position={[x, 0.32, z]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[0.32, 0.32, 0.22, 12]} />
            <meshStandardMaterial color="#111" />
          </mesh>
        )),
      )}
      {/* state of charge, seen from above: fill, and a tick at the driver's target */}
      <group position-y={2.1} rotation-x={-Math.PI / 2}>
        <mesh position-z={-0.001}>
          <planeGeometry args={[2.1, 0.42]} />
          <meshBasicMaterial color="#0b0f14" transparent opacity={0.75} />
        </mesh>
        <mesh ref={bar}>
          <planeGeometry args={[2, 0.3]} />
          <meshBasicMaterial ref={barMat} color="#38e8c6" />
        </mesh>
        <mesh ref={target} position-z={0.001}>
          <planeGeometry args={[0.06, 0.42]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
      </group>
    </group>
  );
}

export function Techs({ lot }: { lot: Lot }) {
  useTick(lot.w, 500);
  return (
    <>
      {lot.techs.map((t) => (
        <TechModel key={t.id} lot={lot} id={t.id} />
      ))}
    </>
  );
}

function TechModel({ lot, id }: { lot: Lot; id: number }) {
  const g = useRef<Group>(null);
  useFrame(({ clock }) => {
    const tech = lot.techs.find((t) => t.id === id);
    if (!tech || !g.current) return;
    const [x, z] = lot.techPos(tech);
    const j = tech.job;
    const walking = j && lot.now < j.t0 + j.walkMs;
    g.current.position.set(x, walking ? Math.abs(Math.sin(clock.elapsedTime * 10)) * 0.15 : 0, z);
    g.current.rotation.z = j && !walking ? Math.sin(clock.elapsedTime * 6) * 0.12 : 0;
  });
  return (
    <group ref={g}>
      <mesh position-y={0.7} castShadow>
        <capsuleGeometry args={[0.28, 0.8, 4, 8]} />
        <meshStandardMaterial color="#ff8a1f" />
      </mesh>
      <mesh position-y={1.5} castShadow>
        <sphereGeometry args={[0.24, 12, 12]} />
        <meshStandardMaterial color="#ffd23f" />
      </mesh>
    </group>
  );
}
