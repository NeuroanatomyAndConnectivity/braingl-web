precision highp float;
precision highp int;
precision highp sampler2D;
precision highp isampler2D;

#define PI 3.14159265358979

uniform mat4 u_view;
uniform mat4 u_proj;

// Per-node positions of four independently selectable spatial representations
// (brainGL: D_SURFACE, D_SURFACE_GLYPH_GEOMETRY, D_SURFACE_GLYPH_COLOR; the
// surface for the minimum-length test comes from vidview's "minlsource").
uniform sampler2D u_posDisplay;
uniform sampler2D u_posGlyph;
uniform sampler2D u_posColor;
uniform sampler2D u_posLength;
uniform sampler2D u_posSphere;
uniform vec3 u_sphereCenterL;
uniform vec3 u_sphereCenterR;
uniform uint u_leftNodes;      // 0 = mesh is not split into hemispheres

uniform int u_geometryMode;    // 0 = scaled copy of the glyph-geometry surface, 1 = polar projection of the sphere
uniform mat3 u_glyphRot;       // user rotation of every glyph
uniform float u_radius;        // glyph scale ("glyph radius" in brainGL)
uniform float u_depthOffset;   // mm: glyphs are lifted toward the viewer so they are not buried in the folded surface
uniform float u_primBias;      // extra lift of points/lines over anatomical background glyphs

uniform float u_valueScale;    // normalised int16 attribute -> connectivity value
uniform float u_threshold;
uniform float u_maxThreshold;
uniform float u_minLength;
uniform int u_sign;            // 0 = positive, 1 = negative, 2 = both

uniform int u_colorMode;       // 0 = orientation, 1 = value
uniform sampler2D u_lut;
uniform float u_cmin;
uniform float u_cmax;
uniform float u_alphaExp;      // 10 * (1 - glyph alpha), as in points.vs
uniform float u_alphaRef;      // |value| that is fully opaque: 1 for correlations (the raw r, as in points.vs), else the largest |value|

vec3 fetchPos(sampler2D t, uint id) {
  return texelFetch(t, ivec2(int(id & 1023u), int(id >> 10u)), 0).xyz;
}

bool passes(float v) {
  if (u_sign != 1 && v > u_threshold && v <= u_maxThreshold) return true;
  if (u_sign != 0 && v < -u_threshold && v >= -u_maxThreshold) return true;
  return false;
}

vec3 glyphCenter(vec3 world) {
  vec3 c = (u_view * vec4(world, 1.0)).xyz;
  c.z += u_depthOffset;
  return c;
}

// Azimuthal equidistant projection of the sphere around a node (the
// overdraw-free "projection" glyph of Boettger et al. 2013, eq. 2). Returns a
// position in a unit-height frame. With two hemispheres every glyph is a pair
// of small polar maps: the left disc holds the targets in the left hemisphere,
// the right disc those in the right hemisphere. The disc of the node's own
// hemisphere is centred on the node, the other one on its homotopic point, and
// each disc is oriented as its hemisphere appears in a lateral view.
vec2 polarOffset(uint i, uint j) {
  bool split = u_leftNodes > 0u;
  bool ri = split && i >= u_leftNodes;
  bool rj = split && j >= u_leftNodes;
  vec3 a = normalize(fetchPos(u_posSphere, i) - (ri ? u_sphereCenterR : u_sphereCenterL));
  vec3 b = normalize(fetchPos(u_posSphere, j) - (rj ? u_sphereCenterR : u_sphereCenterL));
  if (ri != rj) a.x = -a.x;
  vec3 up = vec3(0.0, 0.0, 1.0) - a * a.z;
  if (dot(up, up) < 1e-6) up = vec3(0.0, 1.0, 0.0) - a * a.y;
  up = normalize(up);
  vec3 right = cross(up, a);
  float c = clamp(dot(a, b), -1.0, 1.0);
  vec3 t = b - a * c;
  float tl = length(t);
  vec2 q = tl > 1e-6 ? vec2(dot(t, right), dot(t, up)) / tl * (acos(c) / PI) : vec2(0.0);
  if (!split) return q;
  return 0.5 * q + vec2(rj ? 0.5 : -0.5, 0.0);
}

// View-space position of the display primitive of connexel i -> j.
vec3 glyphPoint(uint i, uint j, vec3 centerView) {
  if (u_geometryMode == 1) {
    return centerView + vec3(polarOffset(i, j) * u_radius * 100.0, 0.0);
  }
  vec3 dg = fetchPos(u_posGlyph, j) - fetchPos(u_posGlyph, i);
  return centerView + mat3(u_view) * (u_glyphRot * (u_radius * dg));
}

// |normalised connection vector| -> rgb, the DTI convention (x red, y green, z blue).
vec3 orientationColor(vec3 dc) {
  float l = length(dc);
  return l > 0.0 ? abs(dc) / l : vec3(0.5);
}

vec4 glyphColor(vec3 orient, float value) {
  vec3 rgb = orient;
  if (u_colorMode == 1) {
    rgb = texture(u_lut, vec2(clamp((value - u_cmin) / (u_cmax - u_cmin), 0.0, 1.0), 0.5)).rgb;
  }
  float a = pow(clamp(abs(value) / u_alphaRef, 0.0, 1.0), u_alphaExp);
  return vec4(rgb, a);
}
