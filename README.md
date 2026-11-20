# brainGL web

brainGL web shows dense brain connectivity on cortical surfaces in the browser. Given surface
meshes and a node-by-node connectivity matrix, it draws a glyph at every node that summarises
all connections of that node, so that changes of the connectivity profile across the cortex
become visible. It is a WebGL2 / TypeScript port of the connectivity-glyph part of
[brainGL](https://code.google.com/archive/p/braingl/) (Böttger, Schurade, Jakobsen, Schaefer &
Margulies 2014). Data are read by the browser and never leave your computer.

![Pie glyphs on the inflated surface, seed-based connectivity in the second view](docs/images/hero.png)

## Features

- Glyph styles: points, vectors, pies, difference glyphs, anatomical background glyphs ("little brains")
- Glyph geometry from any surface or a polar projection of the sphere; colour by orientation or by value
- Live threshold, sign, upper threshold and minimum connection length
- Second, coupled view with the seed-based connectivity of the selected node
- Painted regions: glyphs restricted to a region, mean connectivity, load and save of ROIs
- "Make connections" and mean-shift edge bundling; save `.cxls` and `.fib`
- Screenshots at a multiple of the screen resolution, scene files, scripting from the console
- Export of the scene for Blender

## Quick start

Requires Node.js 20 or newer and a browser with WebGL2.

```bash
npm install
npm run dev
# open http://localhost:5173
```

The demo data (group-average resting-state connectivity of 40 participants of the enhanced NKI
Rockland sample, fsaverage4, 5,124 nodes) load automatically. `npm run build` writes a static
site to `dist/`.

## Two workspaces

- **Connectivity glyphs**: surfaces and a dense connectivity matrix as glyphs, connections and bundles.
- **Directionality**: the vendored
  [directionality-indicator-webgl](https://github.com/NeuroanatomyAndConnectivity/directionality-indicator-webgl)
  app (arrows and line integral convolution on a parcellated surface). Painted regions and
  surface maps can be sent to it from the glyph workspace.

## Documentation

The documentation is in [`docs/`](docs/index.md) (MkDocs Material; `pip install mkdocs-material`,
then `mkdocs serve`). Start with the [quick start](docs/getting-started/quickstart.md), the
[glyph tutorial](docs/tutorials/glyphs.md) and [your own data](docs/tutorials/own-data.md).

## Data it accepts

Open files, open a folder, or drag and drop:

1. a web glyphset: `glyphset.json` plus binary files, written by `tools/make_glyphset.py`;
2. an original brainGL glyphset: `.glyphset`, `.set`, FreeSurfer `.asc` surfaces and a float32 matrix;
3. loose files: surfaces (GIFTI `.surf.gii`, FreeSurfer binary or `.asc`) per hemisphere and a
   square matrix (`.npy` or raw float32), optionally per-node scalars.

At most 65,535 nodes; in practice about 16,000, because the matrix is held in memory as int16
(2·n² bytes). No volumes, fibre tracts or direct CIFTI input. See
[data formats](docs/reference/data-formats.md) and [limits](docs/reference/limits.md).

## Blender export

**Export for Blender** downloads a zip with `scene.json`, one PLY per layer and
`import_braingl.py`. Run `blender --python import_braingl.py` in the unzipped folder, or export
the example scenes without a browser:

```bash
npm run export:blender -- --all --out examples/blender
```

See the [Blender tutorial](docs/tutorials/blender.md).

![Bundled connections rendered in Blender](docs/images/blender-bundles.png)

## Tests

```bash
npm test             # unit tests
npm run typecheck    # TypeScript
npm run build        # production build
```

See [testing](docs/development/testing.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Citing

- Böttger J, Schurade R, Jakobsen E, Schaefer A, Margulies DS (2014). Connexel visualization: a
  software implementation of glyphs and edge-bundling for dense connectivity data using brainGL.
  *Front. Neurosci.* 8:15. [doi:10.3389/fnins.2014.00015](https://doi.org/10.3389/fnins.2014.00015)
- Böttger J, Schurade R, Margulies DS (2013). Functional connectivity glyphs for brain
  visualization. *EuroVis VMLS*. [doi:10.2312/PE.VMLS.VMLS2013.001-005](https://doi.org/10.2312/PE.VMLS.VMLS2013.001-005)
- Böttger J et al. (2014). Three-dimensional mean-shift edge bundling for the visualization of
  functional connectivity in the brain. *IEEE TVCG* 20(3):471-480. [doi:10.1109/TVCG.2013.114](https://doi.org/10.1109/TVCG.2013.114)
- Jakobsen E et al. (2016). Subdivision of Broca's region based on individual-level functional
  connectivity. *Eur. J. Neurosci.* 43(4):561-571. [doi:10.1111/ejn.13140](https://doi.org/10.1111/ejn.13140)
- Margulies DS et al. (2013). Visualizing the human connectome. *NeuroImage* 80:445-461.
  [doi:10.1016/j.neuroimage.2013.04.111](https://doi.org/10.1016/j.neuroimage.2013.04.111)

See also [CITATION.cff](CITATION.cff).

## Licence

New code is under the MIT licence, the licence of the original brainGL. `src/directionality/`
is LGPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

## Acknowledgements

brainGL was written by Ralph Schurade; the connectivity glyphs and the edge bundling by Joachim
Böttger. The Directionality workspace is a port of Sebastian Eichelbaum's DirectionalityIndicator.
