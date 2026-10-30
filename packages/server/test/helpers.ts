import { type RunningServer, type StreamMessage, startServer } from '../src/index';

export type Api = {
  server: RunningServer;
  url: string;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  del(path: string): Promise<Response>;
};

export async function boot(opts: { uiDir?: string } = {}): Promise<Api> {
  const server = await startServer({ port: 0, uiDir: opts.uiDir ?? '/nonexistent-wattsim-ui' });
  const url = server.url;
  return {
    server,
    url,
    get: (path) => fetch(url + path),
    post: (path, body) =>
      fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
    del: (path) => fetch(url + path, { method: 'DELETE' }),
  };
}

/** Collects every message from `/api/stream`. */
export class StreamClient {
  readonly messages: StreamMessage[] = [];
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => this.messages.push(JSON.parse(String(ev.data)) as StreamMessage);
  }

  static async open(baseUrl: string): Promise<StreamClient> {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/stream`);
    const client = new StreamClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('stream did not open'));
    });
    await until(() => client.messages.length > 0, 1000, 'snapshot');
    return client;
  }

  of<T extends StreamMessage['type']>(type: T): Extract<StreamMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<StreamMessage, { type: T }> => m.type === type);
  }

  close(): void {
    this.ws.close();
  }
}

export async function until(cond: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await Bun.sleep(5);
  }
}
