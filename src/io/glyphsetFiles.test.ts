import { describe, it, expect } from "vitest";
import {
  parseGlyphsetFile,
  parseRoiFile,
  parseSetFile,
  writeRgb,
  writeRoi1D,
} from "./glyphsetFiles";

describe("parseGlyphsetFile", () => {
  it("applies the default thresholds and no ROI", () => {
    const g = parseGlyphsetFile("anat.nii.gz\nlh.set\nconn.bin\n");
    expect(g).toEqual({
      nifti: "anat.nii.gz",
      sets: ["lh.set"],
      connectivity: "conn.bin",
      minThreshold: 0.8,
      maxThreshold: 1.0,
      roi: null,
      roi2: null,
    });
  });

  it("parses two sets, thresholds and both ROIs", () => {
    const g = parseGlyphsetFile("anat.nii\nlh.set rh.set\nconn.bin 0.5 0.9 roi.1D roi2.rgb\n");
    expect(g.sets).toEqual(["lh.set", "rh.set"]);
    expect(g.connectivity).toBe("conn.bin");
    expect(g.minThreshold).toBe(0.5);
    expect(g.maxThreshold).toBe(0.9);
    expect(g.roi).toBe("roi.1D");
    expect(g.roi2).toBe("roi2.rgb");
  });

  it("fills in optional fields one at a time", () => {
    expect(parseGlyphsetFile("a\ns.set\nc.bin 0.3")).toMatchObject({ minThreshold: 0.3, maxThreshold: 1.0, roi: null, roi2: null });
    expect(parseGlyphsetFile("a\ns.set\nc.bin 0.3 0.7")).toMatchObject({ minThreshold: 0.3, maxThreshold: 0.7, roi: null });
    expect(parseGlyphsetFile("a\ns.set\nc.bin 0.3 0.7 r.txt")).toMatchObject({ roi: "r.txt", roi2: null });
  });

  it("accepts CRLF, tabs, repeated blanks and a BOM", () => {
    const g = parseGlyphsetFile("﻿anat.nii\r\n  lh.set \t rh.set  \r\nconn.bin   -0.25\t1e-1   roi.1D\r\n");
    expect(g.nifti).toBe("anat.nii");
    expect(g.sets).toEqual(["lh.set", "rh.set"]);
    expect(g.minThreshold).toBe(-0.25);
    expect(g.maxThreshold).toBe(0.1);
    expect(g.roi).toBe("roi.1D");
    expect(g.roi2).toBeNull();
  });

  it("keeps http connectivity URLs and takes lines by position", () => {
    const g = parseGlyphsetFile("\nlh.set\nhttp://example.org/conn.bin 0.6\nignored fourth line\n");
    expect(g.nifti).toBe("");
    expect(g.connectivity).toBe("http://example.org/conn.bin");
    expect(g.minThreshold).toBe(0.6);
  });

  it("uses only the first two sets, like brainGL", () => {
    expect(parseGlyphsetFile("a\nl.set r.set x.set\nc.bin").sets).toEqual(["l.set", "r.set"]);
  });

  it("reads an unparsable threshold as 0, like QString::toFloat", () => {
    expect(parseGlyphsetFile("a\ns.set\nc.bin abc").minThreshold).toBe(0);
  });

  it("rejects files without a set or connectivity line", () => {
    expect(() => parseGlyphsetFile("")).toThrow(/line 2/);
    expect(() => parseGlyphsetFile("anat.nii\n\nconn.bin\n")).toThrow(/line 2/);
    expect(() => parseGlyphsetFile("anat.nii\nlh.set\n")).toThrow(/line 3.*connectivity/);
  });
});

describe("parseSetFile", () => {
  it("parses file names with optional offsets", () => {
    expect(parseSetFile("lh.pial.asc\nlh.inflated.asc -45\nlh.sphere.asc 1 2\nlh.flat.asc 1.5 -2.5 3e1\n")).toEqual([
      { file: "lh.pial.asc", offset: [0, 0, 0] },
      { file: "lh.inflated.asc", offset: [-45, 0, 0] },
      { file: "lh.sphere.asc", offset: [1, 2, 0] },
      { file: "lh.flat.asc", offset: [1.5, -2.5, 30] },
    ]);
  });

  it("skips comments and blank lines, accepts CRLF and tabs", () => {
    expect(parseSetFile("# surfaces\r\n\r\nlh.pial.asc\t10  20\t30\r\n#lh.white.asc\r\n   \r\n  # indented\r\nlh.inflated.asc")).toEqual([
      { file: "lh.pial.asc", offset: [10, 20, 30] },
      { file: "lh.inflated.asc", offset: [0, 0, 0] },
    ]);
  });

  it("returns an empty list for an empty file", () => {
    expect(parseSetFile("")).toEqual([]);
    expect(parseSetFile("\n\n# nothing\n")).toEqual([]);
  });
});

describe("parseRoiFile", () => {
  it("reads .1D values with a 0.5 threshold", () => {
    const m = parseRoiFile("roi.1D", "1\n0\n0.5\n0.51\n-3\n2\n", 6);
    expect(m).toBeInstanceOf(Uint8Array);
    expect(Array.from(m)).toEqual([1, 0, 0, 1, 0, 1]);
  });

  it("reads .1D with CRLF, any whitespace, comments, and ignores surplus values", () => {
    expect(Array.from(parseRoiFile("/some/dir/roi.1D", "# AFNI comment\r\n1 0\t1\r\n\r\n0 1 1 1 1\r\n", 5))).toEqual([1, 0, 1, 0, 1]);
  });

  it("leaves vertices beyond a short .1D file outside the ROI", () => {
    expect(Array.from(parseRoiFile("roi.1D", "1\n1\n", 4))).toEqual([1, 1, 0, 0]);
  });

  it("reads .rgb: anything not white is in the ROI", () => {
    const text = "1 1 1\n0.5 1 1\n1 0.99 1\n1 1 0\n1.0 1.0 1.0\n0 0 0\n";
    expect(Array.from(parseRoiFile("colors.rgb", text, 6))).toEqual([0, 1, 1, 1, 0, 1]);
    expect(Array.from(parseRoiFile("colors.rgb", text.replace(/\n/g, "\r\n"), 6))).toEqual([0, 1, 1, 1, 0, 1]);
    expect(Array.from(parseRoiFile("colors.rgb", "0 0 0\n", 3))).toEqual([1, 0, 0]);
  });

  it("reads a node-id list (first token of each line)", () => {
    expect(Array.from(parseRoiFile("roi.1D.roi", "0 1\n3 1\n5 1\n", 6))).toEqual([1, 0, 0, 1, 0, 1]);
    expect(Array.from(parseRoiFile("nodes.txt", "4\r\n\r\n2\r\n# c\r\n99\r\n-1\r\n", 5))).toEqual([0, 0, 1, 0, 1]);
  });

  it("returns an all-zero mask for an empty file", () => {
    for (const name of ["a.1D", "a.rgb", "a.txt"]) expect(Array.from(parseRoiFile(name, "", 3))).toEqual([0, 0, 0]);
  });
});

describe("writers", () => {
  it("writeRoi1D writes one flag per line and round-trips", () => {
    const mask = new Uint8Array([1, 0, 0, 1, 1]);
    const text = writeRoi1D(mask);
    expect(text).toBe("1\n0\n0\n1\n1\n");
    expect(parseRoiFile("x.1D", text, 5)).toEqual(mask);
    expect(writeRoi1D(new Uint8Array(0))).toBe("");
  });

  it("writeRgb writes r g b per line with six significant digits", () => {
    const text = writeRgb(new Float32Array([1, 1, 1, 0.5, 0.25, 0, 1 / 3, 0.1, 0.9]));
    expect(text).toBe("1 1 1\n0.5 0.25 0\n0.333333 0.1 0.9\n");
    expect(Array.from(parseRoiFile("x.rgb", text, 3))).toEqual([0, 1, 1]);
    expect(writeRgb(new Float32Array(0))).toBe("");
  });

  it("writeRgb rejects arrays that are not 3 per vertex", () => {
    expect(() => writeRgb(new Float32Array(4))).toThrow(/multiple of 3/);
  });
});
