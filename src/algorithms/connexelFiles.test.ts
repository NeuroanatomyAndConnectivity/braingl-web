import { describe, expect, it } from "vitest";
import { parseCxls, writeCxls, writeFibVtk } from "./connexelFiles";
import { bundleEdges, type Polylines } from "./meanShiftBundling";

describe("cxls", () => {
  it("writes one 'x1 y1 z1 x2 y2 z2 v' line per connexel", () => {
    const text = writeCxls(new Float32Array([1, 2, 3, 4, 5, 6, -1.5, 0, 0.25, 1e-3, 100, 7]), new Float32Array([0.5, 2]));
    expect(text).toBe("1 2 3 4 5 6 0.5\n-1.5 0 0.25 0.001 100 7 2\n");
    expect(writeCxls(new Float32Array(0), new Float32Array(0))).toBe("");
    expect(() => writeCxls(new Float32Array(6), new Float32Array(2))).toThrow(RangeError);
  });

  it("round-trips float32 values exactly", () => {
    const n = 500;
    const edges = new Float32Array(n * 6);
    const values = new Float32Array(n);
    let s = 12345;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < edges.length; i++) edges[i] = (rnd() - 0.5) * 180;
    for (let i = 0; i < n; i++) values[i] = rnd() * 2 - 1;
    edges[0] = 1 / 3;
    edges[1] = 1e-12;
    edges[2] = -123456.789;
    const text = writeCxls(edges, values);
    expect(text.trimEnd().split("\n").length).toBe(n);
    const back = parseCxls(text);
    expect(back.edges).toEqual(edges);
    expect(back.values).toEqual(values);
  });

  it("parses leniently", () => {
    const text = [
      "# a comment",
      "0 0 0 10 0 0 0.5\r",
      "",
      "  1\t2\t3   4 5 6  \r",
      "not a connexel",
      "1 2 3",
      "1 2 3 4 5 x 7",
      "-1e1 2.5 3 4 5 6 -0.25",
    ].join("\n");
    const { edges, values } = parseCxls(text);
    expect(Array.from(edges)).toEqual([0, 0, 0, 10, 0, 0, 1, 2, 3, 4, 5, 6, -10, 2.5, 3, 4, 5, 6]);
    expect(Array.from(values)).toEqual([0.5, 1, -0.25]);
    expect(parseCxls("").edges.length).toBe(0);
  });
});

/** Minimal reader for the legacy VTK layout written by writeFibVtk. */
function readVtk(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let pos = 0;
  const line = (): string => {
    let s = "";
    while (pos < bytes.length && bytes[pos] !== 10) s += String.fromCharCode(bytes[pos++]);
    pos++;
    return s;
  };
  const newline = (): void => {
    expect(bytes[pos]).toBe(10);
    pos++;
  };
  const header = [line(), line(), line(), line()];
  const [pointsKey, nPointsText, pointsType] = line().split(" ");
  const nPoints = Number(nPointsText);
  const points: number[] = [];
  for (let i = 0; i < nPoints * 3; i++, pos += 4) points.push(view.getFloat32(pos, false));
  newline();
  const [linesKey, nLinesText, sizeText] = line().split(" ");
  const nLines = Number(nLinesText);
  const size = Number(sizeText);
  const cells: number[] = [];
  for (let i = 0; i < size; i++, pos += 4) cells.push(view.getInt32(pos, false));
  newline();
  const cellData = [line(), line(), line()];
  const colors = Array.from(bytes.subarray(pos, pos + nLines * 3));
  pos += nLines * 3;
  newline();
  const pointData = [line(), line(), line()];
  const connectivity: number[] = [];
  for (let i = 0; i < nPoints; i++, pos += 4) connectivity.push(view.getFloat32(pos, false));
  newline();
  return {
    header, pointsKey, nPoints, pointsType, points, linesKey, nLines, size, cells,
    cellData, colors, pointData, connectivity, end: pos,
  };
}

describe("writeFibVtk", () => {
  it("writes a legacy binary POLYDATA file", () => {
    const lines: Polylines = {
      points: new Float32Array([0, 0, 0, 1, 2, 3, 4, 5, 6, -1, -2, -3, 0.5, 0.25, 1e10]),
      offsets: new Uint32Array([0, 3, 5]),
      values: new Float32Array([0.75, -2]),
    };
    const buffer = writeFibVtk(lines);
    const vtk = readVtk(buffer);
    expect(vtk.header).toEqual([
      "# vtk DataFile Version 3.0",
      "brainGL bundled connexels",
      "BINARY",
      "DATASET POLYDATA",
    ]);
    expect([vtk.pointsKey, vtk.nPoints, vtk.pointsType]).toEqual(["POINTS", 5, "float"]);
    expect(vtk.points).toEqual(Array.from(lines.points));
    expect([vtk.linesKey, vtk.nLines, vtk.size]).toEqual(["LINES", 2, 7]);
    expect(vtk.cells).toEqual([3, 0, 1, 2, 2, 3, 4]);
    expect(vtk.cellData).toEqual(["CELL_DATA 2", "FIELD FieldData 1", "CellColors 3 2 unsigned_char"]);
    expect(vtk.colors).toEqual([255, 255, 255, 255, 255, 255]);
    expect(vtk.pointData).toEqual(["POINT_DATA 5", "FIELD FieldData 1", "connectivity 1 5 float"]);
    expect(vtk.connectivity).toEqual([0.75, 0.75, 0.75, -2, -2]);
    expect(vtk.end).toBe(buffer.byteLength);

    // Big-endian: the x of the second point (1.0f = 3f 80 00 00) right after the first point.
    const text = new TextDecoder("latin1").decode(buffer);
    const start = text.indexOf("POINTS 5 float\n") + "POINTS 5 float\n".length;
    expect(Array.from(new Uint8Array(buffer, start + 12, 4))).toEqual([0x3f, 0x80, 0, 0]);
  });

  it("has the expected size for bundler output", () => {
    const edges = new Float32Array([0, 0, 0, 50, 0, 0, 0, 2, 0, 50, 2, 0, 0, 0, 30, 0, 40, 30]);
    const out = bundleEdges(edges, new Float32Array([1, 2, 3]));
    const nPoints = out.points.length / 3;
    const buffer = writeFibVtk(out);
    const vtk = readVtk(buffer);
    expect(vtk.nPoints).toBe(nPoints);
    expect(vtk.nLines).toBe(3);
    expect(vtk.size).toBe(3 + nPoints);
    const m = nPoints / 3;
    expect(vtk.cells.slice(0, m + 1)).toEqual([m, ...Array.from({ length: m }, (_, i) => i)]);
    expect(vtk.connectivity[0]).toBe(1);
    expect(vtk.connectivity[nPoints - 1]).toBe(3);
    const text =
      "# vtk DataFile Version 3.0\nbrainGL bundled connexels\nBINARY\nDATASET POLYDATA\n" +
      `POINTS ${nPoints} float\n\nLINES 3 ${3 + nPoints}\n\nCELL_DATA 3\nFIELD FieldData 1\n` +
      `CellColors 3 3 unsigned_char\n\nPOINT_DATA ${nPoints}\nFIELD FieldData 1\n` +
      `connectivity 1 ${nPoints} float\n\n`;
    expect(buffer.byteLength).toBe(text.length + nPoints * 12 + (3 + nPoints) * 4 + 9 + nPoints * 4);
  });

  it("handles no lines and rejects inconsistent offsets", () => {
    const empty = writeFibVtk({ points: new Float32Array(0), offsets: new Uint32Array([0]), values: new Float32Array(0) });
    const vtk = readVtk(empty);
    expect([vtk.nPoints, vtk.nLines, vtk.size]).toEqual([0, 0, 0]);
    expect(() =>
      writeFibVtk({ points: new Float32Array(6), offsets: new Uint32Array([0, 3]), values: new Float32Array(1) }),
    ).toThrow(RangeError);
  });
});
