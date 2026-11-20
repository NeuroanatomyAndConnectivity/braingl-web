# Limits

What the app can and cannot do, and where the limits come from.

## Browser requirements

- **WebGL2** is required (the glyph workspace creates a `webgl2` context and stops with
  "WebGL2 is not available in this browser." otherwise). Any current desktop version of Chrome,
  Edge, Firefox or Safari provides it.
- Glyph rendering needs 32-bit floating-point textures for node positions (`RGBA32F`) and
  integer textures (`R16I`) for little brains; both are core WebGL2. No extension is used by
  the glyph workspace.
- The **Directionality** workspace additionally needs the `EXT_color_buffer_float` extension (for
  the LIC render targets). Without it the workspace shows "Your browser does not support
  EXT_color_buffer_float; LIC requires it." and does not start.
- Bundling uses a module Web Worker; gzip-compressed GIFTI data needs `DecompressionStream`.
- Everything runs locally in the browser: no data is uploaded. The `?data=` URL parameter accepts only same-origin
  addresses (the folder must be served from the same site as the app); other addresses are ignored with a warning in
  the browser console.

## Node limit

At most **65,535 nodes** per glyphset. Connexel and node indices are stored as unsigned 16-bit
integers, and a pie sort key packs a local index into 16 bits. A larger dataset is refused with
"This dataset has N nodes; the viewer supports up to 65,535 nodes per glyphset."

The practical limit is far lower and comes from memory (next section): about 16,000 nodes on a
typical machine.

## Memory

The connectivity matrix is held **once, densely, as int16**: `2 n^2` bytes, independently of the
file's dtype or layout (the matrix is expanded from an `upper` file and symmetrised).

| Nodes `n` | Example | int16 matrix (`2 n^2`) | `int8` upper-triangle file (`n(n-1)/2`) | raw float32 file (`4 n^2`) |
|---|---|---|---|---|
| 5,124 | fsaverage4, both hemispheres (the demo) | 52.5 MB | 13.1 MB | 105 MB |
| 10,242 | fsaverage5, one hemisphere | 209.8 MB | 52.4 MB | 420 MB |
| 16,384 | | 536.9 MB | 134.2 MB | 1.07 GB |
| 20,484 | fsaverage5, both hemispheres | 839.1 MB | 209.8 MB | 1.68 GB |
| 65,535 | the node limit | 8.59 GB | 2.15 GB | 17.2 GB |

Loading adds temporary memory:

- web glyphset: the raw file (`n(n-1)/2` elements of the dtype) is read completely into memory
  next to the int16 matrix while it is converted;
- raw float32 file: streamed in 32 MB chunks; the float matrix is never held;
- `.npy`: the whole array is read first (`4 n^2` bytes for float32, `8 n^2` for float64), then converted.

Other per-dataset memory is small: surfaces take `12 n` bytes each on the CPU and `16 n` bytes
in their position texture. The cumulative histogram has 2,001 bins.

Measured by the maintainers on a development machine with a 10,242-node, single-hemisphere
glyphset (52 MB `int8` file) at the default 4 million connexel budget: loading works; about 3.7
million connexels are on the GPU; building pies takes about 155 ms; a threshold change about 30 ms;
the JavaScript heap is about 300 MB. These are single measurements, not guarantees.

## Connexel budget

All connexels above a threshold are sent to the GPU as 8-byte instances `(i, j, value)`. Their
number is bounded by the **connexel budget** (`budgetM`, 0.5 to 40 million, default 4 million). At
the start and whenever the sign, hemisphere, painted region or budget changes, the app builds the
cumulative histogram of `abs(value)` over the glyph nodes (2000 bins from 0 to the largest
absolute value) and picks the smallest threshold whose count fits the budget (it never overshoots it). Connexels below
that **build threshold** are never uploaded; the `threshold` slider can go lower but has no
effect below the build threshold, and the status line then says "threshold limited to t by the
connexel budget". Raising the budget lowers the build threshold, at the cost of memory and
frame time.

| Quantity | Cost |
|---|---|
| Points, vectors | 8 bytes per connexel on the GPU (4 M budget: 32 MB; 40 M: 320 MB). |
| Pies | The same 8 bytes (re-sorted copy), plus 4 bytes of rank per connexel, plus a CPU copy. |
| Diffpoints | 12 bytes per edge-target pair; the count is taken from one histogram of the strongest endpoint value (one bin per raw 16-bit magnitude) and the threshold is the smallest one, at or above `max(0.5 * buildThreshold, 0.15 * maxAbs)`, whose count fits the budget. |
| Little brains | A row texture of `instances * n` int16 values (200 instances at 5,124 nodes: 2 MB). |
| Position textures | One `RGBA32F` texture of width 1024 and `ceil(n / 1024)` rows per surface. |

**GPU load.** The work is done in the vertex shader. Each connexel of a point or vector glyph
performs seven position texture fetches (display position of `i`; glyph geometry of `i` and
`j`; colour surface of `i` and `j`; minimum-length surface of `i` and `j`); a pie slice
three. Frame time grows linearly with the number of connexels above the threshold. Hidden
connexels cost a vertex invocation but no fragments. Changing the surface, glyph geometry,
colour surface or colour mode needs no rebuild; changing the sign, hemisphere, glyph nodes
or budget does, and a change of the colour surface or colour mode re-sorts the pies.
Thresholds, minimum length and upper threshold are cheap (they are shader uniforms; for pies a linear
pass over the connexels recomputes the ranks).

The cumulative histogram has a resolution of `maxAbs / 2000` (about 0.0005 for correlations), which is
also the granularity of the build threshold.

## Texture and GPU limits

| Limit | Where it matters |
|---|---|
| `MAX_TEXTURE_SIZE` (commonly 8192 to 16384) | Anatomical background glyphs coloured by connectivity use a texture of `n` columns by one row per little brain. If `n` or the number of little brains exceeds the limit, the connectivity colouring is silently unavailable (little brains are drawn in the base colour). Position textures are always 1024 wide, so they are not affected. |
| `ALIASED_POINT_SIZE_RANGE` | `primSize` is capped to the largest point size the GPU supports for point glyphs and difference glyphs. Vector glyphs are quads and are not capped. |
| `MAX_RENDERBUFFER_SIZE` | The screenshot is rendered at `screenshotScale` times the screen size, reduced so that the longer side is at most this value and at most 16,384 pixels. |
| Node count `<= 65,535` | Position texture height at most 64 rows. |

## Other numeric limits

| Item | Limit | Source |
|---|---|---|
| Paint regions | 255 (one per distinct paint colour) | `paintAt` |
| Anatomical background glyphs | `lbMax` at most 2000 in the panel | slider range |
| "Make connections" | at most `maxConnexels` (100 to 40,000, default 5,000), strongest kept | `createConnexels` |
| Blender export | 400,000 primitives per layer from the browser; pies at most 48 wedges each; little brains at most `min(lbMax, floor(4e6 / n))` copies | `bake.ts`, `exportState` |
| Screenshot scale | 1 to 8 | slider range |
| `.glyphset` hemispheres | 2 | loader |

## Known upstream issue

The Directionality workspace calls `generateMipmap` on its depth texture in every frame, which WebGL2 rejects with a
console warning. It is harmless. The fix belongs in directionality-indicator-webgl and will be re-vendored.

## What is not ported from brainGL

brainGL is a general neuroimaging viewer; this app ports its connectivity-glyph and
connexel-bundling features only. Not available:

- volume data: NIfTI slices, isosurfaces, labels, the orientation helper and the whole slice
  viewer (a `.nii` or `.nii.gz` file is skipped by the loader);
- diffusion data and tensors, ODFs, spherical harmonics and fibre tracts (no tractography,
  fibre selection or fibre rendering; `.fib` files are written but not read);
- CIFTI dense connectivity (`.dconn.nii`) read directly: convert it with `tools/make_glyphset.py`
  (`from-matrix` with a `.npy` matrix);
- network (`http`) connectivity matrices in `.glyphset` files and the matrix server;
- the percentile threshold slider (`D_THRESHOLD_PERC`), copy-colours to a new mesh, the colour-map editor, and loading `.cxls` or
  `.fib` connexel files for bundling;
- lower-triangle lazy row loading of the matrix and the multi-layer depth peeling pipeline;
- surfaces with different node counts in one dataset (all surfaces share one node numbering).

See [Differences from brainGL](../explanation/differences-from-braingl.md) for the full
comparison.
