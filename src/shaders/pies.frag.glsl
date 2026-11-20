#version 300 es
precision highp float;

flat in vec4 v_color;
in vec2 v_local;
flat in float v_r;
out vec4 o_color;

void main() {
  // keeps the triangles that stand in for whole and half discs (one or two slices) round
  if (dot(v_local, v_local) > v_r * v_r * 1.0001) discard;
  o_color = v_color;
}
