# Installation

**Goal:** run brainGL web on your own computer.
**You need:** a terminal, [Node.js](https://nodejs.org/) version 20 or newer (it includes `npm`),
and a browser with WebGL2.
**Result:** the app open at <http://localhost:5173> with the demo data loaded.

If somebody has already put a copy of brainGL web on a web server for you, you do not need to
install anything: open that address and go to the [Quick start](quickstart.md).

## Requirements

- **Node.js 20 or newer**, only to install the dependencies and to serve or build the app.
  Check with `node --version`.
- **A browser with WebGL2**: a current desktop version of Chrome, Edge, Firefox or Safari.
  The Directionality workspace also needs the `EXT_color_buffer_float` extension, which
  these browsers provide. A dedicated graphics card helps with large glyphsets but is not required
  for the demo. See [Limits](../reference/limits.md) for details.
- **Python 3** with `numpy` and `nibabel` only if you want to convert your own data with
  `tools/make_glyphset.py` (see [Your own data](../tutorials/own-data.md)).
- **Blender 3.6 or newer** only if you want to render exported scenes
  (see [Blender export](../tutorials/blender.md)).

## Install and run

1. Get the source code. The location of the public repository is not fixed yet; replace
   `<repository-url>` with the address you were given.

    ```bash
    git clone <repository-url> braingl-web
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
   your own computer and the left hemisphere appears with point glyphs.

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
npm test             # unit tests
npm run typecheck    # TypeScript type check
```

Both should finish without errors. [Testing](../development/testing.md) describes what the
tests cover.

## Problems

| Symptom | Cause and remedy |
|---|---|
| A red banner "WebGL2 is not available in this browser." | The browser or its graphics driver does not provide WebGL2. Update the browser, or enable hardware acceleration in its settings. |
| The status line shows "demo data not found at data/nki_fsaverage4/" | The folder `public/data/nki_fsaverage4/` is missing from your copy. Fetch the complete repository, or load your own files with **Open files…**. |
| `npm install` fails with an engine or syntax error | Node.js is older than version 20. |
| Port 5173 is in use | Start the server on another port: `npx vite --port 5180`. |
