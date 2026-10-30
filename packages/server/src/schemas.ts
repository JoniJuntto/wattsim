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
} as const;

export type ActionType = keyof typeof ACTION_SCHEMAS;
export type ActionBody = { [K in ActionType]: { type: K } & z.infer<(typeof ACTION_SCHEMAS)[K]> }[ActionType];

export const CHAOS_FAULTS = ['drop', 'delay', 'duplicate', 'corrupt', 'wrongId', 'callError', 'noResponse'] as const;

export const chaosRule = z
  .object({
    fault: z.enum(CHAOS_FAULTS),
    direction: z.enum(['in', 'out']).optional(),
    action: z.string().min(1).optional(),
    nth: z.number().int().min(1).optional(),
    every: z.number().int().min(1).optional(),
    probability: z.number().min(0).max(1).optional(),
    once: z.boolean().optional(),
    delayMs: z.number().int().min(0).optional(),
  })
  .refine((r) => [r.nth, r.every, r.probability].filter((x) => x !== undefined).length <= 1, {
    message: 'give at most one of nth, every, probability',
  })
  .refine((r) => (r.fault === 'delay') === (r.delayMs !== undefined), {
    message: "delayMs is required for fault 'delay' and only allowed with it",
    path: ['delayMs'],
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
