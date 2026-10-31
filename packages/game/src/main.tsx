import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// VirtualClock yields with setImmediate between timers; browsers have no such thing.
if (typeof globalThis.setImmediate !== 'function') {
  const channel = new MessageChannel();
  const queue: Array<() => void> = [];
  channel.port1.onmessage = () => queue.shift()?.();
  (globalThis as { setImmediate?: unknown }).setImmediate = (fn: () => void) => {
    queue.push(fn);
    channel.port2.postMessage(0);
  };
}

// No StrictMode: its double mount builds a second world of stations and trips up drei's <Html> roots.
createRoot(document.getElementById('root') as HTMLElement).render(<App />);
