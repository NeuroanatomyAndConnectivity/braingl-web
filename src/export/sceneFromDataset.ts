import { thresholdForBudget } from "../data/connMatrix";
import { buildTopology, findSphere, GlyphDataset } from "../data/dataset";
import { createConnexels } from "../glyphs/builders";
import { defaultGlyphParams, GlyphParams } from "../glyphs/params";
import { brushNodes } from "../glyphs/picking";
import { bundleEdges, Polylines } from "../algorithms/meanShiftBundling";
import type { GlyphBakeInput } from "./bake";

/** A glyph scene described without any UI: used by the command-line exporter and by tests. */
export interface SceneSpec {
  params?: Partial<GlyphParams>;
  /** paint a region around each of these nodes (one region per entry) */
  regions?: { node: number; radius: number; color?: string }[];
  seedNode?: number;
  /** create connexels from the current thresholds (and optionally bundle them) */
  connections?: { max: number; bundle: boolean };
  primRadius?: number;
  maxPrims?: number;
}

/** Reproduces what the glyph workspace derives from its parameters before drawing. */
export function sceneFromDataset(ds: GlyphDataset, spec: SceneSpec = {}): GlyphBakeInput {
  const p: GlyphParams = { ...defaultGlyphParams, ...spec.params };
  const ns = ds.surfaces.length;
  for (const k of ["surface", "secondSurface", "colorSurface", "lengthSurface"] as const) p[k] = Math.min(Math.max(0, p[k]), ns - 1);
  const sphere = findSphere(ds);
  if (p.glyphGeometry >= ns || (p.glyphGeometry === -1 && !sphere)) p.glyphGeometry = 0;
  p.maxThreshold = Math.min(p.maxThreshold, ds.conn.maxAbs);
  const topo = buildTopology(ds.n, ds.triangles);
  const labels = new Uint8Array(ds.n);
  const labelColors: string[] = [];
  (spec.regions ?? []).forEach((r, k) => {
    labelColors.push(r.color ?? ["#ffb000", "#00a2ff", "#ff4d6d", "#7bd88f"][k % 4]);
    for (const i of brushNodes(topo, ds.surfaces[p.surface].positions, r.node, r.radius)) labels[i] = k + 1;
  });
  const split = ds.leftNodes > 0 && ds.leftNodes < ds.n ? ds.leftNodes : 0;
  const glyphNodes = new Uint8Array(ds.n);
  for (let i = 0; i < ds.n; i++) {
    if (!ds.mask[i]) continue;
    if (split && ((p.hemi === 1 && i >= split) || (p.hemi === 2 && i < split))) continue;
    if (p.glyphNodes === "painted" && !labels[i]) continue;
    glyphNodes[i] = 1;
  }
  const cum = ds.conn.cumulativeHistogram(glyphNodes, p.sign);
  const build = thresholdForBudget(cum, ds.conn.maxAbs, p.budgetM * 1e6);
  const threshold = p.glyphStyle === "diffpoints" ? p.threshold : Math.max(p.threshold, build);
  let seedRow: Float32Array | null = null;
  const cursorNode = spec.seedNode ?? -1;
  if (cursorNode >= 0) {
    seedRow = ds.conn.row(cursorNode, new Float32Array(ds.n));
    seedRow[cursorNode] = ds.conn.maxAbs;
  }
  let lines: Polylines | null = null;
  if (spec.connections) {
    const c = createConnexels(ds.conn, { glyphNodes, targets: null, sign: p.sign, threshold: Math.max(p.threshold, ds.conn.maxAbs * 0.02), maxThreshold: p.maxThreshold },
      ds.surfaces[p.surface].positions, ds.surfaces[p.lengthSurface].positions, p.minLength, spec.connections.max);
    if (spec.connections.bundle) {
      lines = bundleEdges(c.edges, c.values, { compatibilityThreshold: p.bundleCompat, bell: p.bundleBell });
    } else {
      const m = c.values.length;
      const offsets = new Uint32Array(m + 1);
      for (let k = 0; k <= m; k++) offsets[k] = 2 * k;
      lines = { points: c.edges, offsets, values: c.values };
    }
  }
  return {
    ds, topo, sphere, params: p, glyphNodes, threshold, labels, labelColors, seedRow, cursorNode, lines,
    primRadius: spec.primRadius ?? 0.25, maxPrims: spec.maxPrims ?? 400000,
  };
}
