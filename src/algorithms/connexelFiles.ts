/**
 * Text and binary I/O for connexels (straight edges with a value) and bundled polylines.
 */
import type { Polylines } from "./meanShiftBundling";

/** Shortest decimal string that reads back as exactly the same float32. */
function formatFloat32(x: number): string {
  const f = Math.fround(x);
  if (!Number.isFinite(f)) return String(f);
  for (let precision = 6; precision < 9; precision++) {
    const s = String(Number(f.toPrecision(precision)));
    if (Math.fround(Number(s)) === f) return s;
  }
  return String(Number(f.toPrecision(9)));
}

/**
 * brainGL's weighted connexel text format (".cxls", Writer::saveConnexels in
 * src/io/writer.cpp): one line `x1 y1 z1 x2 y2 z2 value` per connexel, separated by single
 * spaces. brainGL prints 6 significant digits; here as many digits as are needed (6 to 9)
 * for the float32 values to survive a round trip unchanged.
 */
export function writeCxls(edges: Float32Array, values: Float32Array): string {
  if (edges.length % 6 !== 0) {
    throw new RangeError("writeCxls: edges must hold 6 numbers per connexel");
  }
  const n = edges.length / 6;
  if (values.length !== n) {
    throw new RangeError(`writeCxls: expected ${n} values, got ${values.length}`);
  }
  const lines = new Array<string>(n);
  const fields = new Array<string>(7);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 6; k++) fields[k] = formatFloat32(edges[i * 6 + k]);
    fields[6] = formatFloat32(values[i]);
    lines[i] = fields.join(" ");
  }
  return n > 0 ? lines.join("\n") + "\n" : "";
}

/**
 * Parse connexel text: `x1 y1 z1 x2 y2 z2 [value]` per line, separated by spaces or tabs.
 * A line with 6 numbers gets the value 1. Blank lines, CRLF line ends and `#` comment lines
 * are tolerated; any other line that does not consist of 6 or 7 numbers is skipped (brainGL's
 * Connections::loadConnexels likewise ignores lines that do not have exactly 7 fields).
 */
export function parseCxls(text: string): { edges: Float32Array; values: Float32Array } {
  const edges: number[] = [];
  const values: number[] = [];
  const row = [0, 0, 0, 0, 0, 0, 1];
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 6 && fields.length !== 7) continue;
    row[6] = 1;
    let ok = true;
    for (let k = 0; k < fields.length; k++) {
      const v = Number(fields[k]);
      if (Number.isNaN(v)) {
        ok = false;
        break;
      }
      row[k] = v;
    }
    if (!ok) continue;
    edges.push(row[0], row[1], row[2], row[3], row[4], row[5]);
    values.push(row[6]);
  }
  return { edges: new Float32Array(edges), values: new Float32Array(values) };
}

/**
 * Legacy VTK binary POLYDATA (".fib"), readable by brainGL, TrackVis-style tools, ParaView
 * and the stand-alone bundler.
 *
 * Layout (every header line ends with "\n", every binary block is followed by "\n",
 * all binary data big-endian):
 *
 *   # vtk DataFile Version 3.0
 *   brainGL bundled connexels
 *   BINARY
 *   DATASET POLYDATA
 *   POINTS <nPoints> float              float32 xyz
 *   LINES <nLines> <nLines + nIndices>  int32: count, then that many point indices, per line
 *   CELL_DATA <nLines>
 *   FIELD FieldData 1
 *   CellColors 3 <nLines> unsigned_char rgb per line, white
 *   POINT_DATA <nPoints>
 *   FIELD FieldData 1
 *   connectivity 1 <nPoints> float      the value of the line each point belongs to
 *
 * Up to and including LINES this is byte-compatible with Connections::writeBinaryVTK of the
 * bundler (which stops there). The two data arrays are those brainGL writes when it saves a
 * bundled dataset through vtkPolyDataWriter (WriterVTK::saveFibs, src/io/writervtk.cpp): the
 * per-line "CellColors" and one per-point float array per data field, which for bundles is
 * the single field "connectivity" (Connections::createDatasetFibers).
 */
export function writeFibVtk(lines: Polylines): ArrayBuffer {
  const { points, offsets, values } = lines;
  if (offsets.length < 1) throw new RangeError("writeFibVtk: offsets must not be empty");
  if (points.length % 3 !== 0) throw new RangeError("writeFibVtk: points must hold xyz triples");
  const nLines = offsets.length - 1;
  const nPoints = points.length / 3;
  let nIndices = 0;
  for (let k = 0; k < nLines; k++) {
    if (offsets[k + 1] < offsets[k] || offsets[k + 1] > nPoints) {
      throw new RangeError(`writeFibVtk: line ${k} is out of range`);
    }
    nIndices += offsets[k + 1] - offsets[k];
  }
  if (values.length < nLines) throw new RangeError("writeFibVtk: one value per line is required");

  const header =
    "# vtk DataFile Version 3.0\n" +
    "brainGL bundled connexels\n" +
    "BINARY\n" +
    "DATASET POLYDATA\n" +
    `POINTS ${nPoints} float\n`;
  const linesHeader = `\nLINES ${nLines} ${nLines + nIndices}\n`;
  const cellHeader =
    `\nCELL_DATA ${nLines}\n` + "FIELD FieldData 1\n" + `CellColors 3 ${nLines} unsigned_char\n`;
  const pointHeader =
    `\nPOINT_DATA ${nPoints}\n` + "FIELD FieldData 1\n" + `connectivity 1 ${nPoints} float\n`;

  const size =
    header.length +
    nPoints * 12 +
    linesHeader.length +
    (nLines + nIndices) * 4 +
    cellHeader.length +
    nLines * 3 +
    pointHeader.length +
    nPoints * 4 +
    1;
  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let pos = 0;
  const ascii = (s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[pos++] = s.charCodeAt(i);
  };

  ascii(header);
  for (let i = 0; i < points.length; i++, pos += 4) view.setFloat32(pos, points[i], false);

  ascii(linesHeader);
  for (let k = 0; k < nLines; k++) {
    view.setInt32(pos, offsets[k + 1] - offsets[k], false);
    pos += 4;
    for (let p = offsets[k]; p < offsets[k + 1]; p++, pos += 4) view.setInt32(pos, p, false);
  }

  ascii(cellHeader);
  bytes.fill(255, pos, pos + nLines * 3);
  pos += nLines * 3;

  ascii(pointHeader);
  const pointValues = new Float32Array(nPoints);
  for (let k = 0; k < nLines; k++) pointValues.fill(values[k], offsets[k], offsets[k + 1]);
  for (let i = 0; i < nPoints; i++, pos += 4) view.setFloat32(pos, pointValues[i], false);
  ascii("\n");

  return buffer;
}
