/**
 * Deterministic synthetic example datasets for the test suites. Everything is
 * generated in code (no files, no Math.random), so every run sees exactly the
 * same numbers.
 *
 *   icoBrain(level)        two mirrored icosphere hemispheres, three surfaces, sulc overlay,
 *                          block-structured correlation matrix with known network modules
 *   singleHemisphere(level) one hemisphere, no sphere surface, no overlays
 *   withMedialWall(ds)     zeroes the rows / columns of a medial patch and clears its mask
 *   anticorrelated(ds)     between-module blocks become negative
 *   weighted(ds)           non-correlation weights with maxAbs = 5 and a zero diagonal
 *   directed(ds)           asymmetric variant (to catch row / column mix-ups in loaders)
 *
 * The serialisers that write a fixture into every on-disk layout are in
 * ./serialise.ts, brute-force reference implementations in ./reference.ts.
 */
import { ConnMatrix } from "../data/connMatrix";
import type { GlyphDataset } from "../data/dataset";

/** A dataset plus the ground truth it was generated from. */
export interface FixtureDataset extends GlyphDataset {
  /** the float matrix that `conn` was quantised from, row-major n * n */
  values: Float32Array;
  /** network module (0..7) of every node; homotopic nodes share their module */
  modules: Uint8Array;
  /** unit-sphere direction of every node in left-hemisphere coordinates (lateral = -x, medial = +x) */
  unit: Float64Array;
  /** nodes per hemisphere */
  hemiNodes: number;
}

/** Seeded linear congruential generator (Numerical Recipes constants); returns values in [0, 1). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface UnitMesh {
  /** unit vectors, xyz per vertex */
  unit: Float64Array;
  /** outward-wound (counter-clockwise seen from outside) */
  triangles: Uint32Array;
}

/** Number of vertices of an icosphere after `level` subdivisions: 12, 42, 162, 642, ... */
export function icosphereVertexCount(level: number): number {
  return 10 * 4 ** level + 2;
}

/**
 * Icosphere by midpoint subdivision. The whole sphere is rotated by a fixed
 * amount so that no vertex lies on a coordinate plane (which keeps the octant
 * modules and the medial-wall patch unambiguous).
 */
export function icosphere(level: number): UnitMesh {
  if (!Number.isInteger(level) || level < 0 || level > 5) throw new Error(`icosphere: level ${level} is out of range 0..5`);
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const norm = (v: number[]): number[] => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  verts = verts.map(norm);
  for (let l = 0; l < level; l++) {
    const cache = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * 1048576 + b : b * 1048576 + a;
      let m = cache.get(key);
      if (m === undefined) {
        m = verts.length;
        verts.push(norm([verts[a][0] + verts[b][0], verts[a][1] + verts[b][1], verts[a][2] + verts[b][2]]));
        cache.set(key, m);
      }
      return m;
    };
    const next: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  // fixed rotation: Rz(0.37) * Ry(0.23) * Rx(0.11)
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(0.11), Math.sin(0.11), Math.cos(0.23), Math.sin(0.23), Math.cos(0.37), Math.sin(0.37)];
  const unit = new Float64Array(3 * verts.length);
  verts.forEach((v, i) => {
    const y1 = cx * v[1] - sx * v[2], z1 = sx * v[1] + cx * v[2];
    const x2 = cy * v[0] + sy * z1, z2 = -sy * v[0] + cy * z1;
    const x3 = cz * x2 - sz * y1, y3 = sz * x2 + cz * y1;
    const l = Math.hypot(x3, y3, z2);
    unit[3 * i] = x3 / l; unit[3 * i + 1] = y3 / l; unit[3 * i + 2] = z2 / l;
  });
  const triangles = new Uint32Array(3 * faces.length);
  faces.forEach(([a, b, c], f) => {
    // make every triangle counter-clockwise seen from outside
    const ux = unit[3 * b] - unit[3 * a], uy = unit[3 * b + 1] - unit[3 * a + 1], uz = unit[3 * b + 2] - unit[3 * a + 2];
    const vx = unit[3 * c] - unit[3 * a], vy = unit[3 * c + 1] - unit[3 * a + 1], vz = unit[3 * c + 2] - unit[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const out = nx * unit[3 * a] + ny * unit[3 * a + 1] + nz * unit[3 * a + 2] > 0;
    triangles[3 * f] = a; triangles[3 * f + 1] = out ? b : c; triangles[3 * f + 2] = out ? c : b;
  });
  return { unit, triangles };
}

// ----------------------------------------------------------------- geometry

/** Geometry of the left hemisphere of the synthetic brain (the right one is its mirror image in x). */
export const BRAIN_SHAPE = {
  pialCenter: [-38, -18, 10] as const,
  pialAxes: [30, 68, 48] as const,
  inflatedCenter: [-48, -18, 10] as const,
  inflatedAxes: [36, 74, 54] as const,
  sphereCenter: [-105, 0, 0] as const,
  sphereRadius: 100,
  /** the folding function stays within 1 +- this amplitude */
  foldAmplitude: 0.16,
  /** nodes whose unit direction has x above this form the "medial wall" patch of withMedialWall() */
  medialX: 0.75,
};

/** Smooth radial perturbation that folds the "pial" surface: > 1 on gyri, < 1 in sulci. */
export function fold(ux: number, uy: number, uz: number): number {
  return 1 + 0.1 * Math.sin(3 * Math.PI * ux + 1) * Math.cos(2 * Math.PI * uy) + 0.06 * Math.sin(5 * Math.PI * uz + 0.5);
}

/** Octant of a unit direction, 0..7. */
export function octant(ux: number, uy: number, uz: number): number {
  return (ux > 0 ? 1 : 0) | (uy > 0 ? 2 : 0) | (uz > 0 ? 4 : 0);
}

/** Expected mean correlation of the generated matrices. */
export const BLOCK_R = { within: 0.8, homotopic: 0.6, other: 0.1, noise: 0.05 };

interface HemisphereGeometry {
  pial: Float32Array;
  inflated: Float32Array;
  sphere: Float32Array;
  sulc: Float32Array;
}

function leftHemisphere(mesh: UnitMesh): HemisphereGeometry {
  const m = mesh.unit.length / 3;
  const S = BRAIN_SHAPE;
  const pial = new Float32Array(3 * m), inflated = new Float32Array(3 * m), sphere = new Float32Array(3 * m), sulc = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const u = [mesh.unit[3 * i], mesh.unit[3 * i + 1], mesh.unit[3 * i + 2]];
    const f = fold(u[0], u[1], u[2]);
    for (let k = 0; k < 3; k++) {
      pial[3 * i + k] = S.pialCenter[k] + S.pialAxes[k] * u[k] * f;
      inflated[3 * i + k] = S.inflatedCenter[k] + S.inflatedAxes[k] * u[k];
      sphere[3 * i + k] = S.sphereCenter[k] + S.sphereRadius * u[k];
    }
    sulc[i] = -(f - 1) / S.foldAmplitude; // positive in sulci, as FreeSurfer's sulc
  }
  return { pial, inflated, sphere, sulc };
}

function mirrorX(positions: Float32Array): Float32Array {
  const out = Float32Array.from(positions);
  for (let i = 0; i < out.length; i += 3) out[i] = -out[i];
  return out;
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Block-structured symmetric correlation matrix: within a module (same
 * hemisphere) r = 0.8, homotopic module (other hemisphere) r = 0.6, everything
 * else r = 0.1, each +- 0.05 of deterministic noise; the diagonal is 1.
 */
function blockMatrix(modules: Uint8Array, hemiNodes: number, seed: number): Float32Array {
  const n = modules.length;
  const values = new Float32Array(n * n);
  const rnd = lcg(seed);
  for (let i = 0; i < n; i++) {
    values[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      const sameHemi = Math.floor(i / hemiNodes) === Math.floor(j / hemiNodes);
      const base = modules[i] !== modules[j] ? BLOCK_R.other : sameHemi ? BLOCK_R.within : BLOCK_R.homotopic;
      const v = base + (2 * rnd() - 1) * BLOCK_R.noise;
      values[i * n + j] = v;
      values[j * n + i] = v;
    }
  }
  return values;
}

/**
 * Two icosphere hemispheres (level 1 / 2 / 3 -> 42 / 162 / 642 nodes each)
 * with "pial" (folded), "inflated" (ellipsoid) and "sphere" surfaces, a "sulc"
 * overlay and a module-structured correlation matrix. Node i of the left
 * hemisphere and node i + hemiNodes of the right one are mirror images.
 */
export function icoBrain(level: number): FixtureDataset {
  const mesh = icosphere(level);
  const m = mesh.unit.length / 3;
  const nt = mesh.triangles.length / 3;
  const left = leftHemisphere(mesh);
  const triangles = new Uint32Array(6 * nt);
  triangles.set(mesh.triangles);
  for (let t = 0; t < nt; t++) {
    // mirroring reverses the orientation, so swap two corners to stay outward-wound
    triangles[3 * (nt + t)] = mesh.triangles[3 * t] + m;
    triangles[3 * (nt + t) + 1] = mesh.triangles[3 * t + 2] + m;
    triangles[3 * (nt + t) + 2] = mesh.triangles[3 * t + 1] + m;
  }
  const modules = new Uint8Array(2 * m);
  const unit = new Float64Array(6 * m);
  unit.set(mesh.unit);
  unit.set(mesh.unit, 3 * m);
  for (let i = 0; i < m; i++) modules[i] = modules[i + m] = octant(mesh.unit[3 * i], mesh.unit[3 * i + 1], mesh.unit[3 * i + 2]);
  const values = blockMatrix(modules, m, 1000 + level);
  return {
    name: `icoBrain(${level})`,
    description: `synthetic brain, 2 x ${m} nodes`,
    n: 2 * m,
    triangles,
    leftNodes: m,
    leftTriangles: nt,
    surfaces: [
      { name: "pial", positions: concat(left.pial, mirrorX(left.pial)) },
      { name: "inflated", positions: concat(left.inflated, mirrorX(left.inflated)) },
      { name: "sphere", positions: concat(left.sphere, mirrorX(left.sphere)) },
    ],
    overlays: [{ name: "sulc", data: concat(left.sulc, left.sulc) }],
    mask: new Uint8Array(2 * m).fill(1),
    conn: ConnMatrix.fromFull(values, 2 * m),
    values, modules, unit, hemiNodes: m,
  };
}

/** One hemisphere only: leftNodes = 0, no overlays and no sphere surface (so no polar projection). */
export function singleHemisphere(level: number): FixtureDataset {
  const mesh = icosphere(level);
  const m = mesh.unit.length / 3;
  const left = leftHemisphere(mesh);
  const modules = new Uint8Array(m);
  for (let i = 0; i < m; i++) modules[i] = octant(mesh.unit[3 * i], mesh.unit[3 * i + 1], mesh.unit[3 * i + 2]);
  const values = blockMatrix(modules, m, 2000 + level);
  return {
    name: `singleHemisphere(${level})`,
    description: `synthetic hemisphere, ${m} nodes`,
    n: m,
    triangles: Uint32Array.from(mesh.triangles),
    leftNodes: 0,
    leftTriangles: 0,
    surfaces: [{ name: "pial", positions: left.pial }, { name: "inflated", positions: left.inflated }],
    overlays: [],
    mask: new Uint8Array(m).fill(1),
    conn: ConnMatrix.fromFull(values, m),
    values, modules, unit: Float64Array.from(mesh.unit), hemiNodes: m,
  };
}

function derive(ds: FixtureDataset, suffix: string, values: Float32Array, mask: Uint8Array = ds.mask): FixtureDataset {
  return {
    ...ds,
    name: `${ds.name}+${suffix}`,
    triangles: Uint32Array.from(ds.triangles),
    surfaces: ds.surfaces.map((s) => ({ name: s.name, positions: Float32Array.from(s.positions) })),
    overlays: ds.overlays.map((o) => ({ name: o.name, data: Float32Array.from(o.data) })),
    mask: Uint8Array.from(mask),
    conn: ConnMatrix.fromFull(values, ds.n),
    values,
  };
}

/** Nodes of the medial patch that withMedialWall() removes. */
export function medialWallNodes(ds: FixtureDataset): number[] {
  const out: number[] = [];
  for (let i = 0; i < ds.n; i++) if (ds.unit[3 * i] > BRAIN_SHAPE.medialX) out.push(i);
  return out;
}

/** Zero the rows and columns (diagonal included) of the medial patch and clear its mask. */
export function withMedialWall(ds: FixtureDataset): FixtureDataset {
  const n = ds.n;
  const values = Float32Array.from(ds.values);
  const mask = Uint8Array.from(ds.mask);
  for (const i of medialWallNodes(ds)) {
    mask[i] = 0;
    for (let j = 0; j < n; j++) { values[i * n + j] = 0; values[j * n + i] = 0; }
  }
  return derive(ds, "medialWall", values, mask);
}

/**
 * Between-module blocks become negative: about -0.5 between antipodal modules
 * (octants m and 7 - m), about -0.1 between the others. Zeros stay zero.
 */
export function anticorrelated(ds: FixtureDataset): FixtureDataset {
  const n = ds.n;
  const values = Float32Array.from(ds.values);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = values[i * n + j];
      if (i === j || v === 0 || ds.modules[i] === ds.modules[j]) continue;
      values[i * n + j] = (ds.modules[i] ^ ds.modules[j]) === 7 ? -(v + 0.4) : -v;
    }
  }
  return derive(ds, "anticorrelated", values);
}

/** Non-correlation weights: zero diagonal, off-diagonal values rescaled so that the largest |weight| is exactly 5. */
export function weighted(ds: FixtureDataset): FixtureDataset {
  const n = ds.n;
  const values = Float32Array.from(ds.values);
  let maxOff = 0;
  for (let i = 0; i < n; i++) {
    values[i * n + i] = 0;
    for (let j = 0; j < n; j++) if (j !== i) maxOff = Math.max(maxOff, Math.abs(values[i * n + j]));
  }
  const k = 5 / (maxOff || 1);
  for (let q = 0; q < values.length; q++) values[q] *= k;
  // float32 rounding of the product may land a hair off 5; pin the largest entries
  for (let q = 0; q < values.length; q++) if (Math.abs(values[q]) > 5) values[q] = Math.sign(values[q]) * 5;
  return derive(ds, "weighted", values);
}

/** Asymmetric ("directed") variant: the lower triangle is halved, so M[i][j] != M[j][i]. */
export function directed(ds: FixtureDataset): FixtureDataset {
  const n = ds.n;
  const values = Float32Array.from(ds.values);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) values[i * n + j] *= 0.5;
  return derive(ds, "directed", values);
}

// ------------------------------------------------------------------ catalogue

export interface FixtureCase {
  name: string;
  make: () => FixtureDataset;
}

function memo(name: string, make: () => FixtureDataset): FixtureCase {
  let cached: FixtureDataset | null = null;
  return { name, make: () => (cached ??= make()) };
}

/** Small and medium example datasets: cheap enough for brute-force comparisons over many parameter combinations. */
export const FIXTURES: FixtureCase[] = [
  memo("icoBrain(1)", () => icoBrain(1)),
  memo("icoBrain(2)", () => icoBrain(2)),
  memo("singleHemisphere(2)", () => singleHemisphere(2)),
  memo("icoBrain(2)+medialWall", () => withMedialWall(icoBrain(2))),
  memo("icoBrain(1)+anticorrelated", () => anticorrelated(icoBrain(1))),
  memo("icoBrain(2)+medialWall+anticorrelated", () => anticorrelated(withMedialWall(icoBrain(2)))),
  memo("icoBrain(1)+weighted", () => weighted(icoBrain(1))),
  memo("singleHemisphere(1)+medialWall+anticorrelated+weighted", () => weighted(anticorrelated(withMedialWall(singleHemisphere(1))))),
];

/** The largest synthetic dataset (2 x 642 nodes), for the tests that can afford it. */
export const LARGE_FIXTURE: FixtureCase = memo("icoBrain(3)", () => icoBrain(3));

/** FIXTURES plus the large one. */
export const ALL_FIXTURES: FixtureCase[] = [...FIXTURES, LARGE_FIXTURE];
