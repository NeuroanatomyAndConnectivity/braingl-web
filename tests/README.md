# Tests

All commands are run from the repository root.

| Suite | Where | Command | Needs |
|---|---|---|---|
| Unit and property tests (vitest) | `src/**/*.test.ts` | `npm test` (= `npx vitest run`) | Node 20 or newer, `npm ci` |
| Integration tests on the bundled data (vitest, same run) | `src/integration/demoDataset.test.ts` | `npm test`, or `npx vitest run src/integration` | `public/data/nki_fsaverage4`, `public/directionality` (skipped when missing) |
| Type check (includes all tests) | `src`, `tools` | `npx tsc --noEmit -p .` (= `npm run typecheck`) | |
| Data tool `tools/make_glyphset.py` (pytest) | `tests/python/test_make_glyphset.py` | `python -m pytest tests/python -q` | numpy, scipy, nibabel, pytest; no network |
| Blender importer `public/blender/import_braingl.py` | `tests/blender/test_import.py` | `blender --background --python tests/blender/test_import.py`, or `python tests/blender/test_import.py` with the stand-alone `bpy` module | Blender, or `pip install bpy numpy` |
| Browser smoke test (headless Chrome) | `tests/e2e/smoke.mjs` | `npm run test:e2e` (builds first), or `node tests/e2e/smoke.mjs --url http://localhost:5173` against a running server | Chrome or Chromium; `CHROME_PATH` selects the executable |

Continuous integration (`.github/workflows/ci.yml`) runs the type check, `npm test`, the build and pytest (with
exactly numpy, scipy, nibabel and pytest installed); the Blender tests and the smoke test run as well but do not
block merging.

## Vitest

```
npm test                              # everything once: about 5,700 tests in about 5 s
npm run test:watch                    # re-run on change
npx vitest run src/glyphs             # a subset, by path
npx vitest run -t "homotopic"         # tests whose name contains a string
npx vitest run --reporter=verbose src/integration
```

`vitest.config.ts` takes the settings of `vite.config.ts` and adds: only `src/**/*.test.ts` is collected, the Node
environment (no DOM), 30 s per test and 60 s per hook (the defaults are tight for the brute-force references and
for loading the 26 MB demo matrix on a slow machine). There is no coverage script because no coverage provider is
installed; with one (`npm i -D @vitest/coverage-v8`) `npx vitest run --coverage` works without further settings.

A test file sits next to the module it tests (`foo.ts`, `foo.test.ts`); `foo.datasets.test.ts` holds the cases that
run over the synthetic datasets.

### Synthetic example datasets (`src/testing/`)

Nothing is read from disk: every dataset is generated deterministically (seeded LCG).

- `fixtures.ts`: `icoBrain(level)` (two mirrored icosphere hemispheres, 42 / 162 / 642 nodes each; folded "pial",
  "inflated" and exact "sphere" surfaces; `sulc` overlay; correlation matrix with eight network modules per
  hemisphere: within 0.8, homotopic 0.6, other 0.1, plus or minus 0.05 noise), `singleHemisphere(level)` (no sphere,
  no overlays), `withMedialWall`, `anticorrelated`, `weighted` (maxAbs 5), `directed` (asymmetric) and
  `withValues(ds, suffix, values, mask)` (a fixture mesh carrying any other matrix, used to push real data through
  the serialisers). `FIXTURES` is the list the suites iterate over with `describe.each`; `LARGE_FIXTURE` is
  `icoBrain(3)`.
- `serialise.ts`: writes a fixture into every layout the loaders accept, as in-memory `File[]`: web glyphset
  (int8 / int16 / float32, upper / full), original brainGL (`.glyphset` + `.set` with offsets + `.asc` + raw float32
  matrix + ROI files), loose files (GIFTI in four encodings, FreeSurfer binary, `.asc`; `.npy` f4 / f8 / Fortran /
  big-endian / v2 or raw matrix; scalar overlays as GIFTI, FreeSurfer curv or `.1D`).
- `reference.ts`: brute-force reference implementations (shader thresholding rule, connexel lists, normals, tangent
  frames, HSV hue, quaternion rotation) that the application code is compared against.
- `formats.ts`: independent readers for binary PLY and ZIP (with a bit-by-bit CRC-32).

### Unit and property suites

Data layer:

- `src/testing/fixtures.test.ts`: the generators themselves (closed manifolds, V - E + F = 2, outward winding,
  symmetric matrix, block structure, mirrored hemispheres).
- `src/data/connMatrix.test.ts`: quantisation bound, NaN / Inf handling, `fromUpper` / `fromFull` /
  `fromFloat32Blob` agreement (including a matrix larger than one 32 MB chunk), and the histogram helpers.
  The histogram, the budget and the builder are tied together on every fixture, row selection and sign:
  `cumulativeHistogram()[b]` equals a brute-force count in every bin and equals `buildConnexels(...).count` at the
  threshold `b / HIST_BINS * maxAbs`; `buildConnexels` at `thresholdForBudget(...)` never exceeds the budget
  whenever any threshold can meet it, and one bin lower would exceed it; `thresholdForFraction(fractionAbove(t))`
  returns the bin of `t` (the first bin with the same count where the histogram is flat). Both rounding outcomes of
  `floor(maxAbs / scale)` (32767 and 32766) are exercised.
- `src/data/dataset.test.ts`: `buildTopology`, `computeNormals`, `orientOutward`, `computeBounds`, `findSphere`,
  `surfaceIndexByName`, `normaliseSulc`.
- `src/data/loaders.datasets.test.ts`, `src/data/loadFiles.test.ts`: every serialised layout of every fixture loads
  back to the same dataset; FreeSurfer `lh.sulc` / `lh.curv` files become overlays and are never taken for the
  matrix; error paths; the 65,535-node limit of `GlyphApp.setDataset`.
- `src/io/*.test.ts`: the file-format parsers (`.npy`, GIFTI, FreeSurfer ASCII and binary, brainGL's `.glyphset` /
  `.set` / ROI files). The GIFTI cases include dimensions beyond the cap of 2^28 elements, dimensions the data
  cannot fill, and a compressed stream that expands far beyond its declared size.
- `src/glyphs/builders.test.ts`, `src/glyphs/builders.datasets.test.ts`: `buildConnexels`, `sortForPies`,
  `computePieRanks`, `buildDiffConnexels`, `createConnexels`, `averageConnectivity` against brute force for many
  threshold / sign / ROI / hemisphere combinations. For `buildDiffConnexels` the budget rule is checked exactly: the
  key of an entry is max(r1, r2) for sign +, -min(r1, r2) for sign -, max(|r1|, |r2|) for both; the result keeps the
  requested threshold while the budget allows and otherwise takes the smallest raw threshold whose count fits; the
  upper threshold is not applied.
- `src/glyphs/picking.test.ts`: ray picking and the paint brush.

Other suites, each next to its module: `src/export/*.test.ts` (PLY byte layout and ZIP validity, the Blender
bundle and `scene.json`, baking glyph and directionality scenes, `sceneFromDataset`), `src/algorithms/*.test.ts`
(mean-shift bundling, connexel files), `src/bridge/*.test.ts`, `src/render/colormaps.test.ts`,
`src/gfx/camera.test.ts`, and the tests vendored with the directionality workspace
(`src/directionality/**/*.test.ts`).

### Integration tests on the bundled data (`src/integration/demoDataset.test.ts`)

Read from disk with a Node `fs` file getter, as `tools/blenderExport.ts` does; each of the two parts is skipped as
a whole when its folder is missing.

`public/data/nki_fsaverage4` (group-average resting-state functional connectivity of 40 participants of the
enhanced NKI Rockland sample on fsaverage4; 2 x 2562 nodes, left hemisphere first):

- manifest (extra keys such as `credit`, `source`, `subjects` are allowed), exact sizes of all referenced files,
  shape; two closed, outward-wound icospheres; plausible size, hemisphere side and cortical thickness;
- the mask removes one medial patch per hemisphere and those rows and columns are entirely zero; the matrix is
  symmetric with an empty diagonal, within [-1, 1], mostly positive;
- neuroscience regression checks, stated on medians and proportions over thousands of nodes with wide margins
  (the values of the bundled data are in the comments): mean connectivity falls monotonically with distance over
  the first 40 mm of the pial surface; homotopic nodes are far more strongly connected than the average pair of
  nodes in different hemispheres; among long-range partners (more than 40 mm away) the homotopic node ranks in the
  top 5 % for more than 85 % of the cortical nodes; the strongest partner in the other hemisphere lies within 20 mm
  of the mirror position for more than 85 % of the nodes. The homotopic node is found geometrically (the nearest
  cortical node to the mirror image on the pial surface). It is not node `i + leftNodes`: both hemispheres of
  fsaverage use the same icosphere, so equal indices are equal sphere positions, which a test asserts;
- at threshold 0.5 and minimum length 20 mm the number of connexels lies in a plausible band and is identical
  between a brute-force count, `buildConnexels` plus the display filter, and `computePieRanks`, node by node;
  `createConnexels` with a limit returns exactly the strongest pairs; histogram and budget agree with the builder;
- every loader layout (six web layouts, the original brainGL files, seven loose-file combinations) round-trips real
  values. A real sub-mesh would need a triangulation of a node subset, so the mesh of the synthetic `icoBrain(2)`
  carries the real connectivity among the first 162 nodes of each hemisphere, with the real mask.

`public/directionality` (four demo sets): each mesh is a closed triangle mesh, there is one label per vertex, and
every non-zero label is listed exactly once in the label order.

## pytest: `tools/make_glyphset.py`

```
python -m pytest tests/python -q
```

needs numpy, scipy, nibabel and pytest. The two `nki-demo` cases also need nilearn and are skipped without it; they
replace nilearn's download functions by local synthetic files, so nothing touches the network in either case.
Expected values are closed forms or brute-force loops, never copies of the tool's output. Covered: quantisation,
hemisphere separation, correlation, the neighbour average, the readers, `write_glyphset`, all four sub-commands
through their argparse entry point and as a subprocess, every option (`--names`, `--overlay`, `--no-separate`,
`--dtype` for all three types, `--name`), numbering of repeated surface and overlay names (`pial`, `pial_2`), the
size the tool reports, the mask written for nodes without data, error messages for malformed options and missing
files, round trips web to brainGL and back, the wording of the demo's description and credit against the shipped
manifest, and that every option has a help text.

## Blender import tests and browser smoke test

`tests/blender/test_import.py` runs inside Blender or with the stand-alone `bpy` module and has its own small
runner (one PASS / FAIL / SKIP line per case); under pytest without `bpy` the file skips itself. Every case writes
its own tiny scene and checks what `public/blender/import_braingl.py` builds from it.

`tests/e2e/smoke.mjs` drives the built application in headless Chrome (puppeteer-core, no bundled browser): the
demo loads, every glyph style draws, selection, the directionality workspace, the Blender export download, and no
console or network errors. Its header lists the flags and every check.

## Known bugs and conventions

No case is marked as an expected failure at present. A defect that cannot be fixed at once is documented where it
is found: `it.fails` (vitest), `@pytest.mark.xfail(strict=True)` (pytest), `@known_bug` (Blender tests) or
`knownBug` (smoke test), with the reproduction in a comment; each of these turns red when the defect is fixed, at
which point the mark is removed.

## Intentionally not covered

- WebGL output is not compared pixel by pixel; shaders, `src/render/renderer.ts` and the user interface
  (`src/glyphs/glyphApp.ts`, `src/ui`) are exercised only by the smoke test, in Chrome only. Vitest runs without
  a DOM.
- `urlGetter` (download with progress) and the bundling web worker wrapper need a browser and are reached only
  through the smoke test.
- The real `nki-demo` download and anything else that needs the network.
- Rendered Blender images (the Blender tests check the scene that is built, not Cycles or EEVEE output).
- Performance and memory: the largest dataset in the tests is the bundled demo with 5124 nodes. The limit of
  65,535 nodes is tested through its error message only, the 2 GB limit of `.npy` files not at all.
- The vendored directionality algorithms beyond the tests that came with them.
