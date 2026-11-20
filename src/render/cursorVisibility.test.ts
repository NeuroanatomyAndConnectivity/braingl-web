import { describe, expect, it } from "vitest";
import { computeNormals, hemisphereTriangles } from "../data/dataset";
import { pickNode } from "../glyphs/picking";
import { icoBrain, singleHemisphere } from "../testing/fixtures";
import { cursorVisible, CursorMesh, rayHitsMesh } from "./cursorVisibility";

const brain = icoBrain(2);
const meshOf = (ds: { surfaces: { positions: Float32Array }[]; triangles: Uint32Array; leftNodes: number; leftTriangles: number }, s: number): CursorMesh => ({
  positions: ds.surfaces[s].positions, normals: computeNormals(ds.surfaces[s].positions, ds.triangles), triangles: ds.triangles,
  leftNodes: ds.leftNodes, leftTriangles: ds.leftTriangles,
});
const inflated = meshOf(brain, 1);
const m = brain.leftNodes;
const xs = (lo: number, hi: number) => Array.from({ length: hi - lo }, (_, i) => [lo + i, inflated.positions[3 * (lo + i)]] as const);
const argmin = (a: readonly (readonly [number, number])[]) => a.reduce((b, c) => (c[1] < b[1] ? c : b))[0];
const argmax = (a: readonly (readonly [number, number])[]) => a.reduce((b, c) => (c[1] > b[1] ? c : b))[0];
const leftLateral = argmin(xs(0, m)), leftMedial = argmax(xs(0, m));
const rightLateral = argmax(xs(m, 2 * m)), rightMedial = argmin(xs(m, 2 * m));
const LEFT_VIEW = [-1, 0, 0], RIGHT_VIEW = [1, 0, 0];

describe("cursorVisible", () => {
  it("shows a lateral node and hides a medial node of the same hemisphere in a lateral view", () => {
    expect(cursorVisible(inflated, leftLateral, 0, LEFT_VIEW, true)).toBe(true);
    expect(cursorVisible(inflated, leftMedial, 0, LEFT_VIEW, true)).toBe(false);
    expect(cursorVisible(inflated, rightLateral, 0, RIGHT_VIEW, true)).toBe(true);
    expect(cursorVisible(inflated, rightMedial, 0, RIGHT_VIEW, true)).toBe(false);
  });

  it("hides a node that faces the viewer but lies behind the other hemisphere", () => {
    // the medial wall of the right hemisphere faces left, behind the left hemisphere
    expect(cursorVisible(inflated, rightMedial, 0, LEFT_VIEW, true)).toBe(false);
    // ... and is seen once the left hemisphere is switched off
    expect(cursorVisible(inflated, rightMedial, 2, LEFT_VIEW, true)).toBe(true);
    expect(cursorVisible(inflated, leftMedial, 1, RIGHT_VIEW, true)).toBe(true);
  });

  it("never shows a node of a hemisphere that is switched off", () => {
    expect(cursorVisible(inflated, leftLateral, 2, LEFT_VIEW, true)).toBe(false);
    expect(cursorVisible(inflated, leftLateral, 2, LEFT_VIEW, false)).toBe(false);
    expect(cursorVisible(inflated, rightLateral, 1, RIGHT_VIEW, false)).toBe(false);
  });

  it("shows every node of the shown hemispheres through a transparent or hidden surface", () => {
    for (const node of [leftLateral, leftMedial, rightLateral, rightMedial]) {
      for (const view of [LEFT_VIEW, RIGHT_VIEW]) expect(cursorVisible(inflated, node, 0, view, false)).toBe(true);
    }
  });

  it("rejects nodes outside the mesh", () => {
    expect(cursorVisible(inflated, -1, 0, LEFT_VIEW, true)).toBe(false);
    expect(cursorVisible(inflated, brain.n, 0, LEFT_VIEW, false)).toBe(false);
  });

  it("works without a hemisphere split", () => {
    const one = singleHemisphere(2);
    const mesh = meshOf(one, 0);
    const pts = Array.from({ length: one.n }, (_, i) => [i, mesh.positions[3 * i]] as const);
    expect(cursorVisible(mesh, argmin(pts), 0, LEFT_VIEW, true)).toBe(true);
    expect(cursorVisible(mesh, argmax(pts), 0, LEFT_VIEW, true)).toBe(false);
    expect(cursorVisible(mesh, argmax(pts), 1, RIGHT_VIEW, true)).toBe(true); // hemi is ignored without a split
  });

  it("never shows a node that picking from the viewer cannot reach, and hides reachable ones only at the silhouette", () => {
    // reference: cast a ray from far in front of the node back toward it; the node is reachable when
    // the first surface hit is (within 0.5 mm of) the node itself
    const views = [[-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [-0.6, 0.48, 0.64]];
    for (const s of [0, 1]) {
      const mesh = meshOf(brain, s);
      const p = mesh.positions, nrm = mesh.normals;
      for (const hemi of [0, 1, 2] as const) {
        const [first, count] = hemisphereTriangles(mesh, hemi);
        let shown = 0, silhouette = 0, total = 0;
        for (const v of views) {
          for (let node = 0; node < brain.n; node++) {
            if ((hemi === 1 && node >= m) || (hemi === 2 && node < m)) continue;
            const far = 1000;
            const origin = [p[3 * node] + far * v[0], p[3 * node + 1] + far * v[1], p[3 * node + 2] + far * v[2]];
            const hit = pickNode(p, mesh.triangles, first, count, origin, [-v[0], -v[1], -v[2]]);
            // (no hit at all happens when the ray passes exactly through the vertex between its triangles)
            const reachable = !hit || hit.distance > far - 0.5;
            const got = cursorVisible(mesh, node, hemi, v, true);
            total++;
            if (got) {
              shown++;
              expect(reachable, `surface ${s}, hemi ${hemi}, node ${node} is shown but hidden from the viewer`).toBe(true);
            } else if (reachable) {
              // grazing view: the vertex normal already points away although the ray still touches the
              // neighbourhood of the node (within the 0.5 mm the reference allows)
              const facing = nrm[3 * node] * v[0] + nrm[3 * node + 1] * v[1] + nrm[3 * node + 2] * v[2];
              expect(facing, `surface ${s}, hemi ${hemi}, node ${node}`).toBeLessThan(0);
              silhouette++;
            }
          }
        }
        expect(silhouette / total, `surface ${s}, hemi ${hemi}`).toBeLessThan(0.1);
        expect(shown / total).toBeGreaterThan(0.25);
      }
    }
  });
});

describe("rayHitsMesh", () => {
  // one triangle in the plane z = 5
  const pos = new Float32Array([0, 0, 0, -1, -1, 5, 3, -1, 5, -1, 3, 5]);
  const tri = new Uint32Array([1, 2, 3]);

  it("finds a triangle in front of the origin and ignores one behind it or closer than tMin", () => {
    expect(rayHitsMesh(pos, tri, 0, 3, [0, 0, 0], [0, 0, 1], -1, 1e-4)).toBe(true);
    expect(rayHitsMesh(pos, tri, 0, 3, [0, 0, 0], [0, 0, -1], -1, 1e-4)).toBe(false);
    expect(rayHitsMesh(pos, tri, 0, 3, [0, 0, 0], [0, 0, 1], -1, 6)).toBe(false);
    expect(rayHitsMesh(pos, tri, 0, 3, [5, 5, 0], [0, 0, 1], -1, 1e-4)).toBe(false);
  });

  it("skips triangles that contain the given node and respects the index range", () => {
    expect(rayHitsMesh(pos, tri, 0, 3, [0, 0, 0], [0, 0, 1], 2, 1e-4)).toBe(false);
    expect(rayHitsMesh(pos, tri, 0, 0, [0, 0, 0], [0, 0, 1], -1, 1e-4)).toBe(false);
  });
});
