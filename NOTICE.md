# Notice

## What this is derived from

**brainGL web** is a TypeScript + WebGL2 port of the surface-connectivity and
connectivity-glyph part of **brainGL**, the C++/Qt/OpenGL brain visualization
tool written by Ralph Schurade, with the connexel, glyph and edge-bundling
code by Joachim Böttger, at the Max Planck Institute for Human Cognitive and
Brain Sciences, Leipzig.

- Original source: <https://code.google.com/archive/p/braingl/> (MIT licence,
  © 2012 Ralph Schurade)
- Glyphs: Böttger J, Schurade R, Margulies DS (2013). Functional connectivity
  glyphs for brain visualization. *EuroVis Workshop on Visualization in
  Medicine and Life Sciences*. <https://doi.org/10.2312/PE.VMLS.VMLS2013.001-005>
- Software: Böttger J, Schurade R, Jakobsen E, Schaefer A, Margulies DS (2014).
  Connexel visualization: a software implementation of glyphs and
  edge-bundling for dense connectivity data using brainGL. *Frontiers in
  Neuroscience* 8:15. <https://doi.org/10.3389/fnins.2014.00015>
- Edge bundling: Böttger J, Schäfer A, Lohmann G, Villringer A, Margulies DS
  (2014). Three-dimensional mean-shift edge bundling for the visualization of
  functional connectivity in the brain. *IEEE Transactions on Visualization
  and Computer Graphics* 20(3):471–480. <https://doi.org/10.1109/TVCG.2013.114>

The glyph shaders (`src/shaders/`), the glyph builders
(`src/glyphs/builders.ts`), the reading of the `.glyphset` / `.set` / ROI
files (`src/io/glyphsetFiles.ts`) and the mean-shift edge bundling
(`src/algorithms/meanShiftBundling.ts`) follow the original C++ sources
(`datasetglyphset.cpp`, `points.vs`, `vectors.vs`, `pies.vs`,
`diffpoints.vs`, `littlebrainrenderer.cpp`, `loader.cpp`, `algos/`), and the
bundler of <https://github.com/NeuroanatomyAndConnectivity/brainbundler>. The
separate surface for the minimum-length test and the projection glyph take
their cue from the earlier viewer
<https://github.com/NeuroanatomyAndConnectivity/vidview>. Everything else was
written for this port. This part of the repository is released under the MIT
licence (see `LICENSE`), as the original.

## Vendored component: Directionality workspace (LGPL)

`src/directionality/` and `public/directionality/` are a copy of
**directionality-indicator-webgl**
(<https://github.com/NeuroanatomyAndConnectivity/directionality-indicator-webgl>),
itself a port of **DirectionalityIndicator** by Sebastian Eichelbaum and the
Max Planck Research Group "Neuroanatomy and Connectivity". It is licensed
under the **GNU Lesser General Public License v3 or later**; its licence texts
and notice are in `src/directionality/`. The copy is made by
`tools/vendor_directionality.py`, which applies a few mechanical patches
listed in `src/directionality/VENDORED.md`; the patched files remain under the
LGPL. The complete corresponding source is this repository.

## Demonstration data

`public/data/nki_fsaverage4/` is a group-average resting-state functional
connectivity matrix computed with `tools/make_glyphset.py nki-demo` from the
surface-projected data of 40 participants of the **enhanced Nathan Kline
Institute – Rockland Sample** (Nooner et al. 2012, *Frontiers in Neuroscience*
6:152, <https://doi.org/10.3389/fnins.2012.00152>;
<http://fcon_1000.projects.nitrc.org/indi/enhanced/>), as distributed through
`nilearn.datasets.fetch_surf_nki_enhanced`, on the **fsaverage4** surfaces of
FreeSurfer (Fischl et al. 1999). It contains no individual-level data. Use of
the underlying data is subject to the terms of those projects.

## Third-party software

- [gl-matrix](https://glmatrix.net) (MIT)
