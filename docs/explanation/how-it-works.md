# How it works

This page explains how the glyph workspace turns a connectivity matrix and a few surfaces into
pictures that you can change interactively. It is about the design, not about every control: for
formulas see [Glyph types](../reference/glyph-types.md), for numbers see
[Limits](../reference/limits.md).

## The problem

A glyph is drawn for every node and shows everything that node is connected to. With 5,000 nodes
and a threshold at a correlation of 0.5 that is already millions of primitives, and you expect to
change the threshold, the surface or the colouring while you look. brainGL solved this with a
large per-connexel vertex buffer that it rebuilt whenever something changed. The web port keeps
the data on the graphics card in a form that makes most changes free.

## Overview

```
 files / drop            CPU (TypeScript)                        GPU (WebGL2)
 ------------   --------------------------------   ---------------------------------------
 glyphset.json   load ->  GlyphDataset              position textures   (one per surface)
 or .glyphset      |        n, triangles,             RGBA32F, 1024 wide
 or loose files    |        surfaces[], overlays,           |
                   |        mask, conn (int16 n*n)          |  texelFetch by node id
                   v                                        v
            cumulative histogram  ->  budget  ->  connexel buffer: 8 bytes per instance
            (|value|, 2000 bins)     threshold    (i : u16, j : u16, value : i16)
                   |                                        |
                   |   pies: sort once by hue,              |  vertex shader per connexel:
                   |   rank pass per threshold change       |    filter  (sign, threshold,
                   |                                        |            min length)
   mouse / panel -> parameters ----- uniforms ------------> |    place   (display + glyph
        |                                                   |            geometry surfaces)
        |  ray casting (CPU) for picking, painting          |    colour  (orientation / LUT)
        |                                                   v
        +--> invalidate() -> requestAnimationFrame -> draw -> canvas (main view + inset)

 painted regions -> bake (CPU mirror of the shaders) -> PLY layers -> Blender
 "Make connections" -> Web Worker (mean-shift bundling) -> polylines -> segment buffer
```

## The matrix is held once, as int16

The dense matrix is stored as `n x n` signed 16-bit integers with one scale factor
(`value = raw * scale`, with the largest absolute value mapped to 32767). Files can be much smaller
(a symmetric matrix as `int8` upper triangle, 13 MB for the demo) but in memory the matrix is
expanded and symmetrised, `2 n^2` bytes. brainGL keeps only the lower triangle as float32
(`n(n+1)/2 * 4` bytes, about the same). The reason for int16 here is not savings but speed and
simplicity: any row is a contiguous slice that can be scanned, uploaded to a texture (little
brains), or summed (mean connectivity), with no conversion, and the same raw integers are what the
GPU receives as normalised attributes. Quantisation to 16 bits is finer than the 8-bit files the
demo is shipped as, and finer than the noise of resting-state correlations.

## Connexels are 8-byte instances

A **connexel** is a pair of nodes with a value. For the glyphs, the CPU scans the rows of the
matrix once and writes one record `(i, j, value)` per entry above the build threshold: two unsigned
16-bit node indices and one signed 16-bit value, 8 bytes with 2 bytes of padding. The record is an
*instance attribute*: the GPU draws one point (or quad, or triangle) per record with instanced
drawing, and the vertex shader reads `i` and `j`.

brainGL's `makeCons` copied for every connexel the node position, the target position and the
offsets in the glyph-geometry and colour surfaces: 13 to 28 floats, 52 to 112 bytes per connexel,
and it had to be redone whenever the surface, the geometry or the colour surface changed.

## Per-surface position textures

Nothing about *where* or *what colour* is stored in the connexel. Every surface of the dataset is
uploaded once as a floating-point texture, 1024 texels wide, one texel per node; the vertex shader
fetches `D(i)`, `G(i)`, `G(j)`, `C(i)`, `C(j)`, `L(i)` and `L(j)` by node id with `texelFetch`
(`fetchPos` in `common.glsl`). Consequently:

- choosing another **displayed surface**, **glyph geometry**, **colour surface** or **length surface**
  only changes which textures are bound: no rebuild;
- changing the **glyph scale**, rotation, lift, colour mode, colour map, alpha or point size changes
  a uniform;
- the **threshold**, **upper threshold**, **minimum length** and the **sign** test run in the shader
  (the sign also changes what the budget histogram counts, which rebuilds the buffer).

The four surfaces are independent, so the minimum-length test can use the pial surface while the
glyphs sit on the inflated one. That separation, which brainGL does not have for the length test,
is the point of the design. (The option "displayed surface (as in brainGL)" makes the length surface follow the displayed one.)

## The connexel budget and the histogram

You cannot send an arbitrary number of connexels to a GPU. brainGL asked for a *minimum threshold*
when loading the data (default 0.8 in `.glyphset` files) and ignored everything below it. The port
chooses it automatically. When the glyph nodes, sign or budget change it builds a cumulative
histogram of `abs(value)` over the rows of the glyph nodes (2000 bins, whose edges coincide with the integer limits the
builders use, so the counts are exact) and takes the smallest threshold whose count fits `budgetM` million connexels
without overshooting it. That is the **build threshold**. The
status line states it, and warns when your own threshold is lower. The same histogram is used to
report how many connexels pass. A paint region or the hemisphere selector reduces the number of
rows, so the build threshold falls and fine structure appears when you paint a small region.

## Pie glyphs

Pies need an ordering: slices are sorted by the hue of their orientation colour, so that
similar orientations are adjacent and the pie reads as a colour histogram. The sort is done once per
(colour surface, colour mode) on the CPU, for each node, by its hue of `|C(j) - C(i)|` (descending,
as brainGL does). A pie also needs to know how many slices it has and which slice a connexel is,
and both depend on the threshold. Instead of re-sorting, a linear pass (`computePieRanks`) writes,
per connexel, its rank among the node's *visible* connexels and the node's visible count. The vertex
shader draws the slice from these two numbers (angle `rank / count * 2 pi`) and discards hidden
connexels. Each slice is a triangle whose rim lies outside the circle (at `r / cos(pi / count)`) and the fragment shader
discards what is beyond the radius, so a pie is an exact disc whatever the number of slices. A threshold change thus costs one linear pass, and pies are live, where brainGL rebuilt
and re-sorted.

## Difference glyphs

The difference glyph compares two neighbouring nodes, so the unit is a mesh edge rather than a
node. For each mesh edge `(i1, i2)` and each target `j` for which either endpoint's connection
passes the prefilter threshold, a 12-byte record stores `i1, i2, j` and both raw values. The
shader computes the difference in Fisher z, `tanh(abs(atanh r1 - atanh r2))`, then filters on it.
The prefilter threshold is `max(0.5 * build threshold, 0.15 * maxAbs)`, lower than the display threshold, so that the
threshold slider acts on the *difference*, not on the connection strength; a single histogram of the stronger endpoint
value then gives the smallest threshold at or above it whose count fits the connexel budget, so the buffer never exceeds
the budget. The upper threshold is not used while building: on screen it bounds the difference. The "either endpoint" rule keeps targets where one
neighbour is strongly connected and the other weakly, which are exactly the transitions that the
glyph is for; brainGL required both endpoints to pass.

## Anatomical background glyphs

Little brains are drawn with instancing: the glyph-geometry surface's vertex, normal and sulcal
buffers are shared, and a second vertex stream, advancing once per instance, gives the node. The
vertex shader places vertex `v` of instance `k` at the node's display position plus the scaled
offset of `v` from the node on the glyph geometry. Colouring by connectivity needs the value of
the connection between the instance's node and every vertex: this is a small integer texture, one
row of the raw int16 matrix per instance, read with `texelFetch(rows, (vertex, instance))`. No
per-instance mesh is created, where brainGL kept one renderer and mesh per node.

## Picking by ray casting

Clicking a surface needs the node under the pointer. The camera is orthographic, so a pixel is a ray
parallel to the viewing direction. `pickNode` intersects the ray with every triangle of the displayed
surface of that view (Möller-Trumbore, brute force, a few hundred thousand triangles take well under a
frame), and returns the nearest vertex of the nearest triangle. Because it uses the geometry, not a
colour-coded picking pass, it works the same for any surface, in either view, with no extra
render. The brush grows along mesh edges from the picked node up to a radius in millimetres.

## Rendering on demand

The app draws only when something changed. Any change calls `invalidate()`, which schedules one
`requestAnimationFrame`; the frame function does nothing if nothing is pending. A hidden workspace
does not draw. The Directionality workspace is loaded as a separate chunk the first time it is shown.
Parameters, cameras and collapsed sections are saved to `localStorage` about 300 ms after the last
change.

The frame draws the opaque surface (with polygon offset so that glyphs near it win), the little brains,
connection lines, the glyphs (blended, depth writes only if glyph alpha is nearly 1), then a transparent
surface if requested (back faces then front faces), and finally the selection cursor on top. The inset is a
second viewport of the same canvas with its own camera and the seed-connectivity map as surface colour;
the screenshot renders the same frame at a larger size.

## The worker for bundling

Mean-shift edge bundling (`src/algorithms/meanShiftBundling.ts`, a port of the
bundler of Böttger et al., 2014) is expensive for thousands of connexels and would freeze the page. It runs in a
module Web Worker (`bundlingWorker.ts`): the connexel edge list is copied in, progress messages come back
at most every 50 ms, and the result (polylines) is transferred back without copying. The worker cannot be
interrupted while it computes; *Clear* terminates it. The algorithm follows brainGL's code rather than the
prose of the paper where they differ (marked "QUIRK" in the source).

## The Blender baker mirrors the shaders

"Export for Blender" does not read pixels. `src/export/bake.ts` repeats the placement, colour and filtering
rules of the vertex shaders on the CPU and writes the result as coloured geometry: points, tubes, wedge
triangles and meshes. It differs from the screen in the one respect that follows from having no fixed camera:
the screen lifts glyphs toward the viewer and makes pies and polar maps face it; the export lifts them along
the surface normal and lays flat glyphs in the tangent plane. Two more differences are deliberate: pies are
resampled to at most 48 wedges each, and glyph alpha is ignored (the primitives are opaque). See
[Blender scene format](../reference/blender-scene-format.md). The same code runs in Node
(`npm run export:blender`) so that the documentation's scenes can be generated without a browser.

## The Directionality workspace

The second workspace is an independent application, vendored under `src/directionality/` (see
[Vendored Directionality](../development/vendored-directionality.md)). The glyph workspace talks to it only through
the bridge (`src/bridge/toDirectionality.ts`), which writes the three text files that application reads from a
painted-region map or a surface map (12 quantile bins in value order). Directionality derives a direction field between the regions, following their order, and shows it with line-integral
convolution and arrows.
