# Load a brainGL glyphset

Glyphsets made for the original brainGL open without conversion.

## Steps

1. Click **Data → Open files…** and select, in one go, the `.glyphset` file and every file it
   refers to: the `.set` file(s), the FreeSurfer `.asc` surfaces listed in them, and the
   connectivity matrix (raw float32, n × n). Or use **Open folder…** / drag the folder onto the view.
2. Wait for the matrix to be read. The glyphs appear with the default settings.

The anatomical NIfTI volume named on the first line is not needed and not read.

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
| 3 | the matrix file, then optionally: minimum threshold, maximum threshold, ROI file | the matrix is read completely; the minimum threshold only raises the starting **Threshold** (it never discards data); an ROI file is loaded as a painted region and **Glyphs at** is set to *painted nodes only* |

A `.set` file lists one surface per line, optionally followed by an x y z offset that is added
to its coordinates:

```text
L.pial.asc
L.inflated.asc
L.sphere.asc
```

## Notes

- If a file is missing you get: *"…" is referenced but was not among the selected files*.
- Surfaces must be FreeSurfer ASCII (`mris_convert lh.pial lh.pial.asc`).
- A matrix given as an `http` address in the `.glyphset` file is not supported.
- The limit of brainGL's load-time minimum threshold is replaced by the **Connexel budget**
  ([Limits](../reference/limits.md)).
- To convert a web glyphset back: `python tools/make_glyphset.py to-braingl <folder> --out <folder> --min-threshold 0.5`.

Formats in detail: [Data formats](../reference/data-formats.md).
