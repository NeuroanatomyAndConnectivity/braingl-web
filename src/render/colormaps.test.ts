import { describe, it, expect } from "vitest";
import { COLORMAP_NAMES, colormapLut, lutToCss } from "./colormaps";

const rgb = (lut: Uint8Array, i: number): number[] => [lut[4 * i], lut[4 * i + 1], lut[4 * i + 2]];
const luma = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe("colormap catalogue", () => {
  it("offers brainGL's defaults and the modern maps", () => {
    for (const name of ["grey", "rainbow", "rainbow 2", "blue white red", "green - red", "cool - warm", "viridis", "magma", "hot", "gradient"]) {
      expect(COLORMAP_NAMES).toContain(name);
    }
    expect(new Set(COLORMAP_NAMES).size).toBe(COLORMAP_NAMES.length);
  });
});

describe.each(COLORMAP_NAMES)("colormap %s", (name) => {
  const lut = colormapLut(name);

  it("is a 256-entry opaque RGBA table", () => {
    expect(lut).toBeInstanceOf(Uint8Array);
    expect(lut.length).toBe(256 * 4);
    for (let i = 0; i < 256; i++) expect(lut[4 * i + 3]).toBe(255);
  });

  it("reversed is the mirror image", () => {
    const rev = colormapLut(name, true);
    // 1 - i / 255 and (255 - i) / 255 can round differently, hence the +-1
    for (let i = 0; i < 256; i++) rgb(rev, i).forEach((v, c) => expect(Math.abs(v - lut[4 * (255 - i) + c])).toBeLessThanOrEqual(1));
    expect(rgb(rev, 0)).toEqual(rgb(lut, 255));
    expect(rgb(rev, 255)).toEqual(rgb(lut, 0));
  });

  it("is continuous (no jump between neighbouring entries)", () => {
    for (let i = 1; i < 256; i++) {
      for (let c = 0; c < 3; c++) expect(Math.abs(lut[4 * i + c] - lut[4 * (i - 1) + c])).toBeLessThanOrEqual(12);
    }
  });

  it("is not constant and has distinct ends", () => {
    expect(rgb(lut, 0)).not.toEqual(rgb(lut, 255));
    expect(new Set(Array.from({ length: 256 }, (_, i) => rgb(lut, i).join(","))).size).toBeGreaterThan(100);
  });

  it("is deterministic and returns a fresh array", () => {
    const again = colormapLut(name);
    expect(again).toEqual(lut);
    expect(again).not.toBe(lut);
  });
});

describe("individual colormaps", () => {
  it("grey is the identity ramp", () => {
    const lut = colormapLut("grey");
    for (let i = 0; i < 256; i++) expect(rgb(lut, i)).toEqual([i, i, i]);
  });

  it("blue white red runs blue -> white -> red, piecewise linear around the middle", () => {
    const lut = colormapLut("blue white red");
    expect(rgb(lut, 0)).toEqual([0, 0, 255]);
    expect(rgb(lut, 255)).toEqual([255, 0, 0]);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const expected = t <= 0.5 ? [255 * 2 * t, 255 * 2 * t, 255] : [255, 255 * (2 - 2 * t), 255 * (2 - 2 * t)];
      expect(rgb(lut, i)).toEqual(expected.map(Math.round));
    }
    expect(Math.min(...rgb(lut, 127), ...rgb(lut, 128))).toBeGreaterThanOrEqual(253);
  });

  it("rainbow passes blue, cyan, green, yellow, red at its quarter points", () => {
    const lut = colormapLut("rainbow");
    expect(rgb(lut, 0)).toEqual([0, 0, 255]);
    expect(rgb(lut, 255)).toEqual([255, 0, 0]);
    const near = (i: number, c: number[]) => rgb(lut, i).forEach((v, k) => expect(Math.abs(v - c[k])).toBeLessThanOrEqual(4));
    near(64, [0, 255, 255]);
    near(128, [0, 255, 0]);
    near(191, [255, 255, 0]);
  });

  it("cool - warm starts blue, is neutral grey in the middle and ends red", () => {
    const lut = colormapLut("cool - warm");
    expect(rgb(lut, 0)).toEqual([Math.round(0.23 * 255), Math.round(0.3 * 255), Math.round(0.75 * 255)]);
    expect(rgb(lut, 255)).toEqual([Math.round(0.71 * 255), Math.round(0.02 * 255), Math.round(0.15 * 255)]);
    const mid = rgb(lut, 128);
    expect(Math.max(...mid) - Math.min(...mid)).toBeLessThanOrEqual(3);
    expect(lut[0]).toBeLessThan(lut[2]); // blue end
    expect(lut[4 * 255]).toBeGreaterThan(lut[4 * 255 + 2]); // red end
  });

  it.each(["grey", "viridis", "magma", "hot"])("%s gets monotonically lighter", (name) => {
    const lut = colormapLut(name);
    for (let i = 8; i < 256; i += 8) expect(luma(rgb(lut, i))).toBeGreaterThan(luma(rgb(lut, i - 8)));
  });

  it("green - red is roughly isoluminant compared with blue white red", () => {
    const spread = (name: string) => {
      const l = Array.from({ length: 256 }, (_, i) => luma(rgb(colormapLut(name), i)));
      return Math.max(...l) - Math.min(...l);
    };
    expect(spread("green - red")).toBeLessThan(0.5 * spread("blue white red"));
  });

  it("an unknown name falls back to grey", () => {
    expect(colormapLut("no such map")).toEqual(colormapLut("grey"));
    expect(colormapLut("no such map", true)).toEqual(colormapLut("grey", true));
  });
});

describe("lutToCss", () => {
  it("builds a left-to-right gradient that samples the table from 0 % to 100 %", () => {
    const lut = colormapLut("viridis");
    const css = lutToCss(lut);
    expect(css.startsWith("linear-gradient(to right, ")).toBe(true);
    expect(css.endsWith(")")).toBe(true);
    const stops = [...css.matchAll(/rgb\((\d+),(\d+),(\d+)\) ([\d.]+)%/g)];
    expect(stops.length).toBe(18);
    expect(stops[0][4]).toBe("0.0");
    expect(stops[stops.length - 1][4]).toBe("100.0");
    let prev = -1;
    for (const s of stops) {
      const pct = Number(s[4]);
      expect(pct).toBeGreaterThan(prev);
      prev = pct;
      const i = Math.round((pct / 100) * 255);
      expect([Number(s[1]), Number(s[2]), Number(s[3])]).toEqual(rgb(lut, i));
    }
  });
});
