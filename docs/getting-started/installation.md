# Installation

**Goal:** run brainGL web on your own computer.
**You need:** a terminal, [git](https://git-scm.com/), [Node.js](https://nodejs.org/) version 20
or newer (it includes `npm`), and a browser with WebGL2.
**Result:** the app open at <http://localhost:5173> with the demo data loaded.

You do not need to install anything to use the app: a hosted copy is at
<https://neuroanatomyandconnectivity.github.io/braingl-web/>. Open it and go to the
[Quick start](quickstart.md). Files you open there are read by your browser and are not
uploaded. Install your own copy if you want to work offline, serve your own data to
colleagues, convert data with the Python tool, or change the code.

## Requirements

- **Node.js 20 or newer**, only to install the dependencies and to serve or build the app.
  Check with `node --version`.
- **A browser with WebGL2**: a current desktop version of Chrome, Edge, Firefox or Safari.
  The Directionality workspace also needs the `EXT_color_buffer_float` extension, which
  these browsers provide. A dedicated graphics card helps with large glyphsets but is not required
  for the demo. See [Limits](../reference/limits.md) for details.
- **Python 3** with `numpy` and `nibabel` only if you want to convert your own data with
  `tools/make_glyphset.py`; add `scipy` and `nilearn` to rebuild the demo data or to follow the
  example in [Your own data](../tutorials/own-data.md).
- **Blender 3.6 or newer** only if you want to render exported scenes
  (see [Blender export](../tutorials/blender.md)).

## Install and run

1. Get the source code.

    ```bash
    git clone https://github.com/NeuroanatomyAndConnectivity/braingl-web.git
    cd braingl-web
    ```

2. Install the dependencies. This downloads the build tools into `node_modules/`.

    ```bash
    npm install
    ```

3. Start the development server.

    ```bash
    npm run dev
    ```

4. Open <http://localhost:5173> in your browser. The demo glyphset (about 13.5 MB) loads from
   your own computer; a progress box shows the download, then the inflated surface appears in a
   left lateral view with point glyphs.

Stop the server with Ctrl+C in the terminal. Your settings in the app are kept by the browser
between sessions.

## Build a static copy

The app is a static web site: after a build it is a folder of files that any web server can
serve.

```bash
npm run build      # type-check, then write the site to dist/
npm run preview    # serve dist/ locally to check it (http://localhost:4173)
```

To put the result on a server, with or without your own data, see
[Deploy your own copy](../how-to/deploy.md).

## Check the installation

```bash
npm run typecheck    # TypeScript type check
npm test             # unit and integration tests
```

Both should finish without errors. Three further suites need extra software:

```bash
npm run test:e2e                     # builds, then drives the app in headless Chrome
python -m pytest tests/python -q     # the data tool; needs numpy, scipy, nibabel and pytest
blender --background --python tests/blender/test_import.py   # the Blender import script
```

[Testing](../development/testing.md) describes what the tests cover.

## Problems

| Symptom | Cause and remedy |
|---|---|
| A red banner "WebGL2 is not available in this browser." | The browser or its graphics driver does not provide WebGL2. Update the browser, or enable hardware acceleration in its settings. |
| The status line shows "demo data not found at data/nki_fsaverage4/" | The folder `public/data/nki_fsaverage4/` is missing from your copy. Fetch the complete repository, or load your own files with **Open files…**. |
| `npm install` fails with an engine or syntax error | Node.js is older than version 20. |
| Port 5173 is in use | Start the server on another port: `npx vite --port 5180`. |
