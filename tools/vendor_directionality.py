#!/usr/bin/env python3
"""Vendor directionality-indicator-webgl into src/directionality/.

The Directionality workspace of brainGL-web is the unmodified upstream app
(https://github.com/NeuroanatomyAndConnectivity/directionality-indicator-webgl,
LGPL-3.0-or-later) plus the few mechanical patches below, which let it live
inside a host page instead of owning the whole document. Re-run this script
against a newer upstream checkout to update:

    python3 tools/vendor_directionality.py /path/to/directionality-indicator-webgl

Each patch asserts that it applied, so upstream changes that break one are
noticed immediately.
"""
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "src" / "directionality"
DATA = ROOT / "public" / "directionality"
SCOPE = "#ws-directionality"


def patch(path: Path, old: str, new: str, count: int = 1) -> None:
    s = path.read_text()
    if s.count(old) < count:
        raise SystemExit(f"patch no longer applies to {path.name}: {old[:70]!r}")
    path.write_text(s.replace(old, new))


def scope_css(css: str) -> str:
    """Prefix every selector with the workspace id; turn :root into the workspace itself."""
    out, i, n = [], 0, len(css)

    def block(start: int) -> int:  # index just after the matching closing brace
        depth, k = 0, start
        while k < n:
            if css[k] == "{":
                depth += 1
            elif css[k] == "}":
                depth -= 1
                if depth == 0:
                    return k + 1
            k += 1
        return n

    while i < n:
        brace = css.find("{", i)
        if brace < 0:
            out.append(css[i:])
            break
        prelude = css[i:brace]
        comment_free = re.sub(r"/\*.*?\*/", "", prelude, flags=re.S).strip()
        end = block(brace)
        body = css[brace:end]
        if comment_free.startswith("@keyframes") or comment_free.startswith("@font-face"):
            out.append(prelude + body)
        elif comment_free.startswith("@"):
            out.append(prelude + "{" + scope_css(body[1:-1]) + "}")
        else:
            sels = []
            for sel in comment_free.split(","):
                sel = sel.strip()
                if sel in (":root", "html", "body"):
                    sels.append(SCOPE)
                elif sel in ("#app", "#banner"):
                    continue  # provided by the host page
                elif sel.startswith(".panel-tooltip"):
                    sels.append(sel)  # tooltips are appended to <body>
                else:
                    sels.append(f"{SCOPE} {sel}")
            if sels:
                lead = prelude[: len(prelude) - len(prelude.lstrip())]
                out.append(f"{lead}{', '.join(sels)} {body}")
        i = end
    return "".join(out)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    up = Path(sys.argv[1]).resolve()
    rev = subprocess.run(["git", "-C", str(up), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()

    if DEST.exists():
        shutil.rmtree(DEST)
    shutil.copytree(up / "src", DEST, ignore=shutil.ignore_patterns("main.ts", "vite-env.d.ts"))
    for f in ("LICENSE", "LICENSE.LESSER", "NOTICE.md"):
        shutil.copy(up / f, DEST / f)

    DATA.mkdir(parents=True, exist_ok=True)
    for f in (up / "public" / "data").iterdir():
        shutil.copy(f, DATA / f.name)

    # ---- patches -------------------------------------------------------------
    app = DEST / "app.ts"
    # 1. bundled data lives in its own folder
    patch(app, "${import.meta.env.BASE_URL}data/${name}", "${import.meta.env.BASE_URL}directionality/${name}", 3)
    patch(DEST / "ui" / "panel.ts", "${import.meta.env.BASE_URL}data/manifest.json", "${import.meta.env.BASE_URL}directionality/manifest.json")
    # 2. the host decides where the panel goes and gets a handle to load data
    patch(app, "export async function runApp(container: HTMLElement): Promise<void> {",
          "export interface DirectionalityHandle {\n"
          "  /** Load a dataset from memory (same three texts as the file picker). */\n"
          "  loadDataset(name: string, plyText: string, labelsText: string, orderText: string): Promise<void>;\n"
          "  requestRender(): void;\n"
          "}\n\n"
          "export async function runApp(container: HTMLElement, panelHost: HTMLElement = container): Promise<DirectionalityHandle | null> {")
    patch(app, "LIC requires it.\");\n    return;", "LIC requires it.\");\n    return null;")
    patch(app, "  container.appendChild(panelElement);", "  panelHost.appendChild(panelElement);")
    patch(app, "\n  view.requestRender();\n}\n",
          "\n  view.requestRender();\n\n"
          "  return {\n"
          "    async loadDataset(name, plyText, labelsText, orderText) {\n"
          "      loadAndCache(plyText, labelsText, orderText);\n"
          "      params.lastDatasetName = name;\n"
          "      params.lastDatasetFiles = { ply: name, labels: \"sent from the glyph workspace\", labelorder: \"\" };\n"
          "      saveParams(params);\n"
          "      await saveDataset({ name, plyText, labelsText, orderText });\n"
          '      (panelElement.querySelector(\'[data-role="loaded-status"]\') as (HTMLElement & { refresh?: () => void }) | null)?.refresh?.();\n'
          "      if (bounds) applyCanonicalView(\"lateral-left\", bounds.center, bounds.radius);\n"
          "      view.requestRender();\n"
          "    },\n"
          "    requestRender: () => view.requestRender(),\n"
          "  };\n}\n")
    patch(DEST / "ui" / "panel.ts", '    status.className = "panel-note";\n    renderLoadedStatus(status, params);',
          '    status.className = "panel-note";\n    status.dataset.role = "loaded-status";\n'
          '    (status as HTMLElement & { refresh?: () => void }).refresh = () => renderLoadedStatus(status, params);\n'
          '    renderLoadedStatus(status, params);')
    # 3. do not resize to 0 x 0 (and re-allocate the LIC targets) while the workspace is hidden
    patch(DEST / "gfx" / "view.ts", "    const h = Math.floor(container.clientHeight * dpr);\n",
          "    const h = Math.floor(container.clientHeight * dpr);\n    if (w === 0 || h === 0) return; // hidden workspace\n")

    # 5. WebGL2 cannot generate mipmaps for depth textures: the call only logged GL_INVALID_OPERATION every frame
    patch(DEST / "gfx" / "framebuffer.ts",
          "      if (spec.depth && depthTexture) {\n        gl.bindTexture(gl.TEXTURE_2D, depthTexture);\n        gl.generateMipmap(gl.TEXTURE_2D);\n      }\n",
          "")
    # 4. tests read the bundled demo data, which moved one level up and into public/directionality
    for t in DEST.rglob("*.test.ts"):
        txt = t.read_text()
        txt = txt.replace('"../..", "public", "data"', '"../../..", "public", "directionality"')
        txt = txt.replace('"../../public/data/', '"../../../public/directionality/')
        t.write_text(txt)

    # ---- styles ----------------------------------------------------------------
    html = (up / "index.html").read_text()
    css = re.search(r"<style>(.*?)</style>", html, flags=re.S).group(1)
    scoped = scope_css(css)
    scoped += f"""
/* ---- host integration (not upstream) ---- */
{SCOPE} #panel-root {{ position: static; width: 100%; height: 100%; display: block; pointer-events: auto; }}
{SCOPE} #panel {{ width: 100%; height: 100%; border-left: none; background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; transform: none !important; }}
{SCOPE} #panel-toggle, {SCOPE} #panel-collapse-btn {{ display: none !important; }}
{SCOPE} .ws-view canvas {{ position: absolute; inset: 0; width: 100%; height: 100%; display: block; }}
{SCOPE} .ws-panel {{ overflow: hidden; }}
"""
    (DEST / "directionality.css").write_text(
        f"/* Generated by tools/vendor_directionality.py from upstream index.html ({rev[:10]}). Do not edit. */\n" + scoped)

    (DEST / "VENDORED.md").write_text(
        "# Vendored: directionality-indicator-webgl\n\n"
        "Source: https://github.com/NeuroanatomyAndConnectivity/directionality-indicator-webgl\n\n"
        f"Revision: `{rev}`\n\n"
        "Licence: LGPL-3.0-or-later (see `LICENSE`, `LICENSE.LESSER`, `NOTICE.md` in this folder).\n\n"
        "Everything in this folder is upstream code. It is copied by\n"
        "`tools/vendor_directionality.py`, which also applies five small patches\n"
        "(data folder, panel host + programmatic `loadDataset`, no resize while hidden, test data paths,\n"
        "no mipmap generation on the depth texture)\n"
        "and generates `directionality.css` by scoping the upstream page styles to\n"
        "`#ws-directionality`. Change upstream and re-run the script rather than\n"
        "editing files here.\n")
    print(f"vendored {rev[:10]} -> {DEST.relative_to(ROOT)} ({sum(1 for _ in DEST.rglob('*.ts'))} ts files)")


if __name__ == "__main__":
    main()
