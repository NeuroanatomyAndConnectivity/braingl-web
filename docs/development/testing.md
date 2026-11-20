# Testing

There are three kinds of tests: unit tests (Vitest, TypeScript), tests of the Python data tool (pytest) and an
end-to-end smoke test in headless Chrome. This page describes what is in the repository.

## Unit tests (Vitest)

```
npm test               # vitest run: all tests once
npm run test:watch     # vitest: re-run on change
npx vitest run src/glyphs      # a subset, by path
```

There is no `vitest.config.ts`: Vitest uses its defaults (Node environment, every `*.test.ts` under the project, including
the vendored folder) together with `vite.config.ts`. Tests therefore must not touch the DOM or WebGL; code that
does (`glyphApp.ts`, `render/renderer.ts`) is covered by the end-to-end test, and the testable logic has been kept in pure modules
(`builders.ts`, `connMatrix.ts`, `picking.ts`, `io/`, `export/`).

Test files sit next to the module they test (`foo.ts` and `foo.test.ts`):

| Area | Test files |
|---|---|
| Glyph builders and picking | `src/glyphs/builders.test.ts`, `builders.datasets.test.ts`, `picking.test.ts` |
| Data model | `src/data/connMatrix.test.ts`, `dataset.test.ts`, `loadFiles.test.ts` |
| File formats | `src/io/npy.test.ts`, `gifti.test.ts`, `freesurferAsc.test.ts`, `freesurferBinary.test.ts`, `glyphsetFiles.test.ts` |
| Bundling and connexel files | `src/algorithms/meanShiftBundling.test.ts`, `connexelFiles.test.ts` |
| Rendering helpers | `src/render/colormaps.test.ts`, `src/gfx/camera.test.ts` |
| Bridge | `src/bridge/toDirectionality.test.ts` |
| Vendored Directionality | `src/directionality/**/*.test.ts` (copied from upstream and patched by the vendoring script; they read the data in `public/directionality`) |
| The fixtures themselves | `src/testing/fixtures.test.ts` |

### Fixtures and references (`src/testing/`)

Not tests, but the shared material:

- `fixtures.ts`: deterministic synthetic example datasets generated in code, with no files and no `Math.random`:
  `icoBrain(level)` (two mirrored icosphere hemispheres with three surfaces, a `sulc` overlay and a block-structured
  correlation matrix with known network modules), `singleHemisphere`, and variants `withMedialWall`, `anticorrelated`,
  `weighted` (maxAbs of 5), `directed` (asymmetric, to catch row/column mix-ups); `ALL_FIXTURES` lists them. `lcg(seed)` is the
  seeded random generator.
- `serialise.ts`: writes a fixture to every on-disk layout the loaders accept, as in-memory `File` objects: web glyphset (int8,
  int16, float32; upper and full), brainGL files (`.glyphset`, `.set`, `.asc`, raw matrix, ROI) and loose files (GIFTI, FreeSurfer
  binary or ASCII, `.npy` or raw). The formats are written from their specifications, independently of the parsers.
- `reference.ts`: slow, obviously correct reference implementations (plain double loops over the float values), such as the
  threshold rule of the shader, against which the application code is compared. They do not import the code under test.

The pattern for a new test: take a fixture, compute the expected result with a reference function or a closed form, compare with
the module under test (`describe.each(ALL_FIXTURES)` is common).

## Python tests (pytest)

```
pip install numpy scipy nibabel pytest
python -m pytest tests/python -q
```

`tests/python/test_make_glyphset.py` tests `tools/make_glyphset.py` (quantisation, upper-triangle order, round trip with
`to-braingl`, the sub-commands; the `nki-demo` test replaces nilearn's download functions with local synthetic files and
never uses the network, and needs nilearn). Expected values come from closed forms or brute-force loops, not from the tool's
own output. Cases marked `xfail(strict=True)`, if any, document known defects of the tool and turn into failures when the defect is fixed,
so that the mark can be removed.

## End-to-end smoke test

```
npm run test:e2e                          # build, then test dist/ with `vite preview`
node tests/e2e/smoke.mjs                  # test the existing dist/
node tests/e2e/smoke.mjs --url http://localhost:5173/    # a server that is already running
```

`tests/e2e/smoke.mjs` drives headless Chrome with `puppeteer-core` (no bundled browser; set `CHROME_PATH`, otherwise Google Chrome
is looked up, on macOS in `Google Chrome.app`). It prints one PASS or FAIL line per check and exits 1 on any failure. The checks
include: the demo glyphset loads (5,124 nodes); every glyph style and the polar geometry draw pixels, differ from one another and
turn off again; selecting a seed recolours the inset; no console or page errors; the Directionality workspace mounts and draws; the
bridge loads a map into it; "Export for Blender" downloads a zip whose layers match `scene.json`; the view is restored after a
reload. Options: `--url`, `--port`, `--timeout`, `--headed`, `--screenshots`, `--artifacts`. Screenshots of failures go to
`tests/e2e/.artifacts` (git-ignored). Read the header of the script for the current list.

The folder `tests/blender` is present but empty at the time of writing.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: `npm run typecheck`, `npm test` and `npm run build` (Node
20); `pytest tests/python` (Python 3.12 with numpy, scipy, nibabel); and `mkdocs build --strict` for this documentation. The end-to-end
test is not part of CI. Run the three npm checks (and the others when you touch their areas) before opening a pull request;
see [Contributing](contributing.md).
