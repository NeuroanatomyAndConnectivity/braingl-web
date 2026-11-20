#version 300 es
#include common

// Point glyphs: one point per connexel, g = p + s * (q_d - p_d)  (points.vs)
layout(location = 0) in uvec2 a_ij;
layout(location = 1) in float a_v;

uniform float u_pointSize;

flat out vec4 v_color;

void main() {
  uint i = a_ij.x, j = a_ij.y;
  float value = a_v * u_valueScale;
  if (!passes(value) || distance(fetchPos(u_posLength, i), fetchPos(u_posLength, j)) <= u_minLength) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec3 c = glyphCenter(fetchPos(u_posDisplay, i));
  vec3 p = glyphPoint(i, j, c);
  p.z += u_primBias;
  gl_Position = u_proj * vec4(p, 1.0);
  gl_PointSize = u_pointSize;
  v_color = glyphColor(orientationColor(fetchPos(u_posColor, j) - fetchPos(u_posColor, i)), value);
}
