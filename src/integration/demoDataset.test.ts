/**
 * Integration tests on the real data that ship with the application:
 *
 *   public/data/nki_fsaverage4   group-average resting-state functional connectivity of 40 participants of the
 *                                enhanced NKI Rockland sample on fsaverage4 (2 x 2562 nodes, left hemisphere first)
 *   public/directionality        the four demo sets of the directionality workspace
 *
 * Everything is read from disk with a node `fs` FileGetter, as tools/blenderExport.ts does. The suites are
 * skipped when the folders are missing. Besides file and shape sanity they hold a few neuroscience regression
 * checks that any decent resting-state average has to pass; these are stated on medians and proportions over
 * thousands of nodes, never on single nodes, and with wide margins around the values of the bundled data
 * (given in the comments).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ConnMatrix, fractionAbove, HIST_BINS, thresholdForBudget } from "../data/connMatrix";
import { buildTopology, computeBounds, findSphere, GlyphDataset, MeshTopology, surfaceIndexByName } from "../data/dataset";
import { loadFromFiles } from "../data/loadFiles";
import { isWebManifest, loadWebGlyphset, WebGlyphsetManifest } from "../data/loadWeb";
import { parseLabelOrder } from "../directionality/io/labelOrderReader";
import { parseLabels } from "../directionality/io/labelReader";
import { parsePly } from "../directionality/io/plyReader";
import { buildConnexels, BuildFilter, computePieRanks, createConnexels, sortForPies } from "../glyphs/builders";
import { FixtureDataset, icoBrain, withValues } from "../testing/fixtures";
import { canonicalTriangles, distance, passesStrict, signedVolume6 } from "../testing/reference";
import { LooseOptions, toBrainGLFiles, toLooseFiles, toWebGlyphsetFiles, WebDtype, WebLayout, webScale } from "../testing/serialise";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO = join(ROOT, "public/data/nki_fsaverage4");
const DIRECTIONALITY = join(ROOT, "public/directionality");

/** Read a file of a folder as ArrayBuffer (the FileGetter that loadWebGlyphset expects). */
function fileGetter(dir: string) {
  return async (name: string): Promise<ArrayBuffer> => {
    const b = readFileSync(join(dir, name));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const share = (values: number[], test: (v: number) => boolean): number => values.filter(test).length / values.length;

describe.skipIf(!existsSync(join(DEMO, "glyphset.json")))("bundled demo dataset public/data/nki_fsaverage4", () => {
  // fsaverage4: an icosphere of order 4 per hemisphere
  const HEMI_NODES = 2562, HEMI_TRIANGLES = 5120, N = 2 * HEMI_NODES;
  let man: WebGlyphsetManifest & Record<string, unknown>;
  let ds: GlyphDataset;
  let topo: MeshTopology;
  let pial: Float32Array;
  /** nodes that carry data */
  let cortex: number[];
  /** for every cortical node: the cortical node of the other hemisphere nearest to its mirror image (x -> -x) on the pial surface */
  let homotopic: Int32Array;

  const dist = (i: number, j: number) => distance(pial, i, j);

  beforeAll(async () => {
    const parsed: unknown = JSON.parse(readFileSync(join(DEMO, "glyphset.json"), "utf8"));
    if (!isWebManifest(parsed)) throw new Error("public/data/nki_fsaverage4/glyphset.json is not a web glyphset manifest");
    man = parsed as WebGlyphsetManifest & Record<string, unknown>;
    ds = await loadWebGlyphset(man, fileGetter(DEMO));
    topo = buildTopology(ds.n, ds.triangles);
    pial = ds.surfaces[surfaceIndexByName(ds, ["pial"])].positions;
    cortex = [];
    for (let i = 0; i < ds.n; i++) if (ds.mask[i]) cortex.push(i);
    homotopic = new Int32Array(ds.n).fill(-1);
    for (const i of cortex) {
      const [lo, hi] = i < ds.leftNodes ? [ds.leftNodes, ds.n] : [0, ds.leftNodes];
      let best = -1, bestD = Infinity;
      for (let j = lo; j < hi; j++) {
        if (!ds.mask[j]) continue;
        const d = Math.hypot(pial[3 * j] + pial[3 * i], pial[3 * j + 1] - pial[3 * i + 1], pial[3 * j + 2] - pial[3 * i + 2]);
        if (d < bestD) { bestD = d; best = j; }
      }
      homotopic[i] = best;
    }
  });

  // ------------------------------------------------------------ files, manifest, shape

  describe("manifest and files", () => {
    it("is a version 1 web glyphset of 5124 nodes, left hemisphere first", () => {
      expect(man.format).toBe("braingl-web-glyphset");
      expect(man.version).toBe(1);
      expect(man.nodes).toBe(N);
      expect(man.leftNodes).toBe(HEMI_NODES);
      expect(man.leftTriangles).toBe(HEMI_TRIANGLES);
      expect(man.surfaces.map((s) => s.name)).toEqual(["pial", "inflated", "sphere", "white"]);
      expect((man.overlays ?? []).map((o) => o.name)).toEqual(["sulc", "curv"]);
      expect(man.connectivity.layout).toBe("upper");
      expect(["int8", "int16", "float32"]).toContain(man.connectivity.dtype);
      expect(man.connectivity.scale ?? 1).toBeGreaterThan(0);
      expect(man.mask).toBeTruthy();
    });

    it("says what the data are and whom to credit (further keys are allowed)", () => {
      expect(typeof man.name).toBe("string");
      expect(man.name).toMatch(/NKI/);
      expect(man.description ?? "").toMatch(/resting-state functional connectivity/i);
      expect(man.description ?? "").toMatch(/NKI Rockland/i);
      expect(man.description ?? "").toMatch(/fsaverage4/);
      // optional keys: checked only when present
      if (man.subjects !== undefined) {
        expect(Number.isInteger(man.subjects) && (man.subjects as number) > 1).toBe(true);
        expect(man.description).toContain(`${man.subjects} participants`);
        expect(man.name).toContain(`n=${man.subjects}`);
      }
      if (man.credit !== undefined) {
        expect(typeof man.credit).toBe("string");
        expect(man.credit).toMatch(/Rockland/);
        expect(man.credit).toMatch(/Nooner et al\. 2012/);
        expect(man.credit).toMatch(/fsaverage/i);
      }
      if (man.source !== undefined) expect(String(man.source)).toMatch(/^https?:\/\//);
    });

    it("every referenced file exists with exactly the size its role implies, and no file is referenced twice", () => {
      const bytesPerValue = { int8: 1, int16: 2, float32: 4 }[man.connectivity.dtype];
      const expected: [string, number][] = [
        [man.triangles, 2 * HEMI_TRIANGLES * 3 * 4],
        ...man.surfaces.map((s): [string, number] => [s.file, N * 3 * 4]),
        ...(man.overlays ?? []).map((o): [string, number] => [o.file, N * 4]),
        [man.mask!, N],
        [man.connectivity.file, ((N * (N - 1)) / 2) * bytesPerValue],
      ];
      expect(new Set(expected.map(([name]) => name)).size).toBe(expected.length);
      for (const [name, size] of expected) expect([name, statSync(join(DEMO, name)).size]).toEqual([name, size]);
      // nothing binary lies around unreferenced (text files such as a README would be fine)
      const referenced = new Set(expected.map(([name]) => name));
      const stray = readdirSync(DEMO).filter((f) => /\.(f32|u32|u8|i8|i16)$/.test(f) && !referenced.has(f));
      expect(stray).toEqual([]);
    });
  });

  describe("mesh", () => {
    it("has the shape the manifest announces", () => {
      expect(ds.n).toBe(N);
      expect(ds.leftNodes).toBe(HEMI_NODES);
      expect(ds.leftTriangles).toBe(HEMI_TRIANGLES);
      expect(ds.triangles.length).toBe(2 * HEMI_TRIANGLES * 3);
      expect(ds.surfaces.map((s) => s.positions.length)).toEqual([N * 3, N * 3, N * 3, N * 3]);
      expect(ds.overlays.map((o) => [o.name, o.data.length])).toEqual([["sulc", N], ["curv", N]]);
      expect(ds.mask.length).toBe(N);
      expect(ds.conn.n).toBe(N);
      expect(ds.conn.data.length).toBe(N * N);
    });

    it("is two closed icospheres of order 4: left triangles use left nodes only, 12 nodes per hemisphere have 5 neighbours", () => {
      let wrongSide = 0;
      for (let t = 0; t < ds.triangles.length; t++) if ((t < 3 * HEMI_TRIANGLES) !== (ds.triangles[t] < HEMI_NODES)) wrongSide++;
      expect(wrongSide).toBe(0);
      // closed manifold: every edge belongs to two triangles, V - E + F = 2 per hemisphere
      const edges = topo.edges.length / 2;
      expect(edges).toBe(2 * ((HEMI_TRIANGLES * 3) / 2));
      expect(2 * HEMI_NODES - edges + 2 * HEMI_TRIANGLES).toBe(4);
      for (const [lo, hi] of [[0, HEMI_NODES], [HEMI_NODES, N]]) {
        const degrees = new Map<number, number>();
        for (let i = lo; i < hi; i++) { const d = topo.adjStart[i + 1] - topo.adjStart[i]; degrees.set(d, (degrees.get(d) ?? 0) + 1); }
        expect([...degrees.entries()].sort((a, b) => a[0] - b[0])).toEqual([[5, 12], [6, HEMI_NODES - 12]]);
      }
    });

    it("is wound outward on every surface of both hemispheres", () => {
      for (const s of ds.surfaces) {
        expect([s.name, signedVolume6(s.positions, ds.triangles, 0, 3 * HEMI_TRIANGLES) > 0]).toEqual([s.name, true]);
        expect([s.name, signedVolume6(s.positions, ds.triangles, 3 * HEMI_TRIANGLES) > 0]).toEqual([s.name, true]);
      }
    });

    it("has brain-sized anatomical surfaces with the left hemisphere on the left", () => {
      for (const name of ["pial", "white"]) {
        const pos = ds.surfaces.find((s) => s.name === name)!.positions;
        const left = computeBounds(pos, 0, HEMI_NODES), right = computeBounds(pos, HEMI_NODES, N), whole = computeBounds(pos);
        expect(left.center[0]).toBeLessThan(-20); // bundled data: -33.8 mm
        expect(right.center[0]).toBeGreaterThan(20); // +34.9 mm
        expect(whole.radius).toBeGreaterThan(70); // 91.5 mm: a human brain is about 17 cm long
        expect(whole.radius).toBeLessThan(120);
        // the hemispheres touch at the midline: anatomical surfaces are not moved apart
        let maxLeft = -Infinity, minRight = Infinity;
        for (let i = 0; i < HEMI_NODES; i++) maxLeft = Math.max(maxLeft, pos[3 * i]);
        for (let i = HEMI_NODES; i < N; i++) minRight = Math.min(minRight, pos[3 * i]);
        expect(Math.abs(minRight - maxLeft)).toBeLessThan(5);
      }
    });

    it("has a cortical ribbon of plausible thickness between the white and the pial surface", () => {
      const white = ds.surfaces.find((s) => s.name === "white")!.positions;
      const thickness = cortex.map((i) => Math.hypot(pial[3 * i] - white[3 * i], pial[3 * i + 1] - white[3 * i + 1], pial[3 * i + 2] - white[3 * i + 2]));
      expect(median(thickness)).toBeGreaterThan(1.5); // bundled data: 2.6 mm
      expect(median(thickness)).toBeLessThan(4);
      expect(share(thickness, (t) => t < 8)).toBe(1);
    });

    it("keeps inflated and spherical hemispheres 5 mm apart, and finds the sphere", () => {
      for (const name of ["inflated", "sphere"]) {
        const pos = ds.surfaces.find((s) => s.name === name)!.positions;
        let maxLeft = -Infinity, minRight = Infinity;
        for (let i = 0; i < HEMI_NODES; i++) maxLeft = Math.max(maxLeft, pos[3 * i]);
        for (let i = HEMI_NODES; i < N; i++) minRight = Math.min(minRight, pos[3 * i]);
        expect(minRight - maxLeft).toBeCloseTo(5, 3);
      }
      const sphere = findSphere(ds);
      expect(sphere).not.toBeNull();
      expect(ds.surfaces[sphere!.surface].name).toBe("sphere");
      expect(sphere!.centerL[0]).toBeLessThan(0);
      expect(sphere!.centerR[0]).toBeGreaterThan(0);
    });

    it("has sulcal depth and curvature overlays with both signs", () => {
      for (const o of ds.overlays) {
        let min = Infinity, max = -Infinity, finite = true;
        for (const v of o.data) { min = Math.min(min, v); max = Math.max(max, v); finite &&= Number.isFinite(v); }
        expect(finite).toBe(true);
        expect(min).toBeLessThan(0);
        expect(max).toBeGreaterThan(0);
        expect(Math.max(-min, max)).toBeLessThan(5); // FreeSurfer units: sulc within +-2, curv within +-0.5
      }
    });
  });

  // ------------------------------------------------------------ mask and matrix

  describe("mask and matrix", () => {
    it("the mask removes one medial patch per hemisphere (the medial wall)", () => {
      for (const [lo, hi] of [[0, HEMI_NODES], [HEMI_NODES, N]]) {
        const masked: number[] = [], kept: number[] = [];
        for (let i = lo; i < hi; i++) (ds.mask[i] ? kept : masked).push(i);
        // bundled data: 228 (left) and 222 (right) of 2562 nodes, i.e. 9 %
        expect(masked.length / HEMI_NODES).toBeGreaterThan(0.04);
        expect(masked.length / HEMI_NODES).toBeLessThan(0.16);
        expect(Array.from(ds.mask.subarray(lo, hi)).every((v) => v === 0 || v === 1)).toBe(true);
        // medial: close to the midline, where the other nodes are not (median |x| 10 mm against 33 mm)
        const absX = (nodes: number[]) => median(nodes.map((i) => Math.abs(pial[3 * i])));
        expect(absX(masked)).toBeLessThan(20);
        expect(absX(kept)).toBeGreaterThan(25);
        // one patch: the largest connected component holds nearly all masked nodes (221 of 228, 216 of 222)
        const seen = new Set<number>();
        let largest = 0;
        for (const start of masked) {
          if (seen.has(start)) continue;
          let size = 0;
          const queue = [start];
          seen.add(start);
          while (queue.length) {
            const a = queue.pop()!;
            size++;
            for (let p = topo.adjStart[a]; p < topo.adjStart[a + 1]; p++) {
              const b = topo.adj[p];
              if (!ds.mask[b] && !seen.has(b)) { seen.add(b); queue.push(b); }
            }
          }
          largest = Math.max(largest, size);
        }
        expect(largest / masked.length).toBeGreaterThan(0.9);
      }
    });

    it("rows and columns of masked nodes are entirely zero, every other node has data", () => {
      const { n, data } = ds.conn;
      let nonZeroInMasked = 0, emptyCortexRows = 0;
      for (let i = 0; i < n; i++) {
        let any = false;
        for (let j = 0; j < n; j++) {
          const v = data[i * n + j];
          if (v !== 0) {
            any = true;
            if (!ds.mask[i] || !ds.mask[j]) nonZeroInMasked++;
          }
        }
        if (ds.mask[i] && !any) emptyCortexRows++;
      }
      expect(nonZeroInMasked).toBe(0);
      expect(emptyCortexRows).toBe(0);
    });

    it("is symmetric with an empty diagonal", () => {
      const { n, data } = ds.conn;
      let asymmetric = 0, diagonal = 0;
      for (let i = 0; i < n; i++) {
        if (data[i * n + i] !== 0) diagonal++;
        for (let j = i + 1; j < n; j++) if (data[i * n + j] !== data[j * n + i]) asymmetric++;
      }
      expect(asymmetric).toBe(0);
      expect(diagonal).toBe(0); // the upper-triangle layout does not store the diagonal
    });

    it("holds correlations: all values within [-1, 1], mostly positive, strongest ones close to 1", () => {
      const { n, data, scale } = ds.conn;
      expect(ds.conn.maxAbs).toBeLessThanOrEqual(1);
      expect(ds.conn.maxAbs).toBeGreaterThan(0.8); // bundled data: 0.964 between neighbouring nodes
      let min = Infinity, max = -Infinity, negative = 0, sum = 0;
      for (const i of cortex) {
        for (const j of cortex) {
          if (i === j) continue;
          const v = data[i * n + j] * scale;
          if (v < min) min = v;
          if (v > max) max = v;
          if (v < 0) negative++;
          sum += v;
        }
      }
      const pairs = cortex.length * (cortex.length - 1);
      expect(max).toBeLessThanOrEqual(1);
      expect(min).toBeGreaterThanOrEqual(-1);
      expect(max).toBe(ds.conn.maxAbs); // the largest |value| is a positive correlation
      expect(min).toBeLessThan(0); // -0.36: there are anticorrelations, but they are weak ...
      expect(-min).toBeLessThan(0.7 * max);
      expect(negative / pairs).toBeLessThan(0.25); // ... and rare without global signal regression (4.6 %)
      expect(sum / pairs).toBeGreaterThan(0.05); // mean r 0.18
      expect(sum / pairs).toBeLessThan(0.4);
    });

    it("the loaded int16 matrix reproduces the stored values within half a storage step", async () => {
      const c = man.connectivity;
      const buf = await fileGetter(DEMO)(c.file);
      const raw = c.dtype === "int8" ? new Int8Array(buf) : c.dtype === "int16" ? new Int16Array(buf) : new Float32Array(buf);
      const stored = c.scale ?? 1;
      let worst = 0, k = 0;
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++, k++) worst = Math.max(worst, Math.abs(ds.conn.get(i, j) - raw[k] * stored));
      }
      expect(k).toBe(raw.length);
      expect(worst).toBeLessThanOrEqual(0.5 * ds.conn.scale + 1e-9);
      expect(ds.conn.maxAbs).toBeCloseTo(stored * Math.max(...Array.from(new Set(raw as unknown as number[]), Math.abs)), 9);
    });
  });

  // ------------------------------------------------------------ neuroscience regression checks

  describe("resting-state structure", () => {
    it("mean connectivity falls with distance over the first 40 mm of the pial surface", () => {
      // within a hemisphere, 5 mm bins. Bundled data: 0.82 0.66 0.46 0.35 0.29 0.25 0.23 0.21
      const BIN = 5, BINS = 8;
      const sum = new Float64Array(BINS), count = new Float64Array(BINS);
      for (const i of cortex) {
        for (const j of cortex) {
          if (j === i || (i < HEMI_NODES) !== (j < HEMI_NODES)) continue;
          const b = Math.floor(dist(i, j) / BIN);
          if (b < BINS) { sum[b] += ds.conn.get(i, j); count[b]++; }
        }
      }
      const mean = Array.from(sum, (s, b) => s / count[b]);
      expect(Math.min(...count)).toBeGreaterThan(1000);
      for (let b = 1; b < BINS; b++) expect(mean[b]).toBeLessThan(mean[b - 1]);
      expect(mean[0]).toBeGreaterThan(0.6); // neighbouring nodes are strongly correlated
      expect(mean[0]).toBeGreaterThan(2 * mean[BINS - 1]);
      expect(mean[BINS - 1]).toBeGreaterThan(0); // and at 4 cm the average is still positive
    });

    it("node i and node i + leftNodes sit at the same place of their spheres, which is NOT the homotopic place", () => {
      // FreeSurfer uses one icosphere for both hemispheres of fsaverage: the same index is the same sphere
      // position, i.e. a lateral node on the left is a medial node on the right. Homotopic nodes have to be
      // looked up geometrically (below).
      const sphere = ds.surfaces.find((s) => s.name === "sphere")!.positions;
      const info = findSphere(ds)!;
      let worst = 0;
      for (let i = 0; i < HEMI_NODES; i++) {
        for (let k = 0; k < 3; k++) {
          worst = Math.max(worst, Math.abs(sphere[3 * i + k] - info.centerL[k] - (sphere[3 * (i + HEMI_NODES) + k] - info.centerR[k])));
        }
      }
      expect(worst).toBeLessThan(1e-3);
      const sameIndex: number[] = [], mirrored: number[] = [];
      for (const i of cortex) {
        if (i >= HEMI_NODES) break;
        if (ds.mask[i + HEMI_NODES]) sameIndex.push(ds.conn.get(i, i + HEMI_NODES));
        mirrored.push(ds.conn.get(i, homotopic[i]));
      }
      expect(median(mirrored)).toBeGreaterThan(median(sameIndex) + 0.15); // 0.54 against 0.22
    });

    it("the geometric homotopic partner is a mirror image within a few millimetres", () => {
      const offsets = cortex.map((i) => {
        const h = homotopic[i];
        return Math.hypot(pial[3 * h] + pial[3 * i], pial[3 * h + 1] - pial[3 * i + 1], pial[3 * h + 2] - pial[3 * i + 2]);
      });
      expect(cortex.every((i) => homotopic[i] >= 0 && (homotopic[i] < HEMI_NODES) !== (i < HEMI_NODES))).toBe(true);
      expect(median(offsets)).toBeLessThan(5); // 2.6 mm; the mesh spacing is about 6 mm
      expect(Math.max(...offsets)).toBeLessThan(15); // 8.1 mm
    });

    it("homotopic nodes are strongly connected: far above the average connection between the hemispheres", () => {
      const homotopicR = cortex.map((i) => ds.conn.get(i, homotopic[i]));
      let sum = 0, count = 0;
      for (const i of cortex) {
        if (i >= HEMI_NODES) break;
        for (const j of cortex) if (j >= HEMI_NODES) { sum += ds.conn.get(i, j); count++; }
      }
      const meanBetween = sum / count; // 0.17
      expect(median(homotopicR)).toBeGreaterThan(0.35); // 0.54
      expect(median(homotopicR)).toBeGreaterThan(2 * meanBetween);
      expect(share(homotopicR, (r) => r > meanBetween)).toBeGreaterThan(0.9);
    });

    it("among long-range partners (> 40 mm) the homotopic node ranks in the top 5 % for most cortical nodes", () => {
      const MIN_DISTANCE = 40;
      const { n, data } = ds.conn;
      const rankFraction: number[] = [];
      for (const i of cortex) {
        const h = homotopic[i];
        if (dist(i, h) <= MIN_DISTANCE) continue; // medial nodes: the partner across the midline is not long-range
        const vh = data[i * n + h];
        let stronger = 0, total = 0;
        for (const j of cortex) {
          if (j === i || dist(i, j) <= MIN_DISTANCE) continue;
          total++;
          if (data[i * n + j] > vh) stronger++;
        }
        rankFraction.push(stronger / total);
      }
      // bundled data: 3191 of 4674 cortical nodes qualify; median rank 0.16 %; top 1 % for 80 %, top 5 % for 95 %
      expect(rankFraction.length).toBeGreaterThan(0.5 * cortex.length);
      expect(median(rankFraction)).toBeLessThan(0.01);
      expect(share(rankFraction, (f) => f < 0.05)).toBeGreaterThan(0.85);
      expect(share(rankFraction, (f) => f < 0.01)).toBeGreaterThan(0.6);
    });

    it("the strongest partner in the other hemisphere lies near the mirror position for most nodes", () => {
      const { n, data } = ds.conn;
      const offset: number[] = [];
      for (const i of cortex) {
        let best = -1, bestV = -Infinity;
        for (const j of cortex) {
          if ((j < HEMI_NODES) === (i < HEMI_NODES)) continue;
          if (data[i * n + j] > bestV) { bestV = data[i * n + j]; best = j; }
        }
        offset.push(Math.hypot(pial[3 * best] + pial[3 * i], pial[3 * best + 1] - pial[3 * i + 1], pial[3 * best + 2] - pial[3 * i + 2]));
      }
      // bundled data: median 6 mm, 95 % within 20 mm; a random node of the other hemisphere is 67 mm away on average
      expect(median(offset)).toBeLessThan(12);
      expect(share(offset, (d) => d < 20)).toBeGreaterThan(0.85);
    });
  });

  // ------------------------------------------------------------ builders on the real matrix

  describe("glyph builders at threshold 0.5, minimum length 20 mm", () => {
    const THRESHOLD = 0.5, MIN_LENGTH = 20;
    let filter: BuildFilter;
    /** directed connexels i -> j that are drawn: glyph node, r > threshold, longer than the minimum length */
    let bruteCount: number;
    let brutePerNode: Uint32Array;

    beforeAll(() => {
      filter = { glyphNodes: ds.mask, targets: null, sign: 0, threshold: THRESHOLD, maxThreshold: ds.conn.maxAbs };
      brutePerNode = new Uint32Array(ds.n);
      bruteCount = 0;
      for (const i of cortex) {
        for (let j = 0; j < ds.n; j++) {
          if (j === i) continue;
          if (passesStrict(ds.conn.get(i, j), THRESHOLD, ds.conn.maxAbs, 0) && dist(i, j) > MIN_LENGTH) { brutePerNode[i]++; bruteCount++; }
        }
      }
    });

    it("the number of connexels is in a plausible band", () => {
      // bundled data: 285 386 connexels, 1.3 % of the directed cortical pairs, 61 per node on average
      const pairs = cortex.length * (cortex.length - 1);
      expect(bruteCount / pairs).toBeGreaterThan(0.003);
      expect(bruteCount / pairs).toBeLessThan(0.05);
      expect(bruteCount % 2).toBe(0); // symmetric matrix, all cortical nodes are glyph nodes: both directions
      // most cortical nodes have at least one such connection, none more than a fifth of the cortex
      expect(share(cortex, (i) => brutePerNode[i] > 0)).toBeGreaterThan(0.6);
      expect(Math.max(...brutePerNode)).toBeLessThan(cortex.length / 5);
    });

    it("buildConnexels plus the display filter gives exactly the brute-force count", () => {
      const set = buildConnexels(ds.conn, filter);
      const u16 = new Uint16Array(set.data), i16 = new Int16Array(set.data);
      const perNode = new Uint32Array(ds.n);
      let shown = 0, sorted = true, wrongStart = 0;
      for (let k = 0; k < set.count; k++) {
        const i = u16[4 * k], j = u16[4 * k + 1], value = i16[4 * k + 2] * ds.conn.scale;
        if (k > 0 && (u16[4 * k - 4] > i || (u16[4 * k - 4] === i && u16[4 * k - 3] >= j))) sorted = false;
        if (!(k >= set.nodeStart[i] && k < set.nodeStart[i + 1])) wrongStart++;
        if (passesStrict(value, THRESHOLD, ds.conn.maxAbs, 0) && dist(i, j) > MIN_LENGTH) { perNode[i]++; shown++; }
      }
      expect(sorted).toBe(true);
      expect(wrongStart).toBe(0);
      expect(set.nodeStart[ds.n]).toBe(set.count);
      expect(set.count).toBeGreaterThanOrEqual(bruteCount); // the buffer also holds the short connexels
      expect(shown).toBe(bruteCount);
      let differing = 0;
      for (let i = 0; i < ds.n; i++) if (perNode[i] !== brutePerNode[i]) differing++;
      expect(differing).toBe(0);
    });

    it("computePieRanks counts the same connexels, node by node", () => {
      const lengthPos = pial;
      const set = buildConnexels(ds.conn, filter);
      for (const byValue of [false, true]) {
        const pie = sortForPies(set, ds.n, ds.surfaces[surfaceIndexByName(ds, ["sphere"])].positions, byValue);
        const r = computePieRanks(pie, set.nodeStart, ds.n, lengthPos, ds.conn.scale, { threshold: THRESHOLD, maxThreshold: ds.conn.maxAbs, minLength: MIN_LENGTH, sign: 0 });
        expect(r.visible).toBe(bruteCount);
        expect(r.maxCount).toBe(Math.max(...brutePerNode));
        let wrongTotals = 0, wrongRanks = 0;
        for (let i = 0; i < ds.n; i++) {
          let next = 0;
          for (let k = set.nodeStart[i]; k < set.nodeStart[i + 1]; k++) {
            if (r.ranks[2 * k + 1] !== brutePerNode[i]) wrongTotals++;
            if (r.ranks[2 * k] !== 0xffff && r.ranks[2 * k] !== next++) wrongRanks++;
          }
          if (next !== brutePerNode[i]) wrongRanks++;
        }
        expect(wrongTotals).toBe(0);
        expect(wrongRanks).toBe(0);
      }
    });

    it("the histogram and the connexel budget agree with the builder on the real matrix", () => {
      const cum = ds.conn.cumulativeHistogram(ds.mask, 0);
      const count = (threshold: number) => buildConnexels(ds.conn, { ...filter, threshold }).count;
      const b = Math.floor((THRESHOLD / ds.conn.maxAbs) * HIST_BINS);
      expect(cum[b]).toBe(count((b / HIST_BINS) * ds.conn.maxAbs));
      expect(cum[0]).toBe(count(0));
      expect(Math.round(fractionAbove(cum, ds.conn.maxAbs, THRESHOLD) * cum[0])).toBe(cum[b]);
      for (const budget of [50_000, 300_000, 2_000_000]) {
        const t = thresholdForBudget(cum, ds.conn.maxAbs, budget);
        const built = count(t);
        expect(built).toBeLessThanOrEqual(budget);
        const bin = Math.round((t / ds.conn.maxAbs) * HIST_BINS);
        if (bin > 1) expect(count(((bin - 1) / HIST_BINS) * ds.conn.maxAbs)).toBeGreaterThan(budget);
      }
    });

    it("createConnexels without a limit returns every unordered pair once", () => {
      const c = createConnexels(ds.conn, filter, pial, pial, MIN_LENGTH, 1e9);
      expect(c.truncated).toBe(false);
      // the builder keeps raw >= floor(threshold / scale); no stored value lies between that and the threshold
      expect(c.values.length).toBe(bruteCount / 2);
      let bad = 0;
      for (let k = 0; k < c.values.length; k++) {
        const i = c.pairs[2 * k], j = c.pairs[2 * k + 1];
        if (!(i < j) || c.values[k] !== Math.fround(ds.conn.get(i, j)) || !(c.values[k] > THRESHOLD) || !(dist(i, j) > MIN_LENGTH)) bad++;
      }
      expect(bad).toBe(0);
      expect(new Set(Array.from({ length: c.values.length }, (_, k) => c.pairs[2 * k] * ds.n + c.pairs[2 * k + 1])).size).toBe(c.values.length);
    });

    it.each([1, 100, 1000, 20000])("createConnexels with a limit of %i returns exactly the strongest pairs", (limit) => {
      // reference: every qualifying unordered pair, strongest first
      const all: { i: number; j: number; raw: number }[] = [];
      for (const i of cortex) {
        for (let j = i + 1; j < ds.n; j++) {
          const raw = ds.conn.data[i * ds.n + j];
          if (passesStrict(raw * ds.conn.scale, THRESHOLD, ds.conn.maxAbs, 0) && dist(i, j) > MIN_LENGTH) all.push({ i, j, raw });
        }
      }
      expect(all.length).toBe(bruteCount / 2);
      expect(all.length).toBeGreaterThan(limit);
      const byStrength = all.map((p) => p.raw).sort((a, b) => b - a);
      const cut = byStrength[limit - 1]; // weakest value that still gets in

      const c = createConnexels(ds.conn, filter, pial, pial, MIN_LENGTH, limit);
      expect(c.truncated).toBe(true);
      expect(c.values.length).toBe(limit);
      expect(c.pairs.length).toBe(2 * limit);
      expect(c.edges.length).toBe(6 * limit);
      // the same values as the `limit` strongest of the reference (ties at the cut may be resolved either way)
      const got = Array.from({ length: limit }, (_, k) => ds.conn.data[c.pairs[2 * k] * ds.n + c.pairs[2 * k + 1]]).sort((a, b) => b - a);
      expect(got).toEqual(byStrength.slice(0, limit));
      // every pair is a qualifying one, listed once, with its value and the coordinates of both ends
      const qualifying = new Set(all.map((p) => p.i * ds.n + p.j));
      const seen = new Set<number>();
      let bad = 0;
      for (let k = 0; k < limit; k++) {
        const i = c.pairs[2 * k], j = c.pairs[2 * k + 1];
        const key = i * ds.n + j;
        if (!qualifying.has(key) || seen.has(key)) bad++;
        seen.add(key);
        if (c.values[k] !== Math.fround(ds.conn.get(i, j))) bad++;
        for (let q = 0; q < 3; q++) if (c.edges[6 * k + q] !== pial[3 * i + q] || c.edges[6 * k + 3 + q] !== pial[3 * j + q]) bad++;
      }
      expect(bad).toBe(0);
      // and every pair strictly stronger than the cut is in
      expect(all.filter((p) => p.raw > cut).every((p) => seen.has(p.i * ds.n + p.j))).toBe(true);
    });
  });

  // ------------------------------------------------------------ every loader layout, with real values

  describe("every loader layout round-trips a 324-node block of the real matrix", () => {
    // A real sub-mesh would need a triangulation of a node subset. Instead the mesh of the synthetic icoBrain(2)
    // (2 x 162 nodes) carries the real connectivity between the first 162 nodes of each hemisphere (fsaverage
    // meshes are nested icospheres, so these are spread over the whole cortex), with the real mask.
    let real: FixtureDataset;

    beforeAll(() => {
      const base = icoBrain(2);
      const m = base.hemiNodes;
      const node = (k: number) => (k < m ? k : HEMI_NODES + (k - m));
      const values = new Float32Array(base.n * base.n);
      const mask = new Uint8Array(base.n);
      for (let a = 0; a < base.n; a++) {
        mask[a] = ds.mask[node(a)];
        for (let b = 0; b < base.n; b++) values[a * base.n + b] = a === b ? 0 : ds.conn.get(node(a), node(b));
      }
      real = withValues(base, "realValues", values, mask);
    });

    const matrixError = (loaded: GlyphDataset): number => {
      let worst = 0;
      for (let k = 0; k < real.values.length; k++) worst = Math.max(worst, Math.abs(loaded.conn.data[k] * loaded.conn.scale - real.values[k]));
      return worst;
    };
    const expectSameMesh = (loaded: GlyphDataset, tolerance: number): void => {
      expect([loaded.n, loaded.leftNodes, loaded.leftTriangles]).toEqual([real.n, real.leftNodes, real.leftTriangles]);
      expect(loaded.surfaces.map((s) => s.name)).toEqual(real.surfaces.map((s) => s.name));
      loaded.surfaces.forEach((s, k) => {
        let worst = 0;
        for (let q = 0; q < s.positions.length; q++) worst = Math.max(worst, Math.abs(s.positions[q] - real.surfaces[k].positions[q]));
        expect(worst).toBeLessThanOrEqual(tolerance);
      });
      expect(canonicalTriangles(loaded.triangles)).toEqual(canonicalTriangles(real.triangles));
    };

    it("the block is real data: masked nodes, correlations, symmetric", () => {
      expect(real.n).toBe(324);
      const masked = Array.from(real.mask).filter((v) => v === 0).length;
      expect(masked).toBeGreaterThan(5); // 13 + 14 medial-wall nodes among the first 162 of each hemisphere
      expect(masked).toBeLessThan(80);
      expect(real.conn.maxAbs).toBeGreaterThan(0.5);
      expect(real.conn.maxAbs).toBeLessThanOrEqual(ds.conn.maxAbs + 1e-6);
      expect(real.conn.get(3, 200)).toBeCloseTo(ds.conn.get(3, HEMI_NODES + 38), 4);
    });

    it.each<[WebDtype, WebLayout]>([["int8", "upper"], ["int16", "upper"], ["float32", "upper"], ["int8", "full"], ["int16", "full"], ["float32", "full"]])(
      "web glyphset, %s %s", async (dtype, layout) => {
        const { dataset } = await loadFromFiles(toWebGlyphsetFiles(real, { dtype, layout }));
        expectSameMesh(dataset, 0);
        expect(Array.from(dataset.mask)).toEqual(Array.from(real.mask));
        expect(dataset.overlays.map((o) => o.name)).toEqual(["sulc"]);
        const requantise = (0.5 * real.conn.maxAbs) / 32767;
        const tolerance = dtype === "float32" ? requantise : 0.5 * webScale(real, { dtype, layout }) + requantise;
        expect(matrixError(dataset)).toBeLessThanOrEqual(tolerance + 1e-7);
      });

    it("original brainGL glyphset (.glyphset + .set + .asc + raw float32 matrix)", async () => {
      const { dataset, minThreshold } = await loadFromFiles(toBrainGLFiles(real, { minThreshold: 0.4 }));
      expect(minThreshold).toBe(0.4);
      expectSameMesh(dataset, 2e-5);
      expect(Array.from(dataset.conn.data)).toEqual(Array.from(real.conn.data));
      expect(Array.from(dataset.mask)).toEqual(Array.from(real.mask)); // derived from the empty rows
    });

    it.each<[LooseOptions["surfaces"], LooseOptions["matrix"], LooseOptions["overlays"]]>([
      ["gifti", "npy-f4", "gifti"], ["gifti-base64", "npy-f8", "1d"], ["gifti-ascii", "raw", "curv"], ["gifti-gzip-member", "npy-v2", "none"],
      ["freesurfer", "npy-f4-fortran", "curv"], ["freesurfer", "npy-f8-big-endian", "gifti"], ["asc", "npy-f8-fortran", "1d"],
    ])("loose files: surfaces as %s, matrix as %s, overlays as %s", async (surfaces, matrix, overlays) => {
      const { dataset } = await loadFromFiles(toLooseFiles(real, { surfaces, matrix, overlays }));
      expectSameMesh(dataset, surfaces === "asc" || surfaces === "gifti-ascii" ? 2e-5 : 0);
      expect(Array.from(dataset.conn.data)).toEqual(Array.from(real.conn.data));
      expect(Array.from(dataset.mask)).toEqual(Array.from(real.mask));
      expect(dataset.overlays.map((o) => o.name)).toEqual(overlays === "none" ? [] : ["sulc"]);
    });

    it("the builders see the same connexels whichever exact layout the data came from", async () => {
      const f = (d: GlyphDataset): BuildFilter => ({ glyphNodes: d.mask, targets: null, sign: 2, threshold: 0.3, maxThreshold: d.conn.maxAbs });
      const reference = buildConnexels(real.conn, f(real));
      expect(reference.count).toBeGreaterThan(1000);
      for (const files of [toBrainGLFiles(real), toLooseFiles(real, { surfaces: "freesurfer", matrix: "npy-f8" }), toWebGlyphsetFiles(real, { dtype: "float32", layout: "full" })]) {
        const { dataset } = await loadFromFiles(files);
        const set = buildConnexels(dataset.conn, f(dataset));
        expect(set.count).toBe(reference.count);
        expect(Buffer.from(set.data).equals(Buffer.from(reference.data))).toBe(true);
      }
    });
  });

  it("ConnMatrix.fromUpper of the stored triangle is what the loader built", async () => {
    const c = man.connectivity;
    const buf = await fileGetter(DEMO)(c.file);
    const raw = c.dtype === "int8" ? new Int8Array(buf) : c.dtype === "int16" ? new Int16Array(buf) : new Float32Array(buf);
    const again = ConnMatrix.fromUpper(raw, N, c.scale ?? 1);
    expect(again.scale).toBe(ds.conn.scale);
    expect(Buffer.from(again.data.buffer).equals(Buffer.from(ds.conn.data.buffer))).toBe(true);
  });
});

// --------------------------------------------------------------------- directionality demo sets

describe.skipIf(!existsSync(join(DIRECTIONALITY, "manifest.json")))("bundled directionality demo sets public/directionality", () => {
  const manifest = existsSync(join(DIRECTIONALITY, "manifest.json"))
    ? (JSON.parse(readFileSync(join(DIRECTIONALITY, "manifest.json"), "utf8")) as { datasets: string[] })
    : { datasets: [] };

  it("the manifest lists the four demo sets, each with its three files", () => {
    expect([...manifest.datasets].sort()).toEqual(["emb", "label18", "label200", "label34"]);
    for (const name of manifest.datasets) {
      for (const ext of ["ply", "labels", "labelorder"]) expect([name, ext, existsSync(join(DIRECTIONALITY, `${name}.${ext}`))]).toEqual([name, ext, true]);
    }
    // and no set lies around that the manifest does not list
    const onDisk = new Set(readdirSync(DIRECTIONALITY).filter((f) => f.endsWith(".ply")).map((f) => f.replace(/\.ply$/, "")));
    expect([...onDisk].sort()).toEqual([...manifest.datasets].sort());
  });

  describe.each(manifest.datasets)("%s", (name) => {
    const read = (ext: string) => readFileSync(join(DIRECTIONALITY, `${name}.${ext}`), "utf8");

    it("mesh, labels and label order agree", () => {
      const mesh = parsePly(read("ply"));
      const labels = parseLabels(read("labels"));
      const order = parseLabelOrder(read("labelorder"));
      const nVerts = mesh.vertices.length / 3;

      // one label per vertex
      expect(nVerts).toBe(32492); // one hemisphere of the 32k fs_LR mesh
      expect(labels.length).toBe(nVerts);
      if (mesh.colors) expect(mesh.colors.length).toBe(3 * nVerts);
      if (mesh.normals) expect(mesh.normals.length).toBe(3 * nVerts);
      expect(mesh.vertices.every((v) => Number.isFinite(v))).toBe(true);

      // a closed triangle mesh that uses every vertex
      expect(mesh.indices.length % 3).toBe(0);
      const nTris = mesh.indices.length / 3;
      const used = new Uint8Array(nVerts);
      let outOfRange = 0;
      for (const i of mesh.indices) { if (i >= nVerts) outOfRange++; else used[i] = 1; }
      expect(outOfRange).toBe(0);
      expect(used.every((u) => u === 1)).toBe(true);
      expect(nVerts - (3 * nTris) / 2 + nTris).toBe(2); // V - E + F = 2 with E = 3F / 2
      expect(buildTopology(nVerts, mesh.indices).edges.length / 2).toBe((3 * nTris) / 2);

      // labels: 0 = unlabelled (medial wall), every other label is listed exactly once in the label order
      const present = new Set(labels);
      expect(Math.min(...present)).toBe(0);
      expect(new Set(order).size).toBe(order.length);
      expect(order.includes(0)).toBe(false);
      expect([...present].filter((l) => l !== 0).sort((a, b) => a - b)).toEqual([...order].sort((a, b) => a - b));
      expect(present.size - 1).toBe(order.length);
      const digits = /^label(\d+)$/.exec(name);
      if (digits) expect(order.length).toBe(Number(digits[1])); // label18, label34, label200: the number of regions
      // the unlabelled part is a minority (the medial wall: 8.6 % of the vertices)
      const unlabelled = labels.filter((l) => l === 0).length / nVerts;
      expect(unlabelled).toBeGreaterThan(0.02);
      expect(unlabelled).toBeLessThan(0.2);
    });
  });
});
