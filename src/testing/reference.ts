/**
 * Slow, obviously-correct reference implementations that the tests compare
 * the application code against. Nothing here imports the code under test
 * (apart from types), and everything is written as plain double loops over
 * the float values.
 */
import type { ConnMatrix } from "../data/connMatrix";
import type { GlyphDataset } from "../data/dataset";

export type Sign = 0 | 1 | 2;

/** The thresholding rule of the shaders (common.glsl, passes()). */
export function passesStrict(value: number, threshold: number, maxThreshold: number, sign: Sign): boolean {
  if (sign !== 1 && value > threshold && value <= maxThreshold) return true;
  if (sign !== 0 && value < -threshold && value >= -maxThreshold) return true;
  return false;
}

export interface RefFilter {
  glyphNodes: Uint8Array;
  targets?: Uint8Array | null;
  sign: Sign;
  threshold: number;
  maxThreshold: number;
  /** connexels not longer than this (in `lengthPos`) are dropped */
  minLength?: number;
  lengthPos?: Float32Array;
}

export interface RefConnexel {
  i: number;
  j: number;
  raw: number;
  value: number;
}

export function distance(pos: ArrayLike<number>, i: number, j: number): number {
  return Math.hypot(pos[3 * j] - pos[3 * i], pos[3 * j + 1] - pos[3 * i + 1], pos[3 * j + 2] - pos[3 * i + 2]);
}

/** Every connexel i -> j (row order) that is drawn: glyph node, target, strict threshold, sign, minimum length, never the diagonal. */
export function refConnexels(conn: ConnMatrix, f: RefFilter): RefConnexel[] {
  const out: RefConnexel[] = [];
  for (let i = 0; i < conn.n; i++) {
    if (!f.glyphNodes[i]) continue;
    for (let j = 0; j < conn.n; j++) {
      if (j === i || (f.targets && !f.targets[j])) continue;
      const raw = conn.data[i * conn.n + j];
      const value = raw * conn.scale;
      if (!passesStrict(value, f.threshold, f.maxThreshold, f.sign)) continue;
      if (f.minLength && f.minLength > 0 && f.lengthPos && !(distance(f.lengthPos, i, j) > f.minLength)) continue;
      out.push({ i, j, raw, value });
    }
  }
  return out;
}

/**
 * What buildConnexels may hold: the strict set plus values within one
 * quantisation step of the thresholds (the builder works on int16 and is
 * allowed to be conservative; the shader applies the exact test).
 */
export function refBuildSet(conn: ConnMatrix, f: RefFilter): RefConnexel[] {
  const lo = Math.max(1, Math.floor(f.threshold / conn.scale));
  const hi = Math.ceil(f.maxThreshold / conn.scale);
  const out: RefConnexel[] = [];
  for (let i = 0; i < conn.n; i++) {
    if (!f.glyphNodes[i]) continue;
    for (let j = 0; j < conn.n; j++) {
      if (j === i || (f.targets && !f.targets[j])) continue;
      const raw = conn.data[i * conn.n + j];
      const a = Math.abs(raw);
      if (a < lo || a > hi) continue;
      if (raw > 0 ? f.sign === 1 : f.sign === 0) continue;
      out.push({ i, j, raw, value: raw * conn.scale });
    }
  }
  return out;
}

/** Glyph nodes as the workspace derives them: data mask, hemisphere selection (0 both, 1 left, 2 right), optional ROI. */
export function glyphNodesFor(ds: GlyphDataset, hemi: 0 | 1 | 2 = 0, roi: Uint8Array | null = null): Uint8Array {
  const split = ds.leftNodes > 0 && ds.leftNodes < ds.n ? ds.leftNodes : 0;
  const out = new Uint8Array(ds.n);
  for (let i = 0; i < ds.n; i++) {
    if (!ds.mask[i]) continue;
    if (split && ((hemi === 1 && i >= split) || (hemi === 2 && i < split))) continue;
    if (roi && !roi[i]) continue;
    out[i] = 1;
  }
  return out;
}

/** HSV hue in [0, 1), -1 for greys (textbook formula with atan-free sextants). */
export function hsvHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 1e-9) return -1;
  const d = max - min;
  let deg: number;
  if (max === r) deg = 60 * ((g - b) / d);
  else if (max === g) deg = 60 * ((b - r) / d) + 120;
  else deg = 60 * ((r - g) / d) + 240;
  if (deg < 0) deg += 360;
  return deg / 360;
}

/** |normalised difference| of two nodes in a surface: the DTI-style orientation colour, components in 0..1. */
export function orientation(pos: ArrayLike<number>, i: number, j: number): [number, number, number] {
  const dx = pos[3 * j] - pos[3 * i], dy = pos[3 * j + 1] - pos[3 * i + 1], dz = pos[3 * j + 2] - pos[3 * i + 2];
  const l = Math.hypot(dx, dy, dz) || 1;
  return [Math.abs(dx) / l, Math.abs(dy) / l, Math.abs(dz) / l];
}

/** Area-weighted unit vertex normals in double precision. */
export function refNormals(positions: ArrayLike<number>, triangles: ArrayLike<number>): Float64Array {
  const out = new Float64Array(positions.length);
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const u = [0, 1, 2].map((k) => positions[3 * b + k] - positions[3 * a + k]);
    const v = [0, 1, 2].map((k) => positions[3 * c + k] - positions[3 * a + k]);
    const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const p of [a, b, c]) for (let k = 0; k < 3; k++) out[3 * p + k] += nrm[k];
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
  }
  return out;
}

export type V3 = [number, number, number];
export const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const norm = (a: ArrayLike<number>): number => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: ArrayLike<number>): V3 => { const l = norm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const at = (pos: ArrayLike<number>, i: number): V3 => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];

/**
 * Tangent frame used for flat glyphs in a 3-D export: up = superior (+z)
 * projected into the tangent plane (anterior, +y, at the poles), right = up x normal.
 */
export function tangentFrame(normal: ArrayLike<number>): { right: V3; up: V3 } {
  const n = unit(normal);
  let up: V3 = [-n[0] * n[2], -n[1] * n[2], 1 - n[2] * n[2]];
  if (norm(up) < 1e-4) up = [-n[0] * n[1], 1 - n[1] * n[1], -n[2] * n[1]];
  up = unit(up);
  return { right: cross(up, n), up };
}

/** Rotation matrix Rx(ax) * Ry(ay) * Rz(az), angles in degrees, applied to a column vector. */
export function rotXYZ(ax: number, ay: number, az: number, v: ArrayLike<number>): V3 {
  const r = (d: number) => (d * Math.PI) / 180;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(r(ax)), Math.sin(r(ax)), Math.cos(r(ay)), Math.sin(r(ay)), Math.cos(r(az)), Math.sin(r(az))];
  const z1: V3 = [cz * v[0] - sz * v[1], sz * v[0] + cz * v[1], v[2]];
  const y1: V3 = [cy * z1[0] + sy * z1[2], z1[1], -sy * z1[0] + cy * z1[2]];
  return [y1[0], cx * y1[1] - sx * y1[2], sx * y1[1] + cx * y1[2]];
}

/** Rotate a vector by a quaternion given as [x, y, z, w]. */
export function quatRotate(q: ArrayLike<number>, v: ArrayLike<number>): V3 {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  const t = cross([x, y, z], v).map((c) => 2 * c);
  const u = cross([x, y, z], t);
  return [v[0] + w * t[0] + u[0], v[1] + w * t[1] + u[1], v[2] + w * t[2] + u[2]];
}

/** Colour of a 256-entry RGBA lookup table at a value mapped linearly from [lo, hi]. */
export function lutColor(lut: Uint8Array, value: number, lo: number, hi: number): [number, number, number] {
  const t = Math.round(255 * Math.min(1, Math.max(0, (value - lo) / (hi - lo || 1))));
  return [lut[4 * t], lut[4 * t + 1], lut[4 * t + 2]];
}

/** Unique undirected edges "a-b" (a < b) of a triangle list. */
export function edgeSet(triangles: ArrayLike<number>): Set<string> {
  const s = new Set<string>();
  for (let t = 0; t < triangles.length; t += 3) {
    for (const [a, b] of [[triangles[t], triangles[t + 1]], [triangles[t + 1], triangles[t + 2]], [triangles[t + 2], triangles[t]]]) {
      s.add(a < b ? `${a}-${b}` : `${b}-${a}`);
    }
  }
  return s;
}

/** Triangles as sorted strings with the smallest index first but the cyclic order (winding) kept. */
export function canonicalTriangles(triangles: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const m = Math.min(a, b, c);
    out.push(m === a ? `${a},${b},${c}` : m === b ? `${b},${c},${a}` : `${c},${a},${b}`);
  }
  return out.sort();
}

/** Six times the signed volume enclosed by a triangle range (positive when wound outward). */
export function signedVolume6(positions: ArrayLike<number>, triangles: ArrayLike<number>, from = 0, to = triangles.length): number {
  let vol = 0;
  for (let t = from; t < to; t += 3) vol += dot(at(positions, triangles[t]), cross(at(positions, triangles[t + 1]), at(positions, triangles[t + 2])));
  return vol;
}
