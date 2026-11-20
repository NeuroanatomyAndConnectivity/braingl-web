#version 300 es
#include common

// Vector glyphs: a line from the node to the point of the point glyph
// (vectors.vs). WebGL has no wide lines, so every connexel is an instanced
// screen-space quad.
layout(location = 0) in uvec2 a_ij;
layout(location = 1) in float a_v;
layout(location = 2) in vec2 a_corner; // x: 0 = node end, 1 = far end; y: -1 / +1 side

uniform float u_lineWidth;  // px
uniform vec2 u_viewport;    // px

flat out vec4 v_color;

void main() {
  uint i = a_ij.x, j = a_ij.y;
  float value = a_v * u_valueScale;
  if (!passes(value) || distance(fetchPos(u_posLength, i), fetchPos(u_posLength, j)) <= u_minLength) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 c = glyphCenter(fetchPos(u_posDisplay, i));
  vec3 p = glyphPoint(i, j, c);
  c.z += u_primBias;
  p.z += u_primBias;
  vec4 A = u_proj * vec4(c, 1.0);
  vec4 B = u_proj * vec4(p, 1.0);
  vec2 d = (B.xy / B.w - A.xy / A.w) * u_viewport;
  float l = length(d);
  vec2 nrm = l > 1e-5 ? vec2(-d.y, d.x) / l : vec2(0.0, 1.0);
  vec4 P = mix(A, B, a_corner.x);
  P.xy += nrm * a_corner.y * u_lineWidth / u_viewport * P.w;
  gl_Position = P;
  v_color = glyphColor(orientationColor(fetchPos(u_posColor, j) - fetchPos(u_posColor, i)), value);
}
