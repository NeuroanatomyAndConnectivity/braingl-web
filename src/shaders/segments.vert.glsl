#version 300 es
precision highp float;

// Connexels and edge bundles: instanced screen-space quads per line segment.
layout(location = 0) in vec3 a_p0;
layout(location = 1) in vec3 a_p1;
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec2 a_corner;

uniform mat4 u_view;
uniform mat4 u_proj;
uniform float u_lineWidth;
uniform vec2 u_viewport;
uniform float u_alpha;

flat out vec4 v_color;

void main() {
  vec4 A = u_proj * u_view * vec4(a_p0, 1.0);
  vec4 B = u_proj * u_view * vec4(a_p1, 1.0);
  vec2 d = (B.xy / B.w - A.xy / A.w) * u_viewport;
  float l = length(d);
  vec2 nrm = l > 1e-5 ? vec2(-d.y, d.x) / l : vec2(0.0, 1.0);
  vec4 P = mix(A, B, a_corner.x);
  P.xy += nrm * a_corner.y * u_lineWidth / u_viewport * P.w;
  gl_Position = P;
  v_color = vec4(a_color.rgb, a_color.a * u_alpha);
}
