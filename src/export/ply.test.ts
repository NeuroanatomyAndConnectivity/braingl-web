import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { crc32, Layer, writePly, zipStore } from "./ply";
import { FIXTURES, lcg } from "../testing/fixtures";
import { readPly, readZip, referenceCrc32 } from "../testing/formats";

const nodeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array) => number }).crc32;
const hasUnzip = spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0;

function randomLayer(kind: Layer["kind"], nv: number, seed: number): Layer {
  const rnd = lcg(seed);
  const positions = Float32Array.from({ length: 3 * nv }, () => (rnd() - 0.5) * 300);
  const colors = Uint8Array.from({ length: 4 * nv }, () => Math.floor(rnd() * 256));
  const layer: Layer = { name: `random ${kind}`, kind, positions, colors, shading: "flat" };
  if (kind === "mesh") layer.triangles = Uint32Array.from({ length: 3 * (nv - 2) }, () => Math.floor(rnd() * nv));
  if (kind === "segments") layer.edges = Uint32Array.from({ length: 2 * Math.floor(nv / 2) }, () => Math.floor(rnd() * nv));
  return layer;
}

describe("writePly", () => {
  describe.each<[Layer["kind"], number]>([["mesh", 50], ["points", 33], ["segments", 40], ["mesh", 3], ["points", 1]])("%s layer with %i vertices", (kind, nv) => {
    const layer = randomLayer(kind, nv, nv + kind.length);
    const buf = writePly(layer);
    const ply = readPly(buf);

    it("announces the element counts in an ASCII header", () => {
      const header = new TextDecoder().decode(new Uint8Array(buf, 0, ply.headerBytes));
      expect(header.startsWith("ply\nformat binary_little_endian 1.0\n")).toBe(true);
      expect(header.endsWith("end_header\n")).toBe(true);
      expect(ply.elements[0]).toEqual({ name: "vertex", count: nv, properties: ["float x", "float y", "float z", "uchar red", "uchar green", "uchar blue", "uchar alpha"] });
      const names = ply.elements.map((e) => e.name);
      expect(names).toEqual(kind === "mesh" ? ["vertex", "face"] : kind === "segments" ? ["vertex", "edge"] : ["vertex"]);
      if (kind === "mesh") expect(ply.elements[1].count).toBe(layer.triangles!.length / 3);
      if (kind === "segments") expect(ply.elements[1].count).toBe(layer.edges!.length / 2);
      expect(ply.comments.join(" ")).toContain(`${kind} layer: random ${kind}`);
    });

    it("has exactly 16 bytes per vertex, 13 per face and 8 per edge after the header", () => {
      const nf = layer.triangles ? layer.triangles.length / 3 : 0, ne = layer.edges ? layer.edges.length / 2 : 0;
      expect(buf.byteLength).toBe(ply.headerBytes + 16 * nv + 13 * nf + 8 * ne);
      expect(ply.trailingBytes).toBe(0);
    });

    it("round-trips positions, colours, faces and edges bit for bit", () => {
      expect(ply.positions).toEqual(layer.positions);
      expect(ply.colors).toEqual(layer.colors);
      expect(ply.triangles).toEqual(layer.triangles ?? new Uint32Array(0));
      expect(ply.edges).toEqual(layer.edges ?? new Uint32Array(0));
    });
  });

  it("stores little-endian floats and vertex-count bytes at the documented offsets", () => {
    const layer: Layer = {
      name: "one triangle", kind: "mesh", shading: "lit",
      positions: new Float32Array([1, 2, 3, -4, 5.5, 6, 7, 8, -9.25]), colors: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0]),
      triangles: new Uint32Array([0, 2, 1]),
    };
    const buf = writePly(layer);
    const bytes = new Uint8Array(buf);
    const start = new TextDecoder().decode(bytes).indexOf("end_header\n") + 11;
    expect(Array.from(bytes.subarray(start, start + 4))).toEqual([0x00, 0x00, 0x80, 0x3f]); // 1.0f little-endian
    expect(Array.from(bytes.subarray(start + 12, start + 16))).toEqual([10, 20, 30, 255]);
    expect(new DataView(buf).getFloat32(start + 16, true)).toBe(-4);
    const face = start + 3 * 16;
    expect(Array.from(bytes.subarray(face, face + 13))).toEqual([3, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0]);
    expect(buf.byteLength).toBe(face + 13);
  });

  it("writes an empty layer as a header only", () => {
    const ply = readPly(writePly({ name: "nothing", kind: "points", shading: "flat", positions: new Float32Array(0), colors: new Uint8Array(0) }));
    expect(ply.elements).toEqual([{ name: "vertex", count: 0, properties: expect.any(Array) }]);
    expect(ply.trailingBytes).toBe(0);
  });

  it("keeps the header parseable when the layer name contains line breaks", () => {
    const layer = randomLayer("points", 4, 9);
    layer.name = "two\nlines\tand tabs";
    const ply = readPly(writePly(layer));
    expect(ply.comments[0]).toContain("two lines and tabs");
    expect(ply.positions).toEqual(layer.positions);
  });

  it.each(FIXTURES)("round-trips the pial surface of $name", ({ make }) => {
    const ds = make();
    const colors = new Uint8Array(4 * ds.n).fill(200);
    const ply = readPly(writePly({ name: "pial", kind: "mesh", shading: "lit", positions: ds.surfaces[0].positions, colors, triangles: ds.triangles }));
    expect(ply.positions).toEqual(ds.surfaces[0].positions);
    expect(ply.triangles).toEqual(ds.triangles);
    expect(ply.elements.map((e) => e.count)).toEqual([ds.n, ds.triangles.length / 3]);
  });
});

describe("crc32", () => {
  const enc = new TextEncoder();
  it.each([["", 0x00000000], ["a", 0xe8b7be43], ["123456789", 0xcbf43926], ["The quick brown fox jumps over the lazy dog", 0x414fa339]])("crc32(%j) is the standard check value", (text, expected) => {
    expect(crc32(enc.encode(text))).toBe(expected);
  });
  it("matches a bit-by-bit reference (and node:zlib when available) on random data", () => {
    const rnd = lcg(77);
    for (const size of [1, 2, 255, 256, 1000, 65537]) {
      const data = Uint8Array.from({ length: size }, () => Math.floor(rnd() * 256));
      expect(crc32(data)).toBe(referenceCrc32(data));
      if (nodeCrc32) expect(crc32(data)).toBe(nodeCrc32(data));
    }
  });
  it("is an unsigned 32-bit integer", () => {
    const c = crc32(new Uint8Array([255, 255, 255, 255]));
    expect(c).toBe(0xffffffff);
    expect(c).toBeGreaterThan(0);
  });
});

describe("zipStore", () => {
  const enc = new TextEncoder();
  const rnd = lcg(123);
  const files = [
    { name: "scene.json", data: enc.encode('{"hello": "world"}') },
    { name: "surface_pial.ply", data: new Uint8Array(writePly(randomLayer("mesh", 200, 1))) },
    { name: "empty.bin", data: new Uint8Array(0) },
    { name: "sous-dossier/données é.txt", data: enc.encode("accents: é à ü — ok\n") },
    { name: "random.bin", data: Uint8Array.from({ length: 70000 }, () => Math.floor(rnd() * 256)) },
  ];
  const zip = zipStore(files);

  it("has a consistent central directory, local headers and end record", () => {
    const entries = readZip(zip); // throws on any structural inconsistency
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    expect(zip.length).toBe(22 + files.reduce((s, f) => s + 30 + 46 + 2 * enc.encode(f.name).length + f.data.length, 0));
  });

  it("stores every file unchanged with the right CRC-32 and the UTF-8 flag", () => {
    const entries = readZip(zip);
    entries.forEach((e, k) => {
      expect(e.method).toBe(0);
      expect(e.flags & 0x0800).toBe(0x0800);
      expect(e.data).toEqual(files[k].data);
      expect(e.crc).toBe(referenceCrc32(files[k].data));
      if (nodeCrc32) expect(e.crc).toBe(nodeCrc32(files[k].data));
    });
  });

  it("an empty archive is just the end record", () => {
    const empty = zipStore([]);
    expect(empty.length).toBe(22);
    expect(readZip(empty)).toEqual([]);
  });

  it.skipIf(!hasUnzip)("passes `unzip -t` and extracts to identical files", () => {
    const dir = mkdtempSync(join(tmpdir(), "braingl-zip-"));
    try {
      const path = join(dir, "bundle.zip");
      writeFileSync(path, zip);
      const report = execFileSync("unzip", ["-t", path], { encoding: "utf-8" });
      expect(report).toMatch(/No errors detected/);
      const ascii = files.filter((f) => /^[\x20-\x7e]+$/.test(f.name));
      execFileSync("unzip", ["-q", path, ...ascii.map((f) => f.name), "-d", join(dir, "out")]);
      expect(readdirSync(join(dir, "out")).sort()).toEqual(ascii.map((f) => f.name).sort());
      for (const f of ascii) expect(new Uint8Array(readFileSync(join(dir, "out", f.name)))).toEqual(f.data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
