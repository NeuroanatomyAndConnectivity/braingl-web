# Background

## Connexels

The word *connexel* was introduced (Worsley et al., as cited by Böttger et al., 2014) for the basic unit of brain
connectomics: the relationship between two three-dimensional positions, in the way a pixel is a
point of a 2-D image. For cortical surface data a connexel is a pair of surface nodes with a value,
usually a correlation between their time series, so a dense connectivity matrix of `n` nodes holds
`n (n - 1) / 2` distinct connexels for a symmetric measure. At 5,000 nodes that is 12.5 million; at
the 32,000 nodes of a standard cortical surface about 500 million.

Connectivity is difficult to look at because it is relational and dense. Drawing every connexel as a
straight line between its two nodes (the usual display for a graph) produces an unreadable cloud once the
number of connexels is large; the structure of the data cannot be seen. Two approaches in brainGL, and in
this app, address this.

## Why glyphs

A **connectivity glyph** takes the opposite view: instead of drawing connections between positions, it
draws, *at each node*, a small picture of that node's whole connectivity profile. Each connexel becomes
one coloured primitive in the little space around its node: a point, a line, a slice of a pie, a point on a
map of the sphere. Your eye can then compare the profile of one node with its neighbours' and see where it
changes, which is what you need to find areas, borders and gradients. The glyphs are drawn directly on the
surface, so the anatomy stays in view.

The two parts of a glyph are *where* the primitive goes and *what colour* it has. Position encodes where the
connection goes, by scaling the position of the target relative to the node into the glyph (so the glyph is a
small copy of the surface, or a map of the sphere); colour encodes the orientation of the connection, the
direction from node to target mapped to red, green and blue like the principal diffusion direction in DTI, or
its strength via a colour map. Orientation colour makes large networks visible at once: the motor cortex
shows as a belt of red because of its strong connections to the opposite hemisphere, the visual cortex as red
and blue. The five glyph types of the 2014 paper (points, vectors, pies, difference glyphs and anatomical background glyphs) trade
off compactness, anatomical fidelity and the ability to show differences between neighbours. See
[Glyph types](../reference/glyph-types.md).

Glyphs were first described, with the polar projection of the sphere that avoids overlap altogether, by
Böttger, Schurade and Margulies (2013), and implemented with the other glyph types in brainGL (Böttger et al.,
2014). Jakobsen and colleagues (2016) applied them to the manual parcellation of the cortex, which is the
workflow of the painting tools in this app; see the [parcellation tutorial](../tutorials/parcellation.md).

## Why bundling

Edge bundling is the second answer to the clutter of straight lines. It groups geometrically similar
connections into bundles that share space in their middle section and fan out at their ends, as in
hierarchical edge bundling for software graphs. In three dimensions, with the dense and
uneven distribution of functional connectivity, the mean-shift method of Böttger and colleagues (2014) moves
the points of subdivided edges toward each other when the edges are compatible (a measure built from
length, angle, distance and position of the edges), so that bundles of very different density bundle
evenly. The result shows the large-scale pathways of a thresholded graph. It is computationally much more
expensive than the glyphs, which is why it is a separate, deliberate step ("Bundle") and runs in a worker.
See the [bundling tutorial](../tutorials/bundling.md).

Glyphs and bundles complement each other. Glyphs show every node's profile at once and respond in real
time to the threshold; bundles show the long-range structure of the strongest connections. brainGL web
implements both, on surfaces, with the same method and parameters as brainGL.

## Citations

The papers on which this software is based, with DOI:

- Böttger J, Schurade R, Jakobsen E, Schaefer A, Margulies DS (2014). Connexel visualization: a
  software implementation of glyphs and edge-bundling for dense connectivity data using brainGL.
  *Frontiers in Neuroscience* 8:15.
  [doi:10.3389/fnins.2014.00015](https://doi.org/10.3389/fnins.2014.00015)
- Böttger J, Schurade R, Margulies DS (2013). Functional connectivity glyphs for brain visualization.
  *EuroVis Workshop on Visualization in Medicine and Life Sciences (VMLS)*.
  [doi:10.2312/PE.VMLS.VMLS2013.001-005](https://doi.org/10.2312/PE.VMLS.VMLS2013.001-005)
- Böttger J, Schäfer A, Lohmann G, Villringer A, Margulies DS (2014). Three-dimensional mean-shift edge
  bundling for the visualization of functional connectivity in the brain. *IEEE Transactions on
  Visualization and Computer Graphics* 20(3):471-480.
  [doi:10.1109/TVCG.2013.114](https://doi.org/10.1109/TVCG.2013.114)
- Jakobsen E, Böttger J, Bellec P, Geyer S, Rübsamen R, Petrides M, Margulies DS (2016). Subdivision of
  Broca's region based on individual-level functional connectivity. *European Journal of
  Neuroscience* 43(4):561-571. [doi:10.1111/ejn.13140](https://doi.org/10.1111/ejn.13140)
- Margulies DS, Böttger J, Watanabe A, Gorgolewski KJ (2013). Visualizing the human connectome.
  *NeuroImage* 80:445-461.
  [doi:10.1016/j.neuroimage.2013.04.111](https://doi.org/10.1016/j.neuroimage.2013.04.111)
- Nooner KB et al. (2012). The NKI-Rockland sample: a model for accelerating the pace of discovery science in psychiatry. *Frontiers in Neuroscience* 6:152. [doi:10.3389/fnins.2012.00152](https://doi.org/10.3389/fnins.2012.00152) (the data of the bundled demo; see `NOTICE.md` at the repository root).

The original program is brainGL (C++/Qt/OpenGL, MIT licence, copyright 2012 Ralph Schurade; the glyph code is by
Joachim Böttger), archived at <https://code.google.com/archive/p/braingl/>.

## Reading list

1. Böttger et al. (2014), *Frontiers in Neuroscience*, above: the glyph types, the thresholding strategy and
   the brainGL implementation. Start here.
2. Böttger et al. (2013), above: the glyph idea and the polar projection.
3. Böttger et al. (2014), *IEEE TVCG*, above: the bundling algorithm.
4. Margulies et al. (2013), above: a review of connectome visualisation tools.
5. Jakobsen et al. (2016), above: glyphs applied to a parcellation problem.
6. The wiki pages of the original brainGL project (GlyphTutorial, SurfaceConnectivity, ConnectionBundling),
   which the tutorials of this site follow.
7. Worsley et al., cited in the 2014 paper for the introduction of the term connexel (see its reference list).
