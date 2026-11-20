# Data formats

This page specifies every file format that the app reads or writes. It is derived from
`src/data/loadWeb.ts`, `src/data/loadFiles.ts`, `src/io/*`, `src/algorithms/connexelFiles.ts`,
`src/bridge/toDirectionality.ts`, `tools/make_glyphset.py` and, for the original formats,
brainGL's `loader.cpp`, `datasetglyphset.cpp` and `correlationmatrix.cpp`.

## Loading rules

"Open files…", "Open folder…" and drag and drop all call `loadFromFiles` with a list of
files (dropped folders are walked recursively). Files are matched **by base name**: a path
inside a manifest is reduced to its last component, so folder structure does not matter
but two files with the same base name in different folders collide (the later one wins).
The first layout that matches is used:

1. **Web glyphset.** A file named `glyphset.json` (case-insensitive), or else the first
   file ending in `.json`, whose `format` is `"braingl-web-glyphset"`. All files that it
   names must be among the selected files, otherwise the error is
   `"<name>" is referenced but was not among the selected files`. A `.json` file with
   another `format` (for example a scene file) is ignored and the next layouts are tried.
2. **brainGL glyphset.** Any file ending in `.glyphset` (case-insensitive).
3. **Loose files.** Everything else.

The node count is limited to 65,535 (see [Limits](limits.md)).

### Validation

Every layout ends in `validateDataset` (`src/data/dataset.ts`), which rejects a structurally invalid dataset before it
reaches the GPU, where an out-of-range index would read garbage. It checks that:

- there are at least 3 nodes (`dataset has <n> nodes`) and at least one surface;
- every surface has exactly `3 * n` coordinates, all finite;
- the triangle list is a multiple of 3 long and every index is smaller than `n`;
- the mask has `n` entries and the matrix is `n x n`;
- the hemisphere split is inside the mesh: `0 <= leftNodes <= n`, and `leftTriangles * 3` does not exceed the triangle
  list;
- every overlay has exactly `n` values. (The web-glyphset reader skips an overlay of the wrong length first; for loose
  files an overlay group that does not add up to `n` is not created.)

## Web glyphset

A folder with a manifest `glyphset.json` and raw little-endian binary files, written by
`tools/make_glyphset.py`. The bundled demo `public/data/nki_fsaverage4/` is one.

### `glyphset.json`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `format` | string | yes | Must be `"braingl-web-glyphset"`. |
| `version` | number | yes (written) | `1`. Not checked by the loader. |
| `name` | string | yes | Dataset name shown in the panel. |
| `description` | string | no | Shown below the name. Default empty. |
| `credit` | string | no | Attribution line for the data (written by `nki-demo`). Not interpreted by the loader. |
| `nodes` | integer | yes | Number of nodes `n`. |
| `leftNodes` | integer | no | Number of nodes of the left hemisphere; nodes `0 .. leftNodes-1` are left, the rest right. 0 or absent: not split. |
| `leftTriangles` | integer | no | Number of triangles of the left hemisphere (triangles `0 .. leftTriangles-1`). |
| `triangles` | string | yes | File name of the triangle index file. |
| `surfaces` | array of `{name, file}` | yes | At least one surface. `name` is shown in the panel (names containing `inflated`, `pial`, `midthickness`, `white` and `sphere` get special treatment in the defaults and in sphere detection). The first surface fixes the triangle winding. |
| `overlays` | array of `{name, file}` | no | Per-node scalar files; an overlay whose length is not `n` is skipped silently. |
| `mask` | string | no | File name of a per-node mask. Absent: all nodes carry data. |
| `connectivity` | object | yes | See below. |

Additional keys are ignored (the writer adds `source` and `subjects` for the NKI demo).

`connectivity`:

| Field | Values | Meaning |
|---|---|---|
| `file` | string | File name. |
| `dtype` | `"int8"`, `"int16"`, `"float32"` | Element type of the file. |
| `layout` | `"upper"`, `"full"` | `upper`: strict upper triangle of a symmetric matrix; `full`: all `n x n` values, row-major. |
| `scale` | number, default 1 | Value = element * `scale`. |

### Binary files

All little-endian, no header.

| File | Content |
|---|---|
| triangles (`triangles.u32`) | `uint32`, 3 indices per triangle, `3 * nTriangles` values. Both hemispheres are in one array, the right hemisphere indices already offset by `leftNodes`. |
| surface (`<name>.f32`) | `float32`, `x y z` interleaved for each node, `3 * n` values, in millimetres. All surfaces must have the same `n`, else the load fails with `surface "<name>" has <k> nodes, expected <n>`. |
| overlay (`<name>.f32`) | `float32`, `n` values. |
| mask (`mask.u8`) | `uint8`, `n` values; 1 = node carries data, 0 = excluded (for example the medial wall). |
| connectivity | see below. |

### The "upper" triangle ordering

For `layout: "upper"` the file holds `n (n - 1) / 2` elements, the pairs `(i, j)` with
`i < j`, in row-major order:

```
(0,1) (0,2) ... (0,n-1)  (1,2) (1,3) ... (1,n-1)  (2,3) ...  (n-2,n-1)
```

which is the order of `numpy.triu_indices(n, k=1)`. The matrix is assumed symmetric:
`m[i][j] = m[j][i]`, and the diagonal is zero. For `layout: "full"` element `i*n + j` is
`m[i][j]` and the matrix need not be symmetric (glyphs of node `i` use row `i`).

A wrong element count raises `upper triangle has <k> entries, expected <n(n-1)/2>` or
`matrix has <k> entries, expected <n>x<n>`.

### dtype and scale

`tools/make_glyphset.py` writes `int8` by default: the largest absolute value `vmax` of the
upper triangle (after replacing NaN and infinities with 0) maps to 127, so
`scale = vmax / 127` and `value = element * scale`. `int16` maps `vmax` to 32767.
`float32` stores the values themselves and `scale` is 1. For the NKI demo the scale is
about 0.0076 for `int8`.

On loading, the matrix is converted to a dense `int16` matrix `n x n` (see
[How it works](../explanation/how-it-works.md)): the largest absolute element is mapped to
32767, so an `int8` file is **re-quantised** onto the int16 range but keeps its original 127
levels of precision. The internal scale is then `maxAbs / 32767` with `maxAbs = max|element| * scale`. NaN and infinite
float values become 0. A matrix whose elements are all zero is given `maxAbs = 1`.

## brainGL glyphset

Original brainGL files, loaded by `src/io/glyphsetFiles.ts` (a port of `Loader::loadGlyphset`,
`Loader::loadSet`). Select the `.glyphset`, the `.set` files, the surface files, the
connectivity file and the optional ROI file together. See also
[Load a brainGL glyphset](../how-to/load-braingl-glyphset.md).

### `.glyphset`

A text file with exactly three lines, by position:

| Line | Content |
|---|---|
| 1 | Anatomical NIfTI file name. Read but not used. |
| 2 | One or two `.set` file names separated by blanks: left hemisphere, right hemisphere. Further names are ignored (brainGL prints "only two hemispheres supported"). At least one is required. |
| 3 | `connectivity [minThreshold [maxThreshold [roi [roi2]]]]`, separated by blanks. |

Line 3 tokens:

| Token | Default | Use in the web port |
|---|---|---|
| connectivity | required | File name of the matrix. brainGL also accepts an `http` URL here; the web port does not (the name must be among the selected files). |
| minThreshold | 0.8 | Starting threshold: the `threshold` parameter is set to at least this value. A token that is not a number counts as 0, as `QString::toFloat` does. |
| maxThreshold | 1.0 | Starting upper threshold, applied only when it is below 1 (the value is then limited to the matrix maximum); otherwise the upper threshold starts at the largest matrix value. |
| roi | none | ROI file listing the nodes that get glyphs. If present, its nodes are painted as one region and `glyphNodes` is set to `"painted"`. |
| roi2 | none | Second ROI file, same formats as `roi`: restricts the **target** nodes. Only connexels `(i, j)` with `j` in this ROI contribute to glyphs, and to connections made from them (brainGL's `roi2`). |

Any run of blanks or tabs separates tokens, and CRLF line ends and a byte-order mark are
accepted (brainGL splits on single blanks).

### `.set`

One surface per line: `filename [x [y [z]]]`. The optional numbers translate every vertex
of that surface. Blank lines and lines starting with `#` are skipped. The left and the
right `.set` file must list the same surfaces in the same order: line `k` of the left file
and line `k` of the right file are the left and right halves of surface `k`; they are
stacked into one surface with the right half's vertex indices offset by the left node
count. The first surface is the anatomical one: it provides the triangles and the
winding is checked on it. The surface name in the panel is derived from the file name (see
[surface names](#hemisphere-and-surface-name-heuristics)).

### FreeSurfer ASCII surface (`.asc`)

```
#!ascii version of lh.pial        optional comment line
nVerts nTris
x y z flag                        nVerts lines (flag optional)
a b c flag                        nTris lines  (flag optional)
```

Produced by `mris_convert lh.pial lh.pial.asc` or AFNI `gifti_tool -write_asc`. The parser
accepts a missing comment line, CRLF, tabs, repeated blanks, blank lines and a missing flag.
Triangle winding is taken as stored; the loader then flips triangles where necessary so that
normals point outward (`orientOutward`, by the sign of the signed volume, separately for each
hemisphere).

### Connectivity matrix (raw float32)

A flat file of `n * n` little-endian IEEE float32 values, row-major, no header. `n` is
computed from the file size (`n = sqrt(size / 4)`) and the file size must be exactly `4 n^2`
bytes. In the web port the file is read in 32 MB chunks and quantised to int16 without ever
holding the float matrix; the file must be square with `n` equal to the surface node count.
NaN and infinities become 0. brainGL reads the same file (`CorrelationMatrix`: "assumes a
square matrix of float32", `QDataStream` little-endian, single precision) and keeps the lower
triangle only.

### ROI files

`parseRoiFile` returns a 0/1 mask with one entry per node. The format is chosen from the file
name. A file that is shorter than the node count leaves the remaining nodes outside the ROI.
`#` comment lines are skipped in the first two formats.

| Extension | Format | A node is in the ROI when |
|---|---|---|
| `.1D` (any case) | one number per node, whitespace separated | value > 0.5 |
| `.rgb` | `r g b` per node (3 numbers) | any channel is below 1.0, that is, the colour is not white |
| anything else | a list of nodes: the first token of each line is a node index | listed (indices outside `0 .. n-1` and lines whose first token is not an integer are ignored) |

### Other loose files and the brainGL formats not read

`.cxls` and `.fib` connexel files are written ([below](#cxls)) but not read by the app
(parsers for `.cxls` exist in `src/algorithms/connexelFiles.ts`, used by tests).

## Loose files

When there is neither a web manifest nor a `.glyphset` file, the loader sorts the files by
extension and content (`loadFromFiles`, third branch). Evaluated in this order for each file:

1. Names ending in `.set`, `.txt`, `.json`, `.md`, `.scn`, `.nii` or `.gz` are skipped. A
   gzipped file is therefore never read.
2. `.gii`: parsed as GIFTI. If it contains both a POINTSET and a TRIANGLE array it is a
   **surface**; otherwise each other array (for a 2-D array each column) is a **per-node
   scalar** set (`.func.gii`, `.shape.gii`, `.label.gii`).
3. `.asc`: a FreeSurfer ASCII **surface**.
4. `.1D`: a **per-node scalar** file (whitespace-separated numbers).
5. `.npy`, `.bin`, `.data`, `.dat`, `.f32`, `.raw`: a **matrix candidate**.
6. Any other file: its first bytes are inspected. `FF FF FE` is a FreeSurfer binary
   **surface**; `FF FF FF` with a consistent header (sniffed from the first 15 bytes plus the file size: the header must be consistent and the file at least as long
   as the vertex count says) is a FreeSurfer new-format **curvature** file (`lh.curv`, `lh.sulc`, `lh.thickness`:
   per-node scalars, used as overlays named `curv`, `sulc`, `thickness`); a truncated curvature file or a quadrangle
   surface is skipped with a note and never taken for the matrix, unless its size is that of a square float32 matrix;
   anything else is a **matrix candidate**.

If there are several matrix candidates, the **largest file** is the matrix. The dataset takes
the matrix file's name as its name. There must be at least one surface and one matrix,
otherwise `No surface found...` or `No connectivity matrix found...`.

**Matrix.** A `.npy` file (any file starting with the NPY magic) must be a square 2-D array;
supported element types are `f4 f8 i1 u1 b1 i2 u2 i4 u4` (little- or big-endian), format
versions 1, 2 and 3, C or Fortran order. The `.npy` array is read completely into memory
(float64 takes 8 `n^2` bytes before conversion). Anything else is read as raw float32.

**Surfaces.** Surfaces are grouped by **surface label**; each group is one surface with a
left and a right half. Per group, the left half is the first mesh with hemisphere `L`, else
the first with no hemisphere detected, else the first; the right half is the first mesh with
hemisphere `R` that is not the left one. The two halves are stacked (left first). `leftNodes` and
`leftTriangles` are set from every group that has both halves (the last such group wins). For
labels other than `pial`, `white` and `midthickness`, overlapping hemispheres are moved apart
along x until they are 5 mm apart (`separate`; the inflated and spherical surfaces are both
centred on the origin). Surfaces are ordered `pial`, `midthickness`, `white`, `smoothwm`, `orig`, `inflated`,
`very_inflated`, `veryinflated`, `sphere`, `flat`, then others. The first one provides the triangles. A later surface
with a different node count is skipped with a note in the browser console.

**Scalars (overlays).** Scalar files are grouped by name (hemisphere markers and the
`.gii`, `.func`, `.shape`, `.1D` suffixes removed). A group becomes an overlay if one file has
`n` values, or if a left and a right file together have `n` values (left first).

**Mask.** For brainGL and loose files, nodes whose row is entirely zero (excluding the
diagonal) get no glyph.

### Hemisphere and surface-name heuristics

Hemisphere (`hemiOf`), from the base name: left if it matches
`(^|[._-])(lh|l|left)([._-]|$)` (case-insensitive), right if it matches
`(^|[._-])(rh|r|right)([._-]|$)`, else undetected. So `lh.pial.asc`, `L.pial.asc`,
`pial_left.gii`, `left-pial.asc` and `pial.L.surf.gii` are recognised; `lhpial.asc` is not. A
name that matches both patterns counts as left.

Surface label (`surfaceLabel`), from the base name lower-cased: the first of
`very_inflated`, `veryinflated`, `midthickness`, `inflated`, `sphere`, `pial`, `white`, `flat`,
`smoothwm`, `orig` that the name contains; otherwise the name with the extension
(`.asc`, `.gii`, `.surf`) and the hemisphere token removed. The label names are those of the sort list above.

## FreeSurfer binary files

Big-endian.

- **Triangle surface** (`lh.pial`, `lh.white`, `lh.inflated`): magic `FF FF FE`, a comment line
  ending in a newline, a second (normally empty) line, `int32 nVerts, nFaces`,
  `float32 x y z` per vertex, `int32 a b c` per face. Quad surfaces (`FF FF FD`) are not supported.
- **New curvature file** (`lh.curv`, `lh.sulc`, `lh.thickness`): magic `FF FF FF`,
  `int32 nVerts, nFaces, valsPerVertex` (only 1 is supported), `float32` values. Old-format
  curv files are not supported.

## GIFTI

`.gii` files are read by a built-in parser (no DOM). Supported encodings: `ASCII`,
`Base64Binary`, `GZipBase64Binary` (needs the browser's `DecompressionStream`); data types
uint8, int8, int16, uint16, int32, uint32, float32, float64; either endianness and indexing
order. `ExternalFileBinary` is not supported. The POINTSET must have dimensions `[nVerts, 3]`
and the TRIANGLE `[nTris, 3]`; the coordinate system transform matrix is **not** applied.
An array is refused, before anything is allocated, when it declares more than 2^28 elements or when its declared dimensions disagree with the data actually present (an ASCII `<Data>` block with too few values, or a compressed stream that expands beyond the declared size).

## Overlays

An overlay is a per-node scalar array with a name. In a web glyphset it is listed in
`overlays`; for loose files it comes from scalar files. It can be shown as the surface colour
(`overlay:<name>`), where the colour range is the 2nd to 98th percentile of the values, and
it can be sent to the Directionality workspace ("Map → Directionality"). The first overlay
whose name contains `sulc` (case-insensitive), else the first containing `curv`, is also
used for sulcal shading. Overlays are not available for datasets loaded from `.glyphset`
files.

## Output files

### `.1D` ROI

`roi.1D`: one line per node, `1` for painted nodes (any region) and `0` otherwise, followed
by a final newline. This is brainGL's / AFNI's `.1D`.

### `.1D.roi` labels

`regions.1D.roi`: one line per painted node, `<node index> <region number>`. Region numbers
start at 1, in the order in which paint colours were first used; the colours themselves are not
saved.

### `.cxls`

`connections.cxls`: weighted connexels as text, one line per connexel,
`x1 y1 z1 x2 y2 z2 value` separated by single spaces, ending in a newline (brainGL's
`Writer::saveConnexels`). Coordinates are those of the displayed surface. Numbers are written
with the fewest digits (6 to 9 significant) that reproduce the float32 value exactly; brainGL
prints 6 digits.

### `.fib`

`connections.fib` or (after bundling) `bundles.fib`: legacy VTK binary POLYDATA, big-endian:

```
# vtk DataFile Version 3.0
brainGL bundled connexels
BINARY
DATASET POLYDATA
POINTS <nPoints> float             float32 x y z per point
LINES <nLines> <nLines + nIdx>     per line: int32 count, then that many int32 point indices
CELL_DATA <nLines>
FIELD FieldData 1
CellColors 3 <nLines> unsigned_char    rgb, all 255 (white), per line
POINT_DATA <nPoints>
FIELD FieldData 1
connectivity 1 <nPoints> float         the value of the line each point belongs to
```

Each header line ends in a newline, and each binary block is followed by a newline. Up to
`LINES` the file is byte-compatible with the stand-alone bundler; the two data arrays are those
brainGL writes through `vtkPolyDataWriter`. Unbundled connexels are two-point lines. The file
can be read by brainGL, TrackVis, DSI Studio and ParaView.

### Scene files

`braingl-scene-<timestamp>.scn.json`, JSON with indentation of one space:

| Key | Content |
|---|---|
| `format` | `"braingl-web-scene"` |
| `version` | `1` |
| `dataset` | dataset name or `null` |
| `nodes` | node count; the painted regions are restored only if it matches the loaded dataset |
| `params` | the full parameter object ([Parameters](parameters.md)) |
| `cameras` | two camera states: `rotation` (quaternion `[x, y, z, w]`, world to view), `target` (mm), `halfHeight` (mm) |
| `cursorNode` | selected node, -1 if none |
| `labelColors` | array of paint colours; region `k` has colour `labelColors[k-1]` |
| `labels` | base64 text of the per-node region numbers, run-length encoded as `(value, count)` byte pairs with `count <= 255` |

Loading a scene overwrites the current parameters (missing keys take defaults). The scene
does not contain the data.

### Screenshot (PNG)

`braingl-<glyphStyle>-<timestamp>.png`: the canvas rendered at `screenshotScale` times the screen
resolution (limited to the maximum render buffer size, at most 16384 pixels on the longer side),
including the inset when it is shown; PNG, RGB, `preserveDrawingBuffer`.

### Blender bundle

A zip with `scene.json`, PLY layers, `import_braingl.py` and `README.txt`; see
[Blender scene format](blender-scene-format.md).

## Directionality inputs

The Directionality workspace reads three text files for one dataset, which refer to the same mesh
by vertex order (`src/directionality/io`; the files are read exactly as the vendored reader
expects, see [Vendored Directionality](../development/vendored-directionality.md)):

| File | Format |
|---|---|
| `.ply` | **ASCII** PLY only. Line 1 `ply`, line 2 `format ascii ...`; an `element vertex` with properties `x y z` (one token each, consecutive) and optionally `red green blue` (consecutive, 0 to 255); an `element face` with a list property; faces must be triangles (`3 a b c`). Binary PLY and polygons other than triangles raise an error. Vertex colours, when present, are the surface palette. Each vertex line is read by position, so list properties among the vertex properties are not supported. |
| `.labels` | One integer region id per mesh vertex (separators may be newlines, spaces or commas). The count must equal the vertex count. |
| `.labelorder` | Integer region ids listed in display order; the number of entries is the number of regions. Ids in `.labels` that are not listed are ignored (no direction is derived for them). |

Bundled examples are in `public/directionality/` (`label18`, `label34`, `label200`, `emb`, each as
`.ply`/`.labels`/`.labelorder`, plus `manifest.json`).

The glyph workspace writes the same three files in memory for its "→ Directionality" buttons
(`toDirectionality`): the PLY is ASCII with coordinates to 4 decimals and vertex colours (the
region colour, grey 190 for unlabelled nodes; for a map, the colour map with the 2nd to 98th
percentile as range); `.labels` holds one integer per vertex (0 for unpainted nodes, or nodes
whose map value is zero or not finite); `.labelorder` lists the used regions in increasing
order (painted regions) or `1..12` (map bins). Regions need at least two painted regions, and the bridge refuses the export
unless at least two regions share a border (a triangle with vertices in two regions), because directions are derived at
shared borders only; a map needs at least 24 non-zero values and bins that touch.
