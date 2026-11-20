#version 300 es
#include common

// Difference glyphs: one glyph in the middle of every mesh edge showing
// |z(r1) - z(r2)| of the two edge endpoints for every target (diffpoints.vs).
layout(location = 0) in uvec4 a_nodes; // i1, i2, j, unused
layout(location = 1) in vec2 a_vals;   // r1, r2 (normalised int16)

uniform float u_pointSize;
uniform int u_fisher; // 1 = values are correlations: compare after Fisher's r-to-z

flat out vec4 v_color;

void main() {
  uint i1 = a_nodes.x, i2 = a_nodes.y, j = a_nodes.z;
  vec2 v = a_vals * u_valueScale;
  float diff;
  if (u_fisher == 1) {
    vec2 z = atanh(clamp(v, -0.999999, 0.999999));
    diff = tanh(abs(z.x - z.y));
  } else {
    diff = abs(v.x - v.y);
  }
  vec3 midLen = 0.5 * (fetchPos(u_posLength, i1) + fetchPos(u_posLength, i2));
  if (!(diff > u_threshold && diff <= u_maxThreshold) || distance(midLen, fetchPos(u_posLength, j)) <= u_minLength) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec3 c = glyphCenter(0.5 * (fetchPos(u_posDisplay, i1) + fetchPos(u_posDisplay, i2)));
  vec3 p;
  if (u_geometryMode == 1) {
    p = c + vec3(0.5 * (polarOffset(i1, j) + polarOffset(i2, j)) * u_radius * 100.0, 0.0);
  } else {
    vec3 dg = fetchPos(u_posGlyph, j) - 0.5 * (fetchPos(u_posGlyph, i1) + fetchPos(u_posGlyph, i2));
    p = c + mat3(u_view) * (u_glyphRot * (u_radius * dg));
  }
  p.z += u_primBias;
  gl_Position = u_proj * vec4(p, 1.0);
  gl_PointSize = u_pointSize;
  vec3 dc = fetchPos(u_posColor, j) - 0.5 * (fetchPos(u_posColor, i1) + fetchPos(u_posColor, i2));
  v_color = glyphColor(orientationColor(dc), diff);
}
