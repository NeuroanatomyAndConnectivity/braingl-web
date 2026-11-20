import { ConnMatrix } from "./connMatrix";
import type { GlyphDataset, Overlay, Surface } from "./dataset";
import { orientOutward, validateDataset } from "./dataset";

/** Manifest of a web glyphset folder (written by tools/make_glyphset.py). */
export interface WebGlyphsetManifest {
  format: "braingl-web-glyphset";
  version: number;
  name: string;
  description?: string;
  nodes: number;
  leftNodes?: number;
  leftTriangles?: number;
  triangles: string;
  surfaces: { name: string; file: string }[];
  overlays?: { name: string; file: string }[];
  mask?: string;
  connectivity: { file: string; dtype: "int8" | "int16" | "float32"; layout: "upper" | "full"; scale?: number };
}

export type FileGetter = (name: string, onProgress?: (fraction: number) => void) => Promise<ArrayBuffer>;

export function isWebManifest(x: unknown): x is WebGlyphsetManifest {
  return typeof x === "object" && x !== null && (x as { format?: unknown }).format === "braingl-web-glyphset";
}

export async function loadWebGlyphset(
  man: WebGlyphsetManifest,
  get: FileGetter,
  onStatus?: (msg: string, fraction?: number) => void,
): Promise<GlyphDataset> {
  const n = man.nodes;
  onStatus?.("Loading surfaces…");
  const triangles = new Uint32Array(await get(man.triangles));
  const surfaces: Surface[] = [];
  for (const s of man.surfaces) {
    const positions = new Float32Array(await get(s.file));
    if (positions.length !== 3 * n) throw new Error(`surface "${s.name}" has ${positions.length / 3} nodes, expected ${n}`);
    surfaces.push({ name: s.name, positions });
  }
  const overlays: Overlay[] = [];
  for (const o of man.overlays ?? []) {
    const data = new Float32Array(await get(o.file));
    if (data.length === n) overlays.push({ name: o.name, data });
  }
  let mask: Uint8Array;
  if (man.mask) mask = new Uint8Array(await get(man.mask));
  else mask = new Uint8Array(n).fill(1);

  onStatus?.("Loading connectivity…", 0);
  const c = man.connectivity;
  const buf = await get(c.file, (f) => onStatus?.("Loading connectivity…", f));
  onStatus?.("Unpacking connectivity…");
  await new Promise((r) => setTimeout(r, 0));
  const raw = c.dtype === "int8" ? new Int8Array(buf) : c.dtype === "int16" ? new Int16Array(buf) : new Float32Array(buf);
  const scale = c.scale ?? 1;
  let conn: ConnMatrix;
  if (c.layout === "upper") {
    conn = ConnMatrix.fromUpper(raw, n, scale);
  } else {
    const full = ConnMatrix.fromFull(raw, n);
    conn = new ConnMatrix(n, full.data, full.scale * scale);
  }

  const leftNodes = man.leftNodes ?? 0;
  const leftTriangles = man.leftTriangles ?? 0;
  for (let t = 0; t < triangles.length; t++) {
    if (triangles[t] >= n) throw new Error(`triangle ${Math.floor(t / 3)} refers to node ${triangles[t]}, but there are only ${n} nodes`);
  }
  // decide the winding once, on the first (anatomical) surface, per hemisphere
  if (leftTriangles > 0 && leftTriangles * 3 < triangles.length) {
    orientOutward(surfaces[0].positions, triangles, 0, leftTriangles * 3);
    orientOutward(surfaces[0].positions, triangles, leftTriangles * 3, triangles.length);
  } else {
    orientOutward(surfaces[0].positions, triangles);
  }
  const ds: GlyphDataset = {
    name: String(man.name ?? "glyphset"), description: man.description ?? "", n, triangles, leftNodes, leftTriangles,
    surfaces, overlays, mask, conn,
  };
  validateDataset(ds);
  return ds;
}

/** Fetch with download progress. */
export function urlGetter(baseUrl: string): FileGetter {
  return async (name, onProgress) => {
    const res = await fetch(baseUrl + name);
    if (!res.ok) throw new Error(`Could not fetch ${baseUrl + name} (${res.status})`);
    const total = Number(res.headers.get("content-length") ?? 0);
    if (!res.body || !total || !onProgress) return res.arrayBuffer();
    const reader = res.body.getReader();
    const out = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > out.length) {
        // content-length was the compressed size; fall back to growing
        const bigger = new Uint8Array(Math.max(out.length * 2, got + value.length));
        bigger.set(out.subarray(0, got));
        return finish(reader, bigger, got, value);
      }
      out.set(value, got);
      got += value.length;
      onProgress(got / total);
    }
    return got === out.length ? out.buffer : out.slice(0, got).buffer;
  };
}

async function finish(reader: ReadableStreamDefaultReader<Uint8Array>, buf: Uint8Array, got: number, first: Uint8Array): Promise<ArrayBuffer> {
  let out = buf;
  out.set(first, got);
  got += first.length;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) {
      const bigger = new Uint8Array(Math.max(out.length * 2, got + value.length));
      bigger.set(out.subarray(0, got));
      out = bigger;
    }
    out.set(value, got);
    got += value.length;
  }
  return out.slice(0, got).buffer;
}
