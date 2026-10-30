import type {
  ActionResult,
  ChaosRuleBody,
  ChaosRuleView,
  ConformanceViolation,
  CreateStationBody,
  CreateStationsBulkBody,
  CsmsReportSummary,
  CsmsView,
  FrameEvent,
  Health,
  Meta,
  RecordingView,
  RunDetail,
  RunSummary,
  SavedScenario,
  SavedScenarioSummary,
  ScenarioCheck,
  StartRunBody,
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
    /** The parsed error body, e.g. `{ error, diagnostics }` for a scenario that does not parse. */
    readonly body?: unknown,
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
    let data: { error?: unknown } | undefined;
    try {
      data = (await res.json()) as { error?: unknown };
      if (typeof data.error === 'string') message = data.error;
    } catch {
      // Not JSON: keep the generic message.
    }
    throw new ApiError(res.status, message, data);
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

  checkScenario: (source: string) => request<ScenarioCheck>('POST', '/api/scenario/check', { source }),
  formatScenario: (source: string) => request<{ source: string }>('POST', '/api/scenario/format', { source }),
  scenarios: () => request<SavedScenarioSummary[]>('GET', '/api/scenarios'),
  scenario: (id: string) => request<SavedScenario>('GET', `/api/scenarios/${encodeURIComponent(id)}`),
  createScenario: (body: { name: string; source: string }) => request<SavedScenario>('POST', '/api/scenarios', body),
  updateScenario: (id: string, body: { name: string; source: string }) =>
    request<SavedScenario>('PUT', `/api/scenarios/${encodeURIComponent(id)}`, body),
  deleteScenario: (id: string) => request<void>('DELETE', `/api/scenarios/${encodeURIComponent(id)}`),

  runs: () => request<RunSummary[]>('GET', '/api/runs'),
  run: (id: string) => request<RunDetail>('GET', `/api/runs/${encodeURIComponent(id)}`),
  startRun: (body: StartRunBody) => request<RunSummary>('POST', '/api/runs', body),
  cancelRun: (id: string) => request<RunDetail>('POST', `/api/runs/${encodeURIComponent(id)}/cancel`),
  deleteRun: (id: string) => request<void>('DELETE', `/api/runs/${encodeURIComponent(id)}`),

  recordings: () => request<RecordingView[]>('GET', '/api/recordings'),
  saveRecording: (body: { name?: string; stationId?: string }) =>
    request<RecordingView>('POST', '/api/recordings', body),
  deleteRecording: (id: string) => request<void>('DELETE', `/api/recordings/${encodeURIComponent(id)}`),

  csms: () => request<CsmsView>('GET', '/api/csms'),
  csmsViolations: (limit = 2000) => request<ConformanceViolation[]>('GET', `/api/csms/violations?limit=${limit}`),
  csmsFrames: (identity: string) =>
    request<FrameEvent[]>('GET', `/api/csms/sessions/${encodeURIComponent(identity)}/frames?limit=500`),
  csmsReports: () => request<CsmsReportSummary[]>('GET', '/api/csms/reports'),
  saveCsmsReport: (name?: string) =>
    request<CsmsReportSummary>('POST', '/api/csms/reports', name === undefined ? {} : { name }),
  deleteCsmsReport: (id: string) => request<void>('DELETE', `/api/csms/reports/${encodeURIComponent(id)}`),
};

/** Plain links for downloads (the server sets `content-disposition`). */
export const downloads = {
  stationTrace: (id: string) => `${station(id)}/trace`,
  sessionTrace: '/api/session/trace',
  runTrace: (id: string) => `/api/runs/${encodeURIComponent(id)}/trace`,
  runJUnit: (id: string) => `/api/runs/${encodeURIComponent(id)}/junit`,
  recording: (id: string) => `/api/recordings/${encodeURIComponent(id)}`,
  csmsReport: (format: 'json' | 'junit') => `/api/csms/report?format=${format}`,
  savedCsmsReport: (id: string, format: 'json' | 'junit') =>
    `/api/csms/reports/${encodeURIComponent(id)}?format=${format}`,
};
