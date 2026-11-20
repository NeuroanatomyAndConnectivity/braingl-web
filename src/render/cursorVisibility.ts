/**
 * Whether the selection cross-hair of a node can be seen in a view.
 *
 * The cross-hair is a screen-sized sprite drawn on top of everything, so it is not depth tested
 * (a depth-tested sprite has the depth of its centre in every pixel and would be cut by the
 * surrounding surface). Instead the node itself is tested on the CPU, exactly and without flicker:
 *
 * - a node of a hemisphere that is switched off is never shown;
 * - through a transparent (or hidden) surface every node is shown;
 * - otherwise the node is hidden when its surface normal faces away from the viewer, or when any
 *   triangle of the displayed hemispheres lies between it and the viewer (the other hemisphere, or
 *   an overhanging fold). The camera is orthographic, so that is a ray from the node along the
 *   viewing direction. One brute-force any-hit test per view and frame costs about 2 ms at the
 *   viewer's limit of 65,535 nodes (130,000 triangles) and a few hundredths of that on fsaverage4.
 */

import { hemisphereTriangles } from "../data/dataset";

export interface CursorMesh {
  /** displayed surface, xyz per vertex */
  positions: Float32Array;
  /** unit vertex normals of that surface (outward) */
  normals: Float32Array;
  triangles: Uint32Array;
  /** number of nodes of the left hemisphere (left first); 0 when there is no split */
  leftNodes: number;
  /** number of triangles of the left hemisphere; 0 when there is no split */
  leftTriangles: number;
}

/**
 * True when a triangle of `triangles[first .. first + count)` that does not contain `skipNode` is
 * hit by the ray `origin + t * dir` at some t > tMin.
 */
export function rayHitsMesh(
  positions: Float32Array, triangles: Uint32Array, first: number, count: number,
  origin: ArrayLike<number>, dir: ArrayLike<number>, skipNode: number, tMin: number,
): boolean {
  const ox = origin[0], oy = origin[1], oz = origin[2];
  const dx = dir[0], dy = dir[1], dz = dir[2];
  for (let t = first; t < first + count; t += 3) {
    const ia = triangles[t], ib = triangles[t + 1], ic = triangles[t + 2];
    if (ia === skipNode || ib === skipNode || ic === skipNode) continue;
    const a = 3 * ia, b = 3 * ib, c = 3 * ic;
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
    if ((e2x * qx + e2y * qy + e2z * qz) * inv > tMin) return true;
  }
  return false;
}

/**
 * Whether the cross-hair of `node` is to be drawn.
 *
 * @param toward unit vector from the scene toward the viewer (orthographic camera), world space
 * @param opaque the surface is drawn and fully opaque
 */
export function cursorVisible(mesh: CursorMesh, node: number, hemi: 0 | 1 | 2, toward: ArrayLike<number>, opaque: boolean): boolean {
  const n = mesh.positions.length / 3;
  if (!(node >= 0 && node < n)) return false;
  const split = mesh.leftNodes > 0 && mesh.leftNodes < n ? mesh.leftNodes : 0;
  if (split && ((hemi === 1 && node >= split) || (hemi === 2 && node < split))) return false;
  if (!opaque) return true;
  const nx = mesh.normals[3 * node], ny = mesh.normals[3 * node + 1], nz = mesh.normals[3 * node + 2];
  if (nx * toward[0] + ny * toward[1] + nz * toward[2] < 0) return false;
  const p = mesh.positions;
  const [first, count] = hemisphereTriangles(mesh, hemi);
  return !rayHitsMesh(p, mesh.triangles, first, count, [p[3 * node], p[3 * node + 1], p[3 * node + 2]], toward, node, 1e-4);
}
