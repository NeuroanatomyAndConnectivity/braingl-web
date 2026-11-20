# Tests

All commands are run from the repository root.

| Suite | Where | Command |
|---|---|---|
| Unit / property tests (vitest) | `src/**/*.test.ts` | `npm test` (= `npx vitest run`) |
| Type check (includes the tests) | `src`, `tools` | `npx tsc --noEmit -p .` |
| Browser smoke test (headless Chrome) | `tests/e2e/smoke.mjs` | `npm run test:e2e` (builds first), or `node tests/e2e/smoke.mjs --url http://localhost:5173` against a running server; `CHROME_PATH` selects the browser |
| `tools/make_glyphset.py` | `tests/python/test_make_glyphset.py` | `python -m pytest tests/python -q` (needs numpy, scipy, nibabel, nilearn, pytest; no network access) |
| Blender importer | `tests/blender/test_import.py` | `blender --background --python tests/blender/test_import.py`, or `python tests/blender/test_import.py` with the standalone `bpy` module |

## Synthetic example datasets (`src/testing/`)

Nothing is read from disk: every dataset is generated deterministically (seeded LCG).

- `fixtures.ts` — `icoBrain(level)` (two mirrored icosphere hemispheres, 42 / 162 / 642 nodes each; folded "pial",
  "inflated" and exact "sphere" surfaces; `sulc` overlay; correlation matrix with eight network modules per hemisphere:
  within 0.8, homotopic 0.6, other 0.1, +-0.05 noise), `singleHemisphere(level)` (no sphere, no overlays),
  `withMedialWall`, `anticorrelated`, `weighted` (maxAbs 5), `directed` (asymmetric). `FIXTURES` is the list the suites
  iterate over with `describe.each`; `LARGE_FIXTURE` is `icoBrain(3)`.
- `serialise.ts` — writes a fixture into every layout the loaders accept, as in-memory `File[]`: web glyphset
  (int8 / int16 / float32, upper / full), original brainGL (`.glyphset` + `.set` with offsets + `.asc` + raw float32
  matrix + ROI files), loose files (GIFTI in four encodings, FreeSurfer binary, `.asc`; `.npy` f4 / f8 / Fortran /
  big-endian / v2 or raw matrix; scalar overlays).
- `reference.ts` — brute-force reference implementations (shader thresholding rule, connexel lists, normals, tangent
  frames, HSV hue, quaternion rotation) that the application code is compared against.
- `formats.ts` — independent readers for binary PLY and ZIP (with a bit-by-bit CRC-32).

## Vitest suites added with the fixtures

- `src/testing/fixtures.test.ts` — the generators themselves (closed manifolds, V - E + F = 2, outward winding,
  symmetric matrix, block structure, mirrored hemispheres).
- `src/data/connMatrix.test.ts` — quantisation bound, NaN / Inf handling, `fromUpper` / `fromFull` /
  `fromFloat32Blob` agreement (including a matrix larger than one 32 MB chunk), histogram, budget and percentile helpers.
- `src/data/dataset.test.ts` — `buildTopology`, `computeNormals`, `orientOutward`, `computeBounds`, `findSphere`,
  `surfaceIndexByName`, `normaliseSulc`.
- `src/data/loaders.datasets.test.ts` — every serialised layout of every fixture loads back to the same dataset;
  error paths; the 65,535-node limit of `GlyphApp.setDataset`.
- `src/glyphs/builders.datasets.test.ts` — `buildConnexels`, `sortForPies`, `computePieRanks`, `buildDiffConnexels`,
  `createConnexels`, `averageConnectivity` against brute force for many threshold / sign / ROI / hemisphere combinations.
- `src/render/colormaps.test.ts` — the colour lookup tables.
- `src/export/ply.test.ts`, `src/export/blenderBundle.test.ts` — PLY byte layout and round trip, CRC-32, ZIP validity
  (also `unzip -t` when available), `scene.json` schema, unique file names, Blender camera orientation for every
  canonical view and for arbitrary trackball rotations.

Cases marked `it.fails` document a known bug in the application code (the comment above each one has the
reproduction); they turn red when the bug is fixed, at which point `it.fails` becomes `it`. Cases marked
`it.skip` with `TODO(restart)` encode behaviour that changed and still need to be rewritten.

## Not written yet

`src/export/bake.test.ts`, `src/export/sceneFromDataset.test.ts`, fixture-based tests for `toDirectionality` /
`bakeDirectionality`, and the real-data integration suite `src/integration/demoDataset.test.ts`
(`public/data/nki_fsaverage4`).
