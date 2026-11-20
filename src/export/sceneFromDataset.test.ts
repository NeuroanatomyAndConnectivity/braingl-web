/**
 * sceneFromDataset(): the headless description of a glyph scene, checked on
 * every synthetic example dataset against expectations computed here with
 * plain loops (flood fill for the brush, brute-force counts for the budget
 * and the connections).
 */
import { describe, it, expect } from "vitest";
import { sceneFromDataset } from "./sceneFromDataset";
import { bakeGlyphs, bakeGlyphScene } from "./bake";
import { defaultGlyphParams } from "../glyphs/params";
import { FIXTURES, FixtureDataset, icoBrain, weighted } from "../testing/fixtures";
import { distance, edgeSet, glyphNodesFor, refBuildSet, refConnexels, Sign } from "../testing/reference";

/** Flood fill along mesh edges through the nodes within `radius` of the start node. */
function refBrush(ds: FixtureDataset, surface: number, start: number, radius: number): Set<number> {
  const adj: number[][] = Array.from({ length: ds.n }, () => []);
  for (const e of edgeSet(ds.triangles)) {
    const [a, b] = e.split("-").map(Number);
    adj[a].push(b); adj[b].push(a);
  }
  const pos = ds.surfaces[surface].positions;
  const inside = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const a = queue.pop()!;
    for (const b of adj[a]) {
      if (inside.has(b) || distance(pos, start, b) > radius) continue;
      inside.add(b);
      queue.push(b);
    }
  }
  return inside;
}

const firstValid = (ds: FixtureDataset, from = 0): number => {
  for (let i = from; i < ds.n; i++) if (ds.mask[i]) return i;
  throw new Error("no valid node");
};

/** Unordered pairs that "make connections" keeps, with the int16 lower bound of the builders. */
function refPairs(ds: FixtureDataset, o: { glyphNodes: Uint8Array; targets: Uint8Array | null; sign: Sign; threshold: number; minLength: number; lengthPos: Float32Array }): { i: number; j: number; value: number }[] {
  const { n, data, scale } = ds.conn;
  const lo = Math.max(1, Math.floor(o.threshold / scale));
  const out: { i: number; j: number; value: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const raw = data[i * n + j];
      if (Math.abs(raw) < lo || (raw > 0 ? o.sign === 1 : o.sign === 0)) continue;
      const forward = o.glyphNodes[i] && (!o.targets || o.targets[j]), backward = o.glyphNodes[j] && (!o.targets || o.targets[i]);
      if (!forward && !backward) continue;
      if (!(distance(o.lengthPos, i, j) > o.minLength)) continue;
      out.push({ i, j, value: raw * scale });
    }
  }
  return out;
}

describe.each(FIXTURES)("sceneFromDataset on $name", ({ make }) => {
  const ds = make();
  const A = ds.conn.maxAbs;
  const n = ds.n;

  it("without a spec: the application defaults, every valid node a glyph node, nothing painted, no seed, no lines", () => {
    const s = sceneFromDataset(ds);
    expect(s.ds).toBe(ds);
    expect(Array.from(s.glyphNodes)).toEqual(Array.from(ds.mask));
    expect(s.labels.every((l) => l === 0)).toBe(true);
    expect(s.labelColors).toEqual([]);
    expect(s.targets).toBeNull();
    expect(s.seedRow).toBeNull();
    expect(s.cursorNode).toBe(-1);
    expect(s.lines).toBeNull();
    expect(s.primRadius).toBe(0.25);
    expect(s.maxPrims).toBe(400000);
    expect(s.budget).toBe(defaultGlyphParams.budgetM * 1e6);
    expect(s.params.glyphStyle).toBe("points");
    expect(s.params.surface).toBe(1);
    expect(s.params).not.toBe(defaultGlyphParams); // a copy: scenes do not leak into each other
    expect(s.topo.edges.length / 2).toBe(edgeSet(ds.triangles).size);
    expect(s.sphere === null).toBe(ds.surfaces.length < 3);
  });

  it("scales the value-dependent defaults to the range of matrices that are not correlations", () => {
    const s = sceneFromDataset(ds);
    const unit = ds.name.includes("weighted") ? 5 : 1;
    expect(A).toBeCloseTo(unit, 3);
    expect(s.params.threshold).toBeCloseTo(0.5 * unit, 3);
    expect(s.params.cmin).toBeCloseTo(-0.8 * unit, 3);
    expect(s.params.cmax).toBeCloseTo(0.8 * unit, 3);
    expect(s.params.seedLower).toBeCloseTo(0.2 * unit, 3);
    // the upper threshold defaults to the largest value of the matrix
    expect(s.params.maxThreshold).toBe(A);
    // values given in the spec are taken as they are
    const given = sceneFromDataset(ds, { params: { threshold: 0.3, cmin: -0.1, cmax: 0.4, seedLower: 0.05, maxThreshold: 0.7 * A } });
    expect([given.params.threshold, given.params.cmin, given.params.cmax, given.params.seedLower]).toEqual([0.3, -0.1, 0.4, 0.05]);
    expect(given.params.maxThreshold).toBe(0.7 * A);
    // ... except that thresholds cannot lie outside the data
    const beyond = sceneFromDataset(ds, { params: { threshold: 9 * A, maxThreshold: 7 * A } });
    expect(beyond.params.threshold).toBe(A);
    expect(beyond.params.maxThreshold).toBe(A);
  });

  it("paints one region per entry with the brush on the displayed surface", () => {
    const a = firstValid(ds), b = firstValid(ds, Math.floor(n / 2)), c = firstValid(ds, Math.floor(n / 2) + 7);
    for (const surface of [0, 1]) {
      const s = sceneFromDataset(ds, { params: { surface }, regions: [{ node: a, radius: 30 }, { node: b, radius: 22, color: "#123456" }, { node: c, radius: 0 }] });
      const want = new Uint8Array(n);
      [refBrush(ds, surface, a, 30), refBrush(ds, surface, b, 22), new Set([c])].forEach((set, k) => { for (const i of set) want[i] = k + 1; }); // later regions paint over earlier ones
      expect(Array.from(s.labels)).toEqual(Array.from(want));
      expect(s.labelColors).toEqual(["#ffb000", "#123456", "#ff4d6d"]);
      expect(s.labels[c]).toBe(3);
      // a brush of 30 mm reaches several nodes but not the whole mesh
      const size = refBrush(ds, surface, a, 30).size;
      expect(size).toBeGreaterThan(3);
      expect(size).toBeLessThan(n / 2);
    }
  });

  it("the brush does not jump to the other hemisphere", () => {
    if (!ds.leftNodes) return;
    const s = sceneFromDataset(ds, { params: { surface: 0 }, regions: [{ node: firstValid(ds), radius: 1000 }] });
    for (let i = 0; i < n; i++) expect(s.labels[i]).toBe(i < ds.leftNodes ? 1 : 0);
  });

  it("glyph nodes: data mask, hemisphere and 'painted' selection", () => {
    const seed = firstValid(ds, Math.floor(n / 3));
    const regions = [{ node: seed, radius: 35 }];
    const roi = Uint8Array.from({ length: n }, (_, i) => (refBrush(ds, 1, seed, 35).has(i) ? 1 : 0));
    for (const hemi of [0, 1, 2] as const) {
      expect(Array.from(sceneFromDataset(ds, { params: { hemi }, regions }).glyphNodes)).toEqual(Array.from(glyphNodesFor(ds, hemi)));
      const painted = sceneFromDataset(ds, { params: { hemi, glyphNodes: "painted" }, regions });
      expect(Array.from(painted.glyphNodes)).toEqual(Array.from(glyphNodesFor(ds, hemi, roi)));
      expect(Array.from(painted.labels)).toEqual(Array.from(roi)); // painting itself ignores the hemisphere selection
    }
    // painted mode without paint: no glyph node at all
    expect(sceneFromDataset(ds, { params: { glyphNodes: "painted" } }).glyphNodes.some((g) => g !== 0)).toBe(false);
    // masked nodes are never glyph nodes, painted or not
    const all = sceneFromDataset(ds, { params: { glyphNodes: "painted" }, regions: [{ node: seed, radius: 1e4 }] });
    for (let i = 0; i < n; i++) if (!ds.mask[i]) expect(all.glyphNodes[i]).toBe(0);
    if (ds.leftNodes) {
      const left = glyphNodesFor(ds, 1), right = glyphNodesFor(ds, 2);
      expect(left.subarray(ds.leftNodes).some((g) => g !== 0)).toBe(false);
      expect(right.subarray(0, ds.leftNodes).some((g) => g !== 0)).toBe(false);
    }
  });

  describe.each([
    { label: "positive", sign: 0 as Sign, hemi: 0 as const },
    { label: "both signs, right hemisphere", sign: 2 as Sign, hemi: 2 as const },
  ])("connexel budget ($label)", ({ sign, hemi }) => {
    const glyphNodes = glyphNodesFor(ds, hemi);
    const held = (threshold: number) => refBuildSet(ds.conn, { glyphNodes, sign, threshold, maxThreshold: A }).length;
    const total = held(A / 2000);

    it.each([0.02, 0.3, 0.75])("a budget of %f of the connexels raises the threshold in effect to the lowest one that fits", (fraction) => {
      const budget = Math.max(1, Math.floor(total * fraction));
      const s = sceneFromDataset(ds, { params: { budgetM: budget / 1e6, threshold: 0.011 * A, sign, hemi, minLength: 0 } });
      expect(s.budget).toBeCloseTo(budget, 6);
      // on the grid of the 2000-bin histogram
      const bin = Math.round((s.buildThreshold / A) * 2000);
      expect(s.buildThreshold).toBeCloseTo((bin / 2000) * A, 9);
      expect(bin).toBeGreaterThanOrEqual(1);
      // what the buffers would hold at that threshold fits the budget, one bin lower it does not
      expect(held(s.buildThreshold)).toBeLessThanOrEqual(budget);
      if (bin > 1 && bin < 2000) expect(held(((bin - 1) / 2000) * A)).toBeGreaterThan(budget);
      expect(s.buildThreshold).toBeGreaterThan(0.011 * A);
      expect(s.threshold).toBe(s.buildThreshold);
      expect(s.params.threshold).toBeCloseTo(0.011 * A, 12); // the slider value is kept
      // the bake uses the threshold in effect
      const layer = bakeGlyphs(s);
      const want = refConnexels(ds.conn, { glyphNodes, sign, threshold: s.buildThreshold, maxThreshold: A }).length;
      expect(layer!.positions.length / 3).toBe(want);
      expect(want).toBeLessThanOrEqual(budget);
    });

    it("a budget that holds everything leaves the threshold of the spec in effect", () => {
      const s = sceneFromDataset(ds, { params: { budgetM: (total + 1) / 1e6, threshold: 0.3 * A, sign, hemi } });
      expect(s.buildThreshold).toBeCloseTo(A / 2000, 9);
      expect(s.threshold).toBe(0.3 * A);
    });

    it("the budget does not depend on the upper threshold, and difference glyphs keep their own threshold", () => {
      const budget = Math.max(1, Math.floor(total * 0.3));
      const params = { budgetM: budget / 1e6, threshold: 0.011 * A, sign, hemi };
      const open = sceneFromDataset(ds, { params }), capped = sceneFromDataset(ds, { params: { ...params, maxThreshold: 0.5 * A } });
      expect(capped.buildThreshold).toBe(open.buildThreshold);
      expect(capped.threshold).toBe(open.threshold);
      expect(capped.params.maxThreshold).toBe(0.5 * A);
      const diff = sceneFromDataset(ds, { params: { ...params, glyphStyle: "diffpoints" } });
      expect(diff.buildThreshold).toBe(open.buildThreshold);
      expect(diff.threshold).toBeCloseTo(0.011 * A, 12);
    });
  });

  it("the seed row is the connectivity of the seed node, with the seed itself at the maximum", () => {
    const seed = firstValid(ds, 5);
    const s = sceneFromDataset(ds, { seedNode: seed });
    expect(s.cursorNode).toBe(seed);
    expect(s.seedRow!.length).toBe(n);
    for (let j = 0; j < n; j++) expect(s.seedRow![j]).toBeCloseTo(j === seed ? A : ds.values[seed * n + j], 3);
    expect(s.seedRow![seed]).toBe(Math.fround(A));
  });

  it("keeps -1 as the length surface, clamps the other surface indices and drops the polar geometry without a sphere", () => {
    const s = sceneFromDataset(ds, { params: { lengthSurface: -1, surface: 99, colorSurface: -3, secondSurface: 7, glyphGeometry: -1 } });
    const last = ds.surfaces.length - 1;
    expect(s.params.lengthSurface).toBe(-1);
    expect(s.params.surface).toBe(last);
    expect(s.params.colorSurface).toBe(0);
    expect(s.params.secondSurface).toBe(last);
    expect(s.params.glyphGeometry).toBe(s.sphere ? -1 : 0);
    expect(sceneFromDataset(ds, { params: { lengthSurface: 99, glyphGeometry: 99 } }).params.lengthSurface).toBe(last);
    expect(sceneFromDataset(ds, { params: { glyphGeometry: 99 } }).params.glyphGeometry).toBe(0);
    expect(() => bakeGlyphScene(s)).not.toThrow();
  });

  it("passes the target mask on to the bake", () => {
    const targets = Uint8Array.from(ds.modules, (m) => (m % 2 ? 1 : 0));
    const s = sceneFromDataset(ds, { targets, params: { threshold: 0.3 * A, minLength: 0, sign: 2 } });
    expect(s.targets).toBe(targets);
    const want = refConnexels(ds.conn, { glyphNodes: glyphNodesFor(ds), targets, sign: 2, threshold: 0.3 * A, maxThreshold: A });
    const without = refConnexels(ds.conn, { glyphNodes: glyphNodesFor(ds), sign: 2, threshold: 0.3 * A, maxThreshold: A });
    expect(bakeGlyphs(s)!.positions.length / 3).toBe(want.length);
    expect(want.length).toBeLessThan(without.length);
    expect(() => sceneFromDataset(ds, { targets: new Uint8Array(n + 1) })).toThrow(/target mask/);
  });

  describe.each([
    { label: "all nodes", hemi: 0 as const, sign: 0 as Sign, threshold: 0.3, minLength: 30, lengthSurface: 0, targets: false },
    { label: "left hemisphere, both signs, targets, length on the displayed surface", hemi: 1 as const, sign: 2 as Sign, threshold: 0.07, minLength: 45, lengthSurface: -1, targets: true },
  ])("connections without bundling ($label)", (c) => {
    const targets = c.targets ? Uint8Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 1 : 0)) : null;
    const params = { hemi: c.hemi, sign: c.sign, threshold: c.threshold * A, minLength: c.minLength, lengthSurface: c.lengthSurface };
    const want = refPairs(ds, {
      glyphNodes: glyphNodesFor(ds, c.hemi), targets, sign: c.sign, threshold: c.threshold * A, minLength: c.minLength,
      lengthPos: ds.surfaces[c.lengthSurface === -1 ? 1 : c.lengthSurface].positions,
    });

    it("one two-point line per unordered pair that passes in either direction and is long enough", () => {
      const s = sceneFromDataset(ds, { params, targets, connections: { max: 1e6, bundle: false } });
      const lines = s.lines!;
      expect(lines.values.length).toBe(want.length);
      expect(lines.offsets.length).toBe(want.length + 1);
      expect(lines.points.length).toBe(6 * want.length);
      const disp = ds.surfaces[1].positions; // drawn on the displayed surface
      want.forEach((w, k) => {
        if (lines.offsets[k] !== 2 * k) throw new Error(`offset ${k}`);
        for (let d = 0; d < 3; d++) {
          if (lines.points[6 * k + d] !== disp[3 * w.i + d] || lines.points[6 * k + 3 + d] !== disp[3 * w.j + d]) throw new Error(`line ${k} does not join nodes ${w.i} and ${w.j}`);
        }
        if (Math.abs(lines.values[k] - w.value) > 1e-6 * A) throw new Error(`line ${k}: value ${lines.values[k]}, expected ${w.value}`);
      });
      expect(lines.offsets[want.length]).toBe(2 * want.length);
      // every pair once: i < j
      if (c.label === "all nodes") expect(want.length).toBeGreaterThan(0);
    });

    it("keeps the strongest `max` pairs", () => {
      if (want.length < 4) return;
      const max = Math.floor(want.length / 3);
      const s = sceneFromDataset(ds, { params, targets, connections: { max, bundle: false } });
      expect(s.lines!.values.length).toBe(max);
      const strongest = want.map((w) => Math.abs(w.value)).sort((a, b) => b - a);
      const kept = Array.from(s.lines!.values, Math.abs).sort((a, b) => b - a);
      for (let k = 0; k < max; k++) expect(kept[k]).toBeCloseTo(strongest[k], 5);
    });
  });

  it("connections never go below the threshold in effect, and have no upper threshold (as brainGL's createConnections)", () => {
    const glyphNodes = glyphNodesFor(ds);
    const total = refBuildSet(ds.conn, { glyphNodes, sign: 2, threshold: A / 2000, maxThreshold: A }).length;
    const budget = Math.floor(total * 0.3);
    const s = sceneFromDataset(ds, { params: { budgetM: budget / 1e6, threshold: 0.011 * A, maxThreshold: 0.5 * A, sign: 2, minLength: 0 }, connections: { max: 1e6, bundle: false } });
    expect(s.threshold).toBeGreaterThan(0.011 * A);
    const want = refPairs(ds, { glyphNodes, targets: null, sign: 2, threshold: s.threshold, minLength: 0, lengthPos: ds.surfaces[0].positions });
    expect(s.lines!.values.length).toBe(want.length);
    expect(want.length).toBeLessThan(refPairs(ds, { glyphNodes, targets: null, sign: 2, threshold: 0.011 * A, minLength: 0, lengthPos: ds.surfaces[0].positions }).length);
    if (want.length) expect(Math.max(...Array.from(s.lines!.values, Math.abs))).toBeGreaterThan(0.5 * A);
    // with a tiny slider value the floor of 2 % of the largest value applies
    const low = sceneFromDataset(ds, { params: { threshold: 0, sign: 2, minLength: 0 }, connections: { max: 1e6, bundle: false } });
    expect(low.lines!.values.length).toBe(refPairs(ds, { glyphNodes, targets: null, sign: 2, threshold: Math.max(low.threshold, 0.02 * A), minLength: 0, lengthPos: ds.surfaces[0].positions }).length);
    for (const v of low.lines!.values) if (Math.abs(v) < 0.0199 * A) throw new Error(`a connection of ${v} is below 2 % of the largest value`);
  });

  it("a scene without connections has no lines, and its bake has no connection layer", () => {
    const s = sceneFromDataset(ds, { params: { threshold: 0.45 * A } });
    expect(bakeGlyphScene(s).map((l) => l.name)).toEqual([`surface ${ds.surfaces[1].name}`, "glyphs points"]);
    const c = sceneFromDataset(ds, { params: { threshold: 0.45 * A, minLength: 0, glyphStyle: "off" }, connections: { max: 50, bundle: false }, primRadius: 0.4, maxPrims: 123 });
    expect(c.primRadius).toBe(0.4);
    expect(c.maxPrims).toBe(123);
    const layers = bakeGlyphScene(c);
    expect(layers.map((l) => l.name)).toEqual([`surface ${ds.surfaces[1].name}`, "connections"]);
    expect(layers[1].edges!.length / 2).toBe(c.lines!.values.length);
  });
});

describe("sceneFromDataset: bundled connections", () => {
  it.each([["icoBrain(1)", () => icoBrain(1)], ["icoBrain(1)+weighted", () => weighted(icoBrain(1))]] as const)("%s: bundling keeps every connection, its value and its end points", (_name, make) => {
    const ds = make();
    const A = ds.conn.maxAbs;
    const params = { threshold: 0.5 * A, minLength: 60 };
    const straight = sceneFromDataset(ds, { params, connections: { max: 80, bundle: false } }).lines!;
    const bundled = sceneFromDataset(ds, { params, connections: { max: 80, bundle: true } }).lines!;
    const m = straight.values.length;
    expect(m).toBeGreaterThan(10);
    expect(m).toBeLessThanOrEqual(80);
    expect(bundled.values.length).toBe(m);
    expect(Array.from(bundled.values)).toEqual(Array.from(straight.values));
    expect(bundled.offsets.length).toBe(m + 1);
    expect(bundled.offsets[0]).toBe(0);
    expect(bundled.offsets[m]).toBe(bundled.points.length / 3);
    expect(bundled.points.every(Number.isFinite)).toBe(true);
    let bent = 0;
    for (let k = 0; k < m; k++) {
      const a = bundled.offsets[k], b = bundled.offsets[k + 1];
      expect(b - a).toBeGreaterThan(2); // subdivided
      for (let d = 0; d < 3; d++) {
        expect(bundled.points[3 * a + d]).toBeCloseTo(straight.points[6 * k + d], 3);
        expect(bundled.points[3 * (b - 1) + d]).toBeCloseTo(straight.points[6 * k + 3 + d], 3);
      }
      // distance of the middle point from the straight segment
      const mid = Math.floor((a + b) / 2);
      const p = [0, 1, 2].map((d) => bundled.points[3 * mid + d] - straight.points[6 * k + d]);
      const e = [0, 1, 2].map((d) => straight.points[6 * k + 3 + d] - straight.points[6 * k + d]);
      const t = (p[0] * e[0] + p[1] * e[1] + p[2] * e[2]) / (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
      if (Math.hypot(p[0] - t * e[0], p[1] - t * e[1], p[2] - t * e[2]) > 0.5) bent++;
    }
    expect(bent).toBeGreaterThan(0); // some lines were pulled together
    // the bake draws them as polylines
    const scene = sceneFromDataset(ds, { params: { ...params, glyphStyle: "off", surfaceAlpha: 0.25 }, connections: { max: 80, bundle: true }, primRadius: 0.35 });
    const layers = bakeGlyphScene(scene);
    expect(layers.map((l) => l.name)).toEqual(["surface inflated", "connections"]);
    expect(layers[0].opacity).toBe(0.25);
    expect(layers[1].edges!.length / 2).toBe(bundled.points.length / 3 - m);
    expect(layers[1].radius).toBeCloseTo(0.21, 12);
  });
});
