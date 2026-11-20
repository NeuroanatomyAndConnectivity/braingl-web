import { ConnMatrix, SignMode } from "../data/connMatrix";

/**
 * CPU side of the glyph pipeline.
 *
 * brainGL's makeCons()/makeVecs() copied, for every supra-threshold connexel,
 * the node position, the target position and the offsets in the "glyph
 * geometry" and "colour" surfaces (13 to 28 floats). Here a connexel is just
 * (i, j, value) in 8 bytes; all positions are looked up in per-surface
 * textures by the vertex shader, so switching the displayed surface, the glyph
 * geometry or the colour surface no longer rebuilds anything.
 */
export interface BuildFilter {
  /** 1 = a glyph is drawn at this node (ROI and hemisphere selection and data mask). */
  glyphNodes: Uint8Array;
  /** Optional restriction of the connection targets (brainGL's second ROI). */
  targets: Uint8Array | null;
  sign: SignMode;
  /** Connexels with |value| below this are not sent to the GPU at all (brainGL's load-time minimum threshold). */
  threshold: number;
  maxThreshold: number;
}

export const CONNEXEL_STRIDE = 8; // u16 i, u16 j, i16 value, u16 unused
export const DIFF_STRIDE = 12; // u16 i1, u16 i2, u16 j, u16 unused, i16 v1, i16 v2

export interface ConnexelSet {
  count: number;
  data: ArrayBuffer;
  /** connexels of node i are [nodeStart[i], nodeStart[i+1]) */
  nodeStart: Uint32Array;
  threshold: number;
}

function rawBounds(conn: ConnMatrix, f: BuildFilter): { lo: number; hi: number } {
  return { lo: Math.max(1, Math.floor(f.threshold / conn.scale)), hi: Math.ceil(f.maxThreshold / conn.scale) };
}

export function buildConnexels(conn: ConnMatrix, f: BuildFilter): ConnexelSet {
  const { n, data } = conn;
  const { lo, hi } = rawBounds(conn, f);
  const pos = f.sign !== 1, neg = f.sign !== 0;
  const tg = f.targets;
  const nodeStart = new Uint32Array(n + 1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    nodeStart[i] = count;
    if (!f.glyphNodes[i]) continue;
    const o = i * n;
    for (let j = 0; j < n; j++) {
      const v = data[o + j];
      if (v >= lo ? pos && v <= hi : neg && v <= -lo && v >= -hi) {
        if (j !== i && (!tg || tg[j])) count++;
      }
    }
  }
  nodeStart[n] = count;
  const buf = new ArrayBuffer(Math.max(count, 1) * CONNEXEL_STRIDE);
  const u16 = new Uint16Array(buf);
  const i16 = new Int16Array(buf);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!f.glyphNodes[i]) continue;
    const o = i * n;
    for (let j = 0; j < n; j++) {
      const v = data[o + j];
      if (v >= lo ? pos && v <= hi : neg && v <= -lo && v >= -hi) {
        if (j !== i && (!tg || tg[j])) {
          u16[k] = i; u16[k + 1] = j; i16[k + 2] = v;
          k += 4;
        }
      }
    }
  }
  return { count, data: buf, nodeStart, threshold: f.threshold };
}

/** HSV hue in [0, 1) of an rgb triple, -1 if achromatic (Qt's QColor::hueF convention). */
export function hue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-9) return -1;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return h < 0 ? h + 1 : h;
}

/**
 * Pie glyphs: order every node's connexels by the hue of their orientation
 * colour (or by value), exactly what makePies() does with qSort. The order only
 * depends on the colour surface, so it survives threshold changes.
 */
export function sortForPies(set: ConnexelSet, n: number, colorPos: Float32Array, byValue: boolean): ArrayBuffer {
  const out = new ArrayBuffer(set.data.byteLength);
  const src = new Uint16Array(set.data);
  const srcI = new Int16Array(set.data);
  const dst = new Uint16Array(out);
  let keys = new Uint32Array(1024);
  for (let i = 0; i < n; i++) {
    const s = set.nodeStart[i], e = set.nodeStart[i + 1];
    const m = e - s;
    if (m === 0) continue;
    if (keys.length < m) keys = new Uint32Array(m * 2);
    const ix = colorPos[3 * i], iy = colorPos[3 * i + 1], iz = colorPos[3 * i + 2];
    for (let k = 0; k < m; k++) {
      const c = 4 * (s + k);
      let key: number;
      if (byValue) {
        key = srcI[c + 2] + 32768;
      } else {
        const j = src[c + 1];
        let dx = Math.abs(colorPos[3 * j] - ix), dy = Math.abs(colorPos[3 * j + 1] - iy), dz = Math.abs(colorPos[3 * j + 2] - iz);
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l; dy /= l; dz /= l;
        key = Math.round((hue(dx, dy, dz) + 1) * 32767);
      }
      // key in the high 16 bits, local index in the low 16 bits (a node has < 65536 connexels)
      keys[k] = (key << 16 | k) >>> 0;
    }
    const sub = keys.subarray(0, m);
    sub.sort();
    for (let k = 0; k < m; k++) {
      const from = 4 * (s + (sub[m - 1 - k] & 0xffff)); // descending, like brainGL
      const to = 4 * (s + k);
      dst[to] = src[from]; dst[to + 1] = src[from + 1]; dst[to + 2] = src[from + 2]; dst[to + 3] = 0;
    }
  }
  return out;
}

export interface PieParams {
  threshold: number;
  maxThreshold: number;
  minLength: number;
  sign: SignMode;
}

/**
 * Per pie slice: its index among the node's connexels that pass the current
 * threshold / minimum length, and that node's total (a_nth, a_cover in
 * pies.vs). 0xFFFF marks a filtered-out connexel. Linear in the number of
 * connexels, so thresholds stay interactive for pies too (brainGL re-sorted).
 */
export function computePieRanks(
  pieData: ArrayBuffer, nodeStart: Uint32Array, n: number, lengthPos: Float32Array, scale: number, p: PieParams,
): { ranks: Uint16Array; maxCount: number; visible: number } {
  const u16 = new Uint16Array(pieData);
  const i16 = new Int16Array(pieData);
  const total = nodeStart[n];
  const ranks = new Uint16Array(Math.max(total, 1) * 2);
  // raw values are integers; the small margin keeps |value| == maxThreshold inside when the division rounds down
  const lo = p.threshold / scale, hi = p.maxThreshold / scale + 1e-3;
  const pos = p.sign !== 1, neg = p.sign !== 0;
  const minL2 = p.minLength * p.minLength;
  let maxCount = 0, visible = 0;
  for (let i = 0; i < n; i++) {
    const s = nodeStart[i], e = nodeStart[i + 1];
    if (s === e) continue;
    const ix = lengthPos[3 * i], iy = lengthPos[3 * i + 1], iz = lengthPos[3 * i + 2];
    let c = 0;
    for (let k = s; k < e; k++) {
      const v = i16[4 * k + 2];
      let ok = v > 0 ? pos && v > lo && v <= hi : neg && v < -lo && v >= -hi;
      if (ok && minL2 > 0) {
        const j = u16[4 * k + 1];
        const dx = lengthPos[3 * j] - ix, dy = lengthPos[3 * j + 1] - iy, dz = lengthPos[3 * j + 2] - iz;
        ok = dx * dx + dy * dy + dz * dz > minL2;
      }
      ranks[2 * k] = ok ? c++ : 0xffff;
    }
    for (let k = s; k < e; k++) ranks[2 * k + 1] = c;
    if (c > maxCount) maxCount = c;
    visible += c;
  }
  return { ranks, maxCount, visible };
}

export interface DiffSet {
  count: number;
  data: ArrayBuffer;
  threshold: number;
}

/**
 * Difference glyphs: one glyph per mesh edge, holding for every target j the
 * connectivity of both edge endpoints; the shader displays
 * tanh(|atanh(r1) - atanh(r2)|). A target is kept when either endpoint passes
 * the build threshold, so that transitions (one strong, one weak) survive.
 */
export function buildDiffConnexels(conn: ConnMatrix, edges: Uint32Array, f: BuildFilter, budget: number): DiffSet {
  const { n, data } = conn;
  const tg = f.targets;
  const sign = f.sign;
  // The upper threshold is not applied here: on screen it bounds the *difference*, not the
  // endpoint values. A target is kept when either endpoint passes, i.e. when
  // key = max(r1, r2) (positive), -min(r1, r2) (negative) or max(|r1|, |r2|) (both) >= threshold,
  // so one histogram of that key gives the count for every candidate threshold.
  const key = (va: number, vb: number): number => {
    if (sign === 0) return va > vb ? va : vb;
    if (sign === 1) return va < vb ? -va : -vb;
    const a = va < 0 ? -va : va, b = vb < 0 ? -vb : vb;
    return a > b ? a : b;
  };
  const BINS = 32768; // one bin per raw int16 magnitude, so the count is exact
  const hist = new Float64Array(BINS + 1);
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1];
    if (!f.glyphNodes[a] || !f.glyphNodes[b]) continue;
    const oa = a * n, ob = b * n;
    for (let j = 0; j < n; j++) {
      const k = key(data[oa + j], data[ob + j]);
      if (k > 0 && j !== a && j !== b && (!tg || tg[j])) hist[k]++;
    }
  }
  for (let q = BINS - 1; q >= 0; q--) hist[q] += hist[q + 1];
  // smallest raw threshold at or above the requested one whose count fits the budget
  let lo = Math.max(1, Math.floor(f.threshold / conn.scale));
  while (lo < BINS && hist[lo] > budget) lo++;
  const threshold = Math.max(f.threshold, lo * conn.scale);
  const count = Math.min(hist[lo], Math.max(0, Math.floor(budget)));
  const buf = new ArrayBuffer(Math.max(count, 1) * DIFF_STRIDE);
  const u16 = new Uint16Array(buf);
  const i16 = new Int16Array(buf);
  let k = 0, written = 0;
  for (let e = 0; e < edges.length && written < count; e += 2) {
    const a = edges[e], b = edges[e + 1];
    if (!f.glyphNodes[a] || !f.glyphNodes[b]) continue;
    const oa = a * n, ob = b * n;
    for (let j = 0; j < n && written < count; j++) {
      const va = data[oa + j], vb = data[ob + j];
      if (key(va, vb) >= lo && j !== a && j !== b && (!tg || tg[j])) {
        u16[k] = a; u16[k + 1] = b; u16[k + 2] = j; u16[k + 3] = 0;
        i16[k + 4] = va; i16[k + 5] = vb;
        k += 6; written++;
      }
    }
  }
  return { count: written, data: buf, threshold };
}

export interface ConnexelEdges {
  /** x1 y1 z1 x2 y2 z2 per connexel, in the geometry of the displayed surface */
  edges: Float32Array;
  values: Float32Array;
  /** node index pairs */
  pairs: Uint32Array;
  truncated: boolean;
}

/**
 * "Make new connections": every unordered node pair that passes the current
 * filter in either direction and is longer than the minimum length
 * (DatasetGlyphset::createConnections). The strongest `limit` are kept.
 */
export function createConnexels(
  conn: ConnMatrix, f: BuildFilter, positions: Float32Array, lengthPos: Float32Array, minLength: number, limit: number,
): ConnexelEdges {
  const { n, data } = conn;
  const { lo, hi } = rawBounds(conn, f);
  const pos = f.sign !== 1, neg = f.sign !== 0;
  const tg = f.targets;
  const minL2 = minLength * minLength;
  const accept = (i: number, j: number, v: number): boolean => {
    if (!(v >= lo ? pos && v <= hi : neg && v <= -lo && v >= -hi)) return false;
    if (!(f.glyphNodes[i] && (!tg || tg[j])) && !(f.glyphNodes[j] && (!tg || tg[i]))) return false;
    const dx = lengthPos[3 * j] - lengthPos[3 * i], dy = lengthPos[3 * j + 1] - lengthPos[3 * i + 1], dz = lengthPos[3 * j + 2] - lengthPos[3 * i + 2];
    return dx * dx + dy * dy + dz * dz > minL2;
  };
  // pass 1: how many pairs per absolute value, to find the cut that keeps the strongest `limit`
  const hist = new Uint32Array(32769);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const o = i * n;
    for (let j = i + 1; j < n; j++) {
      const v = data[o + j];
      if (v !== 0 && accept(i, j, v)) { hist[v < 0 ? -v : v]++; total++; }
    }
  }
  let cut = 1, above = total, ties = 0;
  const truncated = total > limit;
  if (truncated) {
    // largest cut such that the pairs strictly above it fit; `ties` of the cut value fill the rest
    above = 0;
    cut = 32768;
    while (cut > 1 && above + hist[cut - 1] <= limit) { cut--; above += hist[cut]; }
    ties = limit - above;
    cut--; // pairs with |v| > cut are all kept; those equal to cut only until `ties` runs out
  }
  const m = truncated ? limit : total;
  const edges = new Float32Array(6 * m), values = new Float32Array(m), pairs = new Uint32Array(2 * m);
  let k = 0;
  for (let i = 0; i < n && k < m; i++) {
    const o = i * n;
    for (let j = i + 1; j < n && k < m; j++) {
      const v = data[o + j];
      if (v === 0) continue;
      const a = v < 0 ? -v : v;
      if (truncated) {
        if (a < cut) continue;
        if (a === cut && ties <= 0) continue;
      }
      if (!accept(i, j, v)) continue;
      if (truncated && a === cut) ties--;
      edges.set(positions.subarray(3 * i, 3 * i + 3), 6 * k);
      edges.set(positions.subarray(3 * j, 3 * j + 3), 6 * k + 3);
      values[k] = v * conn.scale;
      pairs[2 * k] = i; pairs[2 * k + 1] = j;
      k++;
    }
  }
  if (k < m) return { edges: edges.slice(0, 6 * k), values: values.slice(0, k), pairs: pairs.slice(0, 2 * k), truncated };
  return { edges, values, pairs, truncated };
}

/** Mean connectivity of a set of seed nodes to every node; correlations are averaged via Fisher's z (avgConRtoZ). */
export function averageConnectivity(conn: ConnMatrix, seeds: Uint8Array, out: Float32Array): number {
  const { n, data, scale } = conn;
  const z = new Float64Array(n);
  let m = 0;
  // Fisher's z only makes sense for correlations; other weights are averaged directly
  const fisher = conn.maxAbs <= 1.0001;
  for (let r = 0; r < n; r++) {
    if (!seeds[r]) continue;
    m++;
    const o = r * n;
    for (let i = 0; i < n; i++) {
      if (i === r) continue;
      if (fisher) {
        const v = Math.max(-0.999999, Math.min(0.999999, data[o + i] * scale));
        z[i] += 0.5 * Math.log((1 + v) / (1 - v));
      } else {
        z[i] += data[o + i] * scale;
      }
    }
  }
  for (let i = 0; i < n; i++) out[i] = m ? (fisher ? Math.tanh(z[i] / m) : z[i] / m) : 0;
  return m;
}
