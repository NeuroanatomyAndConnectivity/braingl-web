import { parsePly } from "../directionality/io/plyReader";
import { parseLabels } from "../directionality/io/labelReader";
import { parseLabelOrder } from "../directionality/io/labelOrderReader";
import { buildMeshAdjacency } from "../directionality/algorithms/meshAdjacency";
import { computeVertexNormals } from "../directionality/algorithms/computeNormals";
import { extractRegions } from "../directionality/algorithms/extractRegions";
import { buildVertexColors } from "../directionality/algorithms/regionColors";
import { rejectOverlappingArrows, sampleStreamlines } from "../directionality/algorithms/seedArrows";
import type { Layer } from "./ply";

/** The subset of the Directionality panel parameters that shapes the arrows. */
export interface ArrowParams {
  arrowScale: number;
  arrowHeight: number;
  arrowWidth: number;
  arrowBodyWidth: number;
  arrowHeadFrac: number;
  arrowDist: number;
  arrowDensity: number;
  arrowFlipDirection: boolean;
  arrowColorR: number;
  arrowColorG: number;
  arrowColorB: number;
  useLabelColors: boolean;
  showArrows: boolean;
}

export const defaultArrowParams: ArrowParams = {
  arrowScale: 0.008, arrowHeight: 1.3, arrowWidth: 0.9, arrowBodyWidth: 0.25, arrowHeadFrac: 0.25, arrowDist: 0.5,
  arrowDensity: 0.02, arrowFlipDirection: true, arrowColorR: 0, arrowColorG: 0, arrowColorB: 0, useLabelColors: false, showArrows: true,
};

/**
 * The Directionality scene as geometry: the parcellated surface and the
 * arrows as flat arrow-shaped polygons lying just above it. (The LIC streaks
 * are a screen-space effect and have no 3-D counterpart.) Uses the vendored
 * algorithms unchanged, with the same sampling as the on-screen straight
 * arrows.
 */
export function bakeDirectionality(plyText: string, labelsText: string, orderText: string, params: ArrowParams): Layer[] {
  const mesh = parsePly(plyText);
  const labels = parseLabels(labelsText);
  const order = parseLabelOrder(orderText);
  const nv = mesh.vertices.length / 3;
  if (labels.length !== nv) throw new Error(`mesh has ${nv} vertices but there are ${labels.length} labels`);
  let colors: Uint8Array;
  if (!params.useLabelColors && mesh.colors && mesh.colors.length === 3 * nv) {
    colors = new Uint8Array(4 * nv);
    for (let v = 0; v < nv; v++) { colors[4 * v] = mesh.colors[3 * v]; colors[4 * v + 1] = mesh.colors[3 * v + 1]; colors[4 * v + 2] = mesh.colors[3 * v + 2]; colors[4 * v + 3] = 255; }
  } else {
    colors = buildVertexColors(labels, order);
  }
  const layers: Layer[] = [{ name: "parcellated surface", kind: "mesh", positions: mesh.vertices, colors, triangles: mesh.indices, shading: "lit", smooth: true }];
  if (!params.showArrows) return layers;

  const normals = computeVertexNormals(mesh.vertices, mesh.indices);
  const adjacency = buildMeshAdjacency(mesh.indices, nv);
  const directions = extractRegions({ vertices: mesh.vertices, indices: mesh.indices, labels, labelOrder: order, adjacency, normals, switchDirection: true });

  let cx = 0, cy = 0, cz = 0;
  for (let v = 0; v < nv; v++) { cx += mesh.vertices[3 * v]; cy += mesh.vertices[3 * v + 1]; cz += mesh.vertices[3 * v + 2]; }
  cx /= nv; cy /= nv; cz /= nv;
  let r2 = 0;
  for (let v = 0; v < nv; v++) r2 = Math.max(r2, (mesh.vertices[3 * v] - cx) ** 2 + (mesh.vertices[3 * v + 1] - cy) ** 2 + (mesh.vertices[3 * v + 2] - cz) ** 2);
  const radius = Math.sqrt(r2);

  const length = 2.0 * params.arrowHeight * params.arrowScale * radius;
  const halfWidth = 0.5 * params.arrowWidth * params.arrowScale * radius;
  const lane = Math.max(radius * params.arrowDensity, Math.max(halfWidth * 1.5, length * 0.4));
  const samples = rejectOverlappingArrows(sampleStreamlines(mesh.vertices, adjacency, directions, normals, colors, length * 1.2, lane, 0.05), length, 1.0);
  const m = samples.positions.length / 3;
  const positions = new Float32Array(m * 7 * 3), acol = new Uint8Array(m * 7 * 4), triangles = new Uint32Array(m * 9);
  const lift = Math.max(0.02 * length, params.arrowDist * params.arrowScale * radius * 0.25);
  const body = halfWidth * params.arrowBodyWidth;
  const rgb = [params.arrowColorR * 255, params.arrowColorG * 255, params.arrowColorB * 255];
  for (let k = 0; k < m; k++) {
    const px = samples.positions[3 * k], py = samples.positions[3 * k + 1], pz = samples.positions[3 * k + 2];
    const nx = samples.normals[3 * k], ny = samples.normals[3 * k + 1], nz = samples.normals[3 * k + 2];
    let tx = samples.directions[3 * k], ty = samples.directions[3 * k + 1], tz = samples.directions[3 * k + 2];
    if (params.arrowFlipDirection) { tx = -tx; ty = -ty; tz = -tz; }
    const sx = ny * tz - nz * ty, sy = nz * tx - nx * tz, sz = nx * ty - ny * tx;
    // centred on the sample, like the on-screen quad
    const ox = px + nx * lift - tx * length * 0.5, oy = py + ny * lift - ty * length * 0.5, oz = pz + nz * lift - tz * length * 0.5;
    const neck = length * (1 - params.arrowHeadFrac);
    const pts: [number, number][] = [[0, -body], [0, body], [neck, body], [neck, -body], [neck, -halfWidth], [neck, halfWidth], [length, 0]];
    pts.forEach(([along, side], c) => {
      const v = 7 * k + c;
      positions[3 * v] = ox + tx * along + sx * side; positions[3 * v + 1] = oy + ty * along + sy * side; positions[3 * v + 2] = oz + tz * along + sz * side;
      acol[4 * v] = rgb[0]; acol[4 * v + 1] = rgb[1]; acol[4 * v + 2] = rgb[2]; acol[4 * v + 3] = 255;
    });
    const b = 7 * k;
    triangles.set([b, b + 3, b + 2, b, b + 2, b + 1, b + 4, b + 6, b + 5], 9 * k);
  }
  layers.push({ name: "arrows", kind: "mesh", positions, colors: acol, triangles, shading: "flat", smooth: false });
  return layers;
}
