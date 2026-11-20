# Your own data

<!-- TODO(restart): expand; re-verify the command lines against the current tools/make_glyphset.py -->

**Goal:** look at your own surfaces and connectivity matrix.
**You need:** surfaces with the same node order as the matrix; Python 3 with `numpy`, `scipy`
and `nibabel` (and `nilearn` for the example).
**Result:** your data in the viewer, loaded in one of three ways.

## Conventions

- **One row per surface node.** The matrix is square, n × n, in the node order of the surfaces.
- **Left hemisphere first.** With two hemispheres, the left nodes come first, then the right ones.
- **Medial wall.** Give nodes without data rows of zeros (NaN is read as 0). Loose files: a
  node whose row is entirely zero gets no glyph.
- **Size.** At most 65,535 nodes. The matrix is held as 16-bit integers:

| Nodes | Example | Memory in the browser (2·n² bytes) |
|---|---|---|
| 5,124 | fsaverage4, both hemispheres | 52 MB |
| 10,242 | fsaverage5, one hemisphere | 210 MB |
| 16,384 | | about 0.5 GB |
| 20,484 | fsaverage5, both hemispheres | 839 MB |

About 16,000 nodes is the practical size; see [Limits](../reference/limits.md). NIfTI volumes
and CIFTI dense connectomes are not read; convert CIFTI to a `.npy` matrix first.

## (a) Drop loose files

Select surfaces and a matrix together with **Data → Open files…**, **Open folder…** or drag
them onto the view:

- surfaces: GIFTI `.surf.gii`, FreeSurfer binary (`lh.pial`) or FreeSurfer `.asc`; one per
  hemisphere and kind. The hemisphere is taken from `lh`/`rh`/`L`/`R`/`left`/`right` in the file
  name, the kind from `pial`, `white`, `midthickness`, `inflated`, `sphere` and so on;
- matrix: square `.npy`, or raw little-endian float32;
- optional per-node scalars: `.shape.gii` / `.func.gii`, FreeSurfer `curv`/`sulc`, `.1D`.

Compressed `.gz` files are skipped. Inflated and spherical hemispheres are moved apart automatically.

This example computes a correlation matrix from the surface time series of one participant of
the NKI enhanced sample (fetched by nilearn on fsaverage5) and down-samples it to fsaverage4.
The fsaverage meshes are nested: the first 2,562 nodes of an fsaverage5 hemisphere are the
nodes of fsaverage4. `ico_neighbour_average` from `tools/make_glyphset.py` averages each kept
node with its neighbours before the others are dropped. Run it from the repository root.

```python
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
from nilearn import datasets

sys.path.insert(0, "tools")                      # run from the repository root
from make_glyphset import ico_neighbour_average  # 1-ring average before sub-sampling

out = Path("my_glyphset")
out.mkdir(parents=True, exist_ok=True)

nki = datasets.fetch_surf_nki_enhanced(n_subjects=1)
fs5 = datasets.fetch_surf_fsaverage("fsaverage5")
fs4 = datasets.fetch_surf_fsaverage("fsaverage4")
N4 = 2562                                        # nodes per hemisphere of fsaverage4

# 1. time series [nodes, time], left hemisphere first, then right
parts = []
for hemi in ("left", "right"):
    gii = nib.load(nki[f"func_{hemi}"][0])
    ts = np.stack([d.data for d in gii.darrays], axis=1).astype(np.float32)  # [10242, time]
    tri5 = nib.load(fs5[f"pial_{hemi}"]).agg_data("triangle")
    parts.append(ico_neighbour_average(ts, tri5, N4))                         # [2562, time]
ts = np.concatenate(parts, axis=0)                                            # [5124, time]

# 2. Pearson correlation between all pairs of nodes
with np.errstate(invalid="ignore", divide="ignore"):
    conn = np.corrcoef(ts).astype(np.float32)
conn = np.nan_to_num(conn)      # medial wall (constant time series) -> rows of zeros
np.fill_diagonal(conn, 0)
np.save(out / "conn.npy", conn)

# 3. surfaces and a sulcal-depth overlay, with file names the viewer recognises
for hemi, h in (("left", "lh"), ("right", "rh")):
    for key, name in (("pial", "pial"), ("infl", "inflated"), ("sphere", "sphere")):
        nib.save(nib.load(fs4[f"{key}_{hemi}"]), out / f"{h}.{name}.surf.gii")
    nib.save(nib.load(fs4[f"sulc_{hemi}"]), out / f"{h}.sulc.shape.gii")
```

Drop the folder `my_glyphset` onto the view (`conn.npy` is 105 MB).

![The example loaded as loose files](../images/own-data-loose-files.png)

## (b) Convert with `tools/make_glyphset.py`

A *web glyphset* is a folder with `glyphset.json` and compact binary files (the matrix as
8- or 16-bit integers of the upper triangle). It loads faster, is much smaller, and can be
served with the app. From an existing matrix:

```bash
python tools/make_glyphset.py from-matrix \
  --left  my_glyphset/lh.pial.surf.gii my_glyphset/lh.inflated.surf.gii my_glyphset/lh.sphere.surf.gii \
  --right my_glyphset/rh.pial.surf.gii my_glyphset/rh.inflated.surf.gii my_glyphset/rh.sphere.surf.gii \
  --names pial,inflated,sphere \
  --matrix my_glyphset/conn.npy \
  --overlay sulc=my_glyphset/lh.sulc.shape.gii,my_glyphset/rh.sulc.shape.gii \
  --name "One NKI participant (fsaverage4)" --dtype int16 \
  --out public/data/local/my_set
```

From time series (`.func.gii` or `.npy` with shape nodes × time, on the same mesh as the
surfaces; the tool computes Pearson correlations and does not resample):

```bash
python tools/make_glyphset.py from-timeseries \
  --left lh.pial lh.inflated lh.sphere --right rh.pial rh.inflated rh.sphere \
  --names pial,inflated,sphere \
  --timeseries lh.timeseries.npy rh.timeseries.npy \
  --out public/data/local/my_set
```

Give `--names` in the order of the surfaces. `--dtype` is `int8` (default, smallest), `int16`
or `float32`. With one hemisphere, omit `--right`. Open the result with **Open folder…**, or as
`http://localhost:5173/?data=data/local/my_set` (`public/data/local/` is ignored by git).
All options: `python tools/make_glyphset.py from-matrix --help` and
[Command-line tools](../reference/cli.md).

Two more sub-commands: `nki-demo` rebuilds the demo
(`python tools/make_glyphset.py nki-demo --mesh fsaverage4 --out public/data/nki_fsaverage4`), and
`to-braingl <glyphset folder> --out <folder>` writes the files of the original brainGL.

## (c) An existing brainGL glyphset

Select the `.glyphset` file together with all files it refers to. See
[Load a brainGL glyphset](../how-to/load-braingl-glyphset.md).

## Problems

| Message | Meaning |
|---|---|
| "No surface found…" / "No connectivity matrix found…" | a file type was not recognised; check extensions and that `.gz` files are unpacked |
| "… is a N x N matrix but the surfaces have M nodes" | the matrix and the surfaces are not on the same mesh |
| "… is referenced but was not among the selected files" | select all files of a glyphset together |
| "This dataset has N nodes; the viewer supports up to 65,535 nodes per glyphset." | down-sample |
