#version 300 es
precision highp float;

uniform mat4 u_view;
uniform mat4 u_proj;
uniform vec3 u_pos;
uniform float u_size;

void main() {
  gl_Position = u_proj * u_view * vec4(u_pos, 1.0);
  gl_Position.z = -gl_Position.w; // always in front
  gl_PointSize = u_size;
}
