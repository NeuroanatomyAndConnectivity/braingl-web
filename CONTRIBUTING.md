# Contributing to brainGL web

Thank you for considering a contribution. This project is a browser port of the connectivity glyphs of brainGL; bug
reports, data-format reports, documentation fixes and code are all welcome.

## Set up

You need Node.js 20 or newer and npm. For the data tools and the documentation you also need Python 3.

```
npm install
npm run dev          # http://localhost:5173
```

Layout of the code and how to extend it: see `docs/development/architecture.md` (published as Development, Architecture).
The vendored `src/directionality/` folder is not edited by hand (`docs/development/vendored-directionality.md`).

To build the documentation: `pip install mkdocs-material` then `mkdocs serve` or `mkdocs build --strict`.

## Workflow

1. Open an issue first for anything larger than a small fix, so that the approach can be discussed.
2. Create a branch from `main` (for example `fix/pie-threshold` or `feature/gifti-labels`).
3. Make focused changes: one topic per pull request. Add or update tests next to the code (`*.test.ts`) and update the
   documentation in `docs/` when behaviour, parameters or file formats change. Reference pages are derived from the source,
   so check the numbers and defaults against the code.
4. Run the checks below.
5. Open a pull request against `main` that says what changed and why, and how you checked it. Continuous integration
   runs the same checks.

## Checks before a pull request

```
npm run typecheck    # strict TypeScript
npm test             # unit tests (vitest)
npm run build        # type-check and production build
```

CI additionally runs `pytest tests/python` (the data tools; needs `numpy`, `scipy`, `nibabel`, `pytest`) and
`mkdocs build --strict` (the documentation). Run them if you touched `tools/` or `docs/`.

## Code conventions

- TypeScript in strict mode; no runtime dependencies other than `gl-matrix`.
- Shaders are `.glsl` files imported with `?raw`.
- Data-handling code does not depend on the DOM (it must run in workers, Node and tests).
- If you change a shader, change its CPU mirror in `src/export/bake.ts` as well.
- Plain, direct English in comments and documentation; no emojis.

## Commit messages

Write a short imperative summary line (about 70 characters), then, if needed, a blank line and a paragraph that explains
why. Keep unrelated changes in separate commits. Examples: `Fix pie ranks when the minimum length is zero`,
`Add GIFTI label arrays as overlays`.

## Reporting bugs

Open an issue and include:

- what you did and what you expected;
- what happened, including the text of the error in the status line or the browser console (F12);
- the browser and version, operating system and GPU;
- the dataset type (web glyphset, brainGL `.glyphset`, loose files), the node count and, if you can share them, the files
  or a small file that shows the problem;
- the settings (a saved scene file helps) and the output of `braingl.glyphs.params` in the console.

For visual problems a screenshot helps. Security problems should be reported privately to the maintainer rather than in a public issue.

## Conduct

Be respectful. Assume good faith, give and accept criticism of ideas and code without making it personal, and keep the
discussion on the work. Harassment and discrimination are not acceptable in issues, pull requests or any other project space.
The maintainer may edit or remove contributions and block participants who do not follow this.

## Licence

By contributing you agree that your contribution is released under the MIT licence of the project (`LICENSE`). Contributions
to `src/directionality/` belong upstream, where the licence is the LGPL.
