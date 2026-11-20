/**
 * Dense node-by-node connectivity matrix.
 *
 * brainGL kept the matrix as float32 and copied every supra-threshold connexel
 * (13 floats each) to the GPU. Here the matrix is held once as scaled int16
 * (value = raw * scale), which halves memory and lets the same raw values be
 * uploaded as normalised vertex attributes.
 */
export const HIST_BINS = 2000; // same resolution as brainGL's CorrelationMatrix::makeHistogram

export class ConnMatrix {
  readonly n: number;
  readonly data: Int16Array; // row-major n*n
  /** value = raw * scale */
  readonly scale: number;

  constructor(n: number, data: Int16Array, scale: number) {
    if (data.length !== n * n) throw new Error(`matrix has ${data.length} entries, expected ${n}x${n}`);
    this.n = n;
    this.data = data;
    this.scale = scale;
  }

  /** Largest representable absolute value. */
  get maxAbs(): number {
    return 32767 * this.scale;
  }

  get(i: number, j: number): number {
    return this.data[i * this.n + j] * this.scale;
  }

  row(i: number, out: Float32Array): Float32Array {
    const { n, data, scale } = this;
    const o = i * n;
    for (let j = 0; j < n; j++) out[j] = data[o + j] * scale;
    return out;
  }

  rawRow(i: number): Int16Array {
    return this.data.subarray(i * this.n, (i + 1) * this.n);
  }

  /** Convert a threshold in value units to (fractional) raw int16 units. */
  toRaw(v: number): number {
    return v / this.scale;
  }

  private binTable: Uint16Array | null = null;

  /**
   * Histogram bin of every raw magnitude 0..32768. Bin b starts at the raw value
   * that buildConnexels() uses as its lower bound for the threshold
   * b / HIST_BINS * maxAbs, namely max(1, floor(threshold / scale)), computed
   * with the very same floating-point operations (floor(maxAbs / scale) is
   * 32766 for some scales). Magnitudes above the builders' upper bound
   * ceil(maxAbs / scale) go to the spare slot HIST_BINS + 1, which is not counted.
   */
  private bins(): Uint16Array {
    if (this.binTable) return this.binTable;
    const table = new Uint16Array(32769);
    const maxAbs = this.maxAbs, scale = this.scale;
    // first raw magnitude of bin b: the same expression as thresholdForBudget() followed by the builders' rawBounds()
    const first = (b: number): number => Math.max(1, Math.floor(((b / HIST_BINS) * maxAbs) / scale));
    let b = 0;
    let next = first(1);
    for (let a = 0; a <= 32768; a++) {
      while (b < HIST_BINS && next <= a) next = ++b < HIST_BINS ? first(b + 1) : Infinity;
      table[a] = b;
    }
    for (let a = Math.ceil(maxAbs / scale) + 1; a <= 32768; a++) table[a] = HIST_BINS + 1;
    this.binTable = table;
    return table;
  }

  /**
   * Cumulative histogram of |value| over the given rows: cum[b] is exactly the
   * number of connexels that buildConnexels() keeps for these glyph nodes (all
   * targets, no upper threshold) at the threshold b / HIST_BINS * maxAbs, i.e.
   * the off-diagonal entries with |raw| >= max(1, floor(threshold / scale)).
   * Used for the percentile slider and for fitting the connexel count to the
   * GPU budget.
   */
  cumulativeHistogram(rows: Uint8Array | null, sign: SignMode, lo = 0, hi = this.n): Float64Array {
    const { n, data } = this;
    const bin = this.bins();
    const hist = new Float64Array(HIST_BINS + 2);
    for (let i = lo; i < hi; i++) {
      if (rows && !rows[i]) continue;
      const o = i * n;
      for (let j = 0; j < n; j++) {
        const v = data[o + j];
        if (v === 0 || j === i) continue;
        if (v > 0) {
          if (sign === 1) continue;
          hist[bin[v]]++;
        } else {
          if (sign === 0) continue;
          hist[bin[-v]]++;
        }
      }
    }
    for (let b = HIST_BINS - 1; b >= 0; b--) hist[b] += hist[b + 1];
    return hist.subarray(0, HIST_BINS + 1);
  }

  // ------------------------------------------------------------ constructors

  /** From a full row-major float matrix (the original brainGL binary format, or .npy). */
  static fromFull(values: ArrayLike<number>, n: number, fortranOrder = false): ConnMatrix {
    if (values.length !== n * n) throw new Error(`matrix has ${values.length} entries, expected ${n}x${n} = ${n * n}`);
    let maxAbs = 0;
    for (let k = 0; k < values.length; k++) {
      const v = values[k];
      if (v === v && v !== Infinity && v !== -Infinity) {
        const a = v < 0 ? -v : v;
        if (a > maxAbs) maxAbs = a;
      }
    }
    if (maxAbs === 0) maxAbs = 1;
    const q = 32767 / maxAbs;
    const data = new Int16Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const v = values[fortranOrder ? j * n + i : i * n + j];
        data[i * n + j] = v === v && v !== Infinity && v !== -Infinity ? Math.round(v * q) : 0;
      }
    }
    return new ConnMatrix(n, data, maxAbs / 32767);
  }

  /** From the strict upper triangle (row-major, i < j) of a symmetric matrix, value = raw * scale. */
  static fromUpper(raw: ArrayLike<number>, n: number, scale: number): ConnMatrix {
    const expect = (n * (n - 1)) / 2;
    if (raw.length !== expect) throw new Error(`upper triangle has ${raw.length} entries, expected ${expect}`);
    let maxAbs = 0;
    for (let k = 0; k < raw.length; k++) {
      const v = raw[k];
      if (v === v && v !== Infinity && v !== -Infinity) {
        const a = v < 0 ? -v : v;
        if (a > maxAbs) maxAbs = a;
      }
    }
    if (maxAbs === 0) maxAbs = 1;
    const q = 32767 / maxAbs;
    const data = new Int16Array(n * n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++, k++) {
        const v = raw[k];
        const r = v === v && v !== Infinity && v !== -Infinity ? Math.round(v * q) : 0;
        data[i * n + j] = r;
        data[j * n + i] = r;
      }
    }
    return new ConnMatrix(n, data, (maxAbs * scale) / 32767);
  }

  /**
   * Stream a raw little-endian float32 square matrix from a File/Blob without
   * ever holding the whole float copy in memory (a 10k-node matrix is 420 MB as
   * float32).
   */
  static async fromFloat32Blob(blob: Blob, onProgress?: (f: number) => void): Promise<ConnMatrix> {
    const n = Math.round(Math.sqrt(blob.size / 4));
    if (n * n * 4 !== blob.size) throw new Error(`connectivity file is ${blob.size} bytes, which is not a square float32 matrix`);
    const rowsPerChunk = Math.max(1, Math.floor((32 << 20) / (4 * n)));
    // pass 1: range
    let maxAbs = 0;
    for (let r = 0; r < n; r += rowsPerChunk) {
      const f = new Float32Array(await blob.slice(r * n * 4, Math.min(n, r + rowsPerChunk) * n * 4).arrayBuffer());
      for (let k = 0; k < f.length; k++) {
        const v = f[k];
        if (v === v && v !== Infinity && v !== -Infinity) {
          const a = v < 0 ? -v : v;
          if (a > maxAbs) maxAbs = a;
        }
      }
      onProgress?.((0.5 * (r + rowsPerChunk)) / n);
    }
    if (maxAbs === 0) maxAbs = 1;
    const q = 32767 / maxAbs;
    const data = new Int16Array(n * n);
    for (let r = 0; r < n; r += rowsPerChunk) {
      const f = new Float32Array(await blob.slice(r * n * 4, Math.min(n, r + rowsPerChunk) * n * 4).arrayBuffer());
      const o = r * n;
      for (let k = 0; k < f.length; k++) {
        const v = f[k];
        data[o + k] = v === v && v !== Infinity && v !== -Infinity ? Math.round(v * q) : 0;
      }
      onProgress?.(0.5 + (0.5 * (r + rowsPerChunk)) / n);
    }
    return new ConnMatrix(n, data, maxAbs / 32767);
  }
}

/** 0 = positive only, 1 = negative only, 2 = both (brainGL's "+", "-", "+/-"). */
export type SignMode = 0 | 1 | 2;

/**
 * Smallest threshold on the histogram grid (b / HIST_BINS * maxAbs, b >= 1) at
 * which buildConnexels() keeps no more than `budget` connexels; maxAbs when
 * even the highest bin holds more. `cum` must come from cumulativeHistogram()
 * of the matrix whose maxAbs is passed.
 */
export function thresholdForBudget(cum: Float64Array, maxAbs: number, budget: number): number {
  for (let b = 1; b <= HIST_BINS; b++) {
    if (cum[b] <= budget) return (b / HIST_BINS) * maxAbs;
  }
  return maxAbs;
}

/** Histogram bin of a threshold; a threshold on the grid maps to its own bin whatever the rounding of t / maxAbs. */
function binOfThreshold(maxAbs: number, t: number): number {
  return Math.min(HIST_BINS, Math.max(0, Math.floor((t / maxAbs) * HIST_BINS + 1e-9)));
}

/** Fraction of connexels with |value| >= t (brainGL's percFromThresh). */
export function fractionAbove(cum: Float64Array, maxAbs: number, t: number): number {
  return cum[0] > 0 ? cum[binOfThreshold(maxAbs, t)] / cum[0] : 0;
}

/**
 * Lowest threshold on the histogram grid above which no more than the given
 * fraction of connexels lies (brainGL's threshFromPerc). Fed with
 * fractionAbove(t) it returns the bin of t, or the first bin with the same
 * count when the histogram is flat there.
 */
export function thresholdForFraction(cum: Float64Array, maxAbs: number, fraction: number): number {
  // fraction * cum[0] can land a few ulp below the integer count it was derived from
  const target = fraction * cum[0];
  const limit = target + 1e-12 * Math.max(1, target);
  for (let b = 0; b <= HIST_BINS; b++) {
    if (cum[b] <= limit) return (b / HIST_BINS) * maxAbs;
  }
  return maxAbs;
}
