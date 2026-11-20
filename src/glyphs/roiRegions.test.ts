import { describe, expect, it } from "vitest";
import { parseRoiRegions, writeRoiLabels, type RoiRegions } from "../io/glyphsetFiles";
import { assignRoiRegions, MAX_LABELS, REGION_PALETTE } from "./roiRegions";

const roi = (labels: number[], regions: RoiRegions["regions"]): RoiRegions => ({ labels: Uint32Array.from(labels), regions });
const plain = (k: number) => Array.from({ length: k }, (_, i) => ({ value: i + 1, color: null }));

describe("assignRoiRegions", () => {
  it("gives the first region the paint colour and the others palette colours, in order", () => {
    const r = assignRoiRegions(new Uint8Array(5), [], roi([1, 2, 0, 3, 2], plain(3)), "#ffb000");
    expect(r.labelColors).toEqual(["#ffb000", REGION_PALETTE[0], REGION_PALETTE[1]]);
    expect(Array.from(r.labels)).toEqual([1, 2, 0, 3, 2]);
  });

  it("is deterministic and leaves its inputs unchanged", () => {
    const labels = new Uint8Array([1, 0, 0, 0]);
    const colors = ["#ffb000"];
    const input = roi([0, 1, 2, 0], plain(2));
    const a = assignRoiRegions(labels, colors, input, "#ffb000");
    const b = assignRoiRegions(labels, colors, input, "#ffb000");
    expect(a).toEqual(b);
    expect(Array.from(labels)).toEqual([1, 0, 0, 0]);
    expect(colors).toEqual(["#ffb000"]);
  });

  it("merges the first region with a painted region of the paint colour and skips colours in use", () => {
    // painted already: label 1 = palette[0], label 2 = the paint colour (in another spelling)
    const labels = new Uint8Array([1, 2, 0, 0, 0]);
    const r = assignRoiRegions(labels, [REGION_PALETTE[0].toUpperCase(), "#FFB000"], roi([0, 0, 1, 2, 3], plain(3)), "#ffb000");
    expect(r.labelColors).toEqual([REGION_PALETTE[0].toUpperCase(), "#FFB000", REGION_PALETTE[1], REGION_PALETTE[2]]);
    expect(Array.from(r.labels)).toEqual([1, 2, 2, 3, 4]);
  });

  it("never hands out the paint colour twice, even when it is in the palette", () => {
    const r = assignRoiRegions(new Uint8Array(3), [], roi([1, 2, 3], plain(3)), REGION_PALETTE[0]);
    expect(r.labelColors).toEqual([REGION_PALETTE[0], REGION_PALETTE[1], REGION_PALETTE[2]]);
  });

  it("generates further distinct colours once the palette is used up", () => {
    const k = REGION_PALETTE.length + 8;
    const r = assignRoiRegions(new Uint8Array(k), [], roi(Array.from({ length: k }, (_, i) => i + 1), plain(k)), "#ffb000");
    expect(r.labelColors).toHaveLength(k);
    expect(new Set(r.labelColors.map((c) => c.toLowerCase())).size).toBe(k);
    for (const c of r.labelColors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("paints .rgb regions in their own colour, merging with a painted region of the same colour", () => {
    const r = assignRoiRegions(new Uint8Array([1, 0, 0]), ["#0000FF"], roi([0, 1, 2], [{ value: null, color: "#0000ff" }, { value: null, color: "#ff0000" }]), "#ffb000");
    expect(r.labelColors).toEqual(["#0000FF", "#ff0000"]);
    expect(Array.from(r.labels)).toEqual([1, 1, 2]);
  });

  it("overwrites the labels of the file's nodes only, and adds nothing for an empty file", () => {
    const labels = new Uint8Array([1, 1, 1]);
    const r = assignRoiRegions(labels, ["#123456"], roi([0, 1, 0], plain(1)), "#ffb000");
    expect(Array.from(r.labels)).toEqual([1, 2, 1]);
    const e = assignRoiRegions(labels, ["#123456"], roi([0, 0, 0], []), "#ffb000");
    expect(e.labelColors).toEqual(["#123456"]);
    expect(Array.from(e.labels)).toEqual([1, 1, 1]);
  });

  it("refuses, without changing anything, when more than MAX_LABELS labels would be needed", () => {
    const colors = Array.from({ length: MAX_LABELS - 1 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
    expect(() => assignRoiRegions(new Uint8Array(2), colors, roi([1, 2], plain(2)), "#ffb000")).toThrow(/255 regions/);
    expect(assignRoiRegions(new Uint8Array(2), colors, roi([1, 1], plain(1)), "#ffb000").labelColors).toHaveLength(MAX_LABELS);
  });

  it("restores painted regions saved with writeRoiLabels after clearing (Save labels, Clear, Load ROI)", () => {
    // two painted regions, the second colour erased in between (label 2 has no node left)
    const painted = new Uint8Array([0, 1, 1, 3, 3, 0, 1, 3]);
    const text = writeRoiLabels(painted);
    const r = assignRoiRegions(new Uint8Array(painted.length), [], parseRoiRegions("regions.1D.roi", text, painted.length), "#ffb000");
    expect(r.labelColors).toEqual(["#ffb000", REGION_PALETTE[0]]);
    expect(Array.from(r.labels)).toEqual([0, 1, 1, 2, 2, 0, 1, 2]);
  });
});
