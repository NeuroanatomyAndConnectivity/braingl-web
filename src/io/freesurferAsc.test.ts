import { describe, it, expect } from "vitest";
import { parseFreeSurferAsc } from "./freesurferAsc";

const TETRA = [
  "#!ascii version of lh.pial",
  "4 4",
  "0.000000  0.000000  0.000000  0",
  "1.500000  0.000000  0.000000  0",
  "0.000000  -2.250000  0.000000  0",
  "0.000000  0.000000  3e-1  0",
  "0 1 2 0",
  "0 3 1 0",
  "0 2 3 0",
  "1 3 2 0",
  "",
].join("\n");

const EXPECT_POS = [0, 0, 0, 1.5, 0, 0, 0, -2.25, 0, 0, 0, 0.3];
const EXPECT_TRI = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];

function check(text: string): void {
  const m = parseFreeSurferAsc(text);
  expect(m.positions).toBeInstanceOf(Float32Array);
  expect(m.triangles).toBeInstanceOf(Uint32Array);
  expect(Array.from(m.positions)).toEqual(Array.from(new Float32Array(EXPECT_POS)));
  expect(Array.from(m.triangles)).toEqual(EXPECT_TRI);
}

describe("parseFreeSurferAsc", () => {
  it("parses mris_convert output", () => check(TETRA));

  it("keeps the triangle winding of the file", () => {
    expect(Array.from(parseFreeSurferAsc(TETRA).triangles.subarray(3, 6))).toEqual([0, 3, 1]);
  });

  it("accepts CRLF line ends", () => check(TETRA.replace(/\n/g, "\r\n")));

  it("accepts a missing comment line", () => check(TETRA.split("\n").slice(1).join("\n")));

  it("accepts a first line that is not marked with #", () =>
    check(TETRA.replace("#!ascii version of lh.pial", "created by someone on some day")));

  it("accepts missing trailing flags", () => check(TETRA.replace(/ {1,2}0$/gm, "")));

  it("accepts tabs, leading blanks, blank lines and no final newline", () => {
    const text = TETRA.trimEnd()
      .split("\n")
      .map((l, i) => (i === 0 ? l : "\t " + l.replace(/ +/g, " \t") + "  "))
      .join("\n\n");
    check("﻿\n\n" + text);
  });

  it("ignores trailing content after the last triangle", () => check(TETRA + "garbage here\n1 2\n"));

  it("parses an empty mesh", () => {
    const m = parseFreeSurferAsc("# empty\n0 0\n");
    expect(m.positions.length).toBe(0);
    expect(m.triangles.length).toBe(0);
  });

  it("parses a larger grid mesh consistently", () => {
    const w = 120;
    const h = 90;
    const lines = ["#!ascii grid", `${w * h} ${(w - 1) * (h - 1) * 2}`];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lines.push(`${x * 0.5}  ${-y * 0.25}  ${(x * y) / 7}  0`);
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const a = y * w + x;
        lines.push(`${a} ${a + 1} ${a + w} 0`, `${a + 1} ${a + w + 1} ${a + w} 0`);
      }
    }
    const m = parseFreeSurferAsc(lines.join("\n") + "\n");
    expect(m.positions.length).toBe(w * h * 3);
    expect(m.triangles.length).toBe((w - 1) * (h - 1) * 6);
    const v = 37 * w + 55;
    expect(m.positions[v * 3]).toBeCloseTo(27.5, 5);
    expect(m.positions[v * 3 + 1]).toBeCloseTo(-9.25, 5);
    expect(m.positions[v * 3 + 2]).toBeCloseTo((55 * 37) / 7, 3);
    expect(Array.from(m.triangles.subarray(m.triangles.length - 3))).toEqual([
      (h - 2) * w + w - 1,
      (h - 1) * w + w - 1,
      (h - 1) * w + w - 2,
    ]);
  });

  describe("errors", () => {
    it("rejects empty input", () => {
      expect(() => parseFreeSurferAsc("")).toThrow(/empty/);
      expect(() => parseFreeSurferAsc("# only a comment\n")).toThrow(/empty|header/);
    });

    it("rejects a missing header", () => {
      expect(() => parseFreeSurferAsc("hello world\nfoo bar\n1 2 3\n")).toThrow(/header/);
    });

    it("rejects a truncated vertex list", () => {
      expect(() => parseFreeSurferAsc("#c\n3 0\n0 0 0 0\n1 0 0 0\n")).toThrow(/too short|end of file/);
      expect(() => parseFreeSurferAsc("#c\n3 1\n0 0 0 0\n1 0 0 0\n0 1 0 0\n")).toThrow(/expected 1 triangles, found 0/);
    });

    it("rejects a vertex line with fewer than three coordinates", () => {
      expect(() => parseFreeSurferAsc("#c\n2 0\n0 0 0 0\n1 0\n")).toThrow(/line 4.*three coordinates/);
    });

    it("rejects non-numeric tokens with the line number", () => {
      expect(() => parseFreeSurferAsc("#c\n2 0\n0 0 0 0\n1 abc 0 0\n")).toThrow(/line 4.*"abc"/);
    });

    it("rejects out-of-range and fractional triangle indices", () => {
      expect(() => parseFreeSurferAsc("#c\n3 1\n0 0 0 0\n1 0 0 0\n0 1 0 0\n0 1 3 0\n")).toThrow(/0\.\.2/);
      expect(() => parseFreeSurferAsc("#c\n3 1\n0 0 0 0\n1 0 0 0\n0 1 0 0\n0 -1 2 0\n")).toThrow(/index/);
      expect(() => parseFreeSurferAsc("#c\n3 1\n0 0 0 0\n1 0 0 0\n0 1 0 0\n0 1.5 2 0\n")).toThrow(/index/);
    });

    it("rejects an absurd header before allocating", () => {
      expect(() => parseFreeSurferAsc("#c\n4000000000 8000000000\n0 0 0 0\n")).toThrow(/too short/);
    });
  });
});
