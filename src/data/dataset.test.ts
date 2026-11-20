import { describe, it, expect } from "vitest";
import { buildTopology, computeBounds, computeNormals, findSphere, normaliseSulc, orientOutward, surfaceIndexByName } from "./dataset";
import { ALL_FIXTURES, BRAIN_SHAPE, FIXTURES, icoBrain, icosphere, singleHemisphere } from "../testing/fixtures";
import { hemiSplit } from "../testing/serialise";
import { at, canonicalTriangles, dot, edgeSet, norm, refNormals, signedVolume6, sub, unit } from "../testing/reference";

describe.each(ALL_FIXTURES)("buildTopology on $name", ({ make }) => {
  const ds = make();
  const topo = buildTopology(ds.n, ds.triangles);
  const expected = edgeSet(ds.triangles);

  it("lists every undirected edge exactly once, as (a < b) pairs", () => {
    expect(topo.edges.length).toBe(2 * expected.size);
    const seen = new Set<string>();
    for (let e = 0; e < topo.edges.length; e += 2) {
      expect(topo.edges[e]).toBeLessThan(topo.edges[e + 1]);
      seen.add(`${topo.edges[e]}-${topo.edges[e + 1]}`);
    }
    expect(seen.size).toBe(expected.size);
    for (const e of expected) expect(seen.has(e)).toBe(true);
  });

  it("has a symmetric CSR adjacency without self-loops or duplicates", () => {
    expect(topo.adjStart.length).toBe(ds.n + 1);
    expect(topo.adjStart[0]).toBe(0);
    expect(topo.adjStart[ds.n]).toBe(topo.adj.length);
    expect(topo.adj.length).toBe(2 * expected.size);
    const has = (a: number, b: number) => topo.adj.subarray(topo.adjStart[a], topo.adjStart[a + 1]).includes(b);
    for (let a = 0; a < ds.n; a++) {
      const row = Array.from(topo.adj.subarray(topo.adjStart[a], topo.adjStart[a + 1]));
      expect(new Set(row).size).toBe(row.length);
      expect(row).not.toContain(a);
      expect(row.length === 5 || row.length === 6).toBe(true); // icosphere valences
      for (const b of row) {
        expect(has(b, a)).toBe(true);
        expect(expected.has(a < b ? `${a}-${b}` : `${b}-${a}`)).toBe(true);
      }
    }
  });

  it("satisfies Euler's formula per hemisphere and never connects the hemispheres", () => {
    const s = hemiSplit(ds);
    const hemis = s.two ? 2 : 1;
    expect(ds.n - topo.edges.length / 2 + ds.triangles.length / 3).toBe(2 * hemis);
    if (s.two) {
      for (let e = 0; e < topo.edges.length; e += 2) expect(topo.edges[e] < s.nodes).toBe(topo.edges[e + 1] < s.nodes);
    }
  });
});

describe("buildTopology on small meshes", () => {
  it("handles a single triangle", () => {
    const t = buildTopology(3, new Uint32Array([0, 1, 2]));
    expect(Array.from(t.edges)).toEqual([0, 1, 0, 2, 1, 2]);
    expect(Array.from(t.adjStart)).toEqual([0, 2, 4, 6]);
    expect(Array.from(t.adj)).toEqual([1, 2, 0, 2, 0, 1]);
  });
  it("leaves unreferenced nodes without neighbours", () => {
    const t = buildTopology(6, new Uint32Array([0, 2, 5]));
    expect(Array.from(t.adjStart)).toEqual([0, 2, 2, 4, 4, 4, 6]);
    expect(Array.from(t.edges)).toEqual([0, 2, 0, 5, 2, 5]);
  });
  it("does not duplicate the edge shared by two triangles, whatever their winding", () => {
    const t = buildTopology(4, new Uint32Array([0, 1, 2, 1, 2, 3]));
    expect(t.edges.length / 2).toBe(5);
    expect(Array.from(t.adj.subarray(t.adjStart[1], t.adjStart[2]))).toEqual([0, 2, 3]);
  });
  it("ignores degenerate triangles that repeat a vertex", () => {
    const t = buildTopology(3, new Uint32Array([0, 0, 1]));
    expect(Array.from(t.edges)).toEqual([0, 1]);
  });
  it("handles an empty mesh", () => {
    const t = buildTopology(4, new Uint32Array(0));
    expect(t.edges.length).toBe(0);
    expect(Array.from(t.adjStart)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe.each(FIXTURES)("computeNormals on $name", ({ make }) => {
  const ds = make();

  it.each(ds.surfaces.map((s, k) => [s.name, k] as const))("%s: unit length and equal to a double-precision reference", (_name, k) => {
    const pos = ds.surfaces[k].positions;
    const normals = computeNormals(pos, ds.triangles);
    const ref = refNormals(pos, ds.triangles);
    expect(normals.length).toBe(3 * ds.n);
    for (let i = 0; i < ds.n; i++) {
      expect(norm(at(normals, i))).toBeCloseTo(1, 5);
      for (let c = 0; c < 3; c++) expect(normals[3 * i + c]).toBeCloseTo(ref[3 * i + c], 4);
    }
  });

  it("points outward on every surface (the surfaces are star-shaped around their centres)", () => {
    const S = BRAIN_SHAPE;
    const centres = { pial: S.pialCenter, inflated: S.inflatedCenter, sphere: S.sphereCenter } as Record<string, readonly number[]>;
    const split = hemiSplit(ds);
    for (const s of ds.surfaces) {
      const normals = computeNormals(s.positions, ds.triangles);
      for (let i = 0; i < ds.n; i++) {
        const right = split.two && i >= split.nodes;
        const c = [right ? -centres[s.name][0] : centres[s.name][0], centres[s.name][1], centres[s.name][2]];
        expect(dot(at(normals, i), unit(sub(at(s.positions, i), c)))).toBeGreaterThan(s.name === "sphere" ? 0.99 : s.name === "inflated" ? 0.6 : 0.2);
      }
    }
  });
});

describe("computeNormals", () => {
  it.each([1, 2, 3])("is radial on an icosphere of level %i", (level) => {
    const mesh = icosphere(level);
    const pos = Float32Array.from(mesh.unit, (v) => 100 * v);
    const normals = computeNormals(pos, mesh.triangles);
    let worst = 1;
    for (let i = 0; i < pos.length / 3; i++) worst = Math.min(worst, dot(at(normals, i), at(mesh.unit, i)));
    expect(worst).toBeGreaterThan(0.999);
  });
  it("is the face normal of a single counter-clockwise triangle", () => {
    const n = computeNormals(new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]), new Uint32Array([0, 1, 2]));
    expect(Array.from(n)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });
  it("weights faces by area", () => {
    // vertex 0 is shared by a large triangle in the xy plane (normal +z, area 50) and a small one in the xz plane (normal -y, area 0.5)
    const pos = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1]);
    const n = computeNormals(pos, new Uint32Array([0, 1, 2, 0, 3, 4]));
    expect(n[2]).toBeCloseTo(100 / Math.hypot(100, 1), 5);
    expect(n[1]).toBeCloseTo(-1 / Math.hypot(100, 1), 5);
  });
  it("leaves unreferenced vertices with a zero normal instead of NaN", () => {
    const n = computeNormals(new Float32Array(12), new Uint32Array([0, 1, 2]));
    expect(Array.from(n).every((v) => v === 0)).toBe(true);
  });
});

function flipRange(tri: Uint32Array, from: number, to: number): void {
  for (let t = from; t < to; t += 3) { const tmp = tri[t + 1]; tri[t + 1] = tri[t + 2]; tri[t + 2] = tmp; }
}

describe.each(FIXTURES)("orientOutward on $name", ({ make }) => {
  const ds = make();
  const split = hemiSplit(ds);
  const pos = ds.surfaces[0].positions;
  const original = canonicalTriangles(ds.triangles);
  const ranges: [number, number][] = split.two ? [[0, 3 * split.triangles], [3 * split.triangles, ds.triangles.length]] : [[0, ds.triangles.length]];

  it("leaves an outward-wound mesh untouched", () => {
    const tri = Uint32Array.from(ds.triangles);
    for (const [a, b] of ranges) orientOutward(pos, tri, a, b);
    expect(tri).toEqual(ds.triangles);
  });

  it("restores the winding of a mesh stored inside-out", () => {
    const tri = Uint32Array.from(ds.triangles);
    flipRange(tri, 0, tri.length);
    for (const [a, b] of ranges) {
      expect(signedVolume6(pos, tri, a, b)).toBeLessThan(0);
      orientOutward(pos, tri, a, b);
      expect(signedVolume6(pos, tri, a, b)).toBeGreaterThan(0);
    }
    expect(canonicalTriangles(tri)).toEqual(original);
  });

  it("treats the hemispheres independently", () => {
    if (!split.two) return;
    const tri = Uint32Array.from(ds.triangles);
    flipRange(tri, ranges[1][0], ranges[1][1]); // only the right hemisphere is inside-out
    orientOutward(pos, tri, ranges[0][0], ranges[0][1]);
    expect(signedVolume6(pos, tri, ranges[1][0], ranges[1][1])).toBeLessThan(0); // untouched so far
    orientOutward(pos, tri, ranges[1][0], ranges[1][1]);
    expect(canonicalTriangles(tri)).toEqual(original);
  });

  it("does not depend on where the mesh sits in space", () => {
    const moved = Float32Array.from(pos, (v, k) => v + [500, -300, 200][k % 3]);
    const tri = Uint32Array.from(ds.triangles);
    flipRange(tri, 0, tri.length);
    for (const [a, b] of ranges) orientOutward(moved, tri, a, b);
    expect(canonicalTriangles(tri)).toEqual(original);
  });
});

describe("orientOutward", () => {
  it("accepts an empty range", () => {
    const tri = new Uint32Array([0, 1, 2]);
    orientOutward(new Float32Array(9), tri, 0, 0);
    expect(Array.from(tri)).toEqual([0, 1, 2]);
  });
});

describe("computeBounds", () => {
  it("returns the centre of the bounding box and the largest distance from it", () => {
    const pos = new Float32Array([0, 0, 0, 10, 0, 0, 0, 4, 0, 0, 0, -2, 10, 4, -2]);
    const b = computeBounds(pos);
    expect(b.center).toEqual([5, 2, -1]);
    expect(b.radius).toBeCloseTo(Math.hypot(5, 2, 1), 6);
  });
  it("restricts to a node range", () => {
    const pos = new Float32Array([0, 0, 0, 10, 0, 0, 100, 100, 100, 104, 100, 100]);
    expect(computeBounds(pos, 2, 4)).toEqual({ center: [102, 100, 100], radius: 2 });
    expect(computeBounds(pos, 0, 2)).toEqual({ center: [5, 0, 0], radius: 5 });
  });

  it.each(FIXTURES)("encloses every node of every surface of $name, tightly", ({ make }) => {
    const ds = make();
    for (const s of ds.surfaces) {
      const b = computeBounds(s.positions);
      let far = 0;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < ds.n; i++) {
        far = Math.max(far, norm(sub(at(s.positions, i), b.center)));
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s.positions[3 * i + k]); hi[k] = Math.max(hi[k], s.positions[3 * i + k]); }
      }
      expect(b.radius).toBeCloseTo(far, 4);
      for (let k = 0; k < 3; k++) expect(b.center[k]).toBeCloseTo((lo[k] + hi[k]) / 2, 4);
      // a sphere around the box centre cannot be larger than the box diagonal / 2
      expect(b.radius).toBeLessThanOrEqual(norm(sub(hi, lo)) / 2 + 1e-4);
    }
  });

  it("is symmetric about x = 0 for the mirrored hemispheres", () => {
    const ds = icoBrain(2);
    for (const s of ds.surfaces) expect(computeBounds(s.positions).center[0]).toBeCloseTo(0, 4);
    const l = computeBounds(ds.surfaces[2].positions, 0, ds.leftNodes), r = computeBounds(ds.surfaces[2].positions, ds.leftNodes, ds.n);
    expect(l.center[0]).toBeCloseTo(-r.center[0], 4);
    expect(l.radius).toBeCloseTo(r.radius, 4);
    expect(l.radius).toBeGreaterThan(95);
    expect(l.radius).toBeLessThan(105);
  });
});

describe("findSphere", () => {
  it.each(ALL_FIXTURES.filter((f) => f.name.startsWith("icoBrain")))("finds the sphere surface and both centres of $name", ({ make }) => {
    const ds = make();
    const s = findSphere(ds);
    expect(s).not.toBeNull();
    expect(ds.surfaces[s!.surface].name).toBe("sphere");
    expect(s!.centerL[0]).toBeCloseTo(-105, 3);
    expect(s!.centerR[0]).toBeCloseTo(105, 3);
    for (const c of [s!.centerL, s!.centerR]) { expect(c[1]).toBeCloseTo(0, 3); expect(c[2]).toBeCloseTo(0, 3); }
  });

  it.each(ALL_FIXTURES.filter((f) => f.name.startsWith("singleHemisphere")))("returns null for $name, which has no sphere", ({ make }) => {
    expect(findSphere(make())).toBeNull();
  });

  it("finds the sphere wherever it is in the surface list", () => {
    const ds = icoBrain(1);
    const reordered = { ...ds, surfaces: [ds.surfaces[2], ds.surfaces[0], ds.surfaces[1]] };
    expect(findSphere(reordered)!.surface).toBe(0);
  });

  it("uses one centre for an unsplit dataset", () => {
    const base = singleHemisphere(2);
    const sphere = Float32Array.from(base.unit, (v, k) => 50 * v + [7, -3, 11][k % 3]);
    const s = findSphere({ ...base, surfaces: [...base.surfaces, { name: "ball", positions: sphere }] });
    expect(s).not.toBeNull();
    expect(s!.surface).toBe(2);
    expect(s!.centerR).toEqual(s!.centerL);
    expect(s!.centerL[0]).toBeCloseTo(7, 3);
    expect(s!.centerL[1]).toBeCloseTo(-3, 3);
    expect(s!.centerL[2]).toBeCloseTo(11, 3);
  });

  it("rejects a surface whose radius varies by more than 2 %", () => {
    const base = singleHemisphere(2);
    const egg = Float32Array.from(base.unit, (v, k) => v * (k % 3 === 2 ? 110 : 100));
    expect(findSphere({ ...base, surfaces: [{ name: "egg", positions: egg }] })).toBeNull();
    const nearly = Float32Array.from(base.unit, (v, k) => v * (k % 3 === 2 ? 101 : 100));
    expect(findSphere({ ...base, surfaces: [{ name: "nearly", positions: nearly }] })).not.toBeNull();
  });

  it("prefers the rounder of two candidates", () => {
    const base = singleHemisphere(2);
    const nearly = Float32Array.from(base.unit, (v, k) => v * (k % 3 === 2 ? 101 : 100));
    const exact = Float32Array.from(base.unit, (v) => v * 100);
    expect(findSphere({ ...base, surfaces: [{ name: "nearly", positions: nearly }, { name: "exact", positions: exact }] })!.surface).toBe(1);
    expect(findSphere({ ...base, surfaces: [{ name: "exact", positions: exact }, { name: "nearly", positions: nearly }] })!.surface).toBe(0);
  });
});

describe("surfaceIndexByName", () => {
  const ds = icoBrain(1);
  it("returns the first surface matching a fragment, in fragment order", () => {
    expect(surfaceIndexByName(ds, ["inflated"])).toBe(1);
    expect(surfaceIndexByName(ds, ["white", "sphere", "pial"])).toBe(2);
    expect(surfaceIndexByName(ds, ["infl"])).toBe(1);
  });
  it("falls back to a valid index", () => {
    expect(surfaceIndexByName(ds, ["white"])).toBe(0);
    expect(surfaceIndexByName(ds, ["white"], 1)).toBe(1);
    expect(surfaceIndexByName(ds, ["white"], 99)).toBe(2);
  });
});

describe("normaliseSulc", () => {
  it("centres to mean 0 and scales to a standard deviation of 0.5", () => {
    const sulc = icoBrain(2).overlays[0].data;
    const out = normaliseSulc(sulc);
    let mean = 0, sq = 0;
    for (const v of out) mean += v;
    mean /= out.length;
    for (const v of out) sq += (v - mean) ** 2;
    expect(mean).toBeCloseTo(0, 5);
    expect(Math.sqrt(sq / out.length)).toBeCloseTo(0.5, 5);
    expect(out).not.toBe(sulc);
  });
  it("keeps the ordering of the values", () => {
    const out = normaliseSulc(new Float32Array([3, 1, 2, 10]));
    expect(out[1]).toBeLessThan(out[2]);
    expect(out[2]).toBeLessThan(out[0]);
    expect(out[0]).toBeLessThan(out[3]);
  });
  it("matches the closed form (x - mean) / (2 sd)", () => {
    const out = normaliseSulc(new Float32Array([0, 2, 4, 6])); // mean 3, population sd sqrt(5)
    for (let i = 0; i < 4; i++) expect(out[i]).toBeCloseTo((2 * i - 3) / (2 * Math.sqrt(5)), 6);
  });
  it("maps a constant map to zeros and survives an empty one", () => {
    expect(Array.from(normaliseSulc(new Float32Array([4, 4, 4])))).toEqual([0, 0, 0]);
    expect(normaliseSulc(new Float32Array(0)).length).toBe(0);
  });
});
