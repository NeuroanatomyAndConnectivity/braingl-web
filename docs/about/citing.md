# Citing

## The software

brainGL web is a port of brainGL to the web browser. The original authors come first: brainGL was written by Ralph
Schurade; the connexel, glyph and edge-bundling code is by Joachim Böttger; the Directionality workspace is based on
DirectionalityIndicator by Sebastian Eichelbaum. Daniel S. Margulies refactored the software for the web browser using
Claude. If you use brainGL web in work that you publish, cite the paper that describes the glyphs and their
implementation in brainGL, on which the program is based:

> Böttger J, Schurade R, Jakobsen E, Schaefer A, Margulies DS (2014). Connexel visualization: a software
> implementation of glyphs and edge-bundling for dense connectivity data using brainGL. *Frontiers in
> Neuroscience* 8:15. [doi:10.3389/fnins.2014.00015](https://doi.org/10.3389/fnins.2014.00015)

To cite the web software as well, use the `CITATION.cff` file at the root of the repository (GitHub and Zenodo read
it): software **brainGL web**, authors Schurade, Böttger, Eichelbaum and Margulies, repository
<https://github.com/NeuroanatomyAndConnectivity/braingl-web>, with the paper above as the preferred citation. No
version, release date or DOI has been assigned yet; add them when you cite a specific release.

## Related papers

Cite these as they apply:

| If you used | Cite |
|---|---|
| Glyphs, in particular the polar projection of the sphere | Böttger J, Schurade R, Margulies DS (2013). Functional connectivity glyphs for brain visualization. *EuroVis Workshop on Visualization in Medicine and Life Sciences*. [doi:10.2312/PE.VMLS.VMLS2013.001-005](https://doi.org/10.2312/PE.VMLS.VMLS2013.001-005) |
| Edge bundling | Böttger J, Schäfer A, Lohmann G, Villringer A, Margulies DS (2014). Three-dimensional mean-shift edge bundling for the visualization of functional connectivity in the brain. *IEEE Transactions on Visualization and Computer Graphics* 20(3):471-480. [doi:10.1109/TVCG.2013.114](https://doi.org/10.1109/TVCG.2013.114) |
| Glyphs to parcellate a region manually | Jakobsen E, Böttger J, Bellec P, Geyer S, Rübsamen R, Petrides M, Margulies DS (2016). Subdivision of Broca's region based on individual-level functional connectivity. *European Journal of Neuroscience* 43(4):561-571. [doi:10.1111/ejn.13140](https://doi.org/10.1111/ejn.13140) |
| The Directionality workspace | The upstream project (see `src/directionality/NOTICE.md`): *DirectionalityIndicator* by Sebastian Eichelbaum and the Max Planck Research Group "Neuroanatomy and Connectivity", and <https://github.com/NeuroanatomyAndConnectivity/directionality-indicator-webgl>. |
| The demo data | Nooner KB et al. (2012). The NKI-Rockland sample: a model for accelerating the pace of discovery science in psychiatry. *Frontiers in Neuroscience* 6:152. [doi:10.3389/fnins.2012.00152](https://doi.org/10.3389/fnins.2012.00152); data from <http://fcon_1000.projects.nitrc.org/indi/enhanced/>, on the FreeSurfer fsaverage surfaces; see `NOTICE.md` for the conditions of use. |

## BibTeX

```bibtex
@article{bottger2014connexel,
  author  = {B{\"o}ttger, Joachim and Schurade, Ralph and Jakobsen, Estrid and Schaefer, Alexander and Margulies, Daniel S.},
  title   = {Connexel visualization: a software implementation of glyphs and edge-bundling for dense connectivity data using brainGL},
  journal = {Frontiers in Neuroscience},
  volume  = {8},
  pages   = {15},
  year    = {2014},
  doi     = {10.3389/fnins.2014.00015}
}
```
