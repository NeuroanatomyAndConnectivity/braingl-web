/**
 * The Blender baker (CPU mirror of the glyph vertex shaders) against
 * brute-force expectations on every synthetic example dataset. The inputs are
 * assembled here by hand, so nothing depends on sceneFromDataset().
 */
import { describe, it, expect } from "vitest";
import { bakeGlyphs, bakeGlyphScene, bakeLines, bakeLittleBrains, bakeSurface, GlyphBakeInput } from "./bake";
import type { Layer } from "./ply";
import { buildTopology, findSphere, normaliseSulc } from "../data/dataset";
import { defaultGlyphParams, GlyphParams } from "../glyphs/params";
import type { Polylines } from "../algorithms/meanShiftBundling";
import { colormapLut } from "../render/colormaps";
import { ConnMatrix } from "../data/connMatrix";
import { BRAIN_SHAPE, directed, FIXTURES, FixtureDataset, icoBrain, weighted } from "../testing/fixtures";
import {
  at, cross, dot, edgeSet, glyphNodesFor, lutColor, norm, orientation, passesStrict, RefConnexel, refConnexels, refNormals, rotXYZ, Sign, sub, tangentFrame, V3,
} from "../testing/reference";

// ------------------------------------------------------------------ helpers

/** A bake input with the application defaults, glyph nodes from the data mask / hemisphere and no budget limit. */
function inputFor(ds: FixtureDataset, params: Partial<GlyphParams> = {}, extra: Partial<GlyphBakeInput> = {}): GlyphBakeInput {
  const p: GlyphParams = { ...defaultGlyphParams, maxThreshold: ds.conn.maxAbs, ...params };
  return {
    ds, topo: buildTopology(ds.n, ds.triangles), sphere: findSphere(ds), params: p,
    glyphNodes: glyphNodesFor(ds, p.hemi), targets: null, threshold: p.threshold, buildThreshold: 0, budget: 1e9,
    labels: new Uint8Array(ds.n), labelColors: [], seedRow: null, cursorNode: -1, lines: null, primRadius: 0.25, maxPrims: 1e9,
    ...extra,
  };
}

/** The connexels that are on screen for a bake input, in row order (the order of the exported primitives). */
function drawn(input: GlyphBakeInput): RefConnexel[] {
  const p = input.params;
  const lengthPos = input.ds.surfaces[p.lengthSurface === -1 ? p.surface : p.lengthSurface].positions;
  return refConnexels(input.ds.conn, {
    glyphNodes: input.glyphNodes, targets: input.targets, sign: p.sign, threshold: input.threshold, maxThreshold: p.maxThreshold,
    minLength: p.minLength, lengthPos,
  });
}

const add = (a: ArrayLike<number>, b: ArrayLike<number>, s = 1): V3 => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
const lift = (p: GlyphParams) => p.depthLift * p.glyphRadius * 100;

/** Glyph centre of node i: its position on the displayed surface, lifted along the vertex normal. */
function centreOf(input: GlyphBakeInput, normals: Float64Array, i: number): V3 {
  return add(at(input.ds.surfaces[input.params.surface].positions, i), at(normals, i), lift(input.params));
}

/** p_i + n_i * lift + rot * radius * (g_j - g_i) */
function expectedPoint(input: GlyphBakeInput, normals: Float64Array, i: number, j: number): V3 {
  const p = input.params;
  const geo = input.ds.surfaces[p.glyphGeometry].positions;
  let d: V3 = sub(at(geo, j), at(geo, i));
  if (p.rotationEnabled) d = rotXYZ(p.rotX, p.rotY, p.rotZ, d);
  return add(centreOf(input, normals, i), d, p.glyphRadius);
}

function expectClose(got: ArrayLike<number>, want: ArrayLike<number>, tol: number, label = ""): void {
  const d = Math.max(Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]), Math.abs(got[2] - want[2]));
  if (!(d <= tol)) throw new Error(`${label}: got [${Array.from(got).join(", ")}], expected [${Array.from(want).join(", ")}] (off by ${d})`);
}

/** Orientation colour as 8-bit values (the baker may round or truncate: allow one level). */
function expectOrientationColour(colors: Uint8Array, k: number, pos: Float32Array, i: number, j: number, label = ""): void {
  const o = orientation(pos, i, j);
  for (let c = 0; c < 3; c++) {
    if (Math.abs(colors[4 * k + c] - 255 * o[c]) > 1.001) throw new Error(`${label}: colour ${Array.from(colors.subarray(4 * k, 4 * k + 3))}, expected 255 x [${o}]`);
  }
  if (colors[4 * k + 3] !== 255) throw new Error(`${label}: alpha ${colors[4 * k + 3]}`);
}

/** Cheap assertion for inner loops (a vitest `expect` per vertex would dominate the run time). */
function check(cond: boolean, message: () => string): void {
  if (!cond) throw new Error(message());
}

/** Element-wise equality of two (typed) arrays, much faster than `toEqual` on a hundred thousand numbers. */
function expectSame(got: ArrayLike<number>, want: ArrayLike<number>, label = "array"): void {
  if (got.length !== want.length) throw new Error(`${label}: ${got.length} elements, expected ${want.length}`);
  for (let k = 0; k < got.length; k++) if (got[k] !== want[k]) throw new Error(`${label}: element ${k} is ${got[k]}, expected ${want[k]}`);
}

const rgbAt = (colors: Uint8Array, k: number): number[] => Array.from(colors.subarray(4 * k, 4 * k + 3));
const hexRgb = (hex: string): V3 => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
const smoothstep = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

interface Combo { label: string; params: Partial<GlyphParams>; targets?: (ds: FixtureDataset) => Uint8Array; roi?: (ds: FixtureDataset) => Uint8Array }

/** Filter combinations; thresholds are fractions of maxAbs that do not fall on an int16 level. */
const COMBOS: Combo[] = [
  { label: "defaults (positive, minimum length 20 mm)", params: { threshold: 0.45 } },
  { label: "low threshold, no minimum length", params: { threshold: 0.07, minLength: 0 } },
  { label: "high threshold", params: { threshold: 0.7, minLength: 0 } },
  { label: "negative values", params: { threshold: 0.07, sign: 1, minLength: 10 } },
  { label: "both signs with an upper threshold", params: { threshold: 0.07, maxThreshold: 0.613, sign: 2, minLength: 30 } },
  { label: "upper threshold only", params: { threshold: 0.35, maxThreshold: 0.78, minLength: 0 } },
  { label: "left hemisphere", params: { threshold: 0.45, hemi: 1, minLength: 15 } },
  { label: "right hemisphere, both signs", params: { threshold: 0.123, hemi: 2, sign: 2, minLength: 40 } },
  { label: "targets in modules 0-3", params: { threshold: 0.35, minLength: 0 }, targets: (ds) => Uint8Array.from(ds.modules, (m) => (m < 4 ? 1 : 0)) },
  { label: "ROI of every 5th node, targets every 3rd", params: { threshold: 0.07, sign: 2, minLength: 25 }, roi: (ds) => Uint8Array.from({ length: ds.n }, (_, i) => (i % 5 === 0 ? 1 : 0)), targets: (ds) => Uint8Array.from({ length: ds.n }, (_, i) => (i % 3 === 0 ? 1 : 0)) },
  { label: "length measured on the displayed surface", params: { threshold: 0.35, minLength: 45, lengthSurface: -1 } },
];

/** A combination as a bake input: the threshold fractions are scaled by maxAbs. */
function comboInput(ds: FixtureDataset, c: Combo, params: Partial<GlyphParams> = {}, extra: Partial<GlyphBakeInput> = {}): GlyphBakeInput {
  const A = ds.conn.maxAbs;
  const scaled: Partial<GlyphParams> = { ...c.params, threshold: (c.params.threshold ?? 0.5) * A, maxThreshold: (c.params.maxThreshold ?? 1) * A };
  const input = inputFor(ds, { ...scaled, ...params }, extra);
  if (c.roi) input.glyphNodes = glyphNodesFor(ds, input.params.hemi, c.roi(ds));
  if (c.targets) input.targets = c.targets(ds);
  return input;
}

// ------------------------------------------------------------ points, vectors

describe.each(FIXTURES)("bakeGlyphs points and vectors on $name", ({ make }) => {
  const ds = make();
  const normalsOf = new Map<number, Float64Array>();
  const normals = (surface: number) => {
    if (!normalsOf.has(surface)) normalsOf.set(surface, refNormals(ds.surfaces[surface].positions, ds.triangles));
    return normalsOf.get(surface)!;
  };

  describe.each(COMBOS)("$label", (combo) => {
    it("points: one vertex per connexel on screen, at p_i + n_i * lift + radius * (g_j - g_i)", () => {
      const input = comboInput(ds, combo, { glyphStyle: "points" });
      const ref = drawn(input);
      const layer = bakeGlyphs(input)!;
      expect(layer.kind).toBe("points");
      expect(layer.shading).toBe("flat");
      expect(layer.name).toBe("glyphs points");
      expect(layer.radius).toBe(0.25);
      expect(layer.truncated).toBe(false);
      expect(layer.edges).toBeUndefined();
      expect(layer.positions.length / 3).toBe(ref.length);
      expect(layer.colors.length).toBe(4 * ref.length);
      const nrm = normals(input.params.surface);
      const col = ds.surfaces[input.params.colorSurface].positions;
      ref.forEach((c, k) => {
        expectClose(layer.positions.subarray(3 * k, 3 * k + 3), expectedPoint(input, nrm, c.i, c.j), 2e-3, `connexel ${c.i} -> ${c.j}`);
        expectOrientationColour(layer.colors, k, col, c.i, c.j, `connexel ${c.i} -> ${c.j}`);
      });
    });

    it("vectors: two vertices and one edge per connexel, starting at the lifted node", () => {
      const input = comboInput(ds, combo, { glyphStyle: "vectors" }, { primRadius: 0.4 });
      const ref = drawn(input);
      const layer = bakeGlyphs(input)!;
      expect(layer.kind).toBe("segments");
      expect(layer.name).toBe("glyphs vectors");
      expect(layer.radius).toBeCloseTo(0.2, 12);
      expect(layer.positions.length / 3).toBe(2 * ref.length);
      expect(layer.edges!.length).toBe(2 * ref.length);
      const nrm = normals(input.params.surface);
      const col = ds.surfaces[input.params.colorSurface].positions;
      ref.forEach((c, k) => {
        check(layer.edges![2 * k] === 2 * k && layer.edges![2 * k + 1] === 2 * k + 1, () => `edge ${k} joins ${layer.edges![2 * k]} and ${layer.edges![2 * k + 1]}`);
        expectClose(layer.positions.subarray(6 * k, 6 * k + 3), centreOf(input, nrm, c.i), 2e-3, `node end of ${c.i} -> ${c.j}`);
        expectClose(layer.positions.subarray(6 * k + 3, 6 * k + 6), expectedPoint(input, nrm, c.i, c.j), 2e-3, `far end of ${c.i} -> ${c.j}`);
        expectOrientationColour(layer.colors, 2 * k, col, c.i, c.j);
        expectOrientationColour(layer.colors, 2 * k + 1, col, c.i, c.j);
      });
    });
  });

  it("the comparison is not vacuous: the combinations select different, non-empty sets", () => {
    const counts = COMBOS.map((c) => drawn(comboInput(ds, c)).length);
    expect(counts.filter((c) => c > 0).length).toBeGreaterThanOrEqual(ds.name.includes("anticorrelated") ? 8 : 6);
    expect(new Set(counts).size).toBeGreaterThanOrEqual(5);
  });

  it("applies the glyph rotation (Rx * Ry * Rz), the radius and the depth lift", () => {
    const params: Partial<GlyphParams> = { glyphStyle: "points", threshold: 0.6 * ds.conn.maxAbs, minLength: 0, rotationEnabled: true, rotX: 25, rotY: -40, rotZ: 70, glyphRadius: 0.11, depthLift: 0.35, surface: 0, glyphGeometry: 1 };
    const input = inputFor(ds, params);
    const ref = drawn(input);
    const layer = bakeGlyphs(input)!;
    expect(ref.length).toBeGreaterThan(0);
    expect(layer.positions.length / 3).toBe(ref.length);
    const nrm = normals(0);
    ref.forEach((c, k) => expectClose(layer.positions.subarray(3 * k, 3 * k + 3), expectedPoint(input, nrm, c.i, c.j), 2e-3));
    // the rotation matters: without it the points are elsewhere
    const plain = bakeGlyphs(inputFor(ds, { ...params, rotationEnabled: false }))!;
    let moved = 0;
    for (let k = 0; k < ref.length; k++) if (norm(sub(layer.positions.subarray(3 * k, 3 * k + 3), plain.positions.subarray(3 * k, 3 * k + 3))) > 0.05) moved++;
    expect(moved).toBeGreaterThan(ref.length / 2);
    // the angles are ignored while the rotation is switched off
    const off = bakeGlyphs(inputFor(ds, { ...params, rotationEnabled: false, rotX: 0, rotY: 0, rotZ: 0 }))!;
    expectSame(plain.positions, off.positions);
  });

  it("orientation colours come from the colour surface, value colours from the colour map", () => {
    const base: Partial<GlyphParams> = { glyphStyle: "points", threshold: 0.3 * ds.conn.maxAbs, sign: 2, minLength: 0, colorSurface: 1, glyphGeometry: 0 };
    const input = inputFor(ds, base);
    const ref = drawn(input);
    const layer = bakeGlyphs(input)!;
    ref.forEach((c, k) => expectOrientationColour(layer.colors, k, ds.surfaces[1].positions, c.i, c.j));
    // ... and differ from the colours of the other surface for most connexels
    const other = bakeGlyphs(inputFor(ds, { ...base, colorSurface: 0 }))!;
    let differ = 0;
    for (let k = 0; k < ref.length; k++) if (rgbAt(layer.colors, k).some((v, c) => Math.abs(v - other.colors[4 * k + c]) > 2)) differ++;
    expect(differ).toBeGreaterThan(ref.length / 2);

    const A = ds.conn.maxAbs;
    for (const [colormap, cmin, cmax] of [["cool - warm", -0.8 * A, 0.8 * A], ["viridis", 0.2 * A, 0.9 * A]] as const) {
      const byValue = bakeGlyphs(inputFor(ds, { ...base, glyphColorMode: 1, colormap, cmin, cmax }))!;
      const lut = colormapLut(colormap);
      expectSame(byValue.positions, layer.positions);
      ref.forEach((c, k) => {
        const want = lutColor(lut, c.value, cmin, cmax);
        check(rgbAt(byValue.colors, k).every((g, ch) => g === want[ch]) && byValue.colors[4 * k + 3] === 255, () => `connexel ${c.i} -> ${c.j} (value ${c.value}): colour ${rgbAt(byValue.colors, k)}, colour map ${want}`);
      });
    }
  });

  it("subsamples to maxPrims and says so", () => {
    for (const style of ["points", "vectors"] as const) {
      const params: Partial<GlyphParams> = { glyphStyle: style, threshold: 0.3 * ds.conn.maxAbs, minLength: 0 };
      const full = bakeGlyphs(inputFor(ds, params))!;
      const per = style === "vectors" ? 2 : 1;
      const count = full.positions.length / 3 / per;
      expect(count).toBeGreaterThan(20);
      expect(full.truncated).toBe(false);
      // a limit at or above the count changes nothing
      expect(bakeGlyphs(inputFor(ds, params, { maxPrims: count }))!.truncated).toBe(false);
      for (const maxPrims of [count - 1, Math.ceil(count / 3) + 1, 7]) {
        const cut = bakeGlyphs(inputFor(ds, params, { maxPrims }))!;
        const m = cut.positions.length / 3 / per;
        expect(cut.truncated).toBe(true);
        expect(m).toBeLessThanOrEqual(maxPrims);
        expect(m).toBeGreaterThan(maxPrims / 2 - 1); // the smallest stride that fits
        const stride = Math.ceil(count / maxPrims);
        expect(m).toBe(Math.ceil(count / stride));
        // every stride-th primitive of the full export, unchanged
        for (let o = 0; o < m; o++) {
          expectSame(cut.positions.subarray(3 * per * o, 3 * per * (o + 1)), full.positions.subarray(3 * per * o * stride, 3 * per * (o * stride + 1)), `primitive ${o}`);
          expectSame(cut.colors.subarray(4 * per * o, 4 * per * (o + 1)), full.colors.subarray(4 * per * o * stride, 4 * per * (o * stride + 1)), `colour of primitive ${o}`);
        }
        if (style === "vectors") expectSame(cut.edges!, Array.from({ length: 2 * m }, (_, k) => k), "edges");
      }
    }
  });

  it("the upper threshold is applied when baking: lowering and raising it again brings every primitive back", () => {
    const A = ds.conn.maxAbs;
    const input = inputFor(ds, { glyphStyle: "points", threshold: 0.07 * A, sign: 2, minLength: 0 });
    const all = bakeGlyphs(input)!;
    expect(all.positions.length / 3).toBe(drawn(input).length);
    input.params.maxThreshold = 0.5 * A;
    const fewer = bakeGlyphs(input)!;
    expect(fewer.positions.length / 3).toBe(drawn(input).length);
    expect(fewer.positions.length).toBeLessThan(all.positions.length);
    input.params.maxThreshold = A;
    const again = bakeGlyphs(input)!;
    expectSame(again.positions, all.positions);
    expectSame(again.colors, all.colors);
    // the strongest entries (|value| = maxAbs) are part of the export when the upper threshold is maxAbs
    const strongest = refConnexels(ds.conn, { glyphNodes: input.glyphNodes, sign: 2, threshold: 0.07 * A, maxThreshold: A }).filter((c) => Math.abs(c.raw) === 32767).length;
    const below = refConnexels(ds.conn, { glyphNodes: input.glyphNodes, sign: 2, threshold: 0.07 * A, maxThreshold: A * (1 - 1e-9) }).length;
    expect(all.positions.length / 3).toBe(below + strongest);
  });

  it("the threshold in effect, not the slider value, selects the primitives", () => {
    const A = ds.conn.maxAbs;
    // the connexel budget raised the threshold to 0.79 while the slider is at 0.07
    const input = inputFor(ds, { glyphStyle: "points", threshold: 0.07 * A, sign: 2, minLength: 0 }, { threshold: 0.79 * A, buildThreshold: 0.79 * A });
    expect(bakeGlyphs(input)!.positions.length / 3).toBe(drawn(input).length);
    expect(drawn(input).length).toBeLessThan(drawn(inputFor(ds, { threshold: 0.07 * A, sign: 2, minLength: 0 })).length);
  });

  it("measures the minimum length on the displayed surface when lengthSurface is -1", () => {
    const A = ds.conn.maxAbs;
    for (const style of ["points", "vectors"] as const) {
      const per = style === "vectors" ? 2 : 1;
      const params: Partial<GlyphParams> = { glyphStyle: style, threshold: 0.3 * A, minLength: 45, surface: 1 };
      const displayed = bakeGlyphs(inputFor(ds, { ...params, lengthSurface: -1 }))!;
      const explicit = bakeGlyphs(inputFor(ds, { ...params, lengthSurface: 1 }))!;
      const pial = bakeGlyphs(inputFor(ds, { ...params, lengthSurface: 0 }))!;
      const count = (lengthPos: Float32Array) => refConnexels(ds.conn, { glyphNodes: glyphNodesFor(ds), sign: 0, threshold: 0.3 * A, maxThreshold: A, minLength: 45, lengthPos }).length;
      expect(displayed.positions.length / 3 / per).toBe(count(ds.surfaces[1].positions));
      expectSame(displayed.positions, explicit.positions);
      expect(pial.positions.length / 3 / per).toBe(count(ds.surfaces[0].positions));
      // the inflated surface is larger than the pial one, so more connexels are long enough on it
      expect(count(ds.surfaces[1].positions)).toBeGreaterThan(count(ds.surfaces[0].positions));
    }
  });

  it("returns nothing for the style 'off' and an empty layer when no connexel passes", () => {
    expect(bakeGlyphs(inputFor(ds, { glyphStyle: "off" }))).toBeNull();
    const none = bakeGlyphs(inputFor(ds, { glyphStyle: "points", threshold: ds.conn.maxAbs }))!;
    expect(none.positions.length).toBe(0);
    expect(none.colors.length).toBe(0);
  });
});

// ----------------------------------------------------------------------- pies

describe.each(FIXTURES)("bakeGlyphs pies on $name", ({ make }) => {
  const ds = make();
  const A = ds.conn.maxAbs;
  const WEDGES = 48;
  /** A wedge is one flat triangle: a pie of one or two slices (a disc, two half discs) is cut into 24 wedges. */
  const wedgesFor = (count: number) => (count < 3 ? 24 : Math.min(WEDGES, count));
  let smallPies = 0;

  describe.each([
    { label: "normalisation 0, many slices", normalization: 0, threshold: 0.07, sign: 2 as Sign, minLength: 0, hemi: 0 as const },
    { label: "normalisation 1", normalization: 1, threshold: 0.45, sign: 0 as Sign, minLength: 20, hemi: 0 as const },
    { label: "normalisation 1, few slices, upper threshold", normalization: 1, threshold: 0.7, sign: 2 as Sign, minLength: 35, hemi: 0 as const, maxThreshold: 0.83 },
    { label: "normalisation 0.5, left hemisphere, length on the displayed surface", normalization: 0.5, threshold: 0.35, sign: 0 as Sign, minLength: 40, hemi: 1 as const, lengthSurface: -1 },
  ])("$label", (c) => {
    const input = inputFor(ds, {
      glyphStyle: "pies", normalization: c.normalization, threshold: c.threshold * A, maxThreshold: (c.maxThreshold ?? 1) * A, sign: c.sign, minLength: c.minLength, hemi: c.hemi,
      lengthSurface: c.lengthSurface ?? 0, glyphRadius: 0.04, depthLift: 0.8,
    });
    const p = input.params;
    const ref = drawn(input);
    const perNode = new Map<number, RefConnexel[]>();
    for (const r of ref) perNode.set(r.i, [...(perNode.get(r.i) ?? []), r]);
    const maxCount = Math.max(0, ...[...perNode.values()].map((l) => l.length));
    const nrm = refNormals(ds.surfaces[p.surface].positions, ds.triangles);
    const R100 = p.glyphRadius * 100;
    /** expected centre and radius of the pie of every node with at least one slice */
    const pies = new Map<number, { centre: V3; radius: number; count: number }>();
    for (const [i, list] of perNode) {
      const rel = list.length / maxCount;
      const h = lift(p) + R100 * (1 - rel) * 0.05; // smaller pies sit slightly above larger ones
      pies.set(i, { centre: add(at(ds.surfaces[p.surface].positions, i), at(nrm, i), h), radius: (p.normalization * Math.sqrt(rel) + (1 - p.normalization)) * R100, count: list.length });
    }
    // expected centres in a 0.5 mm grid (the nodes of the fixtures are several millimetres apart)
    const cell = (v: ArrayLike<number>, dx = 0, dy = 0, dz = 0) => `${Math.floor(v[0] * 2) + dx},${Math.floor(v[1] * 2) + dy},${Math.floor(v[2] * 2) + dz}`;
    const byCentre = new Map<string, number>();
    for (const [i, pie] of pies) byCentre.set(cell(pie.centre), i);
    const nodeAt = (v: ArrayLike<number>): number | undefined => {
      for (const dx of [0, -1, 1]) for (const dy of [0, -1, 1]) for (const dz of [0, -1, 1]) {
        const i = byCentre.get(cell(v, dx, dy, dz));
        if (i !== undefined && norm(sub(v, pies.get(i)!.centre)) < 2e-3) return i;
      }
      return undefined;
    };
    const layer = bakeGlyphs(input)!;
    const nTri = layer.positions.length / 9;
    /** triangles of every node, found through their first (centre) vertex */
    const wedges = new Map<number, number[]>();
    let unmatched = 0;
    for (let t = 0; t < nTri; t++) {
      const i = nodeAt(layer.positions.subarray(9 * t, 9 * t + 3));
      if (i === undefined) { unmatched++; continue; }
      if (!wedges.has(i)) wedges.set(i, []);
      wedges.get(i)!.push(t);
    }

    it("is a flat triangle mesh with three own vertices per wedge", () => {
      expect(layer.kind).toBe("mesh");
      expect(layer.shading).toBe("flat");
      expect(layer.smooth).toBe(false);
      expect(layer.name).toBe("glyphs pies");
      expect(Number.isInteger(nTri)).toBe(true);
      expect(Array.from(layer.triangles!)).toEqual(Array.from({ length: 3 * nTri }, (_, k) => k));
      expect(layer.colors.length).toBe(12 * nTri);
      if (c.threshold < 0.7) expect(pies.size).toBeGreaterThan(0); // the comparisons below are not vacuous
    });

    it("has a pie at exactly the nodes with at least one connexel on screen", () => {
      expect(unmatched).toBe(0); // every wedge starts at the lifted centre of such a node
      expect([...wedges.keys()].sort((a, b) => a - b)).toEqual([...pies.keys()].sort((a, b) => a - b));
    });

    it("resamples every pie to at most 48 wedges: one per connexel below that, 24 for a pie of one or two slices", () => {
      for (const [i, list] of wedges) {
        check(list.length <= WEDGES, () => `node ${i}: ${list.length} wedges`);
        check(list.length === wedgesFor(pies.get(i)!.count), () => `node ${i}: ${list.length} wedges for ${pies.get(i)!.count} connexels`);
      }
      if (c.threshold < 0.1 && ds.n > 100) expect(Math.max(...[...pies.values()].map((q) => q.count))).toBeGreaterThan(WEDGES); // the cap is exercised
    });

    it("every wedge lies in the tangent plane of its node, on the circle of the normalisation formula, and the wedges close the circle", () => {
      for (const [i, list] of wedges) {
        const { centre, radius, count } = pies.get(i)!;
        const n = at(nrm, i);
        const W = wedgesFor(count);
        // one triangle per wedge: its outer corners are the ends of the arc
        const want = (2 * Math.PI) / W;
        for (const t of list) {
          const a = sub(layer.positions.subarray(9 * t + 3, 9 * t + 6), centre), b = sub(layer.positions.subarray(9 * t + 6, 9 * t + 9), centre);
          for (const v of [a, b]) {
            check(Math.abs(dot(v, n)) < 2e-3, () => `node ${i}: wedge corner ${dot(v, n)} mm off the tangent plane`);
            check(Math.abs(norm(v) - radius) < 2e-3, () => `node ${i}: wedge corner at ${norm(v)} mm, radius ${radius}`);
          }
          const wedge = Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (norm(a) * norm(b)))));
          check(Math.abs(wedge - want) < 2e-3, () => `node ${i}: wedge of ${wedge} rad, expected ${want}`);
        }
        // the wedges follow each other around the circle: the end of one is the start of the next
        const ends = list.map((t) => Array.from(layer.positions.subarray(9 * t + 6, 9 * t + 9)));
        const starts = list.map((t) => Array.from(layer.positions.subarray(9 * t + 3, 9 * t + 6)));
        for (const e of ends) check(starts.some((st) => norm(sub(st, e)) < 2e-3), () => `node ${i}: a wedge is not followed by another one`);
      }
    });

    it("stays within glyph radius x 100 of the node and is largest where the node has the most connexels", () => {
      expect(unmatched).toBe(0);
      let largest = 0;
      for (const [i, pie] of pies) {
        check(pie.radius <= R100 + 1e-9, () => `node ${i}: radius ${pie.radius}`);
        if (p.normalization === 0) check(Math.abs(pie.radius - R100) < 1e-9, () => `node ${i}: radius ${pie.radius}, expected the constant ${R100}`);
        if (p.normalization === 1) check(Math.abs(pie.radius - R100 * Math.sqrt(pie.count / maxCount)) < 1e-9, () => `node ${i}: area not proportional to the count`);
        if (pie.count === maxCount) largest = Math.max(largest, pie.radius);
        const t = wedges.get(i)![0];
        const reach = norm(sub(layer.positions.subarray(9 * t + 3, 9 * t + 6), at(ds.surfaces[p.surface].positions, i)));
        check(reach <= Math.hypot(R100, lift(p) + 0.05 * R100) + 2e-3, () => `node ${i}: wedge corner ${reach} mm from the node`);
      }
      if (pies.size) expect(largest).toBeCloseTo(R100, 9); // the node with the most connexels has the full radius
    });

    it("colours the wedges of small pies with the orientation colours of their connexels", () => {
      const col = ds.surfaces[p.colorSurface].positions;
      let checked = 0, small = 0;
      for (const [i, list] of wedges) {
        const cons = perNode.get(i)!;
        if (cons.length > WEDGES) continue;
        // 8-bit colours are truncated; the order around the pie (by hue) is covered by the tests of sortForPies
        const slices = cons.map((c) => orientation(col, c.i, c.j).map((v) => Math.floor(v * 255)).join("/"));
        // every slice covers the same number of wedges: 1, or 24 / 12 in a pie of one / two slices
        const per = wedgesFor(cons.length) / cons.length;
        const want = slices.flatMap((rgb) => Array.from({ length: per }, () => rgb)).sort();
        const inOrder = list.map((t) => {
          const rgb = rgbAt(layer.colors, 3 * t).join("/");
          check(rgbAt(layer.colors, 3 * t + 1).join("/") === rgb && rgbAt(layer.colors, 3 * t + 2).join("/") === rgb, () => `node ${i}: a wedge has more than one colour`);
          return rgb;
        });
        expect([...inOrder].sort()).toEqual(want);
        // the wedges of one slice lie next to each other: around the pie the colour changes once per slice at most
        if (per > 1) check(inOrder.filter((rgb, q) => q > 0 && rgb !== inOrder[q - 1]).length <= cons.length - 1, () => `node ${i}: the wedges of a slice are scattered: ${inOrder}`);
        checked++;
        if (cons.length < 3) small++;
      }
      if (c.threshold >= 0.45 && pies.size > 0) expect(checked).toBeGreaterThan(0);
      smallPies += small;
    });
  });

  it("pies of one or two slices occur in these cases (as discs of 24 wedges)", () => {
    // collected by the colour test of the cases above, which run first
    if (ds.n > 100) expect(smallPies).toBeGreaterThan(0);
  });

  it("an upper threshold of maxAbs keeps the strongest connexels in the pies", () => {
    // only the |value| = maxAbs entries pass
    const input = inputFor(ds, { glyphStyle: "pies", threshold: A * (1 - 1e-6), sign: 2, minLength: 0 });
    const perNode = new Map<number, number>();
    for (const c of drawn(input)) perNode.set(c.i, (perNode.get(c.i) ?? 0) + 1);
    const layer = bakeGlyphs(input)!;
    expect(layer.positions.length / 9).toBe([...perNode.values()].reduce((sum, count) => sum + wedgesFor(count), 0));
  });
});

// ---------------------------------------------------------- polar projection

describe.each(FIXTURES.filter((f) => findSphere(f.make())))("bakeGlyphs polar projection on $name", ({ make }) => {
  const ds = make();
  const A = ds.conn.maxAbs;
  const m = ds.hemiNodes;

  it.each([
    { label: "all nodes", hemi: 0 as const, threshold: 0.45 },
    { label: "right hemisphere, both signs", hemi: 2 as const, threshold: 0.07 },
  ])("$label: an azimuthal equidistant map per hemisphere in the tangent plane of the node", ({ hemi, threshold }) => {
    const input = inputFor(ds, { glyphStyle: "points", glyphGeometry: -1, threshold: threshold * A, sign: 2, minLength: 0, hemi, glyphRadius: 0.05 });
    expect(input.sphere).not.toBeNull();
    const p = input.params;
    const ref = drawn(input);
    const layer = bakeGlyphs(input)!;
    expect(layer.positions.length / 3).toBe(ref.length);
    expect(ref.length).toBeGreaterThan(0);
    const nrm = refNormals(ds.surfaces[p.surface].positions, ds.triangles);
    const s = p.glyphRadius * 100;
    /** direction of a node on its sphere, in the coordinates of the left hemisphere */
    const dirOf = (i: number): V3 => [ds.unit[3 * i], ds.unit[3 * i + 1], ds.unit[3 * i + 2]];
    let left = 0, right = 0, antipodal = 0;
    ref.forEach((c, k) => {
      const centre = centreOf(input, nrm, c.i);
      const n = at(nrm, c.i);
      const frame = tangentFrame(n);
      const d = sub(layer.positions.subarray(3 * k, 3 * k + 3), centre);
      const where = () => `connexel ${c.i} -> ${c.j}`;
      check(Math.abs(dot(d, n)) < 2e-3, () => `${where()}: ${dot(d, n)} mm off the tangent plane`);
      check(norm(d) <= s + 2e-3, () => `${where()}: ${norm(d)} mm from the lifted centre, radius x 100 = ${s}`);
      const x = dot(d, frame.right) / s, y = dot(d, frame.up) / s;
      const targetRight = c.j >= m;
      // targets of the left hemisphere in the left half-disc, of the right one in the right half-disc
      check(targetRight ? x >= -1e-4 : x <= 1e-4, () => `${where()}: x = ${x} is in the wrong half-disc`);
      if (targetRight) right++; else left++;
      // Azimuthal equidistant projection (Boettger et al. 2013, eq. 2), two small discs: the distance from the centre
      // of the target's disc is angle(node, target) / pi x 0.5. In the fixture a right-hemisphere node is the mirror
      // image of its left twin, so the angle to a target in the other hemisphere (measured from the homotopic point)
      // is the angle between the two `unit` directions as they are.
      const a = dirOf(c.i), b = dirOf(c.j);
      const cos = Math.min(1, Math.max(-1, dot(a, b)));
      const angle = Math.acos(cos);
      if (angle > Math.PI - 1e-3) { antipodal++; return; } // the direction to the antipode is undefined
      const r = Math.hypot(x - (targetRight ? 0.5 : -0.5), y);
      check(Math.abs(r - (0.5 * angle) / Math.PI) < 1e-3, () => `${where()}: ${r} from the disc centre, expected ${(0.5 * angle) / Math.PI}`);
      // "up" in the disc is superior (+z) on the sphere: y = r * (b_z - cos * a_z) / (sin * sqrt(1 - a_z^2))
      if (angle > 1e-3) {
        const wantY = (((0.5 * angle) / Math.PI) * (b[2] - cos * a[2])) / (Math.sin(angle) * Math.sqrt(1 - a[2] * a[2]));
        check(Math.abs(y - wantY) < 1e-3, () => `${where()}: y = ${y}, expected ${wantY}`);
        // "right" in the disc is up x outward = (z x a) / |z x a|; the map of the right hemisphere is its mirror image
        const wantX = (((0.5 * angle) / Math.PI) * (a[0] * b[1] - a[1] * b[0])) / (Math.sin(angle) * Math.hypot(a[0], a[1])) * (targetRight ? -1 : 1);
        check(Math.abs(x - (targetRight ? 0.5 : -0.5) - wantX) < 1e-3, () => `${where()}: x = ${x - (targetRight ? 0.5 : -0.5)} from the disc centre, expected ${wantX}`);
      }
    });
    expect(antipodal).toBeLessThan(ref.length / 4);
    if (ds.name.startsWith("icoBrain(2)") && hemi === 0) { expect(left).toBeGreaterThan(0); expect(right).toBeGreaterThan(0); }
  });

  it("the discs are oriented as the hemispheres appear in a lateral view: anterior targets toward the face", () => {
    const input = inputFor(ds, { glyphStyle: "points", glyphGeometry: -1, threshold: 0.07 * A, sign: 2, minLength: 0, glyphRadius: 0.05 });
    const ref = drawn(input);
    const layer = bakeGlyphs(input)!;
    const nrm = refNormals(ds.surfaces[input.params.surface].positions, ds.triangles);
    const s = input.params.glyphRadius * 100;
    // the most lateral node of the left hemisphere (unit x nearest to -1) and its mirror image
    let lateral = 0;
    for (let i = 1; i < m; i++) if (ds.unit[3 * i] < ds.unit[3 * lateral]) lateral = i;
    let seen = 0;
    ref.forEach((c, k) => {
      if (c.i % m !== lateral || c.i >= m !== c.j >= m) return; // same hemisphere only
      const a = [ds.unit[3 * c.i], ds.unit[3 * c.i + 1], ds.unit[3 * c.i + 2]], b = [ds.unit[3 * c.j], ds.unit[3 * c.j + 1], ds.unit[3 * c.j + 2]];
      // nearby targets that are clearly more anterior
      if (dot(a, b) < Math.cos((50 * Math.PI) / 180) || b[1] - a[1] < 0.25) return;
      const right = c.j >= m;
      const x = dot(sub(layer.positions.subarray(3 * k, 3 * k + 3), centreOf(input, nrm, c.i)), tangentFrame(at(nrm, c.i)).right) / s - (right ? 0.5 : -0.5);
      // seen from the left the face is on the left of the image, seen from the right on the right
      check(right ? x > 0 : x < 0, () => `connexel ${c.i} -> ${c.j}: x = ${x} in the ${right ? "right" : "left"} disc`);
      seen++;
    });
    expect(seen).toBeGreaterThanOrEqual(2);
  });

  it("ignores the glyph rotation and the glyph geometry surface", () => {
    const params: Partial<GlyphParams> = { glyphStyle: "points", glyphGeometry: -1, threshold: 0.45 * A, minLength: 0 };
    const a = bakeGlyphs(inputFor(ds, params))!;
    const b = bakeGlyphs(inputFor(ds, { ...params, rotationEnabled: true, rotX: 30, rotZ: 50 }))!;
    expectSame(b.positions, a.positions);
  });

  it("falls back to the scaled surface copy when the dataset has no sphere", () => {
    const input = inputFor(ds, { glyphStyle: "points", glyphGeometry: -1, threshold: 0.6 * A, minLength: 0 }, { sphere: null });
    const layer = bakeGlyphs(input)!;
    const nrm = refNormals(ds.surfaces[input.params.surface].positions, ds.triangles);
    const plain = { ...input, params: { ...input.params, glyphGeometry: 0 } };
    drawn(input).forEach((c, k) => expectClose(layer.positions.subarray(3 * k, 3 * k + 3), expectedPoint(plain, nrm, c.i, c.j), 2e-3));
  });
});

// ---------------------------------------------------------- difference glyphs

interface RefDiff { a: number; b: number; j: number; diff: number }

/**
 * The contract of the difference glyphs, as plain loops over the float values:
 * prefilter max(buildThreshold / 2, 0.15 maxAbs) on either endpoint (lowered
 * resolution never: raised until the count fits the budget), then
 * diff > threshold && diff <= maxThreshold and the minimum length from the
 * edge midpoint.
 */
function refDiffs(input: GlyphBakeInput): { kept: RefDiff[]; prefiltered: number } {
  const { ds, params: p } = input;
  const { n, data, scale, maxAbs } = ds.conn;
  const fisher = maxAbs <= 1.0001;
  const z = (r: number) => Math.atanh(Math.min(0.999999, Math.max(-0.999999, r)));
  const key = (va: number, vb: number) => (p.sign === 0 ? Math.max(va, vb) : p.sign === 1 ? -Math.min(va, vb) : Math.max(Math.abs(va), Math.abs(vb)));
  const edges = [...edgeSet(ds.triangles)].map((e) => e.split("-").map(Number)).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const candidates: { a: number; b: number; j: number; key: number }[] = [];
  for (const [a, b] of edges) {
    if (!input.glyphNodes[a] || !input.glyphNodes[b]) continue;
    for (let j = 0; j < n; j++) {
      if (j === a || j === b || (input.targets && !input.targets[j])) continue;
      const k = key(data[a * n + j], data[b * n + j]);
      if (k > 0) candidates.push({ a, b, j, key: k });
    }
  }
  let lo = Math.max(1, Math.floor(Math.max(input.buildThreshold * 0.5, maxAbs * 0.15) / scale));
  const atLeast = new Float64Array(32770); // atLeast[q] = candidates with key >= q
  for (const c of candidates) atLeast[c.key]++;
  for (let q = 32767; q >= 0; q--) atLeast[q] += atLeast[q + 1];
  while (lo < 32768 && atLeast[lo] > input.budget) lo++;
  const pre = candidates.filter((c) => c.key >= lo);
  const len = ds.surfaces[p.lengthSurface === -1 ? p.surface : p.lengthSurface].positions;
  const kept: RefDiff[] = [];
  for (const { a, b, j } of pre) {
    const v1 = data[a * n + j] * scale, v2 = data[b * n + j] * scale;
    const diff = fisher ? Math.tanh(Math.abs(z(v1) - z(v2))) : Math.abs(v1 - v2);
    if (!(diff > input.threshold && diff <= p.maxThreshold)) continue;
    const mid = [0, 1, 2].map((c) => 0.5 * (len[3 * a + c] + len[3 * b + c]));
    if (!(norm(sub(mid, at(len, j))) > p.minLength)) continue;
    kept.push({ a, b, j, diff });
  }
  return { kept, prefiltered: pre.length };
}

describe.each(FIXTURES)("bakeGlyphs difference glyphs on $name", ({ make }) => {
  const ds = make();
  const A = ds.conn.maxAbs;
  const fisher = A <= 1.0001;

  it("fixture check: correlations are compared after Fisher's transform, other weights directly", () => {
    expect(fisher).toBe(!ds.name.includes("weighted"));
  });

  describe.each([
    { label: "defaults of the style", threshold: 0.2, minLength: 0, sign: 0 as Sign, hemi: 0 as const },
    { label: "higher threshold, minimum length", threshold: 0.5, minLength: 30, sign: 0 as Sign, hemi: 0 as const },
    { label: "both signs, upper threshold", threshold: 0.123, minLength: 0, sign: 2 as Sign, hemi: 0 as const, maxThreshold: 0.613 },
    { label: "negative values", threshold: 0.123, minLength: 10, sign: 1 as Sign, hemi: 0 as const },
    { label: "left hemisphere, length on the displayed surface", threshold: 0.2, minLength: 40, sign: 0 as Sign, hemi: 1 as const, lengthSurface: -1 },
    { label: "a large build threshold raises the prefilter", threshold: 0.2, minLength: 0, sign: 2 as Sign, hemi: 0 as const, buildThreshold: 0.9 },
  ])("$label", (c) => {
    const input = inputFor(ds, {
      glyphStyle: "diffpoints", threshold: c.threshold * A, maxThreshold: (c.maxThreshold ?? 1) * A, minLength: c.minLength, sign: c.sign, hemi: c.hemi, lengthSurface: c.lengthSurface ?? 0,
    }, { buildThreshold: (c.buildThreshold ?? 0.3) * A });
    const ref = refDiffs(input);
    const layer = bakeGlyphs(input)!;

    it("exports one point per (edge, target) that passes the prefilter and the display test", () => {
      expect(layer.kind).toBe("points");
      expect(layer.name).toBe("glyphs diffpoints");
      expect(layer.truncated).toBe(false);
      expect(layer.positions.length / 3).toBe(ref.kept.length);
    });

    it("places it at the lifted edge midpoint + radius * (g_j - midpoint of the endpoints in the glyph geometry)", () => {
      const p = input.params;
      const disp = ds.surfaces[p.surface].positions, geo = ds.surfaces[p.glyphGeometry].positions, col = ds.surfaces[p.colorSurface].positions;
      const nrm = refNormals(disp, ds.triangles);
      const mid = (pos: ArrayLike<number>, a: number, b: number): V3 => [0.5 * (pos[3 * a] + pos[3 * b]), 0.5 * (pos[3 * a + 1] + pos[3 * b + 1]), 0.5 * (pos[3 * a + 2] + pos[3 * b + 2])];
      ref.kept.forEach((r, k) => {
        const nm = add(at(nrm, r.a), at(nrm, r.b));
        const centre = add(mid(disp, r.a, r.b), nm, lift(p) / norm(nm));
        const want = add(centre, sub(at(geo, r.j), mid(geo, r.a, r.b)), p.glyphRadius);
        expectClose(layer.positions.subarray(3 * k, 3 * k + 3), want, 2e-3, `edge ${r.a}-${r.b} -> ${r.j}`);
        // colour: orientation of target - edge midpoint in the colour surface
        const d = sub(at(col, r.j), mid(col, r.a, r.b));
        const l = norm(d) || 1;
        for (let ch = 0; ch < 3; ch++) check(Math.abs(layer.colors[4 * k + ch] - (255 * Math.abs(d[ch])) / l) <= 1.001, () => `edge ${r.a}-${r.b} -> ${r.j}: colour ${rgbAt(layer.colors, k)}`);
      });
    });
  });

  it("the selection is not vacuous and depends on the threshold", () => {
    const count = (threshold: number) => refDiffs(inputFor(ds, { glyphStyle: "diffpoints", threshold: threshold * A, minLength: 0, sign: 2 }, { buildThreshold: 0.3 * A })).kept.length;
    expect(count(0.123)).toBeGreaterThan(count(0.5));
    expect(count(0.123)).toBeGreaterThan(0);
  });

  it("colours by the size of the difference in value mode", () => {
    const input = inputFor(ds, { glyphStyle: "diffpoints", threshold: 0.2 * A, minLength: 0, sign: 2, glyphColorMode: 1, colormap: "viridis", cmin: 0, cmax: 0.9 * A }, { buildThreshold: 0.3 * A });
    const ref = refDiffs(input);
    const layer = bakeGlyphs(input)!;
    const lut = colormapLut("viridis");
    expect(layer.positions.length / 3).toBe(ref.kept.length);
    let exact = 0;
    ref.kept.forEach((r, k) => {
      const got = rgbAt(layer.colors, k);
      // the difference is recomputed in double precision: allow the neighbouring LUT entry
      const t = Math.round(255 * Math.min(1, Math.max(0, r.diff / (0.9 * A))));
      const near = [t - 1, t, t + 1].filter((q) => q >= 0 && q < 256).map((q) => [lut[4 * q], lut[4 * q + 1], lut[4 * q + 2]]);
      check(near.some((w) => w.every((v, ch) => v === got[ch])), () => `edge ${r.a}-${r.b} -> ${r.j} (difference ${r.diff}): colour ${got}`);
      if (lutColor(lut, r.diff, 0, 0.9 * A).every((v, ch) => v === got[ch])) exact++;
    });
    expect(exact).toBeGreaterThanOrEqual(ref.kept.length * 0.99);
  });

  it("uses the same budget as the screen: a small budget raises the prefilter instead of cutting the list", () => {
    const loose = inputFor(ds, { glyphStyle: "diffpoints", threshold: 0.123 * A, minLength: 0, sign: 2 }, { buildThreshold: 0.3 * A });
    const all = refDiffs(loose);
    const budget = Math.floor(all.prefiltered * 0.6);
    const tight = { ...loose, budget };
    const ref = refDiffs(tight);
    expect(ref.prefiltered).toBeLessThanOrEqual(budget);
    expect(ref.prefiltered).toBeLessThan(all.prefiltered);
    expect(bakeGlyphs(tight)!.positions.length / 3).toBe(ref.kept.length);
    expect(bakeGlyphs(loose)!.positions.length / 3).toBe(all.kept.length);
  });

  it("subsamples to maxPrims and says so", () => {
    const input = inputFor(ds, { glyphStyle: "diffpoints", threshold: 0.123 * A, minLength: 0, sign: 2 }, { buildThreshold: 0.3 * A });
    const full = bakeGlyphs(input)!;
    const count = full.positions.length / 3;
    expect(count).toBeGreaterThan(10);
    const maxPrims = Math.ceil(count / 4);
    const cut = bakeGlyphs({ ...input, maxPrims })!;
    const stride = Math.ceil(count / maxPrims);
    expect(cut.truncated).toBe(true);
    expect(cut.positions.length / 3).toBe(Math.ceil(count / stride));
    expect(cut.positions.length / 3).toBeLessThanOrEqual(maxPrims);
    for (let o = 0; o < cut.positions.length / 3; o++) expectSame(cut.positions.subarray(3 * o, 3 * o + 3), full.positions.subarray(3 * o * stride, 3 * o * stride + 3), `point ${o}`);
    expect(bakeGlyphs({ ...input, maxPrims: count })!.truncated).toBe(false);
  });
});

describe("bakeGlyphs difference glyphs: Fisher's transform versus plain difference", () => {
  it("the same pair of values gives a different displayed difference for correlations and for weights", () => {
    const corr = icoBrain(1);
    const wts = weighted(corr);
    // the weighted fixture is the correlation fixture times a constant (off the diagonal)
    const k = 5 / Math.max(...Array.from(corr.values).filter((_, q) => q % (corr.n + 1) !== 0).map(Math.abs));
    // within a module r is 0.75 .. 0.85: at most 0.1 apart, but up to 0.28 apart after Fisher's transform
    const a = inputFor(corr, { glyphStyle: "diffpoints", threshold: 0.12, minLength: 0 }, { buildThreshold: 0.3 });
    const b = inputFor(wts, { glyphStyle: "diffpoints", threshold: 0.12 * k, minLength: 0 }, { buildThreshold: 0.3 * k });
    const na = bakeGlyphs(a)!.positions.length / 3, nb = bakeGlyphs(b)!.positions.length / 3;
    expect(na).toBe(refDiffs(a).kept.length);
    expect(nb).toBe(refDiffs(b).kept.length);
    // tanh(|atanh r1 - atanh r2|) >= |r1 - r2| for same-sign correlations, so Fisher shows at least as many
    expect(na).toBeGreaterThan(nb);
  });
});

// -------------------------------------------------------------- little brains

describe.each(FIXTURES)("bakeLittleBrains on $name", ({ make }) => {
  const ds = make();
  const A = ds.conn.maxAbs;
  const n = ds.n;
  const painted = (every: number) => Uint8Array.from({ length: n }, (_, i) => (i % every === 2 ? 1 + (i % 2) : 0));
  const base = hexRgb(defaultGlyphParams.surfaceColor);
  const sulcO = ds.overlays.find((o) => o.name === "sulc");
  const sulc = sulcO ? normaliseSulc(sulcO.data) : null;

  it("makes one copy of the glyph-geometry mesh per painted glyph node, centred on the lifted node", () => {
    const labels = painted(9);
    const input = inputFor(ds, { littleBrains: true, lbColorMode: 0, lbMax: 1000, rotationEnabled: true, rotX: 10, rotY: 20, rotZ: 30, glyphRadius: 0.06, hemi: ds.leftNodes ? 1 : 0 }, { labels });
    const nodes = Array.from({ length: n }, (_, i) => i).filter((i) => labels[i] && input.glyphNodes[i]);
    expect(nodes.length).toBeGreaterThan(1);
    if (ds.leftNodes) expect(nodes.length).toBeLessThan(labels.reduce((s, l) => s + (l ? 1 : 0), 0)); // painted nodes of the other hemisphere get none
    const layer = bakeLittleBrains(input)!;
    expect(layer.kind).toBe("mesh");
    expect(layer.shading).toBe("lit");
    expect(layer.smooth).toBe(true);
    expect(layer.truncated).toBe(false);
    expect(layer.positions.length).toBe(3 * n * nodes.length);
    expect(layer.colors.length).toBe(4 * n * nodes.length);
    expect(layer.triangles!.length).toBe(ds.triangles.length * nodes.length);
    const nrm = refNormals(ds.surfaces[input.params.surface].positions, ds.triangles);
    nodes.forEach((node, k) => {
      // every copy uses the dataset's triangles, shifted to its own vertices
      for (const t of [0, 1, 2, ds.triangles.length - 1]) expect(layer.triangles![k * ds.triangles.length + t]).toBe(ds.triangles[t] + k * n);
      for (const v of [0, node, n - 1, (7 * k + 3) % n]) {
        expectClose(layer.positions.subarray(3 * (k * n + v), 3 * (k * n + v) + 3), expectedPoint(input, nrm, node, v), 2e-3, `copy ${k}, vertex ${v}`);
      }
      // the node's own vertex is the lifted glyph centre
      expectClose(layer.positions.subarray(3 * (k * n + node), 3 * (k * n + node) + 3), centreOf(input, nrm, node), 2e-3);
    });
    // lbColorMode 0: the plain surface colour everywhere
    const plain = base.map((c) => Math.floor(c * 255)).join("/");
    for (let v = 0; v < n * nodes.length; v++) check(rgbAt(layer.colors, v).join("/") === plain, () => `vertex ${v}: colour ${rgbAt(layer.colors, v)}`);
  });

  it("colours by connectivity only where the value passes the thresholds, the rest by sulcal depth", () => {
    const labels = painted(17);
    for (const [sign, threshold, maxThreshold] of [[0, 0.45, 1], [2, 0.07, 0.613], [1, 0.07, 1]] as [Sign, number, number][]) {
      const input = inputFor(ds, { littleBrains: true, lbColorMode: 1, sign, threshold: threshold * A, maxThreshold: maxThreshold * A, colormap: "viridis", cmin: -0.5 * A, cmax: 0.9 * A }, { labels });
      const nodes = Array.from({ length: n }, (_, i) => i).filter((i) => labels[i] && input.glyphNodes[i]);
      const layer = bakeLittleBrains(input)!;
      const lut = colormapLut("viridis");
      let coloured = 0;
      nodes.forEach((node, k) => {
        for (let v = 0; v < n; v++) {
          const value = ds.conn.data[node * n + v] * ds.conn.scale;
          const got = rgbAt(layer.colors, k * n + v);
          if (passesStrict(value, threshold * A, maxThreshold * A, sign)) {
            const want = lutColor(lut, value, -0.5 * A, 0.9 * A);
            check(got.every((g, c) => g === want[c]), () => `copy ${k}, vertex ${v} (value ${value}): colour ${got}, colour map ${want}`);
            coloured++;
          } else {
            const shade = sulc ? 1 - 0.45 * smoothstep(-0.2, 0.2, sulc[v]) : 1;
            check(got.every((g, c) => Math.abs(g - base[c] * shade * 255) <= 1.001), () => `copy ${k}, vertex ${v} (value ${value}): colour ${got}, expected the shaded surface colour`);
          }
        }
      });
      if (sign !== 1 || ds.name.includes("anticorrelated")) expect(coloured).toBeGreaterThan(0);
      expect(coloured).toBeLessThan(n * nodes.length);
    }
  });

  it("uses the threshold in effect", () => {
    const labels = painted(17);
    const input = inputFor(ds, { littleBrains: true, lbColorMode: 1, threshold: 0.07 * A, colormap: "viridis" }, { labels, threshold: 0.7 * A });
    const layer = bakeLittleBrains(input)!;
    const node = Array.from({ length: n }, (_, i) => i).find((i) => labels[i] && input.glyphNodes[i])!;
    const lut = colormapLut("viridis");
    for (let v = 0; v < n; v++) {
      const value = ds.conn.data[node * n + v] * ds.conn.scale;
      const mapped = rgbAt(layer.colors, v).every((g, c) => g === lutColor(lut, value, input.params.cmin, input.params.cmax)[c]);
      if (value > 0.7 * A) expect(mapped).toBe(true);
      if (value < 0.69 * A && value > 0.07 * A) expect(mapped).toBe(false);
    }
  });

  it("is capped by lbMax (evenly spread over the nodes) and flagged as truncated", () => {
    const labels = painted(3);
    const all = Array.from({ length: n }, (_, i) => i).filter((i) => labels[i] && ds.mask[i]);
    const input = inputFor(ds, { littleBrains: true, lbColorMode: 2, lbMax: 4 }, { labels });
    const layer = bakeLittleBrains(input)!;
    expect(layer.truncated).toBe(true);
    expect(layer.positions.length).toBe(3 * n * 4);
    const nrm = refNormals(ds.surfaces[input.params.surface].positions, ds.triangles);
    for (let k = 0; k < 4; k++) {
      const node = all[Math.floor((k * all.length) / 4)];
      expectClose(layer.positions.subarray(3 * (k * n + node), 3 * (k * n + node) + 3), centreOf(input, nrm, node), 2e-3, `copy ${k}`);
    }
    // exactly at the cap: nothing is dropped
    const exact = bakeLittleBrains(inputFor(ds, { littleBrains: true, lbColorMode: 2, lbMax: all.length }, { labels }))!;
    expect(exact.truncated).toBe(false);
    expect(exact.positions.length).toBe(3 * n * all.length);
  });

  it("falls back to the seed node, and is absent when switched off, in polar geometry or without any node", () => {
    const node = Array.from({ length: n }, (_, i) => i).find((i) => ds.mask[i])!;
    const single = bakeLittleBrains(inputFor(ds, { littleBrains: true }, { cursorNode: node }))!;
    expect(single.positions.length).toBe(3 * n);
    expect(bakeLittleBrains(inputFor(ds, { littleBrains: false }, { cursorNode: node }))).toBeNull();
    expect(bakeLittleBrains(inputFor(ds, { littleBrains: true }))).toBeNull();
    expect(bakeLittleBrains(inputFor(ds, { littleBrains: true, glyphGeometry: -1 }, { cursorNode: node }))).toBeNull();
    // painted nodes outside the glyph nodes (other hemisphere) do not count
    if (ds.leftNodes) {
      const labels = new Uint8Array(n);
      labels[Array.from({ length: n }, (_, i) => i).find((i) => i >= ds.leftNodes && ds.mask[i])!] = 1;
      expect(bakeLittleBrains(inputFor(ds, { littleBrains: true, hemi: 1 }, { labels }))).toBeNull();
      expect(bakeLittleBrains(inputFor(ds, { littleBrains: true, hemi: 2 }, { labels }))!.positions.length).toBe(3 * n);
    }
  });
});

// ---------------------------------------------------------------------- lines

describe("bakeLines", () => {
  const lines: Polylines = {
    points: new Float32Array([0, 0, 0, 5, 1, 0, 10, 0, 0, /* line 2 */ 1, 1, 1, 1, 4, 5, /* line 3 */ -3, 0, 2, -3, 0, 4, -3, 1, 9, -3, 0, 12]),
    offsets: new Uint32Array([0, 3, 5, 9]),
    values: new Float32Array([0.8, -0.4, 0.1]),
  };

  it("connects consecutive points of every polyline and never two polylines", () => {
    const layer = bakeLines(lines, { ...defaultGlyphParams }, 0.3);
    expect(layer.kind).toBe("segments");
    expect(layer.name).toBe("connections");
    expect(layer.shading).toBe("flat");
    expect(layer.radius).toBe(0.3);
    expect(layer.positions).toBe(lines.points);
    expect(Array.from(layer.edges!)).toEqual([0, 1, 1, 2, 3, 4, 5, 6, 6, 7, 7, 8]);
    expect(layer.colors.length).toBe(4 * 9);
  });

  it("colours a whole line by the orientation of its end points", () => {
    const layer = bakeLines(lines, { ...defaultGlyphParams, lineColorMode: 0 }, 0.3);
    const want = [[255, 0, 0], [0, (3 / 5) * 255, (4 / 5) * 255], [0, 0, 255]];
    const lineOf = [0, 0, 0, 1, 1, 2, 2, 2, 2];
    lineOf.forEach((l, k) => {
      rgbAt(layer.colors, k).forEach((g, c) => expect(Math.abs(g - want[l][c])).toBeLessThanOrEqual(1.001));
      expect(layer.colors[4 * k + 3]).toBe(255);
    });
  });

  it("colours a whole line by its value through the colour map", () => {
    const p = { ...defaultGlyphParams, lineColorMode: 1 as const, colormap: "blue white red", cmin: -1, cmax: 1 };
    const layer = bakeLines(lines, p, 0.3);
    const lut = colormapLut("blue white red");
    [0, 0, 0, 1, 1, 2, 2, 2, 2].forEach((l, k) => expect(rgbAt(layer.colors, k)).toEqual(lutColor(lut, lines.values[l], -1, 1)));
    // positive red-ish, negative blue-ish
    expect(layer.colors[0]).toBeGreaterThan(layer.colors[2]);
    expect(layer.colors[4 * 3 + 2]).toBeGreaterThan(layer.colors[4 * 3]);
  });

  it("handles no lines at all", () => {
    const layer = bakeLines({ points: new Float32Array(0), offsets: new Uint32Array([0]), values: new Float32Array(0) }, { ...defaultGlyphParams }, 0.2);
    expect(layer.positions.length).toBe(0);
    expect(layer.edges!.length).toBe(0);
  });
});

// -------------------------------------------------------------------- surface

describe.each(FIXTURES)("bakeSurface on $name", ({ make }) => {
  const ds = make();
  const n = ds.n;
  const A = ds.conn.maxAbs;
  const base = hexRgb("#c08040");
  const sulcO = ds.overlays.find((o) => o.name === "sulc");
  const sulc = sulcO ? normaliseSulc(sulcO.data) : null;
  const shadeOf = (i: number) => (sulc ? 1 - 0.45 * smoothstep(-0.25, 0.25, sulc[i]) : 1);
  const expectRgb = (layer: Layer, i: number, want: number[]) => rgbAt(layer.colors, i).forEach((g, c) => {
    if (Math.abs(g - want[c]) > 1.001) throw new Error(`vertex ${i}: colour ${rgbAt(layer.colors, i)}, expected ${want}`);
  });

  it("is the displayed surface with its triangles, opacity and one opaque colour per vertex", () => {
    for (const surface of [0, 1]) {
      const layer = bakeSurface(inputFor(ds, { surface, surfaceAlpha: 0.25, surfaceColorMode: "solid" }));
      expect(layer.kind).toBe("mesh");
      expect(layer.shading).toBe("lit");
      expect(layer.smooth).toBe(true);
      expect(layer.opacity).toBe(0.25);
      expect(layer.name).toBe(`surface ${ds.surfaces[surface].name}`);
      expect(layer.positions).toBe(ds.surfaces[surface].positions);
      expect(layer.triangles).toEqual(ds.triangles);
      expect(layer.colors.length).toBe(4 * n);
      for (let i = 0; i < n; i++) expect(layer.colors[4 * i + 3]).toBe(255);
    }
  });

  it("solid: the surface colour everywhere", () => {
    const layer = bakeSurface(inputFor(ds, { surfaceColorMode: "solid", surfaceColor: "#c08040" }));
    for (let i = 0; i < n; i++) expectRgb(layer, i, [0xc0, 0x80, 0x40]);
  });

  it("sulc: the surface colour darkened in the sulci (plain when there is no sulc overlay)", () => {
    const layer = bakeSurface(inputFor(ds, { surfaceColorMode: "sulc", surfaceColor: "#c08040" }));
    for (let i = 0; i < n; i++) expectRgb(layer, i, base.map((c) => c * shadeOf(i) * 255));
    if (sulc) {
      const deepest = sulc.indexOf(Math.max(...sulc)), highest = sulc.indexOf(Math.min(...sulc));
      expect(layer.colors[4 * deepest]).toBeLessThan(layer.colors[4 * highest]);
      expect(layer.colors[4 * deepest]).toBeGreaterThanOrEqual(Math.floor(0xc0 * 0.55));
    }
  });

  it("seed: the seed's connectivity through the colour map where |value| reaches the lower threshold", () => {
    const seed = Array.from({ length: n }, (_, i) => i).find((i) => ds.mask[i])!;
    const seedRow = Float32Array.from({ length: n }, (_, j) => ds.conn.data[seed * n + j] * ds.conn.scale);
    seedRow[seed] = A;
    const params: Partial<GlyphParams> = { surfaceColorMode: "seed", surfaceColor: "#c08040", colormap: "cool - warm", cmin: -0.8 * A, cmax: 0.8 * A, seedLower: 0.3 * A };
    const layer = bakeSurface(inputFor(ds, params, { seedRow, cursorNode: seed }));
    const lut = colormapLut("cool - warm");
    let mapped = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(seedRow[i]) >= 0.3 * A) { expect(rgbAt(layer.colors, i)).toEqual(lutColor(lut, seedRow[i], -0.8 * A, 0.8 * A)); mapped++; }
      else expectRgb(layer, i, base.map((c) => c * shadeOf(i) * 255));
    }
    expect(mapped).toBeGreaterThan(1);
    expect(mapped).toBeLessThan(n);
    // without a seed the mode shows the plain (sulc-shaded) surface
    const none = bakeSurface(inputFor(ds, params));
    for (let i = 0; i < n; i++) expectRgb(none, i, base.map((c) => c * shadeOf(i) * 255));
  });

  it("overlay: every vertex through the colour map between the 2nd and 98th percentile", () => {
    if (!sulcO) {
      // an overlay that does not exist leaves the plain surface
      const layer = bakeSurface(inputFor(ds, { surfaceColorMode: "overlay:sulc", surfaceColor: "#c08040" }));
      for (let i = 0; i < n; i++) expectRgb(layer, i, [0xc0, 0x80, 0x40]);
      return;
    }
    const layer = bakeSurface(inputFor(ds, { surfaceColorMode: "overlay:sulc", colormap: "viridis", cmin: -123, cmax: 456, seedLower: 99 }));
    const sorted = Array.from(sulcO.data).sort((a, b) => a - b);
    const lo = sorted[Math.floor(n * 0.02)], hi = sorted[Math.floor(n * 0.98)];
    const lut = colormapLut("viridis");
    for (let i = 0; i < n; i++) expect(rgbAt(layer.colors, i)).toEqual(lutColor(lut, sulcO.data[i], lo, hi));
    const low = sulcO.data.indexOf(sorted[0]), high = sulcO.data.indexOf(sorted[n - 1]);
    expect(rgbAt(layer.colors, low)).toEqual([lut[0], lut[1], lut[2]]);
    expect(rgbAt(layer.colors, high)).toEqual([lut[4 * 255], lut[4 * 255 + 1], lut[4 * 255 + 2]]);
  });

  it("blends the paint over the surface colour, unless painting is hidden", () => {
    const labels = Uint8Array.from({ length: n }, (_, i) => (i % 4 === 1 ? 1 : i % 4 === 3 ? 2 : 0));
    const labelColors = ["#ff0000", "#0000ff"];
    const layer = bakeSurface(inputFor(ds, { surfaceColorMode: "solid", surfaceColor: "#c08040", showPaint: true }, { labels, labelColors }));
    const a = 215 / 255;
    for (let i = 0; i < n; i++) {
      const paint = labels[i] ? hexRgb(labelColors[labels[i] - 1]) : null;
      expectRgb(layer, i, base.map((c, k) => (paint ? c + (paint[k] - c) * a : c) * 255));
    }
    const hidden = bakeSurface(inputFor(ds, { surfaceColorMode: "solid", surfaceColor: "#c08040", showPaint: false }, { labels, labelColors }));
    for (let i = 0; i < n; i++) expectRgb(hidden, i, [0xc0, 0x80, 0x40]);
  });

  it("keeps the triangles of the selected hemisphere only", () => {
    const left = bakeSurface(inputFor(ds, { hemi: 1 })), right = bakeSurface(inputFor(ds, { hemi: 2 })), both = bakeSurface(inputFor(ds, { hemi: 0 }));
    expect(both.triangles).toEqual(ds.triangles);
    if (!ds.leftNodes) {
      expect(left.triangles).toEqual(ds.triangles);
      expect(right.triangles).toEqual(ds.triangles);
      return;
    }
    expect(left.triangles!.length + right.triangles!.length).toBe(ds.triangles.length);
    expect(left.triangles!.length).toBe(3 * ds.leftTriangles);
    expect(Math.max(...left.triangles!)).toBeLessThan(ds.leftNodes);
    expect(Math.min(...right.triangles!)).toBeGreaterThanOrEqual(ds.leftNodes);
    // the vertex arrays are complete in both cases, so indices stay valid
    expect(left.positions.length).toBe(3 * n);
    expect(right.colors.length).toBe(4 * n);
    // left = -x in the fixture
    const meanX = (tri: Uint32Array) => tri.reduce((s, v) => s + both.positions[3 * v], 0) / tri.length;
    expect(meanX(left.triangles!)).toBeLessThan(BRAIN_SHAPE.inflatedCenter[0] / 2);
    expect(meanX(right.triangles!)).toBeGreaterThan(-BRAIN_SHAPE.inflatedCenter[0] / 2);
  });
});

// ---------------------------------------------------------------------- scene

describe.each(FIXTURES)("bakeGlyphScene on $name", ({ make }) => {
  const ds = make();
  const A = ds.conn.maxAbs;
  const lines: Polylines = { points: new Float32Array([0, 0, 0, 1, 2, 3]), offsets: new Uint32Array([0, 2]), values: new Float32Array([0.5]) };
  const labels = Uint8Array.from({ length: ds.n }, (_, i) => (i % 11 === 0 ? 1 : 0));
  const full = (params: Partial<GlyphParams> = {}, extra: Partial<GlyphBakeInput> = {}) =>
    inputFor(ds, { glyphStyle: "points", threshold: 0.45 * A, minLength: 0, littleBrains: true, lbMax: 3, ...params }, { labels, lines, primRadius: 0.5, ...extra });
  const names = (layers: Layer[]) => layers.map((l) => l.name);
  const surface = `surface ${ds.surfaces[1].name}`;

  it("orders the layers: surface, little brains, glyphs, connections", () => {
    const layers = bakeGlyphScene(full());
    expect(names(layers)).toEqual([surface, "little brains", "glyphs points", "connections"]);
    expect(layers.map((l) => l.kind)).toEqual(["mesh", "mesh", "points", "segments"]);
    expect(layers.map((l) => l.shading)).toEqual(["lit", "lit", "flat", "flat"]);
    expect(layers[3].radius).toBeCloseTo(0.3, 12); // 0.6 x the primitive radius
    expect(names(bakeGlyphScene(full({ glyphStyle: "vectors" })))).toEqual([surface, "little brains", "glyphs vectors", "connections"]);
    expect(names(bakeGlyphScene(full({ glyphStyle: "pies" })))).toEqual([surface, "little brains", "glyphs pies", "connections"]);
  });

  it("honours the visibility switches", () => {
    expect(names(bakeGlyphScene(full({ showSurface: false })))).toEqual(["little brains", "glyphs points", "connections"]);
    expect(names(bakeGlyphScene(full({ showGlyphs: false })))).toEqual([surface, "connections"]); // glyphs and their background glyphs
    expect(names(bakeGlyphScene(full({ showConnections: false })))).toEqual([surface, "little brains", "glyphs points"]);
    expect(names(bakeGlyphScene(full({}, { lines: null })))).toEqual([surface, "little brains", "glyphs points"]);
    expect(names(bakeGlyphScene(full({ littleBrains: false })))).toEqual([surface, "glyphs points", "connections"]);
    expect(names(bakeGlyphScene(full({ glyphStyle: "off" })))).toEqual([surface, "little brains", "connections"]);
    expect(bakeGlyphScene(full({ showSurface: false, showGlyphs: false, showConnections: false }))).toEqual([]);
  });

  it("leaves out a glyph layer without primitives and keeps thin connections renderable", () => {
    expect(names(bakeGlyphScene(full({ threshold: A, littleBrains: false })))).toEqual([surface, "connections"]);
    const thin = bakeGlyphScene(full({}, { primRadius: 0.01 }));
    expect(thin[thin.length - 1].radius).toBe(0.05);
  });

  it("every layer is well-formed: finite positions, one colour per vertex, indices in range", () => {
    for (const style of ["points", "vectors", "pies", "diffpoints"] as const) {
      for (const layer of bakeGlyphScene(full({ glyphStyle: style, threshold: 0.3 * A }, { buildThreshold: 0.3 * A }))) {
        const nv = layer.positions.length / 3;
        expect(Number.isInteger(nv)).toBe(true);
        expect(layer.colors.length).toBe(4 * nv);
        expect(layer.positions.every(Number.isFinite)).toBe(true);
        for (const idx of [layer.triangles, layer.edges]) if (idx && idx.length) expect(idx.reduce((m, v) => Math.max(m, v), 0)).toBeLessThan(nv);
        if (layer.kind === "mesh") expect(layer.triangles!.length % 3).toBe(0);
        if (layer.kind === "segments") expect(layer.edges!.length % 2).toBe(0);
      }
    }
  });
});

// ------------------------------------------------- awkward matrices

describe("bake: matrices that are not symmetric or whose scale does not divide evenly", () => {
  it("a directed matrix: glyphs and background glyphs of node i show row i, not column i", () => {
    const ds = directed(icoBrain(1));
    const A = ds.conn.maxAbs;
    // the lower triangle is halved: at 0.5 a node keeps its targets with a higher index only (within its module)
    const input = inputFor(ds, { glyphStyle: "points", threshold: 0.5 * A, minLength: 0 });
    const ref = drawn(input);
    expect(ref.length).toBeGreaterThan(0);
    expect(ref.every((c) => c.j > c.i)).toBe(true);
    const layer = bakeGlyphs(input)!;
    expect(layer.positions.length / 3).toBe(ref.length);
    const nrm = refNormals(ds.surfaces[1].positions, ds.triangles);
    ref.forEach((c, k) => expectClose(layer.positions.subarray(3 * k, 3 * k + 3), expectedPoint(input, nrm, c.i, c.j), 2e-3));

    const node = 20;
    const lb = bakeLittleBrains(inputFor(ds, { littleBrains: true, lbColorMode: 1, threshold: 0.5 * A, colormap: "viridis" }, { cursorNode: node }))!;
    const lut = colormapLut("viridis");
    let above = 0, below = 0;
    for (let v = 0; v < ds.n; v++) {
      const value = ds.conn.get(node, v);
      const mapped = rgbAt(lb.colors, v).every((g, c) => g === lutColor(lut, value, -0.8, 0.8)[c]);
      if (value > 0.5 * A) { expect(mapped).toBe(true); above++; }
      // where only the transposed entry would pass, the vertex keeps the surface colour
      if (value <= 0.5 * A && ds.conn.get(v, node) > 0.5 * A) { expect(mapped).toBe(false); below++; }
    }
    expect(above).toBeGreaterThan(0);
    expect(below).toBeGreaterThan(0);
  });

  it("the strongest entries survive an upper threshold of maxAbs when maxAbs / scale rounds below 32767", () => {
    const base = icoBrain(1);
    // find a rescaled copy for which (32767 * scale) / scale < 32767 in floating point
    let ds: FixtureDataset | null = null;
    for (let k = 1; k <= 400 && !ds; k++) {
      const values = base.values.map((v) => v * (1 + k / 97));
      const conn = ConnMatrix.fromFull(values, base.n);
      if (conn.maxAbs / conn.scale < 32767) ds = { ...base, name: `icoBrain(1) x ${1 + k / 97}`, conn, values };
    }
    expect(ds).not.toBeNull();
    const d = ds!;
    const A = d.conn.maxAbs;
    const strongest = Array.from(d.conn.data).filter((v) => Math.abs(v) === 32767).length;
    expect(strongest).toBeGreaterThan(0); // the diagonal of the fixture; make it a connexel by moving it off the diagonal
    const data = Int16Array.from(d.conn.data);
    data[0 * d.n + 5] = data[5 * d.n + 0] = 32767;
    const moved: FixtureDataset = { ...d, conn: new ConnMatrix(d.n, data, d.conn.scale) };
    for (const style of ["points", "vectors", "pies"] as const) {
      const input = inputFor(moved, { glyphStyle: style, threshold: A * (1 - 1e-6), maxThreshold: A, minLength: 0 });
      const ref = drawn(input);
      expect(ref.map((c) => `${c.i}-${c.j}`)).toEqual(["0-5", "5-0"]);
      const layer = bakeGlyphs(input)!;
      expect(layer.positions.length / 3).toBe(style === "points" ? 2 : style === "vectors" ? 4 : 2 * 24 * 3); // two one-slice pies of 24 wedges
    }
    const lb = bakeLittleBrains(inputFor(moved, { littleBrains: true, lbColorMode: 1, threshold: A * (1 - 1e-6), maxThreshold: A, colormap: "viridis" }, { cursorNode: 0 }))!;
    const lut = colormapLut("viridis");
    expect(rgbAt(lb.colors, 5)).toEqual([lut[4 * 255], lut[4 * 255 + 1], lut[4 * 255 + 2]]);
  });
});

// keep `cross` referenced for the tangent-frame sanity check below
describe("test helpers", () => {
  it("tangentFrame is right-handed with the normal: right x up = n", () => {
    const n: V3 = [0.36, -0.48, 0.8];
    const f = tangentFrame(n);
    const back = cross(f.right, f.up);
    for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(n[k], 9);
  });
});
