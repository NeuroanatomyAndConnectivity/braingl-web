import { describe, it, expect } from "vitest";
import { ConnMatrix, fractionAbove, HIST_BINS, SignMode, thresholdForBudget, thresholdForFraction } from "./connMatrix";
import { ALL_FIXTURES, directed, FIXTURES, lcg, singleHemisphere } from "../testing/fixtures";
import { glyphNodesFor, passesStrict } from "../testing/reference";
import { f32Blob } from "../testing/serialise";

const SIGNS: SignMode[] = [0, 1, 2];

/** Deterministic dense matrix with entries in [-amplitude, amplitude]. */
function randomMatrix(n: number, amplitude: number, seed: number, symmetric: boolean): Float32Array {
  const rnd = lcg(seed);
  const m = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = symmetric ? i : 0; j < n; j++) {
      const v = (2 * rnd() - 1) * amplitude;
      m[i * n + j] = v;
      if (symmetric) m[j * n + i] = v;
    }
  }
  return m;
}

function upperOf(values: ArrayLike<number>, n: number): Float32Array {
  const out = new Float32Array((n * (n - 1)) / 2);
  let k = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out[k++] = values[i * n + j];
  return out;
}

describe("ConnMatrix basics", () => {
  const values = randomMatrix(7, 3, 1, false);
  const c = ConnMatrix.fromFull(values, 7);

  it("rejects data of the wrong length", () => {
    expect(() => new ConnMatrix(3, new Int16Array(8), 1)).toThrow(/expected 3x3/);
    expect(() => ConnMatrix.fromFull(new Float32Array(10), 3)).toThrow(/expected 3x3/);
    expect(() => ConnMatrix.fromUpper(new Float32Array(4), 3, 1)).toThrow(/expected 3/);
  });
  it("maxAbs is the largest |value| of the input", () => {
    let m = 0;
    for (const v of values) m = Math.max(m, Math.abs(v));
    expect(c.maxAbs).toBeCloseTo(m, 10);
    expect(c.scale).toBeCloseTo(m / 32767, 12);
  });
  it("get, row and rawRow agree", () => {
    const row = new Float32Array(7);
    for (let i = 0; i < 7; i++) {
      expect(c.row(i, row)).toBe(row);
      const raw = c.rawRow(i);
      expect(raw.length).toBe(7);
      for (let j = 0; j < 7; j++) {
        expect(c.get(i, j)).toBe(c.data[i * 7 + j] * c.scale);
        expect(row[j]).toBeCloseTo(c.get(i, j), 6);
        expect(raw[j]).toBe(c.data[i * 7 + j]);
      }
    }
  });
  it("toRaw inverts the scaling", () => {
    expect(c.toRaw(c.maxAbs)).toBeCloseTo(32767, 6);
    expect(c.toRaw(0)).toBe(0);
    expect(c.toRaw(-c.maxAbs / 2)).toBeCloseTo(-16383.5, 6);
  });
  it("an all-zero matrix gets a unit range instead of dividing by zero", () => {
    const z = ConnMatrix.fromFull(new Float32Array(9), 3);
    expect(z.maxAbs).toBeCloseTo(1, 12);
    expect(Array.from(z.data)).toEqual(new Array(9).fill(0));
    expect(ConnMatrix.fromUpper(new Float32Array(3), 3, 0.5).maxAbs).toBeCloseTo(0.5, 12);
  });
  it("reads Fortran-ordered input transposed", () => {
    const f = ConnMatrix.fromFull(values, 7, true);
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) expect(f.get(i, j)).toBe(c.get(j, i));
  });
  it("accepts float64 and plain arrays", () => {
    const d = ConnMatrix.fromFull(Float64Array.from(values), 7);
    const a = ConnMatrix.fromFull(Array.from(values), 7);
    expect(d.data).toEqual(c.data);
    expect(a.data).toEqual(c.data);
  });
});

describe("quantisation error", () => {
  it.each([1e-3, 0.02, 1, 5, 250, 1e4])("is at most half a step for a matrix of amplitude %f", (amplitude) => {
    const n = 40;
    const values = randomMatrix(n, amplitude, 11, false);
    const c = ConnMatrix.fromFull(values, n);
    const bound = (c.maxAbs / 32767) * 0.5 + c.maxAbs * 1e-7;
    let worst = 0;
    for (let k = 0; k < n * n; k++) worst = Math.max(worst, Math.abs(c.data[k] * c.scale - values[k]));
    expect(worst).toBeLessThanOrEqual(bound);
    expect(Math.max(...c.data.map((v) => Math.abs(v)))).toBe(32767); // the full int16 range is used
  });

  it.each(ALL_FIXTURES)("is at most half a step for $name", ({ make }) => {
    const ds = make();
    let worst = 0;
    for (let k = 0; k < ds.values.length; k++) worst = Math.max(worst, Math.abs(ds.conn.data[k] * ds.conn.scale - ds.values[k]));
    expect(worst).toBeLessThanOrEqual((ds.conn.maxAbs / 32767) * 0.5 + 1e-7 * ds.conn.maxAbs);
  });
});

describe("non-finite input", () => {
  const n = 4;
  const clean = [0, 0.5, -0.25, 0.1, 0.5, 0, 0.75, -0.3, -0.25, 0.75, 0, 0.2, 0.1, -0.3, 0.2, 0];
  const dirty = clean.slice();
  dirty[1] = NaN; dirty[4] = NaN; dirty[3] = Infinity; dirty[12] = Infinity; dirty[11] = -Infinity; dirty[14] = -Infinity;
  const expected = clean.slice();
  for (const k of [1, 4, 3, 12, 11, 14]) expected[k] = 0;

  it("fromFull maps NaN and +-Infinity to 0 and ignores them for the range", () => {
    const c = ConnMatrix.fromFull(dirty, n);
    expect(c.maxAbs).toBeCloseTo(0.75, 12);
    for (let k = 0; k < 16; k++) expect(c.data[k] * c.scale).toBeCloseTo(expected[k], 4);
    expect(Array.from(c.data).every(Number.isFinite)).toBe(true);
  });
  it("fromFloat32Blob maps NaN and +-Infinity to 0 and ignores them for the range", async () => {
    const c = await ConnMatrix.fromFloat32Blob(f32Blob(Float32Array.from(dirty)));
    expect(c.maxAbs).toBeCloseTo(0.75, 6);
    for (let k = 0; k < 16; k++) expect(c.data[k] * c.scale).toBeCloseTo(expected[k], 4);
  });
  it("fromUpper maps NaN to 0", () => {
    const c = ConnMatrix.fromUpper(Float32Array.from([NaN, -0.25, 0.1, 0.75, -0.3, 0.2]), n, 1);
    expect(c.maxAbs).toBeCloseTo(0.75, 6);
    expect(c.get(0, 1)).toBe(0);
    expect(c.get(1, 2)).toBeCloseTo(0.75, 4);
  });
  // Was a bug (fixed since): unlike fromFull, the range scan only skipped NaN, so one
  // +-Infinity in a float32 "upper" glyphset makes maxAbs infinite, every entry 0 and the scale Infinity
  // (get() then returns NaN).
  it("fromUpper maps +-Infinity to 0 and ignores it for the range", () => {
    const c = ConnMatrix.fromUpper(Float32Array.from([0.5, Infinity, 0.1, 0.75, -Infinity, 0.2]), n, 1);
    expect(c.maxAbs).toBeCloseTo(0.75, 6);
    expect(c.get(0, 2)).toBe(0);
    expect(c.get(1, 2)).toBeCloseTo(0.75, 4);
  });
});

describe.each(FIXTURES)("ConnMatrix constructors on $name", ({ make }) => {
  const ds = make();
  const n = ds.n;

  it("fromUpper agrees with fromFull of the matrix without its diagonal", () => {
    const noDiag = Float32Array.from(ds.values);
    for (let i = 0; i < n; i++) noDiag[i * n + i] = 0;
    const full = ConnMatrix.fromFull(noDiag, n);
    const upper = ConnMatrix.fromUpper(upperOf(ds.values, n), n, 1);
    expect(upper.scale).toBeCloseTo(full.scale, 15);
    expect(upper.data).toEqual(full.data);
  });

  it("fromUpper applies the file's scale to integer input", () => {
    const up = upperOf(ds.values, n);
    let maxAbs = 0;
    for (const v of up) maxAbs = Math.max(maxAbs, Math.abs(v));
    const scale = maxAbs / 127;
    const c = ConnMatrix.fromUpper(Int8Array.from(up, (v) => Math.round(v / scale)), n, scale);
    expect(c.maxAbs).toBeCloseTo(maxAbs, 6);
    let worst = 0, k = 0;
    for (let i = 0; i < n; i++) {
      expect(c.get(i, i)).toBe(0);
      for (let j = i + 1; j < n; j++, k++) {
        worst = Math.max(worst, Math.abs(c.get(i, j) - up[k]));
        expect(c.get(j, i)).toBe(c.get(i, j));
      }
    }
    expect(worst).toBeLessThanOrEqual(0.5 * scale + maxAbs / 32767);
  });

  it("fromFloat32Blob agrees exactly with fromFull and reports monotone progress", async () => {
    const progress: number[] = [];
    const c = await ConnMatrix.fromFloat32Blob(f32Blob(ds.values), (f) => progress.push(f));
    expect(c.n).toBe(n);
    expect(c.scale).toBe(ds.conn.scale);
    expect(c.data).toEqual(ds.conn.data);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    for (let k = 1; k < progress.length; k++) expect(progress[k]).toBeGreaterThanOrEqual(progress[k - 1]);
    expect(progress[progress.length - 1]).toBeGreaterThanOrEqual(1);
  });
});

describe("fromFloat32Blob", () => {
  it("keeps rows and columns apart for an asymmetric matrix", async () => {
    const ds = directed(singleHemisphere(1));
    const c = await ConnMatrix.fromFloat32Blob(f32Blob(ds.values));
    for (let i = 0; i < ds.n; i++) for (let j = 0; j < ds.n; j++) expect(c.get(i, j)).toBeCloseTo(ds.values[i * ds.n + j], 4);
  });
  it.each([3, 7, 12, 15, 1000])("rejects a file of %i bytes, which is not a square float32 matrix", async (size) => {
    await expect(ConnMatrix.fromFloat32Blob(new Blob([new Uint8Array(size)]))).rejects.toThrow(/not a square float32 matrix/);
  });
  it("reads a matrix that spans more than one 32 MB chunk identically to fromFull", async () => {
    // 2900^2 * 4 bytes = 33.6 MB > 32 MiB, so the last 8 rows come from a second chunk
    const n = 2900;
    expect(n * n * 4).toBeGreaterThan(32 << 20);
    const values = new Float32Array(n * n);
    const rnd = lcg(5);
    for (let k = 0; k < values.length; k++) values[k] = rnd() - 0.5;
    values[n * n - 3] = -2.5; // the largest |value| sits in the second chunk
    const fromBlob = await ConnMatrix.fromFloat32Blob(f32Blob(values));
    const fromFull = ConnMatrix.fromFull(values, n);
    expect(fromBlob.n).toBe(n);
    expect(fromBlob.maxAbs).toBeCloseTo(2.5, 12);
    expect(fromBlob.scale).toBe(fromFull.scale);
    let same = true;
    for (let k = 0; k < values.length && same; k++) same = fromBlob.data[k] === fromFull.data[k];
    expect(same).toBe(true);
    expect(fromBlob.data[n * n - 3]).toBe(-32767);
  }, 30000);
});

// ----------------------------------------------------------------- histogram

/** bin of a raw value as documented: |value| >= b / HIST_BINS * maxAbs */
const documentedBin = (raw: number) => Math.floor((Math.abs(raw) * HIST_BINS) / 32767);

function bruteCumulative(conn: ConnMatrix, rows: Uint8Array | null, sign: SignMode, bin: (raw: number) => number, lo = 0, hi = conn.n): Float64Array {
  const cum = new Float64Array(HIST_BINS + 2);
  for (let i = lo; i < hi; i++) {
    if (rows && !rows[i]) continue;
    for (let j = 0; j < conn.n; j++) {
      const raw = conn.data[i * conn.n + j];
      if (j === i || raw === 0) continue;
      if (raw > 0 ? sign === 1 : sign === 0) continue;
      const b = Math.min(HIST_BINS, bin(raw));
      for (let q = 0; q <= b; q++) cum[q]++;
    }
  }
  return cum;
}

describe.each(FIXTURES)("histogram of $name", ({ make }) => {
  const ds = make();
  const conn = ds.conn;
  const rowSets: [string, Uint8Array | null][] = [
    ["all rows", null],
    ["masked rows", glyphNodesFor(ds)],
    ["every third row", Uint8Array.from({ length: ds.n }, (_, i) => (i % 3 === 0 ? 1 : 0))],
  ];

  describe.each(rowSets)("%s", (_label, rows) => {
    it.each(SIGNS)("sign %i: cum[0] counts the non-zero off-diagonal entries of that sign", (sign) => {
      const cum = conn.cumulativeHistogram(rows, sign);
      let count = 0;
      for (let i = 0; i < ds.n; i++) {
        if (rows && !rows[i]) continue;
        for (let j = 0; j < ds.n; j++) {
          const v = conn.get(i, j);
          if (j !== i && v !== 0 && (sign === 2 || (sign === 0 ? v > 0 : v < 0))) count++;
        }
      }
      expect(cum.length).toBe(HIST_BINS + 1);
      expect(cum[0]).toBe(count);
    });

    it.each(SIGNS)("sign %i: is non-increasing and agrees with the documented definition within one bin", (sign) => {
      const cum = conn.cumulativeHistogram(rows, sign);
      const doc = bruteCumulative(conn, rows, sign, documentedBin);
      for (let b = 0; b <= HIST_BINS; b++) {
        if (b > 0) expect(cum[b]).toBeLessThanOrEqual(cum[b - 1]);
        expect(cum[b]).toBeLessThanOrEqual(doc[b]);
        expect(cum[b]).toBeGreaterThanOrEqual(doc[b + 1]);
      }
    });
  });

  it("restricting the row range splits the histogram additively", () => {
    const half = Math.floor(ds.n / 2);
    const whole = conn.cumulativeHistogram(null, 2);
    const a = conn.cumulativeHistogram(null, 2, 0, half), b = conn.cumulativeHistogram(null, 2, half, ds.n);
    for (let q = 0; q <= HIST_BINS; q++) expect(a[q] + b[q]).toBe(whole[q]);
  });

  it("positive and negative histograms add up to the two-sided one", () => {
    const [p, m, both] = SIGNS.map((s) => conn.cumulativeHistogram(null, s));
    for (let q = 0; q <= HIST_BINS; q++) expect(p[q] + m[q]).toBe(both[q]);
  });

  describe.each(SIGNS)("sign %i", (sign) => {
    const rows = glyphNodesFor(ds);
    const cum = conn.cumulativeHistogram(rows, sign);
    const strictCount = (t: number) => {
      let c = 0;
      for (let i = 0; i < ds.n; i++) {
        if (!rows[i]) continue;
        for (let j = 0; j < ds.n; j++) if (j !== i && passesStrict(conn.get(i, j), t, Infinity, sign)) c++;
      }
      return c;
    };
    const budgets = [0, 1, 10, 100, 1000, Math.floor(cum[0] / 2), cum[0], cum[0] * 2];

    it("thresholdForBudget is non-increasing in the budget and picks the first bin that fits", () => {
      let prev = Infinity;
      for (const budget of budgets.slice().sort((a, b) => a - b)) {
        const t = thresholdForBudget(cum, conn.maxAbs, budget);
        expect(t).toBeLessThanOrEqual(prev);
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThanOrEqual(conn.maxAbs);
        prev = t;
        const b = Math.round((t / conn.maxAbs) * HIST_BINS);
        expect(cum[b]).toBeLessThanOrEqual(budget);
        if (b > 1) expect(cum[b - 1]).toBeGreaterThan(budget);
      }
    });

    it("the connexels above thresholdForBudget fit the budget, within the entries of one histogram bin", () => {
      for (const budget of budgets) {
        const t = thresholdForBudget(cum, conn.maxAbs, budget);
        const b = Math.round((t / conn.maxAbs) * HIST_BINS);
        const slack = cum[b - 1] - cum[b];
        expect(strictCount(t)).toBeLessThanOrEqual(budget + slack);
      }
    });

    it("fractionAbove is 1 at zero, non-increasing, and matches a brute-force count within one bin", () => {
      if (cum[0] === 0) {
        expect(fractionAbove(cum, conn.maxAbs, 0.3)).toBe(0);
        return;
      }
      expect(fractionAbove(cum, conn.maxAbs, 0)).toBe(1);
      let prev = 1;
      const bin = conn.maxAbs / HIST_BINS;
      for (const f of [0.01, 0.05, 0.123, 0.35, 0.5, 0.613, 0.79, 0.9, 1, 1.5]) {
        const t = f * conn.maxAbs;
        const frac = fractionAbove(cum, conn.maxAbs, t);
        expect(frac).toBeLessThanOrEqual(prev);
        prev = frac;
        if (f < 1) {
          expect(frac).toBeLessThanOrEqual(strictCount(t - 2 * bin) / cum[0]);
          expect(frac).toBeGreaterThanOrEqual(strictCount(t + 2 * bin) / cum[0]);
        }
      }
      expect(fractionAbove(cum, conn.maxAbs, -1)).toBe(1);
    });

    it("thresholdForFraction is non-increasing and inverts fractionAbove within one bin", () => {
      if (cum[0] === 0) return;
      const bin = conn.maxAbs / HIST_BINS;
      let prev = Infinity;
      for (const fraction of [0, 0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const t = thresholdForFraction(cum, conn.maxAbs, fraction);
        expect(t).toBeLessThanOrEqual(prev);
        prev = t;
        // at the returned threshold no more than the requested fraction lies above ...
        expect(fractionAbove(cum, conn.maxAbs, t + 1e-9 * bin)).toBeLessThanOrEqual(fraction + 1e-12);
        // ... and one bin lower it would be more than requested
        if (t > bin / 2) expect(fractionAbove(cum, conn.maxAbs, t - 0.999 * bin)).toBeGreaterThan(fraction);
      }
      expect(thresholdForFraction(cum, conn.maxAbs, 1)).toBe(0);
      for (const f of [0.123, 0.35, 0.613, 0.79]) {
        const t = f * conn.maxAbs;
        // the fraction is padded by a few ulp: see the round-trip bug documented below
        const back = thresholdForFraction(cum, conn.maxAbs, fractionAbove(cum, conn.maxAbs, t) * (1 + 1e-12));
        expect(back).toBeLessThanOrEqual(t + 1e-9);
        expect(fractionAbove(cum, conn.maxAbs, back + 1e-9 * bin)).toBe(fractionAbove(cum, conn.maxAbs, t));
      }
    });
  });
});

describe("histogram of a hand-made matrix", () => {
  // off-diagonal values: 0.9 x2, 0.5 x2, -0.7 x2, 0.3 x2, 0.1 x2, 0.8 x2; diagonal 1
  const m = [1.0, 0.9, 0.5, -0.7, 0.9, 1.0, 0.3, 0.1, 0.5, 0.3, 1.0, 0.8, -0.7, 0.1, 0.8, 1.0];
  const conn = ConnMatrix.fromFull(m, 4);
  it.each<[SignMode, number, number]>([
    [2, 0.05, 12], [2, 0.2, 10], [2, 0.4, 8], [2, 0.6, 6], [2, 0.75, 4], [2, 0.85, 2], [2, 0.95, 0],
    [0, 0.05, 10], [0, 0.6, 4], [0, 0.85, 2],
    [1, 0.05, 2], [1, 0.6, 2], [1, 0.75, 0],
  ])("sign %i: %f -> %i entries above", (sign, t, count) => {
    const cum = conn.cumulativeHistogram(null, sign);
    expect(cum[Math.floor(t * HIST_BINS)]).toBe(count);
    expect(fractionAbove(cum, conn.maxAbs, t)).toBeCloseTo(count / cum[0], 12);
  });
  it("finds the threshold for a budget between two values", () => {
    const cum = conn.cumulativeHistogram(null, 2);
    const t = thresholdForBudget(cum, conn.maxAbs, 5); // the four strongest (0.9, 0.8) fit, the six strongest do not
    expect(t).toBeGreaterThanOrEqual(0.7);
    expect(t).toBeLessThanOrEqual(0.8);
    expect(thresholdForBudget(cum, conn.maxAbs, 12)).toBeCloseTo(1 / HIST_BINS, 12);
    expect(thresholdForFraction(cum, conn.maxAbs, 0.5)).toBeGreaterThan(0.5);
    expect(thresholdForFraction(cum, conn.maxAbs, 0.5)).toBeLessThanOrEqual(0.7 + 1 / HIST_BINS);
  });
});

describe("known weaknesses of the histogram helpers", () => {
  // BUG (src/data/connMatrix.ts, thresholdForFraction): `target = fraction * cum[0]` is computed in floating
  // point, so feeding back the fraction that fractionAbove() just returned can give a target a hair below the
  // integer count it came from (15 / 22 * 22 = 14.999999999999998). The bin is then skipped and the result
  // jumps to the next bin with fewer entries, however far away that is.
  it.fails("thresholdForFraction(fractionAbove(t)) does not land above t", () => {
    const cum = new Float64Array(HIST_BINS + 1);
    cum[0] = 22;
    cum.fill(15, 1, 1001); // 15 entries with |value| >= 0.5, 7 tiny ones
    cum.fill(3, 1001); //      3 entries reach the top of the range
    const fraction = fractionAbove(cum, 1, 0.25);
    expect(fraction).toBe(15 / 22);
    expect(thresholdForFraction(cum, 1, fraction)).toBeLessThanOrEqual(0.25); // returns 0.5005
  });

  // SURPRISING (src/data/connMatrix.ts, cumulativeHistogram / thresholdForBudget): the bins are 32768 / 2000 raw
  // units wide, but a bin index is converted back to a threshold with maxAbs (= 32767 raw units) / 2000. The
  // returned threshold is therefore slightly below the bin edge, and a few more connexels than the budget pass it.
  // Harmless for a budget of millions, but "count <= budget" does not hold exactly.
  it.fails("the number of connexels above thresholdForBudget never exceeds the budget", () => {
    const ds = FIXTURES[0].make();
    const conn = ds.conn;
    const cum = conn.cumulativeHistogram(null, 0);
    for (let b = 1; b <= HIST_BINS; b++) {
      const budget = cum[b];
      const t = thresholdForBudget(cum, conn.maxAbs, budget);
      let count = 0;
      for (let i = 0; i < ds.n; i++) for (let j = 0; j < ds.n; j++) if (i !== j && conn.get(i, j) > t) count++;
      expect(count).toBeLessThanOrEqual(budget); // e.g. 6 over at bin 232 of icoBrain(1)
    }
  });
});
