#version 300 es
precision highp float;

layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in float a_scalar; // seed-based connectivity or overlay
layout(location = 3) in float a_sulc;
layout(location = 4) in vec4 a_paint;   // painted ROI / parcel colour, a = 0 where unpainted

uniform mat4 u_view;
uniform mat4 u_proj;

out vec3 v_normal;
out vec3 v_viewPos;
out float v_scalar;
out float v_sulc;
out vec4 v_paint;

void main() {
  vec4 vp = u_view * vec4(a_pos, 1.0);
  v_viewPos = vp.xyz;
  v_normal = mat3(u_view) * a_normal;
  v_scalar = a_scalar;
  v_sulc = a_sulc;
  v_paint = a_paint;
  gl_Position = u_proj * vp;
}
