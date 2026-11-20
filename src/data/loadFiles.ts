import { ConnMatrix } from "./connMatrix";
import type { GlyphDataset, Overlay, Surface } from "./dataset";
import { orientOutward, validateDataset } from "./dataset";
import { isWebManifest, loadWebGlyphset } from "./loadWeb";
import {
  CURV_HEADER_BYTES, giftiToMesh, giftiToScalars, hasFreeSurferCurvOrQuadMagic, isFreeSurferCurv, isFreeSurferSurface, isNpy,
  parseFreeSurferAsc, parseFreeSurferCurv, parseFreeSurferSurface, parseGifti, parseGlyphsetFile, parseNpy, parseRoiFile,
  parseSetFile, TriMesh,
} from "../io";

type Status = (msg: string, fraction?: number) => void;

export interface LoadedFiles {
  dataset: GlyphDataset;
  /** brainGL's load-time minimum threshold from the .glyphset file, if any */
  minThreshold: number | null;
  /** upper threshold from the .glyphset file, if it differs from the default 1.0 */
  maxThreshold: number | null;
  /** ROI of glyph nodes from the .glyphset file (4th item on its third line), if any */
  roi: Uint8Array | null;
  /** ROI of connection targets (5th item), if any */
  targets: Uint8Array | null;
  notes: string[];
}

const base = (name: string) => name.split(/[\\/]/).pop() ?? name;

/** Combine one mesh per hemisphere into one (brainGL: two .set files -> one TriangleMesh2). */
function stack(left: TriMesh, right: TriMesh | null, offL: number[], offR: number[]): TriMesh {
  const nl = left.positions.length / 3;
  const nr = right ? right.positions.length / 3 : 0;
  const positions = new Float32Array(3 * (nl + nr));
  for (let i = 0; i < nl; i++) for (let k = 0; k < 3; k++) positions[3 * i + k] = left.positions[3 * i + k] + offL[k];
  const triangles = new Uint32Array(left.triangles.length + (right ? right.triangles.length : 0));
  triangles.set(left.triangles);
  if (right) {
    for (let i = 0; i < nr; i++) for (let k = 0; k < 3; k++) positions[3 * (nl + i) + k] = right.positions[3 * i + k] + offR[k];
    for (let t = 0; t < right.triangles.length; t++) triangles[left.triangles.length + t] = right.triangles[t] + nl;
  }
  return { positions, triangles };
}

/** Move two overlapping hemispheres apart along x (inflated and spherical surfaces are centred on the origin). */
function separate(positions: Float32Array, nl: number, gap = 5): void {
  const n = positions.length / 3;
  if (nl <= 0 || nl >= n) return;
  let maxL = -Infinity, minR = Infinity;
  for (let i = 0; i < nl; i++) maxL = Math.max(maxL, positions[3 * i]);
  for (let i = nl; i < n; i++) minR = Math.min(minR, positions[3 * i]);
  const overlap = maxL - minR;
  if (overlap <= -gap) return;
  const shift = (overlap + gap) / 2;
  for (let i = 0; i < nl; i++) positions[3 * i] -= shift;
  for (let i = nl; i < n; i++) positions[3 * i] += shift;
}

async function readMesh(f: File): Promise<TriMesh | null> {
  const name = f.name.toLowerCase();
  if (name.endsWith(".asc")) return parseFreeSurferAsc(await f.text());
  if (name.endsWith(".gii")) return giftiToMesh(await parseGifti(await f.arrayBuffer()));
  const buf = await f.arrayBuffer();
  if (isFreeSurferSurface(buf)) return parseFreeSurferSurface(buf);
  return null;
}

async function readMatrix(f: File, n: number, status?: Status): Promise<ConnMatrix> {
  const head = await f.slice(0, 16).arrayBuffer();
  if (isNpy(head)) {
    status?.("Reading " + f.name + "…");
    if (f.size > 2 ** 31) throw new Error(`${f.name} is ${(f.size / 2 ** 30).toFixed(1)} GB; save the matrix as float32 (.npy or raw) to stay below 2 GB`);
    const a = parseNpy(await f.arrayBuffer());
    if (a.shape.length !== 2 || a.shape[0] !== a.shape[1]) throw new Error(`${f.name}: expected a square 2-D array, got shape [${a.shape.join(", ")}]`);
    return ConnMatrix.fromFull(a.data, a.shape[0], a.fortranOrder);
  }
  const m = await ConnMatrix.fromFloat32Blob(f, (fr) => status?.("Reading " + f.name + "…", fr));
  if (n && m.n !== n) throw new Error(`${f.name} is a ${m.n} x ${m.n} matrix but the surfaces have ${n} nodes`);
  return m;
}

/** True when a file of this size can hold a square float32 matrix. */
function isSquareFloat32(bytes: number): boolean {
  const n = Math.round(Math.sqrt(bytes / 4));
  return n > 0 && n * n * 4 === bytes;
}

function hemiOf(name: string): "L" | "R" | null {
  const b = base(name);
  if (/(^|[._-])(lh|l|left)([._-]|$)/i.test(b)) return "L";
  if (/(^|[._-])(rh|r|right)([._-]|$)/i.test(b)) return "R";
  return null;
}

function surfaceLabel(name: string): string {
  const b = base(name).toLowerCase();
  for (const k of ["very_inflated", "veryinflated", "midthickness", "inflated", "sphere", "pial", "white", "flat", "smoothwm", "orig"]) {
    if (b.includes(k)) return k;
  }
  return b.replace(/\.(asc|gii|surf)$/g, "").replace(/(^|[._-])(lh|rh|l|r|left|right)([._-]|$)/gi, ".").replace(/^\.+|\.+$/g, "") || b;
}

/**
 * Build a dataset from files dropped onto the page. Three layouts are
 * recognised:
 *  1. a web glyphset folder (glyphset.json + binaries),
 *  2. an original brainGL glyphset (.glyphset + .set + .asc + float32 matrix [+ ROI]),
 *  3. loose files: surfaces (.asc / .surf.gii / FreeSurfer binary) + a square
 *     matrix (.npy or raw float32) [+ per-node scalars].
 */
export async function loadFromFiles(files: File[], status?: Status): Promise<LoadedFiles> {
  const byName = new Map<string, File>();
  for (const f of files) byName.set(base(f.name), f);
  const find = (name: string): File => {
    const f = byName.get(base(name));
    if (!f) throw new Error(`"${base(name)}" is referenced but was not among the selected files — select or drop all files of the glyphset together`);
    return f;
  };
  const notes: string[] = [];

  // 1. web glyphset
  const manifestFile = files.find((f) => base(f.name).toLowerCase() === "glyphset.json") ?? files.find((f) => f.name.toLowerCase().endsWith(".json"));
  if (manifestFile) {
    const man: unknown = JSON.parse(await manifestFile.text());
    if (isWebManifest(man)) {
      const dataset = await loadWebGlyphset(man, async (name) => find(name).arrayBuffer(), status);
      return { dataset, minThreshold: null, maxThreshold: null, roi: null, targets: null, notes };
    }
  }

  // 2. original brainGL .glyphset
  const gs = files.find((f) => f.name.toLowerCase().endsWith(".glyphset"));
  if (gs) {
    const spec = parseGlyphsetFile(await gs.text());
    const sets = await Promise.all(spec.sets.slice(0, 2).map(async (s) => parseSetFile(await find(s).text())));
    const two = sets.length > 1;
    const surfaces: Surface[] = [];
    let triangles: Uint32Array | null = null;
    let leftNodes = 0, leftTriangles = 0;
    for (let k = 0; k < sets[0].length; k++) {
      status?.(`Reading surface ${sets[0][k].file}…`);
      const l = parseFreeSurferAsc(await find(sets[0][k].file).text());
      const r = two && sets[1][k] ? parseFreeSurferAsc(await find(sets[1][k].file).text()) : null;
      const m = stack(l, r, sets[0][k].offset, r ? sets[1][k].offset : [0, 0, 0]);
      if (r) { leftNodes = l.positions.length / 3; leftTriangles = l.triangles.length / 3; }
      if (!triangles) triangles = m.triangles;
      surfaces.push({ name: surfaceLabel(sets[0][k].file), positions: m.positions });
    }
    if (!triangles || !surfaces.length) throw new Error("the .set file lists no surfaces");
    const n = surfaces[0].positions.length / 3;
    for (const s of surfaces) if (s.positions.length !== 3 * n) throw new Error(`surface "${s.name}" has a different node count`);
    const conn = await readMatrix(find(spec.connectivity), n, status);
    if (conn.n !== n) throw new Error(`connectivity matrix is ${conn.n} x ${conn.n} but the surfaces have ${n} nodes`);
    fixWinding(surfaces[0].positions, triangles, leftTriangles);
    let roi: Uint8Array | null = null;
    if (spec.roi) roi = parseRoiFile(spec.roi, await find(spec.roi).text(), n);
    const targets = spec.roi2 ? parseRoiFile(spec.roi2, await find(spec.roi2).text(), n) : null;
    notes.push(`brainGL glyphset, load-time minimum threshold ${spec.minThreshold}`);
    const dataset: GlyphDataset = {
      name: base(gs.name), description: "", n, triangles, leftNodes, leftTriangles, surfaces, overlays: [],
      mask: maskFromMatrix(conn), conn,
    };
    validateDataset(dataset);
    return {
      dataset,
      minThreshold: spec.minThreshold, maxThreshold: spec.maxThreshold < 1 ? spec.maxThreshold : null, roi, targets, notes,
    };
  }

  // 3. loose files
  const meshes: { file: File; mesh: TriMesh; hemi: "L" | "R" | null; label: string }[] = [];
  const scalars: { file: File; data: Float32Array; hemi: "L" | "R" | null }[] = [];
  let matrixFile: File | null = null;
  for (const f of files) {
    const name = f.name.toLowerCase();
    if (/\.(set|txt|json|md|scn|nii|gz)$/.test(name)) continue;
    if (name.endsWith(".gii")) {
      const g = await parseGifti(await f.arrayBuffer());
      const mesh = giftiToMesh(g);
      if (mesh) meshes.push({ file: f, mesh, hemi: hemiOf(f.name), label: surfaceLabel(f.name) });
      else for (const d of giftiToScalars(g)) scalars.push({ file: f, data: d, hemi: hemiOf(f.name) });
      continue;
    }
    if (name.endsWith(".asc")) {
      meshes.push({ file: f, mesh: parseFreeSurferAsc(await f.text()), hemi: hemiOf(f.name), label: surfaceLabel(f.name) });
      continue;
    }
    if (name.endsWith(".1d")) {
      const vals = (await f.text()).split(/\s+/).filter(Boolean).map(Number);
      scalars.push({ file: f, data: Float32Array.from(vals), hemi: hemiOf(f.name) });
      continue;
    }
    if (/\.(npy|bin|data|dat|f32|raw)$/.test(name)) {
      if (!matrixFile || f.size > matrixFile.size) matrixFile = f;
      continue;
    }
    // sniff the type: the curvature test needs the whole 15-byte header, not just the magic number
    const head = await f.slice(0, CURV_HEADER_BYTES).arrayBuffer();
    if (isFreeSurferSurface(head)) {
      const mesh = await readMesh(f);
      if (mesh) meshes.push({ file: f, mesh, hemi: hemiOf(f.name), label: surfaceLabel(f.name) });
    } else if (isFreeSurferCurv(head, f.size)) {
      scalars.push({ file: f, data: parseFreeSurferCurv(await f.arrayBuffer()), hemi: hemiOf(f.name) });
    } else if (hasFreeSurferCurvOrQuadMagic(head) && !isSquareFloat32(f.size)) {
      // a truncated curvature file or a quadrangle surface: never a candidate for the connectivity matrix
      notes.push(`skipped "${base(f.name)}" (FreeSurfer curvature / quadrangle file that could not be read)`);
    } else if (!matrixFile || f.size > matrixFile.size) {
      matrixFile = f;
    }
  }
  if (!meshes.length) throw new Error("No surface found. Drop a glyphset.json folder, a brainGL .glyphset with its files, or surfaces (.asc, .surf.gii, FreeSurfer) plus a connectivity matrix (.npy or raw float32).");
  if (!matrixFile) throw new Error("No connectivity matrix found (expected a square .npy or raw float32 file with one row per surface node).");

  const labels = [...new Set(meshes.map((m) => m.label))];
  const rank = (l: string) => { const i = ["pial", "midthickness", "white", "smoothwm", "orig", "inflated", "very_inflated", "veryinflated", "sphere", "flat"].indexOf(l); return i < 0 ? 99 : i; };
  labels.sort((a, b) => rank(a) - rank(b));
  const surfaces: Surface[] = [];
  let triangles: Uint32Array | null = null;
  let leftNodes = 0, leftTriangles = 0;
  for (const label of labels) {
    const group = meshes.filter((m) => m.label === label);
    const l = group.find((m) => m.hemi === "L") ?? group.find((m) => m.hemi === null) ?? group[0];
    const r = group.find((m) => m.hemi === "R" && m !== l) ?? null;
    const m = stack(l.mesh, r ? r.mesh : null, [0, 0, 0], [0, 0, 0]);
    if (r) {
      leftNodes = l.mesh.positions.length / 3;
      leftTriangles = l.mesh.triangles.length / 3;
      if (label !== "pial" && label !== "white" && label !== "midthickness") separate(m.positions, leftNodes);
    }
    if (!triangles) triangles = m.triangles;
    else if (m.positions.length !== surfaces[0].positions.length) {
      notes.push(`skipped surface "${label}" (different node count)`);
      continue;
    }
    surfaces.push({ name: label, positions: m.positions });
  }
  const n = surfaces[0].positions.length / 3;
  const conn = await readMatrix(matrixFile, n, status);
  if (conn.n !== n) throw new Error(`${matrixFile.name} is ${conn.n} x ${conn.n} but the surfaces have ${n} nodes`);
  fixWinding(surfaces[0].positions, triangles!, leftTriangles);

  const overlays: Overlay[] = [];
  const names = [...new Set(scalars.map((s) => base(s.file.name).replace(/(^|[._-])(lh|rh|l|r|left|right)([._-]|$)/gi, ".").replace(/\.(gii|func|shape|1d)/gi, "").replace(/^\.+|\.+$/g, "")))];
  for (const nm of names) {
    const group = scalars.filter((s) => base(s.file.name).replace(/(^|[._-])(lh|rh|l|r|left|right)([._-]|$)/gi, ".").replace(/\.(gii|func|shape|1d)/gi, "").replace(/^\.+|\.+$/g, "") === nm);
    const whole = group.find((s) => s.data.length === n);
    if (whole) { overlays.push({ name: nm, data: whole.data }); continue; }
    const l = group.find((s) => s.hemi === "L"), r = group.find((s) => s.hemi === "R");
    if (l && r && l.data.length + r.data.length === n) {
      const d = new Float32Array(n);
      d.set(l.data); d.set(r.data, l.data.length);
      overlays.push({ name: nm, data: d });
    }
  }
  const dataset: GlyphDataset = {
    name: base(matrixFile.name), description: "", n, triangles: triangles!, leftNodes, leftTriangles, surfaces, overlays,
    mask: maskFromMatrix(conn), conn,
  };
  validateDataset(dataset);
  return {
    dataset,
    minThreshold: null, maxThreshold: null, roi: null, targets: null, notes,
  };
}

function fixWinding(positions: Float32Array, triangles: Uint32Array, leftTriangles: number): void {
  const n = positions.length / 3;
  for (let t = 0; t < triangles.length; t++) {
    if (triangles[t] >= n) throw new Error(`a surface triangle refers to node ${triangles[t]}, but the surface has only ${n} nodes`);
  }
  if (leftTriangles > 0 && leftTriangles * 3 < triangles.length) {
    orientOutward(positions, triangles, 0, leftTriangles * 3);
    orientOutward(positions, triangles, leftTriangles * 3, triangles.length);
  } else {
    orientOutward(positions, triangles);
  }
}

/** Nodes whose row is entirely zero (medial wall) carry no data. */
function maskFromMatrix(conn: ConnMatrix): Uint8Array {
  const { n, data } = conn;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * n;
    for (let j = 0; j < n; j++) {
      if (j !== i && data[o + j] !== 0) { mask[i] = 1; break; }
    }
  }
  return mask;
}
