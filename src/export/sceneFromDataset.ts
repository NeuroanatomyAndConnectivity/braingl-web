import { thresholdForBudget } from "../data/connMatrix";
import { buildTopology, findSphere, GlyphDataset } from "../data/dataset";
import { createConnexels } from "../glyphs/builders";
import { defaultGlyphParams, GlyphParams, lengthSurfaceIndex, valueUnit } from "../glyphs/params";
import { brushNodes } from "../glyphs/picking";
import { bundleEdges, Polylines } from "../algorithms/meanShiftBundling";
import type { GlyphBakeInput } from "./bake";

/** A glyph scene described without any UI: used by the command-line exporter and by tests. */
export interface SceneSpec {
  params?: Partial<GlyphParams>;
  /** paint a region around each of these nodes (one region per entry) */
  regions?: { node: number; radius: number; color?: string }[];
  /** restrict the connection targets to the nodes with a non-zero entry (brainGL's second ROI) */
  targets?: Uint8Array | null;
  seedNode?: number;
  /** create connexels from the current thresholds (and optionally bundle them) */
  connections?: { max: number; bundle: boolean };
  primRadius?: number;
  maxPrims?: number;
}

/**
 * Reproduces what the glyph workspace derives from its parameters before drawing.
 *
 * Parameters that the spec does not give take the application defaults. As in
 * the application, the defaults that are expressed in connectivity units are
 * scaled by the largest absolute value of matrices that are not correlations,
 * and the upper threshold defaults to that largest value.
 */
export function sceneFromDataset(ds: GlyphDataset, spec: SceneSpec = {}): GlyphBakeInput {
  const given = spec.params ?? {};
  const p: GlyphParams = { ...defaultGlyphParams, ...given };
  const maxAbs = ds.conn.maxAbs;
  // not a correlation matrix: the value-dependent defaults follow the range of the data (GlyphApp.setDataset)
  const unit = valueUnit(maxAbs);
  for (const k of ["threshold", "cmin", "cmax", "seedLower"] as const) if (given[k] === undefined) p[k] = defaultGlyphParams[k] * unit;
  const ns = ds.surfaces.length;
  for (const k of ["surface", "secondSurface", "colorSurface"] as const) p[k] = Math.min(Math.max(0, p[k]), ns - 1);
  // -1 = measure connection length on the displayed surface
  if (p.lengthSurface !== -1) p.lengthSurface = Math.min(Math.max(0, p.lengthSurface), ns - 1);
  const sphere = findSphere(ds);
  if (p.glyphGeometry >= ns || p.glyphGeometry < -1 || (p.glyphGeometry === -1 && !sphere)) p.glyphGeometry = 0;
  p.threshold = Math.min(Math.max(0, p.threshold), maxAbs);
  p.maxThreshold = given.maxThreshold !== undefined ? Math.min(given.maxThreshold, maxAbs) : maxAbs;
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
  const targets = spec.targets ?? null;
  if (targets && targets.length !== ds.n) throw new Error(`the target mask has ${targets.length} entries, the dataset ${ds.n} nodes`);
  const budget = p.budgetM * 1e6;
  const cum = ds.conn.cumulativeHistogram(glyphNodes, p.sign);
  const buildThreshold = thresholdForBudget(cum, maxAbs, budget);
  // difference glyphs have their own prefilter; everything else cannot go below what the buffers hold
  const threshold = p.glyphStyle === "diffpoints" ? p.threshold : Math.max(p.threshold, buildThreshold);
  let seedRow: Float32Array | null = null;
  const cursorNode = spec.seedNode ?? -1;
  if (cursorNode >= 0) {
    seedRow = ds.conn.row(cursorNode, new Float32Array(ds.n));
    seedRow[cursorNode] = maxAbs;
  }
  let lines: Polylines | null = null;
  if (spec.connections) {
    // "Make connections" (GlyphApp.makeConnections): never below the threshold in effect on screen, no upper
    // threshold (DatasetGlyphset::createConnections has none), drawn on the displayed surface
    const c = createConnexels(ds.conn, { glyphNodes, targets, sign: p.sign, threshold: Math.max(threshold, maxAbs * 0.02), maxThreshold: maxAbs },
      ds.surfaces[p.surface].positions, ds.surfaces[lengthSurfaceIndex(p)].positions, p.minLength, spec.connections.max);
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
    ds, topo, sphere, params: p, glyphNodes, targets, threshold, buildThreshold, budget, labels, labelColors, seedRow, cursorNode, lines,
    primRadius: spec.primRadius ?? 0.25, maxPrims: spec.maxPrims ?? 400000,
  };
}
