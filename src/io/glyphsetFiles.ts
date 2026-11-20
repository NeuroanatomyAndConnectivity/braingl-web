/**
 * brainGL's own little text formats: `.glyphset`, `.set`, ROI files (`.1D`,
 * `.rgb`, node-id lists) and the matching writers.
 *
 * Ported from `Loader::loadGlyphset`, `Loader::loadSet`
 * (src/io/loader.cpp), `DatasetGlyphset::loadROI`
 * (src/data/datasets/datasetglyphset.cpp) and `Writer::save1D` / `saveRGB`
 * (src/io/writer.cpp).  Where the original splits on a single blank these
 * parsers accept any run of blanks or tabs, and CRLF line ends.
 */

export interface GlyphsetSpec {
  /** line 1: anatomical NIfTI name (brainGL skips it; kept for reference) */
  nifti: string;
  /** line 2: one or two `.set` file names (left, right hemisphere) */
  sets: string[];
  /** line 3, token 1: connectivity matrix file name (or http URL) */
  connectivity: string;
  /** line 3, token 2; 0.8 when absent */
  minThreshold: number;
  /** line 3, token 3; 1.0 when absent */
  maxThreshold: number;
  /** line 3, token 4 */
  roi: string | null;
  /** line 3, token 5 */
  roi2: string | null;
}

export interface SetEntry {
  file: string;
  /** translation added to every vertex of the surface */
  offset: [number, number, number];
}

function splitLines(text: string): string[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.split(/\r\n|\n|\r/);
}

function tokens(line: string): string[] {
  const t = line.trim();
  return t === "" ? [] : t.split(/\s+/);
}

/** An integer token (node id, region number). */
const INT = /^[+-]?\d+$/;

/** QString::toFloat(): the value, or 0 when the string is not a number. */
function qtToFloat(s: string): number {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^[+-]?inf$/i.test(s)) return s[0] === "-" ? -Infinity : Infinity;
  if (/^nan$/i.test(s)) return NaN;
  return 0;
}

/**
 * Parse a `.glyphset` file.  Exactly three lines, by position:
 *   1. anatomical NIfTI (unused)
 *   2. `left.set [right.set]`
 *   3. `connectivity [minThreshold [maxThreshold [roi [roi2]]]]`
 */
export function parseGlyphsetFile(text: string): GlyphsetSpec {
  const lines = splitLines(text);
  const nifti = (lines[0] ?? "").trim();

  const setNames = tokens(lines[1] ?? "");
  if (setNames.length === 0) {
    throw new Error("glyphset: line 2 must name one or two .set files");
  }
  // brainGL complains "only two hemispheres supported" and uses the first two.
  const sets = setNames.slice(0, 2);

  const t = tokens(lines[2] ?? "");
  if (t.length === 0) {
    throw new Error("glyphset: line 3 must name the connectivity file");
  }
  return {
    nifti,
    sets,
    connectivity: t[0],
    minThreshold: t.length > 1 ? qtToFloat(t[1]) : 0.8,
    maxThreshold: t.length > 2 ? qtToFloat(t[2]) : 1.0,
    roi: t.length > 3 ? t[3] : null,
    roi2: t.length > 4 ? t[4] : null,
  };
}

/**
 * Parse a `.set` file: one surface per line, `filename [x [y [z]]]`.  Lines
 * starting with `#` and blank lines are skipped.
 */
export function parseSetFile(text: string): SetEntry[] {
  const out: SetEntry[] = [];
  for (const line of splitLines(text)) {
    if (line.startsWith("#")) continue;
    const t = tokens(line);
    if (t.length === 0 || t[0].startsWith("#")) continue;
    out.push({
      file: t[0],
      offset: [
        t.length > 1 ? qtToFloat(t[1]) : 0,
        t.length > 2 ? qtToFloat(t[2]) : 0,
        t.length > 3 ? qtToFloat(t[3]) : 0,
      ],
    });
  }
  return out;
}

/** Whitespace-separated values of a text, skipping `#` comment lines. */
function numericTokens(text: string): string[] {
  if (text.indexOf("#") >= 0) {
    text = splitLines(text)
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
  }
  return tokens(text);
}

/**
 * Parse an ROI file into a 0/1 mask with one entry per vertex.
 *
 * - `*.1D`: one value per vertex; in the ROI when > 0.5.
 * - `*.rgb`: `r g b` per vertex; in the ROI when any channel is < 1.0 (not white).
 * - anything else: one line per ROI node, whose first token is the node id.
 *
 * A file that is too short leaves the remaining vertices outside the ROI.
 */
export function parseRoiFile(fileName: string, text: string, nVerts: number): Uint8Array {
  const mask = new Uint8Array(nVerts);
  const lower = fileName.toLowerCase();

  if (lower.endsWith(".1d")) {
    const t = numericTokens(text);
    const n = Math.min(nVerts, t.length);
    for (let i = 0; i < n; i++) {
      if (qtToFloat(t[i]) > 0.5) mask[i] = 1;
    }
  } else if (lower.endsWith(".rgb")) {
    const t = numericTokens(text);
    const n = Math.min(nVerts, Math.floor(t.length / 3));
    for (let i = 0; i < n; i++) {
      const r = qtToFloat(t[i * 3]);
      const g = qtToFloat(t[i * 3 + 1]);
      const b = qtToFloat(t[i * 3 + 2]);
      // if the colour is not white, the node is in the ROI
      if (r < 1.0 || g < 1.0 || b < 1.0) mask[i] = 1;
    }
  } else {
    for (const line of splitLines(text)) {
      const t = tokens(line);
      if (t.length === 0 || !INT.test(t[0])) continue;
      const id = parseInt(t[0], 10);
      if (id >= 0 && id < nVerts) mask[id] = 1;
    }
  }
  return mask;
}

/** Regions read from an ROI file by {@link parseRoiRegions}. */
export interface RoiRegions {
  /** per vertex: 0 outside every region, k + 1 inside `regions[k]` */
  labels: Uint32Array;
  /**
   * One entry per region that holds at least one vertex. `value` is the region number of a two-column
   * id list (null otherwise); `color` is the colour of an `.rgb` region as `#rrggbb` (null otherwise).
   */
  regions: { value: number | null; color: string | null }[];
}

/** More distinct colours than this in an `.rgb` file means a colour map, not painted regions. */
export const MAX_RGB_REGIONS = 255;

function hex2(v: number): string {
  return Math.round(255 * Math.min(1, Math.max(0, v))).toString(16).padStart(2, "0");
}

/**
 * Parse an ROI file into one or more regions (the "Load ROI…" button of the glyph workspace).
 * The files are read as by {@link parseRoiFile}; what differs is how many regions come out:
 *
 * - `*.1D`: one region (the vertices whose value is > 0.5).
 * - `*.rgb`: one region per distinct colour that is not white, in the order of first appearance, each
 *   carrying its colour (rounded to 8 bits per channel). With more than {@link MAX_RGB_REGIONS}
 *   distinct colours the file is taken for a colour map and gives a single region, as in brainGL.
 * - anything else, a list of node ids: when every id line has an integer second token (the
 *   `<node id> <region number>` lines that "Save labels" and brainGL's `exportColors` write), one
 *   region per distinct region number, in ascending order of the number; otherwise one region.
 *   A node listed twice keeps its last region.
 *
 * Ids outside the mesh are ignored, and a region without any vertex is dropped.
 */
export function parseRoiRegions(fileName: string, text: string, nVerts: number): RoiRegions {
  const lower = fileName.toLowerCase();
  const labels = new Uint32Array(nVerts);
  const single = (mask: Uint8Array): RoiRegions => {
    let any = false;
    for (let i = 0; i < nVerts; i++) if (mask[i]) { labels[i] = 1; any = true; }
    return { labels, regions: any ? [{ value: null, color: null }] : [] };
  };

  if (lower.endsWith(".1d")) return single(parseRoiFile(fileName, text, nVerts));

  if (lower.endsWith(".rgb")) {
    const t = numericTokens(text);
    const n = Math.min(nVerts, Math.floor(t.length / 3));
    const index = new Map<string, number>();
    const regions: RoiRegions["regions"] = [];
    for (let i = 0; i < n; i++) {
      const r = qtToFloat(t[i * 3]), g = qtToFloat(t[i * 3 + 1]), b = qtToFloat(t[i * 3 + 2]);
      if (!(r < 1.0 || g < 1.0 || b < 1.0)) continue; // white (or not a number): outside, as in parseRoiFile
      const color = "#" + hex2(r) + hex2(g) + hex2(b);
      let k = index.get(color);
      if (k === undefined) {
        k = regions.length;
        if (k >= MAX_RGB_REGIONS) return single(parseRoiFile(fileName, text, nVerts));
        index.set(color, k);
        regions.push({ value: null, color });
      }
      labels[i] = k + 1;
    }
    return { labels, regions };
  }

  const pairs: [number, number][] = [];
  let twoColumns = true;
  for (const line of splitLines(text)) {
    const t = tokens(line);
    if (t.length === 0 || !INT.test(t[0])) continue;
    const id = parseInt(t[0], 10);
    const hasValue = t.length > 1 && INT.test(t[1]);
    if (!hasValue) twoColumns = false;
    if (id >= 0 && id < nVerts) pairs.push([id, hasValue ? parseInt(t[1], 10) : 0]);
  }
  if (!twoColumns || pairs.length === 0) {
    const mask = new Uint8Array(nVerts);
    for (const [id] of pairs) mask[id] = 1;
    return single(mask);
  }
  const last = new Map<number, number>(); // node -> region number
  for (const [id, v] of pairs) last.set(id, v);
  const values = [...new Set(last.values())].sort((a, b) => a - b);
  const k = new Map(values.map((v, i) => [v, i + 1]));
  for (const [id, v] of last) labels[id] = k.get(v)!;
  return { labels, regions: values.map((value) => ({ value, color: null })) };
}

/**
 * Painted regions as text: one line `<node id> <region number>` per labelled node (0 = unlabelled
 * nodes are left out), the brainGL `.1D.roi` layout. {@link parseRoiRegions} reads it back.
 */
export function writeRoiLabels(labels: ArrayLike<number>): string {
  const lines: string[] = [];
  for (let i = 0; i < labels.length; i++) if (labels[i]) lines.push(`${i} ${labels[i]}`);
  return lines.length ? lines.join("\n") + "\n" : "";
}

/** `.1D` ROI: one `1` or `0` per vertex, one per line. */
export function writeRoi1D(mask: Uint8Array): string {
  const parts = new Array<string>(mask.length);
  for (let i = 0; i < mask.length; i++) parts[i] = mask[i] ? "1" : "0";
  return parts.length > 0 ? parts.join("\n") + "\n" : "";
}

/** Shortest text for a float at QTextStream's default 6 significant digits. */
function formatFloat(v: number): string {
  return String(Number(v.toPrecision(6)));
}

/** `.rgb` colour file: `r g b` per vertex (values 0..1), one vertex per line. */
export function writeRgb(colors: Float32Array): string {
  if (colors.length % 3 !== 0) {
    throw new Error(`writeRgb: colour array length ${colors.length} is not a multiple of 3`);
  }
  const n = colors.length / 3;
  const parts = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    parts[i] =
      formatFloat(colors[i * 3]) + " " + formatFloat(colors[i * 3 + 1]) + " " + formatFloat(colors[i * 3 + 2]);
  }
  return n > 0 ? parts.join("\n") + "\n" : "";
}
