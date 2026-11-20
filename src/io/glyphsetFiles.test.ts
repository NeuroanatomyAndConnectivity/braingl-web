import { describe, it, expect } from "vitest";
import {
  parseGlyphsetFile,
  MAX_RGB_REGIONS,
  parseRoiFile,
  parseRoiRegions,
  parseSetFile,
  writeRgb,
  writeRoi1D,
  writeRoiLabels,
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

describe("parseRoiRegions", () => {
  const regionsOf = (name: string, text: string, n: number) => {
    const r = parseRoiRegions(name, text, n);
    return { labels: Array.from(r.labels), regions: r.regions };
  };

  it("gives one region per region number of a two-column id list, in ascending order", () => {
    expect(regionsOf("regions.1D.roi", "4 7\n0 2\n1 2\n5 7\n3 3\n", 7)).toEqual({
      labels: [1, 1, 0, 2, 3, 3, 0],
      regions: [{ value: 2, color: null }, { value: 3, color: null }, { value: 7, color: null }],
    });
  });

  it("accepts CRLF, tabs, comments, ids outside the mesh and repeated nodes (last one wins)", () => {
    const text = "# painted regions\r\n0\t1\r\n\r\n2 1\r\n99 4\r\n-1 5\r\n2 2\r\n";
    // 99 and -1 are outside the mesh, so regions 4 and 5 hold no vertex and are dropped
    expect(regionsOf("labels.txt", text, 3)).toEqual({ labels: [1, 0, 2], regions: [{ value: 1, color: null }, { value: 2, color: null }] });
  });

  it("keeps a single region for a one-column id list, a non-integer second column or mixed lines", () => {
    const one = { value: null, color: null };
    expect(regionsOf("nodes.txt", "4\n2\n", 5)).toEqual({ labels: [0, 0, 1, 0, 1], regions: [one] });
    expect(regionsOf("nodes.txt", "0 0.25\n2 0.75\n", 3)).toEqual({ labels: [1, 0, 1], regions: [one] });
    expect(regionsOf("nodes.txt", "0 1\n2\n", 3)).toEqual({ labels: [1, 0, 1], regions: [one] });
    // a file brainGL's exportColors wrote for one colour: one region number throughout
    expect(regionsOf("x.col_255_0_0.1D.roi", "1 3\n2 3\n", 4)).toEqual({ labels: [0, 1, 1, 0], regions: [{ value: 3, color: null }] });
  });

  it("agrees with parseRoiFile on which nodes are inside, for every kind of file", () => {
    const cases: [string, string, number][] = [
      ["roi.1D", "1\n0\n0.5\n0.51\n-3\n2\n", 6],
      ["colors.rgb", "1 1 1\n0.5 1 1\n1 0.99 1\n1 1 0\n1.0 1.0 1.0\n0 0 0\n", 6],
      ["roi.1D.roi", "0 1\n3 2\n5 1\n", 6],
      ["nodes.txt", "4\r\n\r\n2\r\n# c\r\n99\r\n-1\r\n", 5],
    ];
    for (const [name, text, n] of cases) {
      const mask = Array.from(parseRoiFile(name, text, n));
      expect(Array.from(parseRoiRegions(name, text, n).labels, (v) => (v ? 1 : 0))).toEqual(mask);
    }
  });

  it("reads a .1D mask as one region", () => {
    expect(regionsOf("roi.1D", "1\n0\n2\n", 3)).toEqual({ labels: [1, 0, 1], regions: [{ value: null, color: null }] });
  });

  it("gives one region per non-white colour of an .rgb file, in order of first appearance", () => {
    const text = "1 1 1\n0 0 1\n1 0.690196 0\n0 0 1\n1 1 1\n1 0.690196 0\n";
    expect(regionsOf("painted.rgb", text, 6)).toEqual({
      labels: [0, 1, 2, 1, 0, 2],
      regions: [{ value: null, color: "#0000ff" }, { value: null, color: "#ffb000" }],
    });
    // writeRgb output of two painted colours reads back as the same two colours
    const colours = new Float32Array([1, 1, 1, 0.2, 0.4, 0.6, 0.2, 0.4, 0.6, 1, 0, 0]);
    expect(regionsOf("x.rgb", writeRgb(colours), 4).regions.map((r) => r.color)).toEqual(["#336699", "#ff0000"]);
  });

  it("takes an .rgb file with more distinct colours than MAX_RGB_REGIONS for a colour map: one region", () => {
    const n = MAX_RGB_REGIONS + 5;
    const text = Array.from({ length: n }, (_, i) => `${(i % 16) / 15} ${Math.floor(i / 16) / 20} 0`).join("\n");
    const r = parseRoiRegions("map.rgb", text, n);
    expect(r.regions).toEqual([{ value: null, color: null }]);
    expect(Array.from(r.labels).every((v) => v === 1)).toBe(true);
  });

  it("returns no region for an empty file or one that lies entirely outside the mesh", () => {
    for (const name of ["a.1D", "a.rgb", "a.txt"]) expect(regionsOf(name, "", 3)).toEqual({ labels: [0, 0, 0], regions: [] });
    expect(regionsOf("a.txt", "7 1\n8 2\n", 3)).toEqual({ labels: [0, 0, 0], regions: [] });
  });

  it("reads back what writeRoiLabels writes", () => {
    const labels = new Uint8Array([0, 2, 2, 0, 1, 5, 1]);
    const text = writeRoiLabels(labels);
    expect(text).toBe("1 2\n2 2\n4 1\n5 5\n6 1\n");
    // region numbers 1, 2, 5 become regions 1, 2, 3
    expect(regionsOf("regions.1D.roi", text, labels.length)).toEqual({
      labels: [0, 2, 2, 0, 1, 3, 1],
      regions: [{ value: 1, color: null }, { value: 2, color: null }, { value: 5, color: null }],
    });
    expect(writeRoiLabels(new Uint8Array(3))).toBe("");
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
