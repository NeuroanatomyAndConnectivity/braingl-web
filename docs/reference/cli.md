# Command-line tools

All commands are run from the repository root.

## npm scripts

From `package.json`.

| Script | Command | Purpose |
|---|---|---|
| `npm run dev` | `vite` | Development server at <http://localhost:5173> with hot reload. |
| `npm run build` | `tsc -b && vite build` | Type-check, then build the static site into `dist/`. |
| `npm run preview` | `vite preview` | Serve the contents of `dist/` locally. |
| `npm test` | `vitest run` | Run the unit tests once. |
| `npm run test:watch` | `vitest` | Run the tests in watch mode. |
| `npm run test:e2e` | `npm run build && node tests/e2e/smoke.mjs` | Build, then run the headless-Chrome smoke test ([Testing](../development/testing.md)). |
| `npm run typecheck` | `tsc --noEmit -p .` | Type-check `src/` and `tools/` (strict mode). |
| `npm run export:blender` | `vite-node tools/export_blender.ts --` | Export Blender scenes without a browser (below). |

Build details (`vite.config.ts`): the site is served from `/` locally and from `/<repo>/` when
built on GitHub Actions (`GITHUB_ACTIONS` and `GITHUB_REPOSITORY` set); shader files
(`*.glsl`) are imported as raw strings; workers are built as ES modules.

### URL parameters of the running app

| Parameter | Effect |
|---|---|
| `?workspace=glyphs` or `?workspace=directionality` | Start in that workspace (otherwise the last one used, stored in `localStorage` as `braingl.workspace`). |
| `?data=<folder>` | Load the web glyphset in `<folder>` (a URL relative to the page, containing `glyphset.json`) instead of the bundled demo `data/nki_fsaverage4/`. A trailing slash is added if missing. `public/data/local/` is git-ignored and meant for your own data during development. |

## `tools/make_glyphset.py`

Creates web glyphsets (see [Data formats](data-formats.md#web-glyphset)). Requires Python 3
with `numpy` and `nibabel`; `nki-demo` also needs `nilearn`, and `from-timeseries` / `nki-demo` with
a coarser mesh need `scipy`.

```
python tools/make_glyphset.py {from-matrix,from-timeseries,nki-demo,to-braingl} --help
```

### Options common to `from-matrix` and `from-timeseries`

| Option | Meaning |
|---|---|
| `--left FILE...` | Required. Surfaces of the left hemisphere (or of the only mesh), for example pial, inflated, sphere. GIFTI (`.gii`, `.gii.gz`), FreeSurfer binary, or `.asc`. |
| `--right FILE...` | Matching right-hemisphere surfaces, same order. Omit for a single-hemisphere dataset. |
| `--names a,b,c` | Comma-separated surface names, one per surface file. Default: the surface kind found in the file name (`pial`, `inflated`, `sphere`, `white`, `midthickness`, `smoothwm`, `orig`, `flat`, `very_inflated`), so `lh.pial.surf.gii` becomes `pial`; otherwise the file name without hemisphere and extension parts. |
| `--overlay name=left[,right]` | Per-node scalars; may be repeated. Example `--overlay sulc=lh.sulc,rh.sulc`. Files may be GIFTI, `.npy` or FreeSurfer morphometry. |
| `--no-separate` | Do not move overlapping hemispheres apart. By default the two hemispheres of non-anatomical surfaces (inflated, sphere and others) are moved apart along x until 5 mm separate them (hemispheres already 5 mm or more apart are left alone). `pial`, `white`, `midthickness`, `smoothwm` and `orig` are never moved. |
| `--dtype {int8,int16,float32}` | Storage type of the matrix; default `int8`. |
| `--name NAME` | Dataset name; default the output folder name. |
| `--out DIR` | Required. Output folder. |

All surfaces and overlays must have the same node count; the tool stops with an error if an overlay does not match. The left surfaces are stacked with the
right ones; triangles of the right hemisphere are offset by the left node count.

### `from-matrix`

Surfaces plus an existing node-by-node matrix.

| Option | Meaning |
|---|---|
| `--matrix FILE` | Required. `.npy` (opened memory-mapped) or a raw little-endian float32 square matrix; `n` is computed from the file size. |

```
python tools/make_glyphset.py from-matrix --left lh.pial lh.inflated lh.sphere \
  --right rh.pial rh.inflated rh.sphere --names pial,inflated,sphere \
  --matrix conn.npy --out public/data/local/mine
```

### `from-timeseries`

Surfaces plus surface time series; computes the Pearson correlation between all node time
series.

| Option | Meaning |
|---|---|
| `--timeseries FILE...` | Required. Left (and right) `.func.gii` or `.npy` of shape `[nodes, time]`; files are concatenated along the node axis. |

The correlation matrix is computed in float32 (`z @ z.T / T`) and stored in a temporary
`_conn.npy` in the output folder, which is removed afterwards; plan for `4 n^2` bytes of RAM and
disk. Nodes with a standard deviation below 1e-6 get zero correlation. A node mask (`mask.u8`) marks the valid nodes, so nodes without signal (medial wall) get no glyphs.

### `nki-demo`

Builds the demo dataset: the group-average functional connectivity of the enhanced NKI Rockland
sample, downloaded through nilearn (Pearson r per participant, averaged in Fisher z).

| Option | Default | Meaning |
|---|---|---|
| `--subjects N` | 40 | Number of participants. |
| `--mesh {fsaverage3,fsaverage4,fsaverage5}` | `fsaverage4` | Mesh resolution (642, 2562 or 10242 nodes per hemisphere); the time series are 1-ring averaged and sub-sampled from fsaverage5. |
| `--hemi {both,lh,rh}` | `both` | Hemispheres. |
| `--dtype {int8,int16,float32}` | `int8` | Matrix storage type. |
| `--data-dir DIR` | nilearn default | Where nilearn caches downloads. |
| `--out DIR` | required | Output folder. |

Surfaces written: `pial`, `inflated`, `sphere`, `white`; overlays `sulc` and `curv`; the mask
marks nodes with a valid time series in every participant; the diagonal is zeroed. The manifest
also records `source` and `subjects`.

### `to-braingl`

Converts a web glyphset back to the original brainGL file family.

```
python tools/make_glyphset.py to-braingl <glyphset folder> --out DIR [--min-threshold 0.5]
```

| Argument | Default | Meaning |
|---|---|---|
| `glyphset` | required | Folder containing `glyphset.json`. |
| `--out DIR` | required | Output folder. |
| `--min-threshold X` | 0.5 | The minimum threshold written to line 3 of the `.glyphset`. |

Writes `L.<surface>.asc` and `R.<surface>.asc` per surface (or `<surface>.asc` for a
single-hemisphere set), `L.set` and `R.set` (or `all.set`), `connectivity.bin` (raw
little-endian float32, `n x n`; for an `upper` layout the matrix is symmetrised and the diagonal set
to 1.0), and `data.glyphset` with the lines `anatomy.nii.gz`, the `.set` names and
`connectivity.bin <min-threshold>`. Overlays and the mask are not written. The
`anatomy.nii.gz` named on line 1 is a placeholder that is not written (brainGL skips that line).

## `npm run export:blender`

Exports Blender scenes without a browser (`tools/blenderExport.ts`, entry `tools/export_blender.ts`).
Pass the options after `--`. The output folders contain `scene.json`, one `.ply` per layer and a copy of
`import_braingl.py` ([format](blender-scene-format.md)).

```
npm run export:blender -- --all --out examples/blender
npm run export:blender -- --preset pies --glyphset public/data/nki_fsaverage4 --out /tmp/pies
npm run export:blender -- --preset pies --params '{"threshold":0.6,"hemi":1}' --out /tmp/pies
npm run export:blender -- --directionality public/directionality/label34 --out /tmp/label34
```

| Option | Meaning |
|---|---|
| `--out DIR` | Required. Output folder. With `--all` each scene gets a subfolder. |
| `--all` | Export every preset, plus `directionality-label34` (the bundled `label34` parcellation) and `directionality-seed-map` (the seed connectivity map of node 1200 through the bridge). |
| `--preset NAME` | One glyph preset (default `points`). |
| `--glyphset DIR` | Web glyphset folder (default `public/data/nki_fsaverage4`). |
| `--params JSON` | Parameter overrides merged over the preset (`GlyphParams` keys, see [Parameters](parameters.md)). Used with `--preset` only. |
| `--directionality BASE` | Export a Directionality dataset: `BASE.ply`, `BASE.labels` and `BASE.labelorder` (give the path without extension). |
| `--help` | Print usage and the presets (also printed when `--out` is missing). |

Presets (`PRESETS` in `tools/blenderExport.ts`). All use the default parameters except for the
listed ones; the view is for the camera (`left` lateral or `dorsal`).

| Preset | View | Parameters set | Description |
|---|---|---|---|
| `points` | left | `glyphStyle: points`, `threshold: 0.5`, `minLength: 20` | Point glyphs, whole brain. |
| `vectors` | left | `glyphStyle: vectors`, `threshold: 0.4`, `minLength: 40`; primitive radius 0.12 mm | Vector glyphs emphasising long-range connections. |
| `pies` | dorsal | `glyphStyle: pies`, `threshold: 0.4`, `minLength: 20` | Pie glyphs. |
| `polar` | left | `glyphStyle: points`, `glyphGeometry: -1`, `threshold: 0.35`, `minLength: 0`, `hemi: 1` | Polar-projection point glyphs, left hemisphere. |
| `diffpoints` | left | `glyphStyle: diffpoints`, `threshold: 0.25`, `minLength: 0`, `hemi: 1` | Difference glyphs, left hemisphere. |
| `littlebrains` | left | `glyphStyle: points`, `glyphNodes: painted`, `littleBrains: true`, `lbMax: 60`, `glyphRadius: 0.09`, `glyphColorMode: 1`, `threshold: 0.35`, `minLength: 10`, `surfaceColorMode: seed`; seed node 1200; two painted regions of 14 mm radius around nodes 1200 and 700 | Anatomical background glyphs on two regions, coloured by connectivity. |
| `bundles` | dorsal | `glyphStyle: off`, `threshold: 0.45`, `minLength: 60`, `surfaceAlpha: 0.25`; up to 4000 connexels, bundled; primitive radius 0.35 mm | Bundled long-range connections inside a transparent surface. |

Node numbers refer to the bundled fsaverage4 demo. The camera of each scene is a 16:9
orthographic camera framing the displayed surface. The default primitive radius is 0.25 mm and at
most 400,000 primitives are exported per layer.

## `tools/vendor_directionality.py`

Copies the Directionality app from an upstream checkout into `src/directionality/` and applies
patches ([details](../development/vendored-directionality.md)).

```
python3 tools/vendor_directionality.py /path/to/directionality-indicator-webgl
```

The single argument is the upstream checkout; its git `HEAD` is recorded (the revision is empty if it is not a git checkout). The script deletes and re-creates `src/directionality/`, copies the demo data to
`public/directionality/`, and fails with `patch no longer applies to ...` if an upstream change
breaks a patch.

## `public/blender/import_braingl.py`

Imports a scene into Blender 3.6 or newer (tested with 4.x and the `bpy` 5.0.1 Python module).
Three ways to run it:

```
blender --python import_braingl.py
blender --python import_braingl.py -- /path/to/scene [options]
blender --background --python import_braingl.py -- /path/to/scene --render out.png
```

or Scripting workspace, Open, Run Script (loads the `scene.json` next to the script).

| Option | Default | Meaning |
|---|---|---|
| `scene` (positional) | folder of the script, else the folder of a text block in the open file, else the working directory | Folder (or a file in it) containing `scene.json`. |
| `--render FILE` | none | Render a still image to `FILE`. |
| `--save FILE` | none | Save the result as a `.blend` file. |
| `--cycles` | off | Render with Cycles instead of EEVEE. |
| `--samples N` | 64 | Render samples. |
| `--resolution W` | 1920 | Width in pixels; the height follows the scene's aspect ratio. |
| `--points {nodes,mesh}` | `nodes` | `nodes`: point glyphs as a geometry-nodes point cloud (light); `mesh`: real octahedra (portable, heavier). If the point-cloud nodes are not available the script falls back to octahedra by itself. |
| `--keep` | off | Keep the objects already in the `.blend` file (by default they are removed). |

Layers of kind `segments` become three-sided tubes. The scene is imported into a new collection
named `brainGL: <title>`.
