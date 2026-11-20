import { describe, it, expect } from "vitest";
import { isNpy, parseNpy } from "./npy";

interface BuildOpts {
  version?: [number, number];
  fortran?: boolean;
  /** total length of preamble + header; numpy pads to a multiple of 64 */
  align?: number;
  /** extra bytes of padding, to force a misaligned data offset */
  extraPad?: number;
  rawHeader?: string;
}

function buildNpy(descr: string, shape: number[], payload: Uint8Array, opts: BuildOpts = {}): ArrayBuffer {
  const [major, minor] = opts.version ?? [1, 0];
  const pre = major === 1 ? 10 : 12;
  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(", ")})`;
  let header =
    opts.rawHeader ?? `{'descr': '${descr}', 'fortran_order': ${opts.fortran ? "True" : "False"}, 'shape': ${shapeStr}, }`;
  const align = opts.align ?? 64;
  const padTo = Math.ceil((pre + header.length + 1) / align) * align + (opts.extraPad ?? 0);
  header = header + " ".repeat(padTo - pre - header.length - 1) + "\n";
  const buf = new ArrayBuffer(pre + header.length + payload.length);
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, major, minor], 0);
  if (major === 1) dv.setUint16(8, header.length, true);
  else dv.setUint32(8, header.length, true);
  bytes.set(new TextEncoder().encode(header), pre);
  bytes.set(payload, pre + header.length);
  return buf;
}

/** Serialise values with a DataView setter. */
function pack(
  values: number[],
  size: number,
  set: (dv: DataView, off: number, v: number) => void,
): Uint8Array {
  const out = new Uint8Array(values.length * size);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => set(dv, i * size, v));
  return out;
}

describe("parseNpy", () => {
  it("parses <f4 as a zero-copy view when aligned", () => {
    const vals = [1.5, -2.25, 3, 4, 5, 6];
    const buf = buildNpy("<f4", [2, 3], pack(vals, 4, (dv, o, v) => dv.setFloat32(o, v, true)));
    const a = parseNpy(buf);
    expect(a.shape).toEqual([2, 3]);
    expect(a.fortranOrder).toBe(false);
    expect(a.dtype).toBe("<f4");
    expect(a.data).toBeInstanceOf(Float32Array);
    expect(Array.from(a.data)).toEqual(vals);
    expect(a.data.buffer).toBe(buf);
  });

  it("parses every supported little-endian dtype", () => {
    const cases: Array<[string, number[], number, (dv: DataView, o: number, v: number) => void, unknown, string]> = [
      ["<f8", [0.1, -1e300, 3], 8, (dv, o, v) => dv.setFloat64(o, v, true), Float64Array, "<f8"],
      ["|i1", [-128, 0, 127], 1, (dv, o, v) => dv.setInt8(o, v), Int8Array, "|i1"],
      ["|u1", [0, 200, 255], 1, (dv, o, v) => dv.setUint8(o, v), Uint8Array, "|u1"],
      ["|b1", [0, 1, 1], 1, (dv, o, v) => dv.setUint8(o, v), Uint8Array, "|u1"],
      ["<i2", [-32768, 5, 32767], 2, (dv, o, v) => dv.setInt16(o, v, true), Int16Array, "<i2"],
      ["<u2", [0, 5, 65535], 2, (dv, o, v) => dv.setUint16(o, v, true), Uint16Array, "<u2"],
      ["<i4", [-2147483648, 7, 2147483647], 4, (dv, o, v) => dv.setInt32(o, v, true), Int32Array, "<i4"],
      ["<u4", [0, 7, 4294967295], 4, (dv, o, v) => dv.setUint32(o, v, true), Uint32Array, "<u4"],
      ["=i4", [1, -2, 3], 4, (dv, o, v) => dv.setInt32(o, v, true), Int32Array, "<i4"],
      ["=f4", [1, -2, 0.5], 4, (dv, o, v) => dv.setFloat32(o, v, true), Float32Array, "<f4"],
    ];
    for (const [descr, vals, size, set, ctor, dtype] of cases) {
      const a = parseNpy(buildNpy(descr, [3], pack(vals, size, set)));
      expect(a.data, descr).toBeInstanceOf(ctor as never);
      expect(Array.from(a.data), descr).toEqual(vals);
      expect(a.dtype, descr).toBe(dtype);
      expect(a.shape, descr).toEqual([3]);
    }
  });

  it("byte-swaps big-endian data without touching the input", () => {
    const f = [1.5, -2.25, 1e10, 4];
    const bufF = buildNpy(">f4", [4], pack(f, 4, (dv, o, v) => dv.setFloat32(o, v, false)));
    const before = new Uint8Array(bufF.slice(0));
    const a = parseNpy(bufF);
    expect(a.dtype).toBe("<f4");
    expect(Array.from(a.data)).toEqual(Array.from(new Float32Array(f)));
    expect(new Uint8Array(bufF)).toEqual(before);

    const d = parseNpy(buildNpy(">f8", [2], pack([Math.PI, -1e-200], 8, (dv, o, v) => dv.setFloat64(o, v, false))));
    expect(Array.from(d.data)).toEqual([Math.PI, -1e-200]);
    const i2 = parseNpy(buildNpy(">i2", [3], pack([-2, 258, 32767], 2, (dv, o, v) => dv.setInt16(o, v, false))));
    expect(Array.from(i2.data)).toEqual([-2, 258, 32767]);
    const u4 = parseNpy(buildNpy(">u4", [2], pack([1, 0xdeadbeef], 4, (dv, o, v) => dv.setUint32(o, v, false))));
    expect(Array.from(u4.data)).toEqual([1, 0xdeadbeef]);
  });

  it("copies when the data offset is not aligned", () => {
    const vals = [0.5, 1.5, 2.5];
    const buf = buildNpy("<f8", [3], pack(vals, 8, (dv, o, v) => dv.setFloat64(o, v, true)), { extraPad: 3 });
    const a = parseNpy(buf);
    expect(Array.from(a.data)).toEqual(vals);
    expect(a.data.buffer).not.toBe(buf);
    expect(a.data.byteOffset).toBe(0);
  });

  it("parses format versions 2.0 and 3.0", () => {
    const payload = pack([1, 2, 3, 4], 4, (dv, o, v) => dv.setInt32(o, v, true));
    for (const version of [
      [2, 0],
      [3, 0],
    ] as Array<[number, number]>) {
      const a = parseNpy(buildNpy("<i4", [4], payload, { version }));
      expect(Array.from(a.data)).toEqual([1, 2, 3, 4]);
    }
  });

  it("reports fortran order and leaves the data in file order", () => {
    const payload = pack([1, 2, 3, 4, 5, 6], 4, (dv, o, v) => dv.setFloat32(o, v, true));
    const a = parseNpy(buildNpy("<f4", [2, 3], payload, { fortran: true }));
    expect(a.fortranOrder).toBe(true);
    expect(a.shape).toEqual([2, 3]);
    expect(Array.from(a.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("parses scalars, empty arrays and extra trailing bytes", () => {
    const one = pack([42, 99], 4, (dv, o, v) => dv.setFloat32(o, v, true));
    const s = parseNpy(buildNpy("<f4", [], one, { rawHeader: "{'descr': '<f4', 'fortran_order': False, 'shape': (), }" }));
    expect(s.shape).toEqual([]);
    expect(Array.from(s.data)).toEqual([42]);
    const e = parseNpy(buildNpy("<f4", [0, 3], new Uint8Array(0)));
    expect(e.shape).toEqual([0, 3]);
    expect(e.data.length).toBe(0);
  });

  it("tolerates double quotes and other key order in the header", () => {
    const payload = pack([7, 8], 2, (dv, o, v) => dv.setUint16(o, v, true));
    const a = parseNpy(
      buildNpy("", [], payload, { rawHeader: `{"shape": (2,), "fortran_order": False, "descr": "<u2"}` }),
    );
    expect(a.dtype).toBe("<u2");
    expect(Array.from(a.data)).toEqual([7, 8]);
  });

  it("detects the magic string", () => {
    expect(isNpy(buildNpy("<f4", [0], new Uint8Array(0)))).toBe(true);
    expect(isNpy(new ArrayBuffer(4))).toBe(false);
    expect(isNpy(new TextEncoder().encode("NUMPY is not it").buffer as ArrayBuffer)).toBe(false);
  });

  describe("errors", () => {
    it("rejects non-npy data", () => {
      expect(() => parseNpy(new ArrayBuffer(100))).toThrow(/magic/);
    });

    it("rejects unknown versions", () => {
      expect(() => parseNpy(buildNpy("<f4", [0], new Uint8Array(0), { version: [9, 0] }))).toThrow(/version 9\.0/);
    });

    it("rejects unsupported dtypes", () => {
      expect(() => parseNpy(buildNpy("<i8", [1], new Uint8Array(8)))).toThrow(/unsupported dtype '<i8'/);
      expect(() => parseNpy(buildNpy("<c8", [1], new Uint8Array(8)))).toThrow(/unsupported dtype/);
      expect(() => parseNpy(buildNpy("<U5", [1], new Uint8Array(20)))).toThrow(/unsupported dtype/);
      expect(() =>
        parseNpy(
          buildNpy("", [], new Uint8Array(8), {
            rawHeader: "{'descr': [('a', '<f4'), ('b', '<i4')], 'fortran_order': False, 'shape': (1,), }",
          }),
        ),
      ).toThrow(/structured/);
    });

    it("rejects truncated data and headers", () => {
      expect(() => parseNpy(buildNpy("<f4", [4, 4], new Uint8Array(60)))).toThrow(/needs 64 data bytes.*only 60/);
      const ok = buildNpy("<f4", [1], new Uint8Array(4));
      expect(() => parseNpy(ok.slice(0, 30))).toThrow(/truncated/);
      expect(() => parseNpy(ok.slice(0, 8))).toThrow(/truncated/);
    });

    it("rejects headers without the required keys", () => {
      expect(() => parseNpy(buildNpy("", [], new Uint8Array(0), { rawHeader: "{'fortran_order': False, 'shape': (1,)}" }))).toThrow(/descr/);
      expect(() => parseNpy(buildNpy("", [], new Uint8Array(0), { rawHeader: "{'descr': '<f4', 'shape': (1,)}" }))).toThrow(/fortran_order/);
      expect(() => parseNpy(buildNpy("", [], new Uint8Array(0), { rawHeader: "{'descr': '<f4', 'fortran_order': False}" }))).toThrow(/shape/);
    });
  });
});
