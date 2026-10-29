/**
 * Minimal typed event emitter. No dependency, no Node `events` import.
 *
 * `Events` maps event name -> listener argument tuple, e.g.
 *   type E = { state: [ConnectionState]; error: [Error] };
 */
import { throwCollected } from './clock';

type Listener<Args extends unknown[]> = (...args: Args) => void;
type AnyListener = (...args: unknown[]) => void;
type Entry = { fn: AnyListener; once: boolean };

export class TypedEmitter<Events extends Record<string, unknown[]>> {
  private readonly listeners = new Map<keyof Events, Entry[]>();

  /** Register a listener. Returns a function that removes it. */
  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    this.add(event, fn as unknown as AnyListener, false);
    return () => this.off(event, fn);
  }

  /** Register a listener that fires once. Returns a function that removes it. */
  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    this.add(event, fn as unknown as AnyListener, true);
    return () => this.off(event, fn);
  }

  /** Remove one listener (works for both `on` and `once` registrations). */
  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    const entries = this.listeners.get(event);
    if (!entries) return;
    const next = entries.filter((e) => e.fn !== (fn as unknown as AnyListener));
    if (next.length === 0) this.listeners.delete(event);
    else this.listeners.set(event, next);
  }

  /** Call every listener in registration order. Returns true if any listener was called. */
  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const entries = this.listeners.get(event);
    if (!entries || entries.length === 0) return false;
    // Snapshot so listeners may add/remove during emit without affecting this dispatch.
    const snapshot = entries.slice();
    const remaining = entries.filter((e) => !e.once);
    if (remaining.length === 0) this.listeners.delete(event);
    else this.listeners.set(event, remaining);
    // One throwing listener must not starve the rest; errors are rethrown once every listener has run.
    const errors: unknown[] = [];
    for (const e of snapshot) {
      try {
        (e.fn as unknown as Listener<Events[K]>)(...args);
      } catch (err) {
        errors.push(err);
      }
    }
    throwCollected(errors, `listeners threw during emit('${String(event)}')`);
    return true;
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  removeAllListeners(event?: keyof Events): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }

  private add(event: keyof Events, fn: AnyListener, once: boolean): void {
    const entries = this.listeners.get(event);
    if (entries) entries.push({ fn, once });
    else this.listeners.set(event, [{ fn, once }]);
  }
}
