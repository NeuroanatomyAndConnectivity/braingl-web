import { describe, it, expect } from "vitest";
import { loadFromFiles } from "./loadFiles";

// A tetrahedron per "hemisphere"
const verts = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
const tris = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
const asc = (dx: number, scale = 1) =>
  `#!ascii version of test\n${verts.length} ${tris.length}\n` +
  verts.map((v) => `${v[0] * scale + dx} ${v[1] * scale} ${v[2] * scale} 0`).join("\n") + "\n" +
  tris.map((t) => `${t.join(" ")} 0`).join("\n") + "\n";

function matrix(n: number): ArrayBuffer {
  const m = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) m[i * n + j] = i === j ? 1 : 0.9 - 0.1 * Math.abs(i - j);
  return m.buffer;
}

describe("loadFromFiles", () => {
  it("loads an original brainGL glyphset with two hemispheres and offsets", async () => {
    const files = [
      new File(["anat.nii.gz\nL.set R.set\nconn.bin 0.5\n"], "avg.glyphset"),
      new File(["L.pial.asc -5 0 0\nL.inflated.asc -20 0 0\n"], "L.set"),
      new File(["R.pial.asc 5 0 0\n# comment\nR.inflated.asc 20 0 0\n"], "R.set"),
      new File([asc(0)], "L.pial.asc"), new File([asc(0, 2)], "L.inflated.asc"),
      new File([asc(0)], "R.pial.asc"), new File([asc(0, 2)], "R.inflated.asc"),
      new File([matrix(8)], "conn.bin"),
    ];
    const r = await loadFromFiles(files);
    const ds = r.dataset;
    expect(ds.n).toBe(8);
    expect(ds.leftNodes).toBe(4);
    expect(ds.leftTriangles).toBe(4);
    expect(ds.surfaces.map((s) => s.name)).toEqual(["pial", "inflated"]);
    expect(ds.surfaces[0].positions[0]).toBeCloseTo(-4); // 1 + offset -5
    expect(ds.surfaces[0].positions[12]).toBeCloseTo(6); // right hemisphere: 1 + 5
    expect(ds.triangles.length).toBe(24);
    expect(Math.max(...ds.triangles.subarray(12))).toBe(7); // right triangles index right nodes
    expect(Math.min(...ds.triangles.subarray(12))).toBe(4);
    expect(ds.conn.get(0, 1)).toBeCloseTo(0.8, 3);
    expect(r.minThreshold).toBeCloseTo(0.5);
    expect(Array.from(ds.mask)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("reports a missing referenced file clearly", async () => {
    const files = [new File(["anat.nii\nL.set\nconn.bin\n"], "x.glyphset"), new File(["L.pial.asc\n"], "L.set")];
    await expect(loadFromFiles(files)).rejects.toThrow(/L\.pial\.asc/);
  });

  it("loads loose surfaces plus a raw float32 matrix and separates the hemispheres", async () => {
    const files = [
      new File([asc(0)], "lh.pial.asc"), new File([asc(0)], "rh.pial.asc"),
      new File([asc(0, 3)], "lh.inflated.asc"), new File([asc(0, 3)], "rh.inflated.asc"),
      new File([matrix(8)], "fc.bin"),
    ];
    const { dataset: ds } = await loadFromFiles(files);
    expect(ds.n).toBe(8);
    expect(ds.surfaces.map((s) => s.name)).toEqual(["pial", "inflated"]);
    const infl = ds.surfaces[1].positions;
    let maxL = -Infinity, minR = Infinity;
    for (let i = 0; i < 4; i++) maxL = Math.max(maxL, infl[3 * i]);
    for (let i = 4; i < 8; i++) minR = Math.min(minR, infl[3 * i]);
    expect(minR - maxL).toBeGreaterThan(4); // moved apart
  });

  it("rejects a matrix of the wrong size", async () => {
    const files = [new File([asc(0)], "lh.pial.asc"), new File([matrix(5)], "fc.bin")];
    await expect(loadFromFiles(files)).rejects.toThrow(/5 x 5/);
  });

  it("loads a web glyphset from files", async () => {
    const n = 4;
    const pos = new Float32Array(verts.flat());
    const man = {
      format: "braingl-web-glyphset", version: 1, name: "tiny", nodes: n, triangles: "t.u32",
      surfaces: [{ name: "pial", file: "p.f32" }], connectivity: { file: "c.i8", dtype: "int8", layout: "upper", scale: 1 / 127 },
    };
    const files = [
      new File([JSON.stringify(man)], "glyphset.json"), new File([new Uint32Array(tris.flat())], "t.u32"),
      new File([pos.buffer], "p.f32"), new File([new Int8Array([127, 64, 0, -64, 32, 16])], "c.i8"),
    ];
    const { dataset: ds } = await loadFromFiles(files);
    expect(ds.name).toBe("tiny");
    expect(ds.conn.get(0, 1)).toBeCloseTo(1, 3);
    expect(ds.conn.get(2, 1)).toBeCloseTo(-64 / 127, 3);
    expect(ds.conn.get(3, 1)).toBeCloseTo(32 / 127, 3);
  });
});
