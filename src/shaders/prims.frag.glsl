#version 300 es
precision highp float;

flat in vec4 v_color;
uniform int u_roundPoints;
out vec4 o_color;

void main() {
  if (u_roundPoints == 1) {
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d, d) > 0.25) discard;
  }
  if (v_color.a < 0.004) discard;
  o_color = v_color;
}
