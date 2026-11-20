#version 300 es
precision highp float;

in vec3 v_normal;
in vec3 v_base;
in vec4 v_data;
out vec4 o_color;

void main() {
  vec3 n = normalize(v_normal);
  float diffuse = abs(n.z);
  vec3 base = mix(v_base, v_data.rgb, step(0.5, v_data.a));
  o_color = vec4(base * (0.35 + 0.65 * diffuse), 1.0);
}
