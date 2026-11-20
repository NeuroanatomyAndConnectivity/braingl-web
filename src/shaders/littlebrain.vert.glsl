#version 300 es
#include common

// Anatomical background glyphs ("little brains"): a complete miniature copy of
// the glyph-geometry surface at every selected node, optionally colour-mapped
// with that node's connectivity (LittleBrainRenderer).
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in float a_sulc;
layout(location = 3) in uint a_node; // per instance

uniform isampler2D u_rows;   // one row of raw connectivity per instance
uniform int u_hasRows;
uniform int u_lbColorMode;   // 0 = per mesh, 1 = vertex data (connectivity), 2 = sulcal shading only
uniform vec3 u_lbColor;

out vec3 v_normal;
out vec3 v_base;
out vec4 v_data; // rgb + weight

void main() {
  vec3 c = glyphCenter(fetchPos(u_posDisplay, a_node));
  vec3 gi = fetchPos(u_posGlyph, a_node);
  vec3 p = c + mat3(u_view) * (u_glyphRot * (u_radius * (a_pos - gi)));
  gl_Position = u_proj * vec4(p, 1.0);
  v_normal = mat3(u_view) * (u_glyphRot * a_normal);
  float shade = u_lbColorMode == 0 ? 1.0 : mix(1.0, 0.55, smoothstep(-0.2, 0.2, a_sulc));
  v_base = u_lbColor * shade;
  v_data = vec4(0.0);
  if (u_lbColorMode == 1 && u_hasRows == 1) {
    float value = float(texelFetch(u_rows, ivec2(gl_VertexID, gl_InstanceID), 0).r) / 32767.0 * u_valueScale;
    if (passes(value)) {
      v_data = vec4(texture(u_lut, vec2(clamp((value - u_cmin) / (u_cmax - u_cmin), 0.0, 1.0), 0.5)).rgb, 1.0);
    }
  }
}
