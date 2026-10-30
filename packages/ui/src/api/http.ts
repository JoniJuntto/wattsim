import type {
  ActionResult,
  ChaosRuleBody,
  ChaosRuleView,
  CreateStationBody,
  CreateStationsBulkBody,
  FrameEvent,
  Health,
  Meta,
  StationAction,
  StationView,
  ValidateBody,
  ValidateResult,
} from './types';

/** A 4xx/5xx from the server; `message` is the server's `{ error }` text when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await requestWithStatus<T>(method, path, body)).data;
}

async function requestWithStatus<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const init: RequestInit = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...init.headers, 'content-type': 'application/json' };
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'The wattsim server is not reachable. Is `wattsim ui` still running?');
  }
  if (!res.ok) {
    let message = `${method} ${path} failed with HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === 'string') message = data.error;
    } catch {
      // Not JSON: keep the generic message.
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return { status: 204, data: undefined as T };
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: (type.includes('json') ? await res.json() : await res.text()) as T };
}

const station = (id: string) => `/api/stations/${encodeURIComponent(id)}`;

export const api = {
  health: () => request<Health>('GET', '/api/health'),
  meta: () => request<Meta>('GET', '/api/meta'),
  stations: () => request<StationView[]>('GET', '/api/stations'),
  createStation: (body: CreateStationBody) => request<StationView>('POST', '/api/stations', body),
  createStations: (body: CreateStationsBulkBody) => request<StationView[]>('POST', '/api/stations', body),
  deleteStation: (id: string) => request<void>('DELETE', station(id)),
  /**
   * `pending` is true when the server answered 202: the station had not finished after 5 s (unreachable CSMS, calls
   * queued while offline). A later failure arrives as a stream `error` message.
   */
  action: async (id: string, action: StationAction): Promise<ActionResult & { pending: boolean }> => {
    const { status, data } = await requestWithStatus<ActionResult>('POST', `${station(id)}/actions`, action);
    return { ...data, pending: status === 202 };
  },
  addChaos: (id: string, rule: ChaosRuleBody) => request<ChaosRuleView>('POST', `${station(id)}/chaos`, rule),
  removeChaos: (id: string, ruleId: string) =>
    request<void>('DELETE', `${station(id)}/chaos/${encodeURIComponent(ruleId)}`),
  validate: (body: ValidateBody) => request<ValidateResult>('POST', '/api/validate', body),
  frames: (id: string, limit = 2000) => request<FrameEvent[]>('GET', `${station(id)}/frames?limit=${limit}`),
  startLoopback: () => request<{ url: string }>('POST', '/api/loopback'),
  stopLoopback: () => request<void>('DELETE', '/api/loopback'),
  session: () => request<string>('GET', '/api/session'),
};
