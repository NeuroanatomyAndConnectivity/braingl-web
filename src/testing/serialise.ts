/**
 * Writers that put a fixture into every on-disk layout the loaders accept, as
 * in-memory `File[]` (what a drag-and-drop or a file dialog hands to
 * loadFromFiles):
 *
 *   toWebGlyphsetFiles   glyphset.json + binaries; int8 / int16 / float32, "upper" / "full"
 *   toBrainGLFiles       .glyphset + .set + FreeSurfer .asc + raw float32 matrix [+ .1D ROI]
 *   toLooseFiles         surfaces (.surf.gii, FreeSurfer binary or .asc) + matrix (.npy or raw) [+ scalars]
 *
 * The file formats are written here from their specifications, independently
 * of the parsers under src/io.
 */
import { deflateSync, gzipSync } from "node:zlib";
import type { FixtureDataset } from "./fixtures";

export type WebDtype = "int8" | "int16" | "float32";
export type WebLayout = "upper" | "full";

const bytes = (a: ArrayBufferView): Uint8Array<ArrayBuffer> => new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) as ArrayBuffer);
const file = (data: ArrayBufferView | string, name: string): File => new File([typeof data === "string" ? data : bytes(data)], name);

/** A typed array as a Blob (what File.slice() / a dropped raw matrix file gives the loaders). */
export function f32Blob(values: ArrayBufferView): Blob {
  return new Blob([bytes(values)]);
}

/** Nodes / triangles of the left hemisphere, or everything when the dataset is not split. */
export function hemiSplit(ds: FixtureDataset): { nodes: number; triangles: number; two: boolean } {
  const two = ds.leftNodes > 0 && ds.leftNodes < ds.n;
  return { nodes: two ? ds.leftNodes : ds.n, triangles: two ? ds.leftTriangles : ds.triangles.length / 3, two };
}

// --------------------------------------------------------------- web glyphset

export interface WebGlyphsetOptions {
  dtype: WebDtype;
  layout: WebLayout;
  /** leave the mask file out of the manifest (the loader then assumes all nodes carry data) */
  noMask?: boolean;
}

/** The values a web glyphset of the given layout stores, in file order. */
export function storedValues(ds: FixtureDataset, layout: WebLayout): Float32Array {
  const n = ds.n;
  if (layout === "full") return Float32Array.from(ds.values);
  const out = new Float32Array((n * (n - 1)) / 2);
  let k = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out[k++] = ds.values[i * n + j];
  return out;
}

/** Quantisation of a web glyphset: stored integer = round(value / scale). */
export function webScale(ds: FixtureDataset, o: { dtype: WebDtype; layout: WebLayout }): number {
  if (o.dtype === "float32") return 1;
  let maxAbs = 0;
  for (const v of storedValues(ds, o.layout)) maxAbs = Math.max(maxAbs, Math.abs(v));
  return (maxAbs || 1) / (o.dtype === "int8" ? 127 : 32767);
}

export function toWebGlyphsetFiles(ds: FixtureDataset, o: WebGlyphsetOptions): File[] {
  const stored = storedValues(ds, o.layout);
  const scale = webScale(ds, o);
  let conn: ArrayBufferView = stored;
  if (o.dtype === "int8") conn = Int8Array.from(stored, (v) => Math.round(v / scale));
  if (o.dtype === "int16") conn = Int16Array.from(stored, (v) => Math.round(v / scale));
  const ext = { int8: "i8", int16: "i16", float32: "f32" }[o.dtype];
  const manifest: Record<string, unknown> = {
    format: "braingl-web-glyphset",
    version: 1,
    name: ds.name,
    description: ds.description,
    nodes: ds.n,
    leftNodes: ds.leftNodes,
    leftTriangles: ds.leftTriangles,
    triangles: "triangles.u32",
    surfaces: ds.surfaces.map((s) => ({ name: s.name, file: `${s.name}.f32` })),
    overlays: ds.overlays.map((v) => ({ name: v.name, file: `${v.name}.f32` })),
    connectivity: { file: `connectivity.${ext}`, dtype: o.dtype, layout: o.layout, scale },
  };
  if (!o.noMask) manifest.mask = "mask.u8";
  const files = [
    file(JSON.stringify(manifest, null, 1), "glyphset.json"),
    file(ds.triangles, "triangles.u32"),
    ...ds.surfaces.map((s) => file(s.positions, `${s.name}.f32`)),
    ...ds.overlays.map((v) => file(v.data, `${v.name}.f32`)),
    file(conn, `connectivity.${ext}`),
  ];
  if (!o.noMask) files.push(file(ds.mask, "mask.u8"));
  return files;
}

// ------------------------------------------------------------------ low level

/** One hemisphere of one surface, with local node numbering. */
export function hemiMesh(ds: FixtureDataset, surface: number, right: boolean): { positions: Float32Array; triangles: Uint32Array } {
  const s = hemiSplit(ds);
  const pos = ds.surfaces[surface].positions;
  if (!right) return { positions: pos.slice(0, 3 * s.nodes), triangles: ds.triangles.slice(0, 3 * s.triangles) };
  return { positions: pos.slice(3 * s.nodes), triangles: ds.triangles.slice(3 * s.triangles).map((v) => v - s.nodes) };
}

function flipped(triangles: Uint32Array): Uint32Array {
  const out = Uint32Array.from(triangles);
  for (let t = 0; t < out.length; t += 3) { const tmp = out[t + 1]; out[t + 1] = out[t + 2]; out[t + 2] = tmp; }
  return out;
}

/** FreeSurfer ASCII surface (mris_convert): comment, "nVerts nTris", "x y z 0" lines, "a b c 0" lines. */
export function writeAsc(positions: Float32Array, triangles: Uint32Array, offset: readonly number[] = [0, 0, 0]): string {
  const nv = positions.length / 3, nt = triangles.length / 3;
  const lines: string[] = ["#!ascii version of synthetic fixture", `${nv} ${nt}`];
  for (let i = 0; i < nv; i++) {
    lines.push(`${(positions[3 * i] - offset[0]).toFixed(6)}  ${(positions[3 * i + 1] - offset[1]).toFixed(6)}  ${(positions[3 * i + 2] - offset[2]).toFixed(6)}  0`);
  }
  for (let t = 0; t < nt; t++) lines.push(`${triangles[3 * t]} ${triangles[3 * t + 1]} ${triangles[3 * t + 2]} 0`);
  return lines.join("\n") + "\n";
}

/** FreeSurfer binary triangle surface: FF FF FE, comment line, empty line, big-endian counts, vertices, faces. */
export function writeFreeSurferSurface(positions: Float32Array, triangles: Uint32Array): Uint8Array<ArrayBuffer> {
  const comment = new TextEncoder().encode("created by brainGL-web tests on Thu Jan  1 00:00:00 1970\n\n");
  const out = new Uint8Array(3 + comment.length + 8 + positions.length * 4 + triangles.length * 4);
  const dv = new DataView(out.buffer);
  out.set([0xff, 0xff, 0xfe]);
  out.set(comment, 3);
  let o = 3 + comment.length;
  dv.setInt32(o, positions.length / 3, false); dv.setInt32(o + 4, triangles.length / 3, false);
  o += 8;
  for (let i = 0; i < positions.length; i++, o += 4) dv.setFloat32(o, positions[i], false);
  for (let i = 0; i < triangles.length; i++, o += 4) dv.setInt32(o, triangles[i], false);
  return out;
}

/** FreeSurfer "new" curvature file (lh.sulc, lh.curv): FF FF FF, nVerts, nFaces, 1, big-endian float32 values. */
export function writeFreeSurferCurv(data: Float32Array, nFaces: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(15 + data.length * 4);
  const dv = new DataView(out.buffer);
  out.set([0xff, 0xff, 0xff]);
  dv.setInt32(3, data.length, false); dv.setInt32(7, nFaces, false); dv.setInt32(11, 1, false);
  for (let i = 0; i < data.length; i++) dv.setFloat32(15 + 4 * i, data[i], false);
  return out;
}

export type GiftiEncoding = "GZipBase64Binary" | "Base64Binary" | "ASCII" | "GZipMember";

function giftiArray(intent: string, dataType: "NIFTI_TYPE_FLOAT32" | "NIFTI_TYPE_INT32", data: Float32Array | Int32Array, dims: number[], encoding: GiftiEncoding): string {
  let payload: string;
  if (encoding === "ASCII") payload = Array.from(data).join(" ");
  else if (encoding === "Base64Binary") payload = Buffer.from(bytes(data)).toString("base64");
  else if (encoding === "GZipMember") payload = gzipSync(bytes(data)).toString("base64"); // some writers emit a gzip member instead of a zlib stream
  else payload = deflateSync(bytes(data)).toString("base64");
  const enc = encoding === "GZipMember" ? "GZipBase64Binary" : encoding;
  const dimAttrs = dims.map((d, k) => `Dim${k}="${d}"`).join(" ");
  return `<DataArray Intent="${intent}" DataType="${dataType}" ArrayIndexingOrder="RowMajorOrder" Dimensionality="${dims.length}" ${dimAttrs} ` +
    `Encoding="${enc}" Endian="LittleEndian" ExternalFileName="" ExternalFileOffset="">\n` +
    `<MetaData><MD><Name><![CDATA[Name]]></Name><Value><![CDATA[fixture]]></Value></MD></MetaData>\n` +
    (intent === "NIFTI_INTENT_POINTSET"
      ? `<CoordinateSystemTransformMatrix><DataSpace><![CDATA[NIFTI_XFORM_UNKNOWN]]></DataSpace><TransformedSpace><![CDATA[NIFTI_XFORM_UNKNOWN]]></TransformedSpace>` +
        `<MatrixData>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</MatrixData></CoordinateSystemTransformMatrix>\n`
      : "") +
    `<Data>${payload}</Data>\n</DataArray>\n`;
}

function giftiFile(arrays: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE GIFTI SYSTEM "http://www.nitrc.org/frs/download.php/115/gifti.dtd">\n` +
    `<GIFTI Version="1.0" NumberOfDataArrays="${arrays.length}">\n<MetaData/>\n<LabelTable/>\n${arrays.join("")}</GIFTI>\n`;
}

/** GIFTI surface (.surf.gii): a POINTSET and a TRIANGLE array. */
export function writeGiftiSurface(positions: Float32Array, triangles: Uint32Array, encoding: GiftiEncoding = "GZipBase64Binary"): string {
  return giftiFile([
    giftiArray("NIFTI_INTENT_POINTSET", "NIFTI_TYPE_FLOAT32", positions, [positions.length / 3, 3], encoding),
    giftiArray("NIFTI_INTENT_TRIANGLE", "NIFTI_TYPE_INT32", Int32Array.from(triangles), [triangles.length / 3, 3], encoding),
  ]);
}

/** GIFTI per-node scalars (.shape.gii). */
export function writeGiftiShape(data: Float32Array, encoding: GiftiEncoding = "GZipBase64Binary"): string {
  return giftiFile([giftiArray("NIFTI_INTENT_SHAPE", "NIFTI_TYPE_FLOAT32", data, [data.length], encoding)]);
}

export interface NpyOptions {
  dtype: "<f4" | "<f8" | ">f4" | ">f8";
  fortranOrder?: boolean;
  /** .npy format version */
  version?: 1 | 2;
}

/** NumPy .npy file of a square matrix given row-major. */
export function writeNpy(values: Float32Array, n: number, o: NpyOptions): Uint8Array<ArrayBuffer> {
  const version = o.version ?? 1;
  const pre = version === 1 ? 10 : 12;
  let header = `{'descr': '${o.dtype}', 'fortran_order': ${o.fortranOrder ? "True" : "False"}, 'shape': (${n}, ${n}), }`;
  header += " ".repeat((64 - ((pre + header.length + 1) % 64)) % 64) + "\n";
  const size = o.dtype.endsWith("8") ? 8 : 4;
  const little = o.dtype[0] === "<";
  const out = new Uint8Array(pre + header.length + n * n * size);
  const dv = new DataView(out.buffer);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, version, 0]);
  if (version === 1) dv.setUint16(8, header.length, true);
  else dv.setUint32(8, header.length, true);
  out.set(new TextEncoder().encode(header), pre);
  let p = pre + header.length;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++, p += size) {
      // C order: last index fastest. Fortran order: first index fastest.
      const v = o.fortranOrder ? values[b * n + a] : values[a * n + b];
      if (size === 8) dv.setFloat64(p, v, little);
      else dv.setFloat32(p, v, little);
    }
  }
  return out;
}

// ------------------------------------------------------------ brainGL glyphset

export interface BrainGLOptions {
  /** glyph-node ROI written as a .1D file and referenced on line 3 of the .glyphset */
  roi?: Uint8Array;
  /** store the triangles clockwise (the loader has to restore the outward winding) */
  flipWinding?: boolean;
  /** load-time minimum threshold on line 3 */
  minThreshold?: number;
  /** maximum threshold on line 3 (1.0 when omitted) */
  maxThreshold?: number;
  /** ROI of connection targets, the 5th item of line 3 (written as a list of node ids; needs `roi`) */
  targets?: Uint8Array;
}

/**
 * Translation stored in the .set file for surface k of a hemisphere; the
 * vertices in the .asc file are written relative to it, so that the loader
 * has to apply the offsets to get the fixture back.
 */
export function setOffset(surface: number, right: boolean): [number, number, number] {
  return [(right ? 1 : -1) * (10 + 25 * surface), -3 * surface, 2.5 * surface];
}

export function toBrainGLFiles(ds: FixtureDataset, o: BrainGLOptions = {}): File[] {
  const { two } = hemiSplit(ds);
  const files: File[] = [];
  const hemis = two ? [false, true] : [false];
  for (const right of hemis) {
    const h = right ? "rh" : "lh";
    const lines = [`# ${h} surfaces of ${ds.name}`];
    ds.surfaces.forEach((s, k) => {
      const m = hemiMesh(ds, k, right);
      const off = setOffset(k, right);
      const name = `${h}.${s.name}.asc`;
      lines.push(`${name} ${off[0]} ${off[1]} ${off[2]}`);
      files.push(file(writeAsc(m.positions, o.flipWinding ? flipped(m.triangles) : m.triangles, off), name));
    });
    files.push(file(lines.join("\n") + "\n", `${h}.set`));
  }
  files.push(file(ds.values, "connectivity.bin"));
  let third = `connectivity.bin ${o.minThreshold ?? 0.35} ${o.maxThreshold ?? "1.0"}`;
  if (o.roi) {
    files.push(file(Array.from(o.roi, (v) => (v ? "1" : "0")).join("\n") + "\n", "roi.1D"));
    third += " roi.1D";
  }
  if (o.roi && o.targets) {
    // brainGL's third ROI flavour: one node id per line
    const ids: number[] = [];
    o.targets.forEach((v, i) => { if (v) ids.push(i); });
    files.push(file(ids.join("\n") + "\n", "targets.txt"));
    third += " targets.txt";
  }
  files.push(file(`anatomy.nii.gz\n${two ? "lh.set rh.set" : "lh.set"}\n${third}\n`, "fixture.glyphset"));
  return files;
}

// ------------------------------------------------------------------ loose files

export interface LooseOptions {
  surfaces: "gifti" | "gifti-base64" | "gifti-ascii" | "gifti-gzip-member" | "freesurfer" | "asc";
  matrix: "npy-f4" | "npy-f8" | "npy-f4-fortran" | "npy-f8-fortran" | "npy-f8-big-endian" | "npy-v2" | "raw";
  /** how the overlays are written; "none" by default */
  overlays?: "none" | "gifti" | "curv" | "1d";
  /** centre the hemispheres of every non-anatomical surface on the origin, as FreeSurfer stores them */
  centred?: boolean;
  flipWinding?: boolean;
}

const GIFTI_ENCODING: Record<string, GiftiEncoding> = {
  gifti: "GZipBase64Binary", "gifti-base64": "Base64Binary", "gifti-ascii": "ASCII", "gifti-gzip-member": "GZipMember",
};

export function toLooseFiles(ds: FixtureDataset, o: LooseOptions): File[] {
  const { two, nodes, triangles: leftTris } = hemiSplit(ds);
  const files: File[] = [];
  const hemis = two ? [false, true] : [false];
  ds.surfaces.forEach((s, k) => {
    for (const right of hemis) {
      const m = hemiMesh(ds, k, right);
      if (o.centred && s.name !== "pial") {
        let cx = 0;
        for (let i = 0; i < m.positions.length; i += 3) cx += m.positions[i];
        cx /= m.positions.length / 3;
        for (let i = 0; i < m.positions.length; i += 3) m.positions[i] -= cx;
      }
      const tris = o.flipWinding ? flipped(m.triangles) : m.triangles;
      const h = two ? (right ? "rh." : "lh.") : "";
      if (o.surfaces === "freesurfer") files.push(file(writeFreeSurferSurface(m.positions, tris), `${h}${s.name}`));
      else if (o.surfaces === "asc") files.push(file(writeAsc(m.positions, tris), `${h}${s.name}.asc`));
      else files.push(file(writeGiftiSurface(m.positions, tris, GIFTI_ENCODING[o.surfaces]), `${h}${s.name}.surf.gii`));
    }
  });
  for (const v of o.overlays && o.overlays !== "none" ? ds.overlays : []) {
    for (const right of hemis) {
      const d = right ? v.data.slice(nodes) : v.data.slice(0, nodes);
      const h = two ? (right ? "rh." : "lh.") : "";
      const nFaces = right ? ds.triangles.length / 3 - leftTris : leftTris;
      if (o.overlays === "curv") files.push(file(writeFreeSurferCurv(d, nFaces), `${h}${v.name}`));
      else if (o.overlays === "1d") files.push(file(Array.from(d).join("\n") + "\n", `${h}${v.name}.1D`));
      else files.push(file(writeGiftiShape(d), `${h}${v.name}.shape.gii`));
    }
  }
  const n = ds.n;
  switch (o.matrix) {
    case "raw": files.push(file(ds.values, "connectivity.bin")); break;
    case "npy-f4": files.push(file(writeNpy(ds.values, n, { dtype: "<f4" }), "connectivity.npy")); break;
    case "npy-f8": files.push(file(writeNpy(ds.values, n, { dtype: "<f8" }), "connectivity.npy")); break;
    case "npy-f4-fortran": files.push(file(writeNpy(ds.values, n, { dtype: "<f4", fortranOrder: true }), "connectivity.npy")); break;
    case "npy-f8-fortran": files.push(file(writeNpy(ds.values, n, { dtype: "<f8", fortranOrder: true }), "connectivity.npy")); break;
    case "npy-f8-big-endian": files.push(file(writeNpy(ds.values, n, { dtype: ">f8" }), "connectivity.npy")); break;
    case "npy-v2": files.push(file(writeNpy(ds.values, n, { dtype: "<f4", version: 2 }), "connectivity.npy")); break;
  }
  return files;
}

/** Remove one file by name (to test "missing referenced file" errors). */
export function without(files: File[], name: string): File[] {
  const out = files.filter((f) => f.name !== name);
  if (out.length === files.length) throw new Error(`no file named ${name}`);
  return out;
}
