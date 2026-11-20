# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - unreleased

The first release. brainGL web brings the connectivity glyphs of brainGL (Ralph Schurade; connexel, glyph and bundling
code by Joachim Böttger) and the Directionality app (Sebastian Eichelbaum) to the web browser; the refactoring for the
browser was done by Daniel S. Margulies using Claude.

### Added

- Connectivity glyphs workspace (WebGL2 and TypeScript): point, vector, pie, difference (diffpoints) and anatomical
  background glyphs; polar projection of the sphere as glyph geometry; orientation and value colouring; four independent
  surface choices (display, glyph geometry, glyph colour, minimum-length test, which can also be the displayed surface as
  in brainGL); threshold, sign, upper threshold, minimum length and an automatic connexel budget; ten colour maps.
- Difference glyphs coloured and faded by the difference itself, with the upper threshold applied to it, and usable
  defaults when the style is selected. Glyph alpha is normalised by `max(1, maxAbs)`, so correlations use the raw value as
  in brainGL; matrices that are not correlations get colour ranges and default thresholds scaled by their maximum.
- Coupled second view with the seed-based connectivity of the selected node; tools Navigate, Seed, Paint and Erase
  with brainGL's mouse conventions (the paint modifier is Option on macOS and Ctrl elsewhere); painted regions, mean
  connectivity of a region, ROI load (`.1D`, `.rgb`, id list) and save (`.1D`, labels).
- "Make connections" with mean-shift edge bundling in a Web Worker; save `.cxls` and `.fib`.
- Data input: web glyphsets (`glyphset.json` with binaries), original brainGL `.glyphset` / `.set` / FreeSurfer `.asc` /
  float32 matrix (including the upper threshold and the second ROI), and loose files (FreeSurfer binary and GIFTI
  surfaces, `.npy` or raw float32 matrices, per-node scalars and FreeSurfer curv and sulc files as overlays);
  validation of every dataset before it reaches the GPU; drag and drop; `?data=` (same origin only) and `?workspace=`
  URL parameters.
- Screenshots at a multiple of the screen resolution; save and load of scenes (JSON, validated like a dataset);
  settings and camera views remembered per kind of dataset; console scripting API (`braingl.glyphs.setParams` and others).
- Directionality workspace (vendored directionality-indicator-webgl, LGPL) with a bridge from painted regions and from
  surface maps.
- Blender export: scene bundle (`scene.json`, PLY layers, `import_braingl.py`) from the browser or the command line
  (`npm run export:blender`, seven presets), with a camera in every scene (also for Directionality) and a fallback camera
  in the importer that frames the whole scene.
- Tools: `tools/make_glyphset.py` (`from-matrix`, `from-timeseries`, `nki-demo`, `to-braingl`) and
  `tools/vendor_directionality.py`.
- Bundled demo: group-average resting-state connectivity of 40 participants of the enhanced NKI Rockland sample on
  fsaverage4 (5,124 nodes), with credit to the data providers.
- Documentation site (MkDocs Material), a unit and property test suite on synthetic datasets, integration tests on the
  demo data (`src/integration`), tests of the baker and the scene builder, Python tests of the data tool (190 cases), Blender importer tests (72 checks) and a headless-Chrome smoke test (17 checks); about 5,700 Vitest cases run in about 5 s.

### Notes

- No version or release date has been assigned; the repository is
  <https://github.com/NeuroanatomyAndConnectivity/braingl-web>.
- Differences from brainGL are listed with their reasons in
  [Differences from brainGL](docs/explanation/differences-from-braingl.md).
- Not included: volume and NIfTI data, tractography, tensors, direct CIFTI input and the other non-glyph parts of
  brainGL; see [Limits](docs/reference/limits.md).
