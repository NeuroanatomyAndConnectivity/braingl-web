import type { MeshTopology } from "../data/dataset";

export interface PickHit {
  node: number;
  point: [number, number, number];
  distance: number;
}

/**
 * Nearest intersection of a ray with the mesh, returning the closest vertex of
 * the hit triangle. Brute force Moeller-Trumbore: a few hundred thousand
 * triangles per pick is far below a frame.
 */
export function pickNode(
  positions: Float32Array, triangles: Uint32Array, first: number, count: number,
  origin: ArrayLike<number>, dir: ArrayLike<number>,
): PickHit | null {
  const ox = origin[0], oy = origin[1], oz = origin[2];
  const dx = dir[0], dy = dir[1], dz = dir[2];
  let best = Infinity, bt = -1, bu = 0, bv = 0;
  for (let t = first; t < first + count; t += 3) {
    const a = 3 * triangles[t], b = 3 * triangles[t + 1], c = 3 * triangles[t + 2];
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const e1x = positions[b] - ax, e1y = positions[b + 1] - ay, e1z = positions[b + 2] - az;
    const e2x = positions[c] - ax, e2y = positions[c + 1] - ay, e2z = positions[c + 2] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (d > 0 && d < best) { best = d; bt = t; bu = u; bv = v; }
  }
  if (bt < 0) return null;
  const w = 1 - bu - bv;
  const node = w >= bu && w >= bv ? triangles[bt] : bu >= bv ? triangles[bt + 1] : triangles[bt + 2];
  return { node, point: [ox + dx * best, oy + dy * best, oz + dz * best], distance: best };
}

/**
 * Nodes within `radius` of the hit node, grown along the mesh so that the brush
 * does not jump across a sulcus or to the other hemisphere.
 */
export function brushNodes(topo: MeshTopology, positions: Float32Array, start: number, radius: number): number[] {
  const r2 = radius * radius;
  const sx = positions[3 * start], sy = positions[3 * start + 1], sz = positions[3 * start + 2];
  const seen = new Set<number>([start]);
  const out = [start];
  for (let q = 0; q < out.length; q++) {
    const a = out[q];
    for (let p = topo.adjStart[a]; p < topo.adjStart[a + 1]; p++) {
      const b = topo.adj[p];
      if (seen.has(b)) continue;
      seen.add(b);
      const dx = positions[3 * b] - sx, dy = positions[3 * b + 1] - sy, dz = positions[3 * b + 2] - sz;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(b);
    }
  }
  return out;
}

export function meanEdgeLength(positions: Float32Array, edges: Uint32Array): number {
  let sum = 0;
  const m = edges.length / 2;
  const step = Math.max(1, Math.floor(m / 20000));
  let cnt = 0;
  for (let e = 0; e < m; e += step) {
    const a = 3 * edges[2 * e], b = 3 * edges[2 * e + 1];
    sum += Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
    cnt++;
  }
  return cnt ? sum / cnt : 1;
}
