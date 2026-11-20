import { mat3, mat4, vec3 } from "gl-matrix";
import type { GlyphDataset, MeshTopology, SphereInfo } from "../data/dataset";
import { computeNormals, normaliseSulc } from "../data/dataset";
import type { GlyphParams } from "../glyphs/params";
import { lengthSurfaceIndex } from "../glyphs/params";
import { buildConnexels, buildDiffConnexels, computePieRanks, sortForPies } from "../glyphs/builders";
import type { Polylines } from "../algorithms/meanShiftBundling";
import { colormapLut } from "../render/colormaps";
import { hexToRgb } from "../ui/panel";
import type { Layer } from "./ply";

/**
 * Turns the glyph scene into plain coloured geometry for other 3-D software.
 *
 * This mirrors the vertex shaders on the CPU, with one deliberate difference:
 * on screen, glyphs are lifted toward the viewer and pies / polar projections
 * face the camera. A 3-D export has no fixed camera, so glyphs are lifted
 * along the surface normal and the flat glyph types lie in the plane tangent
 * to the surface at their node.
 */
export interface GlyphBakeInput {
  ds: GlyphDataset;
  topo: MeshTopology;
  sphere: SphereInfo | null;
  params: GlyphParams;
  glyphNodes: Uint8Array;
  /** connection-target mask (brainGL's second ROI), or null for "every node" */
  targets: Uint8Array | null;
  /** threshold in effect (never below what the GPU buffers hold) */
  threshold: number;
  /** lowest |value| held in the GPU connexel buffers (from the connexel budget) */
  buildThreshold: number;
  /** connexel budget in primitives (budgetM * 1e6) */
  budget: number;
  labels: Uint8Array;
  labelColors: string[];
  seedRow: Float32Array | null;
  cursorNode: number;
  lines: Polylines | null;
  /** radius in mm of exported points and tubes */
  primRadius: number;
  /** upper bound on exported glyph primitives; above it they are subsampled */
  maxPrims: number;
}

function glyphRotation(p: GlyphParams): mat3 {
  const rot = mat3.create();
  if (p.rotationEnabled) {
    const m = mat4.create();
    mat4.rotateX(m, m, (p.rotX * Math.PI) / 180);
    mat4.rotateY(m, m, (p.rotY * Math.PI) / 180);
    mat4.rotateZ(m, m, (p.rotZ * Math.PI) / 180);
    mat3.fromMat4(rot, m);
  }
  return rot;
}

/** Local frame at a node: n = surface normal, up = superior projected into the tangent plane, right = up x n. */
function frameAt(normals: Float32Array, i: number, out: Float32Array): void {
  const nx = normals[3 * i], ny = normals[3 * i + 1], nz = normals[3 * i + 2];
  let ux = -nx * nz, uy = -ny * nz, uz = 1 - nz * nz;
  let l = Math.hypot(ux, uy, uz);
  if (l < 1e-4) { ux = -nx * ny; uy = 1 - ny * ny; uz = -nz * ny; l = Math.hypot(ux, uy, uz); }
  ux /= l; uy /= l; uz /= l;
  out[0] = uy * nz - uz * ny; out[1] = uz * nx - ux * nz; out[2] = ux * ny - uy * nx; // right
  out[3] = ux; out[4] = uy; out[5] = uz; // up
  out[6] = nx; out[7] = ny; out[8] = nz;
}

export function bakeSurface(input: GlyphBakeInput): Layer {
  const { ds, params: p } = input;
  const pos = ds.surfaces[p.surface].positions;
  const n = ds.n;
  const colors = new Uint8Array(4 * n);
  const base = hexToRgb(p.surfaceColor);
  const sulcO = ds.overlays.find((o) => /sulc/i.test(o.name)) ?? ds.overlays.find((o) => /curv/i.test(o.name));
  const sulc = sulcO && p.surfaceColorMode !== "solid" ? normaliseSulc(sulcO.data) : null;
  const lut = colormapLut(p.colormap);
  const overlay = p.surfaceColorMode.startsWith("overlay:") ? ds.overlays.find((o) => "overlay:" + o.name === p.surfaceColorMode) : null;
  let lo = p.cmin, hi = p.cmax, values: Float32Array | null = null, lower = p.seedLower;
  if (overlay) {
    const sorted = Float32Array.from(overlay.data).sort();
    lo = sorted[Math.floor(n * 0.02)]; hi = sorted[Math.floor(n * 0.98)];
    values = overlay.data; lower = 0;
  } else if (p.surfaceColorMode === "seed" && input.seedRow) {
    values = input.seedRow;
  }
  const paint = input.labelColors.map(hexToRgb);
  const smooth = (x: number) => { const t = Math.min(1, Math.max(0, (x + 0.25) / 0.5)); return t * t * (3 - 2 * t); };
  for (let i = 0; i < n; i++) {
    const shade = sulc ? 1 - 0.45 * smooth(sulc[i]) : 1;
    let r = base[0] * shade, g = base[1] * shade, b = base[2] * shade;
    if (values && Math.abs(values[i]) >= lower) {
      const t = Math.round(255 * Math.min(1, Math.max(0, (values[i] - lo) / (hi - lo || 1))));
      r = lut[4 * t] / 255; g = lut[4 * t + 1] / 255; b = lut[4 * t + 2] / 255;
    }
    const l = input.labels[i];
    if (l && p.showPaint) {
      const c = paint[l - 1] ?? [1, 1, 1];
      const a = 215 / 255;
      r += (c[0] - r) * a; g += (c[1] - g) * a; b += (c[2] - b) * a;
    }
    colors[4 * i] = r * 255; colors[4 * i + 1] = g * 255; colors[4 * i + 2] = b * 255; colors[4 * i + 3] = 255;
  }
  let triangles = ds.triangles;
  const split = ds.leftTriangles > 0 && ds.leftTriangles * 3 < triangles.length ? ds.leftTriangles * 3 : 0;
  if (split && p.hemi === 1) triangles = triangles.subarray(0, split);
  if (split && p.hemi === 2) triangles = triangles.subarray(split);
  return { name: `surface ${ds.surfaces[p.surface].name}`, kind: "mesh", positions: pos, colors, triangles, shading: "lit", smooth: true, opacity: p.surfaceAlpha };
}

/** Glyph primitives of the current style: points / segments / triangles. */
export function bakeGlyphs(input: GlyphBakeInput): Layer | null {
  const { ds, params: p, sphere } = input;
  if (p.glyphStyle === "off") return null;
  const n = ds.n;
  const disp = ds.surfaces[p.surface].positions;
  const polar = p.glyphGeometry === -1 && !!sphere;
  const geo = ds.surfaces[polar ? p.colorSurface : Math.max(0, p.glyphGeometry)].positions;
  const col = ds.surfaces[p.colorSurface].positions;
  const len = ds.surfaces[lengthSurfaceIndex(p)].positions;
  const sph = sphere ? ds.surfaces[sphere.surface].positions : null;
  const normals = computeNormals(disp, ds.triangles);
  const rot = glyphRotation(p);
  const lut = colormapLut(p.colormap);
  const lift = p.depthLift * p.glyphRadius * 100;
  const scale = ds.conn.scale;
  const minL2 = p.minLength * p.minLength;
  const split = ds.leftNodes > 0 && ds.leftNodes < n ? ds.leftNodes : 0;
  // As on screen, the upper threshold is never part of the build filter: it is applied below,
  // when the primitives are selected (points / vectors / differences) or ranked (pies).
  const filter = { glyphNodes: input.glyphNodes, targets: input.targets, sign: p.sign, threshold: input.threshold, maxThreshold: ds.conn.maxAbs };
  const fr = new Float32Array(9);
  const tmp = vec3.create();

  const setColor = (colors: Uint8Array, k: number, dx: number, dy: number, dz: number, value: number) => {
    if (p.glyphColorMode === 1) {
      const t = Math.round(255 * Math.min(1, Math.max(0, (value - p.cmin) / (p.cmax - p.cmin || 1))));
      colors[4 * k] = lut[4 * t]; colors[4 * k + 1] = lut[4 * t + 1]; colors[4 * k + 2] = lut[4 * t + 2];
    } else {
      const l = Math.hypot(dx, dy, dz) || 1;
      colors[4 * k] = (Math.abs(dx) / l) * 255; colors[4 * k + 1] = (Math.abs(dy) / l) * 255; colors[4 * k + 2] = (Math.abs(dz) / l) * 255;
    }
    colors[4 * k + 3] = 255;
  };

  /** unit-frame polar position of target j around node i (see polarOffset in common.glsl) */
  const polarXY = (i: number, j: number, out: [number, number]) => {
    const ri = split > 0 && i >= split, rj = split > 0 && j >= split;
    const ci = ri ? sphere!.centerR : sphere!.centerL, cj = rj ? sphere!.centerR : sphere!.centerL;
    let ax = sph![3 * i] - ci[0], ay = sph![3 * i + 1] - ci[1], az = sph![3 * i + 2] - ci[2];
    let bx = sph![3 * j] - cj[0], by = sph![3 * j + 1] - cj[1], bz = sph![3 * j + 2] - cj[2];
    let l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
    l = Math.hypot(bx, by, bz) || 1; bx /= l; by /= l; bz /= l;
    if (ri !== rj) ax = -ax;
    let ux = -ax * az, uy = -ay * az, uz = 1 - az * az;
    l = Math.hypot(ux, uy, uz);
    if (l < 1e-3) { ux = -ax * ay; uy = 1 - ay * ay; uz = -az * ay; l = Math.hypot(ux, uy, uz); }
    ux /= l; uy /= l; uz /= l;
    const rx = uy * az - uz * ay, ry = uz * ax - ux * az, rz = ux * ay - uy * ax;
    const c = Math.min(1, Math.max(-1, ax * bx + ay * by + az * bz));
    const tx = bx - ax * c, ty = by - ay * c, tz = bz - az * c;
    const tl = Math.hypot(tx, ty, tz);
    const r = tl > 1e-6 ? Math.acos(c) / Math.PI / tl : 0;
    let x = (tx * rx + ty * ry + tz * rz) * r, y = (tx * ux + ty * uy + tz * uz) * r;
    if (split) { x = 0.5 * x + (rj ? 0.5 : -0.5); y *= 0.5; }
    out[0] = x; out[1] = y;
  };
  const xy: [number, number] = [0, 0];

  /** position of the primitive of connexel i -> j given the glyph centre */
  const place = (i: number, j: number, cx: number, cy: number, cz: number, out: Float32Array, k: number) => {
    if (polar) {
      polarXY(i, j, xy);
      const s = p.glyphRadius * 100;
      out[3 * k] = cx + (fr[0] * xy[0] + fr[3] * xy[1]) * s;
      out[3 * k + 1] = cy + (fr[1] * xy[0] + fr[4] * xy[1]) * s;
      out[3 * k + 2] = cz + (fr[2] * xy[0] + fr[5] * xy[1]) * s;
    } else {
      vec3.set(tmp, geo[3 * j] - geo[3 * i], geo[3 * j + 1] - geo[3 * i + 1], geo[3 * j + 2] - geo[3 * i + 2]);
      vec3.transformMat3(tmp, tmp, rot);
      out[3 * k] = cx + tmp[0] * p.glyphRadius; out[3 * k + 1] = cy + tmp[1] * p.glyphRadius; out[3 * k + 2] = cz + tmp[2] * p.glyphRadius;
    }
  };

  if (p.glyphStyle === "diffpoints") {
    // same prefilter and budget as the screen (GlyphApp.ensureGlyphs), then the display test of diff.vert.glsl
    const d = buildDiffConnexels(ds.conn, input.topo.edges, { ...filter, threshold: Math.max(input.buildThreshold * 0.5, ds.conn.maxAbs * 0.15) }, input.budget);
    const u16 = new Uint16Array(d.data), i16 = new Int16Array(d.data);
    const fisher = ds.conn.maxAbs <= 1.0001;
    const keep: number[] = [];
    const diffs: number[] = [];
    for (let k = 0; k < d.count; k++) {
      const v1 = i16[6 * k + 4] * scale, v2 = i16[6 * k + 5] * scale;
      const diff = fisher ? Math.tanh(Math.abs(Math.atanh(clampR(v1)) - Math.atanh(clampR(v2)))) : Math.abs(v1 - v2);
      if (!(diff > input.threshold && diff <= p.maxThreshold)) continue;
      const a = u16[6 * k], b = u16[6 * k + 1], j = u16[6 * k + 2];
      const mx = 0.5 * (len[3 * a] + len[3 * b]) - len[3 * j], my = 0.5 * (len[3 * a + 1] + len[3 * b + 1]) - len[3 * j + 1], mz = 0.5 * (len[3 * a + 2] + len[3 * b + 2]) - len[3 * j + 2];
      if (mx * mx + my * my + mz * mz <= minL2) continue;
      keep.push(k); diffs.push(diff);
    }
    const stride = Math.max(1, Math.ceil(keep.length / input.maxPrims));
    const m = Math.ceil(keep.length / stride);
    const positions = new Float32Array(3 * m), colors = new Uint8Array(4 * m);
    const pa = new Float32Array(3), pb = new Float32Array(3), mid = new Float32Array(3);
    for (let q = 0, o = 0; q < keep.length; q += stride, o++) {
      const k = keep[q];
      const a = u16[6 * k], b = u16[6 * k + 1], j = u16[6 * k + 2];
      const nx = normals[3 * a] + normals[3 * b], ny = normals[3 * a + 1] + normals[3 * b + 1], nz = normals[3 * a + 2] + normals[3 * b + 2];
      const nl = Math.hypot(nx, ny, nz) || 1;
      mid[0] = nx / nl; mid[1] = ny / nl; mid[2] = nz / nl; // normal at the edge midpoint
      const cx = 0.5 * (disp[3 * a] + disp[3 * b]) + mid[0] * lift, cy = 0.5 * (disp[3 * a + 1] + disp[3 * b + 1]) + mid[1] * lift, cz = 0.5 * (disp[3 * a + 2] + disp[3 * b + 2]) + mid[2] * lift;
      frameAt(mid, 0, fr);
      place(a, j, cx, cy, cz, pa, 0);
      place(b, j, cx, cy, cz, pb, 0);
      positions[3 * o] = 0.5 * (pa[0] + pb[0]); positions[3 * o + 1] = 0.5 * (pa[1] + pb[1]); positions[3 * o + 2] = 0.5 * (pa[2] + pb[2]);
      setColor(colors, o, col[3 * j] - 0.5 * (col[3 * a] + col[3 * b]), col[3 * j + 1] - 0.5 * (col[3 * a + 1] + col[3 * b + 1]), col[3 * j + 2] - 0.5 * (col[3 * a + 2] + col[3 * b + 2]), diffs[q]);
    }
    return { name: "glyphs diffpoints", kind: "points", positions, colors, radius: input.primRadius, shading: "flat", truncated: stride > 1 };
  }

  const set = buildConnexels(ds.conn, filter);
  const u16 = new Uint16Array(set.data), i16 = new Int16Array(set.data);

  if (p.glyphStyle === "pies") {
    const sorted = sortForPies(set, n, col, p.glyphColorMode === 1);
    const { ranks, maxCount } = computePieRanks(sorted, set.nodeStart, n, len, scale, { threshold: input.threshold, maxThreshold: p.maxThreshold, minLength: p.minLength, sign: p.sign });
    const su = new Uint16Array(sorted), si = new Int16Array(sorted);
    // A pie can have thousands of slices. Beyond WEDGES per pie they are narrower than
    // anything a render can resolve, so each pie is resampled to at most WEDGES equal
    // wedges, each with the mean colour of the slices it covers. A wedge is one flat
    // triangle, so a pie of one or two slices (a full or half disc) is cut into
    // SMALL_PIE_WEDGES wedges; otherwise its triangles would have no area.
    const WEDGES = 48, SMALL_PIE_WEDGES = 24;
    const P: number[] = [], C: number[] = [];
    const rgba = new Uint8Array(4);
    const acc = new Float64Array(3 * WEDGES), cnt = new Uint32Array(WEDGES);
    for (let i = 0; i < n; i++) {
      const s0 = set.nodeStart[i], e0 = set.nodeStart[i + 1];
      if (s0 === e0) continue;
      const count = ranks[2 * s0 + 1];
      if (!count) continue;
      const W = count < 3 ? SMALL_PIE_WEDGES : Math.min(count, WEDGES);
      acc.fill(0); cnt.fill(0);
      for (let k = s0; k < e0; k++) {
        const rank = ranks[2 * k];
        if (rank === 0xffff) continue;
        const j = su[4 * k + 1];
        setColor(rgba, 0, col[3 * j] - col[3 * i], col[3 * j + 1] - col[3 * i + 1], col[3 * j + 2] - col[3 * i + 2], si[4 * k + 2] * scale);
        // wedges [w0, w1) of this slice: exactly one, except in the small pies, where a slice spans several
        const w0 = Math.floor((rank * W) / count);
        const w1 = Math.max(w0 + 1, Math.floor(((rank + 1) * W) / count));
        for (let w = w0; w < w1; w++) {
          acc[3 * w] += rgba[0]; acc[3 * w + 1] += rgba[1]; acc[3 * w + 2] += rgba[2]; cnt[w]++;
        }
      }
      frameAt(normals, i, fr);
      const rel = count / Math.max(1, maxCount);
      const r = (p.normalization * Math.sqrt(rel) + (1 - p.normalization)) * p.glyphRadius * 100;
      const h = lift + p.glyphRadius * 100 * (1 - rel) * 0.05; // smaller pies slightly above larger ones
      const cx = disp[3 * i] + fr[6] * h, cy = disp[3 * i + 1] + fr[7] * h, cz = disp[3 * i + 2] + fr[8] * h;
      for (let w = 0; w < W; w++) {
        if (!cnt[w]) continue;
        P.push(cx, cy, cz);
        for (let c = 0; c < 2; c++) {
          const t = ((w + c) / W) * 2 * Math.PI;
          const sn = Math.sin(t) * r, cs = Math.cos(t) * r;
          P.push(cx + fr[0] * sn + fr[3] * cs, cy + fr[1] * sn + fr[4] * cs, cz + fr[2] * sn + fr[5] * cs);
        }
        for (let c = 0; c < 3; c++) C.push(acc[3 * w] / cnt[w], acc[3 * w + 1] / cnt[w], acc[3 * w + 2] / cnt[w], 255);
      }
    }
    const positions = Float32Array.from(P), colors = Uint8Array.from(C);
    const triangles = new Uint32Array(positions.length / 3);
    for (let v = 0; v < triangles.length; v++) triangles[v] = v;
    return { name: "glyphs pies", kind: "mesh", positions, colors, triangles, shading: "flat", smooth: false };
  }

  // points and vectors: the test of passes() in common.glsl, in value units (dividing the thresholds
  // by the scale instead can lose the largest entries to rounding when maxThreshold = maxAbs)
  const lo = input.threshold, hi = p.maxThreshold;
  const pos = p.sign !== 1, neg = p.sign !== 0;
  const keep: number[] = [];
  for (let k = 0; k < set.count; k++) {
    const v = i16[4 * k + 2] * scale;
    if (!(v > 0 ? pos && v > lo && v <= hi : neg && v < -lo && v >= -hi)) continue;
    if (minL2 > 0) {
      const i = u16[4 * k], j = u16[4 * k + 1];
      const dx = len[3 * j] - len[3 * i], dy = len[3 * j + 1] - len[3 * i + 1], dz = len[3 * j + 2] - len[3 * i + 2];
      if (dx * dx + dy * dy + dz * dz <= minL2) continue;
    }
    keep.push(k);
  }
  const stride = Math.max(1, Math.ceil(keep.length / input.maxPrims));
  const m = Math.ceil(keep.length / stride);
  const vectors = p.glyphStyle === "vectors";
  const per = vectors ? 2 : 1;
  const positions = new Float32Array(3 * m * per), colors = new Uint8Array(4 * m * per);
  const edges = vectors ? new Uint32Array(2 * m) : undefined;
  for (let q = 0, o = 0; q < keep.length; q += stride, o++) {
    const k = keep[q];
    const i = u16[4 * k], j = u16[4 * k + 1];
    frameAt(normals, i, fr);
    const cx = disp[3 * i] + fr[6] * lift, cy = disp[3 * i + 1] + fr[7] * lift, cz = disp[3 * i + 2] + fr[8] * lift;
    const a = o * per;
    place(i, j, cx, cy, cz, positions, a + per - 1);
    const value = i16[4 * k + 2] * scale;
    setColor(colors, a + per - 1, col[3 * j] - col[3 * i], col[3 * j + 1] - col[3 * i + 1], col[3 * j + 2] - col[3 * i + 2], value);
    if (vectors) {
      positions[3 * a] = cx; positions[3 * a + 1] = cy; positions[3 * a + 2] = cz;
      colors.copyWithin(4 * a, 4 * (a + 1), 4 * (a + 2));
      edges![2 * o] = a; edges![2 * o + 1] = a + 1;
    }
  }
  return {
    name: `glyphs ${p.glyphStyle}`, kind: vectors ? "segments" : "points", positions, colors, edges,
    radius: vectors ? input.primRadius * 0.5 : input.primRadius, shading: "flat", truncated: stride > 1,
  };
}

function clampR(v: number): number {
  return Math.min(0.999999, Math.max(-0.999999, v));
}

/** Anatomical background glyphs as one merged mesh. */
export function bakeLittleBrains(input: GlyphBakeInput): Layer | null {
  const { ds, params: p } = input;
  if (!p.littleBrains || p.glyphGeometry === -1) return null;
  let nodes: number[] = [];
  for (let i = 0; i < ds.n; i++) if (input.labels[i] && input.glyphNodes[i]) nodes.push(i);
  if (!nodes.length && input.cursorNode >= 0) nodes = [input.cursorNode];
  if (!nodes.length) return null;
  const cap = Math.min(p.lbMax, Math.max(1, Math.floor(4e6 / ds.n)));
  let truncated = false;
  if (nodes.length > cap) {
    const step = nodes.length / cap;
    nodes = Array.from({ length: cap }, (_, k) => nodes[Math.floor(k * step)]);
    truncated = true;
  }
  const n = ds.n, nt = ds.triangles.length;
  const disp = ds.surfaces[p.surface].positions, geo = ds.surfaces[p.glyphGeometry].positions;
  const normals = computeNormals(disp, ds.triangles);
  const rot = glyphRotation(p);
  const lut = colormapLut(p.colormap);
  const base = hexToRgb(p.surfaceColor);
  const sulcO = ds.overlays.find((o) => /sulc/i.test(o.name)) ?? ds.overlays.find((o) => /curv/i.test(o.name));
  const sulc = sulcO && p.lbColorMode !== 0 ? normaliseSulc(sulcO.data) : null;
  const lift = p.depthLift * p.glyphRadius * 100;
  const positions = new Float32Array(3 * n * nodes.length), colors = new Uint8Array(4 * n * nodes.length), triangles = new Uint32Array(nt * nodes.length);
  const raw = ds.conn.data, scale = ds.conn.scale;
  const tmp = vec3.create();
  const pos = p.sign !== 1, neg = p.sign !== 0;
  nodes.forEach((node, k) => {
    const cx = disp[3 * node] + normals[3 * node] * lift, cy = disp[3 * node + 1] + normals[3 * node + 1] * lift, cz = disp[3 * node + 2] + normals[3 * node + 2] * lift;
    for (let v = 0; v < n; v++) {
      vec3.set(tmp, geo[3 * v] - geo[3 * node], geo[3 * v + 1] - geo[3 * node + 1], geo[3 * v + 2] - geo[3 * node + 2]);
      vec3.transformMat3(tmp, tmp, rot);
      const o = k * n + v;
      positions[3 * o] = cx + tmp[0] * p.glyphRadius; positions[3 * o + 1] = cy + tmp[1] * p.glyphRadius; positions[3 * o + 2] = cz + tmp[2] * p.glyphRadius;
      const t0 = sulc ? Math.min(1, Math.max(0, (sulc[v] + 0.2) / 0.4)) : 0;
      const shade = sulc ? 1 - 0.45 * t0 * t0 * (3 - 2 * t0) : 1;
      let r = base[0] * shade * 255, g = base[1] * shade * 255, b = base[2] * shade * 255;
      if (p.lbColorMode === 1) {
        const val = raw[node * n + v] * scale;
        if ((pos && val > input.threshold && val <= p.maxThreshold) || (neg && val < -input.threshold && val >= -p.maxThreshold)) {
          const t = Math.round(255 * Math.min(1, Math.max(0, (val - p.cmin) / (p.cmax - p.cmin || 1))));
          r = lut[4 * t]; g = lut[4 * t + 1]; b = lut[4 * t + 2];
        }
      }
      colors[4 * o] = r; colors[4 * o + 1] = g; colors[4 * o + 2] = b; colors[4 * o + 3] = 255;
    }
    for (let t = 0; t < nt; t++) triangles[k * nt + t] = ds.triangles[t] + k * n;
  });
  return { name: "little brains", kind: "mesh", positions, colors, triangles, shading: "lit", smooth: true, truncated };
}

/** Connexels or bundles as coloured polylines. */
export function bakeLines(lines: Polylines, p: GlyphParams, radius: number): Layer {
  const nLines = lines.offsets.length - 1;
  const nPts = lines.points.length / 3;
  const colors = new Uint8Array(4 * nPts);
  const edges = new Uint32Array(2 * (nPts - nLines));
  const lut = colormapLut(p.colormap);
  let e = 0;
  for (let l = 0; l < nLines; l++) {
    const a = lines.offsets[l], b = lines.offsets[l + 1];
    let r: number, g: number, bl: number;
    if (p.lineColorMode === 1) {
      const t = Math.round(255 * Math.min(1, Math.max(0, (lines.values[l] - p.cmin) / (p.cmax - p.cmin || 1))));
      r = lut[4 * t]; g = lut[4 * t + 1]; bl = lut[4 * t + 2];
    } else {
      const dx = lines.points[3 * (b - 1)] - lines.points[3 * a], dy = lines.points[3 * (b - 1) + 1] - lines.points[3 * a + 1], dz = lines.points[3 * (b - 1) + 2] - lines.points[3 * a + 2];
      const len = Math.hypot(dx, dy, dz) || 1;
      r = (Math.abs(dx) / len) * 255; g = (Math.abs(dy) / len) * 255; bl = (Math.abs(dz) / len) * 255;
    }
    for (let k = a; k < b; k++) {
      colors[4 * k] = r; colors[4 * k + 1] = g; colors[4 * k + 2] = bl; colors[4 * k + 3] = 255;
      if (k < b - 1) { edges[e++] = k; edges[e++] = k + 1; }
    }
  }
  return { name: "connections", kind: "segments", positions: lines.points, colors, edges, radius, shading: "flat" };
}

export function bakeGlyphScene(input: GlyphBakeInput): Layer[] {
  const layers: Layer[] = [];
  if (input.params.showSurface) layers.push(bakeSurface(input));
  if (input.params.showGlyphs) {
    const lb = bakeLittleBrains(input);
    if (lb) layers.push(lb);
    const g = bakeGlyphs(input);
    if (g && g.positions.length) layers.push(g);
  }
  if (input.lines && input.params.showConnections) layers.push(bakeLines(input.lines, input.params, Math.max(0.05, input.primRadius * 0.6)));
  return layers;
}
