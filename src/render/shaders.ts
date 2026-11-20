import common from "../shaders/common.glsl?raw";
import pointsVert from "../shaders/points.vert.glsl?raw";
import vectorsVert from "../shaders/vectors.vert.glsl?raw";
import piesVert from "../shaders/pies.vert.glsl?raw";
import diffVert from "../shaders/diff.vert.glsl?raw";
import primsFrag from "../shaders/prims.frag.glsl?raw";
import littleVert from "../shaders/littlebrain.vert.glsl?raw";
import littleFrag from "../shaders/littlebrain.frag.glsl?raw";
import surfaceVert from "../shaders/surface.vert.glsl?raw";
import surfaceFrag from "../shaders/surface.frag.glsl?raw";
import segmentsVert from "../shaders/segments.vert.glsl?raw";
import markerVert from "../shaders/marker.vert.glsl?raw";
import markerFrag from "../shaders/marker.frag.glsl?raw";

const inc = (src: string) => src.replace("#include common", common);

export const SHADERS = {
  points: [inc(pointsVert), primsFrag],
  vectors: [inc(vectorsVert), primsFrag],
  pies: [inc(piesVert), primsFrag],
  diff: [inc(diffVert), primsFrag],
  little: [inc(littleVert), littleFrag],
  surface: [surfaceVert, surfaceFrag],
  segments: [segmentsVert, primsFrag],
  marker: [markerVert, markerFrag],
} as const;
