/** Request body schemas. A failed parse becomes a 400 whose `error` names each bad field. */
import { OCPP_VERSIONS } from '@wattsim/protocol';
import { z } from 'zod';

const version = z.enum(OCPP_VERSIONS as unknown as [string, ...string[]]);
const evse = z.number().int().min(1);
const unit = z.number().min(0).max(1);
const positive = z.number().positive();
const stationId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\s/]+$/, 'must not contain whitespace or "/"');

const stationOptions = {
  version,
  csmsUrl: z.string().regex(/^wss?:\/\/\S+$/, 'must be a ws:// or wss:// URL'),
  evses: z.number().int().min(1).max(64).optional(),
  vendor: z.string().min(1).max(20).optional(),
  model: z.string().min(1).max(20).optional(),
  heartbeatMs: z.number().int().positive().optional(),
  meterIntervalMs: z.number().int().positive().optional(),
  phases: z.union([z.literal(1), z.literal(3)]).optional(),
  maxCurrentA: positive.optional(),
  voltageV: positive.optional(),
  basicAuth: z.object({ user: z.string().min(1), password: z.string() }).optional(),
  autoBoot: z.boolean().optional(),
};

export const createStation = z.object({ id: stationId, ...stationOptions });
export const createBulk = z
  .object({
    template: z.string().includes('{i}', { message: 'must contain {i}' }),
    from: z.number().int().min(0),
    to: z.number().int().min(0),
    ...stationOptions,
  })
  .refine((b) => b.to >= b.from, { message: 'must be >= from', path: ['to'] })
  .refine((b) => b.to - b.from < 1000, { message: 'at most 1000 stations per request', path: ['to'] });

export type CreateStation = z.infer<typeof createStation>;
export type StationOptions = Omit<CreateStation, 'id'>;

export const CONNECTOR_STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
] as const;

/** Most reboots one `bootLoop` action takes. */
export const MAX_BOOT_LOOPS = 20;

const withEvse = { evse };
export const ACTION_SCHEMAS = {
  connect: z.object({}),
  disconnect: z.object({}),
  boot: z.object({}),
  heartbeat: z.object({}),
  plug: z.object({
    ...withEvse,
    ev: z
      .object({
        batteryKwh: positive.optional(),
        soc: unit.optional(),
        targetSoc: unit.optional(),
        maxKw: positive.optional(),
      })
      .optional(),
  }),
  unplug: z.object(withEvse),
  ready: z.object(withEvse),
  suspend: z.object(withEvse),
  resume: z.object(withEvse),
  authorize: z.object({ idTag: z.string().min(1) }),
  start: z.object({ ...withEvse, idTag: z.string().min(1).optional() }),
  stop: z.object({ ...withEvse, reason: z.string().min(1).optional() }),
  status: z.object({ ...withEvse, status: z.enum(CONNECTOR_STATUSES) }),
  send: z.object({ action: z.string().min(1), payload: z.record(z.string(), z.unknown()) }),
  // Behavioural faults (core `faults.ts`).
  /** Boot, then reboot right after each Accepted boot `count` times. */
  bootLoop: z.object({ count: z.number().int().min(0).max(MAX_BOOT_LOOPS) }),
  /** A spontaneous Faulted: 1.6 ChargePointErrorCode, 2.x NotifyEvent techCode (default OtherError). */
  fault: z.object({
    ...withEvse,
    code: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be one word of letters, digits and _ (the DSL writes it bare)')
      .max(50)
      .optional(),
  }),
  /** Turn the import register back by `wh`, or reset it to 0; without `evse`, on every EVSE. */
  meter: z
    .object({
      op: z.enum(['backwards', 'reset']),
      evse: evse.optional(),
      wh: z.number().min(0).max(1e9).optional(),
    })
    .refine((b) => (b.op === 'backwards') === (b.wh !== undefined), {
      message: "wh is required for op 'backwards' and only allowed with it",
      path: ['wh'],
    }),
  /** The station resets itself: hard (power loss) or soft (transactions end first). */
  reset: z.object({ mode: z.enum(['hard', 'soft']) }),
} as const;

export type ActionType = keyof typeof ACTION_SCHEMAS;
export type ActionBody = { [K in ActionType]: { type: K } & z.infer<(typeof ACTION_SCHEMAS)[K]> }[ActionType];

/** The original transport faults: core `ChaosEffect`. */
export const CHAOS_FAULTS = ['drop', 'delay', 'duplicate', 'corrupt', 'wrongId', 'callError', 'noResponse'] as const;
/** Milestone-4 transport faults: core `ChaosFaultEffect`. */
export const TRANSPORT_FAULTS = ['jitter', 'reorder', 'halfOpen', 'slowRead', 'reconnectStorm'] as const;
/** Milestone-4 protocol faults: deliberate schema breaks in what the station sends. */
export const PROTOCOL_FAULTS = ['invalidEnum', 'missingField', 'timestamp', 'oversized'] as const;
export const ALL_CHAOS_FAULTS = [...CHAOS_FAULTS, ...TRANSPORT_FAULTS, ...PROTOCOL_FAULTS] as const;
export type ChaosFaultName = (typeof ALL_CHAOS_FAULTS)[number];

/** Largest `oversized` payload the API takes, in kB (1 kB = 1024 bytes). */
export const MAX_OVERSIZED_KB = 1024;
/** Longest delay-like parameter: a day. */
const MAX_MS = 86_400_000;

const ms = z.number().int().min(0).max(MAX_MS);
const positiveMs = z.number().int().min(1).max(MAX_MS);

/** The parameters each fault takes: `true` required, `false` optional. Any other parameter is a 400. */
const FAULT_PARAMS: Record<ChaosFaultName, Record<string, boolean>> = {
  drop: {},
  delay: { delayMs: true },
  duplicate: {},
  corrupt: {},
  wrongId: {},
  callError: {},
  noResponse: {},
  jitter: { minMs: true, maxMs: true },
  reorder: { after: false },
  halfOpen: { forMs: false },
  slowRead: { stepMs: true },
  reconnectStorm: { count: true, withinMs: true },
  invalidEnum: { path: false },
  missingField: { path: false },
  timestamp: { shiftMs: true },
  oversized: { kb: true },
};
const PARAM_NAMES = [...new Set(Object.values(FAULT_PARAMS).flatMap((p) => Object.keys(p)))];
const OUT_ONLY_FAULTS: ReadonlySet<string> = new Set(PROTOCOL_FAULTS);

export const chaosRule = z
  .object({
    fault: z.enum(ALL_CHAOS_FAULTS),
    direction: z.enum(['in', 'out']).optional(),
    action: z.string().min(1).optional(),
    nth: z.number().int().min(1).optional(),
    every: z.number().int().min(1).optional(),
    probability: z.number().min(0).max(1).optional(),
    once: z.boolean().optional(),
    /** `delay`: hold every matching frame this long. */
    delayMs: ms.optional(),
    /** `jitter`: a delay drawn uniformly from `minMs..maxMs` per frame. */
    minMs: ms.optional(),
    maxMs: ms.optional(),
    /** `reorder`: hold the frame until this many later frames have passed it (default 1). */
    after: z.number().int().min(1).max(100).optional(),
    /** `halfOpen`: drop the socket after this long; without it the link stays half-open. */
    forMs: positiveMs.optional(),
    /** `slowRead`: the n-th received frame waits n x stepMs. */
    stepMs: positiveMs.optional(),
    /** `reconnectStorm`: drop and reconnect `count` times within `withinMs`. */
    count: z.number().int().min(1).max(100).optional(),
    withinMs: positiveMs.optional(),
    /** `invalidEnum` / `missingField`: payload path, dot-joined, array positions as numbers. Default: the first fit. */
    path: z
      .string()
      .regex(
        /^[a-z][A-Za-z0-9_]*(\.([A-Za-z_][A-Za-z0-9_]*|\d+))*$/,
        'must be a payload path such as idTagInfo.status or meterValue.0.timestamp',
      )
      .max(200)
      .optional(),
    /** `timestamp`: shift every date-time field by this much (negative: into the past). */
    shiftMs: z
      .number()
      .int()
      .min(-MAX_MS * 365)
      .max(MAX_MS * 365)
      .refine((n) => n !== 0, 'must not be 0')
      .optional(),
    /** `oversized`: pad the payload to this many kB. */
    kb: z.number().positive().max(MAX_OVERSIZED_KB).optional(),
  })
  .superRefine((r, ctx) => {
    if ([r.nth, r.every, r.probability].filter((x) => x !== undefined).length > 1) {
      ctx.addIssue({ code: 'custom', message: 'give at most one of nth, every, probability' });
    }
    const allowed = FAULT_PARAMS[r.fault];
    for (const name of PARAM_NAMES) {
      const given = (r as Record<string, unknown>)[name] !== undefined;
      if (allowed[name] === true && !given) {
        ctx.addIssue({ code: 'custom', path: [name], message: `${name} is required for fault '${r.fault}'` });
      } else if (allowed[name] === undefined && given) {
        const owners = Object.entries(FAULT_PARAMS)
          .filter(([, p]) => name in p)
          .map(([f]) => `'${f}'`);
        ctx.addIssue({ code: 'custom', path: [name], message: `${name} is only allowed with ${owners.join(', ')}` });
      }
    }
    if (r.fault === 'jitter' && r.minMs !== undefined && r.maxMs !== undefined && r.maxMs < r.minMs) {
      ctx.addIssue({ code: 'custom', path: ['maxMs'], message: 'must be >= minMs' });
    }
    if (OUT_ONLY_FAULTS.has(r.fault) && r.direction === 'in') {
      ctx.addIssue({
        code: 'custom',
        path: ['direction'],
        message: `'${r.fault}' changes payloads the station sends: use 'out' or no direction`,
      });
    }
    if (r.fault === 'slowRead' && r.direction === 'out') {
      ctx.addIssue({
        code: 'custom',
        path: ['direction'],
        message: "'slowRead' delays frames the station receives: use 'in' or no direction",
      });
    }
  });

export type ChaosBody = z.infer<typeof chaosRule>;

export const validateBody = z.object({
  version,
  action: z.string().min(1),
  direction: z.enum(['request', 'response']),
  payload: z.unknown(),
});

export class BadRequest extends Error {}

/** Parse or throw `BadRequest` with every issue as `path: message`. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  throw new BadRequest(
    r.error.issues.map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message)).join('; '),
  );
}

/** Action bodies: the `type` is checked first so an unknown one gets a message listing the valid ones. */
export function parseAction(body: unknown): ActionBody {
  const type = (body as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !Object.hasOwn(ACTION_SCHEMAS, type)) {
    throw new BadRequest(`type: expected one of ${Object.keys(ACTION_SCHEMAS).join(', ')}`);
  }
  const schema = ACTION_SCHEMAS[type as ActionType] as z.ZodType<unknown>;
  return { type, ...(parseBody(schema, body) as object) } as ActionBody;
}

// ---- server mode ------------------------------------------------------------------------------------------------

const MAX_SOURCE = 1_000_000;
const source = z.string().max(MAX_SOURCE, `must be at most ${MAX_SOURCE} characters`);
const wsUrl = z.string().regex(/^wss?:\/\/\S+$/, 'must be a ws:// or wss:// URL');

export const scenarioSource = z.object({ source });

export const saveScenario = z.object({ name: z.string().trim().min(1).max(200), source });

export const startRun = z
  .object({
    source,
    name: z.string().trim().min(1).max(200).optional(),
    scenarioId: z.string().min(1).optional(),
    /** Default `loopback`: the built-in test CSMS. */
    target: z.enum(['loopback', 'url']).default('loopback'),
    /** For `url`; without it the scenario's own `csms` line is used. */
    csmsUrl: wsUrl.optional(),
    /** Default true. */
    virtual: z.boolean().default(true),
    speed: z.number().positive().max(1000).optional(),
    seed: z.number().int().optional(),
    /** Overrides the site block's `controller` line (scenarios with a site). */
    siteController: z.enum(['reference', 'none']).optional(),
  })
  .refine((r) => r.target === 'url' || r.csmsUrl === undefined, {
    message: "csmsUrl is only allowed with target 'url'",
    path: ['csmsUrl'],
  })
  .refine((r) => !r.virtual || r.speed === undefined, {
    message: 'speed applies to real-time runs only',
    path: ['speed'],
  });

export const saveRecording = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  /** One station's frames; default every station. */
  stationId: z.string().min(1).optional(),
});

export const saveReport = z.object({ name: z.string().trim().min(1).max(200).optional() });

// ---- sites --------------------------------------------------------------------------------------------------------

const phase = z.enum(['L1', 'L2', 'L3']);
const nodeId = z.string().min(1).max(200);

/** `POST /api/sites`: a site sandbox from DSL. */
export const createSite = z.object({
  /** A scenario text with a `site` block; station blocks' `site ... at` statements add the EVSE leaves. */
  source: z.string().min(1).max(256_000, 'must be at most 256000 characters'),
  name: z.string().trim().min(1).max(200).optional(),
  /** Default: the site block's `controller` line, else none. */
  controller: z.enum(['reference', 'none']).optional(),
  /** EVSE leaf id -> UI station id to bind it to. */
  bind: z.record(nodeId, stationId).default({}),
  /** Create a UI station (on the test CSMS) for every unbound leaf. Default true. */
  create: z.boolean().default(true),
  version: version.optional(),
});

export const SITE_ACTION_SCHEMAS = {
  trip: z.object({ node: nodeId, phases: z.array(phase).min(1).max(3).optional() }),
  reclose: z.object({ node: nodeId }),
  load: z
    .object({ node: nodeId, watts: z.number().min(-1e8).max(1e8).optional(), on: z.boolean().optional() })
    .refine((b) => (b.watts === undefined) !== (b.on === undefined), { message: 'give watts or on' }),
  controller: z.object({ mode: z.enum(['reference', 'none']) }),
} as const;

export function parseSiteAction(body: unknown) {
  const type = (body as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !Object.hasOwn(SITE_ACTION_SCHEMAS, type)) {
    throw new BadRequest(`type: expected one of ${Object.keys(SITE_ACTION_SCHEMAS).join(', ')}`);
  }
  const schema = SITE_ACTION_SCHEMAS[type as keyof typeof SITE_ACTION_SCHEMAS] as z.ZodType<object>;
  return { type, ...parseBody(schema, body) } as import('./sites').SiteActionBody;
}

const num = z.number();
const nums = z.array(num);
const triple = z.tuple([num, num, num]);
const seriesNode = z.object({
  currentA: z.tuple([nums, nums, nums]),
  neutralA: nums,
  powerW: nums,
  voltageV: z.tuple([nums, nums, nums]),
  loadingPct: nums.optional(),
  thermal: nums.optional(),
  energized: nums,
});
const nodeState = z.looseObject({
  id: z.string(),
  kind: z.string(),
  energized: z.boolean(),
  currentA: triple,
  powerW: triple,
  voltageV: triple,
});

/** An uploaded `--site-report` file: the shape the Site page reads, checked before it is stored. */
export const siteReport = z.object({
  format: z.literal('wattsim-site-report'),
  /** 1: every step in `allocations`; 2: keyframes in `allocations`, every step in `allocationSteps`. */
  version: z.union([z.literal(1), z.literal(2)]),
  name: z.string().max(200).optional(),
  description: z.looseObject({
    supply: z.looseObject({ phases: z.union([z.literal(1), z.literal(3)]) }),
    nodes: z.array(z.unknown()),
  }),
  nodes: z
    .array(
      z.object({
        id: nodeId,
        kind: z.string().max(20),
        parentId: z.string().optional(),
        childIds: z.array(z.string()),
        leaf: z.boolean(),
        phases: z.array(phase),
        ratingA: num.optional(),
      }),
    )
    .max(5000),
  leaves: z.array(z.object({ leafId: nodeId, station: z.string().max(200), evseId: z.number().int(), maxA: num })),
  run: z.object({
    start: num,
    end: num,
    durationMs: num,
    controller: z.enum(['reference', 'none']),
    timeOffsetMs: num,
  }),
  score: z.looseObject({
    trips: num,
    fairness: z.object({ mean: num, min: num }),
    nodes: z.record(z.string(), z.unknown()),
  }),
  series: z.object({
    resolutionMs: num,
    t: nums,
    marks: z.array(z.number().int()),
    nodes: z.record(z.string(), seriesNode),
  }),
  events: z.array(z.looseObject({ type: z.enum(['trip', 'reclose']), t: num, nodeId: z.string() })),
  violations: z.array(z.looseObject({ nodeId: z.string(), kind: z.string(), start: num })),
  allocations: z.array(z.looseObject({ t: num, nodes: z.array(z.unknown()), evses: z.array(z.unknown()) })),
  allocationSteps: z
    .array(z.union([z.number().int().min(0), z.looseObject({ t: num, reason: z.string() })]))
    .optional(),
  modbus: z.array(z.unknown()),
  final: z.looseObject({ t: num, supply: nodeState, nodes: z.record(z.string(), nodeState) }).optional(),
  inferred: z.array(z.looseObject({ t: num, nodes: z.array(z.unknown()), evses: z.array(z.unknown()) })).optional(),
});
