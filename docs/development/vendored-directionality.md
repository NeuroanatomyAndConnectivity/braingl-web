# Vendored Directionality

The second workspace, **Directionality**, is not written for this project. It is a copy of
[directionality-indicator-webgl](https://github.com/NeuroanatomyAndConnectivity/directionality-indicator-webgl),
the web port of Sebastian Eichelbaum's *DirectionalityIndicator* (surface line-integral convolution plus
arrows on a parcellated surface), kept in `src/directionality/`.

## What is vendored

- everything under upstream `src/` except `main.ts` and `vite-env.d.ts` (the host page replaces them), into
  `src/directionality/`: `app.ts`, `gfx/`, `io/`, `algorithms/`, `shaders/`, `ui/`, with their tests;
- the upstream `LICENSE`, `LICENSE.LESSER` and `NOTICE.md`, into the same folder;
- the upstream demo data (`public/data/*`), into `public/directionality/`;
- the style sheet: the `<style>` block of the upstream `index.html`, scoped to `#ws-directionality`, as
  `src/directionality/directionality.css`, plus a few host-integration rules (generated, marked "not upstream").

The revision is recorded in `src/directionality/VENDORED.md`: `2886087364fe4b68de516ab61cd71c3f580024f4`.

## Patches applied by `tools/vendor_directionality.py`

Each patch asserts that it applied, so an upstream change that breaks one fails loudly
(`patch no longer applies to ...`).

| # | Where | Change | Why |
|---|---|---|---|
| 1 | `app.ts`, `ui/panel.ts` | Bundled data is fetched from `${BASE_URL}directionality/...` instead of `${BASE_URL}data/...`. | The demo glyphset occupies `public/data/`. |
| 2 | `app.ts` | `runApp(container, panelHost = container)` places the panel in a host element, returns `null` instead of `undefined` when LIC is unsupported, and returns a `DirectionalityHandle` with `loadDataset(name, ply, labels, order)` and `requestRender()`. `ui/panel.ts` marks the loaded-dataset status line so it can be refreshed. | The glyph workspace sends data in memory through the bridge, and the app shell owns the layout. |
| 3 | `gfx/view.ts` | Skip the resize when the width or height is 0. | A hidden workspace would otherwise resize to 0 x 0 and re-allocate the LIC targets. |
| 4 | `*.test.ts` | Test data paths point to `public/directionality`. | The demo data moved. |
| 5 | `gfx/framebuffer.ts` | The `generateMipmap` call on the depth texture is removed. | WebGL2 cannot mip-map depth textures; the call only logged `GL_INVALID_OPERATION` every frame. |

## How to update

1. Check out the new upstream revision (a git checkout, so that its `HEAD` can be recorded).
2. From the repository root: `python3 tools/vendor_directionality.py /path/to/directionality-indicator-webgl`.
   This deletes and re-creates `src/directionality/` and refreshes `public/directionality/`.
3. If a patch fails, adapt it in the script, not in `src/directionality/`.
4. Run `npm run typecheck`, `npm test` and `npm run build`; open the Directionality tab, load a bundled
   dataset and use the "Regions → Directionality" bridge once.
5. Commit the regenerated folder together with the script change. `VENDORED.md` is rewritten by the script with
   the new revision.

## Licence implications

- `src/directionality/` and `public/directionality/` are licensed **LGPL-3.0-or-later**, with the licence texts
  in `src/directionality/`. The rest of the repository is MIT. The two coexist: the MIT code calls the LGPL code
  through small interfaces (`runApp`, the `io/` readers and `algorithms/` used by `src/export/directionalityBake.ts`).
- Do not edit files in `src/directionality/` by hand. Any change belongs upstream or in the script's patches, which keeps
  the vendored folder reproducible and the modifications documented in one place.
- Modifications to the LGPL code itself must be released under the LGPL. The patched files stay under it; the full
  corresponding source is this repository.
- Anyone redistributing the app must keep `LICENSE`, `LICENSE.LESSER` and `NOTICE.md` of that folder with it. See
  [License](../about/license.md).
- Files in this repository that import from the vendored folder (`src/export/directionalityBake.ts`,
  `src/directionalityWorkspace.ts`, `src/main.ts`) remain MIT; if you need to combine them differently, check the
  LGPL's terms on linking.

This page is a technical summary, not legal advice.
