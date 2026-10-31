/** Game sounds, synthesised with WebAudio: no files to load. Muted state survives reloads. */
import type { Sound } from './sim/world';

let ctx: AudioContext | undefined;
const last = new Map<Sound, number>();
const KEY = 'wattsim-game-muted';

export let muted = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(KEY, m ? '1' : '0');
  } catch {}
}

/** Call from a click: browsers only start audio after a gesture. */
export function unlockAudio(): void {
  ctx ??= new AudioContext();
  void ctx.resume();
}

type Note = { f: number; at: number; dur: number; type?: OscillatorType; gain?: number; slide?: number };

const SOUNDS: Record<Sound, Note[]> = {
  cash: [
    { f: 1320, at: 0, dur: 0.07, gain: 0.12 },
    { f: 1980, at: 0.06, dur: 0.12, gain: 0.1 },
  ],
  trip: [
    { f: 110, at: 0, dur: 0.45, type: 'sawtooth', gain: 0.25, slide: 40 },
    { f: 70, at: 0.02, dur: 0.5, type: 'square', gain: 0.15, slide: 30 },
  ],
  alarm: [
    { f: 880, at: 0, dur: 0.12, type: 'square', gain: 0.06 },
    { f: 660, at: 0.16, dur: 0.12, type: 'square', gain: 0.06 },
  ],
  ticket: [
    { f: 988, at: 0, dur: 0.1, type: 'triangle', gain: 0.12 },
    { f: 1319, at: 0.11, dur: 0.16, type: 'triangle', gain: 0.12 },
  ],
  solved: [
    { f: 784, at: 0, dur: 0.09, type: 'triangle', gain: 0.12 },
    { f: 1047, at: 0.09, dur: 0.18, type: 'triangle', gain: 0.12 },
  ],
  failed: [
    { f: 330, at: 0, dur: 0.14, type: 'sawtooth', gain: 0.08 },
    { f: 247, at: 0.14, dur: 0.24, type: 'sawtooth', gain: 0.08 },
  ],
  star: [
    { f: 1047, at: 0, dur: 0.1, gain: 0.12 },
    { f: 1319, at: 0.1, dur: 0.1, gain: 0.12 },
    { f: 1568, at: 0.2, dur: 0.25, gain: 0.12 },
  ],
  dilemma: [
    { f: 523, at: 0, dur: 0.12, type: 'triangle', gain: 0.14 },
    { f: 415, at: 0.14, dur: 0.22, type: 'triangle', gain: 0.14 },
  ],
};

export function play(s: Sound): void {
  if (muted || !ctx || ctx.state !== 'running') return;
  // The same sound twice within 120 ms is one sound (eight cars leaving in one step).
  const now = performance.now();
  if (now - (last.get(s) ?? 0) < 120) return;
  last.set(s, now);
  const t0 = ctx.currentTime;
  for (const n of SOUNDS[s]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = n.type ?? 'sine';
    osc.frequency.setValueAtTime(n.f, t0 + n.at);
    if (n.slide) osc.frequency.exponentialRampToValueAtTime(n.slide, t0 + n.at + n.dur);
    g.gain.setValueAtTime(0.0001, t0 + n.at);
    g.gain.exponentialRampToValueAtTime(n.gain ?? 0.1, t0 + n.at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.02);
  }
}
