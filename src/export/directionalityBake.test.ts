/**
 * The bridge to the Directionality workspace and its Blender baker on the
 * synthetic example datasets: a map that grows from posterior to anterior and
 * a parcellation into the fixtures' network modules go through
 * toDirectionality() (text files) and bakeDirectionality() (geometry).
 */
import { describe, it, expect } from "vitest";
import { ArrowParams, bakeDirectionality, defaultArrowParams } from "./directionalityBake";
import type { Layer } from "./ply";
import { toDirectionality } from "../bridge/toDirectionality";
import { colormapLut } from "../render/colormaps";
import { FIXTURES, FixtureDataset } from "../testing/fixtures";
import { at, cross, dot, edgeSet, lutColor, norm, refNormals, sub, unit, V3 } from "../testing/reference";

const SURFACE = 1; // inflated: smooth, so "tangent to the surface" is well defined
const LUT = colormapLut("viridis");
const MODULE_COLORS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6"];

/** A smooth map: the antero-posterior coordinate, positive everywhere, 0 (= no data) on masked nodes. */
function apMap(ds: FixtureDataset): Float32Array {
  const pos = ds.surfaces[SURFACE].positions;
  let min = Infinity;
  for (let i = 0; i < ds.n; i++) min = Math.min(min, pos[3 * i + 1]);
  return Float32Array.from({ length: ds.n }, (_, i) => (ds.mask[i] ? pos[3 * i + 1] - min + 1 : 0));
}

function surfaceExport(ds: FixtureDataset) {
  return {
    name: ds.name, positions: ds.surfaces[SURFACE].positions, triangles: ds.triangles,
    labels: Uint8Array.from({ length: ds.n }, (_, i) => (ds.mask[i] ? ds.modules[i] + 1 : 0)), labelColors: MODULE_COLORS,
    scalars: apMap(ds), scalarName: "antero-posterior position",
  };
}

const mid = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const vert = (l: Layer, v: number): V3 => at(l.positions, v);

/** Bounding radius around the mean vertex: the length unit of the arrow parameters. */
function meshRadius(pos: Float32Array): { centre: V3; radius: number } {
  const n = pos.length / 3;
  const c: V3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) c[d] += pos[3 * i + d] / n;
  let r = 0;
  for (let i = 0; i < n; i++) r = Math.max(r, norm(sub(at(pos, i), c)));
  return { centre: c, radius: r };
}

function hsv(h: number, s: number, v: number): number[] {
  const f = (k: number) => { const q = (k + h * 6) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(q, 4 - q, 1)))); };
  return [f(5), f(3), f(1)];
}

describe.each(FIXTURES)("toDirectionality + bakeDirectionality on $name", ({ make }) => {
  const ds = make();
  const n = ds.n;
  const pos = ds.surfaces[SURFACE].positions;
  const exp = surfaceExport(ds);
  const fromMap = toDirectionality(exp, "scalars", LUT, 8);
  const fromRegions = toDirectionality(exp, "labels", LUT);
  const { radius: R } = meshRadius(pos);
  const longestEdge = Math.max(...[...edgeSet(ds.triangles)].map((e) => { const [a, b] = e.split("-").map(Number); return norm(sub(at(pos, a), at(pos, b))); }));
  const normals = refNormals(pos, ds.triangles);
  const nearest = (p: V3): number => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = norm(sub(at(pos, i), p)); if (d < bd) { bd = d; best = i; } }
    return best;
  };

  describe("the bridge", () => {
    it("map: quantile bands ordered by value, zeros left out, colours from the colour map", () => {
      expect(fromMap.regions).toBe(8);
      expect(fromMap.order).toBe("1\n2\n3\n4\n5\n6\n7\n8\n");
      expect(fromMap.name).toBe(`${ds.name} — antero-posterior position`);
      const labels = fromMap.labels.trim().split("\n").map(Number);
      expect(labels.length).toBe(n);
      const s = exp.scalars;
      const valid = Array.from(s).filter((v) => v !== 0).sort((a, b) => a - b);
      const lo = valid[Math.floor(valid.length * 0.02)], hi = valid[Math.floor(valid.length * 0.98)];
      const counts = new Array(9).fill(0);
      for (let i = 0; i < n; i++) {
        counts[labels[i]]++;
        if (s[i] === 0) { expect(labels[i]).toBe(0); continue; }
        // band = number of the 7 inner octile boundaries below the value, + 1
        const below = [1, 2, 3, 4, 5, 6, 7].filter((k) => s[i] > valid[Math.floor((k * valid.length) / 8)]).length;
        expect(labels[i]).toBe(below + 1);
      }
      expect(counts[0]).toBe(n - valid.length);
      for (let b = 1; b <= 8; b++) expect(Math.abs(counts[b] - valid.length / 8)).toBeLessThanOrEqual(2); // equally populated
      // bands are ordered: a larger value never has a smaller band
      for (let i = 0; i < n; i++) for (const j of [0, Math.floor(n / 2), n - 1]) if (s[i] && s[j] && s[i] > s[j]) expect(labels[i]).toBeGreaterThanOrEqual(labels[j]);
      // the PLY carries the colour-mapped values
      const rows = fromMap.ply.split("\n");
      const first = rows.indexOf("end_header") + 1;
      for (const i of [0, 1, Math.floor(n / 3), n - 1]) {
        const cols = rows[first + i].split(" ").map(Number);
        expect(cols.slice(3)).toEqual(s[i] === 0 ? [190, 190, 190] : lutColor(LUT, s[i], lo, hi));
        for (let d = 0; d < 3; d++) expect(cols[d]).toBeCloseTo(pos[3 * i + d], 3);
      }
    });

    it("regions: one parcel per painted label, in the order they were painted", () => {
      const present = [...new Set(Array.from(exp.labels).filter((l) => l))].sort((a, b) => a - b);
      expect(fromRegions.regions).toBe(present.length);
      expect(fromRegions.order).toBe(present.join("\n") + "\n");
      expect(fromRegions.labels).toBe(Array.from(exp.labels).join("\n") + "\n");
      expect(fromRegions.name).toBe(`${ds.name} — regions`);
    });

    it("refuses a map without values and a single region", () => {
      expect(() => toDirectionality({ ...exp, scalars: null }, "scalars", LUT)).toThrow(/no surface map/);
      expect(() => toDirectionality({ ...exp, scalars: new Float32Array(n) }, "scalars", LUT)).toThrow(/too few/);
      expect(() => toDirectionality({ ...exp, labels: new Uint8Array(n).fill(1) }, "labels", LUT)).toThrow(/two regions/);
    });
  });

  describe.each([
    { source: "map", input: fromMap },
    { source: "regions", input: fromRegions },
  ])("baked from the $source", ({ source, input }) => {
    const params: ArrowParams = { ...defaultArrowParams, arrowScale: 0.02, arrowColorR: 0.2, arrowColorG: 0.4, arrowColorB: 0.6 };
    const layers = bakeDirectionality(input.ply, input.labels, input.order, params);
    const surface = layers[0], arrows = layers[1];
    const m = arrows ? arrows.positions.length / 21 : 0;
    const length = 2 * params.arrowHeight * params.arrowScale * R;
    const halfWidth = 0.5 * params.arrowWidth * params.arrowScale * R;
    const lift = Math.max(0.02 * length, params.arrowDist * params.arrowScale * R * 0.25);

    it("gives the parcellated surface and a layer of arrows", () => {
      expect(layers.map((l) => l.name)).toEqual(["parcellated surface", "arrows"]);
      expect(surface.kind).toBe("mesh");
      expect(surface.shading).toBe("lit");
      expect(surface.smooth).toBe(true);
      expect(surface.positions.length).toBe(3 * n);
      for (let k = 0; k < 3 * n; k++) if (Math.abs(surface.positions[k] - pos[k]) > 1e-3) throw new Error(`surface coordinate ${k}`);
      expect(Array.from(surface.triangles!)).toEqual(Array.from(ds.triangles));
      expect(surface.colors.length).toBe(4 * n);
      expect(arrows.kind).toBe("mesh");
      expect(arrows.shading).toBe("flat");
      expect(arrows.smooth).toBe(false);
      expect(m).toBeGreaterThan(0);
    });

    it("every arrow has 7 vertices and 3 triangles of its own, and nothing is NaN", () => {
      expect(Number.isInteger(m)).toBe(true);
      expect(arrows.triangles!.length).toBe(9 * m);
      expect(arrows.colors.length).toBe(28 * m);
      for (let k = 0; k < m; k++) {
        const b = 7 * k;
        const tri = Array.from(arrows.triangles!.subarray(9 * k, 9 * k + 9));
        // shaft: the quad 0-1-2-3 as two triangles; head: 4-5-6
        expect(tri.slice(0, 6).map((v) => v - b).sort()).toEqual([0, 0, 1, 2, 2, 3]);
        expect(tri.slice(6).map((v) => v - b).sort()).toEqual([4, 5, 6]);
      }
      expect(arrows.positions.every(Number.isFinite)).toBe(true);
      expect(surface.positions.every(Number.isFinite)).toBe(true);
    });

    it("has the size and shape given by the arrow parameters (in units of the mesh radius)", () => {
      for (let k = 0; k < m; k++) {
        const v = [0, 1, 2, 3, 4, 5, 6].map((c) => vert(arrows, 7 * k + c));
        const tail = mid(v[0], v[1]), tip = v[6];
        const axis = unit(sub(tip, tail));
        const side = unit(sub(v[1], v[0]));
        const close = (got: number, want: number, what: string) => { if (Math.abs(got - want) > 1e-3 * length + 1e-4) throw new Error(`arrow ${k}: ${what} is ${got}, expected ${want}`); };
        close(norm(sub(tip, tail)), length, "length");
        close(norm(sub(v[1], v[0])), 2 * halfWidth * params.arrowBodyWidth, "body width");
        close(norm(sub(v[5], v[4])), 2 * halfWidth, "head width");
        close(dot(side, axis), 0, "side . axis");
        const neck = length * (1 - params.arrowHeadFrac);
        close(dot(sub(v[2], tail), axis), neck, "end of the shaft");
        close(dot(sub(v[3], tail), axis), neck, "end of the shaft");
        close(dot(sub(mid(v[4], v[5]), tail), axis), neck, "base of the head");
        close(norm(sub(mid(v[4], v[5]), tail)), neck, "base of the head is centred on the axis");
        // flat: every vertex in the plane of axis and side
        const normal = cross(axis, side);
        for (const p of v) close(dot(sub(p, tail), normal), 0, "distance from the arrow's plane");
        // the head is a triangle that is wider than the shaft and ends in a point
        if (!(norm(sub(v[5], v[4])) > norm(sub(v[1], v[0])))) throw new Error(`arrow ${k}: head not wider than the shaft`);
      }
    });

    it("lies flat just above the surface", () => {
      for (let k = 0; k < m; k++) {
        const tail = mid(vert(arrows, 7 * k), vert(arrows, 7 * k + 1)), tip = vert(arrows, 7 * k + 6);
        const centre = mid(tail, tip);
        const node = nearest(centre);
        const d = norm(sub(centre, at(pos, node)));
        if (!(d <= 0.6 * longestEdge + lift)) throw new Error(`arrow ${k} is ${d} mm from the nearest node (longest edge ${longestEdge})`);
        // tangent to the surface: the arrow's plane normal is (nearly) the surface normal there
        const normal = cross(unit(sub(tip, tail)), unit(sub(vert(arrows, 7 * k + 1), vert(arrows, 7 * k))));
        const cosine = dot(normal, at(normals, node));
        if (!(cosine > 0.8)) throw new Error(`arrow ${k} is tilted against the surface (cos ${cosine})`);
        // on the outside (the fixtures' inflated hemispheres are ellipsoids: convex)
        if (!(dot(sub(centre, at(pos, node)), at(normals, node)) > -1e-3)) throw new Error(`arrow ${k} is below the surface`);
      }
      // well inside the bounding sphere + their own size
      const { centre: c } = meshRadius(pos);
      for (let v = 0; v < 7 * m; v++) if (norm(sub(vert(arrows, v), c)) > R + length) throw new Error(`vertex ${v} is far from the mesh`);
    });

    it("uses the arrow colour, opaque", () => {
      for (let v = 0; v < 7 * m; v++) {
        const c = Array.from(arrows.colors.subarray(4 * v, 4 * v + 4));
        if (c[0] !== 51 || c[1] !== 102 || c[2] !== 153 || c[3] !== 255) throw new Error(`vertex ${v}: colour ${c}`);
      }
      const black = bakeDirectionality(input.ply, input.labels, input.order, { ...params, arrowColorR: 0, arrowColorG: 0, arrowColorB: 0 })[1];
      expect(black.positions).toEqual(arrows.positions);
      for (let v = 0; v < 7 * m; v++) if (black.colors[4 * v] + black.colors[4 * v + 1] + black.colors[4 * v + 2] !== 0 || black.colors[4 * v + 3] !== 255) throw new Error(`vertex ${v} is not black`);
    });

    it("'flip direction' turns every arrow around on the spot", () => {
      const other = bakeDirectionality(input.ply, input.labels, input.order, { ...params, arrowFlipDirection: !params.arrowFlipDirection })[1];
      expect(other.positions.length).toBe(arrows.positions.length);
      for (let k = 0; k < m; k++) {
        const tailA = mid(vert(arrows, 7 * k), vert(arrows, 7 * k + 1)), tipA = vert(arrows, 7 * k + 6);
        const tailB = mid(vert(other, 7 * k), vert(other, 7 * k + 1)), tipB = vert(other, 7 * k + 6);
        if (norm(sub(tailA, tipB)) > 1e-3 || norm(sub(tipA, tailB)) > 1e-3) throw new Error(`arrow ${k} is not reversed in place`);
      }
    });

    it("takes the surface colours from the PLY, or from the label-order palette on request", () => {
      const rows = input.ply.split("\n");
      const first = rows.indexOf("end_header") + 1;
      for (let i = 0; i < n; i++) {
        const want = rows[first + i].split(" ").slice(3).map(Number);
        const got = Array.from(surface.colors.subarray(4 * i, 4 * i + 4));
        if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2] || got[3] !== 255) throw new Error(`vertex ${i}: colour ${got}, PLY ${want}`);
      }
      if (source === "regions") {
        // painted colours, 190 grey where nothing is painted
        const i = Array.from(exp.labels).findIndex((l) => l === 2);
        if (i >= 0) expect(Array.from(surface.colors.subarray(4 * i, 4 * i + 3))).toEqual([0x3c, 0xb4, 0x4b]);
        const none = Array.from(exp.labels).findIndex((l) => l === 0);
        if (none >= 0) expect(Array.from(surface.colors.subarray(4 * none, 4 * none + 3))).toEqual([190, 190, 190]);
      }
      const palette = bakeDirectionality(input.ply, input.labels, input.order, { ...params, useLabelColors: true })[0];
      const labels = input.labels.trim().split("\n").map(Number);
      const order = input.order.trim().split("\n").map(Number);
      let differ = 0;
      for (let i = 0; i < n; i++) {
        const got = Array.from(palette.colors.subarray(4 * i, 4 * i + 3));
        const rank = order.indexOf(labels[i]);
        if (rank >= 0) {
          // region number `rank` of N gets the hue rank / N (saturation 0.6, value 0.95)
          const want = hsv(rank / order.length, 0.6, 0.95);
          if (got.some((g, c) => g !== want[c])) throw new Error(`vertex ${i} (region ${rank + 1} of ${order.length}): colour ${got}, expected ${want}`);
        } else if (got[0] !== got[1] || got[1] !== got[2]) throw new Error(`vertex ${i} has no region but the colour ${got}`);
        if (got.some((g, c) => g !== surface.colors[4 * i + c])) differ++;
      }
      expect(differ).toBeGreaterThan(n / 2);
      expect(palette.positions).toEqual(surface.positions);
    });

    it("leaves the arrows out when they are hidden, and is deterministic", () => {
      const hidden = bakeDirectionality(input.ply, input.labels, input.order, { ...params, showArrows: false });
      expect(hidden.map((l) => l.name)).toEqual(["parcellated surface"]);
      const again = bakeDirectionality(input.ply, input.labels, input.order, params);
      expect(again[1].positions).toEqual(arrows.positions);
    });

    it("larger arrows are fewer", () => {
      const big = bakeDirectionality(input.ply, input.labels, input.order, { ...params, arrowScale: 0.15 })[1];
      expect(big.positions.length / 21).toBeLessThan(m);
      expect(big.positions.every(Number.isFinite)).toBe(true);
    });
  });

  it("arrows of a map point from lower to higher values; unflipped they point the other way", () => {
    const params: ArrowParams = { ...defaultArrowParams, arrowScale: 0.02 };
    expect(params.arrowFlipDirection).toBe(true); // the default of the Directionality panel
    const along = (p: ArrowParams): number => {
      const arrows = bakeDirectionality(fromMap.ply, fromMap.labels, fromMap.order, p)[1];
      let sum = 0;
      const m = arrows.positions.length / 21;
      for (let k = 0; k < m; k++) sum += unit(sub(vert(arrows, 7 * k + 6), mid(vert(arrows, 7 * k), vert(arrows, 7 * k + 1))))[1];
      return sum / m;
    };
    // the map is the antero-posterior coordinate: "up the map" is +y
    expect(along(params)).toBeGreaterThan(0.5);
    expect(along({ ...params, arrowFlipDirection: false })).toBeLessThan(-0.5);
  });

  it("refuses labels that do not match the mesh", () => {
    expect(() => bakeDirectionality(fromMap.ply, fromMap.labels + "1\n", fromMap.order, defaultArrowParams)).toThrow(/labels/);
  });
});
