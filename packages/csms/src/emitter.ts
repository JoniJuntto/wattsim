/** Minimal typed event emitter (the shape of core's `TypedEmitter`, without the dependency). */
type Listener<Args extends unknown[]> = (...args: Args) => void;

export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly listeners = new Map<keyof Events, Array<Listener<never[]>>>();

  /** Register a listener. Returns a function that removes it. */
  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...list, fn as unknown as Listener<never[]>]);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    const list = this.listeners.get(event);
    if (list)
      this.listeners.set(
        event,
        list.filter((f) => f !== (fn as unknown as Listener<never[]>)),
      );
  }

  /**
   * Call every listener in registration order. A throwing listener does not starve the rest; the first error is
   * rethrown once all have run. Returns true if any listener was called.
   */
  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return false;
    let failure: { err: unknown } | undefined;
    for (const fn of list) {
      try {
        (fn as unknown as Listener<Events[K]>)(...args);
      } catch (err) {
        failure ??= { err };
      }
    }
    if (failure) throw failure.err;
    return true;
  }
}
