import { type DataType, decodeValue, encodeValue, registerCount, type WordOrder } from './encoding';
import { EXCEPTION, MAX_READ } from './protocol';
import type { Quantity } from './reading';

/** Where a register's value comes from: a live quantity, a constant, or a function of live quantities. */
export type Source = Quantity | number | ((get: (q: Quantity) => number, unitId: number) => number);

export interface Writable {
  /** Value before any write. A function receives the device's unit id. */
  initial: number | ((unitId: number) => number);
  /** The value to store, or `undefined` when the meter rejects it (Illegal Data Value). Default: accept any. */
  accept?: (value: number) => number | undefined;
  /** A command register: a write is passed to `onWrite` and not stored; reads always return `initial`. */
  command?: boolean;
}

export interface RegisterEntry {
  /** Protocol (0-based) address, as the vendor document's hex "physical"/"start address" column. */
  address: number;
  type: DataType;
  /** Label as the vendor document has it. */
  name: string;
  unit?: string;
  /** Raw register value = value × scale before integer rounding (a Carlo Gavazzi "value weight"). */
  scale?: number;
  /** Live value of a read-only register. Unset reads 0. */
  value?: Source;
  /** Identifier passed to `Device.onWrite`; required for writable registers. */
  key?: string;
  writable?: Writable;
  /** Only answers a read of exactly this one register (the EM24 identification code at 000Bh). */
  alone?: boolean;
}

export type Block = readonly [start: number, endExclusive: number];

export interface RegisterMap {
  id: string;
  title: string;
  /** Vendor document the addresses come from: title, version and URL. */
  source: string;
  wordOrder: WordOrder;
  /** Function codes the meter supports; others are Illegal Function. */
  functions: readonly number[];
  /** Read with FC 04. */
  input: readonly RegisterEntry[];
  /** Read with FC 03, written with FC 06 / 16. */
  holding: readonly RegisterEntry[];
  /**
   * Address ranges that read without an exception. A register inside a block but outside every entry reads
   * 0, as meters do for parameters that do not apply. Defaults to the entries' own registers.
   */
  inputBlocks?: readonly Block[];
  holdingBlocks?: readonly Block[];
  /** Most registers per read, at most 125 (the protocol limit). */
  maxRead?: number;
  /** Reading or writing part of a 32-bit value is Illegal Data Address, as on Eastron meters. */
  aligned?: boolean;
}

/** One emulated meter: a register map and the live values behind it. */
export interface Device {
  map: RegisterMap;
  /** Current value of a quantity. Called while a request is answered; a throw is Server Device Failure. */
  read(quantity: Quantity): number;
  /** Called for every accepted write, with the register's `key` and decoded value. A throw is Server Device Failure. */
  onWrite?(key: string, value: number): void;
  /** False while the device is dark (a de-energised self-powered meter): requests get no answer at all. */
  online?(): boolean;
}

export type TableName = 'input' | 'holding';
export type Outcome<T> = { ok: true; value: T } | { ok: false; exception: number };

interface Slot {
  entry: RegisterEntry;
  offset: number;
}

interface CompiledTable {
  slots: Map<number, Slot>;
  alone: Map<number, RegisterEntry>;
  blocks: readonly Block[];
}

interface CompiledMap {
  input: CompiledTable;
  holding: CompiledTable;
}

const compiled = new WeakMap<RegisterMap, CompiledMap>();

function compileTable(entries: readonly RegisterEntry[], blocks: readonly Block[] | undefined, id: string) {
  const slots = new Map<number, Slot>();
  const alone = new Map<number, RegisterEntry>();
  const own: Block[] = [];
  for (const entry of entries) {
    if (entry.writable && !entry.key) throw new Error(`${id}: writable register ${entry.address} has no key`);
    if (entry.alone) {
      alone.set(entry.address, entry);
      continue;
    }
    const n = registerCount(entry.type);
    for (let i = 0; i < n; i++) {
      if (slots.has(entry.address + i)) throw new Error(`${id}: register ${entry.address + i} defined twice`);
      slots.set(entry.address + i, { entry, offset: i });
    }
    own.push([entry.address, entry.address + n]);
  }
  return { slots, alone, blocks: blocks ?? own };
}

export function compileMap(map: RegisterMap): CompiledMap {
  let c = compiled.get(map);
  if (!c) {
    c = {
      input: compileTable(map.input, map.inputBlocks, map.id),
      holding: compileTable(map.holding, map.holdingBlocks, map.id),
    };
    compiled.set(map, c);
  }
  return c;
}

const inBlocks = (blocks: readonly Block[], address: number) => blocks.some(([s, e]) => address >= s && address < e);

/**
 * The register image of one device: answers reads from live values and keeps the written values of its
 * writable registers. Pure; the server wraps it in Modbus TCP.
 */
export class DeviceImage {
  private readonly stored = new Map<string, number>();
  private readonly tables: CompiledMap;

  constructor(
    readonly device: Device,
    readonly unitId: number,
  ) {
    this.tables = compileMap(device.map);
  }

  get map(): RegisterMap {
    return this.device.map;
  }

  /** Value of a writable register as reads see it. */
  storedValue(entry: RegisterEntry): number {
    const w = entry.writable;
    if (!w) return 0;
    const initial = typeof w.initial === 'function' ? w.initial(this.unitId) : w.initial;
    if (w.command) return initial;
    return this.stored.get(entry.key ?? '') ?? initial;
  }

  private value(entry: RegisterEntry): number {
    if (entry.writable) return this.storedValue(entry);
    const src = entry.value;
    if (src === undefined) return 0;
    if (typeof src === 'number') return src;
    const get = (q: Quantity) => this.device.read(q);
    return typeof src === 'function' ? src(get, this.unitId) : get(src);
  }

  private encode(entry: RegisterEntry): number[] {
    return encodeValue(this.value(entry) * (entry.scale ?? 1), entry.type, this.map.wordOrder);
  }

  read(table: TableName, address: number, quantity: number): Outcome<number[]> {
    const t = this.tables[table];
    if (quantity < 1 || quantity > Math.min(MAX_READ, this.map.maxRead ?? MAX_READ)) {
      return { ok: false, exception: EXCEPTION.ILLEGAL_DATA_VALUE };
    }
    if (address + quantity > 0x10000) return { ok: false, exception: EXCEPTION.ILLEGAL_DATA_ADDRESS };
    try {
      const single = quantity === 1 ? t.alone.get(address) : undefined;
      if (single) return { ok: true, value: [this.encode(single)[0] ?? 0] };
      const out: number[] = [];
      const cache = new Map<RegisterEntry, number[]>();
      for (let a = address; a < address + quantity; a++) {
        if (!inBlocks(t.blocks, a)) return { ok: false, exception: EXCEPTION.ILLEGAL_DATA_ADDRESS };
        const slot = t.slots.get(a);
        if (!slot) {
          out.push(0);
          continue;
        }
        if (this.map.aligned) {
          const n = registerCount(slot.entry.type);
          const cutStart = a === address && slot.offset !== 0;
          const cutEnd = a === address + quantity - 1 && slot.offset !== n - 1;
          if (cutStart || cutEnd) return { ok: false, exception: EXCEPTION.ILLEGAL_DATA_ADDRESS };
        }
        let words = cache.get(slot.entry);
        if (!words) {
          words = this.encode(slot.entry);
          cache.set(slot.entry, words);
        }
        out.push(words[slot.offset] ?? 0);
      }
      return { ok: true, value: out };
    } catch {
      return { ok: false, exception: EXCEPTION.SERVER_DEVICE_FAILURE };
    }
  }

  /**
   * Writes holding registers. Every register must belong to a writable entry, and an entry is written whole
   * (Illegal Data Address otherwise); a value the meter refuses is Illegal Data Value. Nothing is stored
   * unless every value is accepted.
   */
  write(address: number, values: readonly number[]): Outcome<void> {
    const t = this.tables.holding;
    if (address + values.length > 0x10000) return { ok: false, exception: EXCEPTION.ILLEGAL_DATA_ADDRESS };
    const touched: { entry: RegisterEntry; words: number[] }[] = [];
    for (let i = 0; i < values.length; i++) {
      const slot = t.slots.get(address + i);
      if (!slot?.entry.writable) return { ok: false, exception: EXCEPTION.ILLEGAL_DATA_ADDRESS };
      if (slot.offset === 0) touched.push({ entry: slot.entry, words: [] });
      const current = touched[touched.length - 1];
      if (!current || current.entry !== slot.entry) return { ok: false, exception: EXCEPTION.ILLEGAL_DATA_ADDRESS };
      current.words.push(values[i] ?? 0);
    }
    for (const { entry, words } of touched) {
      if (words.length !== registerCount(entry.type)) return { ok: false, exception: EXCEPTION.ILLEGAL_DATA_ADDRESS };
    }
    const accepted: { entry: RegisterEntry; value: number }[] = [];
    for (const { entry, words } of touched) {
      const raw = decodeValue(words, entry.type, this.map.wordOrder) / (entry.scale ?? 1);
      const accept = entry.writable?.accept;
      const value = accept ? accept(raw) : raw;
      if (value === undefined || Number.isNaN(value)) return { ok: false, exception: EXCEPTION.ILLEGAL_DATA_VALUE };
      accepted.push({ entry, value });
    }
    try {
      for (const { entry, value } of accepted) this.device.onWrite?.(entry.key ?? '', value);
    } catch {
      return { ok: false, exception: EXCEPTION.SERVER_DEVICE_FAILURE };
    }
    for (const { entry, value } of accepted) {
      if (!entry.writable?.command) this.stored.set(entry.key ?? '', value);
    }
    return { ok: true, value: undefined };
  }
}

/** Accepts one of a fixed set of values. */
export const oneOf =
  (...allowed: number[]) =>
  (v: number) =>
    allowed.includes(v) ? v : undefined;

/** Accepts an integer in [min, max]. */
export const between = (min: number, max: number) => (v: number) =>
  Number.isInteger(v) && v >= min && v <= max ? v : undefined;
