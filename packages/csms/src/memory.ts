/**
 * An in-memory WebSocket transport: a client socket shaped like Bun's `WebSocket` (and core's `SocketLike`) wired to
 * server handlers shaped like `Bun.serve`'s `websocket` ones, with no TCP. Every delivery (open, message, close) runs
 * on its own `setImmediate`, never synchronously, in the order it was caused, so re-entrancy and ordering match a
 * real localhost socket. The behaviour copies what Bun does over TCP:
 *
 * - the handshake answers after a macrotask; a refused upgrade fires `error` ("Expected 101 status code: <status>")
 *   then `close` 1006; the server's `open` runs before the client's;
 * - `send` while connecting throws `InvalidStateError`; after `close` it is ignored;
 * - a client `close()` without a code reaches both ends as 1005; a server `close()` without a code as 1000; a close
 *   while connecting fails the handshake (`error`, then `close` 1006); `terminate()` is 1006 on both ends;
 * - an invalid close code (1004-1006, outside 1000-1014 and 3000-4999) throws `InvalidAccessError`.
 *
 * TLS is not modelled: tests of TLS use the real server.
 */

/** The server's end of an in-memory socket; the subset of `Bun.ServerWebSocket` the CSMS doubles use. */
export type MemoryServerSocket<D> = {
  readonly data: D;
  /** 1 open, 2 closing, 3 closed. */
  readonly readyState: number;
  send(raw: string): number;
  close(code?: number, reason?: string): void;
  terminate(): void;
};

/** The upgrade request as the endpoint sees it. */
export type MemoryUpgradeRequest = { url: URL; headers: Headers };

/** A server reachable in memory: `upgrade` decides the handshake, the rest are `Bun.serve`'s websocket handlers. */
export type MemoryEndpoint<D> = {
  /**
   * Accept with the socket data and the negotiated subprotocol, refuse with an HTTP status, or `null` when nothing
   * listens any more (the client fails as a refused TCP connect does).
   */
  upgrade(req: MemoryUpgradeRequest): { data: D; protocol: string } | { status: number } | null;
  open(ws: MemoryServerSocket<D>): void;
  message(ws: MemoryServerSocket<D>, raw: string): void;
  close(ws: MemoryServerSocket<D>, code: number, reason: string): void;
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function checkCloseCode(code: number | undefined): void {
  if (code === undefined) return;
  const ok = (code >= 1000 && code <= 1014 && (code < 1004 || code > 1006)) || (code >= 3000 && code <= 4999);
  if (!ok) {
    throw new DOMException(
      `The close code must be a valid WebSocket close code (1000-1014, excluding the reserved codes 1004-1006, or in the range of 3000 to 4999). Received ${code}.`,
      'InvalidAccessError',
    );
  }
}

/** The client end. Structurally a core `SocketLike` (plus `terminate` and `binaryType`, as Bun's WebSocket has). */
export class MemorySocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  binaryType: 'arraybuffer' | 'blob' | 'nodebuffer' = 'nodebuffer';

  private state = CONNECTING;
  private negotiated = '';
  private server: ServerEnd<unknown> | undefined;

  constructor(
    readonly url: string,
    private readonly endpoint: MemoryEndpoint<unknown> | undefined,
    private readonly protocols: string[],
    private readonly headers: Record<string, string>,
  ) {
    setImmediate(() => this.handshake());
  }

  get readyState(): number {
    return this.state;
  }

  get protocol(): string {
    return this.negotiated;
  }

  send(data: string): void {
    if (this.state === CONNECTING) throw new DOMException('The object is in an invalid state.', 'InvalidStateError');
    if (this.state !== OPEN) return;
    const server = this.server as ServerEnd<unknown>;
    const raw = String(data);
    setImmediate(() => server.receive(raw));
  }

  close(code?: number, reason?: string): void {
    checkCloseCode(code);
    if (this.state === CONNECTING) {
      this.state = CLOSING;
      return;
    }
    if (this.state !== OPEN) return;
    this.state = CLOSING;
    const server = this.server as ServerEnd<unknown>;
    setImmediate(() => {
      server.closed(code ?? 1005, reason ?? '');
      this.closed(code ?? 1005, reason ?? '', true);
    });
  }

  /** Drop the connection without a closing handshake: 1006 on both ends. */
  terminate(): void {
    if (this.state === CLOSED) return;
    const wasOpen = this.state === OPEN || this.server !== undefined;
    this.state = CLOSED;
    setImmediate(() => {
      this.fireClose(1006, '', false);
      if (wasOpen) this.server?.closed(1006, '');
    });
  }

  /** @internal The server closed (or dropped) the connection. */
  closed(code: number, reason: string, clean: boolean): void {
    if (this.state === CLOSED) return;
    this.state = CLOSED;
    this.fireClose(code, reason, clean);
  }

  /** @internal A message from the server. Like a browser, drop it unless the socket is open. */
  receive(raw: string): void {
    if (this.state !== OPEN) return;
    this.onmessage?.(new MessageEvent('message', { data: raw }));
  }

  private handshake(): void {
    if (this.state === CLOSED) return;
    if (this.state === CLOSING) {
      this.fail('WebSocket is closed before the connection is established');
      return;
    }
    if (!this.endpoint) {
      this.fail('Failed to connect');
      return;
    }
    const headers = new Headers(this.headers);
    if (this.protocols.length > 0) headers.set('sec-websocket-protocol', this.protocols.join(', '));
    const answer = this.endpoint.upgrade({ url: new URL(this.url), headers });
    if (!answer) {
      this.fail('Failed to connect');
      return;
    }
    if ('status' in answer) {
      this.fail(`Expected 101 status code: ${answer.status}`);
      return;
    }
    const server = new ServerEnd(answer.data, this.endpoint, this);
    this.server = server;
    this.negotiated = answer.protocol;
    this.endpoint.open(server);
    this.state = OPEN;
    this.onopen?.(new Event('open'));
  }

  private fail(message: string): void {
    this.state = CLOSED;
    this.onerror?.(new ErrorEvent('error', { message: `WebSocket connection to '${this.url}' failed: ${message}` }));
    this.fireClose(1006, '', false);
  }

  private fireClose(code: number, reason: string, wasClean: boolean): void {
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean }));
  }
}

class ServerEnd<D> implements MemoryServerSocket<D> {
  private state = OPEN;

  constructor(
    readonly data: D,
    private readonly endpoint: MemoryEndpoint<D>,
    private readonly client: MemorySocket,
  ) {}

  get readyState(): number {
    return this.state;
  }

  send(raw: string): number {
    if (this.state !== OPEN) return 0;
    const text = String(raw);
    setImmediate(() => this.client.receive(text));
    return text.length;
  }

  close(code?: number, reason?: string): void {
    checkCloseCode(code);
    if (this.state !== OPEN) return;
    this.state = CLOSING;
    setImmediate(() => {
      this.closed(code ?? 1000, reason ?? '');
      this.client.closed(code ?? 1000, reason ?? '', true);
    });
  }

  terminate(): void {
    if (this.state !== OPEN) return;
    this.state = CLOSING;
    setImmediate(() => {
      this.closed(1006, '');
      this.client.closed(1006, '', false);
    });
  }

  /** @internal A message from the client. */
  receive(raw: string): void {
    if (this.state !== OPEN) return;
    this.endpoint.message(this, raw);
  }

  /** @internal The connection ended; tells the endpoint once. */
  closed(code: number, reason: string): void {
    if (this.state === CLOSED) return;
    this.state = CLOSED;
    this.endpoint.close(this, code, reason);
  }
}

/** Open an in-memory socket to `endpoint`. */
export function connectMemory<D>(
  endpoint: MemoryEndpoint<D>,
  url: string,
  protocols: string[] = [],
  headers: Record<string, string> = {},
): MemorySocket {
  return new MemorySocket(url, endpoint as MemoryEndpoint<unknown>, protocols, headers);
}

const registry = new Map<string, MemoryEndpoint<unknown>>();
let nextMemoryHost = 1;

/** `ws://host:port` of a URL, the key the in-memory registry uses. */
function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

/**
 * Make `endpoint` reachable through `connectInMemory` at `url`'s origin (default: a fresh `ws://memory-N.invalid`,
 * which no DNS resolves, so a client that bypasses the in-memory transport fails at once). Returns the URL and a
 * function that removes it.
 */
export function listenInMemory<D>(endpoint: MemoryEndpoint<D>, url?: string): { url: string; close: () => void } {
  const origin = url ? originOf(url) : `ws://memory-${nextMemoryHost++}.invalid`;
  registry.set(origin, endpoint as MemoryEndpoint<unknown>);
  return {
    url: origin,
    close: () => {
      if (registry.get(origin) === endpoint) registry.delete(origin);
    },
  };
}

/**
 * A socket factory for `ConnectionOptions.socket` / `StationConfig.socket`: connects in memory to whatever is
 * listening at the URL's origin (every `Csms` is). Nothing there: the socket fails like a refused TCP connect.
 */
export function connectInMemory(
  url: string,
  protocols: string[] = [],
  headers: Record<string, string> = {},
): MemorySocket {
  return new MemorySocket(url, registry.get(originOf(url)), protocols, headers);
}

/** True when something listens in memory at `url`'s origin, so `connectInMemory` reaches it. */
export function listensInMemory(url: string): boolean {
  return registry.has(originOf(url));
}
