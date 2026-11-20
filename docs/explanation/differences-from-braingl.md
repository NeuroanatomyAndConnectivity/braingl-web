# Differences from brainGL

brainGL web is a port of the connectivity-glyph part of brainGL, not of the whole program. This
page compares the two feature by feature, based on reading both code bases (the original
`datasetglyphset.cpp`, the shaders `points.vs`, `vectors.vs`, `pies.vs`, `diffpoints.vs`,
`littlebrainrenderer.cpp`, `loader.cpp`, `correlationmatrix.cpp`, and this repository). Status:

- **Ported**: the same behaviour.
- **Changed**: the same purpose, implemented differently or with a different result.
- **Added**: not in brainGL's glyph code.
- **Not ported**: absent here.

Property names (`D_*`) are those of brainGL's `Fn::Property`. See [Parameters](../reference/parameters.md) for
the web controls.

## Glyph styles

| Feature | brainGL | brainGL web | Status | Reason |
|---|---|---|---|---|
| Points | `points.vs`, one point per connexel at `a_position + rot * (radius * dg)` | same placement, in view space | Ported | Core feature. |
| Round points | square GL points | round when the size is 3 device pixels or more | Changed | Easier to read at the point sizes used on screen. |
| Vectors | `vectors.vs`, two vertices per connexel: glyph point and node | one instanced screen-space quad per connexel from node to glyph point | Ported | Same geometry; WebGL has no wide lines. |
| Pies | `pies.vs`, slices sorted by hue, arrays rebuilt and re-sorted when the threshold changes | sorted once; ranks recomputed per threshold change | Changed | Thresholds stay live, with the same result. |
| Pie radius law | `(n*sqrt(a_cover)/sqrt(maxCount) + (1-n))*radius*100` | same | Ported | |
| Difference glyphs | `diffpoints.vs`, Fisher-z difference, target kept only if **both** edge endpoints pass the threshold | same difference; target kept if **either** endpoint passes | Changed | Keeps transitions from a strong to a weak connection, which is what the glyph is for. |
| Anatomical background glyphs | one `LittleBrainRenderer` and mesh per painted node, colour mode "vertex data" | one instanced draw call, row texture of raw values, three colour modes | Changed | Same picture, far less memory per glyph. |
| Polar projection of the sphere | described in the 2013 paper, never in the glyphset code | `glyphGeometry = -1` | Added | Overdraw-free map from the 2013 paper (equation 2). |
| Glyph geometry and colour surfaces | `D_SURFACE_GLYPH_GEOMETRY`, `D_SURFACE_GLYPH_COLOR` | `glyphGeometry`, `colorSurface` | Ported | |
| Glyph rotation | `D_GLYPH_ROTATION`, `D_GLYPH_ROT_X/Y/Z` | `rotationEnabled`, `rotX/Y/Z` | Ported | |
| Glyph alpha | `pow(value, 10*(1-D_GLYPH_ALPHA))` | `pow(abs(value)/maxAbs, 10*(1-glyphAlpha))` | Ported | The value is normalised by the matrix maximum. |
| Orientation and value colours | `D_GLYPH_COLORMODE` | `glyphColorMode` | Ported | |
| Depth offset | clip-space offset `-0.00001 * u_scale` | lift toward the viewer in glyph radii (`depthLift`) | Changed | Scales with the glyph size and works with the orthographic camera in millimetres. |
| Connection to itself | not excluded (a node's value with itself is drawn at the glyph centre) | excluded (`j != i`) | Changed | The diagonal carries no information. |
| Upper threshold test | `v < m_maxThreshold` | `v <= maxThreshold` | Changed | At the default (the matrix maximum) the strongest value is kept. |
| Glyph nodes | glyphs only at nodes in the ROI (initially none) | all nodes with data by default, or only painted nodes (`glyphNodes`) | Changed | Glyphs appear as soon as data are loaded; restricting to a painted region is still available. |

## Thresholds and data size

| Feature | brainGL | brainGL web | Status | Reason |
|---|---|---|---|---|
| Threshold, sign | `D_THRESHOLD`, `D_GLYPH_THRESHOLD_SIGN` | `threshold`, `sign` | Ported | |
| Minimum length | `D_MINLENGTH`, measured on the displayed surface | `minLength`, measured on a separately chosen surface | Changed | Taken from vidview, which has a separate source for the minimum-length test: the length can be measured on one surface (for example pial) while the glyphs sit on another (for example inflated). |
| Load-time minimum threshold | `m_minThreshold`, third token of `.glyphset`, default 0.8; everything below is dropped | automatic connexel budget (`budgetM`) | Changed | The limit is derived from the data and the GPU, stated in the status line, and rises or falls with the selected region. A `.glyphset` value still sets the starting threshold. |
| Percentile threshold | `D_THRESHOLD_PERC` | none | Not ported | The status line reports counts instead. |
| Upper threshold | `m_maxThreshold`, third token of line 3 | `maxThreshold`, starts at the file's value if below 1, else at the maximum | Ported | |
| Matrix storage | float32 lower triangle (`n(n+1)/2` values), rows read lazily; network matrices | dense int16 `n x n` (`2 n^2` bytes), loaded entirely | Changed | Direct row access and raw integers to the GPU; about the same footprint as the lower triangle in float32. |
| Value precision | float32 | 16-bit quantisation relative to the largest value | Changed | See the [formats](../reference/data-formats.md#dtype-and-scale). |
| Node limit | not limited by design | 65,535 | Changed | 16-bit indices on the GPU. |
| Live thresholds for pies | rebuild | live | Added | See above. |

## Interaction and views

| Feature | brainGL | brainGL web | Status | Reason |
|---|---|---|---|---|
| Orthographic main view | yes | yes | Ported | Required for screen-facing glyphs. |
| Second, coupled view of seed connectivity | `maingl2` | the inset | Ported | |
| Node selection | right mouse button, synchronised cursor | right mouse button, double-click, Seed tool | Ported | |
| Painting regions | ctrl + right-drag, ctrl + shift to erase | same, plus Paint/Erase tools and keys | Ported | |
| Several regions | one ROI | each paint colour is a region | Changed | Needed for the bridge to Directionality. |
| Mean connectivity of a region | `avgConRtoZ` (Fisher-z mean) | same | Ported | |
| Hemisphere selector | `D_LEFT_RIGHT` | `hemi` | Ported | |
| Four separate surface choices | three | four (display, geometry, colour, length) | Added | The minimum-length surface. |
| Overlays | per-mesh vertex data | named overlays shown as the surface colour; sulc / curv shading | Added | Common per-node maps such as sulcal depth. |
| Colour maps | brainGL's maps and an editor | ten fixed maps (brainGL's `grey`, `rainbow`, `rainbow 2`, `blue white red`, plus `green - red`, `cool - warm`, `viridis`, `magma`, `hot`, `gradient`) | Changed | The editor is not ported; modern perceptual maps added. |

## Connexels and bundling

| Feature | brainGL | brainGL web | Status | Reason |
|---|---|---|---|---|
| Make connections | `createConnections`, threshold at least `m_minThreshold`, both directions | same filter; threshold at least `0.02 * maxAbs`; strongest `maxConnexels` kept | Changed | Bounded size for interactive use. |
| Mean-shift edge bundling | threads, 3-D algorithm of Böttger et al. 2014 | same algorithm, Web Worker | Ported | Follows the C++ code, including its quirks. |
| Save connexels `.cxls` | `saveConnexels` | same format | Ported | |
| Save bundles `.fib` | `saveFibs` | same format | Ported | |
| Load connexel files (`.cxls`, `.cons`, `.fib`) | yes | no | Not ported | Parsers exist but are not wired to the interface. |

## Data input and output

| Feature | brainGL | brainGL web | Status | Reason |
|---|---|---|---|---|
| `.glyphset`, `.set`, FreeSurfer `.asc`, float32 matrix | yes | yes | Ported | See [Load a brainGL glyphset](../how-to/load-braingl-glyphset.md). |
| Connectivity from a URL in a `.glyphset` file | yes (`http`) | no | Not ported | Browsers cannot read arbitrary servers; use a web glyphset. |
| ROI files `.1D`, `.rgb`, id list | yes | yes | Ported | |
| Save `.1D` ROI | `save1D` | yes | Ported | |
| Web glyphset (`glyphset.json` + binaries) | none | yes | Added | Compact, browser-friendly. Converters in `tools/make_glyphset.py`. |
| GIFTI surfaces and scalars, FreeSurfer binary, `.npy` matrices | no | yes | Added | The formats current pipelines write. |
| Export colours / copy colours | `exportColors`, `D_COPY_COLORS` | none | Not ported | Not part of the glyph workflow here. |
| Scene file | not compared | JSON (`.scn.json`) with parameters, cameras and regions | Added | A web-specific format. |
| Settings between sessions | not compared | `localStorage` | Added | |
| Drag and drop of data | no | yes | Added | |
| Screenshot | brainGL's own screenshot function | PNG at a multiple of screen resolution | Changed | Not compared in detail. |

## New in the web port

| Feature | Description |
|---|---|
| Directionality workspace | The vendored LGPL app: LIC and arrows on a parcellated surface, with a bridge from painted regions or surface maps. |
| Blender export | Scenes as coloured geometry plus `scene.json`; an import script; a command-line exporter. |
| Scripting API | `braingl.glyphs.setParams` and friends in the console. |

## Not ported

brainGL is a general neuroimaging viewer. Not present: NIfTI volumes and slices, isosurfaces,
diffusion and tensor data, ODFs and spherical harmonics, fibre tracking and fibre display,
the dataset tree and tool-bar of the Qt application, MEG and tree data, CIFTI read directly
(convert it), the colour-map editor. See [Limits](../reference/limits.md#what-is-not-ported-from-braingl).

## Notes on the papers

- The 2013 paper describes the polar projection; brainGL's glyphset code does not contain it, so it
  cannot be reproduced in brainGL, only here.
- The 2014 paper describes vector glyphs as "a line is drawn between each of the above mentioned points and
  the node position", which is what both programs do.
