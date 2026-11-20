#version 300 es
precision highp float;

uniform vec4 u_color;
out vec4 o_color;

// crosshair + ring, like brainGL's synchronised selection cursor
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  float ring = smoothstep(0.12, 0.0, abs(r - 0.55));
  float cross_ = (1.0 - smoothstep(0.02, 0.07, min(abs(p.x), abs(p.y)))) * step(0.25, r) * step(r, 1.0);
  float a = max(ring, cross_);
  float halo = max(smoothstep(0.24, 0.0, abs(r - 0.55)), (1.0 - smoothstep(0.06, 0.16, min(abs(p.x), abs(p.y)))) * step(0.2, r) * step(r, 1.0));
  if (halo < 0.02) discard;
  o_color = vec4(mix(vec3(0.0), u_color.rgb, a), max(a, halo * 0.6) * u_color.a);
}
