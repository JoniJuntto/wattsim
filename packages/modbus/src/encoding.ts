/**
 * 16-bit register encodings. Byte order inside a register is always big-endian (Modbus Application Protocol
 * v1.1b3 §4.2); only the order of the two registers of a 32-bit value differs between vendors.
 */
export type DataType = 'float32' | 'int32' | 'uint32' | 'int16' | 'uint16';

/** `msw`: most significant register first (Eastron default). `lsw`: least significant first (Carlo Gavazzi). */
export type WordOrder = 'msw' | 'lsw';

export function registerCount(type: DataType): 1 | 2 {
  return type === 'int16' || type === 'uint16' ? 1 : 2;
}

const LIMITS: Record<Exclude<DataType, 'float32'>, [number, number]> = {
  int16: [-0x8000, 0x7fff],
  uint16: [0, 0xffff],
  int32: [-0x80000000, 0x7fffffff],
  uint32: [0, 0xffffffff],
};

/**
 * Encodes a value into registers. Integers are rounded and saturate at the type's limits (a Carlo Gavazzi
 * meter shows overflow as a 7FFFh most significant word); NaN encodes as 0 for integer types.
 */
export function encodeValue(value: number, type: DataType, order: WordOrder): number[] {
  const view = new DataView(new ArrayBuffer(4));
  switch (type) {
    case 'float32':
      view.setFloat32(0, value);
      break;
    case 'int32':
      view.setInt32(0, saturate(value, type));
      break;
    case 'uint32':
      view.setUint32(0, saturate(value, type));
      break;
    case 'int16':
      return [saturate(value, type) & 0xffff];
    case 'uint16':
      return [saturate(value, type)];
  }
  const hi = view.getUint16(0);
  const lo = view.getUint16(2);
  return order === 'msw' ? [hi, lo] : [lo, hi];
}

/** Decodes registers produced by `encodeValue` (or by a real meter) back into a number. */
export function decodeValue(words: readonly number[], type: DataType, order: WordOrder): number {
  const w0 = words[0] ?? 0;
  if (type === 'uint16') return w0 & 0xffff;
  if (type === 'int16') return (w0 << 16) >> 16;
  const w1 = words[1] ?? 0;
  const [hi, lo] = order === 'msw' ? [w0, w1] : [w1, w0];
  const view = new DataView(new ArrayBuffer(4));
  view.setUint16(0, hi);
  view.setUint16(2, lo);
  if (type === 'float32') return view.getFloat32(0);
  if (type === 'int32') return view.getInt32(0);
  return view.getUint32(0);
}

function saturate(value: number, type: Exclude<DataType, 'float32'>): number {
  if (Number.isNaN(value)) return 0;
  const [min, max] = LIMITS[type];
  return Math.min(max, Math.max(min, Math.round(value)));
}
