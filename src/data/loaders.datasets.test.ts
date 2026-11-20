/**
 * Every synthetic example dataset is written into every on-disk layout the
 * loaders accept (src/testing/serialise.ts) and has to load back unchanged.
 */
import { describe, it, expect } from "vitest";
import type { GlyphDataset } from "./dataset";
import { loadFromFiles } from "./loadFiles";
import { isWebManifest, loadWebGlyphset, WebGlyphsetManifest } from "./loadWeb";
import { directed, FixtureDataset, FIXTURES, icoBrain, singleHemisphere, withMedialWall } from "../testing/fixtures";
import {
  hemiSplit, LooseOptions, setOffset, storedValues, toBrainGLFiles, toLooseFiles, toWebGlyphsetFiles, WebDtype, WebLayout, webScale, without, writeNpy,
} from "../testing/serialise";
import { canonicalTriangles, signedVolume6 } from "../testing/reference";

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k] - b[k]));
  return worst;
}

/** Largest |loaded - expected| over the matrix; `zeroDiagonal` for layouts that do not store the diagonal. */
function matrixError(loaded: GlyphDataset, ds: FixtureDataset, zeroDiagonal: boolean): number {
  let worst = 0;
  for (let i = 0; i < ds.n; i++) {
    for (let j = 0; j < ds.n; j++) {
      const expected = zeroDiagonal && i === j ? 0 : ds.values[i * ds.n + j];
      worst = Math.max(worst, Math.abs(loaded.conn.get(i, j) - expected));
    }
  }
  return worst;
}

interface Expectation {
  positionTolerance: number;
  /** names of the surfaces expected, in order (default: those of the fixture) */
  surfaces?: string[];
}

/** Geometry, topology and hemisphere split of a loaded dataset equal those of the fixture. */
function expectSameMesh(loaded: GlyphDataset, ds: FixtureDataset, e: Expectation): void {
  expect(loaded.n).toBe(ds.n);
  expect(loaded.leftNodes).toBe(ds.leftNodes);
  expect(loaded.leftTriangles).toBe(ds.leftTriangles);
  expect(loaded.surfaces.map((s) => s.name)).toEqual(e.surfaces ?? ds.surfaces.map((s) => s.name));
  for (const s of loaded.surfaces) {
    const original = ds.surfaces.find((o) => o.name === s.name)!;
    expect(maxDiff(s.positions, original.positions)).toBeLessThanOrEqual(e.positionTolerance);
  }
  // identical triangles, wound outward
  expect(loaded.triangles.length).toBe(ds.triangles.length);
  expect(canonicalTriangles(loaded.triangles)).toEqual(canonicalTriangles(ds.triangles));
  const split = hemiSplit(ds);
  const ranges = split.two ? [[0, 3 * split.triangles], [3 * split.triangles, ds.triangles.length]] : [[0, ds.triangles.length]];
  for (const [a, b] of ranges) expect(signedVolume6(loaded.surfaces[0].positions, loaded.triangles, a, b)).toBeGreaterThan(0);
}

function flipWinding(ds: FixtureDataset): FixtureDataset {
  const triangles = Uint32Array.from(ds.triangles);
  for (let t = 0; t < triangles.length; t += 3) { const tmp = triangles[t + 1]; triangles[t + 1] = triangles[t + 2]; triangles[t + 2] = tmp; }
  return { ...ds, triangles };
}

const WEB_LAYOUTS: [WebDtype, WebLayout][] = [
  ["int8", "upper"], ["int16", "upper"], ["float32", "upper"], ["int8", "full"], ["int16", "full"], ["float32", "full"],
];

/** worst-case error of the value that ends up in the int16 matrix */
function webTolerance(ds: FixtureDataset, dtype: WebDtype, layout: WebLayout): number {
  let maxAbs = 0;
  for (const v of storedValues(ds, layout)) maxAbs = Math.max(maxAbs, Math.abs(v));
  const requantise = (0.5 * maxAbs) / 32767;
  if (dtype === "float32") return requantise + 1e-7 * maxAbs;
  return 0.5 * webScale(ds, { dtype, layout }) + (dtype === "int8" ? requantise : 0) + 1e-7 * maxAbs;
}

describe.each(FIXTURES)("web glyphset of $name", ({ make }) => {
  const ds = make();

  describe.each(WEB_LAYOUTS)("connectivity as %s, %s layout", (dtype, layout) => {
    it("loads back to the same dataset", async () => {
      const r = await loadFromFiles(toWebGlyphsetFiles(ds, { dtype, layout }));
      const loaded = r.dataset;
      expect([r.minThreshold, r.maxThreshold, r.roi, r.targets]).toEqual([null, null, null, null]);
      expect(loaded.name).toBe(ds.name);
      expect(loaded.description).toBe(ds.description);
      expectSameMesh(loaded, ds, { positionTolerance: 0 });
      expect(Array.from(loaded.mask)).toEqual(Array.from(ds.mask));
      expect(loaded.overlays.map((o) => o.name)).toEqual(ds.overlays.map((o) => o.name));
      loaded.overlays.forEach((o, k) => expect(maxDiff(o.data, ds.overlays[k].data)).toBe(0));
      expect(matrixError(loaded, ds, layout === "upper")).toBeLessThanOrEqual(webTolerance(ds, dtype, layout));
      if (layout === "upper") for (let i = 0; i < ds.n; i++) expect(loaded.conn.data[i * ds.n + i]).toBe(0);
    });
  });

  it("float32 full reproduces the int16 matrix of the fixture bit for bit", async () => {
    const { dataset } = await loadFromFiles(toWebGlyphsetFiles(ds, { dtype: "float32", layout: "full" }));
    expect(dataset.conn.scale).toBe(ds.conn.scale);
    expect(maxDiff(dataset.conn.data, ds.conn.data)).toBe(0);
  });

  it("restores the outward winding of triangles stored inside-out", async () => {
    const { dataset } = await loadFromFiles(toWebGlyphsetFiles(flipWinding(ds), { dtype: "int16", layout: "upper" }));
    expectSameMesh(dataset, ds, { positionTolerance: 0 });
  });

  it("assumes every node carries data when the manifest has no mask", async () => {
    const { dataset } = await loadFromFiles(toWebGlyphsetFiles(ds, { dtype: "int8", layout: "upper", noMask: true }));
    expect(Array.from(dataset.mask)).toEqual(new Array(ds.n).fill(1));
  });

  it("loads through a FileGetter (as fetch does) and reports its progress", async () => {
    const files = toWebGlyphsetFiles(ds, { dtype: "int16", layout: "full" });
    const byName = new Map(files.map((f) => [f.name, f]));
    const manifest: unknown = JSON.parse(await byName.get("glyphset.json")!.text());
    expect(isWebManifest(manifest)).toBe(true);
    const requested: string[] = [];
    const messages: string[] = [];
    const loaded = await loadWebGlyphset(manifest as WebGlyphsetManifest, async (name, onProgress) => {
      requested.push(name);
      onProgress?.(0.5);
      return byName.get(name)!.arrayBuffer();
    }, (msg) => messages.push(msg));
    expect(new Set(requested)).toEqual(new Set(files.map((f) => f.name).filter((nm) => nm !== "glyphset.json")));
    expect(messages.some((m) => /surfaces/i.test(m))).toBe(true);
    expect(messages.some((m) => /connectivity/i.test(m))).toBe(true);
    expectSameMesh(loaded, ds, { positionTolerance: 0 });
    expect(matrixError(loaded, ds, false)).toBeLessThanOrEqual(webTolerance(ds, "int16", "full"));
  });
});

describe.each(FIXTURES)("original brainGL glyphset of $name", ({ make }) => {
  const ds = make();
  const split = hemiSplit(ds);

  it("loads back to the same dataset, applying the per-surface offsets of the .set files", async () => {
    const r = await loadFromFiles(toBrainGLFiles(ds));
    const loaded = r.dataset;
    expect(loaded.name).toBe("fixture.glyphset");
    expectSameMesh(loaded, ds, { positionTolerance: 2e-4 });
    expect(loaded.overlays).toEqual([]);
    // raw float32 matrix: the int16 copy is identical to the fixture's
    expect(loaded.conn.scale).toBe(ds.conn.scale);
    expect(maxDiff(loaded.conn.data, ds.conn.data)).toBe(0);
    // nodes whose row is all zero are masked
    expect(Array.from(loaded.mask)).toEqual(Array.from(ds.mask));
    expect(r.minThreshold).toBeCloseTo(0.35, 6);
    expect(r.roi).toBeNull();
    expect(r.notes.join("\n")).toMatch(/minimum threshold 0\.35/);
  });

  it("really needs the offsets (the .asc files alone are shifted)", async () => {
    const files = toBrainGLFiles(ds);
    const asc = files.find((f) => f.name === "lh.inflated.asc")!;
    const firstVertex = (await asc.text()).split("\n")[2].trim().split(/\s+/).map(Number);
    const off = setOffset(1, false);
    for (let k = 0; k < 3; k++) expect(firstVertex[k] + off[k]).toBeCloseTo(ds.surfaces[1].positions[k], 4);
    expect(Math.abs(off[0])).toBeGreaterThan(1);
  });

  it("restores the outward winding of clockwise .asc triangles", async () => {
    const { dataset } = await loadFromFiles(toBrainGLFiles(ds, { flipWinding: true }));
    expectSameMesh(dataset, ds, { positionTolerance: 2e-4 });
  });

  it("reads the load-time threshold and the .1D ROI named on line 3", async () => {
    const roi = Uint8Array.from({ length: ds.n }, (_, i) => (i % 4 === 1 ? 1 : 0));
    const r = await loadFromFiles(toBrainGLFiles(ds, { roi, minThreshold: 0.62 }));
    expect(r.minThreshold).toBeCloseTo(0.62, 6);
    expect(r.roi).not.toBeNull();
    expect(Array.from(r.roi!)).toEqual(Array.from(roi));
    expect(r.maxThreshold).toBeNull(); // 1.0 = no upper limit
    expect(r.targets).toBeNull();
  });

  it("reads the maximum threshold and the second ROI (connection targets) named on line 3", async () => {
    const roi = Uint8Array.from({ length: ds.n }, (_, i) => (i % 4 === 1 ? 1 : 0));
    const targets = Uint8Array.from(ds.modules, (m) => (m >= 4 ? 1 : 0));
    const r = await loadFromFiles(toBrainGLFiles(ds, { roi, targets, minThreshold: 0.2, maxThreshold: 0.75 }));
    expect(r.minThreshold).toBeCloseTo(0.2, 6);
    expect(r.maxThreshold).toBeCloseTo(0.75, 6);
    expect(Array.from(r.roi!)).toEqual(Array.from(roi));
    expect(r.targets).not.toBeNull();
    expect(Array.from(r.targets!)).toEqual(Array.from(targets));
  });

  it("does not depend on the order of the dropped files", async () => {
    const files = toBrainGLFiles(ds).reverse();
    const { dataset } = await loadFromFiles(files);
    expectSameMesh(dataset, ds, { positionTolerance: 2e-4 });
    expect(maxDiff(dataset.conn.data, ds.conn.data)).toBe(0);
  });

  it("names every missing file", async () => {
    const files = toBrainGLFiles(ds);
    await expect(loadFromFiles(without(files, "lh.inflated.asc"))).rejects.toThrow(/lh\.inflated\.asc/);
    await expect(loadFromFiles(without(files, "connectivity.bin"))).rejects.toThrow(/connectivity\.bin/);
    await expect(loadFromFiles(without(files, "lh.set"))).rejects.toThrow(/lh\.set/);
    if (split.two) await expect(loadFromFiles(without(files, "rh.pial.asc"))).rejects.toThrow(/rh\.pial\.asc/);
  });
});

const LOOSE_CASES: LooseOptions[] = [
  { surfaces: "gifti", matrix: "npy-f4" },
  { surfaces: "gifti", matrix: "npy-f8" },
  { surfaces: "gifti", matrix: "npy-f4-fortran" },
  { surfaces: "gifti", matrix: "npy-f8-fortran" },
  { surfaces: "gifti", matrix: "npy-f8-big-endian" },
  { surfaces: "gifti", matrix: "npy-v2" },
  { surfaces: "gifti", matrix: "raw" },
  { surfaces: "gifti-base64", matrix: "npy-f4" },
  { surfaces: "gifti-ascii", matrix: "raw" },
  { surfaces: "gifti-gzip-member", matrix: "npy-f8" },
  { surfaces: "freesurfer", matrix: "npy-f4" },
  { surfaces: "freesurfer", matrix: "raw" },
  { surfaces: "asc", matrix: "npy-f8-fortran" },
  { surfaces: "gifti", matrix: "npy-f4", flipWinding: true },
  { surfaces: "freesurfer", matrix: "npy-f8", flipWinding: true },
];

describe.each(FIXTURES)("loose files of $name", ({ make }) => {
  const ds = make();
  const split = hemiSplit(ds);

  it.each(LOOSE_CASES)("surfaces as $surfaces, matrix as $matrix (flipped winding: $flipWinding)", async (o) => {
    const r = await loadFromFiles(toLooseFiles(ds, o));
    const loaded = r.dataset;
    expect(loaded.name).toBe(o.matrix === "raw" ? "connectivity.bin" : "connectivity.npy");
    expectSameMesh(loaded, ds, { positionTolerance: o.surfaces === "asc" ? 1e-5 : 0 });
    expect(loaded.conn.scale).toBe(ds.conn.scale);
    expect(maxDiff(loaded.conn.data, ds.conn.data)).toBe(0);
    expect(Array.from(loaded.mask)).toEqual(Array.from(ds.mask));
    expect(loaded.overlays).toEqual([]);
    expect(r.minThreshold).toBeNull();
    expect(r.roi).toBeNull();
  });

  it("does not depend on the order of the dropped files", async () => {
    const { dataset } = await loadFromFiles(toLooseFiles(ds, { surfaces: "gifti", matrix: "npy-f4" }).reverse());
    expectSameMesh(dataset, ds, { positionTolerance: 0 });
    expect(maxDiff(dataset.conn.data, ds.conn.data)).toBe(0);
  });

  it.each(["gifti", "1d"] as const)("joins per-hemisphere scalar files (%s) into overlays", async (overlays) => {
    if (!ds.overlays.length) return;
    const { dataset } = await loadFromFiles(toLooseFiles(ds, { surfaces: "gifti", matrix: "npy-f4", overlays }));
    expect(dataset.overlays.map((v) => v.name)).toEqual(ds.overlays.map((v) => v.name));
    dataset.overlays.forEach((v, k) => expect(maxDiff(v.data, ds.overlays[k].data)).toBeLessThanOrEqual(1e-6));
  });

  it("separates hemispheres that are stored centred on the origin, leaving a 5 mm gap", async () => {
    if (!split.two) return;
    const { dataset } = await loadFromFiles(toLooseFiles(ds, { surfaces: "freesurfer", matrix: "npy-f4", centred: true }));
    expect(dataset.surfaces.map((s) => s.name)).toEqual(ds.surfaces.map((s) => s.name));
    // the anatomical surface is left where it is
    expect(maxDiff(dataset.surfaces[0].positions, ds.surfaces[0].positions)).toBe(0);
    for (let k = 1; k < ds.surfaces.length; k++) {
      const got = dataset.surfaces[k].positions, want = ds.surfaces[k].positions;
      let maxL = -Infinity, minR = Infinity;
      for (let i = 0; i < ds.leftNodes; i++) maxL = Math.max(maxL, got[3 * i]);
      for (let i = ds.leftNodes; i < ds.n; i++) minR = Math.min(minR, got[3 * i]);
      expect(minR - maxL).toBeCloseTo(5, 3);
      // each hemisphere is only translated along x
      for (const [from, to] of [[0, ds.leftNodes], [ds.leftNodes, ds.n]]) {
        const shift = got[3 * from] - want[3 * from];
        let worst = 0;
        for (let i = from; i < to; i++) {
          worst = Math.max(worst, Math.abs(got[3 * i] - want[3 * i] - shift), Math.abs(got[3 * i + 1] - want[3 * i + 1]), Math.abs(got[3 * i + 2] - want[3 * i + 2]));
        }
        expect(worst).toBeLessThan(1e-3);
      }
    }
  });
});

describe("loose FreeSurfer curvature files", () => {
  // BUG (src/data/loadFiles.ts, loose-file branch): the file type is sniffed from `f.slice(0, 3)`, but
  // isFreeSurferCurv() needs the 15-byte header and returns false for anything shorter. A binary lh.sulc /
  // lh.curv is therefore never recognised as an overlay; it is silently treated as a matrix candidate.
  it.fails("lh.sulc + rh.sulc become a 'sulc' overlay", async () => {
    const ds = icoBrain(1);
    const { dataset } = await loadFromFiles(toLooseFiles(ds, { surfaces: "freesurfer", matrix: "npy-f4", overlays: "curv" }));
    expect(dataset.overlays.map((v) => v.name)).toEqual(["sulc"]);
    expect(maxDiff(dataset.overlays[0].data, ds.overlays[0].data)).toBe(0);
  });

  it("a curvature file at least does not break loading", async () => {
    const ds = icoBrain(1);
    const { dataset } = await loadFromFiles(toLooseFiles(ds, { surfaces: "freesurfer", matrix: "npy-f4", overlays: "curv" }));
    expectSameMesh(dataset, ds, { positionTolerance: 0 });
    expect(maxDiff(dataset.conn.data, ds.conn.data)).toBe(0);
  });
});

describe("asymmetric matrices keep rows and columns apart", () => {
  const ds = directed(singleHemisphere(1));

  it.each<LooseOptions["matrix"]>(["npy-f4", "npy-f8", "npy-f4-fortran", "npy-f8-fortran", "npy-f8-big-endian", "npy-v2", "raw"])("loose files, matrix as %s", async (matrix) => {
    const { dataset } = await loadFromFiles(toLooseFiles(ds, { surfaces: "gifti", matrix }));
    expect(maxDiff(dataset.conn.data, ds.conn.data)).toBe(0);
    expect(dataset.conn.get(5, 2)).toBeCloseTo(ds.values[5 * ds.n + 2], 4);
    expect(dataset.conn.get(2, 5)).toBeCloseTo(2 * ds.values[5 * ds.n + 2], 4);
  });

  it.each<WebDtype>(["int8", "int16", "float32"])("web glyphset, %s full layout", async (dtype) => {
    const { dataset } = await loadFromFiles(toWebGlyphsetFiles(ds, { dtype, layout: "full" }));
    expect(matrixError(dataset, ds, false)).toBeLessThanOrEqual(webTolerance(ds, dtype, "full"));
  });

  it("brainGL raw float32 matrix", async () => {
    const { dataset } = await loadFromFiles(toBrainGLFiles(ds));
    expect(maxDiff(dataset.conn.data, ds.conn.data)).toBe(0);
  });
});

describe("loader error paths", () => {
  const ds = icoBrain(1);
  const web = () => toWebGlyphsetFiles(ds, { dtype: "int8", layout: "upper" });
  const replace = (files: File[], name: string, data: BlobPart): File[] => [...without(files, name), new File([data], name)];

  it.each(["triangles.u32", "pial.f32", "sphere.f32", "sulc.f32", "mask.u8", "connectivity.i8"])("web glyphset: a missing %s is named in the error", async (name) => {
    await expect(loadFromFiles(without(web(), name))).rejects.toThrow(new RegExp(name.replace(".", "\\.")));
  });

  it("web glyphset: a surface with the wrong node count is rejected", async () => {
    await expect(loadFromFiles(replace(web(), "inflated.f32", new Float32Array(3 * (ds.n - 1))))).rejects.toThrow(/"inflated" has 83 nodes, expected 84/);
  });

  it("web glyphset: an upper triangle of the wrong length is rejected", async () => {
    await expect(loadFromFiles(replace(web(), "connectivity.i8", new Int8Array(100)))).rejects.toThrow(/upper triangle has 100 entries, expected 3486/);
  });

  it("web glyphset: a full matrix of the wrong size is rejected", async () => {
    const files = toWebGlyphsetFiles(ds, { dtype: "float32", layout: "full" });
    await expect(loadFromFiles(replace(files, "connectivity.f32", new Float32Array(83 * 83)))).rejects.toThrow(/expected 84x84/);
  });

  it("web glyphset: an overlay of the wrong length is skipped rather than shown misaligned", async () => {
    const { dataset } = await loadFromFiles(replace(web(), "sulc.f32", new Float32Array(ds.n + 3)));
    expect(dataset.overlays).toEqual([]);
  });

  it("a JSON file that is not a glyphset manifest is ignored", async () => {
    const files = [...toLooseFiles(ds, { surfaces: "gifti", matrix: "npy-f4" }), new File(['{"hello": "world"}'], "notes.json")];
    const { dataset } = await loadFromFiles(files);
    expect(dataset.n).toBe(ds.n);
  });

  it("brainGL glyphset: a matrix of the wrong size is rejected with both sizes", async () => {
    const files = replace(toBrainGLFiles(ds), "connectivity.bin", new Float32Array(80 * 80));
    await expect(loadFromFiles(files)).rejects.toThrow(/80 x 80.*84 nodes/);
  });

  it("brainGL glyphset: a file that is not a square float32 matrix is rejected", async () => {
    const files = replace(toBrainGLFiles(ds), "connectivity.bin", new Uint8Array(1001));
    await expect(loadFromFiles(files)).rejects.toThrow(/not a square float32 matrix/);
  });

  it("brainGL glyphset: surfaces with different node counts are rejected", async () => {
    const small = singleHemisphere(1);
    const other = toBrainGLFiles(icoBrain(2)).find((f) => f.name === "lh.inflated.asc")!;
    const files = [...without(toBrainGLFiles(small), "lh.inflated.asc"), other];
    await expect(loadFromFiles(files)).rejects.toThrow(/different node count/);
  });

  it("loose files: a matrix of the wrong size is rejected with both sizes", async () => {
    const files = [...without(toLooseFiles(ds, { surfaces: "gifti", matrix: "raw" }), "connectivity.bin"), new File([new Float32Array(50 * 50)], "connectivity.bin")];
    await expect(loadFromFiles(files)).rejects.toThrow(/50 x 50.*84 nodes/);
    const npy = [...without(toLooseFiles(ds, { surfaces: "gifti", matrix: "npy-f4" }), "connectivity.npy"), new File([writeNpy(new Float32Array(50 * 50), 50, { dtype: "<f4" })], "connectivity.npy")];
    await expect(loadFromFiles(npy)).rejects.toThrow(/50 x 50.*84 nodes/);
  });

  it("loose files: a non-square .npy is rejected with its shape", async () => {
    const npy = writeNpy(new Float32Array(84 * 84), 84, { dtype: "<f4" });
    // patch the shape in the header in place: "(84, 84)" -> "(56,126)", same length and same number of elements
    const at = new TextDecoder("latin1").decode(npy.subarray(0, 128)).indexOf("(84, 84)");
    expect(at).toBeGreaterThan(0);
    npy.set(Array.from("(56,126)", (ch) => ch.charCodeAt(0)), at);
    const files = [...without(toLooseFiles(ds, { surfaces: "gifti", matrix: "npy-f4" }), "connectivity.npy"), new File([npy], "connectivity.npy")];
    await expect(loadFromFiles(files)).rejects.toThrow(/square 2-D array.*56, 126/);
  });

  it("loose files: surfaces without a matrix, and a matrix without surfaces, are explained", async () => {
    const files = toLooseFiles(ds, { surfaces: "gifti", matrix: "npy-f4" });
    await expect(loadFromFiles(without(files, "connectivity.npy"))).rejects.toThrow(/No connectivity matrix found/);
    await expect(loadFromFiles(files.filter((f) => f.name === "connectivity.npy"))).rejects.toThrow(/No surface found/);
    await expect(loadFromFiles([])).rejects.toThrow(/No surface found/);
  });

  it("loose files: a surface with a different node count is skipped and noted", async () => {
    const other = toLooseFiles(singleHemisphere(2), { surfaces: "gifti", matrix: "raw" }).find((f) => f.name === "inflated.surf.gii")!;
    const base = toLooseFiles(singleHemisphere(1), { surfaces: "gifti", matrix: "npy-f4" });
    const r = await loadFromFiles([...without(base, "inflated.surf.gii"), other]);
    expect(r.dataset.surfaces.map((s) => s.name)).toEqual(["pial"]);
    expect(r.notes.join("\n")).toMatch(/skipped surface "inflated"/);
  });

  it("the medial wall survives every layout as mask = 0", async () => {
    const wall = withMedialWall(ds);
    expect(Array.from(wall.mask).filter((m) => m === 0).length).toBeGreaterThan(0);
    for (const files of [toWebGlyphsetFiles(wall, { dtype: "int8", layout: "upper" }), toBrainGLFiles(wall), toLooseFiles(wall, { surfaces: "freesurfer", matrix: "raw" })]) {
      const { dataset } = await loadFromFiles(files);
      expect(Array.from(dataset.mask)).toEqual(Array.from(wall.mask));
    }
  });
});

describe("GlyphApp.setDataset", () => {
  it("rejects more than 65,535 nodes (node ids are 16-bit on the GPU)", async () => {
    // the size check is the first statement, so it can be exercised without a DOM or a GL context
    const { GlyphApp } = await import("../glyphs/glyphApp");
    const tooBig = { n: 65536 } as GlyphDataset;
    expect(() => GlyphApp.prototype.setDataset.call({} as never, tooBig, null, null)).toThrow(/65536 nodes.*65,535/);
  });
});
