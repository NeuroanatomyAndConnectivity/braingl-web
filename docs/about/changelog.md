# Changelog

This page mirrors `CHANGELOG.md` at the repository root. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - unreleased

### Added

- Connectivity glyphs workspace (WebGL2 and TypeScript): point, vector, pie, difference (diffpoints) and anatomical
  background glyphs; polar projection of the sphere as glyph geometry; orientation and value colouring; four independent
  surface choices (display, glyph geometry, glyph colour, minimum-length test); threshold, sign, upper threshold,
  minimum length and an automatic connexel budget; ten colour maps.
- Coupled second view with the seed-based connectivity of the selected node; tools Navigate, Seed, Paint and Erase
  with brainGL's mouse conventions; painted regions, mean connectivity of a region, ROI load (`.1D`, `.rgb`, id list)
  and save (`.1D`, labels).
- "Make connections" with mean-shift edge bundling in a Web Worker; save `.cxls` and `.fib`.
- Data input: web glyphsets (`glyphset.json` with binaries), original brainGL `.glyphset` / `.set` / FreeSurfer `.asc` /
  float32 matrix, and loose files (FreeSurfer binary and GIFTI surfaces, `.npy` or raw float32 matrices, per-node
  scalars as overlays); drag and drop; `?data=` and `?workspace=` URL parameters.
- Screenshots at a multiple of the screen resolution; save and load of scenes (JSON); settings stored in the browser;
  console scripting API (`braingl.glyphs.setParams` and others).
- Directionality workspace (vendored directionality-indicator-webgl, LGPL) with a bridge from painted regions and from
  surface maps.
- Blender export: scene bundle (`scene.json`, PLY layers, `import_braingl.py`) from the browser or the command line
  (`npm run export:blender`, seven presets).
- Tools: `tools/make_glyphset.py` (`from-matrix`, `from-timeseries`, `nki-demo`, `to-braingl`) and
  `tools/vendor_directionality.py`.
- Bundled demo: group-average resting-state connectivity of 40 participants of the enhanced NKI Rockland sample on
  fsaverage4 (5,124 nodes).
- Documentation site (MkDocs Material) and a unit test suite.

### Not included

Volume and NIfTI data, tractography, tensors, direct CIFTI input and the other non-glyph parts of brainGL; see
[Limits](../reference/limits.md).
