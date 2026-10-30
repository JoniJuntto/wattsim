import type { StoreAction } from '../state/store';
import type { StreamMessage } from './types';

export type StreamStatus =
  | { state: 'connecting'; attempt: number }
  | { state: 'open' }
  | { state: 'waiting'; attempt: number; retryAt: number };

export type Backoff = { initialMs: number; maxMs: number; factor: number };
export const DEFAULT_BACKOFF: Backoff = { initialMs: 500, maxMs: 10_000, factor: 2 };

/** Delay before reconnect attempt `attempt` (1-based): exponential, capped, with ±20% jitter. */
export function backoffDelay(
  attempt: number,
  b: Backoff = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = Math.min(b.maxMs, b.initialMs * b.factor ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + 0.4 * random()));
}

const TYPES = new Set([
  'snapshot',
  'station',
  'removed',
  'frame',
  'violation',
  'error',
  'run',
  'run.event',
  'csms',
  'csms.session',
  'csms.violation',
  'series',
  'fleet',
  'site',
  'site.allocation',
  'site.event',
  'site.summary',
  'site.removed',
]);

const isObject = (v: unknown) => typeof v === 'object' && v !== null;

/** Parses one text message from `/api/stream`; null for anything that is not a known message. */
export function parseStreamMessage(data: unknown): StreamMessage | null {
  if (typeof data !== 'string') return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== 'string' || !TYPES.has(m.type)) return null;
  switch (m.type) {
    case 'snapshot':
      return Array.isArray(m.stations) ? (m as StreamMessage) : null;
    case 'station':
      return typeof m.station === 'object' && m.station !== null ? (m as StreamMessage) : null;
    case 'removed':
      return typeof m.id === 'string' ? (m as StreamMessage) : null;
    case 'frame':
      return typeof m.frame === 'object' && m.frame !== null ? (m as StreamMessage) : null;
    case 'violation':
      return typeof m.stationId === 'string' && typeof m.violation === 'object' ? (m as StreamMessage) : null;
    case 'error':
      return typeof m.stationId === 'string' && typeof m.message === 'string' ? (m as StreamMessage) : null;
    case 'run':
      return isObject(m.run) ? (m as StreamMessage) : null;
    case 'run.event':
      return typeof m.runId === 'string' && isObject(m.event) ? (m as StreamMessage) : null;
    case 'csms':
      return isObject(m.csms) ? (m as StreamMessage) : null;
    case 'csms.session':
      return isObject(m.session) ? (m as StreamMessage) : null;
    case 'csms.violation':
      return isObject(m.violation) ? (m as StreamMessage) : null;
    case 'series':
      return typeof m.stationId === 'string' && Array.isArray(m.points) ? (m as StreamMessage) : null;
    case 'fleet':
      return isObject(m.bin) ? (m as StreamMessage) : null;
    case 'site':
      return typeof m.siteId === 'string' && typeof m.seq === 'number' && isObject(m.nodes)
        ? (m as StreamMessage)
        : null;
    case 'site.allocation':
      return typeof m.siteId === 'string' && isObject(m.allocation) ? (m as StreamMessage) : null;
    case 'site.event':
      return typeof m.siteId === 'string' && isObject(m.event) ? (m as StreamMessage) : null;
    case 'site.summary':
      return isObject(m.site) ? (m as StreamMessage) : null;
    case 'site.removed':
      return typeof m.id === 'string' ? (m as StreamMessage) : null;
    default:
      return null;
  }
}

export type StreamHandler = {
  /** Feed one raw WebSocket message. */
  receive(data: unknown): void;
  /** Dispatch everything queued so far. */
  flush(): void;
};

/**
 * Turns raw stream messages into store actions, batched: messages queue up and go to `dispatch` together on the
 * next `schedule` tick, so a burst of frames costs one render. `onError` fires immediately for `error` messages.
 */
export function createStreamHandler(opts: {
  dispatch: (actions: StoreAction[]) => void;
  onError?: (stationId: string, message: string) => void;
  schedule?: (fn: () => void) => void;
}): StreamHandler {
  const schedule = opts.schedule ?? ((fn) => setTimeout(fn, 50));
  let queue: StoreAction[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    opts.dispatch(batch);
  };
  return {
    receive(data) {
      const msg = parseStreamMessage(data);
      if (!msg) return;
      // A snapshot replaces everything queued before it.
      if (msg.type === 'snapshot') queue = [];
      queue.push(msg);
      if (msg.type === 'error') opts.onError?.(msg.stationId, msg.message);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    flush,
  };
}

type SocketLike = {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
};

export type StreamClientOptions = {
  url: string;
  onMessage: (data: unknown) => void;
  onStatus?: (status: StreamStatus) => void;
  backoff?: Backoff;
  createSocket?: (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  random?: () => number;
};

/** One WebSocket to `/api/stream`, reconnecting with exponential backoff until `stop()`. */
export class StreamClient {
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  /** Consecutive closes without a successful open. */
  private failures = 0;
  private stopped = true;

  constructor(private readonly opts: StreamClientOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.opts.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
  }

  /** Skip the remaining backoff wait and try now. */
  retryNow(): void {
    if (this.stopped || this.socket) return;
    if (this.timer !== null) (this.opts.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
    this.connect();
  }

  private connect(): void {
    this.opts.onStatus?.({ state: 'connecting', attempt: this.failures + 1 });
    const create = this.opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const socket = create(this.opts.url);
    this.socket = socket;
    socket.onopen = () => {
      this.failures = 0;
      this.opts.onStatus?.({ state: 'open' });
    };
    socket.onmessage = (ev) => this.opts.onMessage(ev.data);
    socket.onerror = () => {
      // `close` follows and schedules the retry.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      this.failures++;
      const delay = backoffDelay(this.failures, this.opts.backoff, this.opts.random);
      const now = (this.opts.now ?? Date.now)();
      this.opts.onStatus?.({ state: 'waiting', attempt: this.failures, retryAt: now + delay });
      this.timer = (this.opts.setTimer ?? setTimeout)(() => {
        this.timer = null;
        this.connect();
      }, delay);
    };
  }
}

/** `ws(s)://<host>/api/stream` for the page's own origin. */
export function streamUrl(loc: { protocol: string; host: string } = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/api/stream`;
}
