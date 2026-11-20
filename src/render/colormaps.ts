/**
 * Colour maps as 256-entry RGBA lookup tables. "grey", "rainbow", "rainbow 2"
 * and "blue white red" are brainGL's defaults; "green - red" is the
 * isoluminant opponent scale used for the figures of Boettger et al. 2014;
 * the rest are common modern choices.
 */
type Stop = [number, number, number, number]; // position, r, g, b (0..1)

const MAPS: Record<string, Stop[]> = {
  grey: [[0, 0, 0, 0], [1, 1, 1, 1]],
  rainbow: [[0, 0, 0, 1], [0.25, 0, 1, 1], [0.5, 0, 1, 0], [0.75, 1, 1, 0], [1, 1, 0, 0]],
  "rainbow 2": [[0, 0.5, 0, 1], [0.2, 0, 0, 1], [0.4, 0, 1, 1], [0.6, 0, 1, 0], [0.8, 1, 1, 0], [1, 1, 0, 0]],
  "blue white red": [[0, 0, 0, 1], [0.5, 1, 1, 1], [1, 1, 0, 0]],
  "green - red": [[0, 0.1, 0.62, 0.3], [0.5, 0.62, 0.62, 0.42], [1, 0.9, 0.3, 0.25]],
  "cool - warm": [[0, 0.23, 0.3, 0.75], [0.5, 0.87, 0.87, 0.87], [1, 0.71, 0.02, 0.15]],
  viridis: [[0, 0.267, 0.005, 0.329], [0.25, 0.229, 0.322, 0.546], [0.5, 0.128, 0.567, 0.551], [0.75, 0.369, 0.789, 0.383], [1, 0.993, 0.906, 0.144]],
  magma: [[0, 0.001, 0, 0.014], [0.25, 0.316, 0.072, 0.485], [0.5, 0.716, 0.215, 0.475], [0.75, 0.987, 0.536, 0.382], [1, 0.987, 0.991, 0.75]],
  hot: [[0, 0.04, 0, 0], [0.37, 1, 0, 0], [0.75, 1, 1, 0], [1, 1, 1, 1]],
  // the lab's gradient map: viridis running into yellow-orange-brown
  gradient: [[0, 0.283, 0.141, 0.458], [0.22, 0.212, 0.359, 0.552], [0.45, 0.129, 0.563, 0.551], [0.68, 0.36, 0.786, 0.388], [0.88, 0.955, 0.901, 0.118], [0.94, 0.996, 0.6, 0.16], [1, 0.4, 0.145, 0.024]],
};

export const COLORMAP_NAMES = Object.keys(MAPS);

export function colormapLut(name: string, reverse = false): Uint8Array {
  const stops = MAPS[name] ?? MAPS.grey;
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    let t = i / 255;
    if (reverse) t = 1 - t;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const a = stops[k], b = stops[k + 1];
    const u = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0] || 1)));
    out[4 * i] = Math.round(255 * (a[1] + (b[1] - a[1]) * u));
    out[4 * i + 1] = Math.round(255 * (a[2] + (b[2] - a[2]) * u));
    out[4 * i + 2] = Math.round(255 * (a[3] + (b[3] - a[3]) * u));
    out[4 * i + 3] = 255;
  }
  return out;
}

export function lutToCss(lut: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < 256; i += 15) parts.push(`rgb(${lut[4 * i]},${lut[4 * i + 1]},${lut[4 * i + 2]}) ${((i / 255) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${parts.join(", ")})`;
}
