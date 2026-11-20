# Notice

## Authors and origin

**brainGL web** brings the surface-connectivity and connectivity-glyph part of
**brainGL** to the web browser. brainGL is the C++/Qt/OpenGL brain
visualization tool written by **Ralph Schurade**; its connexel, connectivity
glyph and edge-bundling methods and code are by **Joachim Böttger**, developed
with Estrid Jakobsen, Alexander Schäfer and colleagues at the Max Planck
Institute for Human Cognitive and Brain Sciences, Leipzig. The methods are
theirs; please cite their papers (below) when you use this software.

The refactoring for the web browser (TypeScript and WebGL2) was done in 2026 by
Daniel S. Margulies using Claude.

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
written for the web version. This part of the repository is released under
the MIT licence (see `LICENSE`), as the original.

## Vendored component: Directionality workspace (LGPL)

`src/directionality/` and `public/directionality/` are a copy of
**directionality-indicator-webgl**
(<https://github.com/NeuroanatomyAndConnectivity/directionality-indicator-webgl>),
itself a web version of **DirectionalityIndicator** by **Sebastian Eichelbaum**
and the Max Planck Research Group "Neuroanatomy and Connectivity". It is licensed
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
FreeSurfer (Fischl, Sereno, Tootell & Dale 1999, *Human Brain Mapping*
8:272–284; <https://surfer.nmr.mgh.harvard.edu>). It contains no
individual-level data. We thank the Nathan Kline Institute, the participants
of the Rockland Sample and the 1000 Functional Connectomes Project /
International Neuroimaging Data-sharing Initiative for making the data openly
available. If you use the demonstration data, please credit the enhanced NKI
Rockland Sample (Nooner et al. 2012) as its source.

## Third-party software

- [gl-matrix](https://glmatrix.net) (MIT)
