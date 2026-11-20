import { describe, it, expect } from "vitest";
import { toDirectionality } from "./toDirectionality";
import { parsePly } from "../directionality/io/plyReader";
import { parseLabels } from "../directionality/io/labelReader";
import { parseLabelOrder } from "../directionality/io/labelOrderReader";

const lut = new Uint8Array(256 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i >> 2)));
const n = 48;
const positions = new Float32Array(3 * n).map((_, i) => (i % 3 === 0 ? Math.floor(i / 3) : 0));
const triangles = new Uint32Array([0, 1, 2, 2, 3, 4]);

describe("toDirectionality", () => {
  it("exports painted regions as a parcellation the Directionality reader accepts", () => {
    const labels = new Uint8Array(n);
    labels.fill(1, 0, 10);
    labels.fill(2, 10, 30);
    const out = toDirectionality({ name: "s", positions, triangles, labels, labelColors: ["#ff0000", "#0000ff"], scalars: null, scalarName: "" }, "labels", lut);
    const mesh = parsePly(out.ply);
    expect(mesh.vertices.length).toBe(3 * n);
    expect(mesh.indices.length).toBe(6);
    expect(Array.from(mesh.colors!.slice(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(mesh.colors!.slice(3 * 12, 3 * 12 + 3))).toEqual([0, 0, 255]);
    const l = parseLabels(out.labels);
    expect(l.length).toBe(n);
    expect([l[0], l[15], l[40]]).toEqual([1, 2, 0]);
    expect(Array.from(parseLabelOrder(out.order))).toEqual([1, 2]);
  });

  it("needs two regions", () => {
    const labels = new Uint8Array(n).fill(1);
    expect(() => toDirectionality({ name: "s", positions, triangles, labels, labelColors: ["#ff0000"], scalars: null, scalarName: "" }, "labels", lut)).toThrow(/two regions/);
  });

  it("bins a scalar map into ordered quantile regions and ignores zeros", () => {
    const scalars = new Float32Array(n).map((_, i) => (i < 4 ? 0 : i / n));
    const out = toDirectionality({ name: "s", positions, triangles, labels: new Uint8Array(n), labelColors: [], scalars, scalarName: "g1" }, "scalars", lut, 4);
    const l = parseLabels(out.labels);
    expect(l[0]).toBe(0);
    expect(l[4]).toBe(1);
    expect(l[n - 1]).toBe(4);
    for (let i = 5; i < n; i++) expect(l[i]).toBeGreaterThanOrEqual(l[i - 1]);
    expect(Array.from(parseLabelOrder(out.order))).toEqual([1, 2, 3, 4]);
    expect(out.name).toContain("g1");
  });
});
