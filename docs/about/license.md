# License

This page is a summary. The binding texts are `LICENSE` and `NOTICE.md` at the repository root; read them for the
exact terms.

## Who wrote what

brainGL web brings the connectivity glyphs of brainGL to the web browser. The original work belongs to its authors:
brainGL was written by Ralph Schurade (MIT licence, copyright 2012); the connexel, connectivity glyph and edge-bundling
methods and code are by Joachim Böttger, developed with Estrid Jakobsen, Alexander Schäfer and colleagues at the Max
Planck Institute for Human Cognitive and Brain Sciences in Leipzig; the Directionality workspace is a vendored copy of
directionality-indicator-webgl, a web version of DirectionalityIndicator by Sebastian Eichelbaum. Daniel S. Margulies
refactored the software for the web browser in 2026 using Claude. The methods are those of the original authors, so
cite their papers; see [Citing](citing.md).

## Licences by part

| Part | Licence |
|---|---|
| Everything in the repository except the rows below | MIT, the licence of the original brainGL. `LICENSE` lists the copyright of Ralph Schurade (brainGL, 2012) and of the brainGL authors including Joachim Böttger, and notes the refactoring for the web browser by Daniel S. Margulies using Claude. |
| `src/directionality/` and `public/directionality/` | GNU Lesser General Public License v3 or later, a vendored copy of directionality-indicator-webgl (see [Vendored Directionality](../development/vendored-directionality.md)). Licence texts in `src/directionality/LICENSE` and `LICENSE.LESSER`. |
| `gl-matrix` (the only runtime dependency) | MIT; listed in `NOTICE.md` under third-party software. |
| `public/data/nki_fsaverage4/` | A group average of 40 participants of the enhanced Nathan Kline Institute Rockland Sample (Nooner et al. 2012, [doi:10.3389/fnins.2012.00152](https://doi.org/10.3389/fnins.2012.00152); <http://fcon_1000.projects.nitrc.org/indi/enhanced/>), computed on the FreeSurfer fsaverage4 surfaces (Fischl et al. 1999). It is redistributed with credit to the Nathan Kline Institute, the participants of the Rockland Sample and the 1000 Functional Connectomes Project and International Neuroimaging Data-sharing Initiative. It contains no individual-level data, and its use is subject to the terms of those projects. |

`LICENSE` states that the MIT licence covers everything except `src/directionality/` and the data files in
`public/directionality/`, which are LGPL-3.0-or-later. `NOTICE.md` records the origin of the code (which files follow
brainGL's C++ sources and the bundler, and which ideas come from vidview), the vendored component and the
demonstration data.

In practice: you can use, change and redistribute the application under the MIT licence; if you redistribute it
with the Directionality workspace, keep that folder's licence files and respect the LGPL for modifications to that
folder. If you use the demo data in a publication, cite Nooner et al. (2012). How to cite is described in
[Citing](citing.md).
