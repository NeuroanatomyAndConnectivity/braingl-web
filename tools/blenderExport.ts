/**
 * Command-line export of brainGL-web scenes for Blender (no browser needed).
 *
 *   npm run export:blender -- --all --out examples/blender
 *   npm run export:blender -- --preset pies --glyphset public/data/nki_fsaverage4 --out /tmp/pies
 *   npm run export:blender -- --preset pies --params '{"threshold":0.6,"hemi":1}' --out /tmp/pies
 *   npm run export:blender -- --directionality public/directionality/label34 --out /tmp/label34
 *
 * Every output folder holds scene.json, one .ply per layer and
 * import_braingl.py, ready for `blender --python import_braingl.py`.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Camera, CanonicalView } from "../src/gfx/camera";
import { computeBounds, GlyphDataset } from "../src/data/dataset";
import { isWebManifest, loadWebGlyphset } from "../src/data/loadWeb";
import { bakeGlyphScene } from "../src/export/bake";
import { buildBundleFiles, SceneCamera } from "../src/export/blenderBundle";
import { bakeDirectionality, defaultArrowParams } from "../src/export/directionalityBake";
import { sceneFromDataset, SceneSpec } from "../src/export/sceneFromDataset";
import { toDirectionality } from "../src/bridge/toDirectionality";
import { colormapLut } from "../src/render/colormaps";
import { hexToRgb } from "../src/ui/panel";
import type { Layer } from "../src/export/ply";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Preset extends SceneSpec {
  about: string;
  view: CanonicalView;
  zoom?: number;
}

/** The example scenes of the documentation. Node ids refer to the bundled fsaverage4 demo. */
export const PRESETS: Record<string, Preset> = {
  points: { about: "Point glyphs, whole brain (r > 0.5, minimum length 20 mm)", view: "left", params: { glyphStyle: "points", threshold: 0.5, minLength: 20 } },
  vectors: { about: "Vector glyphs emphasising long-range connections", view: "left", params: { glyphStyle: "vectors", threshold: 0.4, minLength: 40 }, primRadius: 0.12 },
  pies: { about: "Pie-chart glyphs: red motor belt, red-blue visual cortex", view: "dorsal", params: { glyphStyle: "pies", threshold: 0.4, minLength: 20 } },
  polar: { about: "Polar-projection point glyphs (one disc per hemisphere)", view: "left", params: { glyphStyle: "points", glyphGeometry: -1, threshold: 0.35, minLength: 0, hemi: 1 } },
  diffpoints: { about: "Difference glyphs on every mesh edge", view: "left", params: { glyphStyle: "diffpoints", threshold: 0.25, minLength: 0, hemi: 1 } },
  littlebrains: {
    about: "Anatomical background glyphs on two painted regions, coloured by connectivity", view: "left", seedNode: 1200,
    regions: [{ node: 1200, radius: 14 }, { node: 700, radius: 14 }],
    params: { glyphStyle: "points", glyphNodes: "painted", littleBrains: true, lbMax: 60, glyphRadius: 0.09, glyphColorMode: 1, threshold: 0.35, minLength: 10, surfaceColorMode: "seed" },
  },
  bundles: {
    about: "Mean-shift bundled long-range connections inside a transparent surface", view: "dorsal",
    params: { glyphStyle: "off", threshold: 0.45, minLength: 60, surfaceAlpha: 0.25 }, connections: { max: 4000, bundle: true }, primRadius: 0.35,
  },
};

function fileGetter(dir: string) {
  return async (name: string): Promise<ArrayBuffer> => {
    const b = readFileSync(join(dir, name));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
}

export async function loadGlyphsetFolder(dir: string): Promise<GlyphDataset> {
  const man: unknown = JSON.parse(readFileSync(join(dir, "glyphset.json"), "utf-8"));
  if (!isWebManifest(man)) throw new Error(`${dir}/glyphset.json is not a web glyphset manifest`);
  return loadWebGlyphset(man, fileGetter(dir));
}

function cameraFor(ds: GlyphDataset, surface: number, view: CanonicalView, zoom = 1): SceneCamera {
  const cam = new Camera();
  const b = computeBounds(ds.surfaces[surface].positions);
  cam.frame(b.center, b.radius);
  cam.halfHeight /= zoom;
  cam.setView(view);
  return { rotation: cam.rotation, target: cam.target, halfHeight: cam.halfHeight, aspect: 16 / 9, distance: cam.sceneRadius * 4 + 100 };
}

function writeScene(out: string, title: string, layers: Layer[], background: [number, number, number], camera: SceneCamera | null): void {
  mkdirSync(out, { recursive: true });
  for (const f of buildBundleFiles(title, layers, background, camera)) writeFileSync(join(out, f.name), f.data);
  copyFileSync(join(ROOT, "public", "blender", "import_braingl.py"), join(out, "import_braingl.py"));
  const total = layers.reduce((a, l) => a + l.positions.length / 3, 0);
  console.log(`${out}: ${layers.map((l) => `${l.name} [${(l.positions.length / 3).toLocaleString()}${l.truncated ? ", subsampled" : ""}]`).join(", ")} (${total.toLocaleString()} vertices)`);
}

export function exportGlyphPreset(ds: GlyphDataset, name: string, out: string, override: SceneSpec["params"] = {}): void {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`unknown preset "${name}" (available: ${Object.keys(PRESETS).join(", ")})`);
  const input = sceneFromDataset(ds, { ...preset, params: { ...preset.params, ...override } });
  const layers = bakeGlyphScene(input);
  writeScene(out, `${ds.name} — ${name}`, layers, hexToRgb(input.params.background), cameraFor(ds, input.params.surface, preset.view, preset.zoom));
}

export function exportDirectionality(base: string, out: string): void {
  const layers = bakeDirectionality(readFileSync(base + ".ply", "utf-8"), readFileSync(base + ".labels", "utf-8"), readFileSync(base + ".labelorder", "utf-8"), defaultArrowParams);
  writeScene(out, `Directionality: ${base.split("/").pop()}`, layers, [0.05, 0.05, 0.06], null);
}

/** The bridge, headless: the connectivity map of one seed node as a directionality scene. */
export function exportSeedDirectionality(ds: GlyphDataset, node: number, out: string): void {
  const input = sceneFromDataset(ds, { seedNode: node });
  const d = toDirectionality({
    name: ds.name, positions: ds.surfaces[input.params.surface].positions, triangles: ds.triangles, labels: input.labels, labelColors: [],
    scalars: input.seedRow, scalarName: `connectivity of node ${node}`,
  }, "scalars", colormapLut(input.params.colormap));
  writeScene(out, d.name, bakeDirectionality(d.ply, d.labels, d.order, { ...defaultArrowParams, arrowScale: 0.012 }), [0.05, 0.05, 0.06], null);
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const opt = (k: string): string | undefined => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : undefined; };
  const out = opt("out");
  if (!out || argv.includes("--help")) {
    console.log("usage: export_blender (--all | --preset NAME | --directionality BASE) [--glyphset DIR] [--params JSON] --out DIR\npresets:");
    for (const [k, v] of Object.entries(PRESETS)) console.log(`  ${k.padEnd(13)} ${v.about}`);
    process.exit(out ? 0 : 1);
  }
  const glyphset = resolve(opt("glyphset") ?? join(ROOT, "public", "data", "nki_fsaverage4"));
  const di = opt("directionality");
  if (di) { exportDirectionality(resolve(di), resolve(out)); return; }
  const ds = await loadGlyphsetFolder(glyphset);
  if (argv.includes("--all")) {
    for (const name of Object.keys(PRESETS)) exportGlyphPreset(ds, name, join(resolve(out), name));
    exportDirectionality(join(ROOT, "public", "directionality", "label34"), join(resolve(out), "directionality-label34"));
    exportSeedDirectionality(ds, 1200, join(resolve(out), "directionality-seed-map"));
  } else {
    exportGlyphPreset(ds, opt("preset") ?? "points", resolve(out), opt("params") ? JSON.parse(opt("params")!) : {});
  }
}
