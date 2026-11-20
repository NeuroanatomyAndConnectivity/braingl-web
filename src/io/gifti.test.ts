import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { deflateSync, gzipSync } from "node:zlib";
import { giftiToMesh, giftiToScalars, parseGifti } from "./gifti";

type Encoding = "ASCII" | "Base64Binary" | "GZipBase64Binary";
type Setter = (dv: DataView, off: number, v: number, little: boolean) => void;

const TYPES: Record<string, { size: number; set: Setter }> = {
  NIFTI_TYPE_UINT8: { size: 1, set: (dv, o, v) => dv.setUint8(o, v) },
  NIFTI_TYPE_INT8: { size: 1, set: (dv, o, v) => dv.setInt8(o, v) },
  NIFTI_TYPE_INT16: { size: 2, set: (dv, o, v, le) => dv.setInt16(o, v, le) },
  NIFTI_TYPE_UINT16: { size: 2, set: (dv, o, v, le) => dv.setUint16(o, v, le) },
  NIFTI_TYPE_INT32: { size: 4, set: (dv, o, v, le) => dv.setInt32(o, v, le) },
  NIFTI_TYPE_UINT32: { size: 4, set: (dv, o, v, le) => dv.setUint32(o, v, le) },
  NIFTI_TYPE_FLOAT32: { size: 4, set: (dv, o, v, le) => dv.setFloat32(o, v, le) },
  NIFTI_TYPE_FLOAT64: { size: 8, set: (dv, o, v, le) => dv.setFloat64(o, v, le) },
};

interface ArraySpec {
  intent: string;
  dataType: string;
  dims: number[];
  /** values in the order they are written to the file */
  values: number[];
  encoding: Encoding;
  endian?: "LittleEndian" | "BigEndian";
  order?: "RowMajorOrder" | "ColumnMajorOrder";
  /** override the text placed inside <Data> */
  rawData?: string;
  /** wrap base64 at this many characters, like some writers do */
  wrap?: number;
  gzipMember?: boolean;
}

function encodeData(a: ArraySpec): string {
  if (a.rawData !== undefined) return a.rawData;
  if (a.encoding === "ASCII") {
    const perLine = a.dims.length > 1 ? a.dims[a.dims.length - 1] : 1;
    const lines: string[] = [];
    for (let i = 0; i < a.values.length; i += perLine) lines.push(a.values.slice(i, i + perLine).join(" "));
    return "\n" + lines.join("\n") + "\n";
  }
  const t = TYPES[a.dataType];
  const raw = new Uint8Array(a.values.length * t.size);
  const dv = new DataView(raw.buffer);
  const little = (a.endian ?? "LittleEndian") === "LittleEndian";
  a.values.forEach((v, i) => t.set(dv, i * t.size, v, little));
  const payload = a.encoding === "GZipBase64Binary" ? (a.gzipMember ? gzipSync(raw) : deflateSync(raw)) : raw;
  let b64 = Buffer.from(payload).toString("base64");
  if (a.wrap) b64 = (b64.match(new RegExp(`.{1,${a.wrap}}`, "g")) ?? []).join("\n");
  return b64;
}

function dataArrayXml(a: ArraySpec, eol: string): string {
  const dimAttrs = a.dims.map((d, i) => `Dim${i}="${d}"`).join(eol + "             ");
  return [
    `   <DataArray Intent="${a.intent}"`,
    `              DataType="${a.dataType}"`,
    `              ArrayIndexingOrder="${a.order ?? "RowMajorOrder"}"`,
    `              Dimensionality="${a.dims.length}"`,
    `              ${dimAttrs}`,
    `              Encoding="${a.encoding}"`,
    `              Endian="${a.endian ?? "LittleEndian"}"`,
    `              ExternalFileName=""`,
    `              ExternalFileOffset="0">`,
    `      <MetaData>`,
    `         <MD><Name><![CDATA[Name]]></Name><Value><![CDATA[a <Data> decoy & more]]></Value></MD>`,
    `      </MetaData>`,
    `      <CoordinateSystemTransformMatrix>`,
    `         <DataSpace><![CDATA[NIFTI_XFORM_UNKNOWN]]></DataSpace>`,
    `         <TransformedSpace><![CDATA[NIFTI_XFORM_UNKNOWN]]></TransformedSpace>`,
    `         <MatrixData>2 0 0 10 0 2 0 20 0 0 2 30 0 0 0 1</MatrixData>`,
    `      </CoordinateSystemTransformMatrix>`,
    `      <Data>${encodeData(a)}</Data>`,
    `   </DataArray>`,
  ].join(eol);
}

function giftiXml(arrays: ArraySpec[], eol = "\n"): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE GIFTI SYSTEM "http://www.nitrc.org/frs/download.php/115/gifti.dtd">`,
    `<GIFTI Version="1.0"  NumberOfDataArrays="${arrays.length}">`,
    `   <MetaData/>`,
    `   <LabelTable/>`,
    ...arrays.map((a) => dataArrayXml(a, eol)),
    `</GIFTI>`,
    ``,
  ].join(eol);
}

const POINTS = [0, 0, 0, 1.5, 0, 0, 0, -2.25, 0, 0, 0, 0.25];
const TRIS = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];

function surface(encoding: Encoding, extra: Partial<ArraySpec> = {}): ArraySpec[] {
  return [
    { intent: "NIFTI_INTENT_POINTSET", dataType: "NIFTI_TYPE_FLOAT32", dims: [4, 3], values: POINTS, encoding, ...extra },
    { intent: "NIFTI_INTENT_TRIANGLE", dataType: "NIFTI_TYPE_INT32", dims: [4, 3], values: TRIS, encoding, ...extra },
  ];
}

describe("parseGifti", () => {
  for (const encoding of ["ASCII", "Base64Binary", "GZipBase64Binary"] as Encoding[]) {
    it(`parses a ${encoding} surface`, async () => {
      const g = await parseGifti(giftiXml(surface(encoding)));
      expect(g.arrays).toHaveLength(2);
      expect(g.arrays[0].intent).toBe("NIFTI_INTENT_POINTSET");
      expect(g.arrays[0].dataType).toBe("NIFTI_TYPE_FLOAT32");
      expect(g.arrays[0].dims).toEqual([4, 3]);
      expect(g.arrays[0].data).toBeInstanceOf(Float32Array);
      expect(Array.from(g.arrays[0].data)).toEqual(POINTS);
      expect(g.arrays[1].intent).toBe("NIFTI_INTENT_TRIANGLE");
      expect(g.arrays[1].data).toBeInstanceOf(Int32Array);
      expect(Array.from(g.arrays[1].data)).toEqual(TRIS);
    });

    it(`parses ${encoding} with CRLF line ends`, async () => {
      const g = await parseGifti(giftiXml(surface(encoding, { wrap: 16 }), "\r\n").replace(/\r?\n/g, "\r\n"));
      expect(Array.from(g.arrays[0].data)).toEqual(POINTS);
      expect(Array.from(g.arrays[1].data)).toEqual(TRIS);
    });
  }

  it("accepts an ArrayBuffer", async () => {
    const bytes = new TextEncoder().encode(giftiXml(surface("GZipBase64Binary")));
    const g = await parseGifti(bytes.buffer as ArrayBuffer);
    expect(Array.from(g.arrays[0].data)).toEqual(POINTS);
  });

  it("parses big-endian binary data", async () => {
    for (const encoding of ["Base64Binary", "GZipBase64Binary"] as Encoding[]) {
      const g = await parseGifti(giftiXml(surface(encoding, { endian: "BigEndian" })));
      expect(Array.from(g.arrays[0].data)).toEqual(POINTS);
      expect(Array.from(g.arrays[1].data)).toEqual(TRIS);
    }
  });

  it("parses every supported data type in every encoding", async () => {
    const cases: Array<[string, number[], unknown]> = [
      ["NIFTI_TYPE_UINT8", [0, 1, 200, 255], Uint8Array],
      ["NIFTI_TYPE_INT8", [-128, -1, 0, 127], Int8Array],
      ["NIFTI_TYPE_INT16", [-32768, -2, 258, 32767], Int16Array],
      ["NIFTI_TYPE_UINT16", [0, 258, 40000, 65535], Uint16Array],
      ["NIFTI_TYPE_INT32", [-2147483648, -3, 65536, 2147483647], Int32Array],
      ["NIFTI_TYPE_UINT32", [0, 65536, 3000000000, 4294967295], Uint32Array],
      ["NIFTI_TYPE_FLOAT32", [0.5, -1.25, 1024, 3.0517578125e-5], Float32Array],
      ["NIFTI_TYPE_FLOAT64", [Math.PI, -1e-200, 1e300, 0.1], Float64Array],
    ];
    for (const [dataType, values, ctor] of cases) {
      for (const encoding of ["ASCII", "Base64Binary", "GZipBase64Binary"] as Encoding[]) {
        for (const endian of ["LittleEndian", "BigEndian"] as const) {
          const label = `${dataType} ${encoding} ${endian}`;
          const g = await parseGifti(
            giftiXml([{ intent: "NIFTI_INTENT_SHAPE", dataType, dims: [4], values, encoding, endian }]),
          );
          expect(g.arrays[0].data, label).toBeInstanceOf(ctor as never);
          expect(Array.from(g.arrays[0].data), label).toEqual(values);
          expect(g.arrays[0].dims, label).toEqual([4]);
        }
      }
    }
  });

  it("converts ColumnMajorOrder to row-major", async () => {
    // logical 4x3 array POINTS, stored column by column
    const colMajor: number[] = [];
    for (let c = 0; c < 3; c++) for (let r = 0; r < 4; r++) colMajor.push(POINTS[r * 3 + c]);
    for (const encoding of ["ASCII", "Base64Binary", "GZipBase64Binary"] as Encoding[]) {
      const g = await parseGifti(
        giftiXml([
          {
            intent: "NIFTI_INTENT_POINTSET",
            dataType: "NIFTI_TYPE_FLOAT32",
            dims: [4, 3],
            values: colMajor,
            encoding,
            order: "ColumnMajorOrder",
          },
        ]),
      );
      expect(g.arrays[0].dims).toEqual([4, 3]);
      expect(Array.from(g.arrays[0].data), encoding).toEqual(POINTS);
    }
  });

  it("converts 3-D ColumnMajorOrder arrays", async () => {
    const dims = [2, 3, 4];
    const rowMajor = Array.from({ length: 24 }, (_, i) => i);
    const colMajor = new Array<number>(24);
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 4; k++) colMajor[i + 2 * (j + 3 * k)] = rowMajor[(i * 3 + j) * 4 + k];
    const g = await parseGifti(
      giftiXml([
        { intent: "NIFTI_INTENT_NONE", dataType: "NIFTI_TYPE_INT16", dims, values: colMajor, encoding: "Base64Binary", order: "ColumnMajorOrder" },
      ]),
    );
    expect(Array.from(g.arrays[0].data)).toEqual(rowMajor);
  });

  it("leaves 1-D and [n, 1] ColumnMajorOrder arrays alone", async () => {
    const g = await parseGifti(
      giftiXml([
        { intent: "NIFTI_INTENT_SHAPE", dataType: "NIFTI_TYPE_FLOAT32", dims: [4], values: [1, 2, 3, 4], encoding: "ASCII", order: "ColumnMajorOrder" },
        { intent: "NIFTI_INTENT_SHAPE", dataType: "NIFTI_TYPE_FLOAT32", dims: [4, 1], values: [5, 6, 7, 8], encoding: "Base64Binary", order: "ColumnMajorOrder" },
      ]),
    );
    expect(Array.from(g.arrays[0].data)).toEqual([1, 2, 3, 4]);
    expect(Array.from(g.arrays[1].data)).toEqual([5, 6, 7, 8]);
  });

  it("tolerates a gzip member where a zlib stream is expected", async () => {
    const g = await parseGifti(giftiXml(surface("GZipBase64Binary", { gzipMember: true })));
    expect(Array.from(g.arrays[0].data)).toEqual(POINTS);
  });

  it("handles a larger compressed array", async () => {
    const n = 50000;
    const values = Array.from({ length: n }, (_, i) => Math.fround(Math.sin(i) * 100));
    const g = await parseGifti(
      giftiXml([{ intent: "NIFTI_INTENT_SHAPE", dataType: "NIFTI_TYPE_FLOAT32", dims: [n], values, encoding: "GZipBase64Binary" }]),
    );
    expect(g.arrays[0].data.length).toBe(n);
    expect(g.arrays[0].data[12345]).toBe(values[12345]);
    expect(g.arrays[0].data[n - 1]).toBe(values[n - 1]);
  });

  it("parses nan and inf in ASCII data, single-quoted attributes and a file without arrays", async () => {
    const xml = giftiXml([
      { intent: "NIFTI_INTENT_SHAPE", dataType: "NIFTI_TYPE_FLOAT32", dims: [4], values: [], encoding: "ASCII", rawData: " 1.5 nan\t-inf\n inf " },
    ]).replace(/="([^"]*)"/g, "='$1'");
    const g = await parseGifti(xml);
    expect(Array.from(g.arrays[0].data)).toEqual([1.5, NaN, -Infinity, Infinity]);
    expect((await parseGifti(giftiXml([]))).arrays).toEqual([]);
  });

  describe("errors", () => {
    it("rejects input that is not GIFTI", async () => {
      await expect(parseGifti("<html><body>nope</body></html>")).rejects.toThrow(/not a GIFTI/);
      await expect(parseGifti(new ArrayBuffer(16))).rejects.toThrow(/not a GIFTI/);
    });

    it("rejects external-file encoding with a clear message", async () => {
      const xml = giftiXml(surface("Base64Binary")).replace(/Encoding="Base64Binary"/g, 'Encoding="ExternalFileBinary"');
      await expect(parseGifti(xml)).rejects.toThrow(/ExternalFileBinary.*not supported/);
    });

    it("rejects unknown data types, encodings and orders", async () => {
      const base: ArraySpec = { intent: "NIFTI_INTENT_SHAPE", dataType: "NIFTI_TYPE_FLOAT32", dims: [2], values: [1, 2], encoding: "ASCII" };
      await expect(parseGifti(giftiXml([{ ...base, dataType: "NIFTI_TYPE_INT64" }]))).rejects.toThrow(/unsupported DataType "NIFTI_TYPE_INT64"/);
      await expect(parseGifti(giftiXml([base]).replace('Encoding="ASCII"', 'Encoding="Morse"'))).rejects.toThrow(/unknown Encoding "Morse"/);
      await expect(parseGifti(giftiXml([base]).replace("RowMajorOrder", "DiagonalOrder"))).rejects.toThrow(/ArrayIndexingOrder/);
      await expect(parseGifti(giftiXml([{ ...base, encoding: "Base64Binary" }]).replace("LittleEndian", "MiddleEndian"))).rejects.toThrow(/Endian/);
    });

    it("rejects data that is shorter than the dimensions", async () => {
      const short = (encoding: Encoding): string =>
        giftiXml([{ intent: "NIFTI_INTENT_SHAPE", dataType: "NIFTI_TYPE_FLOAT32", dims: [5], values: [1, 2, 3], encoding }]);
      await expect(parseGifti(short("ASCII"))).rejects.toThrow(/DataArray 0.*need 5 values.*holds 3/);
      await expect(parseGifti(short("Base64Binary"))).rejects.toThrow(/need 20 bytes.*decodes to 12/);
      await expect(parseGifti(short("GZipBase64Binary"))).rejects.toThrow(/need 20 bytes.*decodes to 12/);
    });

    it("rejects malformed numbers, base64 and compressed streams", async () => {
      const mk = (encoding: Encoding, rawData: string): string =>
        giftiXml([{ intent: "NIFTI_INTENT_SHAPE", dataType: "NIFTI_TYPE_FLOAT32", dims: [2], values: [], encoding, rawData }]);
      await expect(parseGifti(mk("ASCII", "1.0 abc"))).rejects.toThrow(/invalid number "abc"/);
      await expect(parseGifti(mk("Base64Binary", "AAAA*AAA"))).rejects.toThrow(/invalid base64/);
      await expect(parseGifti(mk("GZipBase64Binary", "AAAAAAAAAAAAAAAA"))).rejects.toThrow(/DataArray 0.*decompress/);
    });

    it("rejects missing dimensions and structure", async () => {
      const xml = giftiXml(surface("ASCII"));
      await expect(parseGifti(xml.replace(/Dim1="3"/, ""))).rejects.toThrow(/Dim1/);
      await expect(parseGifti(xml.replace(/<\/DataArray>/g, ""))).rejects.toThrow(/<\/DataArray>/);
      await expect(parseGifti(xml.replace(/<Data>[^<]*<\/Data>/, ""))).rejects.toThrow(/no <Data>/);
    });
  });
});

describe("giftiToMesh", () => {
  it("builds a TriMesh from POINTSET + TRIANGLE without applying the transform", async () => {
    const g = await parseGifti(giftiXml(surface("GZipBase64Binary")));
    const m = giftiToMesh(g);
    expect(m).not.toBeNull();
    expect(m!.positions).toBeInstanceOf(Float32Array);
    expect(m!.triangles).toBeInstanceOf(Uint32Array);
    expect(Array.from(m!.positions)).toEqual(POINTS);
    expect(Array.from(m!.triangles)).toEqual(TRIS);
  });

  it("converts float64 coordinates and finds the arrays in any order", async () => {
    const [p, t] = surface("ASCII");
    const g = await parseGifti(giftiXml([t, { ...p, dataType: "NIFTI_TYPE_FLOAT64" }]));
    const m = giftiToMesh(g)!;
    expect(m.positions).toBeInstanceOf(Float32Array);
    expect(Array.from(m.positions)).toEqual(POINTS);
    expect(Array.from(m.triangles)).toEqual(TRIS);
  });

  it("returns null when geometry is missing", async () => {
    const [p, t] = surface("ASCII");
    expect(giftiToMesh(await parseGifti(giftiXml([p])))).toBeNull();
    expect(giftiToMesh(await parseGifti(giftiXml([t])))).toBeNull();
    expect(giftiToMesh({ arrays: [] })).toBeNull();
  });

  it("rejects geometry that is not n x 3", () => {
    const bad = {
      arrays: [
        { intent: "NIFTI_INTENT_POINTSET", dataType: "NIFTI_TYPE_FLOAT32", dims: [2, 2], data: new Float32Array(4) },
        { intent: "NIFTI_INTENT_TRIANGLE", dataType: "NIFTI_TYPE_INT32", dims: [1, 3], data: new Int32Array(3) },
      ],
    };
    expect(() => giftiToMesh(bad)).toThrow(/POINTSET.*\[2, 2\]/);
  });
});

describe("giftiToScalars", () => {
  it("returns each non-geometry array as Float32Array and splits 2-D arrays into columns", async () => {
    const g = await parseGifti(
      giftiXml([
        ...surface("Base64Binary"),
        { intent: "NIFTI_INTENT_SHAPE", dataType: "NIFTI_TYPE_FLOAT32", dims: [4], values: [0.5, 1.5, 2.5, 3.5], encoding: "Base64Binary" },
        { intent: "NIFTI_INTENT_LABEL", dataType: "NIFTI_TYPE_INT32", dims: [4, 1], values: [3, 1, 4, 1], encoding: "ASCII" },
        // rows = vertices, 3 columns
        { intent: "NIFTI_INTENT_TIME_SERIES", dataType: "NIFTI_TYPE_FLOAT64", dims: [4, 3], values: [1, 10, 100, 2, 20, 200, 3, 30, 300, 4, 40, 400], encoding: "GZipBase64Binary" },
        // the same, stored column-major
        { intent: "NIFTI_INTENT_NONE", dataType: "NIFTI_TYPE_UINT8", dims: [4, 2], values: [1, 2, 3, 4, 11, 12, 13, 14], encoding: "ASCII", order: "ColumnMajorOrder" },
      ]),
    );
    const s = giftiToScalars(g);
    expect(s).toHaveLength(7);
    for (const a of s) {
      expect(a).toBeInstanceOf(Float32Array);
      expect(a.length).toBe(4);
    }
    expect(s.map((a) => Array.from(a))).toEqual([
      [0.5, 1.5, 2.5, 3.5],
      [3, 1, 4, 1],
      [1, 2, 3, 4],
      [10, 20, 30, 40],
      [100, 200, 300, 400],
      [1, 2, 3, 4],
      [11, 12, 13, 14],
    ]);
  });

  it("returns nothing for a pure surface file", async () => {
    expect(giftiToScalars(await parseGifti(giftiXml(surface("ASCII"))))).toEqual([]);
  });
});
