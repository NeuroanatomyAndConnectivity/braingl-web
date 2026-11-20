/**
 * NumPy .npy reader (format versions 1.0, 2.0, 3.0).
 *
 * The element order of `data` is the order in the file: C order (last index
 * fastest) unless `fortranOrder` is true, in which case the first index varies
 * fastest.  No reordering is done here.
 */

export type NpyData =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

export interface NpyArray {
  shape: number[];
  fortranOrder: boolean;
  /**
   * Element type of `data`, normalised to how it is held in memory: `<f4 <f8
   * <i2 <u2 <i4 <u4 |i1 |u1` (a big-endian file is byte-swapped on load and
   * reported as `<`; `|b1` booleans are reported as `|u1`).
   */
  dtype: string;
  data: NpyData;
}

interface NpyCtor {
  new (length: number): NpyData;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): NpyData;
}

const CTORS: Record<string, NpyCtor> = {
  f4: Float32Array,
  f8: Float64Array,
  i1: Int8Array,
  u1: Uint8Array,
  b1: Uint8Array,
  i2: Int16Array,
  u2: Uint16Array,
  i4: Int32Array,
  u4: Uint32Array,
};

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

const PLATFORM_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function isNpy(buf: ArrayBuffer): boolean {
  if (buf.byteLength < MAGIC.length) return false;
  const b = new Uint8Array(buf, 0, MAGIC.length);
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return false;
  return true;
}

function swapBytesInPlace(bytes: Uint8Array, size: number): void {
  for (let i = 0, n = bytes.length - size + 1; i < n; i += size) {
    for (let a = i, b = i + size - 1; a < b; a++, b--) {
      const t = bytes[a];
      bytes[a] = bytes[b];
      bytes[b] = t;
    }
  }
}

export function parseNpy(buf: ArrayBuffer): NpyArray {
  if (!isNpy(buf)) throw new Error("NPY: bad magic string (not a .npy file)");
  if (buf.byteLength < 10) throw new Error("NPY: file is truncated (incomplete preamble)");
  const dv = new DataView(buf);
  const major = dv.getUint8(6);
  const minor = dv.getUint8(7);

  let headerLen: number;
  let headerStart: number;
  if (major === 1) {
    headerLen = dv.getUint16(8, true);
    headerStart = 10;
  } else if (major === 2 || major === 3) {
    if (buf.byteLength < 12) throw new Error("NPY: file is truncated (incomplete preamble)");
    headerLen = dv.getUint32(8, true);
    headerStart = 12;
  } else {
    throw new Error(`NPY: unsupported format version ${major}.${minor}`);
  }
  const dataStart = headerStart + headerLen;
  if (dataStart > buf.byteLength) throw new Error("NPY: file is truncated (incomplete header)");

  // v1/v2 headers are latin-1, v3 is utf-8; the keys we need are ASCII either way.
  const header = new TextDecoder(major >= 3 ? "utf-8" : "latin1").decode(
    new Uint8Array(buf, headerStart, headerLen),
  );

  const descrMatch = /['"]descr['"]\s*:\s*(?:'([^']*)'|"([^"]*)")/.exec(header);
  if (!descrMatch) {
    if (/['"]descr['"]\s*:\s*\[/.test(header)) {
      throw new Error("NPY: structured (record) dtypes are not supported");
    }
    throw new Error(`NPY: header has no 'descr' entry: ${header.trim()}`);
  }
  const descr = descrMatch[1] ?? descrMatch[2];

  const fortranMatch = /['"]fortran_order['"]\s*:\s*(True|False)/.exec(header);
  if (!fortranMatch) throw new Error(`NPY: header has no 'fortran_order' entry: ${header.trim()}`);
  const fortranOrder = fortranMatch[1] === "True";

  const shapeMatch = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header);
  if (!shapeMatch) throw new Error(`NPY: header has no 'shape' entry: ${header.trim()}`);
  const shape: number[] = [];
  for (const part of shapeMatch[1].split(",")) {
    const t = part.trim();
    if (t === "") continue;
    if (!/^\d+L?$/.test(t)) throw new Error(`NPY: invalid shape (${shapeMatch[1]})`);
    shape.push(parseInt(t, 10));
  }

  const dt = /^([<>=|])([a-zA-Z])(\d+)$/.exec(descr);
  const key = dt ? dt[2] + dt[3] : "";
  const Ctor = dt ? CTORS[key] : undefined;
  if (!dt || !Ctor) {
    throw new Error(
      `NPY: unsupported dtype '${descr}' (supported: f4 f8 i1 u1 i2 u2 i4 u4, little- or big-endian)`,
    );
  }
  const size = parseInt(dt[3], 10);
  const fileLittleEndian = dt[1] === "<" || dt[1] === "|" || (dt[1] === "=" && PLATFORM_LITTLE_ENDIAN);

  let count = 1;
  for (const d of shape) count *= d;
  const nBytes = count * size;
  if (dataStart + nBytes > buf.byteLength) {
    throw new Error(
      `NPY: shape (${shape.join(", ")}) of '${descr}' needs ${nBytes} data bytes but the file has only ${buf.byteLength - dataStart}`,
    );
  }

  const needSwap = size > 1 && fileLittleEndian !== PLATFORM_LITTLE_ENDIAN;
  let data: NpyData;
  if (needSwap || dataStart % size !== 0) {
    // copy: never modify the caller's buffer, and typed-array views need alignment
    const copy = new Uint8Array(buf.slice(dataStart, dataStart + nBytes));
    if (needSwap) swapBytesInPlace(copy, size);
    data = new Ctor(copy.buffer, 0, count);
  } else {
    data = new Ctor(buf, dataStart, count);
  }

  const outKey = key === "b1" ? "u1" : key;
  return { shape, fortranOrder, dtype: (size === 1 ? "|" : "<") + outKey, data };
}
