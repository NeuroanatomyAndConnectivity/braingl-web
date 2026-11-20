import { GlyphApp } from "./glyphs/glyphApp";
import { toDirectionality } from "./bridge/toDirectionality";
import { colormapLut } from "./render/colormaps";
import type { DirectionalityHandle } from "./directionalityWorkspace";
import { downloadBlob } from "./ui/panel";

function showBanner(msg: string): void {
  const b = document.getElementById("banner");
  if (b) { b.textContent = msg; b.style.display = "block"; }
}

interface Workspace {
  id: string;
  title: string;
  root: HTMLElement;
  setActive(active: boolean): void;
}

function workspaceShell(id: string): { root: HTMLElement; view: HTMLElement; panel: HTMLElement } {
  const root = document.createElement("div");
  root.className = "workspace";
  root.id = "ws-" + id;
  const view = document.createElement("div");
  view.className = "ws-view";
  const panel = document.createElement("aside");
  panel.className = "ws-panel";
  root.append(view, panel);
  return { root, view, panel };
}

function boot(): void {
  const stage = document.getElementById("stage")!;
  const tabs = document.getElementById("tabs")!;
  const workspaces: Workspace[] = [];

  // --- Directionality: the vendored directionality-indicator app, loaded on first use
  const d = workspaceShell("directionality");
  stage.appendChild(d.root);
  let directionality: Promise<DirectionalityHandle | null> | null = null;
  const ensureDirectionality = () => {
    directionality ??= import("./directionalityWorkspace").then((m) => m.mountDirectionality(d.view, d.panel)).catch((e) => {
      console.error(e);
      showBanner("Directionality workspace failed to start: " + (e instanceof Error ? e.message : String(e)));
      return null;
    });
    return directionality;
  };

  // --- Connectivity glyphs
  const g = workspaceShell("glyphs");
  stage.appendChild(g.root);
  const glyphs = new GlyphApp(g.view, g.panel, {
    openInDirectionality: async (surface, source) => {
      try {
        const input = toDirectionality(surface, source, colormapLut(glyphs.params.colormap));
        show("directionality");
        const handle = await ensureDirectionality();
        await handle?.loadDataset(input.name, input.ply, input.labels, input.order);
      } catch (e) {
        glyphs.report(e);
      }
    },
  });
  // --- Blender export of whichever workspace is in front (code loaded on demand)
  const scriptUrl = new URL("blender/import_braingl.py", document.baseURI).href;
  const exportForBlender = async () => {
    const btn = document.getElementById("blender-export") as HTMLButtonElement;
    btn.disabled = true;
    try {
      const { buildBundleZip } = await import("./export/blenderBundle");
      if (current === "directionality") {
        const [{ bakeDirectionality, defaultArrowParams }, { loadCachedDataset }] = await Promise.all([
          import("./export/directionalityBake"), import("./directionality/io/datasetCache"),
        ]);
        const cached = await loadCachedDataset();
        if (!cached) throw new Error("No directionality dataset is loaded.");
        let stored = {};
        try { stored = JSON.parse(localStorage.getItem("di-panel-params-v1") ?? "{}"); } catch { /* defaults */ }
        const layers = bakeDirectionality(cached.plyText, cached.labelsText, cached.orderText, { ...defaultArrowParams, ...stored });
        downloadBlob(await buildBundleZip(cached.name, layers, [0.05, 0.05, 0.06], null, scriptUrl), "braingl-directionality-blender.zip");
      } else {
        const { bakeGlyphScene } = await import("./export/bake");
        const st = glyphs.exportState();
        if (!st) throw new Error("No glyph dataset is loaded.");
        const layers = bakeGlyphScene(st.bake);
        const title = `${st.bake.ds.name} (${st.bake.params.glyphStyle})`;
        downloadBlob(await buildBundleZip(title, layers, st.background, st.camera, scriptUrl), `braingl-${st.bake.params.glyphStyle}-blender.zip`);
      }
    } catch (e) {
      console.error(e);
      if (current === "glyphs") glyphs.report(e); else showBanner(e instanceof Error ? e.message : String(e));
    } finally {
      btn.disabled = false;
    }
  };
  document.getElementById("blender-export")!.addEventListener("click", () => void exportForBlender());

  workspaces.push({ id: "glyphs", title: "Connectivity glyphs", root: g.root, setActive: (a) => glyphs.setActive(a) });
  workspaces.push({
    id: "directionality", title: "Directionality", root: d.root,
    setActive: (a) => { if (a) void ensureDirectionality().then((h) => h?.requestRender()); },
  });

  let current = "glyphs";
  const show = (id: string) => {
    if (!workspaces.some((w) => w.id === id)) id = "glyphs";
    current = id;
    for (const w of workspaces) {
      const on = w.id === id;
      w.root.hidden = !on;
      w.setActive(on);
    }
    tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.ws === id));
    try { localStorage.setItem("braingl.workspace", id); } catch { /* ignore */ }
  };
  for (const w of workspaces) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = w.title; b.dataset.ws = w.id;
    b.addEventListener("click", () => show(w.id));
    tabs.appendChild(b);
  }
  document.getElementById("shell-panel-toggle")!.addEventListener("click", () => {
    document.body.classList.toggle("panel-closed");
    window.dispatchEvent(new Event("resize"));
  });
  // the documentation is published next to the app (see .github/workflows/deploy.yml)
  if (import.meta.env.PROD) document.getElementById("docs-link")?.removeAttribute("hidden");
  let start = "glyphs";
  try { start = new URLSearchParams(location.search).get("workspace") ?? localStorage.getItem("braingl.workspace") ?? "glyphs"; } catch { /* ignore */ }
  show(start);
  // ?data=<folder with a glyphset.json> loads another glyphset hosted next to the app instead of the demo
  let dataUrl: string | null = null;
  try { dataUrl = new URLSearchParams(location.search).get("data"); } catch { /* ignore */ }
  void glyphs.loadDemo(dataUrl ? dataUrl.replace(/\/?$/, "/") : undefined);
  (window as unknown as { braingl: unknown }).braingl = { glyphs, show, directionality: ensureDirectionality, exportForBlender };
}

try {
  boot();
} catch (err) {
  console.error(err);
  showBanner(err instanceof Error ? err.message : String(err));
}
