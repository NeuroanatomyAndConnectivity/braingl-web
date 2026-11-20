#version 300 es
#include common

// Pie-chart glyphs: one triangular slice per connexel, sorted by hue (or
// value) on the CPU; the pies always face the viewer (pies.vs).
layout(location = 0) in uvec2 a_ij;
layout(location = 1) in float a_v;
layout(location = 2) in uvec2 a_rank;   // x: index among the node's visible connexels (a_nth), y: their number (a_cover)
layout(location = 3) in float a_corner; // 0 = centre, 1 = start of slice, 2 = end of slice

uniform float u_normalization; // 0 = constant radius, 1 = area proportional to the number of connections
uniform float u_maxCount;

flat out vec4 v_color;

void main() {
  if (a_rank.x == 65535u || a_rank.y == 0u) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  uint i = a_ij.x, j = a_ij.y;
  float value = a_v * u_valueScale;
  float count = float(a_rank.y);
  float rel = count / max(u_maxCount, 1.0);
  vec3 c = glyphCenter(fetchPos(u_posDisplay, i));
  float r = (u_normalization * sqrt(rel) + (1.0 - u_normalization)) * u_radius * 100.0;
  // smaller pies are drawn in front of larger ones
  c.z += u_radius * 100.0 * (1.0 - rel) * 0.5 + u_primBias;
  if (a_corner > 0.5) {
    float t = (float(a_rank.x) + a_corner - 1.0) / count * 2.0 * PI;
    c.xy += r * vec2(sin(t), cos(t));
  }
  gl_Position = u_proj * vec4(c, 1.0);
  vec4 col = glyphColor(orientationColor(fetchPos(u_posColor, j) - fetchPos(u_posColor, i)), value);
  v_color = vec4(col.rgb, 1.0);
}
