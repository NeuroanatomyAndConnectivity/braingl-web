import { ConnMatrix } from "./connMatrix";

export interface Surface {
  name: string;
  positions: Float32Array; // xyz per node
}

export interface Overlay {
  name: string;
  data: Float32Array; // one value per node
}

/**
 * Everything brainGL's DatasetGlyphset holds: several spatial representations
 * of one mesh (pial / inflated / sphere ... with identical node numbering), the
 * connectivity between its nodes, and the hemisphere split.
 */
export interface GlyphDataset {
  name: string;
  description: string;
  n: number;
  triangles: Uint32Array;
  /** Number of nodes / triangles of the left hemisphere (brainGL's m_points_middle / m_tris_middle); 0 = not split. */
  leftNodes: number;
  leftTriangles: number;
  surfaces: Surface[];
  overlays: Overlay[];
  /** 1 = node carries data (cortex), 0 = e.g. medial wall. */
  mask: Uint8Array;
  conn: ConnMatrix;
}

export interface MeshTopology {
  /** CSR vertex adjacency */
  adjStart: Uint32Array;
  adj: Uint32Array;
  /** unique undirected edges, pairs (a < b) */
  edges: Uint32Array;
}

export function buildTopology(n: number, triangles: Uint32Array): MeshTopology {
  // collect directed half-edges as a*n+b keys, dedupe via sort
  const nt = triangles.length / 3;
  const keys = new Float64Array(nt * 6);
  let k = 0;
  for (let t = 0; t < nt; t++) {
    const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];
    keys[k++] = a * n + b; keys[k++] = b * n + a;
    keys[k++] = b * n + c; keys[k++] = c * n + b;
    keys[k++] = c * n + a; keys[k++] = a * n + c;
  }
  keys.sort();
  const adjStart = new Uint32Array(n + 1);
  const adjTmp = new Uint32Array(keys.length);
  let m = 0;
  let prev = -1;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === prev) continue;
    prev = key;
    const a = Math.floor(key / n);
    const b = key - a * n;
    if (a === b) continue;
    adjTmp[m++] = b;
    adjStart[a + 1]++;
  }
  for (let i = 0; i < n; i++) adjStart[i + 1] += adjStart[i];
  const adj = adjTmp.slice(0, m);
  const edges = new Uint32Array(m); // m directed = 2 * undirected
  let e = 0;
  for (let a = 0; a < n; a++) {
    for (let p = adjStart[a]; p < adjStart[a + 1]; p++) {
      const b = adj[p];
      if (a < b) { edges[e++] = a; edges[e++] = b; }
    }
  }
  return { adjStart, adj, edges: edges.slice(0, e) };
}

/** Area-weighted vertex normals. */
/**
 * Range of `triangles` (first index, number of indices) that belongs to the hemispheres shown:
 * `hemi` 0 both, 1 left, 2 right. Without a hemisphere split it is always the whole mesh.
 */
export function hemisphereTriangles(mesh: Pick<GlyphDataset, "triangles" | "leftTriangles">, hemi: 0 | 1 | 2): [number, number] {
  const total = mesh.triangles.length;
  const split = mesh.leftTriangles > 0 && mesh.leftTriangles * 3 < total ? mesh.leftTriangles * 3 : 0;
  if (split && hemi === 1) return [0, split];
  if (split && hemi === 2) return [split, total - split];
  return [0, total];
}

export function computeNormals(positions: Float32Array, triangles: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < triangles.length; t += 3) {
    const a = 3 * triangles[t], b = 3 * triangles[t + 1], c = 3 * triangles[t + 2];
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return normals;
}

/**
 * Make triangle winding consistent with outward normals. FreeSurfer and GIFTI
 * disagree on winding (brainGL swaps two indices when loading .asc), so decide
 * from the data: the signed volume of a closed outward-wound mesh is positive.
 */
export function orientOutward(positions: Float32Array, triangles: Uint32Array, from = 0, to = triangles.length): void {
  let cx = 0, cy = 0, cz = 0, cnt = 0;
  for (let t = from; t < to; t++) {
    const a = 3 * triangles[t];
    cx += positions[a]; cy += positions[a + 1]; cz += positions[a + 2]; cnt++;
  }
  if (!cnt) return;
  cx /= cnt; cy /= cnt; cz /= cnt;
  let vol = 0;
  for (let t = from; t < to; t += 3) {
    const a = 3 * triangles[t], b = 3 * triangles[t + 1], c = 3 * triangles[t + 2];
    const ax = positions[a] - cx, ay = positions[a + 1] - cy, az = positions[a + 2] - cz;
    const bx = positions[b] - cx, by = positions[b + 1] - cy, bz = positions[b + 2] - cz;
    const dx = positions[c] - cx, dy = positions[c + 1] - cy, dz = positions[c + 2] - cz;
    vol += ax * (by * dz - bz * dy) - ay * (bx * dz - bz * dx) + az * (bx * dy - by * dx);
  }
  if (vol < 0) {
    for (let t = from; t < to; t += 3) {
      const tmp = triangles[t + 1];
      triangles[t + 1] = triangles[t + 2];
      triangles[t + 2] = tmp;
    }
  }
}

export interface Bounds {
  center: [number, number, number];
  radius: number;
}

export function computeBounds(positions: Float32Array, lo = 0, hi = positions.length / 3): Bounds {
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = lo; i < hi; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  const center: [number, number, number] = [(minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2];
  let r2 = 0;
  for (let i = lo; i < hi; i++) {
    const dx = positions[3 * i] - center[0], dy = positions[3 * i + 1] - center[1], dz = positions[3 * i + 2] - center[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  return { center, radius: Math.sqrt(r2) };
}

export interface SphereInfo {
  surface: number; // index into dataset.surfaces
  centerL: [number, number, number];
  centerR: [number, number, number];
}

/** Find the spherical representation (needed for the polar-projection glyph geometry). */
export function findSphere(ds: GlyphDataset): SphereInfo | null {
  const fit = (pos: Float32Array, lo: number, hi: number) => {
    let cx = 0, cy = 0, cz = 0;
    for (let i = lo; i < hi; i++) { cx += pos[3 * i]; cy += pos[3 * i + 1]; cz += pos[3 * i + 2]; }
    const m = hi - lo;
    cx /= m; cy /= m; cz /= m;
    let mean = 0, sq = 0;
    for (let i = lo; i < hi; i++) {
      const d = Math.hypot(pos[3 * i] - cx, pos[3 * i + 1] - cy, pos[3 * i + 2] - cz);
      mean += d; sq += d * d;
    }
    mean /= m;
    const sd = Math.sqrt(Math.max(0, sq / m - mean * mean));
    return { center: [cx, cy, cz] as [number, number, number], cv: sd / (mean || 1) };
  };
  let best: SphereInfo | null = null;
  let bestCv = 0.02; // radius must be constant within 2 %
  ds.surfaces.forEach((s, idx) => {
    const split = ds.leftNodes > 0 && ds.leftNodes < ds.n ? ds.leftNodes : ds.n;
    const l = fit(s.positions, 0, split);
    const r = split < ds.n ? fit(s.positions, split, ds.n) : l;
    const cv = Math.max(l.cv, r.cv);
    if (cv < bestCv) {
      bestCv = cv;
      best = { surface: idx, centerL: l.center, centerR: r.center };
    }
  });
  return best;
}

/** Index of the first surface whose name contains one of the given fragments, else fallback. */
export function surfaceIndexByName(ds: GlyphDataset, fragments: string[], fallback = 0): number {
  for (const f of fragments) {
    const i = ds.surfaces.findIndex((s) => s.name.toLowerCase().includes(f));
    if (i >= 0) return i;
  }
  return Math.min(fallback, ds.surfaces.length - 1);
}

/** Centre and scale sulcal depth / curvature to roughly [-1, 1] for shading. */
export function normaliseSulc(data: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length || 1;
  let sd = 0;
  for (let i = 0; i < data.length; i++) sd += (data[i] - mean) ** 2;
  sd = Math.sqrt(sd / (data.length || 1)) || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = (data[i] - mean) / (2 * sd);
  return out;
}

/** Reject structurally invalid datasets before they reach the GPU (bad indices would read out of bounds). */
export function validateDataset(ds: GlyphDataset): void {
  const n = ds.n;
  if (!Number.isInteger(n) || n < 3) throw new Error(`dataset has ${n} nodes`);
  if (!ds.surfaces.length) throw new Error("dataset has no surface");
  for (const s of ds.surfaces) {
    if (s.positions.length !== 3 * n) throw new Error(`surface "${s.name}" has ${s.positions.length / 3} nodes, expected ${n}`);
    for (let i = 0; i < s.positions.length; i++) {
      if (!Number.isFinite(s.positions[i])) throw new Error(`surface "${s.name}" contains a non-finite coordinate`);
    }
  }
  if (ds.triangles.length % 3 !== 0) throw new Error("triangle list length is not a multiple of 3");
  for (let t = 0; t < ds.triangles.length; t++) {
    if (ds.triangles[t] >= n) throw new Error(`triangle ${Math.floor(t / 3)} refers to node ${ds.triangles[t]}, but there are only ${n} nodes`);
  }
  if (ds.mask.length !== n) throw new Error(`mask has ${ds.mask.length} entries, expected ${n}`);
  if (ds.conn.n !== n) throw new Error(`connectivity matrix is ${ds.conn.n} x ${ds.conn.n}, expected ${n} x ${n}`);
  if (ds.leftNodes < 0 || ds.leftNodes > n || ds.leftTriangles < 0 || ds.leftTriangles * 3 > ds.triangles.length) {
    throw new Error("hemisphere split is outside the mesh");
  }
  for (const o of ds.overlays) if (o.data.length !== n) throw new Error(`overlay "${o.name}" has ${o.data.length} values, expected ${n}`);
}
