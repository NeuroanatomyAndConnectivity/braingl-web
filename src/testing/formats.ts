/**
 * Minimal independent readers for the formats the exporters write (binary
 * PLY, ZIP), so that tests can check the bytes rather than trust the writers.
 */

export interface PlyElement {
  name: string;
  count: number;
  /** property declarations as written, e.g. "float x" or "list uchar int vertex_indices" */
  properties: string[];
}

export interface ParsedPly {
  format: string;
  comments: string[];
  elements: PlyElement[];
  headerBytes: number;
  positions: Float32Array;
  colors: Uint8Array;
  triangles: Uint32Array;
  edges: Uint32Array;
  /** bytes left over after the last element (must be 0 for a well-formed file) */
  trailingBytes: number;
}

const SIZES: Record<string, number> = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };

/**
 * Binary little-endian PLY with `vertex` (float x y z + uchar red green blue
 * alpha), optional `face` (list uchar int) and optional `edge` (int vertex1
 * vertex2) elements. Anything else throws.
 */
export function readPly(buf: ArrayBuffer | Uint8Array): ParsedPly {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const marker = "end_header\n";
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const end = head.indexOf(marker);
  if (end < 0) throw new Error("PLY: no end_header");
  const headerBytes = end + marker.length;
  const lines = head.slice(0, end).split("\n");
  if (lines[0] !== "ply") throw new Error("PLY: missing magic line");
  let format = "";
  const comments: string[] = [];
  const elements: PlyElement[] = [];
  for (const line of lines.slice(1)) {
    const t = line.split(" ");
    if (t[0] === "format") format = t.slice(1).join(" ");
    else if (t[0] === "comment") comments.push(t.slice(1).join(" "));
    else if (t[0] === "element") elements.push({ name: t[1], count: Number(t[2]), properties: [] });
    else if (t[0] === "property") elements[elements.length - 1].properties.push(t.slice(1).join(" "));
    else if (line !== "") throw new Error(`PLY: unexpected header line "${line}"`);
  }
  if (format !== "binary_little_endian 1.0") throw new Error(`PLY: unsupported format "${format}"`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = headerBytes;
  let positions = new Float32Array(0), colors = new Uint8Array(0), triangles = new Uint32Array(0), edges = new Uint32Array(0);
  for (const el of elements) {
    if (el.name === "vertex") {
      const names = el.properties.map((p) => p.split(" ")[1]);
      const types = el.properties.map((p) => p.split(" ")[0]);
      if (names.join(" ") !== "x y z red green blue alpha" || types.join(" ") !== "float float float uchar uchar uchar uchar") {
        throw new Error(`PLY: unexpected vertex layout "${el.properties.join(", ")}"`);
      }
      const stride = types.reduce((s, t) => s + SIZES[t], 0);
      positions = new Float32Array(3 * el.count);
      colors = new Uint8Array(4 * el.count);
      for (let i = 0; i < el.count; i++, o += stride) {
        for (let k = 0; k < 3; k++) positions[3 * i + k] = dv.getFloat32(o + 4 * k, true);
        for (let k = 0; k < 4; k++) colors[4 * i + k] = dv.getUint8(o + 12 + k);
      }
    } else if (el.name === "face") {
      if (el.properties.join("|") !== "list uchar int vertex_indices") throw new Error(`PLY: unexpected face layout "${el.properties.join(", ")}"`);
      triangles = new Uint32Array(3 * el.count);
      for (let t = 0; t < el.count; t++) {
        const m = dv.getUint8(o);
        if (m !== 3) throw new Error(`PLY: face ${t} has ${m} vertices`);
        for (let k = 0; k < 3; k++) triangles[3 * t + k] = dv.getInt32(o + 1 + 4 * k, true);
        o += 13;
      }
    } else if (el.name === "edge") {
      if (el.properties.join("|") !== "int vertex1|int vertex2") throw new Error(`PLY: unexpected edge layout "${el.properties.join(", ")}"`);
      edges = new Uint32Array(2 * el.count);
      for (let e = 0; e < el.count; e++, o += 8) {
        edges[2 * e] = dv.getInt32(o, true);
        edges[2 * e + 1] = dv.getInt32(o + 4, true);
      }
    } else {
      throw new Error(`PLY: unexpected element "${el.name}"`);
    }
  }
  return { format, comments, elements, headerBytes, positions, colors, triangles, edges, trailingBytes: bytes.length - o };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  method: number;
  flags: number;
  localHeaderOffset: number;
}

/** Bit-by-bit CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) without a lookup table. */
export function referenceCrc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Parse a ZIP archive from its end-of-central-directory record, cross-checking
 * every central-directory entry against its local header. Throws on any
 * inconsistency.
 */
export function readZip(zip: Uint8Array): ZipEntry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  if (eocd < 0 || dv.getUint32(eocd, true) !== 0x06054b50) throw new Error("ZIP: no end-of-central-directory record at the end");
  if (dv.getUint16(eocd + 4, true) !== 0 || dv.getUint16(eocd + 6, true) !== 0) throw new Error("ZIP: multi-disk archive");
  const count = dv.getUint16(eocd + 10, true);
  if (dv.getUint16(eocd + 8, true) !== count) throw new Error("ZIP: entry counts differ");
  const cdSize = dv.getUint32(eocd + 12, true), cdStart = dv.getUint32(eocd + 16, true);
  if (cdStart + cdSize !== eocd) throw new Error("ZIP: central directory does not end at the EOCD record");
  if (dv.getUint16(eocd + 20, true) !== 0) throw new Error("ZIP: unexpected archive comment");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  let o = cdStart, expectedLocal = 0;
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(o, true) !== 0x02014b50) throw new Error(`ZIP: bad central header ${k}`);
    const flags = dv.getUint16(o + 8, true), method = dv.getUint16(o + 10, true);
    const crc = dv.getUint32(o + 16, true), csize = dv.getUint32(o + 20, true), usize = dv.getUint32(o + 24, true);
    const nameLen = dv.getUint16(o + 28, true), extraLen = dv.getUint16(o + 30, true), commentLen = dv.getUint16(o + 32, true);
    const local = dv.getUint32(o + 42, true);
    const name = utf8.decode(zip.subarray(o + 46, o + 46 + nameLen));
    o += 46 + nameLen + extraLen + commentLen;
    // local header
    if (local !== expectedLocal) throw new Error(`ZIP: entry ${name} starts at ${local}, expected ${expectedLocal} (gap or overlap)`);
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`ZIP: bad local header for ${name}`);
    const lNameLen = dv.getUint16(local + 26, true), lExtraLen = dv.getUint16(local + 28, true);
    const same = dv.getUint16(local + 6, true) === flags && dv.getUint16(local + 8, true) === method && dv.getUint32(local + 14, true) === crc &&
      dv.getUint32(local + 18, true) === csize && dv.getUint32(local + 22, true) === usize &&
      utf8.decode(zip.subarray(local + 30, local + 30 + lNameLen)) === name;
    if (!same) throw new Error(`ZIP: local and central headers of ${name} disagree`);
    if (method !== 0 || csize !== usize) throw new Error(`ZIP: ${name} is not stored`);
    const start = local + 30 + lNameLen + lExtraLen;
    entries.push({ name, data: zip.subarray(start, start + usize), crc, method, flags, localHeaderOffset: local });
    expectedLocal = start + usize;
  }
  if (o !== eocd) throw new Error("ZIP: central directory size mismatch");
  if (expectedLocal !== cdStart) throw new Error("ZIP: file data does not end at the central directory");
  return entries;
}
