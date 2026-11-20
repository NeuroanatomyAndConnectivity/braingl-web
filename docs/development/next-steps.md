# Next steps

Where the project stands after the first published version, and what to pick up next. Items are grouped by
kind and ordered roughly by value within each group. When you finish one, delete it here and add a line to
`CHANGELOG.md`.

## State at the time of writing

- The app is published at <https://neuroanatomyandconnectivity.github.io/braingl-web/> with the documentation
  under `/docs/`; the repository is <https://github.com/NeuroanatomyAndConnectivity/braingl-web>.
- Checks that pass: type-check, about 5,760 unit, property and integration tests, 190 tests of the Python
  data tool, 72 checks of the Blender import script (with the `bpy` 5.0.1 module, on macOS and on the Linux
  CI runner), and the 17-step browser smoke test (locally, and against the deployed site).
- All five CI jobs pass on GitHub's Linux runners, including the browser smoke test under software WebGL.

## To verify

1. **The Blender application.** `public/blender/import_braingl.py` was only run through the standalone `bpy`
   module, version 5.0.1. Open an exported zip in the Blender application itself (current release and 3.6 LTS)
   and follow `docs/tutorials/blender.md`; the code paths for versions before 4.1 (`loop_total`, node-group
   sockets, `use_nodes`) are written but untested. Inside the application use `--engine cycles`; the `--cycles`
   alias is consumed by the Cycles add-on there.
2. **Real drag and drop.** File loading was tested through the file-picker code path with files built in the
   page; dropping a folder from the desktop onto the view was not exercised.
3. **Numbers quoted in the tutorials.** The percentages in the glyph and parcellation tutorials (shares of
   connexels at given thresholds) and the arrow direction convention in the Directionality bridge were not
   re-derived during the last pass.

## Known defects

1. **Difference glyphs and the budget.** For difference glyphs the connexel budget sets a floor on the
   endpoint prefilter (about 0.34 for one hemisphere of the demo), which can lie above the automatic display
   threshold, so moving the threshold slider below the floor changes nothing, and unlike the other styles the
   status line shows no "threshold limited by the connexel budget" warning. Reproduce: Hemispheres "left",
   press `4`. See `ensureGlyphs` and `updateStatus` in `src/glyphs/glyphApp.ts`.
2. **Importing the Blender script as a module** with `--cycles` left in `sys.argv` fails with "ambiguous
   option"; only running it as a script strips the option.
3. **Region colours are not stored in region files.** `regions.1D.roi` holds node and region number only;
   reloading assigns colours from a fixed palette. A scene file keeps the colours.
4. **"Regions → Directionality" needs touching regions.** The direction field is derived at shared borders,
   so separate patches give an error. A useful extension: order the regions and derive directions through the
   unpainted cortex between them.

## Upstream (directionality-indicator-webgl)

1. The depth-texture `generateMipmap` call that `tools/vendor_directionality.py` removes (patch 5) should be
   removed upstream; then re-vendor and drop the patch.
2. The other four patches (panel host, programmatic `loadDataset`, no resize while hidden, data folder) could
   become upstream options so that the vendored copy needs no patching.
3. Upstream starts with the `label18` set and LIC switched off; the Blender export of the Directionality
   workspace uses a default left-lateral camera because the on-screen camera is not exposed.

## Performance and scale

1. **Software renderers.** Points and difference glyphs are drawn as instanced one-vertex primitives, which
   SwiftShader handles slowly. Drawing them with `drawArrays(POINTS)` and non-instanced attributes would help
   machines without a GPU and the CI job.
2. **More than about 16,000 nodes.** The matrix is held densely as int16 (2·n² bytes) and node ids are 16 bit.
   Whole-brain fsaverage5 (20,484 nodes) and HCP fs_LR 32k need a sparse representation built with a
   load-time threshold, as the original did, and 32-bit ids beyond 65,535 nodes.
3. **CIFTI input.** `.dconn.nii` and `.dtseries.nii` are not read; `tools/make_glyphset.py` could convert them
   (the lab's `glyphsets` scripts show the Workbench steps).
4. **Level of detail.** The 2013 paper suggests simpler glyph representations when glyphs are small on screen;
   nothing of the kind exists yet.
5. **Worker for rebuilds.** Connexel builds run on the main thread (about 0.15 s at 10,000 nodes); moving
   them to a worker would keep the interface responsive for larger data.

## Features of brainGL not ported

Volume slices and NIfTI overlays, the "mri" surface colour mode, the perspective camera, the colour-map
editor, the scripting and animation system, fibre and tensor datasets, weighted edge bundling, and remote
(HTTP) connectivity matrices. `docs/explanation/differences-from-braingl.md` has the full comparison.

## Blender export

1. Glyph alpha is not exported, and pies are resampled to at most 48 wedges.
2. EEVEE draws geometry-nodes point clouds as small diamonds, Cycles as spheres; `--points mesh` gives the
   same geometry in both at the cost of larger scenes.
3. A turntable or camera-path helper would make the Blender route more useful for talks.

## Documentation and release

1. **Reproducible figures.** The screenshots were taken with a headless-Chrome helper that is not in the
   repository. Commit a script (for example `tools/docs_screenshots.mjs`, reusing the launch code of
   `tests/e2e/smoke.mjs`) that regenerates every image in `docs/images/` from a list of scenes.
2. **First release.** Tag `v0.1.0`, add the version and date to `CITATION.cff` and `CHANGELOG.md`, and
   consider archiving the release on Zenodo for a citable DOI.
3. **Homotopy on fsaverage.** The integration tests found that node `i + leftNodes` is not the homotopic
   partner of node `i` on fsaverage (median correlation 0.22, against 0.54 for the mirror-nearest pial node).
   The polar projection centres the opposite hemisphere's disc by mirroring the sphere coordinate, which does
   not depend on node order, but any future feature that needs homotopic pairs should use a geometric mapping.
4. **A higher-resolution demo.** A single-hemisphere fsaverage5 set (10,242 nodes, 52 MB) works well and can
   be built with `python tools/make_glyphset.py nki-demo --mesh fsaverage5 --hemi lh`; it is not bundled
   because of its size. Hosting it as a release asset and loading it with `?data=` would need cross-origin
   loading to be allowed for a trusted list of hosts.
