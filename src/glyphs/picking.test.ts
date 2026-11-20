import { describe, it, expect } from "vitest";
import { buildTopology } from "../data/dataset";
import { brushNodes, pickNode } from "./picking";

// two triangles forming a unit square in the z = 0 plane, plus a far triangle at z = -5
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, -5, 1, 0, -5, 0, 1, -5]);
const triangles = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6]);

describe("pickNode", () => {
  it("returns the nearest vertex of the first triangle hit", () => {
    const hit = pickNode(positions, triangles, 0, 9, [0.9, 0.1, 10], [0, 0, -1]);
    expect(hit?.node).toBe(1);
    expect(hit?.point[2]).toBeCloseTo(0);
  });
  it("respects the index range (hidden hemisphere)", () => {
    const hit = pickNode(positions, triangles, 6, 3, [0.1, 0.1, 10], [0, 0, -1]);
    expect(hit?.node).toBe(4);
  });
  it("misses outside the mesh", () => {
    expect(pickNode(positions, triangles, 0, 9, [5, 5, 10], [0, 0, -1])).toBeNull();
  });
});

describe("topology and brush", () => {
  const topo = buildTopology(7, triangles);
  it("builds unique edges", () => {
    expect(topo.edges.length / 2).toBe(5 + 3);
  });
  it("grows along the mesh only", () => {
    const nodes = brushNodes(topo, positions, 0, 100).sort();
    expect(nodes).toEqual([0, 1, 2, 3]); // never reaches the disconnected triangle
    expect(brushNodes(topo, positions, 0, 1.1).sort()).toEqual([0, 1, 3]);
  });
});
