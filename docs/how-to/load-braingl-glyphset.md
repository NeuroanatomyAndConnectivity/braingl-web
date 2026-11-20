# Load a brainGL glyphset

Glyphsets made for the original brainGL open without conversion.

## Steps

1. Click **Data → Open files…** and select, in one go, the `.glyphset` file and every file it
   refers to: the `.set` file(s), the FreeSurfer `.asc` surfaces listed in them, and the
   connectivity matrix (raw float32, n × n). Or use **Open folder…** / drag the folder onto the view.
2. Wait for the matrix to be read; a progress box shows how far it is. The glyphs appear with
   the default settings, and the dataset takes the name of the `.glyphset` file.

The anatomical NIfTI volume named on the first line is not needed and not read. If you have no
brainGL glyphset to try this with, `tools/make_glyphset.py to-braingl` writes one from any web
glyphset ([Your own data](../tutorials/own-data.md#8-open-or-create-a-braingl-glyphset)).

## The three lines of a `.glyphset` file

```text
anatomy.nii.gz
L.set R.set
connectivity.bin 0.5
```

| Line | Content | In brainGL web |
|---|---|---|
| 1 | the anatomical NIfTI volume | ignored |
| 2 | one or two `.set` files: left hemisphere, then right | read; the two hemispheres are joined, left nodes first |
| 3 | the matrix file, then optionally: minimum threshold, maximum threshold, ROI file, second ROI file | the matrix is read completely; the minimum threshold only raises the starting **Threshold** (it never discards data); a maximum threshold below 1 sets the starting **Upper threshold**; an ROI file is loaded as a painted region and **Glyphs at** is set to *painted nodes only*; a second ROI file restricts the nodes that connections may lead to |

A `.set` file lists one surface per line, optionally followed by an x y z offset that is added
to its coordinates:

```text
L.pial.asc
L.inflated.asc
L.sphere.asc
```

## Notes

- If a file is missing you get: *"…" is referenced but was not among the selected files*. Error
  messages are shown in the status line for 8 seconds and in the browser console.
- A `.glyphset` carries no overlays, so the surface has no sulcal shading and **Surface →
  Colour** offers no overlay.
- Surfaces must be FreeSurfer ASCII (`mris_convert lh.pial lh.pial.asc`).
- A matrix given as an `http` address in the `.glyphset` file is not supported.
- The limit of brainGL's load-time minimum threshold is replaced by the **Connexel budget**
  ([Limits](../reference/limits.md)).
- To convert a web glyphset back: `python tools/make_glyphset.py to-braingl <folder> --out <folder> --min-threshold 0.5`.

Formats in detail: [Data formats](../reference/data-formats.md).
