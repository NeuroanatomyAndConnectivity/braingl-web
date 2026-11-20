import { afterEach, describe, it, expect, vi } from "vitest";
import { vec3 } from "gl-matrix";
import { BlenderScene, buildBundleFiles, buildBundleZip, SceneCamera } from "./blenderBundle";
import type { Layer } from "./ply";
import { Camera, CanonicalView } from "../gfx/camera";
import { computeBounds } from "../data/dataset";
import { FIXTURES, icoBrain, lcg } from "../testing/fixtures";
import { readPly, readZip } from "../testing/formats";
import { dot, norm, quatRotate, sub, unit, V3 } from "../testing/reference";

function layer(name: string, kind: Layer["kind"], nv: number, extra: Partial<Layer> = {}): Layer {
  const l: Layer = { name, kind, positions: new Float32Array(3 * nv).map((_, k) => k), colors: new Uint8Array(4 * nv).fill(255), shading: "flat", ...extra };
  if (kind === "mesh" && !l.triangles) l.triangles = new Uint32Array([0, 1, 2]);
  if (kind === "segments" && !l.edges) l.edges = new Uint32Array([0, 1]);
  return l;
}

const sceneOf = (files: { name: string; data: Uint8Array }[]): BlenderScene => JSON.parse(new TextDecoder().decode(files[0].data)) as BlenderScene;

/** Blender stores quaternions as [w, x, y, z]; rotate a vector from camera space to world space. */
const camToWorld = (q: number[], v: V3): V3 => quatRotate([q[1], q[2], q[3], q[0]], v);
const worldToCam = (q: number[], v: V3): V3 => quatRotate([-q[1], -q[2], -q[3], q[0]], v);

function sceneCamera(cam: Camera, aspect: number): SceneCamera {
  return { rotation: cam.rotation, target: cam.target, halfHeight: cam.halfHeight, aspect, distance: cam.sceneRadius * 4 + 100 };
}

describe("buildBundleFiles: scene.json", () => {
  const layers = [
    layer("surface pial", "mesh", 4, { shading: "lit", smooth: true, opacity: 0.25 }),
    layer("glyphs points", "points", 7, { radius: 0.25, truncated: true }),
    layer("connections", "segments", 6, { radius: 0.15 }),
  ];
  const files = buildBundleFiles("My scene — test", layers, [0.1, 0.2, 0.3], null);
  const scene = sceneOf(files);

  it("comes first and follows the documented schema", () => {
    expect(files[0].name).toBe("scene.json");
    expect(Object.keys(scene).sort()).toEqual(["background", "camera", "format", "layers", "title", "units", "version"]);
    expect(scene.format).toBe("braingl-blender-scene");
    expect(scene.version).toBe(1);
    expect(scene.title).toBe("My scene — test");
    expect(scene.units).toBe("mm");
    expect(scene.background).toEqual([0.1, 0.2, 0.3]);
    expect(scene.camera).toBeNull();
    for (const l of scene.layers) {
      expect(Object.keys(l).sort()).toEqual(["file", "kind", "name", "opacity", "radius", "shading", "smooth", "truncated", "vertices"]);
    }
  });

  it("describes every layer and fills in the defaults", () => {
    expect(scene.layers).toEqual([
      { file: "surface_pial.ply", name: "surface pial", kind: "mesh", shading: "lit", smooth: true, opacity: 0.25, radius: 0, vertices: 4, truncated: false },
      { file: "glyphs_points.ply", name: "glyphs points", kind: "points", shading: "flat", smooth: false, opacity: 1, radius: 0.25, vertices: 7, truncated: true },
      { file: "connections.ply", name: "connections", kind: "segments", shading: "flat", smooth: false, opacity: 1, radius: 0.15, vertices: 6, truncated: false },
    ]);
  });

  it("writes one PLY per layer with the announced vertex count", () => {
    expect(files.map((f) => f.name)).toEqual(["scene.json", "surface_pial.ply", "glyphs_points.ply", "connections.ply"]);
    scene.layers.forEach((l, k) => {
      const ply = readPly(files[k + 1].data);
      expect(ply.positions.length / 3).toBe(l.vertices);
      expect(ply.positions).toEqual(layers[k].positions);
      expect(ply.elements.map((e) => e.name)).toEqual(l.kind === "mesh" ? ["vertex", "face"] : l.kind === "segments" ? ["vertex", "edge"] : ["vertex"]);
    });
  });
});

describe("buildBundleFiles: file names", () => {
  it("are unique even when layers share a name", () => {
    const files = buildBundleFiles("t", [layer("glyphs", "points", 1), layer("glyphs", "points", 2), layer("Glyphs!", "points", 3), layer("glyphs 2", "points", 4)], [0, 0, 0], null);
    const names = files.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.slice(1, 4)).toEqual(["glyphs.ply", "glyphs_2.ply", "glyphs_3.ply"]);
    const scene = sceneOf(files);
    expect(scene.layers.map((l) => l.file)).toEqual(names.slice(1));
    expect(scene.layers.map((l) => l.vertices)).toEqual([1, 2, 3, 4]);
  });

  it.each([["Surface  Pial (left)", "surface_pial_left.ply"], ["ünïcödé — ✓", "n_c_d.ply"], ["***", "layer.ply"], ["a/b\\c", "a_b_c.ply"]])("layer %j is written to %s", (name, file) => {
    const files = buildBundleFiles("t", [layer(name, "points", 1)], [0, 0, 0], null);
    expect(files[1].name).toBe(file);
    expect(files[1].name).toMatch(/^[a-z0-9_]+\.ply$/);
    expect(sceneOf(files).layers[0].name).toBe(name);
  });

  it("an empty scene still has a scene.json", () => {
    const files = buildBundleFiles("empty", [], [0, 0, 0], null);
    expect(files.length).toBe(1);
    expect(sceneOf(files).layers).toEqual([]);
  });
});

describe("buildBundleFiles: camera", () => {
  const ds = icoBrain(2);
  const bounds = computeBounds(ds.surfaces[0].positions);
  /** [direction from the scene toward the viewer, screen-up direction] in world (RAS) coordinates */
  const VIEWS: Record<CanonicalView, [V3, V3]> = {
    left: [[-1, 0, 0], [0, 0, 1]],
    right: [[1, 0, 0], [0, 0, 1]],
    anterior: [[0, 1, 0], [0, 0, 1]],
    posterior: [[0, -1, 0], [0, 0, 1]],
    dorsal: [[0, 0, 1], [0, 1, 0]],
    ventral: [[0, 0, -1], [0, 1, 0]],
  };

  describe.each(Object.keys(VIEWS) as CanonicalView[])("%s view", (view) => {
    const cam = new Camera();
    cam.frame(bounds.center, bounds.radius);
    cam.setView(view);
    const sc = sceneCamera(cam, 16 / 9);
    const c = sceneOf(buildBundleFiles("t", [], [0, 0, 0], sc)).camera!;
    const [toward, up] = VIEWS[view];

    it("is an orthographic camera with a unit quaternion", () => {
      expect(c.type).toBe("ORTHO");
      expect(c.rotation_quaternion.length).toBe(4);
      expect(Math.hypot(...c.rotation_quaternion)).toBeCloseTo(1, 6);
      expect(c.aspect).toBeCloseTo(16 / 9, 12);
    });

    it("sits on the viewer's side of the scene, at the camera distance from the target", () => {
      const offset = sub(c.location, bounds.center);
      expect(norm(offset)).toBeCloseTo(sc.distance, 3);
      for (let k = 0; k < 3; k++) expect(offset[k] / sc.distance).toBeCloseTo(toward[k], 5);
    });

    it("looks down its local -Z axis from its location to the target", () => {
      const forward = camToWorld(c.rotation_quaternion, [0, 0, -1]);
      const toTarget = unit(sub(bounds.center, c.location));
      for (let k = 0; k < 3; k++) expect(forward[k]).toBeCloseTo(toTarget[k], 5);
    });

    it("has its local +Y axis along the screen-up direction and +X to the screen right", () => {
      const y = camToWorld(c.rotation_quaternion, [0, 1, 0]);
      for (let k = 0; k < 3; k++) expect(y[k]).toBeCloseTo(up[k], 5);
      const x = camToWorld(c.rotation_quaternion, [1, 0, 0]);
      const right: V3 = [up[1] * toward[2] - up[2] * toward[1], up[2] * toward[0] - up[0] * toward[2], up[0] * toward[1] - up[1] * toward[0]];
      for (let k = 0; k < 3; k++) expect(x[k]).toBeCloseTo(right[k], 5);
    });

    it("shows anatomical directions as a radiologist expects", () => {
      // project a world direction on the screen axes of the exported camera
      const onScreen = (d: V3) => worldToCam(c.rotation_quaternion, d);
      if (view === "left") expect(onScreen([0, 1, 0])[0]).toBeCloseTo(-1, 5); // left lateral view: anterior points to the screen left
      if (view === "right") expect(onScreen([0, 1, 0])[0]).toBeCloseTo(1, 5);
      if (view === "dorsal") expect(onScreen([1, 0, 0])[0]).toBeCloseTo(1, 5); // from above: right hemisphere on the right
      if (view === "ventral") expect(onScreen([1, 0, 0])[0]).toBeCloseTo(-1, 5);
      if (view === "anterior") expect(onScreen([1, 0, 0])[0]).toBeCloseTo(-1, 5); // face to face: subject's right on the screen left
      if (view === "posterior") expect(onScreen([1, 0, 0])[0]).toBeCloseTo(1, 5);
    });
  });

  it.each([[16 / 9, 16 / 9], [1, 1], [2.5, 2.5], [0.5, 1], [0.75, 1]])("ortho_scale covers the larger image side (aspect %f -> 2 * halfHeight * %f)", (aspect, factor) => {
    const cam = new Camera();
    cam.frame([0, 0, 0], 80);
    const c = sceneOf(buildBundleFiles("t", [], [0, 0, 0], sceneCamera(cam, aspect))).camera!;
    expect(c.ortho_scale).toBeCloseTo(2 * cam.halfHeight * factor, 9);
    expect(c.aspect).toBe(aspect);
  });

  it("reproduces the on-screen view matrix for arbitrary trackball rotations, pans and zooms", () => {
    const rnd = lcg(2024);
    for (let trial = 0; trial < 25; trial++) {
      const cam = new Camera();
      cam.frame(bounds.center, bounds.radius);
      cam.setView((Object.keys(VIEWS) as CanonicalView[])[trial % 6]);
      cam.rotate((rnd() - 0.5) * 900, (rnd() - 0.5) * 900, 800);
      cam.roll((rnd() - 0.5) * 3);
      cam.pan((rnd() - 0.5) * 200, (rnd() - 0.5) * 200, 800);
      cam.zoom(0.5 + rnd());
      cam.update(1.6);
      const c = sceneOf(buildBundleFiles("t", [], [0, 0, 0], sceneCamera(cam, 1.6))).camera!;
      expect(c.ortho_scale).toBeCloseTo(2 * cam.halfHeight * 1.6, 6);
      for (let p = 0; p < 6; p++) {
        const world: V3 = [(rnd() - 0.5) * 200, (rnd() - 0.5) * 200, (rnd() - 0.5) * 200];
        const view = vec3.transformMat4(vec3.create(), world, cam.view); // what the shaders see
        const blender = worldToCam(c.rotation_quaternion, sub(world, c.location)); // what Blender's camera sees
        for (let k = 0; k < 3; k++) expect(blender[k]).toBeCloseTo(view[k], 2);
      }
      // the target is on the optical axis
      const t = worldToCam(c.rotation_quaternion, sub(Array.from(cam.target), c.location));
      expect(Math.hypot(t[0], t[1])).toBeLessThan(1e-3);
      expect(t[2]).toBeLessThan(0);
      expect(dot(camToWorld(c.rotation_quaternion, [0, 0, -1]), unit(sub(Array.from(cam.target), c.location)))).toBeCloseTo(1, 6);
    }
  });

  it.each(FIXTURES)("frames $name completely", ({ make }) => {
    const d = make();
    const b = computeBounds(d.surfaces[0].positions);
    const cam = new Camera();
    cam.frame(b.center, b.radius);
    cam.setView("dorsal");
    const c = sceneOf(buildBundleFiles("t", [], [0, 0, 0], sceneCamera(cam, 1))).camera!;
    const pos = d.surfaces[0].positions;
    for (let i = 0; i < d.n; i++) {
      const v = worldToCam(c.rotation_quaternion, sub([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], c.location));
      expect(Math.abs(v[0])).toBeLessThanOrEqual(c.ortho_scale / 2);
      expect(Math.abs(v[1])).toBeLessThanOrEqual(c.ortho_scale / 2);
      expect(v[2]).toBeLessThan(0); // in front of the camera
    }
  });
});

describe("buildBundleZip", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const layers = [layer("surface", "mesh", 3), layer("glyphs", "points", 5)];

  it("packs the scene, the layers, the import script and a README into a valid zip", async () => {
    const script = "# import_braingl.py stand-in\nprint('hello')\n";
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url).toBe("blender/import_braingl.py");
      return new Response(script, { status: 200 });
    });
    const blob = await buildBundleZip("Zip scene", layers, [0, 0, 0], null, "blender/import_braingl.py");
    expect(blob.type).toBe("application/zip");
    const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(["scene.json", "surface.ply", "glyphs.ply", "import_braingl.py", "README.txt"]);
    const text = (name: string) => new TextDecoder().decode(entries.find((e) => e.name === name)!.data);
    expect(text("import_braingl.py")).toBe(script);
    expect(text("README.txt")).toContain("Zip scene");
    expect(text("README.txt")).toMatch(/blender --python import_braingl\.py/);
    const scene = JSON.parse(text("scene.json")) as BlenderScene;
    expect(scene.layers.map((l) => l.file)).toEqual(["surface.ply", "glyphs.ply"]);
    expect(readPly(entries[2].data).positions.length).toBe(15);
  });

  it.each([["the script cannot be fetched", async () => { throw new Error("offline"); }], ["the server answers 404", async () => new Response("nope", { status: 404 })]])(
    "still produces the bundle when %s", async (_label, fetchStub) => {
      vi.stubGlobal("fetch", fetchStub);
      const blob = await buildBundleZip("No script", layers, [0, 0, 0], null, "missing.py");
      const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
      expect(entries.map((e) => e.name)).toEqual(["scene.json", "surface.ply", "glyphs.ply", "README.txt"]);
    });
});
