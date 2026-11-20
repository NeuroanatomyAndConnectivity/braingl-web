import type { SurfaceExport } from "../glyphs/glyphApp";
import { hexToRgb } from "../ui/panel";

/**
 * Turn what is on screen in the glyph workspace into the three text files the
 * Directionality workspace reads (.ply, .labels, .labelorder).
 *
 *  - "labels":  every painted region becomes a parcel, ordered as painted;
 *               unpainted nodes are ignored by the directionality field.
 *  - "scalars": the surface map (seed-based connectivity or an overlay such as
 *               a gradient) is cut into quantile bins ordered by value, so the
 *               LIC streamlines and arrows follow the map's gradient across
 *               the cortex.
 */
export interface DirectionalityInput {
  name: string;
  ply: string;
  labels: string;
  order: string;
  regions: number;
}

export function toDirectionality(s: SurfaceExport, source: "labels" | "scalars", lut: Uint8Array, bins = 12): DirectionalityInput {
  const n = s.positions.length / 3;
  const labels = new Int32Array(n);
  const rgb = new Uint8Array(3 * n).fill(190);
  let order: number[] = [];

  if (source === "labels") {
    const cols = s.labelColors.map(hexToRgb);
    const used = new Set<number>();
    for (let i = 0; i < n; i++) {
      const l = s.labels[i];
      labels[i] = l;
      if (l) {
        used.add(l);
        const c = cols[l - 1] ?? [0.8, 0.8, 0.8];
        rgb[3 * i] = c[0] * 255; rgb[3 * i + 1] = c[1] * 255; rgb[3 * i + 2] = c[2] * 255;
      }
    }
    order = [...used].sort((a, b) => a - b);
    if (order.length < 2) throw new Error("Paint at least two regions (two different paint colours) to derive a direction between them.");
  } else {
    const v = s.scalars;
    if (!v) throw new Error("There is no surface map to send: select a seed node or choose an overlay as the surface colour.");
    const valid: number[] = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(v[i]) && v[i] !== 0) valid.push(v[i]);
    if (valid.length < bins * 2) throw new Error("The surface map has too few non-zero values.");
    valid.sort((a, b) => a - b);
    const edges = Array.from({ length: bins - 1 }, (_, k) => valid[Math.floor(((k + 1) * valid.length) / bins)]);
    const lo = valid[Math.floor(valid.length * 0.02)], hi = valid[Math.floor(valid.length * 0.98)];
    for (let i = 0; i < n; i++) {
      const x = v[i];
      if (!Number.isFinite(x) || x === 0) continue; // e.g. medial wall
      let b = 0;
      while (b < edges.length && x > edges[b]) b++;
      labels[i] = b + 1;
      const t = Math.round(255 * Math.min(1, Math.max(0, (x - lo) / (hi - lo || 1))));
      rgb[3 * i] = lut[4 * t]; rgb[3 * i + 1] = lut[4 * t + 1]; rgb[3 * i + 2] = lut[4 * t + 2];
    }
    order = Array.from({ length: bins }, (_, k) => k + 1);
  }

  const nt = s.triangles.length / 3;
  const parts: string[] = [
    "ply", "format ascii 1.0", "comment exported by brainGL-web", `element vertex ${n}`,
    "property float x", "property float y", "property float z",
    "property uchar red", "property uchar green", "property uchar blue",
    `element face ${nt}`, "property list uchar int vertex_indices", "end_header",
  ];
  for (let i = 0; i < n; i++) {
    parts.push(`${s.positions[3 * i].toFixed(4)} ${s.positions[3 * i + 1].toFixed(4)} ${s.positions[3 * i + 2].toFixed(4)} ${rgb[3 * i]} ${rgb[3 * i + 1]} ${rgb[3 * i + 2]}`);
  }
  for (let t = 0; t < nt; t++) parts.push(`3 ${s.triangles[3 * t]} ${s.triangles[3 * t + 1]} ${s.triangles[3 * t + 2]}`);
  const tag = source === "labels" ? "regions" : s.scalarName || "map";
  return {
    name: `${s.name} — ${tag}`,
    ply: parts.join("\n") + "\n",
    labels: Array.from(labels).join("\n") + "\n",
    order: order.join("\n") + "\n",
    regions: order.length,
  };
}
