# Glyph types

This page describes what every glyph style draws, the exact placement and colour
formulas as implemented in `src/shaders/*.glsl`, which parameters change it, and how it
relates to the original brainGL shaders (`points.vs`, `vectors.vs`, `pies.vs`,
`diffpoints.vs` and `littlebrainrenderer.cpp`). Parameter keys are those of
`src/glyphs/params.ts`; see [Parameters](parameters.md) for the panel controls.

## Common concepts

A **connexel** is one entry of the connectivity matrix: an ordered pair of nodes
(`i`, `j`) with a value `v` (see [Background](../explanation/background.md)). A glyph
shows the connectivity profile of node `i`: one primitive per connexel `(i, j)` that
passes the filters. All glyph styles use the same ingredients.

| Symbol | Meaning | Source |
|---|---|---|
| `i`, `j` | source node (where the glyph sits) and target node | connexel instance attributes `a_ij` |
| `v` | connection value, `a_v * u_valueScale` | `u_valueScale` is the largest representable absolute value of the matrix (`ConnMatrix.maxAbs`) |
| `D(n)` | position of node `n` on the **displayed** surface (`surface`) | `u_posDisplay` |
| `G(n)` | position of node `n` on the **glyph-geometry** surface (`glyphGeometry`) | `u_posGlyph` |
| `C(n)` | position of node `n` on the **glyph-colour** surface (`colorSurface`) | `u_posColor` |
| `L(n)` | position of node `n` on the **minimum-length** surface (`lengthSurface`) | `u_posLength` |
| `s` | glyph scale, `glyphRadius` | `u_radius` |
| `R` | user rotation of every glyph, built from `rotX`, `rotY`, `rotZ` (degrees, composed as Rx · Ry · Rz, so z is applied to a vector first) when `rotationEnabled` is on, otherwise the identity | `u_glyphRot` |
| `V` | 3x3 rotation part of the camera view matrix | `mat3(u_view)` |
| `lift` | `depthLift * glyphRadius * 100` (millimetres) | `u_depthOffset`, computed in `drawState` |

All positions are in millimetres in the coordinate system of the surface files.
Four independent surfaces can therefore be chosen (display, glyph geometry, glyph
colour, minimum length); they must share the node numbering. This is the same split
that brainGL makes with `D_SURFACE`, `D_SURFACE_GLYPH_GEOMETRY` and
`D_SURFACE_GLYPH_COLOR`. The surface for the minimum-length test has no brainGL
counterpart: brainGL measures the length on the displayed surface.

### Which connexels are drawn

A connexel is drawn when both conditions hold (`passes()` in `common.glsl`, and the
`distance(...)` test in each vertex shader):

- the value passes the threshold and sign filter:
  `sign != "−"` and `threshold < v <= maxThreshold`, or `sign != "+"` and
  `-maxThreshold <= v < -threshold`;
- the straight-line distance `|L(j) - L(i)|` is **greater than** `minLength` (mm).

The effective threshold is `max(threshold, buildThreshold)`. `buildThreshold` is the
smallest threshold at which the number of connexels fits the connexel budget
(`budgetM`, millions); connexels below it are never sent to the GPU. See
[Limits](limits.md#connexel-budget). Nodes without data (all-zero rows, or the `mask`
of a web glyphset) and, if chosen, nodes outside the selected hemisphere or outside the
painted region (`glyphNodes = "painted"`) get no glyph.

`BuildFilter.targets` (the second ROI of a `.glyphset` file, when given) additionally restricts the target nodes `j`
that are built into the buffers.

### Glyph centre and depth

The glyph of node `i` is centred on the node's position on the displayed surface,
moved toward the viewer in view space:

```
c = (view * D(i)).xyz ;  c.z += lift
```

`lift` keeps glyphs from being buried in a folded surface. When anatomical background
glyphs are on, every point or line is raised a little further, by
`primBias = 0.15 * lift + 0.2` mm; otherwise `primBias = 0`.

brainGL instead nudged the clip-space depth by `-0.00001 * u_scale`. The web port
expresses the lift in glyph radii so that it scales with the glyph size.

### Colour and transparency

`glyphColor` in `common.glsl` returns an RGBA colour:

- `glyphColorMode = 0` (orientation): `rgb = |d| / |d|` with `d = C(j) - C(i)`. The
  x, y and z components of the connection direction map to red, green and blue (the
  DTI convention); `rgb = (0.5, 0.5, 0.5)` if `d` is zero.
- `glyphColorMode = 1` (value): `rgb = LUT((v - cmin) / (cmax - cmin))`, clamped to
  0 to 1, where `LUT` is the selected [colour map](parameters.md#colour-maps).
- alpha `a = clamp(|v| / maxAbs, 0, 1) ^ (10 * (1 - glyphAlpha))`.

With `glyphAlpha = 1` the exponent is 0 and every glyph is opaque. Lower values make
weak connections fade, which is the transparency rule of brainGL's
`pow(a_value, 10*(1-u_beta))`. The fragment shader discards fragments with alpha below
0.004. Pie glyphs ignore `glyphAlpha` (alpha is forced to 1).

The surface used for colour matters: on the sphere the orientation vectors cover the
whole range of directions, so the colour variance is largest; on the pial surface
orientation is dominated by folding (see the tooltip of the Glyph colour control).

## Points

**One primitive:** one point per connexel `(i, j)`, placed where the target `j` lies
in a miniature copy of the glyph-geometry surface centred on node `i`. The glyph is a
small map of everything node `i` is connected to.

**Placement** (`points.vert.glsl`, `glyphPoint` in `common.glsl`), for a surface
glyph geometry:

```
g = c + V * ( R * ( s * (G(j) - G(i)) ) )
g.z += primBias
```

Parameters that change it: `surface`, `glyphGeometry`, `glyphRadius` (`s`),
`rotationEnabled`/`rotX`/`rotY`/`rotZ` (`R`), `depthLift`, `primSize` (point size in
CSS pixels times the device pixel ratio, capped by the GPU's maximum point size),
`roundPoints` (round points only when the size is at least 3 device pixels, otherwise
square), `glyphAlpha`, `glyphColorMode`, `colorSurface`, `threshold`, `maxThreshold`,
`sign`, `minLength`, `lengthSurface`, `budgetM`.

**Good for:** overdraw-free overview of the whole connectivity profile of every node
at once; identifying subtle shifts in connectivity between adjacent nodes, especially
with anatomical background glyphs (Böttger et al., 2014: "Point glyphs are more useful
for identifying subtle shifts in connectivity between adjacent regions").

**Original:** `points.vs` computes `p = a_position + rot_matrix * (radius * dg)` with
`dg` the offset in the glyph-geometry surface, then multiplies by the model-view-
projection matrix. The web version is the same placement; the differences are listed in
[Differences from brainGL](../explanation/differences-from-braingl.md). brainGL's
points were square; the port draws round points at sizes of 3 pixels and above.

## Vectors

**One primitive:** a line segment per connexel from the node centre to the point glyph
position. It emphasises long-range connections: a distant target gives a long line.

**Placement** (`vectors.vert.glsl`): with `p` the point position of the points style
and `c` the glyph centre, both raised by `primBias`, the segment is `c` to `p`. WebGL
has no wide lines, so each connexel is an instanced screen-space quad of
`primSize` device pixels width: the two end points are projected, the offset is
perpendicular to the projected segment, and `corner.x` selects the end (0 = node,
1 = far end), `corner.y` the side.

Parameters: the same as for points, with `primSize` as the line width. `roundPoints`
has no effect.

**Good for:** judging the presence or absence of a particular feature of an area's
connectivity profile; with orientation colour and a high minimum length it shows the
long-range structure (Böttger et al., 2014).

**Original:** `vectors.vs` receives two vertices per connexel. The first has
`a_flag > 0` and is placed at `a_position + rot_matrix * (radius * dg)`; the second
has `a_flag < 0` and is placed at `a_to`, which the loader fills with the node's own
position. The result is the same segment from the point glyph to the node.

## Pies

**One primitive:** a triangular slice of a pie chart per visible connexel. Each node
has one pie; every connexel that passes the filters contributes one slice of equal
angle, coloured by connection orientation (or value). The pie shows the *proportion*
of connections of different orientations, not where they end.

**Order of slices.** The connexels of each node are sorted once, on the CPU
(`sortForPies` in `builders.ts`), in descending order of the hue (HSV, 0 to 1,
achromatic = -1) of their orientation colour, or in descending value when
`glyphColorMode = 1`. The order depends only on the colour surface and colour mode, so
it survives threshold changes. For every threshold, minimum-length, sign or upper
threshold change a linear pass (`computePieRanks`) assigns to each connexel its rank
among the node's visible connexels (`a_rank.x`) and the node's visible total
(`a_rank.y`, called `count` below); hidden connexels get rank `0xFFFF` and are
discarded.

**Placement** (`pies.vert.glsl`). Let `count` be the node's visible connexel count,
`maxCount` the largest `count` over all nodes (`u_maxCount`), `rel = count / maxCount`,
`n` the pie normalisation (`normalization`, `u_normalization`) and `k` the slice's
rank. The centre is `c` (display position, lifted by `lift`) with additional depth
`c.z += 100 * s * (1 - rel) * 0.5 + primBias`, so small pies are drawn in front of
large ones. The radius in millimetres is

```
r = ( n * sqrt(rel) + (1 - n) ) * s * 100
```

With `n = 0` every pie has radius `100 s`; with `n = 1` the pie *area* is proportional
to the number of connections. The slice is the triangle (centre, A, B), with the two
outer corners offset in the **view plane** (so pies always face the viewer):

```
angle(m)  = (k + m) / count * 2 * PI,   m = 0 (start) or 1 (end)
offset(m) = r * ( sin angle(m), cos angle(m) )
```

The first slice starts at 12 o'clock and slices run clockwise. Pies always use the
displayed surface for position and ignore the glyph geometry, the rotation and the
polar projection (these controls are hidden when "pies" is selected).

Parameters: `normalization`, `glyphRadius`, `depthLift`, `glyphColorMode`,
`colorSurface`, `threshold`, `maxThreshold`, `sign`, `minLength`, `lengthSurface`,
`budgetM`, `cmin`/`cmax`/`colormap` in value mode. The status line counts visible
connexels ("shown") for pies.

**Good for:** a compact summary of the *distribution of connection orientations* per
node (Böttger et al., 2014: "After sorting the colors by their hue, the pie charts
emphasize the ratio of connections with different orientations"). The motor cortex, with
its strong left-right connectivity, appears red; the visual cortex red and blue.

**Original:** `pies.vs` uses `t = a_nth / a_cover * 2 * PI` and
`r = (normalization * sqrt(a_cover)/sqrt(u_maxNodeCount) + (1 - normalization)) * radius * 100`, which is
the same radius law. brainGL sorted and rebuilt the pie arrays (`makePies`, `qSort` by
hue descending) whenever the threshold changed; the port keeps the sort and recomputes
only the ranks, so thresholds stay live for pies.

## Difference glyphs (diffpoints)

**One primitive:** one point per *mesh edge* and target node `j`. The glyph sits at
the midpoint of the edge `(i1, i2)` and shows how different the connectivity of the two
endpoints is to `j`. Where neighbouring nodes have a similar profile nothing is drawn;
where the profile changes (a border between areas) points appear.

**Value** (`diff.vert.glsl`). With `r1 = v(i1, j)`, `r2 = v(i2, j)`:

```
if maxAbs <= 1.0001 (data are correlations, u_fisher = 1):
    diff = tanh( | atanh(clamp(r1)) - atanh(clamp(r2)) | )      clamp to ±0.999999
else:
    diff = | r1 - r2 |
```

That is the absolute difference in Fisher z, mapped back to the correlation scale.
A connexel is drawn if `threshold < diff <= maxThreshold` and the distance between the
mean of `L(i1)`, `L(i2)` and `L(j)` is greater than `minLength`. The sign setting only
acts when the data are built (see below); the displayed difference is always positive.

**Placement.** The centre is the midpoint of the edge on the displayed surface, lifted:
`c = view * (D(i1)+D(i2))/2`, `c.z += lift`. For a surface glyph geometry:

```
g = c + V * ( R * ( s * ( G(j) - (G(i1)+G(i2))/2 ) ) ),   g.z += primBias
```

For the polar projection the offset is the mean of the two polar offsets,
`(P(i1,j) + P(i2,j)) / 2`, scaled by `100 s` (see below). The colour uses the
direction `C(j) - (C(i1)+C(i2))/2`, and `diff` replaces `v` in the value colour map and
in the alpha rule.

**Building the data.** `buildDiffConnexels` produces 12-byte records `(i1, i2, j,
unused, r1, r2)` for all mesh edges whose two endpoints both carry a glyph. A target is
kept if **either** endpoint's value passes the build threshold, so that transitions from
a strong to a weak connection survive. The build threshold starts at
`max(0.5 * buildThreshold, 0.15 * maxAbs)` and is raised in steps of `0.025 * maxAbs`
until the count fits `budgetM` million. The status line reports it as "edge-target
pairs on GPU". For this style the `threshold` slider is the minimum *difference*.

**Good for:** locating borders between areas with different connectivity profiles
(Böttger et al., 2013; 2014: difference glyphs show differences between the connectivity
of neighbouring nodes).

**Original:** `diffpoints.vs` computes the same Fisher-z difference
(`diff = (exp(2 d) - 1) / (exp(2 d) + 1)`) and tests `diff > threshold` and the
minimum length. In brainGL `makeDiffPoints` keeps a target only when **both** endpoints
pass the threshold filter; the port keeps it when either does.

## Polar projection (glyph geometry "polar projection (sphere)")

Selecting `glyphGeometry = -1` replaces the miniature copy of a surface by a flat map of
the sphere. It is available when the dataset has a spherical surface, detected by
`findSphere` (`dataset.ts`): the first surface whose nodes lie at a constant distance
from their centroid, with a coefficient of variation below 2 % in each hemisphere. It
applies to points, vectors and difference glyphs; it is ignored for pies, is not
available for anatomical background glyphs, and disables the rotation controls.

**What it is.** An azimuthal equidistant projection of the sphere around the glyph's node
(equation 2 of Böttger et al., 2013): the target is placed at an angle around the node
equal to the direction on the sphere and at a distance proportional to the great-circle
angle. Nothing overlaps, because each target has a unique position; and because the map
is drawn in the view plane the glyph always faces the viewer.

**Formula** (`polarOffset` in `common.glsl`). Let `ctr(n)` be the centre of the node's
hemisphere (`u_sphereCenterL` or `u_sphereCenterR`, computed from the sphere surface),
and `S(n)` the node's position on the sphere surface.

```
a = normalize( S(i) - ctr(i) )          b = normalize( S(j) - ctr(j) )
if i and j are in different hemispheres:  a.x = -a.x       (mirror to the homotopic point)
up    = (0,0,1) - a * a.z                (superior, projected into the tangent plane;
                                          (0,1,0) - a * a.y if that is degenerate)
up    = normalize(up);   right = up x a
c     = clamp( a . b, -1, 1 )            t = b - a * c
q     = ( t . right, t . up ) / |t| * acos(c) / PI          (q = 0 if |t| is tiny)
```

`|q|` lies between 0 and 1: 0 for the node itself, 1 for the antipode. For a dataset
with two hemispheres (`leftNodes > 0`), every glyph is a pair of half-size discs:

```
offset = 0.5 * q + ( +0.5 if j is in the right hemisphere else -0.5 , 0 )
```

The left disc holds targets in the left hemisphere, the right disc those in the right
hemisphere; the disc of the node's own hemisphere is centred on the node and each disc
is oriented as its hemisphere appears in a lateral view. For a single hemisphere
`offset = q`. The point is then `g = c + ( offset * s * 100 , 0 )` in view space
(units: `s * 100` mm per unit), followed by `g.z += primBias`.

Parameters: `glyphGeometry = -1`, `glyphRadius` (disc size), `depthLift`, plus the
filters. The orientation colour still uses `colorSurface`.

**Original:** the polar projection is described in the 2013 paper but is not part of
brainGL's glyphset code; the web port adds it.

## Anatomical background glyphs ("little brains")

**One primitive:** a complete miniature copy of the glyph-geometry surface at a node. It
gives each glyph an anatomical frame so that a point can be read as "this part of the
brain" (Böttger et al., 2014). A copy is drawn at each node of the painted region (or at
the selected node if nothing is painted), at most `lbMax` of them, evenly sub-sampled
(`ensureLittleBrains` in `glyphApp.ts`). Only nodes that also carry a glyph are used.

**Placement** (`littlebrain.vert.glsl`): for every mesh vertex `v` (surface vertex
`a_pos`, taken from the glyph-geometry surface) of the instance at node `i`:

```
p = c + V * ( R * ( s * ( G(v) - G(i) ) ) ),    c as above (display position, lifted)
```

Normals are rotated by `V * R`. Because these are real meshes they are drawn before the
point/line glyphs, with the lift `primBias` keeping the primitives in front.

**Colour** (`lbColorMode`; fragment shader `littlebrain.frag.glsl`):

| Mode | Value | Base colour |
|---|---|---|
| per mesh | 0 | `surfaceColor` |
| vertex data (connectivity) | 1 | `surfaceColor` shaded by sulcal depth; vertices whose connection to the node passes the threshold, sign and upper threshold are coloured by the colour map |
| anatomy | 2 | `surfaceColor` shaded by sulcal depth only |

Sulcal shading is `mix(1, 0.55, smoothstep(-0.2, 0.2, sulc))` with `sulc` the
normalised `sulc` (or `curv`) overlay. Connectivity values come from a texture of raw
int16 rows, one row per instance (`u_rows`, vertex `gl_VertexID`, instance
`gl_InstanceID`), converted as `raw / 32767 * maxAbs`. The fragment colour is the base
or data colour times `0.35 + 0.65 * |n.z|`.

Little brains are only drawn for surface glyph geometries (not the polar projection)
and when the row texture fits the GPU's texture size limit for connectivity colouring
(see [Limits](limits.md)).

**Original:** `LittleBrainRenderer` is a `MeshRenderer` whose colour mode is forced to
"vertex data"; brainGL created one renderer and mesh per node
(`littleBrains[i]`, `littleMeshes[i]`) and exposes `D_LITTLE_BRAIN_VISIBILITY` and
`D_LITTLE_BRAINS_COLORMODE` ("per mesh", "mri", "per vertex", "vertex data"; default
"vertex data"). The port draws all copies in one instanced draw call.

## Summary of correspondences

| Style | brainGL shader | Placement relative to node | Visible test |
|---|---|---|---|
| points | `points.vs` | `s * R * (G(j) - G(i))` | `v > threshold` and distance > `minlength`, measured on D in brainGL and on L in the port |
| vectors | `vectors.vs` | line node to the point position | same |
| pies | `pies.vs` | view-plane slice of angle `2 pi / count` | same, evaluated as ranks |
| diffpoints | `diffpoints.vs` | edge midpoint plus `s * R * (G(j) - mean G(edge))` | `diff > threshold` |
| little brains | `LittleBrainRenderer` | whole `G` surface minus `G(i)`, scaled by `s` | selected nodes |
| polar | none | disc offset `q * s * 100` in the view plane | as points |
