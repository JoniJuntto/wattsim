/**
 * The chaos faults the station page offers, grouped as the panel shows them, with the parameters each takes. Field
 * values are the strings typed into the form; `faultParams` turns them into the API body fields (in the server's
 * units: ms, kB) or says what is wrong.
 */
import type { ChaosRuleBody } from '@/api/types';

export type FaultGroup = 'Transport' | 'Protocol';

type ParamKey = Exclude<
  keyof ChaosRuleBody,
  'fault' | 'direction' | 'action' | 'nth' | 'every' | 'probability' | 'once'
>;

export type FaultField = {
  /** API body field. */
  key: ParamKey;
  label: string;
  /** One line under the input. */
  help: string;
  /** What the input takes; multiplied by `scale` into the API unit. */
  kind: 'int' | 'number' | 'signed' | 'path';
  /** Input unit -> API unit (s -> ms: 1000). Default 1. */
  scale?: number;
  required: boolean;
  default: string;
  placeholder?: string;
  min?: number;
  max?: number;
};

export type FaultSpec = {
  value: string;
  label: string;
  group: FaultGroup;
  /** One plain line on what it does. */
  help: string;
  fields: FaultField[];
  /** Only frames in this direction can match (protocol faults: what the station sends; slowRead: what it receives). */
  onlyDirection?: 'in' | 'out';
};

export const FAULTS: FaultSpec[] = [
  {
    value: 'drop',
    label: 'Drop',
    group: 'Transport',
    fields: [],
    help: 'The frame is lost: never sent, or never processed when received.',
  },
  {
    value: 'delay',
    label: 'Delay',
    group: 'Transport',
    help: 'Hold the frame for a while before it goes out or is processed.',
    fields: [
      {
        key: 'delayMs',
        label: 'Delay (ms)',
        help: 'How long every matching frame waits.',
        kind: 'int',
        required: true,
        default: '2000',
        min: 0,
      },
    ],
  },
  {
    value: 'jitter',
    label: 'Jitter',
    group: 'Transport',
    help: 'Each frame waits a random time between a minimum and a maximum.',
    fields: [
      { key: 'minMs', label: 'Min (ms)', help: 'Shortest wait.', kind: 'int', required: true, default: '100', min: 0 },
      { key: 'maxMs', label: 'Max (ms)', help: 'Longest wait.', kind: 'int', required: true, default: '2000', min: 0 },
    ],
  },
  {
    value: 'reorder',
    label: 'Reorder',
    group: 'Transport',
    help: 'Later frames overtake this one: it is held until they have passed.',
    fields: [
      {
        key: 'after',
        label: 'Overtaken by',
        help: 'How many later frames go first.',
        kind: 'int',
        required: false,
        default: '1',
        min: 1,
        max: 100,
      },
    ],
  },
  {
    value: 'halfOpen',
    label: 'Half-open link',
    group: 'Transport',
    help: 'From this frame on nothing is sent or read, but the socket stays open.',
    fields: [
      {
        key: 'forMs',
        label: 'Notice after (s)',
        help: 'The station gives up and reconnects after this long. Blank: it never notices.',
        kind: 'number',
        scale: 1000,
        required: false,
        default: '',
        placeholder: 'never',
        min: 0.001,
      },
    ],
  },
  {
    value: 'slowRead',
    label: 'Slow reader',
    group: 'Transport',
    onlyDirection: 'in',
    help: 'Received frames are processed slower and slower.',
    fields: [
      {
        key: 'stepMs',
        label: 'Step (ms)',
        help: 'The 1st frame waits one step, the 2nd two steps, and so on.',
        kind: 'int',
        required: true,
        default: '500',
        min: 1,
      },
    ],
  },
  {
    value: 'reconnectStorm',
    label: 'Reconnect storm',
    group: 'Transport',
    help: 'After the frame, the socket drops and reconnects several times in a row.',
    fields: [
      {
        key: 'count',
        label: 'Reconnects',
        help: 'How many times the socket drops.',
        kind: 'int',
        required: true,
        default: '5',
        min: 1,
        max: 100,
      },
      {
        key: 'withinMs',
        label: 'Within (s)',
        help: 'Spread evenly over this long.',
        kind: 'number',
        scale: 1000,
        required: true,
        default: '60',
        min: 0.001,
      },
    ],
  },
  {
    value: 'duplicate',
    label: 'Duplicate',
    group: 'Transport',
    fields: [],
    help: 'The frame goes over the wire twice.',
  },
  {
    value: 'corrupt',
    label: 'Corrupt',
    group: 'Transport',
    fields: [],
    help: 'The frame is turned into invalid JSON.',
  },
  {
    value: 'wrongId',
    label: 'Wrong message id',
    group: 'Transport',
    fields: [],
    help: 'The response carries a message id that matches no CALL.',
  },
  {
    value: 'callError',
    label: 'CALLERROR',
    group: 'Transport',
    fields: [],
    help: 'Answer the CALL with a CALLERROR instead of a result.',
  },
  {
    value: 'noResponse',
    label: 'No response',
    group: 'Transport',
    fields: [],
    help: 'Swallow an inbound CALL so the CSMS never gets an answer.',
  },
  {
    value: 'invalidEnum',
    label: 'Invalid enum value',
    group: 'Protocol',
    onlyDirection: 'out',
    help: 'An enum field gets a value OCPP does not define.',
    fields: [
      {
        key: 'path',
        label: 'Field',
        help: 'Dot path into the payload, e.g. idTagInfo.status. Blank: the first enum field.',
        kind: 'path',
        required: false,
        default: '',
        placeholder: 'first enum field',
      },
    ],
  },
  {
    value: 'missingField',
    label: 'Missing field',
    group: 'Protocol',
    onlyDirection: 'out',
    help: 'A required field is left out of the payload.',
    fields: [
      {
        key: 'path',
        label: 'Field',
        help: 'Dot path into the payload, e.g. meterValue.0.timestamp. Blank: the first required field.',
        kind: 'path',
        required: false,
        default: '',
        placeholder: 'first required field',
      },
    ],
  },
  {
    value: 'timestamp',
    label: 'Shifted timestamps',
    group: 'Protocol',
    onlyDirection: 'out',
    help: 'Every timestamp in the payload is moved by the same amount.',
    fields: [
      {
        key: 'shiftMs',
        label: 'Shift (min)',
        help: 'Negative moves them into the past.',
        kind: 'signed',
        scale: 60_000,
        required: true,
        default: '-10',
      },
    ],
  },
  {
    value: 'oversized',
    label: 'Oversized payload',
    group: 'Protocol',
    onlyDirection: 'out',
    help: 'The payload is padded with an extra field up to a given size.',
    fields: [
      {
        key: 'kb',
        label: 'Size (kB)',
        help: '1 kB is 1024 bytes; at most 1024 kB.',
        kind: 'number',
        required: true,
        default: '64',
        min: 0.001,
        max: 1024,
      },
    ],
  },
];

export const FAULT_GROUPS: FaultGroup[] = ['Transport', 'Protocol'];

export const faultSpec = (value: string): FaultSpec | undefined => FAULTS.find((f) => f.value === value);

const PATH_RE = /^[a-z][A-Za-z0-9_]*(\.([A-Za-z_][A-Za-z0-9_]*|\d+))*$/;

/**
 * The API fields for `fault` from the typed values (keyed by field key; a missing value is the field's default).
 * Blank optional fields are left out.
 */
export function faultParams(
  fault: string,
  values: Partial<Record<string, string>>,
): { ok: true; params: Partial<ChaosRuleBody> } | { ok: false; error: string } {
  const spec = faultSpec(fault);
  if (!spec) return { ok: false, error: `Unknown fault ${fault}.` };
  const params: Partial<Record<ParamKey, number | string>> = {};
  for (const f of spec.fields) {
    const raw = (values[f.key] ?? f.default).trim();
    const name = f.label.replace(/ \(.*\)$/, '');
    if (raw === '') {
      if (f.required) return { ok: false, error: `${name} is required.` };
      continue;
    }
    if (f.kind === 'path') {
      if (!PATH_RE.test(raw)) return { ok: false, error: `${name}: a dot path such as idTagInfo.status.` };
      params[f.key] = raw;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: `${name} must be a number.` };
    if (f.kind === 'int' && !Number.isInteger(n)) return { ok: false, error: `${name} must be a whole number.` };
    if (f.kind === 'signed' && n === 0) return { ok: false, error: `${name} must not be 0.` };
    if (f.min !== undefined && n < f.min) return { ok: false, error: `${name} must be at least ${f.min}.` };
    if (f.max !== undefined && n > f.max) return { ok: false, error: `${name} must be at most ${f.max}.` };
    params[f.key] = f.scale ? Math.round(n * f.scale) : n;
  }
  if (fault === 'jitter' && Number(params.maxMs) < Number(params.minMs)) {
    return { ok: false, error: 'Max must not be below min.' };
  }
  return { ok: true, params: params as Partial<ChaosRuleBody> };
}
