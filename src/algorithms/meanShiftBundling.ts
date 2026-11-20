/**
 * Three-dimensional mean-shift edge bundling.
 *
 * TypeScript port of the bundler of Böttger et al., "Three-dimensional mean-shift edge
 * bundling for the visualization of functional connectivity in the brain", IEEE TVCG 20(3),
 * 2014, as implemented in brainGL (src/algos/connections.cpp, edge.cpp, attractthread.cpp,
 * compatibilitiesthread.cpp) and in the stand-alone "brainbundler" command-line tool.
 *
 * The port follows the brainGL code, not the prose of the paper, wherever the two differ.
 * The places where the code is not what one would expect from the paper are marked "QUIRK".
 *
 * Pure and dependency-free (no DOM), so it runs unchanged in a Web Worker or in node.
 */

export interface BundlingOptions {
  /** c_thr: two edges attract each other if their compatibility is strictly greater. Default 0.8. */
  compatibilityThreshold: number;
  /** Standard deviation ("bell") of the Gaussian mean-shift kernel, in mm. Default 5. */
  bell: number;
  /** Number of mean-shift iterations in the first cycle; each later cycle runs one fewer. Default 10. */
  startIterations: number;
  /** Number of subdivide-and-attract cycles. Default 10. */
  numCycles: number;
  /** "smooth": extra re-subdivision steps without attraction (see QUIRK in bundleEdges). Default 3. */
  smoothSteps: number;
}

export const defaultBundlingOptions: BundlingOptions = {
  compatibilityThreshold: 0.8,
  bell: 5,
  startIterations: 10,
  numCycles: 10,
  smoothSteps: 3,
};

export interface Polylines {
  /** xyz of every polyline point, concatenated. */
  points: Float32Array;
  /** Length nLines + 1; line k uses points[3*offsets[k] .. 3*offsets[k+1]). */
  offsets: Uint32Array;
  /** One value per line (copied from the input). */
  values: Float32Array;
}

/**
 * Sparse compatibility relation in CSR form.
 *
 * Only the upper triangle is stored: row i lists the edges j > i that are compatible with
 * edge i. The relation is symmetric, and every edge is compatible with itself (implicit).
 */
export interface CompatibilityGraph {
  /** Length nEdges + 1; row i is neighbours[offsets[i] .. offsets[i+1]), ascending. */
  offsets: Uint32Array;
  /** Edge indices j > i. */
  neighbours: Uint32Array;
  /** Parallel to `neighbours`: 1 if edge j runs opposite to edge i and is traversed backwards. */
  reversed: Uint8Array;
}

/** Subdivision points are multiplied by this factor between cycles (connections.cpp:285). */
const SUBDIVISION_GROWTH = 1.3;
/** The visibility term is only evaluated above this product (compatibilitiesthread.cpp:66). */
const VISIBILITY_GATE = 0.9;
/** Share of the progress range spent on the O(n^2) compatibility pass. */
const PRECOMPUTE_PROGRESS = 0.3;

// ---------------------------------------------------------------------------------------
// Per-edge records: from(3) to(3) length(1) midpoint(3), all in double precision.
// ---------------------------------------------------------------------------------------

const STRIDE = 10;
const LEN = 6;
const MID = 7;

function prepareEdges(edges: ArrayLike<number>, n: number): Float64Array {
  const E = new Float64Array(n * STRIDE);
  for (let i = 0; i < n; i++) {
    const s = i * 6;
    const o = i * STRIDE;
    const fx = edges[s];
    const fy = edges[s + 1];
    const fz = edges[s + 2];
    const tx = edges[s + 3];
    const ty = edges[s + 4];
    const tz = edges[s + 5];
    E[o] = fx;
    E[o + 1] = fy;
    E[o + 2] = fz;
    E[o + 3] = tx;
    E[o + 4] = ty;
    E[o + 5] = tz;
    const dx = fx - tx;
    const dy = fy - ty;
    const dz = fz - tz;
    E[o + LEN] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    E[o + MID] = (fx + tx) / 2;
    E[o + MID + 1] = (fy + ty) / 2;
    E[o + MID + 2] = (fz + tz) / 2;
  }
  return E;
}

function dist(E: Float64Array, p: number, q: number): number {
  const dx = E[p] - E[q];
  const dy = E[p + 1] - E[q + 1];
  const dz = E[p + 2] - E[q + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Edge::flip (edge.cpp:83-94). True if the two edges point the same way, i.e. pairing
 * from-from / to-to is shorter than pairing from-to / to-from. (The C++ name is misleading:
 * `flip() == true` means "do not reverse".) A tie counts as opposite.
 */
function sameDirection(E: Float64Array, a: number, b: number): boolean {
  const ff = dist(E, a, b);
  const tt = dist(E, a + 3, b + 3);
  const ft = dist(E, a, b + 3);
  const tf = dist(E, a + 3, b);
  return ff + tt < ft + tf;
}

/** Cosine between the two edges after orienting them alike (compatibilitiesthread.cpp:48-57). */
function angleTerm(E: Float64Array, a: number, b: number, aligned: boolean): number {
  const dot =
    (E[a] - E[a + 3]) * (E[b] - E[b + 3]) +
    (E[a + 1] - E[a + 4]) * (E[b + 1] - E[b + 4]) +
    (E[a + 2] - E[a + 5]) * (E[b + 2] - E[b + 5]);
  return (aligned ? dot : -dot) / (E[a + LEN] * E[b + LEN]);
}

/** 2 / (lavg / min(li, lj) + max(li, lj) / lavg) (compatibilitiesthread.cpp:59-60). */
function scaleTerm(li: number, lj: number): number {
  const lavg = (li + lj) / 2;
  const lmin = li < lj ? li : lj;
  const lmax = li < lj ? lj : li;
  return 2 / (lavg / lmin + lmax / lavg);
}

/** lavg / (lavg + |mi - mj|) (compatibilitiesthread.cpp:62-64). */
function positionTerm(E: Float64Array, a: number, b: number): number {
  const lavg = (E[a + LEN] + E[b + LEN]) / 2;
  return lavg / (lavg + dist(E, a + MID, b + MID));
}

/**
 * vis_c(P, Q) (compatibilitiesthread.cpp:92-107): max(1 - 2 |Pm - Im| / |I0 - I1|, 0), where
 * I0, I1 are the projections of Q's end points onto the line through P, Im their midpoint and
 * Pm the midpoint of P. Written with the line parameters t0, t1 of I0, I1 (P.from = 0,
 * P.to = 1), for which |Pm - Im| = |P| |1 - t0 - t1| / 2 and |I0 - I1| = |P| |t0 - t1|.
 */
function visibilityOneWay(E: Float64Array, p: number, q: number): number {
  const ax = E[p];
  const ay = E[p + 1];
  const az = E[p + 2];
  const bx = E[p + 3] - ax;
  const by = E[p + 4] - ay;
  const bz = E[p + 5] - az;
  const b2 = bx * bx + by * by + bz * bz;
  const t0 = (bx * (E[q] - ax) + by * (E[q + 1] - ay) + bz * (E[q + 2] - az)) / b2;
  const t1 = (bx * (E[q + 3] - ax) + by * (E[q + 4] - ay) + bz * (E[q + 5] - az)) / b2;
  const v = 1 - Math.abs(1 - t0 - t1) / Math.abs(t0 - t1);
  return v > 0 ? v : 0; // also maps the degenerate 0/0 case to 0
}

function visibilityTerm(E: Float64Array, a: number, b: number): number {
  return Math.min(visibilityOneWay(E, a, b), visibilityOneWay(E, b, a));
}

/**
 * Exposed for tests: the four compatibility terms of two edges, each given as
 * [x1, y1, z1, x2, y2, z2], and the total used for thresholding.
 *
 * - angle: cos of the angle between the edges after orienting them alike. Not |cos|: it can be
 *   slightly negative for skewed edge pairs, which then simply never pass the threshold.
 * - scale: 2 / (lavg / lmin + lmax / lavg), lavg = (|P| + |Q|) / 2.
 * - position: lavg / (lavg + |Pm - Qm|).
 * - visibility: min(V(P, Q), V(Q, P)), V(P, Q) = max(1 - 2 |Pm - Im| / |I0 - I1|, 0).
 * - total: QUIRK, as in the reference: angle * scale * position * visibility only if
 *   angle * scale * position > 0.9, otherwise angle * scale * position *without* the
 *   visibility factor (the visibility term was evidently added as an afterthought, as a
 *   lazily evaluated refinement of highly compatible pairs).
 *
 * A zero-length edge gives NaN terms and is compatible with nothing but itself.
 */
export function edgeCompatibility(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): { angle: number; scale: number; position: number; visibility: number; total: number } {
  const both = new Float64Array(12);
  for (let k = 0; k < 6; k++) {
    both[k] = a[k];
    both[6 + k] = b[k];
  }
  const E = prepareEdges(both, 2);
  const angle = angleTerm(E, 0, STRIDE, sameDirection(E, 0, STRIDE)) + 0; // "+ 0" turns -0 into 0
  const scale = scaleTerm(E[LEN], E[STRIDE + LEN]);
  const position = positionTerm(E, 0, STRIDE);
  const visibility = visibilityTerm(E, 0, STRIDE);
  let total = angle * scale * position;
  if (total > VISIBILITY_GATE) total *= visibility;
  return { angle, scale, position, visibility, total };
}

/**
 * All pairs of edges whose compatibility exceeds `threshold`, as an upper-triangular CSR
 * graph. O(n^2) time, O(number of compatible pairs) memory.
 *
 * `tick(fraction)` is called a few hundred times with the fraction of pairs done.
 */
export function computeCompatibilityGraph(
  edges: ArrayLike<number>,
  threshold: number,
  tick?: (fraction: number) => void,
): CompatibilityGraph {
  const n = Math.floor(edges.length / 6);
  const E = prepareEdges(edges, n);
  return buildGraph(E, n, threshold, tick);
}

function buildGraph(
  E: Float64Array,
  n: number,
  threshold: number,
  tick?: (fraction: number) => void,
): CompatibilityGraph {
  const offsets = new Uint32Array(n + 1);
  let capacity = Math.max(1024, n * 8);
  let neighbours = new Uint32Array(capacity);
  let reversed = new Uint8Array(capacity);
  let count = 0;

  const totalPairs = (n * (n - 1)) / 2;
  const reportEvery = Math.max(1, totalPairs / 256);
  let pairsDone = 0;
  let nextReport = reportEvery;

  // |angle| <= 1 up to rounding, and the visibility factor is <= 1, so a pair whose
  // scale * position is already at or below the threshold can never pass it. This skips the
  // four square roots of the direction test for the vast majority of pairs.
  const bound = 1 + 1e-9;

  for (let i = 0; i < n; i++) {
    const a = i * STRIDE;
    const li = E[a + LEN];
    for (let j = i + 1; j < n; j++) {
      const b = j * STRIDE;
      const scale = scaleTerm(li, E[b + LEN]);
      const position = positionTerm(E, a, b);
      if (scale * position * bound <= threshold) continue;
      const aligned = sameDirection(E, a, b);
      let c = angleTerm(E, a, b, aligned) * scale * position;
      if (c > VISIBILITY_GATE) c *= visibilityTerm(E, a, b);
      if (c > threshold) {
        if (count === capacity) {
          capacity *= 2;
          const grownNeighbours = new Uint32Array(capacity);
          grownNeighbours.set(neighbours);
          neighbours = grownNeighbours;
          const grownReversed = new Uint8Array(capacity);
          grownReversed.set(reversed);
          reversed = grownReversed;
        }
        neighbours[count] = j;
        reversed[count] = aligned ? 0 : 1;
        count++;
      }
    }
    offsets[i + 1] = count;
    pairsDone += n - 1 - i;
    if (tick && totalPairs > 0 && (pairsDone >= nextReport || i === n - 1)) {
      tick(pairsDone / totalPairs);
      nextReport = pairsDone + reportEvery;
    }
  }
  return { offsets, neighbours: neighbours.slice(0, count), reversed: reversed.slice(0, count) };
}

// ---------------------------------------------------------------------------------------
// Subdivision and attraction on flat arrays. Every edge has the same number of points m;
// point k of edge e is at P[(e * m + k) * 3 ..].
// ---------------------------------------------------------------------------------------

/**
 * Edge::subdivide (edge.cpp:30-73): resample every polyline to `newp` interior points,
 * equally spaced along its current arc length. End points are copied unchanged.
 */
function subdivide(P: Float64Array, n: number, m: number, newp: number): Float64Array {
  const mNew = newp + 2;
  const out = new Float64Array(n * mNew * 3);
  const nSeg = m - 1;
  const segLen = new Float64Array(nSeg);
  for (let e = 0; e < n; e++) {
    const src = e * m * 3;
    const dst = e * mNew * 3;
    let polyLength = 0;
    for (let s = 0; s < nSeg; s++) {
      const p = src + s * 3;
      const dx = P[p + 3] - P[p];
      const dy = P[p + 4] - P[p + 1];
      const dz = P[p + 5] - P[p + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      segLen[s] = l;
      polyLength += l;
    }
    out[dst] = P[src];
    out[dst + 1] = P[src + 1];
    out[dst + 2] = P[src + 2];
    const newl = polyLength / (newp + 1);
    let seg = 0;
    let lengthSoFar = 0;
    for (let j = 0; j < newp; j++) {
      const target = newl * (j + 1);
      // The reference has no bound on seg here and relies on rounding going its way.
      while (seg < nSeg - 1 && segLen[seg] < target - lengthSoFar) {
        lengthSoFar += segLen[seg];
        seg++;
      }
      const l = segLen[seg];
      const t = l > 0 ? (target - lengthSoFar) / l : 0;
      const p = src + seg * 3;
      const o = dst + (j + 1) * 3;
      out[o] = P[p] + (P[p + 3] - P[p]) * t;
      out[o + 1] = P[p + 1] + (P[p + 4] - P[p + 1]) * t;
      out[o + 2] = P[p + 2] + (P[p + 5] - P[p + 2]) * t;
    }
    const last = src + (m - 1) * 3;
    const o = dst + (mNew - 1) * 3;
    out[o] = P[last];
    out[o + 1] = P[last + 1];
    out[o + 2] = P[last + 2];
  }
  return out;
}

/**
 * One mean-shift iteration (AttractThread::run, attractthread.cpp:28-65, followed by
 * Edge::applyForces): every interior point k of every edge e moves to
 *
 *   p' = sum_j w_j q_j / sum_j w_j,   w_j = exp(-|q_j - p|^2 / (2 bell^2)),
 *
 * where j runs over the edges compatible with e (including e itself) and q_j is point k of
 * edge j, or point m-1-k if j runs opposite to e. All new positions are computed from the
 * old ones (Jacobi update). End points do not move.
 *
 * Since the relation, the weights and the point correspondence are all symmetric, each
 * compatible pair is visited once and contributes to both of its edges. The contributions
 * reach every point in the same order as in the reference (ascending edge index), so the
 * result is the same as with the full double loop.
 */
function attract(
  P: Float64Array,
  n: number,
  m: number,
  graph: CompatibilityGraph,
  negInvTwoBellSq: number,
  acc: Float64Array,
  wsum: Float64Array,
): void {
  const { offsets, neighbours, reversed } = graph;
  const m3 = m * 3;
  const lastK = m - 1;
  acc.fill(0);
  wsum.fill(0);
  for (let i = 0; i < n; i++) {
    const pi = i * m3;
    const wi = i * m;
    // The edge itself: distance 0, weight 1.
    for (let k = 1; k < lastK; k++) {
      const p = pi + k * 3;
      acc[p] += P[p];
      acc[p + 1] += P[p + 1];
      acc[p + 2] += P[p + 2];
      wsum[wi + k] += 1;
    }
    const end = offsets[i + 1];
    for (let e = offsets[i]; e < end; e++) {
      const j = neighbours[e];
      const pj = j * m3;
      const wj = j * m;
      const rev = reversed[e] !== 0;
      for (let k = 1; k < lastK; k++) {
        const kj = rev ? lastK - k : k;
        const p = pi + k * 3;
        const q = pj + kj * 3;
        const px = P[p];
        const py = P[p + 1];
        const pz = P[p + 2];
        const qx = P[q];
        const qy = P[q + 1];
        const qz = P[q + 2];
        const dx = qx - px;
        const dy = qy - py;
        const dz = qz - pz;
        const w = Math.exp((dx * dx + dy * dy + dz * dz) * negInvTwoBellSq);
        acc[p] += w * qx;
        acc[p + 1] += w * qy;
        acc[p + 2] += w * qz;
        wsum[wi + k] += w;
        acc[q] += w * px;
        acc[q + 1] += w * py;
        acc[q + 2] += w * pz;
        wsum[wj + kj] += w;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const pi = i * m3;
    const wi = i * m;
    for (let k = 1; k < lastK; k++) {
      const p = pi + k * 3;
      const w = wsum[wi + k];
      P[p] = acc[p] / w;
      P[p + 1] = acc[p + 1] / w;
      P[p + 2] = acc[p + 2] / w;
    }
  }
}

function countOption(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`bundleEdges: ${name} must be a finite number`);
  return Math.max(0, Math.trunc(value));
}

/**
 * Bundle straight edges into polylines.
 *
 * Schedule, as in Connections::fullAttract (connections.cpp:276-308): with s = 1 and
 * it = startIterations, each of the numCycles cycles re-subdivides every edge to round(s)
 * interior points, runs `it` mean-shift iterations, then sets it = it - 1 and s = 1.3 s.
 * With the defaults that is 55 iterations on 1, 1, 2, 2, 3, 4, 5, 6, 8, 11 interior points.
 *
 * QUIRK: afterwards the reference loops `for (i = 1; i < smooth; i++) subdivide(round(s) + i)`,
 * so `smoothSteps` = 3 performs two (not three) re-subdivisions, ending at round(s) + 2
 * interior points (16 with the defaults, i.e. 18 points per line), and `smoothSteps` <= 1
 * leaves the result of the last cycle as it is. These are plain equidistant resamplings of
 * the bundled polyline; despite the name nothing is low-pass filtered.
 *
 * @param edges      length 6 n: x1 y1 z1 x2 y2 z2 per edge.
 * @param values     optional per-edge value, copied to the output (default 1, as in brainGL).
 * @param onProgress called at least once per iteration with a non-decreasing fraction in
 *                   [0, 1]; the compatibility pass takes the first 30 %. The last call is 1.
 * @param shouldCancel polled once per iteration (and regularly during the compatibility
 *                   pass); if it returns true, `Error("cancelled")` is thrown.
 */
export function bundleEdges(
  edges: Float32Array,
  values: Float32Array | null,
  opts?: Partial<BundlingOptions>,
  onProgress?: (fraction: number) => void,
  shouldCancel?: () => boolean,
): Polylines {
  if (edges.length % 6 !== 0) {
    throw new RangeError("bundleEdges: edges must hold 6 numbers per edge");
  }
  const n = edges.length / 6;
  if (values && values.length !== n) {
    throw new RangeError(`bundleEdges: expected ${n} values, got ${values.length}`);
  }
  const threshold = opts?.compatibilityThreshold ?? defaultBundlingOptions.compatibilityThreshold;
  const bell = opts?.bell ?? defaultBundlingOptions.bell;
  const startIterations = countOption(
    opts?.startIterations ?? defaultBundlingOptions.startIterations,
    "startIterations",
  );
  const numCycles = countOption(opts?.numCycles ?? defaultBundlingOptions.numCycles, "numCycles");
  const smoothSteps = countOption(
    opts?.smoothSteps ?? defaultBundlingOptions.smoothSteps,
    "smoothSteps",
  );
  if (Number.isNaN(threshold)) {
    throw new RangeError("bundleEdges: compatibilityThreshold must be a number");
  }
  if (!(bell > 0) || !Number.isFinite(bell)) {
    throw new RangeError("bundleEdges: bell must be a positive finite number");
  }

  let reported = 0;
  const report = (fraction: number): void => {
    if (fraction > 1) fraction = 1;
    if (fraction > reported) reported = fraction;
    onProgress?.(reported);
  };
  const checkCancel = (): void => {
    if (shouldCancel?.()) throw new Error("cancelled");
  };

  checkCancel();
  report(0);

  // Compatibility pass.
  const E = prepareEdges(edges, n);
  const graph = buildGraph(E, n, threshold, (fraction) => {
    checkCancel();
    report(PRECOMPUTE_PROGRESS * fraction);
  });
  report(PRECOMPUTE_PROGRESS);

  // Work estimate for the progress fraction: interior points moved per iteration.
  let totalWork = 0;
  {
    let s = 1;
    for (let cycle = 0; cycle < numCycles; cycle++) {
      totalWork += Math.max(0, startIterations - cycle) * Math.round(s);
      s *= SUBDIVISION_GROWTH;
    }
  }

  let m = 2;
  let P: Float64Array = new Float64Array(n * 6);
  P.set(edges);

  const negInvTwoBellSq = -1 / (2 * bell * bell);
  let spnow = 1;
  let workDone = 0;
  for (let cycle = 0; cycle < numCycles; cycle++) {
    const sps = Math.round(spnow);
    P = subdivide(P, n, m, sps);
    m = sps + 2;
    const iterations = startIterations - cycle;
    if (iterations > 0) {
      const acc = new Float64Array(P.length);
      const wsum = new Float64Array(n * m);
      for (let it = 0; it < iterations; it++) {
        checkCancel();
        attract(P, n, m, graph, negInvTwoBellSq, acc, wsum);
        workDone += sps;
        report(PRECOMPUTE_PROGRESS + (1 - PRECOMPUTE_PROGRESS) * (workDone / totalWork));
      }
    }
    spnow *= SUBDIVISION_GROWTH;
  }
  for (let i = 1; i < smoothSteps; i++) {
    const sps = Math.round(spnow) + i;
    P = subdivide(P, n, m, sps);
    m = sps + 2;
  }

  const points = new Float32Array(P);
  const offsets = new Uint32Array(n + 1);
  for (let k = 0; k <= n; k++) offsets[k] = k * m;
  const outValues = new Float32Array(n);
  if (values) outValues.set(values);
  else outValues.fill(1);

  report(1);
  return { points, offsets, values: outValues };
}
