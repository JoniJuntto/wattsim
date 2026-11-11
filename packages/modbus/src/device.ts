import type { Device, RegisterEntry, RegisterMap } from './map';
import { em24 } from './maps/em24';
import { generic } from './maps/generic';
import { sdm630 } from './maps/sdm630';
import { deriveReading, isQuantity, type MeterReading } from './reading';

export const MAPS = { sdm630, em24, generic } as const satisfies Record<string, RegisterMap>;
export type MapId = keyof typeof MAPS;

export function getMap(id: string): RegisterMap {
  const map = (MAPS as Record<string, RegisterMap>)[id];
  if (!map) throw new Error(`unknown register map "${id}" (known: ${Object.keys(MAPS).join(', ')})`);
  return map;
}

/**
 * A device whose values come live from `source`, called once per register value. Missing quantities are
 * filled by `deriveReading` unless `derive` is false, in which case they read 0. While `online` returns false the
 * device answers nothing.
 */
export function liveDevice(
  map: RegisterMap,
  source: () => Partial<MeterReading>,
  options: { derive?: boolean; onWrite?: Device['onWrite']; online?: Device['online'] } = {},
): Device {
  const derive = options.derive ?? true;
  return {
    map,
    read(q) {
      const given = source();
      return (derive ? deriveReading(given)[q] : given[q]) ?? 0;
    },
    onWrite: options.onWrite,
    ...(options.online ? { online: options.online } : {}),
  };
}

/** A device with fixed values (the rest derived), for demos and tests. */
export function staticDevice(map: RegisterMap, values: Partial<MeterReading>): Device {
  const reading = deriveReading(values);
  return { map, read: (q) => reading[q] };
}

/** Parses `currentL1=12.5,powerTotal=3000` into a partial reading. */
export function parseConstants(text: string): Partial<MeterReading> {
  const out: Partial<MeterReading> = {};
  for (const part of text.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    const name = item.slice(0, eq).trim();
    const value = Number(item.slice(eq + 1));
    if (eq < 1 || !isQuantity(name)) throw new Error(`"${item}": expected <quantity>=<number>, e.g. currentL1=12.5`);
    if (!Number.isFinite(value)) throw new Error(`"${item}": ${item.slice(eq + 1)} is not a number`);
    out[name] = value;
  }
  return out;
}

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;

/** Text for a Markdown table cell: no newlines, pipes escaped. */
const cell = (text: string) => text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');

/** Where a register's value comes from, in words. */
function registerSource(e: RegisterEntry): string {
  if (e.writable) {
    const initial = typeof e.writable.initial === 'number' ? `, default ${e.writable.initial}` : '';
    return e.writable.command ? `command \`${e.key}\`` : `writable \`${e.key}\`${initial}`;
  }
  if (typeof e.value === 'string') return `\`${e.value}\``;
  if (typeof e.value === 'number') return `constant ${e.value}`;
  if (typeof e.value === 'function') return 'derived';
  return '0';
}

/** One register table as Markdown, by address. */
export function registerTable(entries: readonly RegisterEntry[]): string {
  const rows = [...entries]
    .sort((a, b) => a.address - b.address)
    .map(
      (e) =>
        `| ${hex(e.address)} | ${e.address} | ${e.type} | ${e.scale ? `×${e.scale}` : ''} | ${cell(e.name)}${e.alone ? ' (one-register read only)' : ''} | ${cell(e.unit ?? '')} | ${registerSource(e)} |`,
    );
  return ['| Address | Dec | Type | Scale | Name | Unit | Value |', '|---|---|---|---|---|---|---|', ...rows].join(
    '\n',
  );
}

/** The map as Markdown: title, source, then its register table(s) (FC 04, and FC 03 when it differs). */
export function describeMap(map: RegisterMap): string {
  const parts = [`${map.title}. Word order: ${map.wordOrder === 'msw' ? 'most' : 'least'} significant register first.`];
  parts.push(`Source: ${map.source}`);
  if (map.input === map.holding) parts.push(`FC 03 and FC 04 read the same registers.\n\n${registerTable(map.input)}`);
  else {
    parts.push(`Input registers (FC 04):\n\n${registerTable(map.input)}`);
    parts.push(`Holding registers (FC 03):\n\n${registerTable(map.holding)}`);
  }
  return parts.join('\n\n');
}
