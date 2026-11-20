# Architecture

## Source tree

```
index.html                  page shell, styles of the top bar and workspaces
src/
  main.ts                   boot: workspaces, tabs, Blender export, URL parameters (?workspace=, ?data=),
                            "Docs" link (production builds only), window.braingl
  directionalityWorkspace.ts  lazy entry to the vendored Directionality app
  glyphs/                   the Connectivity glyphs workspace
    glyphApp.ts               GlyphApp: state, events, panel, pipeline control, export hooks
    params.ts                 GlyphParams and defaults (the parameter keys), `valueUnit` (scale of thresholds for
                              non-correlation matrices), `lengthSurfaceIndex` (-1 = displayed surface)
    builders.ts               CPU side: connexel buffers, pie sort and ranks, diff records,
                              "make connections", mean connectivity
    picking.ts                ray-triangle picking, brush growth, mean edge length
    roiRegions.ts             regions of a loaded ROI file -> labels and paint colours (`assignRoiRegions`)
  render/                   WebGL2 drawing of the glyph workspace
    renderer.ts               GlyphRenderer: GPU resources, VAOs, draw order, uniforms
    cursorVisibility.ts       whether the selection cross-hair's node can be seen (hemisphere, normal, ray test)
    shaders.ts                imports the GLSL files as raw strings and resolves "#include common"
    colormaps.ts              colour maps as 256-entry lookup tables
  shaders/                  GLSL ES 3.00 (one file per stage and glyph type)
    common.glsl               uniforms, fetchPos, passes, polarOffset, glyphPoint, glyphColor
    points / vectors / pies / diff .vert.glsl, prims.frag.glsl   glyph styles
    littlebrain.vert/.frag.glsl   anatomical background glyphs
    surface.vert/.frag.glsl       the displayed surface
    segments.vert.glsl            connexel and bundle lines
    marker.vert/.frag.glsl        selection cross-hair (drawn on top, only when cursorVisibility says so)
  gfx/
    gl.ts                     Program wrapper (cached uniform lookup), data textures, buffers
    camera.ts                 orthographic quaternion trackball in millimetres
  data/                     data model and loading
    dataset.ts                GlyphDataset, mesh topology, normals, winding, sphere detection, `validateDataset`
                              (structural checks that every loader runs before data reach the GPU)
    connMatrix.ts             ConnMatrix (dense int16), histogram, budget threshold
    loadWeb.ts                web glyphset manifest and binaries
    loadFiles.ts              file-drop dispatch: web / brainGL / loose files
  io/                       file formats, no DOM dependency
    freesurferAsc.ts  freesurferBinary.ts  gifti.ts  npy.ts  glyphsetFiles.ts   (+ index.ts)
  algorithms/               bundling and connexel files
    meanShiftBundling.ts      the 3-D mean-shift bundler (pure, dependency-free)
    bundlingWorker.ts         Web Worker wrapper
    connexelFiles.ts          .cxls and .fib reader/writers
  export/                   Blender export
    bake.ts                   CPU mirror of the shaders: glyphs as coloured geometry
    directionalityBake.ts     Directionality scene as geometry
    sceneFromDataset.ts       GlyphParams to GlyphBakeInput without a UI (CLI and tests); applies the same
                              defaults, budget and thresholds as GlyphApp
    blenderBundle.ts          scene.json and zip assembly; `defaultSceneCamera` (left-lateral view framing all
                              layers, used for Directionality scenes)
    ply.ts                    binary PLY writer, stored-zip writer, CRC-32
  bridge/toDirectionality.ts  painted regions or surface map to .ply/.labels/.labelorder text
  ui/panel.ts               declarative side panel (sliders, selects, buttons, collapsible sections); slider
                            limits and steps can be functions of the loaded data (`niceStep`, `stepDigits`)
  directionality/           VENDORED upstream app (LGPL-3.0-or-later); see Vendored Directionality
    app.ts  gfx/  io/  algorithms/  shaders/  ui/  directionality.css  LICENSE*  NOTICE.md  VENDORED.md
tools/
  make_glyphset.py          glyphset creation and conversion (Python)
  blenderExport.ts, export_blender.ts   Node command-line Blender export
  vendor_directionality.py  re-vendors the Directionality app
public/
  data/nki_fsaverage4/      the demo glyphset
  directionality/           bundled Directionality datasets
  blender/import_braingl.py the Blender import script (also copied into every bundle)
docs/                       this site (MkDocs Material)
tests/                      end-to-end (`e2e/`), Python (`python/`) and Blender (`blender/`) tests
```

Test files sit next to the code they test as `*.test.ts` (see [Testing](testing.md)).

## Data flow: from file drop to pixels

1. **Drop or pick.** `GlyphApp.loadFiles` collects the files (walking dropped folders) and calls
   `loadFromFiles` (`data/loadFiles.ts`). It tries, in order, a web manifest (`loadWebGlyphset`),
   a `.glyphset` (`io/glyphsetFiles.ts`, `io/freesurferAsc.ts`) and loose files (`io/gifti.ts`,
   `io/npy.ts`, `io/freesurferBinary.ts`). The result is a `GlyphDataset`: node count, triangles,
   surfaces with identical numbering, overlays, a mask and a `ConnMatrix`.
2. **Dataset set-up.** Each loader ends in `validateDataset`. `GlyphApp.setDataset(ds, roi, minThreshold, maxThreshold, targets)` (the last three come from a `.glyphset` file) builds the mesh topology (adjacency and unique edges),
   finds the sphere, derives default surfaces, glyph scale and threshold, and calls
   `GlyphRenderer.setDataset`, which uploads each surface as a position texture and its normals. Settings and camera views are remembered per dataset signature (node count and surface names; `localStorage` key `braingl.glyphs.dataset`).
3. **Glyph build** (`ensureGlyphs`, lazily, on the next frame). When the glyph nodes, hemisphere, sign or
   budget changed: cumulative histogram, build threshold, then `buildConnexels`
   (or `buildDiffConnexels`, or `sortForPies` plus `computePieRanks`), then `GlyphRenderer.setConnexels`
   (`setPies`, `setDiff`). Nothing is rebuilt for changes that only affect uniforms.
4. **Parameters to uniforms.** `GlyphApp.drawState` turns `GlyphParams` into a `DrawState`;
   `GlyphRenderer.glyphUniforms` sets the uniforms of `common.glsl`.
5. **Draw.** `frame()` runs when `invalidate()` has been called: surface, little brains, segments, glyphs,
   transparent surface, cursor (only if its node can be seen in that view, `cursorVisible`); once for the main
   view and once for the inset.
6. **Interaction.** Pointer events go through `bindEvents`; `pickAt` casts a ray with `Camera.ray` and
   `pickNode`; `selectNode` writes the seed row to a vertex attribute buffer; `paintAt` edits the label array.
7. **Export.** `exportState()` snapshots the state (including the build threshold, the budget and the target mask, which the baker needs to select the same primitives as the screen); `bakeGlyphScene` produces layers; `buildBundleZip` packs them. `sceneFromDataset` builds the same snapshot without a UI.

## URL parameters and deployment

`?workspace=glyphs|directionality` selects the workspace at start-up. `?data=<folder>/` loads the web glyphset at that
URL (relative to the page) instead of the bundled demo `data/nki_fsaverage4/`; `public/data/local/` is git-ignored for
local data. The top bar's "Docs" link is visible only in production builds and points to `docs/` next to the app: the
Pages workflow (`.github/workflows/deploy.yml`) publishes the app at the site root and the MkDocs build under `/docs/`.

## How to add a glyph style

1. Add the name to `GlyphStyle` in `src/render/renderer.ts` and to the `glyphStyle` select and the key map
   in `buildPanel` / `bindEvents` of `glyphApp.ts`.
2. Write `src/shaders/<name>.vert.glsl` starting with `#version 300 es` and `#include common`; use
   `fetchPos`, `passes`, `glyphCenter`, `glyphPoint` and `glyphColor` so the filters, surfaces, polar projection
   and colour modes work automatically. Register it in `src/render/shaders.ts` (import with `?raw`, add to
   `SHADERS`).
3. Describe the per-instance data layout. If it is the 8-byte connexel, reuse `connexelAttribs`; otherwise add a
   builder in `glyphs/builders.ts` and a `set<Name>` method with a VAO in `renderer.ts`.
4. Add the draw branch in `GlyphRenderer.draw` and, if it needs state, a field in `DrawState`/`drawState`.
5. Decide what must be rebuilt for each parameter in `afterChange` and `ensureGlyphs`.
6. Mirror the placement in `src/export/bake.ts` (`bakeGlyphs`) so Blender export works.
7. Add tests next to the builder, and update [Glyph types](../reference/glyph-types.md) and
   [Parameters](../reference/parameters.md).

## How to add a colour map

Add an entry to `MAPS` in `src/render/colormaps.ts`: an array of stops `[position, r, g, b]`, positions rising from 0
to 1, colours 0 to 1. It appears in the panel automatically (`COLORMAP_NAMES`). Document it in the colour-map table of
[Parameters](../reference/parameters.md#colour-maps).

## How to add an input format

1. Put the parser in `src/io/` as a pure function (no DOM), export it from `src/io/index.ts`, and add a unit test
   with a small fixture.
2. Hook it up in `readMesh` / `readMatrix` or the loose-file loop of `loadFiles.ts`, choosing the file by extension or
   by magic bytes as the other formats do.
3. Return `TriMesh` (positions and triangles), a `ConnMatrix` (`ConnMatrix.fromFull`, `fromUpper`, or a streamed
   reader) or per-node scalars.
4. Document the format and the detection rule in [Data formats](../reference/data-formats.md).

Output formats follow the same pattern in `src/algorithms/connexelFiles.ts` or `src/io/glyphsetFiles.ts`.

## Conventions

- **TypeScript in strict mode** (`tsconfig.json`: `strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`); `npm run typecheck` must pass.
- **No runtime dependencies other than `gl-matrix`.** Everything else (GIFTI, NPY, FreeSurfer readers, PLY and
  ZIP writers, the bundler) is in the repository.
- **Shaders live in `.glsl` files** imported as raw strings (`import src from "...glsl?raw"`); shared code is
  pulled in with the one directive `#include common`, resolved textually in `render/shaders.ts`.
- Data-handling code (`io/`, `algorithms/`, `export/` except where noted) does not touch the DOM, so it runs in
  workers, Node scripts and tests.
- Positions are millimetres, RAS (x right, y anterior, z superior); matrices are row-major.
- The vendored `src/directionality/` is not edited by hand.
- British-neutral spelling in comments and docs; no emojis.
