/** Thin client for the UI server's HTTP API (docs/superpowers/plans/2026-10-30-ui.md). */

/** A non-2xx answer or an unreachable server; `message` is the server's own `error` text when it sent one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ApiResponse = { status: number; body: unknown };

export class Api {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<ApiResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(`cannot reach the wattsim server at ${this.baseUrl}: ${e instanceof Error ? e.message : e}`);
    }
    const text = await res.text();
    let parsed: unknown = text;
    if (res.headers.get('content-type')?.includes('application/json') && text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep the text
      }
    }
    if (!res.ok) {
      const error = (parsed as { error?: unknown } | null)?.error;
      throw new ApiError(typeof error === 'string' ? error : `HTTP ${res.status} ${res.statusText}`, res.status);
    }
    return { status: res.status, body: res.status === 204 ? undefined : parsed };
  }

  async get<T>(path: string): Promise<T> {
    return (await this.request('GET', path)).body as T;
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    return (await this.request('POST', path, body)).body as T;
  }

  async delete(path: string): Promise<void> {
    await this.request('DELETE', path);
  }
}
