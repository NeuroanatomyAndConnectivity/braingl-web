/**
 * GIFTI (.gii, .surf.gii, .func.gii, .shape.gii, .label.gii) reader.
 *
 * No DOMParser: the file is scanned for `<DataArray ...> ... <Data>...</Data>
 * </DataArray>` with plain string searches, so this runs unchanged in
 * browsers, workers and Node.
 */

import type { TriMesh } from "./freesurferAsc";

export type GiftiData =
  | Float32Array
  | Int32Array
  | Uint8Array
  | Float64Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array;

export interface GiftiArray {
  /** e.g. `NIFTI_INTENT_POINTSET`, `NIFTI_INTENT_TRIANGLE`, `NIFTI_INTENT_SHAPE` */
  intent: string;
  /** e.g. `NIFTI_TYPE_FLOAT32` */
  dataType: string;
  dims: number[];
  /** always row-major (last index fastest), whatever the file's ArrayIndexingOrder */
  data: GiftiData;
}

export interface GiftiFile {
  arrays: GiftiArray[];
}

interface GiftiCtor {
  new (length: number): GiftiData;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): GiftiData;
  readonly BYTES_PER_ELEMENT: number;
}

const CTORS: Record<string, GiftiCtor> = {
  NIFTI_TYPE_UINT8: Uint8Array,
  NIFTI_TYPE_INT8: Int8Array,
  NIFTI_TYPE_INT16: Int16Array,
  NIFTI_TYPE_UINT16: Uint16Array,
  NIFTI_TYPE_INT32: Int32Array,
  NIFTI_TYPE_UINT32: Uint32Array,
  NIFTI_TYPE_FLOAT32: Float32Array,
  NIFTI_TYPE_FLOAT64: Float64Array,
};

const PLATFORM_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// ---------------------------------------------------------------------------
// low-level helpers
// ---------------------------------------------------------------------------

const B64 = new Int8Array(128).fill(-1);
{
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) B64[alphabet.charCodeAt(i)] = i;
}

/** Decode text[start, end) as base64, ignoring whitespace. */
function decodeBase64(text: string, start: number, end: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Math.floor(((end - start) * 3) / 4) + 3);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c <= 32) continue;
    if (c === 61) break; // '=' padding
    const v = c < 128 ? B64[c] : -1;
    if (v < 0) throw new Error(`GIFTI: invalid base64 character "${text[i]}" in <Data>`);
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("GIFTI: GZipBase64Binary needs DecompressionStream, which this runtime does not provide");
  }
  // GIFTI specifies a zlib stream; tolerate writers that emit a gzip member.
  const format = bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : "deflate";
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    throw new Error(`GIFTI: could not decompress GZipBase64Binary data (${e instanceof Error ? e.message : String(e)})`);
  }
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

/** Whitespace-separated numbers of text[start, end) into `out`; returns how many were read. */
function parseAsciiNumbers(text: string, start: number, end: number, out: GiftiData): number {
  let n = 0;
  let pos = start;
  const cap = out.length;
  while (pos < end) {
    while (pos < end && text.charCodeAt(pos) <= 32) pos++;
    if (pos >= end) break;
    const s = pos;
    while (pos < end && text.charCodeAt(pos) > 32) pos++;
    let v = +text.substring(s, pos);
    if (v !== v) {
      // C-style spellings that Number() does not understand
      const tok = text.substring(s, Math.min(pos, s + 30)).toLowerCase();
      if (/^[+-]?inf(inity)?$/.test(tok)) {
        v = tok[0] === "-" ? -Infinity : Infinity;
      } else if (!/^[+-]?nan$/.test(tok)) {
        throw new Error(`GIFTI: invalid number "${tok}" in ASCII <Data>`);
      }
    }
    if (n < cap) out[n] = v;
    n++;
  }
  return n;
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) attrs[m[1]] = m[2] ?? m[3];
  return attrs;
}

/** Index of `<name` followed by whitespace, `>` or `/`, searching forwards from `from`; -1 if none. */
function findOpenTag(text: string, name: string, from: number): number {
  const needle = "<" + name;
  let i = from;
  for (;;) {
    i = text.indexOf(needle, i);
    if (i < 0) return -1;
    const c = text.charCodeAt(i + needle.length);
    if (c === 62 || c === 47 || c <= 32) return i;
    i += needle.length;
  }
}

/** Reorder a column-major (first index fastest) array to row-major. */
function columnToRowMajor(src: GiftiData, dims: number[], Ctor: GiftiCtor): GiftiData {
  const n = src.length;
  const k = dims.length;
  const out = new Ctor(n);
  // stride of dimension d in the column-major source
  const stride = new Array<number>(k);
  let s = 1;
  for (let d = 0; d < k; d++) {
    stride[d] = s;
    s *= dims[d];
  }
  const idx = new Array<number>(k).fill(0);
  let c = 0; // source index of the current multi-index
  for (let r = 0; r < n; r++) {
    out[r] = src[c];
    // odometer increment, last dimension fastest
    for (let d = k - 1; d >= 0; d--) {
      if (++idx[d] < dims[d]) {
        c += stride[d];
        break;
      }
      c -= (dims[d] - 1) * stride[d];
      idx[d] = 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export async function parseGifti(input: ArrayBuffer | string): Promise<GiftiFile> {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8").decode(input);
  if (findOpenTag(text, "GIFTI", 0) < 0) {
    throw new Error("GIFTI: no <GIFTI> root element (not a GIFTI XML file)");
  }

  const arrays: GiftiArray[] = [];
  let pos = 0;
  for (;;) {
    const start = findOpenTag(text, "DataArray", pos);
    if (start < 0) break;
    const index = arrays.length;
    const tagEnd = text.indexOf(">", start);
    if (tagEnd < 0) throw new Error(`GIFTI: DataArray ${index}: unterminated <DataArray> tag`);
    const attrs = parseAttributes(text.substring(start + 10, tagEnd));
    const close = text.indexOf("</DataArray>", tagEnd);
    if (close < 0) throw new Error(`GIFTI: DataArray ${index}: missing </DataArray>`);
    pos = close + 12;

    const intent = attrs.Intent ?? "NIFTI_INTENT_NONE";
    const dataType = attrs.DataType ?? "";
    const Ctor = CTORS[dataType];
    if (!Ctor) {
      throw new Error(
        `GIFTI: DataArray ${index}: unsupported DataType "${dataType}" (supported: ${Object.keys(CTORS).join(", ")})`,
      );
    }

    // dimensions
    const dims: number[] = [];
    const dimensionality =
      attrs.Dimensionality !== undefined
        ? parseInt(attrs.Dimensionality, 10)
        : Object.keys(attrs).filter((a) => /^Dim\d+$/.test(a)).length;
    if (!(dimensionality >= 1)) {
      throw new Error(`GIFTI: DataArray ${index}: invalid Dimensionality "${attrs.Dimensionality ?? ""}"`);
    }
    for (let d = 0; d < dimensionality; d++) {
      const raw = attrs["Dim" + d];
      const v = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(v) || v < 0) {
        throw new Error(`GIFTI: DataArray ${index}: missing or invalid Dim${d} ("${raw ?? ""}")`);
      }
      dims.push(v);
    }
    let count = 1;
    for (const d of dims) count *= d;

    const encoding = attrs.Encoding ?? "";
    if (encoding === "ExternalFileBinary") {
      throw new Error(
        `GIFTI: DataArray ${index}: Encoding "ExternalFileBinary" (${attrs.ExternalFileName ?? "external file"}) is not supported`,
      );
    }

    // <Data> is the last child of <DataArray>; searching backwards keeps any
    // MetaData CDATA out of the way (base64 / numbers never contain '<').
    let dataStart = close;
    let dataEnd = close;
    const dEnd = text.lastIndexOf("</Data>", close);
    if (dEnd > tagEnd) {
      const dOpen = text.lastIndexOf("<Data", dEnd);
      const dOpenEnd = dOpen > tagEnd ? text.indexOf(">", dOpen) : -1;
      if (dOpenEnd < 0 || dOpenEnd > dEnd || text.substring(dOpen + 5, dOpenEnd).trim() !== "") {
        throw new Error(`GIFTI: DataArray ${index}: malformed <Data> element`);
      }
      dataStart = dOpenEnd + 1;
      dataEnd = dEnd;
    } else if (count > 0) {
      throw new Error(`GIFTI: DataArray ${index}: no <Data> element`);
    }

    const size = Ctor.BYTES_PER_ELEMENT;
    let data: GiftiData;
    if (encoding === "ASCII") {
      data = new Ctor(count);
      const got = parseAsciiNumbers(text, dataStart, dataEnd, data);
      if (got < count) {
        throw new Error(
          `GIFTI: DataArray ${index}: dims [${dims.join(", ")}] need ${count} values but <Data> holds ${got}`,
        );
      }
    } else if (encoding === "Base64Binary" || encoding === "GZipBase64Binary") {
      let bytes = decodeBase64(text, dataStart, dataEnd);
      if (encoding === "GZipBase64Binary" && (count > 0 || bytes.length > 0)) {
        try {
          bytes = await inflate(bytes);
        } catch (e) {
          throw new Error(`GIFTI: DataArray ${index}: ${e instanceof Error ? e.message.replace(/^GIFTI: /, "") : String(e)}`);
        }
      }
      if (bytes.length < count * size) {
        throw new Error(
          `GIFTI: DataArray ${index}: dims [${dims.join(", ")}] of ${dataType} need ${count * size} bytes but <Data> decodes to ${bytes.length}`,
        );
      }
      const endian = attrs.Endian ?? "LittleEndian";
      if (endian !== "LittleEndian" && endian !== "BigEndian") {
        throw new Error(`GIFTI: DataArray ${index}: unknown Endian "${endian}"`);
      }
      // `bytes` is freshly allocated at offset 0, so it is aligned and ours to modify.
      const used = bytes.subarray(0, count * size);
      if (size > 1 && (endian === "LittleEndian") !== PLATFORM_LITTLE_ENDIAN) swapBytesInPlace(used, size);
      data = new Ctor(used.buffer, used.byteOffset, count);
    } else {
      throw new Error(
        `GIFTI: DataArray ${index}: unknown Encoding "${encoding}" (expected ASCII, Base64Binary or GZipBase64Binary)`,
      );
    }

    const order = attrs.ArrayIndexingOrder ?? "RowMajorOrder";
    if (order === "ColumnMajorOrder") {
      if (dims.filter((d) => d > 1).length > 1) data = columnToRowMajor(data, dims, Ctor);
    } else if (order !== "RowMajorOrder") {
      throw new Error(`GIFTI: DataArray ${index}: unknown ArrayIndexingOrder "${order}"`);
    }

    arrays.push({ intent, dataType, dims, data });
  }

  return { arrays };
}

// ---------------------------------------------------------------------------
// convenience accessors
// ---------------------------------------------------------------------------

const POINTSET = "NIFTI_INTENT_POINTSET";
const TRIANGLE = "NIFTI_INTENT_TRIANGLE";

/**
 * Surface geometry from the first POINTSET and TRIANGLE arrays, or null when
 * either is missing.  Coordinates are returned as stored: the
 * CoordinateSystemTransformMatrix is not applied.
 */
export function giftiToMesh(g: GiftiFile): TriMesh | null {
  const points = g.arrays.find((a) => a.intent === POINTSET);
  const tris = g.arrays.find((a) => a.intent === TRIANGLE);
  if (!points || !tris) return null;
  if (points.data.length % 3 !== 0 || (points.dims.length > 1 && points.dims[1] !== 3)) {
    throw new Error(`GIFTI: POINTSET array has dims [${points.dims.join(", ")}], expected [nVerts, 3]`);
  }
  if (tris.data.length % 3 !== 0 || (tris.dims.length > 1 && tris.dims[1] !== 3)) {
    throw new Error(`GIFTI: TRIANGLE array has dims [${tris.dims.join(", ")}], expected [nTris, 3]`);
  }
  const positions = points.data instanceof Float32Array ? points.data : new Float32Array(points.data);
  const triangles = tris.data instanceof Uint32Array ? tris.data : new Uint32Array(tris.data);
  return { positions, triangles };
}

/**
 * Every array that is neither POINTSET nor TRIANGLE, as Float32Array.  A 2-D
 * [nVerts, nCols] array yields one Float32Array per column.
 */
export function giftiToScalars(g: GiftiFile): Float32Array[] {
  const out: Float32Array[] = [];
  for (const a of g.arrays) {
    if (a.intent === POINTSET || a.intent === TRIANGLE) continue;
    const n = a.dims.length > 0 ? a.dims[0] : a.data.length;
    const nCols = n > 0 ? a.data.length / n : 0;
    if (a.dims.length < 2 || nCols <= 1) {
      out.push(a.data instanceof Float32Array ? a.data : new Float32Array(a.data));
      continue;
    }
    for (let c = 0; c < nCols; c++) {
      const col = new Float32Array(n);
      for (let i = 0, j = c; i < n; i++, j += nCols) col[i] = a.data[j];
      out.push(col);
    }
  }
  return out;
}
