import { quat, vec3 } from "gl-matrix";
import { Camera } from "../gfx/camera";
import type { Layer } from "./ply";
import { writePly, zipStore } from "./ply";

/** Orthographic camera in the conventions of brainGL-web's glyph view (world -> view quaternion). */
export interface SceneCamera {
  rotation: ArrayLike<number>; // [x, y, z, w]
  target: ArrayLike<number>;
  halfHeight: number;
  aspect: number;
  distance: number;
}

export interface BlenderScene {
  format: "braingl-blender-scene";
  version: 1;
  title: string;
  units: "mm";
  background: [number, number, number];
  camera: { type: "ORTHO"; location: number[]; rotation_quaternion: number[]; ortho_scale: number; aspect: number } | null;
  layers: { file: string; name: string; kind: Layer["kind"]; shading: Layer["shading"]; smooth: boolean; opacity: number; radius: number; vertices: number; truncated: boolean }[];
}

/**
 * Axis-aligned bounding box of all layers; point and tube layers are grown by their radius
 * (the spheres and tubes reach beyond their vertices). Null when there is no finite vertex.
 */
export function layerBounds(layers: Layer[]): { min: [number, number, number]; max: [number, number, number] } | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const l of layers) {
    const r = l.kind === "mesh" ? 0 : l.radius ?? 0;
    for (let i = 0; i < l.positions.length; i++) {
      const v = l.positions[i], k = i % 3;
      if (!Number.isFinite(v)) continue;
      if (v - r < min[k]) min[k] = v - r;
      if (v + r > max[k]) max[k] = v + r;
    }
  }
  return min.every(Number.isFinite) && max.every(Number.isFinite) ? { min, max } : null;
}

/**
 * Camera for scenes that have no on-screen view to copy (the Directionality
 * export): a left-lateral orthographic view (viewer at -x looking toward +x,
 * +z up, as `Camera.setView("left")`) that frames the bounding box of all
 * layers for the given image aspect (width / height) with a small margin.
 */
export function defaultSceneCamera(layers: Layer[], aspect: number, margin = 1.06): SceneCamera {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const b = layerBounds(layers) ?? { min: [-100, -100, -100], max: [100, 100, 100] };
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  // seen from the left the image shows y (anterior-posterior) horizontally and z vertically
  const halfHeight = Math.max(margin * Math.max(size[2] / 2, size[1] / (2 * a)), 1e-3);
  const cam = new Camera();
  cam.setView("left");
  return {
    rotation: [cam.rotation[0], cam.rotation[1], cam.rotation[2], cam.rotation[3]],
    target: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
    halfHeight, aspect: a,
    // well outside the scene, with the same rule as the glyph view (4 x scene radius + 100 mm)
    distance: 2 * Math.hypot(size[0], size[1], size[2]) + 100,
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "layer";

/** scene.json plus one PLY per layer. */
export function buildBundleFiles(title: string, layers: Layer[], background: [number, number, number], camera: SceneCamera | null): { name: string; data: Uint8Array }[] {
  const scene: BlenderScene = { format: "braingl-blender-scene", version: 1, title, units: "mm", background, camera: null, layers: [] };
  if (camera) {
    // Blender cameras look down their local -Z with +Y up, exactly like the GL view space,
    // so the camera orientation is the inverse of the world -> view rotation.
    const q = quat.fromValues(camera.rotation[0], camera.rotation[1], camera.rotation[2], camera.rotation[3]);
    const inv = quat.invert(quat.create(), q);
    const loc = vec3.transformQuat(vec3.create(), [0, 0, camera.distance], inv);
    vec3.add(loc, loc, [camera.target[0], camera.target[1], camera.target[2]]);
    scene.camera = {
      type: "ORTHO", location: Array.from(loc), rotation_quaternion: [inv[3], inv[0], inv[1], inv[2]],
      ortho_scale: 2 * camera.halfHeight * Math.max(1, camera.aspect), aspect: camera.aspect,
    };
  }
  const files: { name: string; data: Uint8Array }[] = [];
  const used = new Set<string>();
  for (const l of layers) {
    let file = slug(l.name) + ".ply";
    for (let k = 2; used.has(file); k++) file = `${slug(l.name)}_${k}.ply`;
    used.add(file);
    files.push({ name: file, data: new Uint8Array(writePly(l)) });
    scene.layers.push({ file, name: l.name, kind: l.kind, shading: l.shading, smooth: !!l.smooth, opacity: l.opacity ?? 1, radius: l.radius ?? 0, vertices: l.positions.length / 3, truncated: !!l.truncated });
  }
  files.unshift({ name: "scene.json", data: new TextEncoder().encode(JSON.stringify(scene, null, 1)) });
  return files;
}

/** One zip with the scene, its layers and the Blender import script. */
export async function buildBundleZip(title: string, layers: Layer[], background: [number, number, number], camera: SceneCamera | null, scriptUrl: string): Promise<Blob> {
  const files = buildBundleFiles(title, layers, background, camera);
  try {
    const res = await fetch(scriptUrl);
    if (res.ok) files.push({ name: "import_braingl.py", data: new Uint8Array(await res.arrayBuffer()) });
  } catch { /* the script is also in the repository */ }
  files.push({
    name: "README.txt",
    data: new TextEncoder().encode(
      `${title}\n\nExported from brainGL-web for Blender (3.6 or newer).\n\n` +
      "1. Unzip this archive.\n2. In Blender: Scripting workspace > Open > import_braingl.py > Run Script\n" +
      "   (the script loads scene.json and the .ply layers next to it).\n" +
      "   Or from a terminal:  blender --python import_braingl.py\n" +
      "   Render without the interface:\n" +
      "     blender --background --python import_braingl.py -- . --render picture.png [--engine cycles]\n" +
      "3. Render with F12. Units are millimetres.\n\nSee docs/tutorials/blender.md in the brainGL-web repository.\n"),
  });
  return new Blob([zipStore(files)], { type: "application/zip" });
}
