import type { RoiRegions } from "../io/glyphsetFiles";

/** Labels are stored in a Uint8Array: label 0 is "unpainted", so at most 255 regions. */
export const MAX_LABELS = 255;

/**
 * Paint colours given to the second, third, ... region of a loaded ROI file (the first one gets the
 * current paint colour). Chosen to stand out from each other and from the grey surface.
 */
export const REGION_PALETTE: readonly string[] = [
  "#4e79a7", "#e15759", "#59a14f", "#b07aa1", "#76b7b2", "#edc948",
  "#ff9da7", "#9c755f", "#17becf", "#bcbd22", "#d62728", "#9467bd",
];

const norm = (c: string) => c.trim().toLowerCase();

/** A deterministic extra colour once the palette is used up (golden-angle hues). */
function extraColor(k: number): string {
  const h = (k * 137.508) % 360, s = 0.65, l = 0.55;
  const f = (n: number) => {
    const a = s * Math.min(l, 1 - l);
    const x = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(x - 3, 9 - x, 1));
    return Math.round(255 * v).toString(16).padStart(2, "0");
  };
  return "#" + f(0) + f(8) + f(4);
}

/**
 * Add the regions of a loaded ROI file to the painted labels, without changing the inputs.
 *
 * - A region that carries a colour (`.rgb` files) is painted in that colour; when a painted region
 *   already has that colour, the two merge (one colour is one region in the glyph workspace).
 * - The first region without a colour gets `paintColor` (merging with a painted region of that
 *   colour, as painting does); every further one gets the next colour of `palette` that is not yet
 *   in use, then generated colours.
 *
 * Nodes of the file overwrite their previous label; all other nodes keep theirs. Throws, before
 * anything is changed, when the result would need more than {@link MAX_LABELS} labels.
 */
export function assignRoiRegions(
  labels: Uint8Array, labelColors: readonly string[], roi: RoiRegions, paintColor: string,
  palette: readonly string[] = REGION_PALETTE,
): { labels: Uint8Array; labelColors: string[] } {
  const colors = labelColors.slice();
  const used = new Set(colors.map(norm));
  const take = (c: string): number => {
    const i = colors.findIndex((x) => norm(x) === norm(c));
    if (i >= 0) return i;
    if (colors.length >= MAX_LABELS) {
      throw new Error(`The file holds ${roi.regions.length} regions; with the ${labelColors.length} painted already that is more than the ${MAX_LABELS} regions the workspace can hold.`);
    }
    colors.push(c);
    used.add(norm(c));
    return colors.length - 1;
  };
  let first = true, next = 0, extra = 0;
  const fresh = (): string => {
    while (next < palette.length) {
      const c = palette[next++];
      if (!used.has(norm(c)) && norm(c) !== norm(paintColor)) return c;
    }
    for (;;) {
      const c = extraColor(extra++);
      if (!used.has(c) && c !== norm(paintColor)) return c;
    }
  };
  const map = roi.regions.map((r) => {
    if (r.color) return take(r.color) + 1;
    if (first) { first = false; return take(paintColor) + 1; }
    return take(fresh()) + 1;
  });
  const out = labels.slice();
  for (let i = 0; i < out.length && i < roi.labels.length; i++) {
    const k = roi.labels[i];
    if (k) out[i] = map[k - 1];
  }
  return { labels: out, labelColors: colors };
}
