# License

This page is a summary. The binding texts are `LICENSE` and `NOTICE.md` at the repository root, which are
maintained by the project maintainer; read them for the exact terms.

| Part | Licence |
|---|---|
| Everything in the repository except the two rows below | MIT (the licence of the original brainGL). Copyright 2026 Daniel S. Margulies and the brainGL web contributors; the glyph code derives from brainGL, copyright 2012 Ralph Schurade. |
| `src/directionality/` and `public/directionality/` | GNU Lesser General Public License v3 or later, a vendored copy of directionality-indicator-webgl (see [Vendored Directionality](../development/vendored-directionality.md)). Licence texts in `src/directionality/LICENSE` and `LICENSE.LESSER`. |
| `gl-matrix` (the only runtime dependency) | MIT; listed in `NOTICE.md` under third-party software. |
| `public/data/nki_fsaverage4/` | Derived from the enhanced NKI Rockland Sample group average; see `NOTICE.md` for the source, the citation and the conditions of use. |

`LICENSE` states that the MIT licence covers everything except `src/directionality/` and the data files in `public/directionality/`, which are LGPL-3.0-or-later. `NOTICE.md` also records the origin of the code: which files follow brainGL's C++ sources and the bundler, and which
ideas come from vidview.

In practice: you can use, change and redistribute the application under the MIT licence; if you redistribute it
with the Directionality workspace, keep that folder's licence files and respect the LGPL for modifications to that
folder. How to cite is described in [Citing](citing.md).
