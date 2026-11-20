# Testing

There are five kinds of tests: unit and property tests (Vitest, TypeScript), integration tests on the real demo data
(also Vitest), tests of the Python data tool (pytest), tests of the Blender importer (Python, with the `bpy` module)
and an end-to-end smoke test in headless Chrome. The same overview, kept next to the code, is `tests/README.md`.
All commands are run from the repository root.

| Suite | Where | Command | In CI |
|---|---|---|---|
| Unit and property tests | `src/**/*.test.ts` | `npm test` | yes |
| Integration tests on the demo data | `src/integration/` | `npm test` (same run) | yes |
| Type check (covers the tests) | `src`, `tools` | `npm run typecheck` | yes |
| Data tool | `tests/python/test_make_glyphset.py` | `python -m pytest tests/python -q` | yes |
| Blender importer | `tests/blender/test_import.py` | `blender --background --python tests/blender/test_import.py` | no |
| Browser smoke test | `tests/e2e/smoke.mjs` | `npm run test:e2e` | no |

## Unit and property tests (Vitest)

```
npm test                        # vitest run: everything once
npm run test:watch              # re-run on change
npx vitest run src/glyphs       # a subset, by path
npx vitest run -t "pie"         # tests whose name contains "pie"
```

Vitest runs in its Node environment with `vitest.config.ts`, which merges `vite.config.ts`, collects `src/**/*.test.ts`, and
raises the timeouts (30 s per test, 60 s per hook) for the brute-force references and the 26 MB demo matrix. Tests therefore must not touch the DOM or WebGL. Code that does (`glyphApp.ts`,
`render/renderer.ts`) is covered by the end-to-end test, and the testable logic is kept in pure modules (`builders.ts`,
`connMatrix.ts`, `picking.ts`, `io/`, `export/`, `bridge/`).

Test files sit next to the module they test (`foo.ts` and `foo.test.ts`); a second file `foo.datasets.test.ts` holds
the tests that run over the synthetic datasets.

| Area | Test files |
|---|---|
| Glyph builders and picking | `src/glyphs/builders.test.ts`, `builders.datasets.test.ts`, `picking.test.ts` |
| Data model and loading | `src/data/connMatrix.test.ts`, `dataset.test.ts`, `loadFiles.test.ts`, `loaders.datasets.test.ts` |
| File formats | `src/io/npy.test.ts`, `gifti.test.ts`, `freesurferAsc.test.ts`, `freesurferBinary.test.ts`, `glyphsetFiles.test.ts` |
| Bundling and connexel files | `src/algorithms/meanShiftBundling.test.ts`, `connexelFiles.test.ts` |
| Rendering helpers | `src/render/colormaps.test.ts`, `src/gfx/camera.test.ts` |
| Export | `src/export/ply.test.ts`, `blenderBundle.test.ts`, `bake.test.ts`, `sceneFromDataset.test.ts`, `directionalityBake.test.ts` |
| Bridge to Directionality | `src/bridge/toDirectionality.test.ts` |
| The fixtures themselves | `src/testing/fixtures.test.ts` |
| Vendored Directionality | `src/directionality/**/*.test.ts`, copied from upstream and patched by the vendoring script; they read the data in `public/directionality` |

### The synthetic datasets (`src/testing/fixtures.ts`)

Nothing is read from disk: every dataset is generated in code with a seeded random generator (`lcg(seed)`), so each run
sees the same numbers. The base generator `icoBrain(level)` builds two mirrored icosphere hemispheres (level 1, 2 and 3
give 42, 162 and 642 nodes per hemisphere) with three surfaces (a folded "pial", an ellipsoid "inflated" and an exact
"sphere"), a `sulc` overlay and a block-structured correlation matrix with eight network modules per hemisphere (one per
octant of the sphere): within-module 0.8, homotopic (mirror) nodes 0.6, other 0.1, with plus or minus 0.05 noise.
Because the modules are known, the expected structure of every result is known too. Variants:

| Fixture | What it exercises |
|---|---|
| `icoBrain(1)`, `icoBrain(2)`, `icoBrain(3)` | The ordinary two-hemisphere case at three sizes; `icoBrain(3)` is `LARGE_FIXTURE`, used only where the test can afford it. Hemisphere split, polar projection (sphere surface present), overlays. |
| `singleHemisphere(level)` | One hemisphere, `leftNodes = 0`, no sphere surface and no overlays: no polar projection, no hemisphere selector, loaders that must not invent a second hemisphere. |
| `withMedialWall(ds)` | Zeroes rows and columns of a medial patch and clears its mask: nodes without data, glyph nodes that must be skipped. |
| `anticorrelated(ds)` | Between-module blocks become negative (about -0.5 between antipodal modules, about -0.1 otherwise): the sign filter, upper and lower thresholds, colouring by value. |
| `weighted(ds)` | Zero diagonal, largest absolute weight exactly 5: matrices that are not correlations (colour ranges, Fisher z must not be applied, alpha normalisation, build thresholds). |
| `directed(ds)` | Asymmetric matrix (lower triangle halved): catches row and column mix-ups in the loaders. |

Combinations of these are the entries of `FIXTURES` (for example `icoBrain(2)+medialWall+anticorrelated`); `ALL_FIXTURES`
adds the large one. Suites iterate over them with `describe.each(FIXTURES)`.

The other files in `src/testing/`:

- `serialise.ts` writes a fixture into every on-disk layout the loaders accept, as in-memory `File` objects: web
  glyphset (int8, int16, float32; upper and full), original brainGL (`.glyphset`, `.set`, `.asc`, raw float32 matrix,
  ROI files) and loose files (GIFTI in four encodings, FreeSurfer binary and ASCII, `.npy` in several dtypes and byte
  orders, raw matrix, scalar overlays). The formats are written from their specifications, independently of the parsers
  under test.
- `reference.ts` holds slow, obviously correct reference implementations that do not import the code under test:
  the threshold rule of the shader, connexel lists, normals, tangent frames, HSV hue, quaternion rotation.
- `formats.ts` holds independent readers for binary PLY and ZIP (with a bit-by-bit CRC-32), used by the export tests.

### Property tests against brute-force references

The glyph code is optimised: it scans rows once, uses histograms, builds ranks in linear passes. The tests do not
re-derive its output from the same algorithm. Instead, for each fixture and for many combinations of threshold, sign,
upper threshold, minimum length, hemisphere, ROI and target mask, they compute the expected result with plain double
loops over the original float matrix (`reference.ts`) and compare it with the module. Examples: `buildConnexels` against
the reference connexel list; `computePieRanks` against a sort done per node; `buildDiffConnexels` against a loop over
all mesh edges and targets; `averageConnectivity` against a direct Fisher-z mean. Because the application stores 16-bit
integers, comparisons allow for the quantisation step (half a step of `maxAbs / 32767`) and take care at values that sit
exactly on a threshold.

### Integration tests on the demo data

The unit tests use synthetic data. `src/integration/demoDataset.test.ts` reads the bundled demo dataset
(`public/data/nki_fsaverage4`, 5,124 nodes) and the four sets in `public/directionality` from disk with Node's `fs`, as
`tools/blenderExport.ts` does, so that problems that only appear at real sizes and with real values are caught. The suites
are skipped when the folders are missing. They check:

- the manifest, the credit text and that every referenced file exists with exactly the size its role implies;
- the mesh (two closed icospheres, outward winding, brain-sized surfaces, a cortical ribbon of plausible thickness,
  inflated hemispheres 5 mm apart, sphere detection, overlays with both signs);
- the mask (one medial patch per hemisphere) and the matrix (symmetric, empty diagonal, correlations within -1 to 1,
  int16 values within half a storage step of the stored ones);
- a few neuroscience regression checks, stated on medians and proportions over thousands of nodes with wide margins:
  connectivity falls with distance, homotopic nodes are strongly connected, and the strongest partner in the other
  hemisphere lies near the mirror position for most nodes;
- the glyph builders at threshold 0.5 and minimum length 20 mm against brute force, and that the histogram and the
  connexel budget agree with the builder on the real matrix.

They run as part of `npm test`. One finding is worth knowing: on fsaverage the node `i + leftNodes` is *not* the homotopic partner of node `i` (FreeSurfer uses one icosphere for both hemispheres, so the same index is the same sphere position: a lateral node on the left is a medial node on the right), so the test looks for the pial node nearest to the mirror position instead.

### Current size

At the time of writing: about 5,700 Vitest cases (about 5 s), 190 pytest cases, 72 Blender import checks (with `bpy` 5.0.1) and 17 browser smoke checks.

### Known-defect and pending cases

A test that documents a known defect of the application is written with `it.fails`; it turns red when the defect is
fixed, and the marker is then changed to `it`. Cases written for behaviour that changed and not yet rewritten are
`it.skip` with a `TODO` in the name. Python cases use `xfail(strict=True)` in the same way. Search for these markers
before assuming that a suite is complete.

### Adding a test for a new glyph style or input format

A new glyph style:

1. Add the builder logic to `src/glyphs/builders.ts` (pure, no DOM) and, if the style is drawn from per-connexel
   records, a reference version to `src/testing/reference.ts` that uses double loops over `ds.values`.
2. In `src/glyphs/builders.datasets.test.ts`, add a `describe.each(FIXTURES)` block that builds the records with the
   module and with the reference for several `(threshold, sign, maxThreshold, minLength, hemi)` combinations and
   compares them, including a threshold exactly at a stored value and a range that selects nothing.
3. The shader has a CPU mirror in `src/export/bake.ts`. Test it where possible through the bundle: bake a fixture with
   the new style and check the layers listed in `scene.json` (see `src/export/blenderBundle.test.ts`).
4. Add the style to the style loop in `tests/e2e/smoke.mjs` (the check that every style draws pixels and differs from the
   others), and to `reference/glyph-types.md`.

A new input format:

1. Add a writer for the format to `src/testing/serialise.ts`, written from the specification, not from the parser, and
   add it to `toLooseFiles` or the layout options.
2. Add a parser unit test next to the parser (`src/io/foo.test.ts`) with small hand-made byte strings, including the
   error paths: truncated data, wrong magic number, dimensions larger than the data.
3. In `src/data/loaders.datasets.test.ts`, add the layout to the list of layouts so that every fixture is serialised,
   loaded and compared with the original (surfaces, matrix within one quantisation step, overlays).
4. Document the format in `reference/data-formats.md`.

## Python tests (pytest)

```
pip install numpy scipy nibabel nilearn pytest
python -m pytest tests/python -q
```

`tests/python/test_make_glyphset.py` tests `tools/make_glyphset.py`: quantisation (closed forms and error bounds),
upper-triangle order, the hemisphere helpers, correlation, loading of surfaces, the sub-commands and the round trip
with `to-braingl`. Expected values come from closed forms or brute-force loops, not from the tool's own output. The
`nki-demo` test replaces nilearn's download functions with local synthetic files, so no network is used. Tests that
need `nilearn` are skipped when it is not installed, and one test is skipped when the bundled demo data are absent.
CI installs only numpy, scipy, nibabel and pytest, so those tests run only locally.

## Blender importer tests

```
blender --background --python tests/blender/test_import.py
python tests/blender/test_import.py        # with a Python that has the standalone bpy module and numpy
```

`tests/blender/test_import.py` loads `public/blender/import_braingl.py`, writes tiny scenes (a `scene.json` and
binary PLY layers in the layout of `writePly`) and checks the objects, materials, cameras and renders it creates. It has
its own small runner that prints PASS, FAIL, SKIP or XFAIL per case; without Blender it skips itself. CI does not run
it because Blender is not installed there. Cases marked `@known_bug` turn into failures when the defect is fixed.

## End-to-end smoke test

```
npm run test:e2e                          # build, then test dist/ with `vite preview`
node tests/e2e/smoke.mjs                  # test the existing dist/
node tests/e2e/smoke.mjs --url http://localhost:5173/    # a server that is already running
```

`tests/e2e/smoke.mjs` drives headless Chrome with `puppeteer-core`, which does not bring a browser: set `CHROME_PATH`
or install Google Chrome. It prints one PASS or FAIL line per check and exits 1 on any failure. The checks include: the
demo glyphset loads (5,124 nodes); every glyph style and the polar geometry draw pixels, differ from one another and
turn off again; selecting a seed recolours the inset; no console or page errors; the Directionality workspace mounts
and draws; the bridge loads a map into it; "Export for Blender" downloads a zip whose layers match `scene.json`; the
view is restored after a reload. Options: `--url`, `--port`, `--timeout`, `--headed`, `--screenshots`, `--artifacts`.
Screenshots of failures go to `tests/e2e/.artifacts` (git-ignored). The header of the script has the current list of
checks, including those registered as known defects.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests, in three jobs:

1. **web**: `npm ci`, `npm run typecheck`, `npm test` (unit, property and integration tests) and `npm run build`, on
   Node 20.
2. **python**: `pytest tests/python -q` on Python 3.12 with numpy, scipy, nibabel and pytest.
3. **docs**: `mkdocs build --strict` with mkdocs-material.

The end-to-end test and the Blender tests are not part of CI. Run the three npm checks (and the others when you touch
their areas) before opening a pull request; see [Contributing](contributing.md).
