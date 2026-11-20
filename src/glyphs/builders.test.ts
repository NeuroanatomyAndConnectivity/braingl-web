import { describe, it, expect } from "vitest";
import { ConnMatrix, thresholdForBudget, fractionAbove } from "../data/connMatrix";
import { buildConnexels, sortForPies, computePieRanks, buildDiffConnexels, createConnexels, hue, averageConnectivity } from "./builders";

// 4 nodes on a line along x; symmetric matrix
const m = [
  1.0, 0.9, 0.5, -0.7,
  0.9, 1.0, 0.3, 0.1,
  0.5, 0.3, 1.0, 0.8,
  -0.7, 0.1, 0.8, 1.0,
];
const conn = ConnMatrix.fromFull(m, 4);
const pos = new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0, 30, 0, 0]);
const all = new Uint8Array(4).fill(1);

describe("ConnMatrix", () => {
  it("round-trips values within int16 precision", () => {
    expect(conn.get(0, 1)).toBeCloseTo(0.9, 4);
    expect(conn.get(3, 0)).toBeCloseTo(-0.7, 4);
  });
  it("unpacks an upper triangle", () => {
    const c = ConnMatrix.fromUpper(new Int8Array([127, 64, -89, 38, 13, 102]), 4, 1 / 127);
    expect(c.get(0, 1)).toBeCloseTo(1, 3);
    expect(c.get(1, 0)).toBeCloseTo(1, 3);
    expect(c.get(0, 3)).toBeCloseTo(-89 / 127, 3);
    expect(c.get(2, 3)).toBeCloseTo(102 / 127, 3);
    expect(c.get(2, 2)).toBe(0);
  });
  it("histogram ignores the diagonal and respects the sign", () => {
    const both = conn.cumulativeHistogram(null, 2);
    expect(both[0]).toBe(12);
    const posOnly = conn.cumulativeHistogram(null, 0);
    expect(posOnly[0]).toBe(10);
    expect(fractionAbove(posOnly, conn.maxAbs, 0.75)).toBeCloseTo(0.4, 5); // 0.9 and 0.8, both directions
    const t = thresholdForBudget(posOnly, conn.maxAbs, 4);
    expect(t).toBeGreaterThan(0.5);
    expect(t).toBeLessThanOrEqual(0.8);
  });
});

describe("buildConnexels", () => {
  it("keeps supra-threshold positive connexels and skips the diagonal", () => {
    const s = buildConnexels(conn, { glyphNodes: all, targets: null, sign: 0, threshold: 0.45, maxThreshold: 1 });
    expect(s.count).toBe(6); // (0,1) (0,2) (1,0) (2,0) (2,3) (3,2)
    expect(Array.from(s.nodeStart)).toEqual([0, 2, 3, 5, 6]);
    const u = new Uint16Array(s.data);
    expect([u[0], u[1]]).toEqual([0, 1]);
  });
  it("handles negative and both signs, ROI and target masks", () => {
    const neg = buildConnexels(conn, { glyphNodes: all, targets: null, sign: 1, threshold: 0.45, maxThreshold: 1 });
    expect(neg.count).toBe(2);
    const both = buildConnexels(conn, { glyphNodes: all, targets: null, sign: 2, threshold: 0.45, maxThreshold: 1 });
    expect(both.count).toBe(8);
    const roi = buildConnexels(conn, { glyphNodes: new Uint8Array([1, 0, 0, 0]), targets: new Uint8Array([0, 0, 1, 1]), sign: 2, threshold: 0.45, maxThreshold: 1 });
    expect(roi.count).toBe(2);
  });
});

describe("pies", () => {
  it("hue matches the HSV convention", () => {
    expect(hue(1, 0, 0)).toBeCloseTo(0);
    expect(hue(0, 1, 0)).toBeCloseTo(1 / 3);
    expect(hue(0, 0, 1)).toBeCloseTo(2 / 3);
    expect(hue(0.5, 0.5, 0.5)).toBe(-1);
  });
  it("sorts by value descending and ranks the visible slices", () => {
    const s = buildConnexels(conn, { glyphNodes: all, targets: null, sign: 0, threshold: 0.05, maxThreshold: 1 });
    const sorted = sortForPies(s, 4, pos, true);
    const i16 = new Int16Array(sorted);
    const first = [i16[2], i16[6], i16[10]].map((v) => v * conn.scale); // node 0: 0.9, 0.5 (and nothing else positive)
    expect(first[0]).toBeCloseTo(0.9, 3);
    expect(first[1]).toBeCloseTo(0.5, 3);
    const r = computePieRanks(sorted, s.nodeStart, 4, pos, conn.scale, { threshold: 0.45, maxThreshold: 1, minLength: 0, sign: 0 });
    expect(r.maxCount).toBe(2);
    expect(r.visible).toBe(6);
    expect([r.ranks[0], r.ranks[1], r.ranks[2], r.ranks[3]]).toEqual([0, 2, 1, 2]);
    const far = computePieRanks(sorted, s.nodeStart, 4, pos, conn.scale, { threshold: 0.45, maxThreshold: 1, minLength: 15, sign: 0 });
    expect(far.visible).toBe(2); // only 0<->2 (20 mm)
    expect(far.ranks[0]).toBe(0xffff);
  });
});

describe("diff glyphs and connexels", () => {
  it("keeps a target when either endpoint passes", () => {
    const edges = new Uint32Array([0, 1, 1, 2, 2, 3]);
    const d = buildDiffConnexels(conn, edges, { glyphNodes: all, targets: null, sign: 0, threshold: 0.45, maxThreshold: 1 }, 1e6);
    // edge 0-1: j=2 (0.5 | 0.3) -> 1 ; edge 1-2: j=0 (0.9|0.5), j=3 (0.1|0.8) -> 2 ; edge 2-3: j=0 (0.5|-0.7) -> 1
    expect(d.count).toBe(4);
  });
  it("raises the threshold to fit the budget", () => {
    const edges = new Uint32Array([0, 1, 1, 2, 2, 3]);
    const d = buildDiffConnexels(conn, edges, { glyphNodes: all, targets: null, sign: 0, threshold: 0.05, maxThreshold: 1 }, 2);
    expect(d.count).toBeLessThanOrEqual(2);
    expect(d.threshold).toBeGreaterThan(0.05);
  });
  it("creates unordered connexels above the minimum length", () => {
    const c = createConnexels(conn, { glyphNodes: all, targets: null, sign: 2, threshold: 0.45, maxThreshold: 1 }, pos, pos, 15, 100);
    // pairs: (0,1) 10mm no; (0,2) 20mm yes; (0,3) -0.7 30mm yes; (2,3) 10mm no
    expect(c.values.length).toBe(2);
    expect(Array.from(c.pairs)).toEqual([0, 2, 0, 3]);
    expect(c.edges[3]).toBe(20);
  });
  it("averages seed connectivity through Fisher z", () => {
    const out = new Float32Array(4);
    const k = averageConnectivity(conn, new Uint8Array([1, 1, 0, 0]), out);
    expect(k).toBe(2);
    expect(out[2]).toBeCloseTo(Math.tanh((Math.atanh(0.5) + Math.atanh(0.3)) / 2), 3);
  });
});
