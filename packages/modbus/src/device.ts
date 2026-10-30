import type { Device, RegisterMap } from './map';
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
 * filled by `deriveReading` unless `derive` is false, in which case they read 0.
 */
export function liveDevice(
  map: RegisterMap,
  source: () => Partial<MeterReading>,
  options: { derive?: boolean; onWrite?: Device['onWrite'] } = {},
): Device {
  const derive = options.derive ?? true;
  return {
    map,
    read(q) {
      const given = source();
      return (derive ? deriveReading(given)[q] : given[q]) ?? 0;
    },
    onWrite: options.onWrite,
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

/** The map as a Markdown table (FC 04 table, then FC 03 when it differs). */
export function describeMap(map: RegisterMap): string {
  const rows = (entries: RegisterMap['input']) =>
    [...entries]
      .sort((a, b) => a.address - b.address)
      .map((e) => {
        const addr = `0x${e.address.toString(16).toUpperCase().padStart(4, '0')}`;
        const src = e.writable ? `write (\`${e.key}\`)` : typeof e.value === 'string' ? `\`${e.value}\`` : '';
        return `| ${addr} | ${e.address} | ${e.type} | ${e.scale ? `×${e.scale}` : ''} | ${e.name} | ${e.unit ?? ''} | ${src} |`;
      });
  const head = '| Address | Dec | Type | Scale | Name | Unit | Value |\n|---|---|---|---|---|---|---|';
  const parts = [`${map.title}. Word order: ${map.wordOrder === 'msw' ? 'most' : 'least'} significant register first.`];
  parts.push(`Source: ${map.source}`);
  if (map.input === map.holding) {
    parts.push(`FC 03 and FC 04 read the same registers.\n\n${head}\n${rows(map.input).join('\n')}`);
  } else {
    parts.push(`Input registers (FC 04):\n\n${head}\n${rows(map.input).join('\n')}`);
    parts.push(`Holding registers (FC 03):\n\n${head}\n${rows(map.holding).join('\n')}`);
  }
  return parts.join('\n\n');
}
