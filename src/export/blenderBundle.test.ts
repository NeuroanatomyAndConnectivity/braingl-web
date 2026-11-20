import { afterEach, describe, it, expect, vi } from "vitest";
import { vec3 } from "gl-matrix";
import { BlenderScene, buildBundleFiles, buildBundleZip, defaultSceneCamera, layerBounds, SceneCamera } from "./blenderBundle";
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

describe("defaultSceneCamera", () => {
  /** A layer whose vertices are the corners of a box. */
  const box = (min: V3, max: V3, extra: Partial<Layer> = {}): Layer => {
    const positions: number[] = [];
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) positions.push(x, y, z);
    return { name: "box", kind: "mesh", positions: Float32Array.from(positions), colors: new Uint8Array(32).fill(255), triangles: new Uint32Array([0, 1, 2]), shading: "lit", ...extra };
  };
  /** What Blender shows of an orthographic camera: half extents of the image in world units. */
  const visible = (c: NonNullable<BlenderScene["camera"]>) => ({ halfWidth: (c.ortho_scale / 2) * Math.min(1, c.aspect), halfHeight: c.ortho_scale / 2 / Math.max(1, c.aspect) });
  const exported = (layers: Layer[], aspect: number) => sceneOf(buildBundleFiles("t", layers, [0, 0, 0], defaultSceneCamera(layers, aspect))).camera!;
  const ASPECTS = [16 / 9, 1, 4 / 3, 0.5, 2.4];
  const BOXES: [string, V3, V3][] = [
    ["a brain (140 x 175 x 130 mm)", [-70, -105, -50], [70, 70, 80]],
    ["long and flat", [-20, -150, 0], [20, 150, 30]],
    ["tall", [10, -15, -100], [50, 15, 140]],
    ["deep (along the view direction)", [-300, -10, -10], [300, 10, 10]],
  ];

  describe.each(BOXES)("%s", (_label, min, max) => {
    const layers = [box(min, [max[0], max[1], (min[2] + max[2]) / 2]), box([min[0], (min[1] + max[1]) / 2, min[2]], max)]; // two layers that only together fill the box
    const corners = Array.from(box(min, max).positions);

    it.each(ASPECTS)("frames the bounding box of all layers at aspect %f", (aspect) => {
      const c = exported(layers, aspect);
      const { halfWidth, halfHeight } = visible(c);
      let fill = 0;
      for (let k = 0; k < 8; k++) {
        const v = worldToCam(c.rotation_quaternion, sub(corners.slice(3 * k, 3 * k + 3), c.location));
        expect(Math.abs(v[0])).toBeLessThanOrEqual(halfWidth);
        expect(Math.abs(v[1])).toBeLessThanOrEqual(halfHeight);
        expect(v[2]).toBeLessThan(-50); // well in front of the camera
        fill = Math.max(fill, Math.abs(v[0]) / halfWidth, Math.abs(v[1]) / halfHeight);
      }
      // a small margin only: the box touches 1 / 1.06 of the image in its tighter direction
      expect(fill).toBeCloseTo(1 / 1.06, 6);
      expect(c.aspect).toBe(aspect);
    });

    it("is a left-lateral orthographic view centred on the box", () => {
      const cam = defaultSceneCamera(layers, 16 / 9);
      const centre: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      for (let k = 0; k < 3; k++) expect(cam.target[k]).toBeCloseTo(centre[k], 4);
      // halfHeight: half the box height, or half its width over the aspect, whichever is larger, plus 6 %
      expect(cam.halfHeight).toBeCloseTo(1.06 * Math.max((max[2] - min[2]) / 2, (max[1] - min[1]) / 2 / (16 / 9)), 4);
      // the same rotation as the "left" view of the glyph workspace
      const left = new Camera();
      left.setView("left");
      for (let k = 0; k < 4; k++) expect(cam.rotation[k]).toBeCloseTo(left.rotation[k], 12);
      const c = sceneOf(buildBundleFiles("t", layers, [0, 0, 0], cam)).camera!;
      expect(c.type).toBe("ORTHO");
      const forward = camToWorld(c.rotation_quaternion, [0, 0, -1]), up = camToWorld(c.rotation_quaternion, [0, 1, 0]), right = camToWorld(c.rotation_quaternion, [1, 0, 0]);
      for (let k = 0; k < 3; k++) {
        expect(forward[k]).toBeCloseTo([1, 0, 0][k], 6); // the viewer is on the left (-x) and looks toward +x
        expect(up[k]).toBeCloseTo([0, 0, 1][k], 6); // superior is up
        expect(right[k]).toBeCloseTo([0, -1, 0][k], 6); // anterior (+y) on the left of the image
      }
      expect(c.location[0]).toBeLessThan(min[0] - 50); // outside the box, on the viewer's side
      expect(c.location[1]).toBeCloseTo(centre[1], 4);
      expect(c.location[2]).toBeCloseTo(centre[2], 4);
    });
  });

  it.each(FIXTURES)("shows every vertex of $name, surface and glyph layers alike, at 16:9 and 1:1", ({ make }) => {
    const d = make();
    const points: Layer = { name: "glyphs", kind: "points", positions: d.surfaces[0].positions.map((v, k) => v * 1.3 + (k % 3 === 2 ? 20 : 0)), colors: new Uint8Array(4 * d.n), shading: "flat", radius: 0.4 };
    const layers: Layer[] = [{ name: "surface", kind: "mesh", positions: d.surfaces[1].positions, colors: new Uint8Array(4 * d.n), triangles: d.triangles, shading: "lit" }, points];
    for (const aspect of [16 / 9, 1]) {
      const c = exported(layers, aspect);
      const { halfWidth, halfHeight } = visible(c);
      for (const l of layers) {
        for (let i = 0; i < d.n; i++) {
          const v = worldToCam(c.rotation_quaternion, sub([l.positions[3 * i], l.positions[3 * i + 1], l.positions[3 * i + 2]], c.location));
          if (Math.abs(v[0]) > halfWidth || Math.abs(v[1]) > halfHeight || v[2] >= 0) throw new Error(`${l.name}, vertex ${i} is outside the view: ${v}`);
        }
      }
    }
  });

  it("grows the box by the radius of point and tube layers, not of meshes", () => {
    const min: V3 = [-10, -20, -30], max: V3 = [10, 20, 30];
    expect(layerBounds([box(min, max, { radius: 5 })])).toEqual({ min, max });
    expect(layerBounds([box(min, max, { kind: "points", radius: 5 })])).toEqual({ min: [-15, -25, -35], max: [15, 25, 35] });
    expect(layerBounds([box(min, max), box([0, 0, 0], [12, 1, 1], { kind: "segments", radius: 2 })])).toEqual({ min: [-10, -20, -30], max: [14, 20, 30] });
    expect(defaultSceneCamera([box(min, max, { kind: "points", radius: 5 })], 1).halfHeight).toBeCloseTo(1.06 * 35, 6);
    expect(defaultSceneCamera([box(min, max)], 1).halfHeight).toBeCloseTo(1.06 * 30, 6);
  });

  it("copes with scenes without vertices, non-finite coordinates and a meaningless aspect", () => {
    expect(layerBounds([])).toBeNull();
    const empty = defaultSceneCamera([], 16 / 9);
    expect(Array.from(empty.target)).toEqual([0, 0, 0]);
    expect(empty.halfHeight).toBeGreaterThan(0);
    expect(Number.isFinite(empty.distance)).toBe(true);
    const l = box([0, 0, 0], [1, 2, 3]);
    l.positions[0] = NaN; l.positions[4] = Infinity;
    expect(layerBounds([l])).toEqual({ min: [0, 0, 0], max: [1, 2, 3] });
    for (const aspect of [0, -2, NaN, Infinity]) {
      const cam = defaultSceneCamera([box([0, 0, 0], [1, 2, 3])], aspect);
      expect(cam.aspect).toBe(1);
      expect(cam.halfHeight).toBeCloseTo(1.06 * 1.5, 6);
    }
    // a single point still gives a usable camera
    const dot1 = defaultSceneCamera([{ name: "p", kind: "mesh", positions: new Float32Array([1, 2, 3]), colors: new Uint8Array(4), shading: "flat" }], 1);
    expect(dot1.halfHeight).toBeGreaterThan(0);
    expect(sceneOf(buildBundleFiles("t", [], [0, 0, 0], dot1)).camera!.ortho_scale).toBeGreaterThan(0);
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
