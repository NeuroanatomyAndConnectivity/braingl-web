import { describe, it, expect } from "vitest";
import {
  CURV_HEADER_BYTES,
  hasFreeSurferCurvOrQuadMagic,
  isFreeSurferCurv,
  isFreeSurferSurface,
  parseFreeSurferCurv,
  parseFreeSurferSurface,
} from "./freesurferBinary";

const VERTS = [0, 0, 0, 1.5, 0, 0, 0, -2.25, 0, 0, 0, 0.3];
const FACES = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];

function buildSurface(comment: string, verts = VERTS, faces = FACES, trailer = ""): ArrayBuffer {
  const enc = new TextEncoder();
  const c = enc.encode(comment);
  const t = enc.encode(trailer);
  const buf = new ArrayBuffer(3 + c.length + 8 + verts.length * 4 + faces.length * 4 + t.length);
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  bytes.set([0xff, 0xff, 0xfe], 0);
  bytes.set(c, 3);
  let off = 3 + c.length;
  dv.setInt32(off, verts.length / 3, false);
  dv.setInt32(off + 4, faces.length / 3, false);
  off += 8;
  for (const v of verts) {
    dv.setFloat32(off, v, false);
    off += 4;
  }
  for (const f of faces) {
    dv.setInt32(off, f, false);
    off += 4;
  }
  bytes.set(t, off);
  return buf;
}

function buildCurv(values: number[], valsPerVertex = 1, nVertsOverride?: number): ArrayBuffer {
  const buf = new ArrayBuffer(15 + values.length * 4);
  const dv = new DataView(buf);
  new Uint8Array(buf).set([0xff, 0xff, 0xff], 0);
  dv.setInt32(3, nVertsOverride ?? values.length / valsPerVertex, false);
  dv.setInt32(7, 2 * values.length - 4, false);
  dv.setInt32(11, valsPerVertex, false);
  values.forEach((v, i) => dv.setFloat32(15 + i * 4, v, false));
  return buf;
}

function checkMesh(buf: ArrayBuffer): void {
  const m = parseFreeSurferSurface(buf);
  expect(m.positions).toBeInstanceOf(Float32Array);
  expect(m.triangles).toBeInstanceOf(Uint32Array);
  expect(Array.from(m.positions)).toEqual(Array.from(new Float32Array(VERTS)));
  expect(Array.from(m.triangles)).toEqual(FACES);
}

describe("parseFreeSurferSurface", () => {
  it("parses the classic 'created by ...\\n\\n' header", () => {
    checkMesh(buildSurface("created by fischl on Thu Mar  3 12:00:00 2011\n\n"));
  });

  it("parses a header with two non-empty comment lines", () => {
    checkMesh(buildSurface("created by someone\nsecond comment line\n"));
  });

  it("parses a header with a single comment line", () => {
    checkMesh(buildSurface("created by someone\n"));
  });

  it("ignores the trailer after the faces", () => {
    checkMesh(buildSurface("created by x\n\n", VERTS, FACES, "\0\0\0\x02valid = 1  # volume info valid\nfilename = orig.mgz\n"));
  });

  it("does not need the data to be 4-byte aligned", () => {
    for (const comment of ["a\n\n", "ab\n\n", "abc\n\n", "abcd\n\n"]) checkMesh(buildSurface(comment));
  });

  it("detects the magic number", () => {
    expect(isFreeSurferSurface(buildSurface("c\n\n"))).toBe(true);
    expect(isFreeSurferSurface(buildCurv([1, 2, 3]))).toBe(false);
    expect(isFreeSurferSurface(new ArrayBuffer(2))).toBe(false);
    expect(isFreeSurferSurface(new TextEncoder().encode("#!ascii\n1 0\n").buffer as ArrayBuffer)).toBe(false);
  });

  describe("errors", () => {
    it("rejects other magic numbers", () => {
      expect(() => parseFreeSurferSurface(new ArrayBuffer(64))).toThrow(/magic/);
      expect(() => parseFreeSurferSurface(buildCurv([1, 2, 3]))).toThrow(/not a triangle surface/);
    });

    it("rejects a truncated file", () => {
      const full = buildSurface("created by x\n\n");
      expect(() => parseFreeSurferSurface(full.slice(0, full.byteLength - 5))).toThrow(/4 vertices and 4 faces.*truncated/);
      expect(() => parseFreeSurferSurface(full.slice(0, 18))).toThrow(/truncated/);
      expect(() => parseFreeSurferSurface(full.slice(0, 8))).toThrow(/comment line/);
    });

    it("rejects out-of-range face indices", () => {
      expect(() => parseFreeSurferSurface(buildSurface("c\n\n", VERTS, [0, 1, 4]))).toThrow(/vertex 4/);
      expect(() => parseFreeSurferSurface(buildSurface("c\n\n", VERTS, [0, -1, 2]))).toThrow(/vertex -1/);
    });
  });
});

describe("parseFreeSurferCurv", () => {
  it("parses big-endian float values", () => {
    const vals = [0.25, -1.5, 3, 1e-3, 0];
    const out = parseFreeSurferCurv(buildCurv(vals));
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual(Array.from(new Float32Array(vals)));
  });

  it("detects the magic number and a consistent header", () => {
    expect(isFreeSurferCurv(buildCurv([1, 2, 3]))).toBe(true);
    expect(isFreeSurferCurv(buildSurface("c\n\n"))).toBe(false);
    expect(isFreeSurferCurv(new ArrayBuffer(1))).toBe(false);
    // right magic, but the vertex count cannot fit: not a curv file
    expect(isFreeSurferCurv(buildCurv([1, 2, 3], 1, 1000))).toBe(false);
  });

  it("recognises a file from its first 15 bytes when the file size is given", () => {
    const whole = buildCurv([1, 2, 3, 4, 5]);
    const head = whole.slice(0, CURV_HEADER_BYTES);
    expect(CURV_HEADER_BYTES).toBe(15);
    expect(isFreeSurferCurv(head)).toBe(false); // on its own the header announces more than 15 bytes
    expect(isFreeSurferCurv(head, whole.byteLength)).toBe(true);
    expect(isFreeSurferCurv(head, whole.byteLength + 100)).toBe(true); // a trailer is tolerated
    expect(isFreeSurferCurv(head, whole.byteLength - 1)).toBe(false); // truncated
    expect(isFreeSurferCurv(whole.slice(0, 14), whole.byteLength)).toBe(false); // header incomplete
    expect(isFreeSurferCurv(whole.slice(0, 3), whole.byteLength)).toBe(false); // what the loader used to sniff
    expect(isFreeSurferCurv(buildCurv([1, 2, 3, 4], 2).slice(0, 15), 31)).toBe(true); // two values per vertex still fit
    expect(isFreeSurferCurv(buildCurv([1, 2], 1, -1).slice(0, 15), 1e6)).toBe(false);
  });

  it("tells the curvature / quadrangle magic numbers from everything else", () => {
    expect(hasFreeSurferCurvOrQuadMagic(buildCurv([1, 2, 3]))).toBe(true);
    expect(hasFreeSurferCurvOrQuadMagic(new Uint8Array([0xff, 0xff, 0xfd, 0]).buffer)).toBe(true);
    expect(hasFreeSurferCurvOrQuadMagic(buildSurface("c\n\n"))).toBe(false);
    expect(hasFreeSurferCurvOrQuadMagic(new Float32Array([1, 0.5]).buffer)).toBe(false);
    expect(hasFreeSurferCurvOrQuadMagic(new ArrayBuffer(2))).toBe(false);
  });

  describe("errors", () => {
    it("rejects other magic numbers", () => {
      expect(() => parseFreeSurferCurv(buildSurface("c\n\n"))).toThrow(/magic/);
    });

    it("rejects truncated files", () => {
      expect(() => parseFreeSurferCurv(buildCurv([1, 2, 3]).slice(0, 10))).toThrow(/truncated/);
      expect(() => parseFreeSurferCurv(buildCurv([1, 2, 3], 1, 5))).toThrow(/5 vertices.*only 3/);
    });

    it("rejects more than one value per vertex", () => {
      expect(() => parseFreeSurferCurv(buildCurv([1, 2, 3, 4], 2))).toThrow(/values per vertex/);
    });
  });
});
