# Deploy your own copy

The built app is a folder of static files. Any web server can host it; no server-side code runs.
The reference copy is at <https://neuroanatomyandconnectivity.github.io/braingl-web/> (the app)
and <https://neuroanatomyandconnectivity.github.io/braingl-web/docs/> (this documentation),
published from <https://github.com/NeuroanatomyAndConnectivity/braingl-web>.

## Which data are loaded

- By default the app loads the web glyphset in `data/nki_fsaverage4/` next to the page.
- `?data=<folder>` in the address loads another web glyphset instead: a folder with a
  `glyphset.json`, given relative to the page, for example
  `http://localhost:5173/?data=data/local/my_set` during development or
  `https://your.server/braingl/?data=data/my_set` on your own host.
- The folder must be on the **same origin** as the app (same scheme, host and port). An
  address that points to another origin is ignored with a warning in the browser console, and
  the demo loads instead. To show data that live elsewhere, copy them next to your own copy of
  the app, or open them from disk with **Open folder…**.
- `?workspace=directionality` starts in the Directionality workspace.
- The **Demo** button always loads `data/nki_fsaverage4/`.

## With your own data

1. Create a web glyphset ([Your own data](../tutorials/own-data.md)) in `public/data/<name>/`.
   (`public/data/local/` is ignored by git and meant for data you do not want to commit.)
2. Either link to the site with `?data=data/<name>`, or replace the contents of
   `public/data/nki_fsaverage4/` to make your data the default.
3. Build: `npm run build`. Everything in `public/` is copied to `dist/`.
4. Check locally: `npm run preview`, then open `http://localhost:4173/?data=data/<name>`.

Only put data on a public server that you are allowed to share. Visitors download the whole
glyphset. If you keep the bundled demo data in your copy, keep its credit (enhanced NKI
Rockland Sample, Nooner et al. 2012; see `NOTICE.md`).

## GitHub Pages

The repository contains `.github/workflows/deploy.yml`. On every push to `main` it runs the
tests, builds the app, builds this documentation into `docs/` of the site and publishes both.
To publish your own fork:

1. Fork <https://github.com/NeuroanatomyAndConnectivity/braingl-web> or push your copy to
   GitHub.
2. In the repository settings, **Pages → Build and deployment → Source**, choose *GitHub Actions*.
3. Push to `main` or start the workflow by hand. The app is then at
   `https://<user>.github.io/<repository>/` and the documentation under `docs/`.

The build sets the base path to `/<repository>/` by itself when it runs on GitHub Actions.
The documentation links in `mkdocs.yml` (`site_url`, `repo_url`, and the *Open the app* entry of
the navigation) point to the reference copy; change them for a fork.

## Any other static host

Run `npm run build` and copy `dist/` to the server. The app uses relative addresses for its
data, so it works in a sub-folder, but the scripts are referenced from the base path: for a
sub-folder build with `npx vite build --base=/sub/folder/`.

The documentation is a separate build: `pip install mkdocs-material`, then
`mkdocs build -d dist/docs` puts it where the **Docs** link of the app expects it.
