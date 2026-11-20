#version 300 es
precision highp float;

in vec3 v_normal;
in vec3 v_viewPos;
in float v_scalar;
in float v_sulc;
in vec4 v_paint;

uniform vec3 u_baseColor;
uniform int u_useSulc;       // shade the base colour by sulcal depth
uniform int u_showScalar;    // colour-map a_scalar ("vertex data" colour mode)
uniform sampler2D u_lut;
uniform float u_cmin;
uniform float u_cmax;
uniform float u_lower;       // |value| below this shows the base colour
uniform int u_showPaint;
uniform float u_alpha;
uniform float u_ambient;
uniform float u_diffuse;
uniform float u_specular;

out vec4 o_color;

void main() {
  vec3 base = u_baseColor;
  if (u_useSulc == 1) base *= mix(1.0, 0.55, smoothstep(-0.25, 0.25, v_sulc));
  if (u_showScalar == 1 && abs(v_scalar) >= u_lower) {
    base = texture(u_lut, vec2(clamp((v_scalar - u_cmin) / (u_cmax - u_cmin), 0.0, 1.0), 0.5)).rgb;
  }
  if (u_showPaint == 1) base = mix(base, v_paint.rgb, v_paint.a);
  vec3 n = normalize(v_normal);
  if (!gl_FrontFacing) n = -n;
  // headlight
  float nl = max(n.z, 0.0);
  vec3 h = normalize(vec3(0.0, 0.0, 1.0) + vec3(0.25, 0.35, 1.0));
  float spec = pow(max(dot(n, normalize(h)), 0.0), 48.0);
  vec3 col = base * (u_ambient + u_diffuse * nl) + vec3(u_specular * spec);
  o_color = vec4(col, u_alpha);
}
