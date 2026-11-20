/**
 * The CPU glyph builders against brute-force reference implementations, on
 * every synthetic example dataset and many filter combinations.
 */
import { describe, it, expect } from "vitest";
import { ConnMatrix, SignMode } from "../data/connMatrix";
import { buildTopology } from "../data/dataset";
import {
  averageConnectivity, buildConnexels, buildDiffConnexels, BuildFilter, computePieRanks, CONNEXEL_STRIDE, createConnexels, DIFF_STRIDE, hue, sortForPies,
} from "./builders";
import { FIXTURES, FixtureDataset, LARGE_FIXTURE, lcg } from "../testing/fixtures";
import { distance, glyphNodesFor, hsvHue, orientation, RefConnexel, refBuildSet, refConnexels, RefFilter } from "../testing/reference";

const SIGNS: SignMode[] = [0, 1, 2];
/** thresholds as fractions of maxAbs; none of them falls exactly on an int16 level */
const FRACTIONS = [0, 0.05, 0.123, 0.35, 0.613, 0.79];

interface NodeSet { label: string; nodes: Uint8Array }

function glyphNodeSets(ds: FixtureDataset): NodeSet[] {
  const patch = Uint8Array.from({ length: ds.n }, (_, i) => (i % 5 === 0 ? 1 : 0));
  return [
    { label: "all nodes", nodes: glyphNodesFor(ds) },
    { label: "left hemisphere", nodes: glyphNodesFor(ds, 1) },
    { label: "right hemisphere", nodes: glyphNodesFor(ds, 2) },
    { label: "ROI of every 5th node", nodes: glyphNodesFor(ds, 0, patch) },
  ];
}

function targetSets(ds: FixtureDataset): { label: string; targets: Uint8Array | null }[] {
  return [
    { label: "all targets", targets: null },
    { label: "targets in modules 0-3", targets: Uint8Array.from(ds.modules, (m) => (m < 4 ? 1 : 0)) },
  ];
}

/** Index of the first connexel that differs from the reference list, -1 when identical (same order). */
function firstMismatch(buf: ArrayBuffer, count: number, ref: RefConnexel[]): number {
  const u16 = new Uint16Array(buf), i16 = new Int16Array(buf);
  if (count !== ref.length) return Math.min(count, ref.length);
  for (let k = 0; k < count; k++) if (u16[4 * k] !== ref[k].i || u16[4 * k + 1] !== ref[k].j || i16[4 * k + 2] !== ref[k].raw) return k;
  return -1;
}

const unpack = (buf: ArrayBuffer, count: number) => {
  const u16 = new Uint16Array(buf), i16 = new Int16Array(buf);
  return Array.from({ length: count }, (_, k) => ({ i: u16[4 * k], j: u16[4 * k + 1], raw: i16[4 * k + 2], pad: u16[4 * k + 3] }));
};

describe.each(FIXTURES)("buildConnexels on $name", ({ make }) => {
  const ds = make();
  const conn = ds.conn;
  const A = conn.maxAbs;

  describe.each(glyphNodeSets(ds))("$label", ({ nodes }) => {
    describe.each(targetSets(ds))("$label", ({ targets }) => {
      describe.each(SIGNS)("sign %i", (sign) => {
        it.each(FRACTIONS)("threshold %f x maxAbs", (fraction) => {
          const f: BuildFilter = { glyphNodes: nodes, targets, sign, threshold: fraction * A, maxThreshold: A };
          const set = buildConnexels(conn, f);
          const u16 = new Uint16Array(set.data), i16 = new Int16Array(set.data);

          // exactly the documented conservative set, in row order
          const ref = refBuildSet(conn, f);
          expect(set.count).toBe(ref.length);
          expect(firstMismatch(set.data, set.count, ref)).toBe(-1);
          expect(set.threshold).toBe(f.threshold);
          expect(set.data.byteLength).toBe(Math.max(1, set.count) * CONNEXEL_STRIDE);

          // a superset of what the shader draws (both lists are in row order, so one merge pass compares them);
          // anything extra is within one int16 step of the threshold
          const strict = refConnexels(conn, f);
          let p = 0, missing = 0, farExtras = 0, diagonal = 0;
          const extra = (k: number) => { if (Math.abs(Math.abs(i16[4 * k + 2] * conn.scale) - f.threshold) > conn.scale * 1.000001) farExtras++; };
          for (const c of strict) {
            while (p < set.count && (u16[4 * p] !== c.i || u16[4 * p + 1] !== c.j)) extra(p++);
            if (p >= set.count) { missing++; break; }
            p++;
          }
          for (; p < set.count; p++) extra(p);
          for (let k = 0; k < set.count; k++) if (u16[4 * k] === u16[4 * k + 1]) diagonal++;
          expect(missing).toBe(0);
          expect(farExtras).toBe(0);
          expect(diagonal).toBe(0);

          // nodeStart
          expect(set.nodeStart.length).toBe(ds.n + 1);
          expect(set.nodeStart[0]).toBe(0);
          expect(set.nodeStart[ds.n]).toBe(set.count);
          let bad = 0;
          for (let i = 0; i < ds.n; i++) {
            if (set.nodeStart[i + 1] < set.nodeStart[i]) bad++;
            if (!nodes[i] && set.nodeStart[i + 1] !== set.nodeStart[i]) bad++;
            for (let k = set.nodeStart[i]; k < set.nodeStart[i + 1]; k++) if (u16[4 * k] !== i) bad++;
          }
          expect(bad).toBe(0);
        });
      });
    });
  });

  describe.each(SIGNS)("band-pass, sign %i", (sign) => {
    it.each([[0.05, 0.2], [0.123, 0.62], [0.35, 0.81], [0.613, 0.7]])("%f < |value| / maxAbs <= %f", (lo, hi) => {
      const f: BuildFilter = { glyphNodes: glyphNodesFor(ds), targets: null, sign, threshold: lo * A, maxThreshold: hi * A };
      const set = buildConnexels(conn, f);
      const ref = refBuildSet(conn, f);
      expect(firstMismatch(set.data, set.count, ref)).toBe(-1);
      const strict = refConnexels(conn, f);
      expect(set.count).toBeGreaterThanOrEqual(strict.length);
      // at most the entries within one step of either bound are extra
      let near = 0;
      for (const c of ref) if (Math.min(Math.abs(Math.abs(c.value) - f.threshold), Math.abs(Math.abs(c.value) - f.maxThreshold)) <= conn.scale * 1.000001) near++;
      expect(set.count - strict.length).toBeLessThanOrEqual(near);
    });
  });

  it("is empty without glyph nodes, and never contains masked nodes as sources", () => {
    const none = buildConnexels(conn, { glyphNodes: new Uint8Array(ds.n), targets: null, sign: 2, threshold: 0, maxThreshold: A });
    expect(none.count).toBe(0);
    expect(none.data.byteLength).toBe(CONNEXEL_STRIDE);
    expect(Array.from(none.nodeStart).every((v) => v === 0)).toBe(true);
    const all = buildConnexels(conn, { glyphNodes: glyphNodesFor(ds), targets: null, sign: 2, threshold: 0, maxThreshold: A });
    // zero rows / columns never pass a threshold
    expect(unpack(all.data, all.count).every((c) => ds.mask[c.i] === 1 && ds.mask[c.j] === 1)).toBe(true);
  });

  it("the count shrinks monotonically with the threshold and the three sign modes add up", () => {
    const nodes = glyphNodesFor(ds);
    let prev = Infinity;
    for (const fraction of FRACTIONS) {
      const count = (sign: SignMode) => buildConnexels(conn, { glyphNodes: nodes, targets: null, sign, threshold: fraction * A, maxThreshold: A }).count;
      expect(count(0) + count(1)).toBe(count(2));
      expect(count(2)).toBeLessThanOrEqual(prev);
      prev = count(2);
    }
  });

  it("includes the strongest connection when the upper threshold is maxAbs", () => {
    let best = 0, bi = 0, bj = 0;
    for (let i = 0; i < ds.n; i++) for (let j = 0; j < ds.n; j++) {
      if (i !== j && Math.abs(conn.data[i * ds.n + j]) > best) { best = Math.abs(conn.data[i * ds.n + j]); bi = i; bj = j; }
    }
    const set = buildConnexels(conn, { glyphNodes: glyphNodesFor(ds), targets: null, sign: 2, threshold: 0.5 * A, maxThreshold: A });
    expect(unpack(set.data, set.count).some((c) => c.i === bi && c.j === bj)).toBe(true);
  });
});

describe("hue", () => {
  it("agrees with the textbook HSV hue on random colours", () => {
    const rnd = lcg(3);
    for (let k = 0; k < 2000; k++) {
      const c = [rnd(), rnd(), rnd()];
      expect(hue(c[0], c[1], c[2])).toBeCloseTo(hsvHue(c[0], c[1], c[2]), 9);
    }
  });
  it.each([[1, 0, 0, 0], [1, 1, 0, 1 / 6], [0, 1, 0, 1 / 3], [0, 1, 1, 0.5], [0, 0, 1, 2 / 3], [1, 0, 1, 5 / 6], [0.5, 0.5, 0.5, -1]])("hue(%f, %f, %f) = %f", (r, g, b, h) => {
    expect(hue(r, g, b)).toBeCloseTo(h, 12);
  });
});

/** quantised hue key used for the ordering of pie slices: 16 bits over [-1, 1) */
const hueKey = (colorPos: Float32Array, i: number, j: number): number => {
  const o = orientation(colorPos, i, j);
  return Math.round((hsvHue(o[0], o[1], o[2]) + 1) * 32767);
};

describe.each(FIXTURES)("pie glyphs on $name", ({ make }) => {
  const ds = make();
  const conn = ds.conn;
  const A = conn.maxAbs;
  const nodes = glyphNodesFor(ds);
  const base: BuildFilter = { glyphNodes: nodes, targets: null, sign: 2, threshold: 0.123 * A, maxThreshold: A };
  const set = buildConnexels(conn, base);
  const before = unpack(set.data, set.count);

  describe.each(ds.surfaces.map((s, k) => [s.name, k] as const))("colour surface %s", (_name, surface) => {
    const colorPos = ds.surfaces[surface].positions;

    describe.each([false, true])("sorted by value: %s", (byValue) => {
      const sorted = sortForPies(set, ds.n, colorPos, byValue);
      const after = unpack(sorted, set.count);

      it("permutes the connexels within each node and leaves the input untouched", () => {
        expect(sorted.byteLength).toBe(set.data.byteLength);
        expect(sorted).not.toBe(set.data);
        expect(unpack(set.data, set.count)).toEqual(before);
        let bad = 0;
        const key = (c: { i: number; j: number; raw: number }) => c.i * 1e9 + c.j * 65536 + (c.raw + 32768);
        for (let i = 0; i < ds.n; i++) {
          const s = set.nodeStart[i], e = set.nodeStart[i + 1];
          const a = after.slice(s, e).map(key).sort((x, y) => x - y), b = before.slice(s, e).map(key).sort((x, y) => x - y);
          for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) bad++;
          for (let k = s; k < e; k++) if (after[k].pad !== 0 || after[k].i !== i) bad++;
        }
        expect(bad).toBe(0);
      });

      it(byValue ? "orders each node's slices by descending value" : "orders each node's slices by descending hue of the orientation colour", () => {
        let outOfOrder = 0;
        for (let i = 0; i < ds.n; i++) {
          let prev = Infinity;
          for (let k = set.nodeStart[i]; k < set.nodeStart[i + 1]; k++) {
            const key = byValue ? after[k].raw : hueKey(colorPos, i, after[k].j);
            if (key > prev) outOfOrder++;
            prev = key;
          }
        }
        expect(outOfOrder).toBe(0);
      });

      it("keeps the relative order when the build threshold is raised", () => {
        const higher = buildConnexels(conn, { ...base, threshold: 0.613 * A });
        const sortedHigher = unpack(sortForPies(higher, ds.n, colorPos, byValue), higher.count);
        const lo = Math.max(1, Math.floor((0.613 * A) / conn.scale));
        const filtered = after.filter((c) => Math.abs(c.raw) >= lo);
        expect(sortedHigher.length).toBe(filtered.length);
        expect(sortedHigher.findIndex((c, k) => c.i !== filtered[k].i || c.j !== filtered[k].j)).toBe(-1);
      });
    });
  });

  const sortedByHue = sortForPies(set, ds.n, ds.surfaces[0].positions, false);
  const slices = unpack(sortedByHue, set.count);

  describe.each(ds.surfaces.map((s, k) => [s.name, k] as const))("ranks with lengths measured on %s", (_name, lengthSurface) => {
    const lengthPos = ds.surfaces[lengthSurface].positions;
    describe.each(SIGNS)("sign %i", (sign) => {
      it.each([[0.123, 1, 0], [0.35, 1, 0], [0.35, 1, 25], [0.613, 1, 60], [0.123, 0.7, 25], [0.79, 1, 0]])(
        "threshold %f, max %f (x maxAbs), minimum length %i mm", (lo, hi, minLength) => {
          const p = { threshold: lo * A, maxThreshold: hi * A, minLength, sign };
          const { ranks, maxCount, visible } = computePieRanks(sortedByHue, set.nodeStart, ds.n, lengthPos, conn.scale, p);
          expect(ranks.length).toBe(Math.max(1, set.count) * 2);

          const ref: RefFilter = { glyphNodes: nodes, sign, threshold: p.threshold, maxThreshold: p.maxThreshold, minLength, lengthPos };
          const perNode = new Uint32Array(ds.n);
          const drawn = new Set<number>();
          for (const c of refConnexels(conn, ref)) { perNode[c.i]++; drawn.add(c.i * ds.n + c.j); }

          let total = 0, largest = 0, bad = 0;
          for (let i = 0; i < ds.n; i++) {
            let next = 0;
            for (let k = set.nodeStart[i]; k < set.nodeStart[i + 1]; k++) {
              const shown = drawn.has(i * ds.n + slices[k].j);
              if (ranks[2 * k] !== (shown ? next++ : 0xffff)) bad++; // 0 .. count-1 in slice order, 0xFFFF when filtered
              if (ranks[2 * k + 1] !== perNode[i]) bad++;
            }
            if (next !== perNode[i]) bad++;
            total += perNode[i];
            largest = Math.max(largest, perNode[i]);
          }
          expect(bad).toBe(0);
          expect(visible).toBe(total);
          expect(maxCount).toBe(largest);
        });
    });
  });

  it("an empty set yields no visible slices", () => {
    const empty = buildConnexels(conn, { ...base, glyphNodes: new Uint8Array(ds.n) });
    const r = computePieRanks(sortForPies(empty, ds.n, ds.surfaces[0].positions, false), empty.nodeStart, ds.n, ds.surfaces[0].positions, conn.scale,
      { threshold: 0, maxThreshold: A, minLength: 0, sign: 2 });
    expect(r.visible).toBe(0);
    expect(r.maxCount).toBe(0);
  });
});

// ------------------------------------------------------------- diff glyphs

interface DiffEntry { a: number; b: number; j: number; va: number; vb: number }

/**
 * Every (edge, target) entry of which at least one endpoint value reaches the raw lower bound `lo` with the
 * right sign. The upper threshold of the filter is deliberately not applied: on screen it bounds the
 * difference, not the endpoint values.
 */
function refDiffRaw(conn: ConnMatrix, edges: Uint32Array, f: BuildFilter, lo: number): DiffEntry[] {
  const passes = (raw: number) => Math.abs(raw) >= lo && (raw > 0 ? f.sign !== 1 : f.sign !== 0);
  const out: DiffEntry[] = [];
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1];
    if (!f.glyphNodes[a] || !f.glyphNodes[b]) continue;
    for (let j = 0; j < conn.n; j++) {
      if (j === a || j === b || (f.targets && !f.targets[j])) continue;
      const va = conn.data[a * conn.n + j], vb = conn.data[b * conn.n + j];
      if (passes(va) || passes(vb)) out.push({ a, b, j, va, vb });
    }
  }
  return out;
}

/** The raw lower bound the builders derive from a threshold. */
const rawLo = (conn: ConnMatrix, threshold: number) => Math.max(1, Math.floor(threshold / conn.scale));

function refDiff(conn: ConnMatrix, edges: Uint32Array, f: BuildFilter, threshold: number): DiffEntry[] {
  return refDiffRaw(conn, edges, f, rawLo(conn, threshold));
}

/**
 * The key of an entry, written out per sign: the entry is kept at raw bound `lo` exactly when key >= lo.
 * sign 0: max(r1, r2); sign 1: -min(r1, r2); sign 2: max(|r1|, |r2|).
 */
function diffKey(e: DiffEntry, sign: SignMode): number {
  if (sign === 0) return Math.max(e.va, e.vb);
  if (sign === 1) return -Math.min(e.va, e.vb);
  return Math.max(Math.abs(e.va), Math.abs(e.vb));
}

/** Index of the first difference between a diff buffer and the reference, -1 when identical. */
function diffMismatch(buf: ArrayBuffer, count: number, ref: DiffEntry[]): number {
  const u16 = new Uint16Array(buf), i16 = new Int16Array(buf);
  if (count !== ref.length) return Math.min(count, ref.length);
  for (let k = 0; k < count; k++) {
    const r = ref[k];
    if (u16[6 * k] !== r.a || u16[6 * k + 1] !== r.b || u16[6 * k + 2] !== r.j || i16[6 * k + 4] !== r.va || i16[6 * k + 5] !== r.vb) return k;
  }
  return -1;
}

const unpackDiff = (buf: ArrayBuffer, count: number): DiffEntry[] => {
  const u16 = new Uint16Array(buf), i16 = new Int16Array(buf);
  return Array.from({ length: count }, (_, k) => ({ a: u16[6 * k], b: u16[6 * k + 1], j: u16[6 * k + 2], va: i16[6 * k + 4], vb: i16[6 * k + 5] }));
};

describe.each(FIXTURES)("buildDiffConnexels on $name", ({ make }) => {
  const ds = make();
  const conn = ds.conn;
  const A = conn.maxAbs;
  const topo = buildTopology(ds.n, ds.triangles);

  describe.each(glyphNodeSets(ds).slice(0, 2))("$label", ({ nodes }) => {
    describe.each(SIGNS)("sign %i", (sign) => {
      it.each([0.15, 0.35, 0.613])("threshold %f x maxAbs, unlimited budget: one entry per edge and target where either endpoint passes", (fraction) => {
        const f: BuildFilter = { glyphNodes: nodes, targets: null, sign, threshold: fraction * A, maxThreshold: A };
        const d = buildDiffConnexels(conn, topo.edges, f, 1e9);
        const ref = refDiff(conn, topo.edges, f, f.threshold);
        expect(d.threshold).toBe(f.threshold);
        expect(d.count).toBe(ref.length);
        expect(d.data.byteLength).toBe(Math.max(1, d.count) * DIFF_STRIDE);
        expect(diffMismatch(d.data, d.count, ref)).toBe(-1);
        expect(ref.every((c) => nodes[c.a] === 1 && nodes[c.b] === 1 && c.a < c.b && c.j !== c.a && c.j !== c.b)).toBe(true);
      });
    });
  });

  it("keeps transitions: targets where only one endpoint passes are included", () => {
    const f: BuildFilter = { glyphNodes: glyphNodesFor(ds), targets: null, sign: 2, threshold: 0.35 * A, maxThreshold: A };
    const d = unpackDiff(buildDiffConnexels(conn, topo.edges, f, 1e9).data, refDiff(conn, topo.edges, f, f.threshold).length);
    const strong = (raw: number) => Math.abs(raw * conn.scale) > f.threshold;
    expect(d.some((c) => strong(c.va) !== strong(c.vb))).toBe(true);
    expect(d.every((c) => strong(c.va) || strong(c.vb) || Math.abs(Math.abs(c.va * conn.scale) - f.threshold) <= conn.scale || Math.abs(Math.abs(c.vb * conn.scale) - f.threshold) <= conn.scale)).toBe(true);
  });

  it("restricts the targets", () => {
    const targets = Uint8Array.from(ds.modules, (m) => (m % 2 ? 1 : 0));
    const f: BuildFilter = { glyphNodes: glyphNodesFor(ds), targets, sign: 2, threshold: 0.35 * A, maxThreshold: A };
    const d = buildDiffConnexels(conn, topo.edges, f, 1e9);
    expect(diffMismatch(d.data, d.count, refDiff(conn, topo.edges, f, f.threshold))).toBe(-1);
    expect(unpackDiff(d.data, d.count).every((c) => targets[c.j] === 1)).toBe(true);
  });

  // The budget rule: one exact count per raw value of the key (max(r1, r2) for sign +, -min(r1, r2) for -,
  // max(|r1|, |r2|) for +-), then the smallest raw bound at or above the requested one whose count fits.
  describe.each(SIGNS)("budget, sign %i", (sign) => {
    const f: BuildFilter = { glyphNodes: glyphNodesFor(ds), targets: null, sign, threshold: 0.05 * A, maxThreshold: A };
    const lo0 = rawLo(conn, f.threshold);
    // every candidate entry with its key, in buffer order
    const candidates = refDiffRaw(conn, topo.edges, f, 1);
    const keys = candidates.map((e) => diffKey(e, sign));
    const sorted = Int32Array.from(keys).sort();
    /** number of entries whose key is at least `lo` (binary search in the sorted keys) */
    const countAt = (lo: number): number => {
      let a = 0, b = sorted.length;
      while (a < b) { const m = (a + b) >> 1; if (sorted[m] < lo) a = m + 1; else b = m; }
      return sorted.length - a;
    };
    const full = countAt(lo0);
    /** smallest raw bound >= lo0 whose count fits the budget, by trying them all (32768 holds nothing: no value reaches it) */
    const expectedLo = (budget: number): number => {
      let lo = lo0;
      while (lo < 32768 && countAt(lo) > budget) lo++;
      return lo;
    };
    // from generous to nothing, each budget once
    const budgets = [...new Set([1e9, full + 1, full, full - 1, Math.floor(full / 2), Math.floor(full / 5), Math.floor(full / 50), 20, 1, 0])]
      .filter((b) => b >= 0).sort((x, y) => y - x);

    it("has entries to work with", () => {
      // the fixtures without negative values have nothing to show for sign 1
      if (sign === 1 && !conn.data.some((v) => v < 0)) expect(full).toBe(0);
      else expect(full).toBeGreaterThan(100);
      // the binary search agrees with a plain count
      for (const lo of [1, lo0, rawLo(conn, 0.35 * A), 32767, 32768]) expect(countAt(lo)).toBe(keys.filter((k) => k >= lo).length);
    });

    it("keeps the requested threshold while the budget allows, else takes the smallest raw threshold that fits", () => {
      let prevThreshold = 0;
      for (const budget of budgets) {
        const d = buildDiffConnexels(conn, topo.edges, f, budget);
        const lo = expectedLo(budget);
        expect(d.threshold).toBeGreaterThanOrEqual(prevThreshold); // a smaller budget never lowers the threshold
        prevThreshold = d.threshold;
        if (lo === lo0) expect(d.threshold).toBe(f.threshold);
        else {
          expect(d.threshold).toBe(lo * conn.scale);
          expect(d.threshold).toBeGreaterThan(f.threshold);
          expect(countAt(lo - 1)).toBeGreaterThan(budget); // one raw step lower would not have fitted
        }
        expect(d.count).toBe(countAt(lo));
        expect(d.count).toBeLessThanOrEqual(budget);
        expect(d.data.byteLength).toBe(Math.max(1, d.count) * DIFF_STRIDE);
        expect(diffMismatch(d.data, d.count, refDiffRaw(conn, topo.edges, f, lo))).toBe(-1);
      }
    });

    it("counts the key, not the two endpoint values separately", () => {
      // an entry with both endpoints above the bound is one entry: the count equals a plain filter on the key
      for (const fraction of [0.05, 0.35, 0.613]) {
        const lo = rawLo(conn, fraction * A);
        expect(refDiffRaw(conn, topo.edges, f, lo).length).toBe(countAt(lo));
        expect(buildDiffConnexels(conn, topo.edges, { ...f, threshold: fraction * A }, 1e9).count).toBe(countAt(lo));
      }
    });

    it("does not apply the upper threshold, with or without a budget", () => {
      for (const budget of [1e9, Math.floor(full / 5)]) {
        const open = buildDiffConnexels(conn, topo.edges, f, budget);
        for (const maxThreshold of [0.5 * A, 0.06 * A, 0]) {
          const capped = buildDiffConnexels(conn, topo.edges, { ...f, maxThreshold }, budget);
          expect(capped.threshold).toBe(open.threshold);
          expect(capped.count).toBe(open.count);
          expect(diffMismatch(capped.data, capped.count, unpackDiff(open.data, open.count))).toBe(-1);
        }
      }
    });

    it("applies the budget to the restricted targets and glyph nodes only", () => {
      const targets = Uint8Array.from(ds.modules, (m) => (m % 2 ? 1 : 0));
      const nodes = glyphNodeSets(ds)[3].nodes; // every 5th node: few edges have both ends in it
      for (const g of [{ ...f, targets }, { ...f, glyphNodes: nodes }]) {
        const all = refDiffRaw(conn, topo.edges, g, 1).map((e) => diffKey(e, sign));
        const at = (lo: number) => { let c = 0; for (const k of all) if (k >= lo) c++; return c; };
        const budget = Math.floor(at(lo0) / 3);
        const d = buildDiffConnexels(conn, topo.edges, g, budget);
        const lo = d.threshold === g.threshold ? lo0 : Math.round(d.threshold / conn.scale);
        expect(d.count).toBe(at(lo));
        expect(d.count).toBeLessThanOrEqual(budget);
        if (lo > lo0) expect(at(lo - 1)).toBeGreaterThan(budget);
        expect(diffMismatch(d.data, d.count, refDiffRaw(conn, topo.edges, g, lo))).toBe(-1);
      }
    });
  });
});

describe("buildDiffConnexels at the end of the range", () => {
  // three nodes in a triangle, every connection at the maximum
  const conn = ConnMatrix.fromFull([0, 1, 1, 1, 0, 1, 1, 1, 0], 3);
  const edges = new Uint32Array([0, 1, 0, 2, 1, 2]);
  const f: BuildFilter = { glyphNodes: new Uint8Array([1, 1, 1]), targets: null, sign: 0, threshold: 0.5, maxThreshold: 1 };

  // Used to be a bug (before the histogram-based rule): when even threshold = maxAbs left more than `budget`
  // entries, all of them were written.
  it("never returns more entries than the budget: when even the largest value does not fit, nothing is kept", () => {
    expect(buildDiffConnexels(conn, edges, f, 1e9).count).toBe(3);
    expect(buildDiffConnexels(conn, edges, f, 3).count).toBe(3);
    const d = buildDiffConnexels(conn, edges, f, 2);
    expect(d.count).toBe(0);
    expect(d.threshold).toBeGreaterThan(conn.maxAbs); // one raw step above everything
    expect(d.threshold).toBeCloseTo(32768 * conn.scale, 12);
    expect(d.data.byteLength).toBe(DIFF_STRIDE);
  });

  it("accepts a fractional or negative budget", () => {
    expect(buildDiffConnexels(conn, edges, f, 3.7).count).toBe(3);
    expect(buildDiffConnexels(conn, edges, f, 2.999).count).toBe(0);
    expect(buildDiffConnexels(conn, edges, f, -5).count).toBe(0);
  });

  it("an empty edge list or an empty selection gives an empty set at the requested threshold", () => {
    for (const d of [buildDiffConnexels(conn, new Uint32Array(0), f, 10), buildDiffConnexels(conn, edges, { ...f, glyphNodes: new Uint8Array(3) }, 10)]) {
      expect(d.count).toBe(0);
      expect(d.threshold).toBe(0.5);
    }
  });
});

// ------------------------------------------------------------- connections

describe.each(FIXTURES)("createConnexels on $name", ({ make }) => {
  const ds = make();
  const conn = ds.conn;
  const A = conn.maxAbs;
  const display = ds.surfaces[ds.surfaces.length - 1].positions;
  const lengthPos = ds.surfaces[0].positions;

  function refPairs(f: BuildFilter, minLength: number): { i: number; j: number; value: number }[] {
    const lo = Math.max(1, Math.floor(f.threshold / conn.scale)), hi = Math.ceil(f.maxThreshold / conn.scale);
    const out: { i: number; j: number; value: number }[] = [];
    for (let i = 0; i < ds.n; i++) {
      for (let j = i + 1; j < ds.n; j++) {
        const raw = conn.data[i * ds.n + j];
        if (Math.abs(raw) < lo || Math.abs(raw) > hi || (raw > 0 ? f.sign === 1 : f.sign === 0)) continue;
        const forward = f.glyphNodes[i] && (!f.targets || f.targets[j]);
        const backward = f.glyphNodes[j] && (!f.targets || f.targets[i]);
        if (!forward && !backward) continue;
        if (!(distance(lengthPos, i, j) > minLength)) continue;
        out.push({ i, j, value: raw * conn.scale });
      }
    }
    return out;
  }

  describe.each(glyphNodeSets(ds))("$label", ({ nodes }) => {
    describe.each(targetSets(ds))("$label", ({ targets }) => {
      describe.each(SIGNS)("sign %i", (sign) => {
        it.each([[0.35, 0], [0.35, 30], [0.613, 0], [0.613, 60], [0.05, 90]])("threshold %f x maxAbs, minimum length %i mm", (fraction, minLength) => {
          const f: BuildFilter = { glyphNodes: nodes, targets, sign, threshold: fraction * A, maxThreshold: A };
          const ref = refPairs(f, minLength);
          const c = createConnexels(conn, f, display, lengthPos, minLength, 1e9);
          expect(c.truncated).toBe(false);
          expect(c.values.length).toBe(ref.length);
          expect(c.pairs.length).toBe(2 * ref.length);
          expect(c.edges.length).toBe(6 * ref.length);
          const seen = new Set<number>();
          let wrongPair = 0, duplicate = 0, wrongValue = 0, wrongEnd = 0, tooShort = 0;
          for (let k = 0; k < ref.length; k++) {
            const i = c.pairs[2 * k], j = c.pairs[2 * k + 1];
            if (i !== ref[k].i || j !== ref[k].j || i >= j) wrongPair++; // unordered pairs, each once, as i < j
            if (seen.has(i * ds.n + j)) duplicate++;
            seen.add(i * ds.n + j);
            if (Math.abs(c.values[k] - ref[k].value) > 1e-5 * A) wrongValue++;
            for (let q = 0; q < 3; q++) if (c.edges[6 * k + q] !== display[3 * i + q] || c.edges[6 * k + 3 + q] !== display[3 * j + q]) wrongEnd++;
            if (!(distance(lengthPos, i, j) > minLength)) tooShort++;
          }
          expect({ wrongPair, duplicate, wrongValue, wrongEnd, tooShort }).toEqual({ wrongPair: 0, duplicate: 0, wrongValue: 0, wrongEnd: 0, tooShort: 0 });
        });
      });
    });
  });

  it.each([1, 7, 40])("keeps the %i strongest when truncated", (limit) => {
    const f: BuildFilter = { glyphNodes: glyphNodesFor(ds), targets: null, sign: 2, threshold: 0.05 * A, maxThreshold: A };
    const ref = refPairs(f, 20);
    expect(ref.length).toBeGreaterThan(limit);
    const c = createConnexels(conn, f, display, lengthPos, 20, limit);
    expect(c.truncated).toBe(true);
    expect(c.values.length).toBe(limit);
    const all = new Map(ref.map((r) => [r.i * ds.n + r.j, r.value]));
    const kept = new Set<number>();
    for (let k = 0; k < limit; k++) {
      const key = c.pairs[2 * k] * ds.n + c.pairs[2 * k + 1];
      expect(all.has(key)).toBe(true);
      expect(c.values[k]).toBeCloseTo(all.get(key)!, 5);
      kept.add(key);
    }
    expect(kept.size).toBe(limit);
    const weakestKept = Math.min(...Array.from(c.values, Math.abs));
    const strongestDropped = Math.max(...ref.filter((r) => !kept.has(r.i * ds.n + r.j)).map((r) => Math.abs(r.value)));
    expect(weakestKept).toBeGreaterThanOrEqual(strongestDropped - 1e-6);
  });

  it("is not truncated when the limit equals the number of pairs", () => {
    const f: BuildFilter = { glyphNodes: glyphNodesFor(ds), targets: null, sign: 2, threshold: 0.613 * A, maxThreshold: A };
    const ref = refPairs(f, 0);
    const c = createConnexels(conn, f, display, lengthPos, 0, ref.length);
    expect(c.truncated).toBe(false);
    expect(c.values.length).toBe(ref.length);
  });
});

// ------------------------------------------------------ average connectivity

describe.each(FIXTURES)("averageConnectivity on $name", ({ make }) => {
  const ds = make();
  const conn = ds.conn;
  const n = ds.n;
  const fisherMean = (seeds: number[], i: number): number => {
    if (!seeds.length) return 0;
    let z = 0;
    const weights = conn.maxAbs > 1.0001; // not correlations: plain mean instead of Fisher's z
    for (const r of seeds) if (r !== i) z += weights ? conn.get(r, i) : Math.atanh(Math.min(0.999999, Math.max(-0.999999, conn.get(r, i))));
    return weights ? z / seeds.length : Math.tanh(z / seeds.length);
  };
  const seedSets: [string, number[]][] = [
    ["one seed", [3]],
    ["two seeds", [0, n - 1]],
    ["module 5", Array.from({ length: n }, (_, i) => i).filter((i) => ds.modules[i] === 5)],
    ["every node", Array.from({ length: n }, (_, i) => i)],
    ["no seed", []],
  ];

  it.each(seedSets)("%s: Fisher-z mean of the seed rows, the seed's own diagonal left out", (_label, seeds) => {
    const mask = new Uint8Array(n);
    for (const s of seeds) mask[s] = 1;
    const out = new Float32Array(n).fill(9);
    expect(averageConnectivity(conn, mask, out)).toBe(seeds.length);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(out[i] - fisherMean(seeds, i)));
    expect(worst).toBeLessThan(1e-5 * Math.max(1, conn.maxAbs));
  });

  it("a single seed reproduces its row (correlations) and maps itself to 0", () => {
    const seed = Math.floor(n / 3);
    const mask = new Uint8Array(n);
    mask[seed] = 1;
    const out = new Float32Array(n);
    averageConnectivity(conn, mask, out);
    expect(out[seed]).toBe(0);
    if (conn.maxAbs <= 1.0001) for (let i = 0; i < n; i++) if (i !== seed) expect(out[i]).toBeCloseTo(conn.get(seed, i), 4);
  });
});

describe("averageConnectivity closed forms", () => {
  it("averages r and -r to 0 and identical rows to themselves", () => {
    const conn = ConnMatrix.fromFull([1, 0, 0.6, -0.3, 0, 1, -0.6, -0.3, 0.6, -0.6, 1, 0, -0.3, -0.3, 0, 1], 4);
    const out = new Float32Array(4);
    expect(averageConnectivity(conn, new Uint8Array([1, 1, 0, 0]), out)).toBe(2);
    expect(out[2]).toBeCloseTo(0, 5);
    expect(out[3]).toBeCloseTo(-0.3, 4);
  });
  it("is not the arithmetic mean: tanh(mean(atanh r))", () => {
    const conn = ConnMatrix.fromFull([1, 0, 0.9, 0, 1, 0.1, 0.9, 0.1, 1], 3);
    const out = new Float32Array(3);
    averageConnectivity(conn, new Uint8Array([1, 1, 0]), out);
    expect(out[2]).toBeCloseTo(Math.tanh((Math.atanh(0.9) + Math.atanh(0.1)) / 2), 4);
    expect(out[2]).toBeGreaterThan(0.55);
  });
});

// ------------------------------------------------------------- larger data

describe(`builders on ${LARGE_FIXTURE.name} (2 x 642 nodes)`, () => {
  const ds = LARGE_FIXTURE.make();
  const conn = ds.conn;
  const nodes = glyphNodesFor(ds);

  it.each([[0.5, 0], [0.7, 0], [0.05, 1], [0.123, 2]] as [number, SignMode][])("threshold %f, sign %i: count and membership equal the brute force", (t, sign) => {
    const f: BuildFilter = { glyphNodes: nodes, targets: null, sign, threshold: t, maxThreshold: conn.maxAbs };
    const set = buildConnexels(conn, f);
    const ref = refBuildSet(conn, f);
    expect(set.count).toBe(ref.length);
    expect(firstMismatch(set.data, set.count, ref)).toBe(-1);
    expect(refConnexels(conn, f).length).toBeLessThanOrEqual(set.count);
  });

  it("recovers the network modules: at r > 0.7 every connexel stays within its module and hemisphere", () => {
    const set = buildConnexels(conn, { glyphNodes: nodes, targets: null, sign: 0, threshold: 0.7, maxThreshold: 1 });
    expect(set.count).toBeGreaterThan(10000);
    const u16 = new Uint16Array(set.data);
    let outside = 0;
    for (let k = 0; k < set.count; k++) {
      const i = u16[4 * k], j = u16[4 * k + 1];
      if (ds.modules[i] !== ds.modules[j] || (i < ds.hemiNodes) !== (j < ds.hemiNodes)) outside++;
    }
    expect(outside).toBe(0);
  });

  it("at 0.5 < r <= 0.7 every connexel is homotopic (other hemisphere, same module)", () => {
    const set = buildConnexels(conn, { glyphNodes: nodes, targets: null, sign: 0, threshold: 0.5, maxThreshold: 0.7 });
    const u16 = new Uint16Array(set.data);
    expect(set.count).toBeGreaterThan(10000);
    let wrong = 0;
    for (let k = 0; k < set.count; k++) {
      const i = u16[4 * k], j = u16[4 * k + 1];
      if (ds.modules[i] !== ds.modules[j] || (i < ds.hemiNodes) === (j < ds.hemiNodes)) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it("pies: every node gets one slice per module member, sorted by hue, ranks 0..count-1", () => {
    const set = buildConnexels(conn, { glyphNodes: nodes, targets: null, sign: 0, threshold: 0.7, maxThreshold: 1 });
    const col = ds.surfaces[0].positions;
    const sorted = sortForPies(set, ds.n, col, false);
    const u16 = new Uint16Array(sorted);
    const { ranks, maxCount, visible } = computePieRanks(sorted, set.nodeStart, ds.n, col, conn.scale, { threshold: 0.7, maxThreshold: 1, minLength: 0, sign: 0 });
    const size = new Uint32Array(8);
    for (let i = 0; i < ds.hemiNodes; i++) size[ds.modules[i]]++;
    expect(maxCount).toBe(Math.max(...size) - 1);
    expect(visible).toBe(2 * Array.from(size).reduce((s, m) => s + m * (m - 1), 0));
    for (let i = 0; i < ds.n; i += 37) {
      const s = set.nodeStart[i], e = set.nodeStart[i + 1];
      expect(e - s).toBe(size[ds.modules[i]] - 1);
      for (let k = s; k < e; k++) {
        expect(ranks[2 * k]).toBe(k - s);
        expect(ranks[2 * k + 1]).toBe(e - s);
        if (k > s) expect(hueKey(col, i, u16[4 * k + 1])).toBeLessThanOrEqual(hueKey(col, i, u16[4 * (k - 1) + 1]));
      }
    }
  });
});
