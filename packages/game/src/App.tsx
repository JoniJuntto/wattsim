import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useTick } from './hooks';
import { Alerts, Goals, Inbox, Inspector, OcppLog, Protection, TopBar } from './hud/Hud';
import { BusinessModal, DilemmaModal, GameOver, Intro, Summary } from './hud/Modals';
import { Scene } from './scene/Scene';
import { type Selection, World } from './sim/world';
import { play, unlockAudio } from './sound';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Plays the world's new sounds; a trip shakes the screen and flashes it red. */
function useFx(world: World, root: RefObject<HTMLDivElement | null>, flash: RefObject<HTMLDivElement | null>) {
  const seen = useRef(world.fxs.at(-1)?.id ?? 0);
  useEffect(() => {
    const id = setInterval(() => {
      for (const e of world.fxs) {
        if (e.id <= seen.current) continue;
        seen.current = e.id;
        // Takings at other car parks would be a constant jingle; trouble anywhere is worth hearing.
        if (e.sound && (e.sound !== 'cash' || !e.lot || e.lot === world.view)) play(e.sound);
        if (e.sound !== 'trip') continue;
        flash.current?.animate([{ opacity: 0.45 }, { opacity: 0 }], { duration: 700, easing: 'ease-out' });
        if (!REDUCED) {
          const k = [0, -7, 6, -4, 3, 0];
          root.current?.animate(
            k.map((x, i) => ({ transform: `translate(${x}px, ${k[(i + 2) % k.length]}px)` })),
            { duration: 420 },
          );
        }
      }
    }, 100);
    return () => clearInterval(id);
  }, [world, root, flash]);
}

export function App() {
  const [world, setWorld] = useState<World>();
  const start = useCallback(() => {
    setWorld(undefined);
    World.create(Math.floor(Math.random() * 1e6)).then((w) => {
      w.setPaused(true);
      if (import.meta.env.DEV) (globalThis as { world?: World }).world = w;
      setWorld(w);
    });
  }, []);
  useEffect(() => start(), [start]);
  if (!world) return <div className="grid h-full place-items-center text-slate-400">Booting chargers…</div>;
  return <Game key={world.seed} world={world} onRestart={start} />;
}

function Game({ world, onRestart }: { world: World; onRestart: () => void }) {
  useTick(world, 300);
  const [selected, setSelectedState] = useState<Selection | null>(null);
  const [business, setBusiness] = useState(false);
  // Selecting something at another car park brings that car park on screen.
  const setSelected = (s: Selection | null) => {
    world.select(s);
    setSelectedState(s);
  };
  const openBusiness = (open: boolean) => {
    setBusiness(open);
    world.setPaused(open);
  };
  const [log, setLog] = useState(false);
  const [intro, setIntro] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  useFx(world, root, flash);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === ' ' && !world.dilemma) {
        e.preventDefault();
        world.setPaused(!world.paused);
      }
      const speed = { '1': 60, '2': 120, '3': 240, '4': 480 }[e.key];
      if (speed) world.setSpeed(speed);
      if (e.key === 'Escape') setSelectedState(null);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [world]);

  return (
    <div ref={root} className="relative h-full">
      <Scene world={world} selected={selected} onSelect={setSelected} />
      <div ref={flash} className="pointer-events-none absolute inset-0 z-20 bg-red-600 opacity-0" />
      <div className="pointer-events-none absolute inset-0 z-30 flex flex-col gap-3 p-3">
        <TopBar
          world={world}
          onLog={() => setLog((v) => !v)}
          onHelp={() => setIntro(true)}
          onBusiness={() => openBusiness(true)}
        />
        <div className="flex min-h-0 flex-1 items-start justify-between gap-3">
          <div className="flex max-h-full min-h-0 flex-col gap-2">
            <Protection world={world} onSelect={setSelected} />
            <Inbox world={world} onSelect={setSelected} />
            <Alerts world={world} onSelect={setSelected} />
          </div>
          <div className="flex max-h-full min-h-0 flex-col items-end gap-2">
            <Goals world={world} />
            {selected && <Inspector world={world} selected={selected} />}
          </div>
        </div>
        {log && <OcppLog world={world} station={selected?.kind === 'charger' ? selected.id : undefined} />}
      </div>
      {intro && (
        <Intro
          onStart={() => {
            unlockAudio();
            setIntro(false);
            world.setPaused(false);
          }}
        />
      )}
      {world.dilemma && world.phase === 'day' && <DilemmaModal world={world} />}
      {business && world.phase === 'day' && <BusinessModal world={world} onClose={() => openBusiness(false)} />}
      {world.phase === 'summary' && <Summary world={world} />}
      {world.phase === 'over' && <GameOver world={world} onRestart={onRestart} />}
    </div>
  );
}
