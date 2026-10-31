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
  /** Without credentials, so it is safe to print. */
  readonly baseUrl: string;
  /** `Basic …` from `user:password@` in the URL, sent on every request. */
  private readonly auth: string | undefined;

  constructor(baseUrl: string) {
    // Errors here never echo the URL: it may hold a password.
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new ApiError('the wattsim server URL must start with http:// or https://');
    }
    if (u.username || u.password) {
      let pair: string;
      try {
        pair = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      } catch {
        throw new ApiError('percent-encode special characters in the URL credentials, e.g. % as %25 and # as %23');
      }
      this.auth = `Basic ${Buffer.from(pair).toString('base64')}`;
      u.username = '';
      u.password = '';
    }
    this.baseUrl = u.href.replace(/\/+$/, '');
  }

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<ApiResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.auth === undefined ? {} : { authorization: this.auth }),
        },
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
