# Contributing

This page is the same text as `CONTRIBUTING.md` at the repository root (the root file is the one that GitHub shows).

## Set up

You need Node.js 20 or newer and npm. For the data tools and the documentation you also need Python 3.

```
npm install
npm run dev          # http://localhost:5173
```

See [Architecture](architecture.md) for the layout of the code and how to extend it. The vendored `src/directionality/`
folder is not edited by hand ([Vendored Directionality](vendored-directionality.md)). To build these docs:
`pip install mkdocs-material`, then `mkdocs serve` or `mkdocs build --strict`.

## Workflow

1. Open an issue first for anything larger than a small fix.
2. Create a branch from `main` (for example `fix/pie-threshold`).
3. Make focused changes, one topic per pull request. Add or update tests next to the code (`*.test.ts`) and update `docs/`
   when behaviour, parameters or file formats change; check numbers and defaults against the code.
4. Run the checks below.
5. Open a pull request against `main` describing what changed, why, and how you checked it.

## Checks before a pull request

```
npm run typecheck    # strict TypeScript
npm test             # unit tests (vitest)
npm run build        # type-check and production build
```

CI also runs `pytest tests/python` (the data tools) and `mkdocs build --strict` (the documentation); run them if you
touched `tools/` or `docs/`. See [Testing](testing.md).

## Conventions

- TypeScript in strict mode; no runtime dependencies other than `gl-matrix`; shaders as `.glsl?raw`.
- Data-handling code does not depend on the DOM.
- Changing a shader means changing its CPU mirror in `src/export/bake.ts`.
- Plain, direct English; no emojis.

## Commit messages

A short imperative summary line (about 70 characters), then if needed a blank line and a paragraph that explains why.
Unrelated changes go in separate commits.

## Reporting bugs

Include what you did and expected, what happened (error text from the status line or the browser console), browser,
operating system and GPU, the dataset type and node count, a small file that shows the problem if you can share one,
and your settings (a saved scene file, or `braingl.glyphs.params`). A screenshot helps for visual problems.

## Conduct

Be respectful: assume good faith, criticise ideas and code rather than people, and keep discussion on the work.
Harassment and discrimination are not acceptable in any project space. The maintainer may edit or remove contributions and
block participants who do not follow this.

## Licence

Contributions are released under the project's MIT licence; changes to `src/directionality/` belong upstream (LGPL).
