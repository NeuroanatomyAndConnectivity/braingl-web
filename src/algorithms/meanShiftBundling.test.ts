import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundleEdges,
  computeCompatibilityGraph,
  defaultBundlingOptions,
  edgeCompatibility,
  type Polylines,
} from "./meanShiftBundling";

/** Deterministic pseudo-random numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEdges(n: number, box: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const edges = new Float32Array(n * 6);
  for (let i = 0; i < edges.length; i++) edges[i] = rnd() * box;
  return edges;
}

function point(lines: Polylines, line: number, k: number): [number, number, number] {
  const p = (lines.offsets[line] + k) * 3;
  return [lines.points[p], lines.points[p + 1], lines.points[p + 2]];
}

function lineLength(lines: Polylines, line: number): number {
  return lines.offsets[line + 1] - lines.offsets[line];
}

/** Largest pairwise distance between the given points. */
function spread(pts: [number, number, number][]): number {
  let max = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      max = Math.max(max, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]));
    }
  }
  return max;
}

/** Largest distance of any point of the line from the straight segment between its ends. */
function deviationFromStraight(lines: Polylines, line: number): number {
  const m = lineLength(lines, line);
  const a = point(lines, line, 0);
  const b = point(lines, line, m - 1);
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  let max = 0;
  for (let k = 0; k < m; k++) {
    const p = point(lines, line, k);
    const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / d2;
    max = Math.max(max, Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1], p[2] - a[2] - t * d[2]));
  }
  return max;
}

describe("edgeCompatibility", () => {
  it("is 1 for identical edges", () => {
    const e = [1, 2, 3, 40, -20, 15];
    const c = edgeCompatibility(e, e);
    expect(c.angle).toBeCloseTo(1, 12);
    expect(c.scale).toBeCloseTo(1, 12);
    expect(c.position).toBeCloseTo(1, 12);
    expect(c.visibility).toBeCloseTo(1, 12);
    expect(c.total).toBeCloseTo(1, 12);
  });

  it("is 1 for an edge and its reverse", () => {
    const c = edgeCompatibility([1, 2, 3, 40, -20, 15], [40, -20, 15, 1, 2, 3]);
    expect(c.total).toBeCloseTo(1, 12);
  });

  it("is symmetric", () => {
    const edges = randomEdges(200, 100, 7);
    for (let i = 0; i + 1 < 200; i += 2) {
      const a = edges.subarray(i * 6, i * 6 + 6);
      const b = edges.subarray(i * 6 + 6, i * 6 + 12);
      const ab = edgeCompatibility(a, b);
      const ba = edgeCompatibility(b, a);
      expect(ab.angle).toBeCloseTo(ba.angle, 12);
      expect(ab.scale).toBeCloseTo(ba.scale, 12);
      expect(ab.position).toBeCloseTo(ba.position, 12);
      expect(ab.visibility).toBeCloseTo(ba.visibility, 12);
      expect(ab.total).toBeCloseTo(ba.total, 12);
    }
  });

  it("has angle term 0 for perpendicular edges", () => {
    const c = edgeCompatibility([-10, 0, 0, 10, 0, 0], [0, -10, 5, 0, 10, 5]);
    expect(c.angle).toBe(0);
    expect(c.total).toBe(0);
    const skew = edgeCompatibility([0, 0, 0, 10, 0, 0], [3, 1, 2, 3, 1, 22]);
    expect(skew.angle).toBe(0);
  });

  it("matches hand-computed terms", () => {
    // Parallel, same direction; lengths 10 and 20, midpoints 5 apart along y.
    const c = edgeCompatibility([0, 0, 0, 10, 0, 0], [-5, 5, 0, 15, 5, 0]);
    expect(c.angle).toBeCloseTo(1, 12);
    expect(c.scale).toBeCloseTo(2 / (15 / 10 + 20 / 15), 12);
    expect(c.position).toBeCloseTo(15 / 20, 12);
    expect(c.visibility).toBeCloseTo(1, 12);
    expect(c.total).toBeCloseTo((2 / (15 / 10 + 20 / 15)) * 0.75, 12);

    // Same line, shifted by half a length: I0..I1 = [5, 15] on P = [0, 10].
    const shifted = edgeCompatibility([0, 0, 0, 10, 0, 0], [5, 0, 0, 15, 0, 0]);
    expect(shifted.visibility).toBeCloseTo(0, 12); // 1 - 2 * 5 / 10
    expect(shifted.position).toBeCloseTo(10 / 15, 12);
  });

  it("applies the visibility term only above the 0.9 gate, as the reference does", () => {
    // Collinear, shifted by 0.5: angle = scale = 1, position = 10 / 10.5 > 0.9.
    const above = edgeCompatibility([0, 0, 0, 10, 0, 0], [0.5, 0, 0, 10.5, 0, 0]);
    expect(above.visibility).toBeCloseTo(0.9, 12);
    expect(above.total).toBeCloseTo((10 / 10.5) * 0.9, 12);
    // Collinear, shifted by 2: position = 10 / 12 < 0.9, visibility 0.6 is ignored.
    const below = edgeCompatibility([0, 0, 0, 10, 0, 0], [2, 0, 0, 12, 0, 0]);
    expect(below.visibility).toBeCloseTo(0.6, 12);
    expect(below.total).toBeCloseTo(10 / 12, 12);
  });
});

describe("computeCompatibilityGraph", () => {
  it("lists exactly the pairs whose edgeCompatibility total exceeds the threshold", () => {
    // Clustered edges so that a good share of the pairs is compatible.
    const rnd = mulberry32(3);
    const n = 120;
    const edges = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const cluster = i % 3;
      const flip = rnd() < 0.3;
      const from = [cluster * 20 + rnd() * 8, rnd() * 8, rnd() * 8];
      const to = [cluster * 20 + rnd() * 8, 60 + rnd() * 8, rnd() * 8];
      edges.set(flip ? [...to, ...from] : [...from, ...to], i * 6);
    }
    for (const threshold of [0.5, 0.8, 0.95]) {
      const ticks: number[] = [];
      const graph = computeCompatibilityGraph(edges, threshold, (f) => ticks.push(f));
      expect(graph.offsets.length).toBe(n + 1);
      expect(graph.offsets[n]).toBe(graph.neighbours.length);
      expect(graph.reversed.length).toBe(graph.neighbours.length);
      expect(ticks[ticks.length - 1]).toBe(1);
      let pairs = 0;
      for (let i = 0; i < n; i++) {
        const row = Array.from(graph.neighbours.subarray(graph.offsets[i], graph.offsets[i + 1]));
        const expected: number[] = [];
        for (let j = i + 1; j < n; j++) {
          const c = edgeCompatibility(edges.subarray(i * 6, i * 6 + 6), edges.subarray(j * 6, j * 6 + 6));
          if (c.total > threshold) expected.push(j);
        }
        expect(row).toEqual(expected);
        pairs += row.length;
        for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e++) {
          const j = graph.neighbours[e];
          // Reversed exactly when the two "from" ends are on opposite sides (y near 0 vs 60).
          const opposite = edges[i * 6 + 1] < 30 !== edges[j * 6 + 1] < 30;
          expect(graph.reversed[e]).toBe(opposite ? 1 : 0);
        }
      }
      expect(pairs).toBeGreaterThan(0);
    }
  });
});

/**
 * Two bundles of 6 roughly parallel edges along x (the second 80 mm above the first, with
 * every other edge stored back to front), plus one far-away perpendicular edge.
 */
function twoBundles(): Float32Array {
  const rnd = mulberry32(11);
  const edges: number[] = [];
  for (let bundle = 0; bundle < 2; bundle++) {
    for (let i = 0; i < 6; i++) {
      const from = [rnd() * 2, rnd() * 6, bundle * 80 + rnd() * 6];
      const to = [100 + rnd() * 2, rnd() * 6, bundle * 80 + rnd() * 6];
      if (i % 2 === 1) edges.push(...to, ...from);
      else edges.push(...from, ...to);
    }
  }
  edges.push(50, -200, 40, 50, -200, 140);
  return new Float32Array(edges);
}

describe("bundleEdges", () => {
  it("has the documented defaults", () => {
    expect(defaultBundlingOptions).toEqual({
      compatibilityThreshold: 0.8,
      bell: 5,
      startIterations: 10,
      numCycles: 10,
      smoothSteps: 3,
    });
  });

  it("returns consistent offsets, points and values", () => {
    const edges = randomEdges(50, 100, 1);
    const values = new Float32Array(50).map((_, i) => i / 10);
    const out = bundleEdges(edges, values);
    expect(out.offsets.length).toBe(51);
    expect(out.offsets[0]).toBe(0);
    for (let k = 0; k < 50; k++) {
      // 10 cycles end at round(1.3^9) = 11 interior points; "smooth" 3 adds 2 resamplings to 16.
      expect(lineLength(out, k)).toBe(18);
    }
    expect(out.points.length).toBe(out.offsets[50] * 3);
    expect(Array.from(out.values)).toEqual(Array.from(values));
    expect(out.values).not.toBe(values);
    expect(out.points.every((v) => Number.isFinite(v))).toBe(true);
    // Without values every line gets the value 1.
    expect(Array.from(bundleEdges(edges, null).values)).toEqual(new Array(50).fill(1));
  });

  it("keeps the end points exactly fixed", () => {
    const edges = twoBundles();
    const out = bundleEdges(edges, null);
    const n = edges.length / 6;
    for (let k = 0; k < n; k++) {
      const m = lineLength(out, k);
      expect(point(out, k, 0)).toEqual(Array.from(edges.subarray(k * 6, k * 6 + 3)));
      expect(point(out, k, m - 1)).toEqual(Array.from(edges.subarray(k * 6 + 3, k * 6 + 6)));
    }
  });

  it("pulls each bundle together and leaves an isolated edge straight", () => {
    const edges = twoBundles();
    // Same sampling without attraction, as the "before" reference.
    const straight = bundleEdges(edges, null, { compatibilityThreshold: 2 });
    const out = bundleEdges(edges, null);
    const m = lineLength(out, 0);
    expect(lineLength(straight, 0)).toBe(m);

    for (let bundle = 0; bundle < 2; bundle++) {
      // Mid point and a quarter point; edges stored back to front are read from the other end.
      for (const k of [Math.floor(m / 2), Math.floor(m / 4)]) {
        const before: [number, number, number][] = [];
        const after: [number, number, number][] = [];
        for (let i = 0; i < 6; i++) {
          const line = bundle * 6 + i;
          const kk = i % 2 === 1 ? m - 1 - k : k;
          before.push(point(straight, line, kk));
          after.push(point(out, line, kk));
        }
        expect(spread(before)).toBeGreaterThan(2);
        expect(spread(after)).toBeLessThan(0.25 * spread(before));
      }
    }

    // The two bundles stay 80 mm apart.
    const mid = Math.floor(m / 2);
    expect(Math.abs(point(out, 0, mid)[2] - point(out, 6, mid)[2])).toBeGreaterThan(70);

    // The isolated edge is untouched; the bundled edges are not straight any more.
    expect(deviationFromStraight(out, 12)).toBeLessThan(1e-4);
    expect(deviationFromStraight(straight, 0)).toBeLessThan(1e-4);
    let maxDeviation = 0;
    for (let line = 0; line < 12; line++) {
      maxDeviation = Math.max(maxDeviation, deviationFromStraight(out, line));
    }
    expect(maxDeviation).toBeGreaterThan(1);
  });

  it("follows the reference schedule for the number of points per line", () => {
    const edges = twoBundles();
    const count = (opts: Parameters<typeof bundleEdges>[2]): number =>
      lineLength(bundleEdges(edges, null, opts), 0);
    expect(count({ numCycles: 0, smoothSteps: 0 })).toBe(2);
    expect(count({ numCycles: 0, smoothSteps: 3 })).toBe(5); // subdivide(1 + 1), subdivide(1 + 2)
    expect(count({ numCycles: 1, smoothSteps: 1 })).toBe(3);
    expect(count({ numCycles: 10, smoothSteps: 1 })).toBe(13); // round(1.3^9) = 11 interior
    expect(count({ numCycles: 10, smoothSteps: 2 })).toBe(17); // round(1.3^10) + 1 = 15 interior
  });

  it("resamples straight edges at equal spacing", () => {
    const out = bundleEdges(new Float32Array([0, 0, 0, 17, 0, 0]), null);
    const m = lineLength(out, 0);
    for (let k = 0; k < m; k++) {
      const p = point(out, 0, k);
      expect(p[0]).toBeCloseTo((17 * k) / (m - 1), 4);
      expect(p[1]).toBe(0);
      expect(p[2]).toBe(0);
    }
  });

  it("reports monotone progress that reaches 1, at least once per iteration", () => {
    const fractions: number[] = [];
    let polls = 0;
    bundleEdges(
      randomEdges(300, 60, 5),
      null,
      undefined,
      (f) => fractions.push(f),
      () => {
        polls++;
        return false;
      },
    );
    expect(fractions.length).toBeGreaterThanOrEqual(55); // 10 + 9 + ... + 1 iterations
    expect(polls).toBeGreaterThanOrEqual(55);
    expect(fractions[0]).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(Math.max(...fractions)).toBe(1);
    // The compatibility pass is reported too, within the first 30 %.
    expect(fractions.some((f) => f > 0 && f < 0.3)).toBe(true);
  });

  it("throws 'cancelled' when asked to cancel", () => {
    const edges = randomEdges(100, 60, 9);
    expect(() => bundleEdges(edges, null, undefined, undefined, () => true)).toThrow("cancelled");
    // Cancelling in the middle of the iterations.
    const fractions: number[] = [];
    expect(() =>
      bundleEdges(
        edges,
        null,
        undefined,
        (f) => fractions.push(f),
        () => fractions.length > 0 && fractions[fractions.length - 1] > 0.5,
      ),
    ).toThrow("cancelled");
    expect(fractions[fractions.length - 1]).toBeGreaterThan(0.5);
    expect(fractions[fractions.length - 1]).toBeLessThan(0.6);
  });

  it("handles empty input and rejects malformed input", () => {
    const fractions: number[] = [];
    const out = bundleEdges(new Float32Array(0), null, undefined, (f) => fractions.push(f));
    expect(out.points.length).toBe(0);
    expect(Array.from(out.offsets)).toEqual([0]);
    expect(out.values.length).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(() => bundleEdges(new Float32Array(7), null)).toThrow(RangeError);
    expect(() => bundleEdges(new Float32Array(12), new Float32Array(3))).toThrow(RangeError);
    expect(() => bundleEdges(new Float32Array(12), null, { bell: 0 })).toThrow(RangeError);
  });

  it("survives zero-length and duplicate edges", () => {
    const edges = new Float32Array([
      5, 5, 5, 5, 5, 5, // zero length
      0, 0, 0, 50, 0, 0,
      0, 0, 0, 50, 0, 0, // duplicate
      50, 1, 0, 0, 1, 0, // reversed neighbour
    ]);
    const out = bundleEdges(edges, null);
    expect(out.points.every((v) => Number.isFinite(v))).toBe(true);
    const m = lineLength(out, 0);
    for (let k = 0; k < m; k++) expect(point(out, 0, k)).toEqual([5, 5, 5]);
    // The three real edges meet half-way between y = 0 (twice) and y = 1.
    const mid = (m - 1) / 2;
    const k = Math.floor(mid);
    expect(point(out, 1, k)[1]).toBeCloseTo(1 / 3, 2);
    expect(point(out, 3, m - 1 - k)[1]).toBeCloseTo(1 / 3, 2);
  });
});

type Vec = [number, number, number];

/**
 * Literal, unoptimised transliteration of the C++ reference (brainbundler's
 * Connections::fullAttract / calcComps / attract with a dense n x n matrix, and Edge::subdivide
 * / flip), used to check the optimised implementation against.
 */
function referenceBundle(
  input: Float32Array,
  c_thr: number,
  bell: number,
  start_i: number,
  numcycles: number,
  smooth: number,
): Vec[][] {
  const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a: Vec, f: number): Vec => [a[0] * f, a[1] * f, a[2] * f];
  const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a: Vec): number => Math.sqrt(dot(a, a));
  const normalized = (a: Vec): Vec => (len(a) > 0 ? mul(a, 1 / len(a)) : [0, 0, 0]);

  interface Edge {
    fn: Vec;
    tn: Vec;
    points: Vec[];
  }
  const edges: Edge[] = [];
  for (let i = 0; i < input.length; i += 6) {
    const fn: Vec = [input[i], input[i + 1], input[i + 2]];
    const tn: Vec = [input[i + 3], input[i + 4], input[i + 5]];
    edges.push({ fn, tn, points: [fn, tn] });
  }
  const n = edges.length;
  const length = (e: Edge): number => len(sub(e.fn, e.tn));
  const flip = (e: Edge, o: Edge): boolean =>
    len(sub(e.fn, o.fn)) + len(sub(e.tn, o.tn)) < len(sub(e.fn, o.tn)) + len(sub(e.tn, o.fn));
  const proj = (a: Vec, b: Vec, p: Vec): Vec => {
    const ba = sub(b, a);
    const pa = sub(p, a);
    return add(a, mul(ba, dot(ba, pa) / dot(ba, ba)));
  };
  const vis_c = (ep: Edge, eq: Edge): number => {
    const i0 = proj(ep.fn, ep.tn, eq.fn);
    const i1 = proj(ep.fn, ep.tn, eq.tn);
    const im = mul(add(i0, i1), 0.5);
    const pm = mul(add(ep.fn, ep.tn), 0.5);
    return Math.max(1 - (2 * len(sub(pm, im))) / len(sub(i0, i1)), 0);
  };

  // calcComps
  const comps = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        comps[i + n * j] = 1;
        continue;
      }
      const ei = edges[i];
      const ej = edges[j];
      let angle_comp: number;
      if (!flip(ei, ej)) angle_comp = dot(sub(ei.fn, ei.tn), sub(ej.tn, ej.fn));
      else angle_comp = dot(sub(ei.fn, ei.tn), sub(ej.fn, ej.tn));
      angle_comp /= length(ei) * length(ej);
      const lavg = (length(ei) + length(ej)) / 2.0;
      const l_comp =
        2 / (lavg / Math.min(length(ei), length(ej)) + Math.max(length(ei), length(ej)) / lavg);
      const mi = mul(add(ei.fn, ei.tn), 0.5);
      const mj = mul(add(ej.fn, ej.tn), 0.5);
      const p_comp = lavg / (lavg + len(sub(mi, mj)));
      if (angle_comp * l_comp * p_comp > 0.9) {
        const vis_comp = Math.min(vis_c(ei, ej), vis_c(ej, ei));
        comps[i + n * j] = angle_comp * l_comp * p_comp * vis_comp;
      } else {
        comps[i + n * j] = angle_comp * l_comp * p_comp;
      }
    }
  }

  const subdivide = (e: Edge, newp: number): void => {
    const segLength = (k: number): number => len(sub(e.points[k], e.points[k + 1]));
    const newpoints: Vec[] = [e.points[0]];
    let polyLength = 0;
    for (let i = 0; i < e.points.length - 1; i++) polyLength += segLength(i);
    const newl = polyLength / (newp + 1);
    let seg = 0;
    let lengthSoFar = 0;
    let p1 = e.points[0];
    let p2 = e.points[1];
    for (let j = 0; j < newp; j++) {
      while (seg < e.points.length - 2 && segLength(seg) < newl * (j + 1) - lengthSoFar) {
        lengthSoFar += segLength(seg);
        seg++;
        p1 = e.points[seg];
        p2 = e.points[seg + 1];
      }
      const ib = newl * (j + 1) - lengthSoFar;
      newpoints.push(add(p1, mul(normalized(sub(p2, p1)), ib)));
    }
    newpoints.push(e.points[e.points.length - 1]);
    e.points = newpoints;
  };

  const attract = (): void => {
    const moved: Vec[][] = [];
    for (let ie = 0; ie < n; ie++) {
      const e = edges[ie];
      const next = e.points.slice();
      for (let i = 1; i < e.points.length - 1; i++) {
        const p = e.points[i];
        let fsum = 0;
        let f: Vec = [0, 0, 0];
        for (let ef = 0; ef < n; ef++) {
          if (comps[ie + n * ef] > c_thr) {
            const other = edges[ef];
            const pe = flip(e, other) ? other.points[i] : other.points[other.points.length - 1 - i];
            const de = len(sub(pe, p));
            const weight = Math.exp(-(de * de) / (2 * bell * bell));
            fsum += weight;
            f = add(f, mul(pe, weight));
          }
        }
        f = mul(f, 1 / fsum);
        next[i] = add(p, sub(f, p)); // applyForces
      }
      moved.push(next);
    }
    for (let ie = 0; ie < n; ie++) edges[ie].points = moved[ie];
  };

  // fullAttract
  const spfac = 1.3;
  let spnow = 1;
  let i = start_i;
  for (let cycle = 0; cycle < numcycles; cycle++) {
    const sps = Math.round(spnow);
    for (const e of edges) subdivide(e, sps);
    for (let j = 0; j < i; j++) attract();
    i--;
    spnow *= spfac;
  }
  for (let k = 1; k < smooth; k++) {
    for (const e of edges) subdivide(e, Math.round(spnow) + k);
  }
  return edges.map((e) => e.points);
}

describe("bundleEdges against a literal port of the C++ reference", () => {
  /** Edges between a few clusters of end points, in random orientation, plus stray edges. */
  function clusteredEdges(n: number, seed: number): Float32Array {
    const rnd = mulberry32(seed);
    const centres: Vec[] = [];
    for (let c = 0; c < 6; c++) centres.push([rnd() * 120, rnd() * 120, rnd() * 120]);
    const edges = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      if (i % 10 === 9) {
        for (let k = 0; k < 6; k++) edges[i * 6 + k] = rnd() * 120;
        continue;
      }
      const a = Math.floor(rnd() * 6);
      let b = Math.floor(rnd() * 5);
      if (b >= a) b++;
      for (let k = 0; k < 3; k++) {
        edges[i * 6 + k] = centres[a][k] + (rnd() - 0.5) * 16;
        edges[i * 6 + 3 + k] = centres[b][k] + (rnd() - 0.5) * 16;
      }
    }
    return edges;
  }

  for (const [label, opts] of [
    ["defaults", defaultBundlingOptions],
    ["other parameters", { compatibilityThreshold: 0.6, bell: 12, startIterations: 4, numCycles: 6, smoothSteps: 5 }],
  ] as const) {
    it(`gives the same polylines (${label})`, () => {
      const edges = clusteredEdges(150, 21);
      const out = bundleEdges(edges, null, opts);
      const ref = referenceBundle(
        edges,
        opts.compatibilityThreshold,
        opts.bell,
        opts.startIterations,
        opts.numCycles,
        opts.smoothSteps,
      );
      let maxDiff = 0;
      let maxBend = 0;
      for (let line = 0; line < ref.length; line++) {
        expect(lineLength(out, line)).toBe(ref[line].length);
        maxBend = Math.max(maxBend, deviationFromStraight(out, line));
        for (let k = 0; k < ref[line].length; k++) {
          const p = point(out, line, k);
          for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(p[c] - ref[line][k][c]));
        }
      }
      expect(maxBend).toBeGreaterThan(2); // the data does bundle
      expect(maxDiff).toBeLessThan(1e-3);
    });
  }
});

describe("bundlingWorker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("answers a bundle request with progress and a transferred result", async () => {
    const posted: { message: any; transfer: Transferable[] }[] = [];
    const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: unknown } = {
      onmessage: null,
      postMessage: (message: unknown, transfer: Transferable[] = []) => posted.push({ message, transfer }),
    };
    vi.stubGlobal("self", scope);
    await import("./bundlingWorker");
    expect(typeof scope.onmessage).toBe("function");

    const edges = twoBundles();
    scope.onmessage!({ data: { type: "bundle", edges, values: null, options: { numCycles: 4 } } });
    const types = posted.map((p) => p.message.type);
    expect(types[types.length - 1]).toBe("done");
    expect(types.slice(0, -1).every((t) => t === "progress")).toBe(true);
    expect(types.length).toBeGreaterThanOrEqual(2);
    expect(posted[posted.length - 2].message.fraction).toBe(1);
    const done = posted[posted.length - 1];
    const expected = bundleEdges(edges, null, { numCycles: 4 });
    expect(Array.from(done.message.result.points)).toEqual(Array.from(expected.points));
    expect(Array.from(done.message.result.offsets)).toEqual(Array.from(expected.offsets));
    expect(done.transfer).toEqual([
      done.message.result.points.buffer,
      done.message.result.offsets.buffer,
      done.message.result.values.buffer,
    ]);

    posted.length = 0;
    scope.onmessage!({ data: { type: "bundle", edges: new Float32Array(5), values: null, options: {} } });
    expect(posted.map((p) => p.message.type)).toEqual(["error"]);
    expect(posted[0].message.message).toMatch(/6 numbers/);
  });
});
