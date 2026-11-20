# Parameters

Every control of the **Connectivity glyphs** panel, grouped by panel section. The
`Key` column is the field name in `src/glyphs/params.ts`, which is also the key used
by the scripting API (`braingl.glyphs.setParams({ ... })`), by saved scene files and by
the settings stored in the browser. Ranges are the `slider(...)` ranges of `buildPanel`
in `src/glyphs/glyphApp.ts`. The last column names the brainGL property
(`Fn::Property::D_*` in `datasetglyphset.cpp`) that the control replaces, where there is
one. See [Glyph types](glyph-types.md) for the formulas.

!!! note
    Settings are stored in the browser (`localStorage`, key `braingl.glyphs.params`) and
    restored at the next visit; *Reset to defaults* in the Export section restores the
    values below. When a dataset of a different shape is loaded, the surfaces, the glyph
    scale and the thresholds are re-initialised (see [Dataset-dependent defaults](#dataset-dependent-defaults)).

## Data

| Control | Key | Type / range | Default | Meaning | brainGL |
|---|---|---|---|---|---|
| Open files… | none | button | n/a | Pick the files of a glyphset together (see [Data formats](data-formats.md#loading-rules)). | File menu, `.glyphset` loader |
| Open folder… | none | button | n/a | Pick a folder; all files in it are read. | n/a |
| Demo | none | button | n/a | Load the bundled NKI Rockland group average (`data/nki_fsaverage4/`). | n/a |

The page also accepts `?data=<folder>` (a web glyphset served next to the app, relative
to the page) in place of the demo at start-up, and `?workspace=glyphs|directionality`.

## View

| Control | Key | Type / range | Default | Meaning | brainGL |
|---|---|---|---|---|---|
| Surface | `surface` | index of a dataset surface | 1 (see below) | Surface on which glyphs and the surface are drawn, also the surface used for picking and painting. | `D_SURFACE` |
| Hemispheres | `hemi` | 0 both, 1 left, 2 right | 0 | Restrict glyphs and surface to one hemisphere. Only shown for datasets with two hemispheres (`leftNodes > 0`). | `D_LEFT_RIGHT` |
| Second view: seed-based connectivity | `secondView` | boolean | true | Show the coupled inset with the connectivity map of the selected node. | the second GL widget, `maingl2` |
| Second view surface | `secondSurface` | index | 0 (see below) | Surface of the inset. Shown when the second view is on. | `D_SURFACE` of `maingl2` |
| Background | `background` | colour | `#101014` | Background colour of the views and of screenshots. | n/a |

## Surface

| Control | Key | Type / range | Default | Meaning | brainGL |
|---|---|---|---|---|---|
| Show surface | `showSurface` | boolean | true | Draw the displayed surface. | `D_DRAW_SURFACE` |
| Colour | `surfaceColorMode` | `"solid"`, `"sulc"`, `"seed"` or `"overlay:<name>"` | `"sulc"` | `sulc`: base colour shaded by sulcal depth; `solid`: one colour; `seed`: colour-map the connectivity of the selected node (or the mean of the painted region); `overlay:<name>`: colour-map a per-node overlay (range: 2nd to 98th percentile). | mesh colour-mode property |
| Mesh colour | `surfaceColor` | colour | `#c9c9cf` | Base colour. Also the base colour of anatomical background glyphs. | `D_COLOR` |
| Alpha | `surfaceAlpha` | 0.02 to 1, step 0.01 | 1 | Transparency of the surface. Below 0.995 the surface is drawn after the glyphs, back faces first. | n/a |

In the inset the surface colour mode is always "seed" and the surface is opaque.

## Glyphs

| Control | Key | Type / range | Default | Meaning | brainGL |
|---|---|---|---|---|---|
| Show glyphs | `showGlyphs` | boolean | true | Master switch for glyphs and anatomical background glyphs in the main view. | `D_DRAW_GLYPHS` |
| Glyph style | `glyphStyle` | `points`, `vectors`, `pies`, `diffpoints`, `off` | `points` | See [Glyph types](glyph-types.md). Keys 1 to 4 and 0. | `D_GLYPHSTYLE` (default "off" there) |
| Scale | `glyphRadius` | 0.001 to 0.2, step 0.0005 | 0.03 (re-derived on load) | Glyph size relative to the surface it copies: the factor `s` of the placement formulas. For pies and the polar projection it is also the unit of the radius, `100 s` mm. | `D_GLYPHRADIUS` (0 to 0.5, default 0.01) |
| Point / line size | `primSize` | 0.5 to 12, step 0.1 | 2 | Point size or line width in CSS pixels (multiplied by the device pixel ratio). Hidden for pies. | `D_PRIMSIZE` (0 to 10, default 0.5) |
| Round points | `roundPoints` | boolean | true | Round instead of square points. Has no panel control; set it with `setParams`. Applied only when the size is at least 3 device pixels. | none |
| Pie normalisation | `normalization` | 0 to 1, step 0.01 | 0.5 | 0: all pies have the same radius; 1: pie area proportional to the number of connections. Shown for pies only. | `D_NORMALIZATION` (default 0.5) |
| Glyph alpha | `glyphAlpha` | 0 to 1, step 0.01 | 1 | Below 1, weak connections fade (`alpha = (abs(v)/max)^(10(1-glyphAlpha))`). Hidden for pies. | `D_GLYPH_ALPHA` |
| Glyph geometry | `glyphGeometry` | surface index, or -1 for the polar projection | 0 (see below) | Surface whose shape each glyph copies. `-1` ("polar projection (sphere)") is offered only if a sphere is found. Hidden for pies. | `D_SURFACE_GLYPH_GEOMETRY` |
| Colour mode | `glyphColorMode` | 0 orientation, 1 value | 0 | Colour glyphs by connection direction or by connection strength. | `D_GLYPH_COLORMODE` |
| Glyph colour | `colorSurface` | surface index | 0 (see below) | Surface in which orientations are measured. Shown for orientation colouring. | `D_SURFACE_GLYPH_COLOR` |
| Glyph rotation | `rotationEnabled` | boolean | false | Enable the rotation below. Hidden for pies and the polar projection. | `D_GLYPH_ROTATION` |
| x / y / z rotation | `rotX`, `rotY`, `rotZ` | 0 to 360, step 1 (degrees) | 0 | Rotation of every glyph, composed as Rx · Ry · Rz. | `D_GLYPH_ROT_X`, `_Y`, `_Z` |
| Lift off surface | `depthLift` | 0 to 8, step 0.1 | 1 | Distance toward the viewer, in glyph radii (`depthLift * glyphRadius * 100` mm). | none (brainGL used a fixed clip-space bias) |

## Thresholds

| Control | Key | Type / range | Default | Meaning | brainGL |
|---|---|---|---|---|---|
| Threshold | `threshold` | 0 to `maxAbs`, step 0.005 | 0.5 | Lower bound on `abs(value)`. For diffpoints: minimum difference between neighbouring profiles. `maxAbs` is the largest absolute matrix value. | `D_THRESHOLD`, `D_THRESHOLD_PERC` |
| Sign | `sign` | 0 `+`, 1 `−`, 2 `+ / −` | 0 | Which signs of connection are drawn. | `D_GLYPH_THRESHOLD_SIGN` |
| Minimum length (mm) | `minLength` | 0 to 150, step 1 | 20 | Hide connections shorter than this (strictly: kept when distance > value). | `D_MINLENGTH` (0 to 100, default 0) |
| Length measured on | `lengthSurface` | surface index | 0 (see below) | Surface on which the length is measured. Shown when `minLength > 0`. | none (brainGL measures on the displayed surface) |
| Upper threshold | `maxThreshold` | 0 to `maxAbs`, step 0.005 | `maxAbs` (set on load; the `.glyphset` value when given) | Upper bound on `abs(value)`. `m_maxThreshold` (third item of line 3 of a `.glyphset` file, used when below 1) |
| Connexel budget (millions) | `budgetM` | 0.5 to 40, step 0.5, applied on release | 4 | Upper bound on connexels sent to the GPU; sets a lower bound on the effective threshold. | the load-time minimum threshold (`m_minThreshold`) |

There is no percentile slider (`D_THRESHOLD_PERC` in brainGL); the status line reports
how many connexels pass.

## Colour map

| Control | Key | Type / range | Default | Meaning | brainGL |
|---|---|---|---|---|---|
| Colour map | `colormap` | name from the table below | `cool - warm` | Lookup table for value colouring of glyphs, surface maps, little brains and connection lines. | colormap bar properties |
| Min / Max | `cmin`, `cmax` | -1 to 1, step 0.01 | -0.8, 0.8 | Values mapped to the two ends of the map (`D_SELECTED_MIN`, `D_SELECTED_MAX`). For overlays the 2nd and 98th percentile are used instead. | `D_SELECTED_MIN`, `D_SELECTED_MAX` |
| Surface map lower threshold | `seedLower` | 0 to 1, step 0.01 | 0.2 | Seed-based connectivity with absolute value below this shows the anatomy colour instead. | `D_LOWER_THRESHOLD` |

### Colour maps

Each map is a 256-entry table interpolated linearly between stops
(`src/render/colormaps.ts`); the stops are `[position, r, g, b]` with colours in 0 to 1.

| Name | Stops | Origin |
|---|---|---|
| `grey` | black to white | brainGL default |
| `rainbow` | blue, cyan, green, yellow, red at 0, 0.25, 0.5, 0.75, 1 | brainGL default |
| `rainbow 2` | violet (0.5, 0, 1), blue, cyan, green, yellow, red at 0, 0.2, 0.4, 0.6, 0.8, 1 | brainGL default |
| `blue white red` | blue, white, red | brainGL default |
| `green - red` | (0.1, 0.62, 0.3), (0.62, 0.62, 0.42), (0.9, 0.3, 0.25) | isoluminant opponent scale of the 2014 figures |
| `cool - warm` | (0.23, 0.30, 0.75), (0.87, 0.87, 0.87), (0.71, 0.02, 0.15) | diverging, default here |
| `viridis` | 5 stops | common perceptual map |
| `magma` | 5 stops | common perceptual map |
| `hot` | black-red (0.04, 0, 0), red at 0.37, yellow at 0.75, white | common |
| `gradient` | 7 stops, viridis into yellow, orange and brown | the lab's gradient map |

An unknown name falls back to `grey`. The map is not reversed anywhere in the panel.

## Regions & painting

| Control | Key | Type / range | Default | Meaning | brainGL |
|---|---|---|---|---|---|
| Brush size (mm) | `brushSize` | 1 to 60, step 0.5 | 8 | Radius of the paint/erase brush, grown along the mesh from the picked node (it does not jump across a sulcus or to the other hemisphere). | n/a |
| Paint colour | `paintColor` | colour | `#ffb000` | Colour of new paint; each distinct colour is one region (up to 255). | n/a |
| Show paint | `showPaint` | boolean | true | Draw painted nodes on the surface (alpha 215/255). | n/a |
| Glyphs at | `glyphNodes` | `"all"`, `"painted"` | `"all"` | All nodes with data, or only painted nodes. Loading a `.glyphset` or ROI file with a region switches it to `"painted"`. | the ROI of the glyphset (always in effect there) |
| Tool | `tool` | `navigate`, `seed`, `paint`, `erase` | `navigate` | Toolbar buttons and keys N, S, P, E. | toolbar |
| Mean connectivity | button | | | Fisher-z mean of the connectivity rows of all painted nodes, shown as the surface map (`averageConnectivity`). | `avgConRtoZ` |
| Clear | button | | | Remove all paint. | n/a |
| Load ROI… | button | | | `.1D`, `.rgb` or id list ([formats](data-formats.md#roi-files)). The nodes are added to the region of the current paint colour. | `loadROI` |
| Save .1D | button | | | One line per node, 1 if painted. | `save1D` |
| Save labels | button | | | `<node> <region>` per painted node, file `regions.1D.roi`. | n/a |

## Anatomical background glyphs

This section is collapsed by default.

| Control | Key | Type / range | Default | Meaning | brainGL |
|---|---|---|---|---|---|
| Show little brains | `littleBrains` | boolean | false | Draw a miniature surface behind each glyph of the painted region, or of the selected node. | `D_LITTLE_BRAIN_VISIBILITY` (default true) |
| Little brain colour | `lbColorMode` | 1 vertex data, 2 anatomy, 0 per mesh | 1 | See [Glyph types](glyph-types.md#anatomical-background-glyphs-little-brains). | `D_LITTLE_BRAINS_COLORMODE` |
| Maximum number | `lbMax` | 1 to 2000, step 1, applied on release | 200 | Cap on the number of copies; selected nodes are sub-sampled evenly. | n/a |

A warning is shown, and nothing is drawn, with the polar projection.

## Connections & bundling

This section is collapsed by default.

| Control | Key | Type / range | Default | Meaning | brainGL |
|---|---|---|---|---|---|
| Maximum connexels | `maxConnexels` | 100 to 40000, step 100 | 5000 | Cap for "Make connections"; the strongest connexels are kept. | n/a |
| Make connections | button | | | Create one line per node pair that passes the current filters in either direction and exceeds the minimum length, using at least `0.02 * maxAbs` as threshold. Sets `showConnections`, and lowers the surface alpha to 0.25 if it was above 0.6. | `createConnections` |
| Bundle | button | | | Mean-shift edge bundling in a Web Worker. | bundler of Böttger et al. 2014 |
| Clear | button | | | Remove connections and bundles. | n/a |
| Show connections | `showConnections` | boolean | true | Draw the lines. | n/a |
| Line colour | `lineColorMode` | 0 orientation, 1 value | 0 | Colour of each line by direction or by value. | n/a |
| Line width | `lineWidth` | 0.5 to 8, step 0.1 | 1.2 | Pixels. | n/a |
| Line alpha | `lineAlpha` | 0.02 to 1, step 0.01 | 0.5 | Opacity of the lines. | n/a |
| Compatibility threshold | `bundleCompat` | 0.5 to 0.99, step 0.01 | 0.8 | How similar two connections must be to attract each other. | bundler `c_thr` |
| Kernel width (mm) | `bundleBell` | 1 to 30, step 0.5 | 5 | Standard deviation of the Gaussian mean-shift kernel. | bundler `bell` |
| Save .cxls | button | | | Weighted connexels as text ([format](data-formats.md#cxls)). | `saveConnexels` |
| Save .fib | button | | | Lines as binary VTK ([format](data-formats.md#fib)). | `saveFibs` |

The other bundling options (10 cycles, 10 initial iterations, 3 smoothing steps; see
`defaultBundlingOptions` in `src/algorithms/meanShiftBundling.ts`) have no controls.

## Export

| Control | Key | Type / range | Default | Meaning |
|---|---|---|---|---|
| Screenshot scale | `screenshotScale` | 1 to 8, step 0.5 | 2 | Multiple of the screen resolution; limited to the largest render buffer (at most 16384 px on the longer side). |
| Screenshot | button | | | Render at that scale and download `braingl-<style>-<timestamp>.png`. |
| Save scene | button | | | Download `braingl-scene-<timestamp>.scn.json` ([format](data-formats.md#scene-files)). |
| Load scene… | button | | | Restore parameters, cameras and painted regions from a scene file. Regions are restored only if the node count matches. |
| Regions → Directionality | button | | | Painted regions become the parcellation of the Directionality workspace. Needs at least two regions. |
| Map → Directionality | button | | | The current surface map (seed connectivity or overlay) is cut into 12 quantile bins ordered by value. |
| Reset to defaults | button | | | Restore every parameter and forget the stored dataset signature, so the dataset-dependent defaults below are applied again. |

The two Directionality buttons appear only when the Directionality workspace is
available (it is, in the standard app).

## Dataset-dependent defaults

Settings and camera views are remembered per kind of dataset: a signature made of the node count and the
surface names is stored in `localStorage` (`braingl.glyphs.dataset`). When a dataset with a different
signature (or without stored camera state) is loaded, `setDataset` re-initialises:

- `surface`: the surface whose name contains `inflated`, else index 1 (or the last, if
  there is only one);
- `secondSurface`: first of `pial`, `midthickness`, `white`, else 0;
- `glyphGeometry`, `colorSurface` and `lengthSurface`: set to the same surface as
  `secondSurface`;
- `glyphRadius`: `0.0042 * (mean mesh edge length of the displayed surface)`, rounded to
  4 decimals and clamped to 0.002 to 0.2;
- `maxThreshold`: `maxAbs`, or the upper threshold of a `.glyphset` file when it is below 1; `threshold`: clamped to at most `maxAbs`, and raised to the
  load-time minimum threshold of a `.glyphset` file when there is one.

If a ROI came with the data, its nodes are painted as region 1 and `glyphNodes` becomes
`"painted"`.

## Status line

The line at the bottom of the main view (`updateStatus`), separated by middle dots:

| Field | Meaning |
|---|---|
| **name** · N nodes | Dataset name and node count. |
| `X connexels above threshold` | For points and vectors: number of connexels with `abs(value)` above the effective threshold, estimated from the cumulative histogram of 2000 bins. For pies: `X connexels shown`, the exact count of visible slices. |
| `Y on GPU (abs(r) ≥ t)` | Number of connexels in the GPU buffer and the build threshold `t` that the budget imposed. |
| `edge–target pairs on GPU (abs(r) ≥ t)` | Diffpoints: records in the GPU buffer and the build threshold. |
| warning "threshold limited to t by the connexel budget" | Shown when `threshold` is below `t`: the display is limited by the budget, not by your setting. |
| warning "paint a region to create glyphs" | `glyphNodes = "painted"` and nothing is painted. |
| `node c (x, y, z)` | Selected node and its coordinates on the displayed surface, rounded to whole millimetres. |
| `N ms` | Frame-preparation time, shown only above 250 ms. |

The colour-bar legend (min, colour map, max) is shown when glyph colour is "value", when
the second view is on, or when the surface colour is "seed". Counts of 10,000 or more are
shown as "k" and of a million or more as "M".

## Scripting API

In the browser console (`src/main.ts`, `GlyphApp`):

| Call | Effect |
|---|---|
| `braingl.glyphs.setParams({...})` | Set any keys of the table above and rebuild what they affect. |
| `braingl.glyphs.params` | The current parameter object. |
| `braingl.glyphs.setView(view, which = 0, zoom = 1)` | `view` is `"left"`, `"right"`, `"anterior"`, `"posterior"`, `"dorsal"` or `"ventral"`; `which` 0 = main, 1 = inset. |
| `braingl.glyphs.selectNode(i)` | Select node `i` (seed). |
| `braingl.glyphs.focusNode(i, zoom = 4)` | Centre the main view on node `i`. |
| `braingl.glyphs.screenshot()` | Download a PNG. |
| `braingl.show("glyphs")` or `braingl.show("directionality")` | Switch workspace. |
| `braingl.exportForBlender()` | Download the Blender bundle of the front workspace. |
| `braingl.directionality()` | Start (if needed) and return the handle of the Directionality workspace (a promise). |
