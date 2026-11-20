import { mat3, mat4 } from "gl-matrix";
import { Camera, CameraState, CanonicalView } from "../gfx/camera";
import { fractionAbove, thresholdForBudget } from "../data/connMatrix";
import {
  buildTopology, computeBounds, findSphere, GlyphDataset, hemisphereTriangles, MeshTopology, SphereInfo, surfaceIndexByName,
} from "../data/dataset";
import { isWebManifest, loadWebGlyphset, urlGetter } from "../data/loadWeb";
import { loadFromFiles } from "../data/loadFiles";
import { parseRoiRegions, writeRoi1D, writeRoiLabels } from "../io";
import { DrawState, GlyphRenderer, GlyphStyle, Viewport } from "../render/renderer";
import { colormapLut, COLORMAP_NAMES, lutToCss } from "../render/colormaps";
import { downloadBlob, hexToRgb, niceStep, Panel, stepDigits } from "../ui/panel";
import {
  averageConnectivity, buildConnexels, buildDiffConnexels, BuildFilter, computePieRanks, ConnexelEdges, ConnexelSet,
  createConnexels, sortForPies,
} from "./builders";
import { brushNodes, meanEdgeLength, pickNode } from "./picking";
import { assignRoiRegions } from "./roiRegions";
import { defaultGlyphParams, GlyphParams, lengthSurfaceIndex, valueUnit } from "./params";
import { defaultBundlingOptions, Polylines } from "../algorithms/meanShiftBundling";
import type { BundlingResponse } from "../algorithms/bundlingWorker";
import { writeCxls, writeFibVtk } from "../algorithms/connexelFiles";
import type { GlyphBakeInput } from "../export/bake";
import type { SceneCamera } from "../export/blenderBundle";

const STORAGE = "braingl.glyphs";

/**
 * On macOS ctrl-click is the system's secondary click (and some browsers report it as the right
 * button), so ctrl cannot also mean "paint" there: option (alt) takes that role.
 */
const IS_MAC = ((): boolean => {
  if (typeof navigator === "undefined") return false;
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad|ipod/i.test(uad?.platform || navigator.platform || "");
})();
const PAINT_GESTURE = IS_MAC ? "option + right-drag" : "ctrl + right-drag";

/** Parameters with a closed set of values (checked when settings come from storage or a scene file). */
const CHOICES: Partial<Record<keyof GlyphParams, readonly unknown[]>> = {
  hemi: [0, 1, 2],
  glyphStyle: ["points", "vectors", "pies", "diffpoints", "off"],
  glyphColorMode: [0, 1],
  sign: [0, 1, 2],
  tool: ["navigate", "seed", "paint", "erase"],
  glyphNodes: ["all", "painted"],
  lbColorMode: [0, 1, 2],
  lineColorMode: [0, 1],
  colormap: COLORMAP_NAMES,
};

/** Parameters that size buffers: kept within the range of their sliders. */
const LIMITS: Partial<Record<keyof GlyphParams, [number, number]>> = {
  budgetM: [0.5, 40],
  lbMax: [1, 2000],
  maxConnexels: [100, 40000],
  screenshotScale: [1, 8],
};

/** What the glyph workspace can hand to other workspaces / exporters. */
export interface SurfaceExport {
  name: string;
  positions: Float32Array;
  triangles: Uint32Array;
  /** per-node label (0 = unlabelled) and label colours, from painting */
  labels: Uint8Array;
  labelColors: string[];
  /** per-node scalars currently shown (seed map or overlay), or null */
  scalars: Float32Array | null;
  scalarName: string;
}

export interface GlyphAppHooks {
  /** shown as a button in the panel when provided */
  openInDirectionality?: (s: SurfaceExport, source: "labels" | "scalars") => void;
}

export class GlyphApp {
  readonly params: GlyphParams;
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly renderer: GlyphRenderer;
  private readonly cams = [new Camera(), new Camera()];
  private panel!: Panel<GlyphParams>;
  private readonly statusEl: HTMLElement;
  private readonly progressEl: HTMLElement;
  private readonly insetEl: HTMLElement;
  private readonly legendEl: HTMLElement;
  private readonly dropEl: HTMLElement;

  ds: GlyphDataset | null = null;
  private topo: MeshTopology | null = null;
  private sphere: SphereInfo | null = null;

  // selection / painting
  cursorNode = -1;
  private seedRow = new Float32Array(0);
  private seedIsAverage = false;
  labels: Uint8Array = new Uint8Array(0);
  labelColors: string[] = [];
  private paintRgba: Uint8Array = new Uint8Array(0);
  private fileRoi: Uint8Array | null = null;
  /** optional restriction of connection targets (second ROI of a brainGL .glyphset file) */
  private targets: Uint8Array | null = null;

  // glyph pipeline state
  private glyphNodes: Uint8Array = new Uint8Array(0);
  private cum: Float64Array | null = null;
  private buildThreshold = 0;
  private set: ConnexelSet | null = null;
  private pieData: ArrayBuffer | null = null;
  private pieKey = "";
  private pieStats = { maxCount: 0, visible: 0 };
  private diffCount = -1;
  private diffThreshold = 0;
  /** threshold / minimum length to put back when the difference-glyph style is left */
  private diffRestore: { threshold: number; minLength: number } | null = null;
  private styleShown: GlyphStyle = "points";
  private dirtyBuild = true;
  private dirtyRanks = true;
  private dirtyLittle = true;

  // connexels / bundles
  private connexels: ConnexelEdges | null = null;
  private bundles: Polylines | null = null;
  private worker: Worker | null = null;

  private active = true;
  private needsDraw = true;
  private raf = 0;
  private saveTimer = 0;
  private errorHtml = "";
  private errorTimer = 0;
  private shotScale = 1;

  constructor(private readonly viewHost: HTMLElement, panelHost: HTMLElement, private readonly hooks: GlyphAppHooks = {}) {
    this.params = { ...defaultGlyphParams, ...loadStored<Partial<GlyphParams>>(STORAGE + ".params"), tool: "navigate" };
    this.sanitizeParams();
    this.styleShown = this.params.glyphStyle;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "view-canvas";
    viewHost.appendChild(this.canvas);
    const gl = this.canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.renderer = new GlyphRenderer(gl);

    this.insetEl = el("div", "inset-frame");
    this.insetEl.innerHTML = `<span>seed-based connectivity</span>`;
    this.statusEl = el("div", "hud-status");
    this.progressEl = el("div", "hud-progress");
    this.progressEl.innerHTML = `<div class="hud-progress-text"></div><div class="hud-progress-bar"><div></div></div>`;
    this.legendEl = el("div", "hud-legend");
    this.dropEl = el("div", "hud-drop");
    this.dropEl.textContent = "Drop a glyphset: glyphset.json folder, brainGL .glyphset + files, or surfaces + matrix";
    viewHost.append(this.insetEl, this.statusEl, this.legendEl, this.progressEl, this.dropEl);
    this.buildToolbar();
    this.buildPanel(panelHost);
    this.bindEvents();
    new ResizeObserver(() => this.invalidate()).observe(viewHost);
    this.renderer.setLut(colormapLut(this.params.colormap));
    this.invalidate();
  }

  // ------------------------------------------------------------- life cycle

  setActive(a: boolean): void {
    this.active = a;
    if (a) this.invalidate();
  }

  invalidate(): void {
    this.needsDraw = true;
    if (!this.raf && this.active) this.raf = requestAnimationFrame(() => { this.raf = 0; this.frame(); });
  }

  private persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persistNow(), 300);
  }

  private persistNow(): void {
    clearTimeout(this.saveTimer);
    // the temporary values of the difference-glyph style are never stored: a later session would not know what to restore
    const r = this.diffRestore;
    store(STORAGE + ".params", r ? { ...this.params, threshold: r.threshold, minLength: r.minLength } : this.params);
    if (this.ds) store(STORAGE + ".cams." + this.ds.n, this.cams.map((c) => c.getState()));
  }

  // ---------------------------------------------------------------- loading

  async loadDemo(url = "data/nki_fsaverage4/"): Promise<void> {
    const base = new URL(url, document.baseURI).href;
    try {
      this.progress("Loading demo glyphset…");
      const res = await fetch(base + "glyphset.json");
      if (!res.ok) throw new Error(`demo data not found at ${url}`);
      // a dev server answers unknown paths with its HTML page (status 200), so a wrong folder shows up here
      const man: unknown = await res.json().catch(() => { throw new Error(`no glyphset.json found at ${url}`); });
      if (!isWebManifest(man)) throw new Error("not a web glyphset manifest");
      const ds = await loadWebGlyphset(man, urlGetter(base), (m, f) => this.progress(m, f));
      this.setDataset(ds, null, null);
    } catch (e) {
      this.fail(e);
    }
  }

  async loadFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    try {
      this.progress("Reading files…");
      const r = await loadFromFiles(files, (m, f) => this.progress(m, f));
      this.setDataset(r.dataset, r.roi, r.minThreshold, r.maxThreshold, r.targets);
      if (r.notes.length) console.info(r.notes.join("\n"));
    } catch (e) {
      this.fail(e);
    }
  }

  /** Show an error in the status line. */
  report(e: unknown): void { this.fail(e); }

  private fail(e: unknown): void {
    console.error(e);
    this.progress(null);
    // kept for a few seconds: the status line is rewritten on every redraw, which would wipe the message at once
    this.errorHtml = `<span class="err">${escapeHtml(e instanceof Error ? e.message : String(e))}</span>`;
    this.statusEl.innerHTML = this.errorHtml;
    clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => { this.errorHtml = ""; this.invalidate(); }, 8000);
  }

  private progress(msg: string | null, fraction?: number): void {
    // the style sheet hides the box by default, so "" would leave it hidden
    this.progressEl.style.display = msg ? "block" : "none";
    if (!msg) return;
    (this.progressEl.firstChild as HTMLElement).textContent = msg;
    const bar = this.progressEl.querySelector<HTMLElement>(".hud-progress-bar > div")!;
    bar.style.width = fraction === undefined ? "100%" : `${Math.round(100 * Math.min(1, fraction))}%`;
    bar.classList.toggle("indeterminate", fraction === undefined);
  }

  setDataset(ds: GlyphDataset, roi: Uint8Array | null, minThreshold: number | null, maxThreshold: number | null = null, targets: Uint8Array | null = null): void {
    if (ds.n > 65535) throw new Error(`This dataset has ${ds.n} nodes; the viewer supports up to 65,535 nodes per glyphset.`);
    const p = this.params;
    // Settings and views are remembered per kind of dataset (node count + surface names).
    const signature = `${ds.n}:${ds.surfaces.map((s) => s.name).join(",")}`;
    const sameShape = loadStored<string>(STORAGE + ".dataset") === signature;
    store(STORAGE + ".dataset", signature);
    this.ds = ds;
    this.topo = buildTopology(ds.n, ds.triangles);
    this.sphere = findSphere(ds);
    this.renderer.setDataset(ds);
    this.labels = new Uint8Array(ds.n);
    this.paintRgba = new Uint8Array(ds.n * 4);
    this.labelColors = [];
    this.fileRoi = roi;
    this.targets = targets;
    this.seedRow = new Float32Array(ds.n);
    this.cursorNode = -1;
    this.seedIsAverage = false;
    this.worker?.terminate();
    this.worker = null;
    this.connexels = null;
    this.bundles = null;
    this.renderer.setSegments(null, 0);

    const ns = ds.surfaces.length;
    const stored = loadStored<CameraState[]>(STORAGE + ".cams." + ds.n);
    // judge the remembered threshold / minimum length, not the temporary ones of the difference glyphs
    this.leaveDiffStyle();
    if (!sameShape || !stored) {
      // sensible defaults for a new kind of dataset: glyphs on the inflated surface, shaped and coloured by the pial one
      p.surface = surfaceIndexByName(ds, ["inflated"], Math.min(1, ns - 1));
      p.secondSurface = surfaceIndexByName(ds, ["pial", "midthickness", "white"], 0);
      p.glyphGeometry = p.colorSurface = p.lengthSurface = p.secondSurface;
      p.glyphRadius = Math.min(0.2, Math.max(0.002, +(0.0042 * meanEdgeLength(ds.surfaces[p.surface].positions, this.topo.edges)).toFixed(4)));
    }
    // Thresholds and the colour range are remembered in the units of the matrix they were chosen for
    // (1 for correlations). A matrix in other units starts from the defaults scaled to its range.
    const maxAbs = ds.conn.maxAbs;
    const unit = valueUnit(maxAbs);
    const prevUnit = loadStored<number>(STORAGE + ".unit") ?? 1;
    if (!(Math.abs(prevUnit - unit) <= 1e-3 * unit)) {
      p.threshold = defaultGlyphParams.threshold * unit;
      p.cmin = defaultGlyphParams.cmin * unit;
      p.cmax = defaultGlyphParams.cmax * unit;
      p.seedLower = defaultGlyphParams.seedLower * unit;
    }
    store(STORAGE + ".unit", unit);
    if (minThreshold !== null) p.threshold = Math.max(p.threshold, minThreshold);
    p.maxThreshold = maxThreshold !== null ? maxThreshold : maxAbs;
    this.sanitizeParams();
    if (roi) {
      for (let i = 0; i < ds.n; i++) if (roi[i]) this.labels[i] = 1;
      this.labelColors = [p.paintColor];
      p.glyphNodes = "painted";
      this.refreshPaint();
    }
    this.frameCameras();
    if (stored && stored.length === 2 && sameShape) this.cams.forEach((c, i) => { if (isCameraState(stored[i])) c.setState(stored[i]); });
    this.updateOverlay();
    this.styleShown = p.glyphStyle;
    if (p.glyphStyle === "diffpoints") this.enterDiffStyle();
    this.dirtyBuild = this.dirtyLittle = true;
    this.errorHtml = "";
    this.progress(null);
    this.dropEl.style.display = "none";
    this.panel.refresh();
    this.persistNow();
    this.invalidate();
  }

  /**
   * Bring the parameters into what the loaded dataset allows. Settings come from the previous
   * session, from a scene file or from another dataset, so nothing in them may be trusted to
   * index an existing surface or to lie within the value range of the matrix.
   */
  private sanitizeParams(): void {
    const p = this.params;
    const rec = p as unknown as Record<string, unknown>;
    const def = defaultGlyphParams as unknown as Record<string, unknown>;
    for (const k of Object.keys(def)) {
      const v = rec[k];
      if (typeof v !== typeof def[k] || (typeof v === "number" && !Number.isFinite(v))) rec[k] = def[k];
    }
    for (const [k, allowed] of Object.entries(CHOICES)) if (!allowed.includes(rec[k])) rec[k] = def[k];
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) rec[k] = Math.min(hi, Math.max(lo, rec[k] as number));
    p.minLength = Math.max(0, p.minLength);
    const ds = this.ds;
    if (!ds) return;
    const ns = ds.surfaces.length;
    const idx = (v: number) => (Number.isInteger(v) && v >= 0 && v < ns ? v : 0);
    p.surface = idx(p.surface);
    p.secondSurface = idx(p.secondSurface);
    p.colorSurface = idx(p.colorSurface);
    if (p.lengthSurface !== -1) p.lengthSurface = idx(p.lengthSurface);
    if (p.glyphGeometry !== -1 || !this.sphere) p.glyphGeometry = idx(p.glyphGeometry);
    const m = p.surfaceColorMode;
    if (m.startsWith("overlay:") ? !ds.overlays.some((o) => "overlay:" + o.name === m) : !["sulc", "solid", "seed"].includes(m)) p.surfaceColorMode = "sulc";
    const maxAbs = ds.conn.maxAbs;
    if (p.threshold < 0) p.threshold = 0;
    if (p.threshold >= maxAbs) p.threshold = 0.5 * maxAbs; // nothing would be drawn
    if (!(p.maxThreshold > 0 && p.maxThreshold <= maxAbs)) p.maxThreshold = maxAbs;
    const lim = this.colorLimit();
    p.cmin = Math.min(lim, Math.max(-lim, p.cmin));
    p.cmax = Math.min(lim, Math.max(-lim, p.cmax));
    p.seedLower = Math.min(lim, Math.max(0, p.seedLower));
  }

  /** Slider step for values of the matrix: 0.01 for correlations, about a hundredth of the range otherwise. */
  private valueStep(): number {
    return niceStep(valueUnit(this.ds?.conn.maxAbs ?? 1) / 100);
  }

  /** Range of the colour-map sliders: +-1 for correlations, +-(largest |value|, rounded up to a step) otherwise. */
  private colorLimit(): number {
    const maxAbs = this.ds?.conn.maxAbs ?? 1;
    if (valueUnit(maxAbs) === 1) return 1;
    const step = this.valueStep();
    return Number((Math.ceil(maxAbs / step - 1e-9) * step).toPrecision(12));
  }

  /** A matrix value with as many decimals as its scale needs (two for correlations). */
  private fmtValue(v: number): string {
    return v.toFixed(stepDigits(this.valueStep()));
  }

  /**
   * Differences between neighbouring profiles are much smaller than the connections themselves, and
   * the minimum length would hide the local ones: switching to difference glyphs with a threshold
   * meant for connections shows nothing. Start from usable values and remember what to put back.
   */
  private enterDiffStyle(): void {
    const p = this.params, ds = this.ds;
    if (!ds || this.diffRestore) return;
    const maxAbs = ds.conn.maxAbs;
    if (p.threshold > 0.3 * maxAbs) {
      this.diffRestore = { threshold: p.threshold, minLength: p.minLength };
      p.threshold = 0.2 * maxAbs;
      p.minLength = 0;
      this.dirtyRanks = true;
    }
  }

  private leaveDiffStyle(): void {
    const r = this.diffRestore;
    if (!r) return;
    this.diffRestore = null;
    this.params.threshold = r.threshold;
    this.params.minLength = r.minLength;
    this.dirtyRanks = true;
  }

  private frameCameras(): void {
    const ds = this.ds!;
    const p = this.params;
    [p.surface, p.secondSurface].forEach((si, k) => {
      const b = computeBounds(ds.surfaces[si].positions);
      this.cams[k].frame(b.center, b.radius);
      this.cams[k].setView("left");
    });
  }

  // --------------------------------------------------------- glyph pipeline

  private filter(threshold: number): BuildFilter {
    // The upper threshold is applied when drawing (shader / pie ranks), so that raising it later
    // never finds the connexels missing from the GPU buffers.
    return { glyphNodes: this.glyphNodes, targets: this.targets, sign: this.params.sign, threshold, maxThreshold: this.ds?.conn.maxAbs ?? 1 };
  }

  /** The threshold actually in effect: never below what was sent to the GPU. */
  private effectiveThreshold(): number {
    const t = this.params.glyphStyle === "diffpoints" ? 0 : this.buildThreshold;
    return Math.max(this.params.threshold, t);
  }

  private ensureGlyphs(): void {
    const ds = this.ds, topo = this.topo;
    if (!ds || !topo) return;
    const p = this.params;
    if (this.dirtyBuild) {
      const n = ds.n;
      const split = ds.leftNodes > 0 && ds.leftNodes < n ? ds.leftNodes : 0;
      const nodes = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!ds.mask[i]) continue;
        if (split && ((p.hemi === 1 && i >= split) || (p.hemi === 2 && i < split))) continue;
        if (p.glyphNodes === "painted" && !this.labels[i]) continue;
        nodes[i] = 1;
      }
      this.glyphNodes = nodes;
      this.cum = ds.conn.cumulativeHistogram(nodes, p.sign);
      this.buildThreshold = thresholdForBudget(this.cum, ds.conn.maxAbs, p.budgetM * 1e6);
      this.set = null;
      this.pieData = null;
      this.diffCount = -1;
      this.dirtyBuild = false;
      this.dirtyRanks = true;
    }
    if (!p.showGlyphs || p.glyphStyle === "off") return;
    if (p.glyphStyle === "diffpoints") {
      if (this.diffCount < 0) {
        // differences of neighbours are small: start well below the display threshold
        const d = buildDiffConnexels(ds.conn, topo.edges, this.filter(Math.max(this.buildThreshold * 0.5, ds.conn.maxAbs * 0.15)), p.budgetM * 1e6);
        this.renderer.setDiff(d.data, d.count);
        this.diffCount = d.count;
        this.diffThreshold = d.threshold;
      }
      return;
    }
    if (!this.set) {
      this.set = buildConnexels(ds.conn, this.filter(this.buildThreshold));
      this.renderer.setConnexels(this.set.data, this.set.count);
      this.pieData = null;
    }
    if (p.glyphStyle === "pies") {
      const key = `${p.colorSurface}|${p.glyphColorMode}`;
      const rankParams = { threshold: this.effectiveThreshold(), maxThreshold: p.maxThreshold, minLength: p.minLength, sign: p.sign };
      const lenPos = ds.surfaces[lengthSurfaceIndex(p)].positions;
      if (!this.pieData || this.pieKey !== key) {
        this.pieData = sortForPies(this.set, ds.n, ds.surfaces[p.colorSurface].positions, p.glyphColorMode === 1);
        this.pieKey = key;
        const r = computePieRanks(this.pieData, this.set.nodeStart, ds.n, lenPos, ds.conn.scale, rankParams);
        this.renderer.setPies(this.pieData, this.set.count, r.ranks, r.maxCount);
        this.pieStats = r;
      } else if (this.dirtyRanks) {
        const r = computePieRanks(this.pieData, this.set.nodeStart, ds.n, lenPos, ds.conn.scale, rankParams);
        this.renderer.setPieRanks(r.ranks, r.maxCount);
        this.pieStats = r;
      }
      this.dirtyRanks = false;
    }
  }

  private ensureLittleBrains(): void {
    const ds = this.ds;
    if (!ds || !this.dirtyLittle) return;
    this.dirtyLittle = false;
    const p = this.params;
    if (!p.littleBrains) { this.renderer.setLittleBrains(new Uint32Array(0), null); return; }
    let nodes: number[] = [];
    for (let i = 0; i < ds.n; i++) if (this.labels[i] && this.glyphNodes[i]) nodes.push(i);
    if (!nodes.length && this.cursorNode >= 0) nodes = [this.cursorNode];
    if (nodes.length > p.lbMax) {
      const step = nodes.length / p.lbMax;
      nodes = Array.from({ length: p.lbMax }, (_, k) => nodes[Math.floor(k * step)]);
    }
    let rows: Int16Array | null = null;
    if (p.lbColorMode === 1 && nodes.length) {
      rows = new Int16Array(nodes.length * ds.n);
      nodes.forEach((node, k) => rows!.set(ds.conn.rawRow(node), k * ds.n));
    }
    this.renderer.setLittleBrains(Uint32Array.from(nodes), rows);
  }

  // ---------------------------------------------------------------- drawing

  private viewports(): { main: Viewport; inset: Viewport | null; dpr: number } {
    const dpr = (window.devicePixelRatio || 1) * this.shotScale;
    const w = Math.max(1, Math.round(this.viewHost.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.viewHost.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    let inset: Viewport | null = null;
    if (this.params.secondView && this.ds) {
      const iw = Math.round(Math.min(w * 0.26, h * 0.36 * 1.25));
      const ih = Math.round(iw / 1.25);
      const m = Math.round(12 * dpr);
      inset = { x: m, y: m + Math.round(26 * dpr), w: iw, h: ih };
    }
    return { main: { x: 0, y: 0, w, h }, inset, dpr };
  }

  private drawState(view: 0 | 1, dpr: number): DrawState {
    const p = this.params;
    const rot = mat3.create();
    if (p.rotationEnabled) {
      const m = mat4.create();
      mat4.rotateX(m, m, (p.rotX * Math.PI) / 180);
      mat4.rotateY(m, m, (p.rotY * Math.PI) / 180);
      mat4.rotateZ(m, m, (p.rotZ * Math.PI) / 180);
      mat3.fromMat4(rot, m);
    }
    const polar = p.glyphGeometry === -1 && !!this.sphere;
    const mode = view === 1 ? "seed" : p.surfaceColorMode;
    const overlay = mode.startsWith("overlay:");
    const hasSeed = this.cursorNode >= 0 || this.seedIsAverage;
    const thr = this.effectiveThreshold();
    return {
      surface: view === 1 ? p.secondSurface : p.surface,
      glyphSurface: polar ? p.colorSurface : p.glyphGeometry,
      colorSurface: p.colorSurface,
      lengthSurface: lengthSurfaceIndex(p),
      sphereSurface: this.sphere ? this.sphere.surface : -1,
      sphereCenterL: this.sphere?.centerL ?? [0, 0, 0],
      sphereCenterR: this.sphere?.centerR ?? [0, 0, 0],
      geometryMode: polar ? 1 : 0,
      glyphStyle: p.glyphStyle,
      showSurface: view === 1 ? true : p.showSurface,
      showGlyphs: view === 0 && p.showGlyphs,
      showLittleBrains: p.littleBrains,
      showSegments: view === 0 && p.showConnections,
      hemi: p.hemi,
      radius: p.glyphRadius,
      primSize: p.primSize * dpr,
      roundPoints: p.roundPoints,
      normalization: p.normalization,
      glyphAlpha: p.glyphAlpha,
      glyphRot: rot,
      depthOffset: p.depthLift * p.glyphRadius * 100,
      threshold: p.glyphStyle === "diffpoints" ? p.threshold : thr,
      maxThreshold: p.maxThreshold,
      minLength: p.minLength,
      sign: p.sign,
      colorMode: p.glyphColorMode,
      cmin: p.cmin,
      cmax: p.cmax,
      baseColor: hexToRgb(p.surfaceColor),
      useSulc: mode !== "solid" && this.renderer.hasSulc,
      showScalar: overlay || (mode === "seed" && hasSeed),
      scalarSource: overlay ? "overlay" : "seed",
      scalarLower: overlay ? 0 : p.seedLower,
      scalarMin: overlay ? this.overlayRange[0] : p.cmin,
      scalarMax: overlay ? this.overlayRange[1] : p.cmax,
      showPaint: p.showPaint,
      surfaceAlpha: view === 1 ? 1 : p.surfaceAlpha,
      lbColorMode: p.lbColorMode,
      lbColor: hexToRgb(p.surfaceColor),
      background: view === 1 ? hexToRgb(p.background).map((c) => c * 0.82 + 0.03) as [number, number, number] : hexToRgb(p.background),
      lineWidth: p.lineWidth * dpr,
      segmentAlpha: p.lineAlpha,
      cursorNode: this.cursorNode,
      cursorSize: 30 * dpr,
      cursorColor: [1, 1, 1, 1],
    };
  }

  private frame(): void {
    if (!this.needsDraw) return;
    this.needsDraw = false;
    const { main, inset, dpr } = this.viewports();
    if (!this.ds) {
      this.gl.viewport(0, 0, main.w, main.h);
      const bg = hexToRgb(this.params.background);
      this.gl.clearColor(bg[0], bg[1], bg[2], 1);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
      this.insetEl.style.display = "none";
      return;
    }
    const t0 = performance.now();
    this.ensureGlyphs();
    this.ensureLittleBrains();
    this.renderer.draw(main, this.cams[0], this.drawState(0, dpr));
    if (inset) {
      this.renderer.draw(inset, this.cams[1], this.drawState(1, dpr));
      if (this.shotScale === 1) {
        const css = (window.devicePixelRatio || 1);
        Object.assign(this.insetEl.style, {
          display: "block", left: inset.x / css + "px", bottom: inset.y / css + "px", width: inset.w / css + "px", height: inset.h / css + "px",
        });
      }
    } else {
      this.insetEl.style.display = "none";
    }
    this.updateStatus(performance.now() - t0);
  }

  private updateStatus(buildMs: number): void {
    const ds = this.ds;
    if (!ds) return;
    const p = this.params;
    const parts: string[] = [`<b>${escapeHtml(ds.name)}</b> · ${ds.n.toLocaleString()} nodes`];
    const sym = valueUnit(ds.conn.maxAbs) === 1 ? "|r|" : "|value|";
    if (p.showGlyphs && p.glyphStyle !== "off") {
      if (p.glyphStyle === "diffpoints") {
        parts.push(`${fmtCount(Math.max(0, this.diffCount))} edge–target pairs on GPU (${sym} ≥ ${this.fmtValue(this.diffThreshold)})`);
      } else if (this.set && this.cum) {
        const shown = p.glyphStyle === "pies" ? this.pieStats.visible : Math.round(fractionAbove(this.cum, ds.conn.maxAbs, this.effectiveThreshold()) * this.cum[0]);
        parts.push(`${fmtCount(shown)} connexels ${p.glyphStyle === "pies" ? "shown" : "above threshold"} · ${fmtCount(this.set.count)} on GPU (${sym} ≥ ${this.fmtValue(this.buildThreshold)})`);
        if (p.threshold < this.buildThreshold - 1e-6) parts.push(`<span class="warn">threshold limited to ${this.fmtValue(this.buildThreshold)} by the connexel budget</span>`);
        if (p.glyphNodes === "painted" && this.set.count === 0) parts.push(`<span class="warn">paint a region to create glyphs</span>`);
      }
    }
    if (this.cursorNode >= 0) {
      const pos = ds.surfaces[p.surface].positions;
      const c = this.cursorNode;
      parts.push(`node ${c} (${pos[3 * c].toFixed(0)}, ${pos[3 * c + 1].toFixed(0)}, ${pos[3 * c + 2].toFixed(0)})`);
    }
    if (buildMs > 250) parts.push(`${Math.round(buildMs)} ms`);
    this.statusEl.innerHTML = this.errorHtml || parts.join(" &nbsp;·&nbsp; ");
    const lut = colormapLut(p.colormap);
    const showLegend = p.glyphColorMode === 1 || p.secondView || p.surfaceColorMode === "seed";
    this.legendEl.style.display = showLegend ? "" : "none";
    this.legendEl.innerHTML = `<span>${this.fmtValue(p.cmin)}</span><div style="background:${lutToCss(lut)}"></div><span>${this.fmtValue(p.cmax)}</span>`;
  }

  // ------------------------------------------------------------ interaction

  private viewAt(clientX: number, clientY: number): { view: 0 | 1; vp: Viewport; x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const { main, inset } = this.viewports();
    const sx = this.canvas.width / rect.width;
    const x = (clientX - rect.left) * sx;
    const y = (rect.bottom - clientY) * sx; // GL origin is bottom-left
    if (inset && x >= inset.x && x <= inset.x + inset.w && y >= inset.y && y <= inset.y + inset.h) return { view: 1, vp: inset, x, y };
    return { view: 0, vp: main, x, y };
  }

  private pickAt(clientX: number, clientY: number, forceView?: 0 | 1): { node: number; view: 0 | 1 } | null {
    const ds = this.ds;
    if (!ds) return null;
    const at = this.viewAt(clientX, clientY);
    const view = forceView ?? at.view;
    const vps = this.viewports();
    const vp = view === 1 ? (vps.inset ?? vps.main) : vps.main;
    const cam = this.cams[view];
    cam.update(vp.w / vp.h);
    const ray = cam.ray(((at.x - vp.x) / vp.w) * 2 - 1, ((at.y - vp.y) / vp.h) * 2 - 1);
    const si = view === 1 ? this.params.secondSurface : this.params.surface;
    const [first, count] = hemisphereTriangles(ds, this.params.hemi);
    const hit = pickNode(ds.surfaces[si].positions, ds.triangles, first, count, ray.origin, ray.dir);
    return hit ? { node: hit.node, view } : null;
  }

  /** Select a node: shows its connectivity map and moves the synchronised cursor. */
  selectNode(node: number): void {
    const ds = this.ds;
    if (!ds || node < 0 || node >= ds.n) return;
    this.cursorNode = node;
    this.seedIsAverage = false;
    ds.conn.row(node, this.seedRow);
    this.seedRow[node] = ds.conn.maxAbs;
    this.renderer.setScalars(this.seedRow);
    if (this.params.littleBrains) this.dirtyLittle = true;
    this.invalidate();
  }

  private paintAt(node: number, erase: boolean): void {
    const ds = this.ds, topo = this.topo;
    if (!ds || !topo) return;
    const p = this.params;
    let label = 0;
    if (!erase) {
      let idx = this.labelColors.indexOf(p.paintColor);
      if (idx < 0) {
        if (this.labelColors.length >= 255) return;
        this.labelColors.push(p.paintColor);
        idx = this.labelColors.length - 1;
      }
      label = idx + 1;
    }
    for (const i of brushNodes(topo, ds.surfaces[p.surface].positions, node, p.brushSize)) this.labels[i] = label;
    this.refreshPaint();
  }

  private refreshPaint(): void {
    const rgba = this.paintRgba;
    const cols = this.labelColors.map(hexToRgb);
    for (let i = 0; i < this.labels.length; i++) {
      const l = this.labels[i];
      if (l) {
        const c = cols[l - 1] ?? [1, 1, 1];
        rgba[4 * i] = c[0] * 255; rgba[4 * i + 1] = c[1] * 255; rgba[4 * i + 2] = c[2] * 255; rgba[4 * i + 3] = 215;
      } else {
        rgba[4 * i + 3] = 0;
      }
    }
    this.renderer.setPaint(rgba);
    this.invalidate();
  }

  private paintChanged(): void {
    if (this.params.glyphNodes === "painted") this.dirtyBuild = true;
    this.dirtyLittle = true;
    this.panel.refresh();
    this.invalidate();
  }

  private bindEvents(): void {
    const c = this.canvas;
    let drag: { mode: "rotate" | "pan" | "seed" | "paint" | "erase"; view: 0 | 1; x: number; y: number; moved: boolean } | null = null;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      if (!this.ds) return;
      c.setPointerCapture(e.pointerId);
      const { view } = this.viewAt(e.clientX, e.clientY);
      const tool = this.params.tool;
      const right = e.button === 2 || (e.button === 0 && e.ctrlKey);
      let mode: NonNullable<typeof drag>["mode"];
      if (right) {
        // brainGL: right click = select node; ctrl + right = paint; ctrl + shift + right = erase.
        // On macOS ctrl-click *is* the right click (button 0 or 2 depending on the browser), so it
        // always selects a node there and painting takes option (alt), which works everywhere.
        const paint = e.altKey || (!IS_MAC && e.button === 2 && e.ctrlKey);
        mode = paint ? (e.shiftKey ? "erase" : "paint") : "seed";
      } else if (e.button === 1 || (e.button === 0 && e.shiftKey && tool === "navigate")) {
        mode = "pan";
      } else if (e.button === 0 && tool !== "navigate" && !e.metaKey) {
        mode = tool === "paint" && e.shiftKey ? "erase" : tool;
      } else {
        mode = "rotate";
      }
      if (view === 1 && (mode === "paint" || mode === "erase")) mode = "seed";
      drag = { mode, view, x: e.clientX, y: e.clientY, moved: false };
      this.applyTool(drag.mode, e.clientX, e.clientY, view);
    });
    c.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      drag.x = e.clientX; drag.y = e.clientY;
      const cam = this.cams[drag.view];
      const { main, inset } = this.viewports();
      const hCss = (drag.view === 1 && inset ? inset.h : main.h) / (window.devicePixelRatio || 1);
      if (drag.mode === "rotate") { cam.rotate(dx, dy, hCss); this.invalidate(); this.persist(); }
      else if (drag.mode === "pan") { cam.pan(dx, dy, hCss); this.invalidate(); this.persist(); }
      else this.applyTool(drag.mode, e.clientX, e.clientY, drag.view);
    });
    const end = () => {
      if (drag && (drag.mode === "paint" || drag.mode === "erase")) this.paintChanged();
      drag = null;
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("dblclick", (e) => {
      const hit = this.pickAt(e.clientX, e.clientY);
      if (hit) this.selectNode(hit.node);
    });
    c.addEventListener("wheel", (e) => {
      if (!this.ds) return;
      e.preventDefault();
      const at = this.viewAt(e.clientX, e.clientY);
      const cam = this.cams[at.view];
      cam.update(at.vp.w / at.vp.h);
      cam.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), ((at.x - at.vp.x) / at.vp.w) * 2 - 1, ((at.y - at.vp.y) / at.vp.h) * 2 - 1);
      this.invalidate();
      this.persist();
    }, { passive: false });

    // drag & drop of files / folders
    const host = this.viewHost;
    host.addEventListener("dragover", (e) => { e.preventDefault(); host.classList.add("dragging"); });
    host.addEventListener("dragleave", () => host.classList.remove("dragging"));
    host.addEventListener("drop", async (e) => {
      e.preventDefault();
      host.classList.remove("dragging");
      const files = await collectDroppedFiles(e.dataTransfer);
      void this.loadFiles(files);
    });
    window.addEventListener("keydown", (e) => {
      if (!this.active || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const tools: Record<string, GlyphParams["tool"]> = { n: "navigate", s: "seed", p: "paint", e: "erase" };
      const styles: Record<string, GlyphParams["glyphStyle"]> = { "1": "points", "2": "vectors", "3": "pies", "4": "diffpoints", "0": "off" };
      if (tools[e.key]) { this.params.tool = tools[e.key]; this.afterChange("tool"); }
      else if (styles[e.key]) { this.params.glyphStyle = styles[e.key]; this.afterChange("glyphStyle"); }
      else return;
      this.panel.refresh();
      this.refreshToolbar();
    });
  }

  private applyTool(mode: string, x: number, y: number, view: 0 | 1): void {
    if (mode !== "seed" && mode !== "paint" && mode !== "erase") return;
    const hit = this.pickAt(x, y, view);
    if (!hit) return;
    if (mode === "seed") this.selectNode(hit.node);
    else this.paintAt(hit.node, mode === "erase");
  }

  // -------------------------------------------------------------- overlays

  private overlayRange: [number, number] = [0, 1];

  private updateOverlay(): void {
    const ds = this.ds;
    if (!ds) return;
    const m = this.params.surfaceColorMode;
    if (!m.startsWith("overlay:")) return;
    const o = ds.overlays.find((x) => "overlay:" + x.name === m);
    if (!o) return;
    this.renderer.setOverlay(o.data);
    const sorted = Float32Array.from(o.data).sort();
    this.overlayRange = [sorted[Math.floor(sorted.length * 0.02)], sorted[Math.floor(sorted.length * 0.98)]];
  }

  // ---------------------------------------------------- connexels / bundles

  private makeConnections(): void {
    const ds = this.ds;
    if (!ds) return;
    this.ensureGlyphs();
    const p = this.params;
    // never below the threshold in effect on screen (the connexel budget may have raised it)
    const thr = Math.max(this.effectiveThreshold(), ds.conn.maxAbs * 0.02);
    this.connexels = createConnexels(ds.conn, this.filter(thr), ds.surfaces[p.surface].positions, ds.surfaces[lengthSurfaceIndex(p)].positions, p.minLength, p.maxConnexels);
    this.bundles = null;
    this.uploadSegments();
    p.showConnections = true;
    if (p.surfaceAlpha > 0.6) p.surfaceAlpha = 0.25;
    this.panel.refresh();
    this.invalidate();
  }

  private currentLines(): Polylines | null {
    if (this.bundles) return this.bundles;
    const c = this.connexels;
    if (!c) return null;
    const m = c.values.length;
    const offsets = new Uint32Array(m + 1);
    for (let k = 0; k <= m; k++) offsets[k] = 2 * k;
    return { points: c.edges, offsets, values: c.values };
  }

  private uploadSegments(): void {
    const lines = this.currentLines();
    if (!lines) { this.renderer.setSegments(null, 0); return; }
    const p = this.params;
    const nLines = lines.offsets.length - 1;
    const nSeg = lines.points.length / 3 - nLines;
    const buf = new ArrayBuffer(Math.max(1, nSeg) * 28);
    const f = new Float32Array(buf);
    const u = new Uint8Array(buf);
    const lut = colormapLut(p.colormap);
    let s = 0;
    for (let l = 0; l < nLines; l++) {
      const a = lines.offsets[l], b = lines.offsets[l + 1];
      let r: number, g: number, bl: number;
      if (p.lineColorMode === 1) {
        const t = Math.round(255 * Math.min(1, Math.max(0, (lines.values[l] - p.cmin) / (p.cmax - p.cmin || 1))));
        r = lut[4 * t]; g = lut[4 * t + 1]; bl = lut[4 * t + 2];
      } else {
        const dx = lines.points[3 * (b - 1)] - lines.points[3 * a], dy = lines.points[3 * (b - 1) + 1] - lines.points[3 * a + 1], dz = lines.points[3 * (b - 1) + 2] - lines.points[3 * a + 2];
        const len = Math.hypot(dx, dy, dz) || 1;
        r = (Math.abs(dx) / len) * 255; g = (Math.abs(dy) / len) * 255; bl = (Math.abs(dz) / len) * 255;
      }
      for (let k = a; k < b - 1; k++, s++) {
        f.set(lines.points.subarray(3 * k, 3 * k + 6), 7 * s);
        u[28 * s + 24] = r; u[28 * s + 25] = g; u[28 * s + 26] = bl; u[28 * s + 27] = 255;
      }
    }
    this.renderer.setSegments(buf, s);
  }

  private bundle(): void {
    const c = this.connexels;
    if (!c || !c.values.length) return;
    this.worker?.terminate();
    const w = new Worker(new URL("../algorithms/bundlingWorker.ts", import.meta.url), { type: "module" });
    this.worker = w;
    this.progress(`Bundling ${c.values.length.toLocaleString()} connexels…`, 0);
    w.onmessage = (ev: MessageEvent<BundlingResponse>) => {
      const m = ev.data;
      if (m.type === "progress") this.progress(`Bundling ${c.values.length.toLocaleString()} connexels…`, m.fraction);
      else if (m.type === "done") {
        this.bundles = m.result;
        this.uploadSegments();
        this.progress(null);
        this.worker = null;
        w.terminate();
        this.panel.refresh();
        this.invalidate();
      } else {
        this.worker = null;
        w.terminate();
        this.fail(new Error(m.message));
      }
    };
    w.onerror = (e) => { this.worker = null; this.fail(new Error(e.message)); };
    w.postMessage({
      type: "bundle", edges: c.edges.slice(), values: c.values.slice(),
      options: { ...defaultBundlingOptions, compatibilityThreshold: this.params.bundleCompat, bell: this.params.bundleBell },
    });
  }

  // ----------------------------------------------------------------- export

  /** Render at `scale` times the screen resolution and download a PNG. */
  screenshot(): void {
    const max = Math.min(this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE) as number, 16384);
    const dpr = window.devicePixelRatio || 1;
    const longest = Math.max(this.viewHost.clientWidth, this.viewHost.clientHeight) * dpr;
    this.shotScale = Math.max(1, Math.min(this.params.screenshotScale, max / longest));
    this.needsDraw = true;
    this.frame();
    this.canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `braingl-${this.params.glyphStyle}-${stamp()}.png`);
      this.shotScale = 1;
      this.invalidate();
    }, "image/png");
  }

  surfaceExport(): SurfaceExport | null {
    const ds = this.ds;
    if (!ds) return null;
    const p = this.params;
    const o = p.surfaceColorMode.startsWith("overlay:") ? ds.overlays.find((x) => "overlay:" + x.name === p.surfaceColorMode) : null;
    const hasSeed = this.cursorNode >= 0 || this.seedIsAverage;
    return {
      name: `${ds.name} (${ds.surfaces[p.surface].name})`,
      positions: ds.surfaces[p.surface].positions,
      triangles: ds.triangles,
      labels: this.labels,
      labelColors: this.labelColors,
      scalars: o ? o.data : hasSeed ? this.seedRow : null,
      scalarName: o ? o.name : hasSeed ? (this.seedIsAverage ? "mean connectivity of painted region" : `connectivity of node ${this.cursorNode}`) : "",
    };
  }

  /** Everything needed to rebuild the current picture as geometry elsewhere (Blender export). */
  exportState(maxPrims = 400000): { bake: GlyphBakeInput; background: [number, number, number]; camera: SceneCamera } | null {
    const ds = this.ds, topo = this.topo;
    if (!ds || !topo) return null;
    this.ensureGlyphs();
    const cam = this.cams[0];
    const hCss = Math.max(1, this.viewHost.clientHeight);
    return {
      bake: {
        ds, topo, sphere: this.sphere, params: this.params, glyphNodes: this.glyphNodes, targets: this.targets,
        threshold: this.effectiveThreshold(), buildThreshold: this.buildThreshold, budget: this.params.budgetM * 1e6,
        labels: this.labels, labelColors: this.labelColors, seedRow: this.cursorNode >= 0 || this.seedIsAverage ? this.seedRow : null,
        cursorNode: this.cursorNode, lines: this.currentLines(),
        primRadius: Math.max(0.03, 0.5 * this.params.primSize * cam.mmPerPixel(hCss)), maxPrims,
      },
      background: hexToRgb(this.params.background),
      camera: {
        rotation: cam.rotation, target: cam.target, halfHeight: cam.halfHeight,
        aspect: this.viewHost.clientWidth / hCss, distance: cam.sceneRadius * 4 + 100,
      },
    };
  }

  private saveScene(): void {
    const scene = {
      format: "braingl-web-scene", version: 1, dataset: this.ds?.name ?? null, nodes: this.ds?.n ?? 0,
      params: this.params, cameras: this.cams.map((c) => c.getState()), cursorNode: this.cursorNode,
      labelColors: this.labelColors, labels: btoa(rle(this.labels).map((b) => String.fromCharCode(b)).join("")),
    };
    downloadBlob(new Blob([JSON.stringify(scene, null, 1)], { type: "application/json" }), `braingl-scene-${stamp()}.scn.json`);
  }

  private async loadScene(file: File): Promise<void> {
    try {
      const s = JSON.parse(await file.text());
      if (!s || s.format !== "braingl-web-scene") throw new Error("not a brainGL-web scene file");
      // only known parameters are taken, and they are checked against the loaded dataset exactly as
      // after loading one: the scene may have been saved with other surfaces or another matrix
      const rec = this.params as unknown as Record<string, unknown>;
      Object.assign(rec, defaultGlyphParams);
      if (s.params && typeof s.params === "object") {
        for (const k of Object.keys(defaultGlyphParams)) if (k in s.params) rec[k] = s.params[k];
      }
      this.diffRestore = null; // the scene's values are what was on screen
      this.sanitizeParams();
      this.styleShown = this.params.glyphStyle;
      if (Array.isArray(s.cameras)) this.cams.forEach((c, i) => { if (isCameraState(s.cameras[i])) c.setState(s.cameras[i]); });
      if (this.ds && s.nodes === this.ds.n && typeof s.labels === "string") {
        const bytes = Uint8Array.from(atob(s.labels), (ch) => ch.charCodeAt(0));
        this.labels = unrle(bytes, this.ds.n);
        this.labelColors = Array.isArray(s.labelColors) ? s.labelColors.filter((c: unknown) => typeof c === "string").slice(0, 255) : [];
        this.refreshPaint();
        if (Number.isInteger(s.cursorNode) && s.cursorNode >= 0) this.selectNode(s.cursorNode);
      }
      this.renderer.setLut(colormapLut(this.params.colormap));
      this.updateOverlay();
      this.dirtyBuild = this.dirtyLittle = true;
      this.panel.refresh();
      this.refreshToolbar();
      this.invalidate();
    } catch (e) {
      this.fail(e);
    }
  }

  // -------------------------------------------------------------- scripting

  /** Change parameters programmatically (console: `braingl.glyphs.setParams({ glyphStyle: "pies" })`). */
  setParams(patch: Partial<GlyphParams>): void {
    // the style first: it may replace the threshold and minimum length (difference glyphs), which
    // values given in the same call must override
    const keys = (Object.keys(patch) as (keyof GlyphParams)[]).sort((a, b) => Number(b === "glyphStyle") - Number(a === "glyphStyle"));
    for (const k of keys) {
      (this.params as unknown as Record<string, unknown>)[k] = patch[k];
      this.afterChange(k);
    }
    this.panel.refresh();
  }

  /** Snap one of the two views to a canonical anatomical direction. */
  setView(v: CanonicalView, view: 0 | 1 = 0, zoom = 1): void {
    if (!this.ds) return;
    const b = computeBounds(this.ds.surfaces[view ? this.params.secondSurface : this.params.surface].positions);
    this.cams[view].frame(b.center, b.radius);
    this.cams[view].halfHeight /= zoom;
    this.cams[view].setView(v);
    this.invalidate();
    this.persist();
  }

  /** Centre the main view on a node. */
  focusNode(node: number, zoom = 4): void {
    if (!this.ds) return;
    const pos = this.ds.surfaces[this.params.surface].positions;
    const c = this.cams[0];
    c.target[0] = pos[3 * node]; c.target[1] = pos[3 * node + 1]; c.target[2] = pos[3 * node + 2];
    c.halfHeight = (c.sceneRadius * 1.05) / zoom;
    this.invalidate();
  }

  // --------------------------------------------------------------------- UI

  private toolbarEl!: HTMLElement;

  private buildToolbar(): void {
    const bar = el("div", "hud-toolbar");
    const group = (items: [string, string, () => void, (() => boolean)?][]) => {
      const g = el("div", "hud-group");
      for (const [label, tip, fn, active] of items) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = label; b.title = tip;
        b.addEventListener("click", () => { fn(); this.refreshToolbar(); this.panel.refresh(); });
        if (active) (b as HTMLButtonElement & { isActive?: () => boolean }).isActive = active;
        g.appendChild(b);
      }
      bar.appendChild(g);
    };
    const tool = (t: GlyphParams["tool"]) => () => { this.params.tool = t; this.afterChange("tool"); };
    group([
      ["Navigate", "Drag to rotate, shift-drag to pan, scroll to zoom (N)", tool("navigate"), () => this.params.tool === "navigate"],
      ["Seed", "Click or drag on the surface to select a node and show its connectivity (S). Right-click or ctrl-click selects a node with any tool.", tool("seed"), () => this.params.tool === "seed"],
      ["Paint", "Drag to paint a region; shift-drag erases (P). " + (IS_MAC
        ? "With any tool: option + right-drag paints, option + shift + right-drag erases."
        : "With any tool, as in brainGL: ctrl + right-drag paints, ctrl + shift + right-drag erases (alt works in place of ctrl)."), tool("paint"), () => this.params.tool === "paint"],
      ["Erase", "Drag to erase paint (E)", tool("erase"), () => this.params.tool === "erase"],
    ]);
    const views: [string, CanonicalView, string][] = [["L", "left", "Left lateral"], ["R", "right", "Right lateral"], ["A", "anterior", "Anterior"], ["P", "posterior", "Posterior"], ["D", "dorsal", "Dorsal"], ["V", "ventral", "Ventral"]];
    group(views.map(([l, v, tip]) => [l, tip + " view (shift-click: second view)", () => this.setView(v, lastShift ? 1 : 0)]));
    let lastShift = false;
    bar.addEventListener("pointerdown", (e) => { lastShift = e.shiftKey; }, true);
    this.viewHost.appendChild(bar);
    this.toolbarEl = bar;
    this.refreshToolbar();
  }

  private refreshToolbar(): void {
    this.toolbarEl.querySelectorAll("button").forEach((b) => {
      const f = (b as HTMLButtonElement & { isActive?: () => boolean }).isActive;
      if (f) { b.classList.toggle("active", f()); b.setAttribute("aria-pressed", String(f())); }
    });
    this.canvas.style.cursor = this.params.tool === "navigate" ? "grab" : "crosshair";
  }

  /** React to a changed parameter: decide what has to be rebuilt. */
  private afterChange(key: keyof GlyphParams): void {
    const p = this.params;
    switch (key) {
      case "hemi": case "sign": case "budgetM": case "glyphNodes":
        this.dirtyBuild = true; this.dirtyLittle = true; break;
      case "threshold": case "maxThreshold": case "minLength": case "lengthSurface":
        this.dirtyRanks = true; break;
      case "colormap":
        this.renderer.setLut(colormapLut(p.colormap));
        if (p.lineColorMode === 1) this.uploadSegments();
        break;
      case "cmin": case "cmax":
        if (p.lineColorMode === 1) this.uploadSegments();
        break;
      case "lineColorMode": this.uploadSegments(); break;
      case "surfaceColorMode": this.updateOverlay(); break;
      case "littleBrains": case "lbColorMode": case "lbMax": this.dirtyLittle = true; break;
      case "paintColor": {
        // recolouring keeps existing labels; a new colour starts a new label when painting
        break;
      }
      case "surface": case "secondSurface": {
        if (this.ds) {
          const k = key === "surface" ? 0 : 1;
          const b = computeBounds(this.ds.surfaces[p[key]].positions);
          const zoom = this.cams[k].halfHeight / (this.cams[k].sceneRadius || 1);
          this.cams[k].frame(b.center, b.radius);
          this.cams[k].halfHeight = Math.min(zoom, 1.05) * b.radius;
        }
        // the minimum length follows the displayed surface when it is measured there
        if (key === "surface" && p.lengthSurface === -1) this.dirtyRanks = true;
        break;
      }
      case "glyphStyle": {
        if (p.glyphStyle !== this.styleShown) {
          if (p.glyphStyle === "diffpoints") this.enterDiffStyle();
          else if (this.styleShown === "diffpoints") this.leaveDiffStyle();
          this.styleShown = p.glyphStyle;
          this.panel.refresh(); // threshold and minimum length may have changed
        }
        break;
      }
      default: break;
    }
    this.refreshToolbar();
    this.persist();
    this.invalidate();
  }

  private buildPanel(host: HTMLElement): void {
    const p = this.params;
    const panel = new Panel<GlyphParams>(host, p, (k) => this.afterChange(k), STORAGE, "Connectivity glyphs");
    this.panel = panel;
    const surfaces = (): [number, string][] => (this.ds ? this.ds.surfaces.map((s, i) => [i, s.name]) : [[0, "—"]]);
    const pickFiles = (opts: { folder?: boolean; accept?: string }, cb: (files: File[]) => void) => {
      const inp = document.createElement("input");
      inp.type = "file"; inp.multiple = true;
      if (opts.folder) inp.setAttribute("webkitdirectory", "");
      if (opts.accept) inp.accept = opts.accept;
      inp.addEventListener("change", () => cb(Array.from(inp.files ?? [])));
      inp.click();
    };

    panel.section("Data")
      .note(() => this.ds
        ? `<b>${escapeHtml(this.ds.name)}</b><br>${this.ds.n.toLocaleString()} nodes · ${this.ds.surfaces.length} surfaces${this.ds.description ? `<br><span class="dim">${escapeHtml(this.ds.description)}</span>` : ""}`
        : "No dataset loaded.")
      .buttons([
        { label: "Open files…", tip: "Select all files of a glyphset together: glyphset.json + binaries, or a brainGL .glyphset with its .set, .asc and matrix files, or surfaces (.asc / .surf.gii / FreeSurfer) plus a square matrix (.npy or raw float32).", onClick: () => pickFiles({}, (f) => void this.loadFiles(f)) },
        { label: "Open folder…", onClick: () => pickFiles({ folder: true }, (f) => void this.loadFiles(f)) },
        { label: "Demo", tip: "Group-average resting-state connectivity of 40 participants of the enhanced NKI Rockland sample on fsaverage4.", onClick: () => void this.loadDemo() },
      ]);

    panel.section("View")
      .select("surface", "Surface", surfaces, { tip: "Spatial representation on which the glyphs are placed." })
      .select("hemi", "Hemispheres", () => [[0, "both"], [1, "left"], [2, "right"]], { visible: () => !!this.ds && this.ds.leftNodes > 0 })
      .checkbox("secondView", "Second view: seed-based connectivity", { tip: "A coupled overview that shows the connectivity map of the selected node (brainGL's main gl 2). Right-click or use the Seed tool in either view." })
      .select("secondSurface", "Second view surface", surfaces, { visible: () => p.secondView })
      .color("background", "Background");

    panel.section("Surface")
      .checkbox("showSurface", "Show surface")
      .select("surfaceColorMode", "Colour", () => {
        const o: [string, string][] = [["sulc", "anatomy (sulcal shading)"], ["solid", "per mesh (one colour)"], ["seed", "vertex data (seed connectivity)"]];
        for (const ov of this.ds?.overlays ?? []) o.push(["overlay:" + ov.name, "overlay: " + ov.name]);
        return o;
      })
      .color("surfaceColor", "Mesh colour")
      .slider("surfaceAlpha", "Alpha", { min: 0.02, max: 1, step: 0.01, tip: "Make the surface transparent to see connections inside the brain." });

    panel.section("Glyphs")
      .checkbox("showGlyphs", "Show glyphs")
      .select("glyphStyle", "Glyph style", () => [["points", "points"], ["vectors", "vectors"], ["pies", "pies"], ["diffpoints", "diffpoints"], ["off", "off"]], {
        tip: "points: a small map of all connections of the node. vectors: the same with a line to the node, emphasising long-range connections. pies: a pie chart of connection orientations sorted by hue. diffpoints: difference between the profiles of neighbouring nodes, drawn on every mesh edge. Keys 1-4, 0.",
      })
      .slider("glyphRadius", "Scale", { min: 0.001, max: 0.2, step: 0.0005, digits: 4, tip: "Size of every glyph relative to the surface it copies." })
      .slider("primSize", "Point / line size", { min: 0.5, max: 12, step: 0.1, visible: () => p.glyphStyle !== "pies", tip: "Size in pixels of the points or lines that make up a glyph." })
      .slider("normalization", "Pie normalisation", { min: 0, max: 1, step: 0.01, visible: () => p.glyphStyle === "pies", tip: "0: all pies have the same radius. 1: the pie area is proportional to the number of connections of the node." })
      .slider("glyphAlpha", "Glyph alpha", { min: 0, max: 1, step: 0.01, visible: () => p.glyphStyle !== "pies", tip: "Below 1, weaker connections become gradually more transparent (an alternative to thresholding)." })
      .select("glyphGeometry", "Glyph geometry", () => {
        const o = surfaces() as [number, string][];
        if (this.sphere) o.push([-1, "polar projection (sphere)"]);
        return o;
      }, { visible: () => p.glyphStyle !== "pies", tip: "Surface whose shape every glyph copies, independent of the displayed surface. The polar projection unrolls the sphere around each node into a flat, overdraw-free disc that faces the viewer." })
      .select("glyphColorMode", "Colour mode", () => [[0, "orientation"], [1, "value"]], { tip: "orientation: red = left-right, green = anterior-posterior, blue = superior-inferior direction of each connection. value: connection strength through the colour map." })
      .select("colorSurface", "Glyph colour", surfaces, { visible: () => p.glyphColorMode === 0, tip: "Surface in which connection orientations are measured. The sphere maximises colour variance; the pial surface is sensitive to folding." })
      .checkbox("rotationEnabled", "Glyph rotation", { visible: () => p.glyphStyle !== "pies" && p.glyphGeometry !== -1 })
      .slider("rotX", "x rotation", { min: 0, max: 360, step: 1, visible: () => p.rotationEnabled && p.glyphStyle !== "pies" && p.glyphGeometry !== -1 })
      .slider("rotY", "y rotation", { min: 0, max: 360, step: 1, visible: () => p.rotationEnabled && p.glyphStyle !== "pies" && p.glyphGeometry !== -1 })
      .slider("rotZ", "z rotation", { min: 0, max: 360, step: 1, visible: () => p.rotationEnabled && p.glyphStyle !== "pies" && p.glyphGeometry !== -1 })
      .slider("depthLift", "Lift off surface", { min: 0, max: 8, step: 0.1, tip: "Glyphs are moved toward the viewer by this many glyph radii so that they are not buried in the folded surface." });

    // Ranges and steps follow the matrix: correlations keep 0..1 in steps of 0.005, other weights
    // get their own largest |value| and a step of about a two-hundredth of it.
    const maxAbs = () => this.ds?.conn.maxAbs ?? 1;
    const thresholdStep = () => niceStep(valueUnit(maxAbs()) / 200);
    const valueStep = () => this.valueStep();
    const colorLimit = () => this.colorLimit();
    panel.section("Thresholds")
      .slider("threshold", "Threshold", { min: 0, max: maxAbs, step: thresholdStep, tip: "Only connections stronger than this are drawn. For diffpoints: minimum difference between neighbouring profiles." })
      .select("sign", "Sign", () => [[0, "+"], [1, "−"], [2, "+ / −"]])
      .slider("minLength", "Minimum length (mm)", { min: 0, max: 150, step: 1, tip: "Remove short connections to reveal long-range structure." })
      .select("lengthSurface", "Length measured on", () => [...surfaces(), [-1, "displayed surface (as in brainGL)"]], {
        visible: () => p.minLength > 0,
        tip: "Surface in which the length of a connection is measured. brainGL measured it in the displayed surface, so the selection changed with the view; a fixed anatomical surface keeps it the same on every surface.",
      })
      .slider("maxThreshold", "Upper threshold", { min: 0, max: maxAbs, step: thresholdStep })
      .slider("budgetM", "Connexel budget (millions)", { min: 0.5, max: 40, step: 0.5, lazy: true, tip: "Upper bound on the connexels sent to the graphics card, the equivalent of brainGL's load-time minimum threshold. Raise it on a strong GPU to reach lower thresholds." });

    const legend = el("div", "legend-bar");
    panel.section("Colour map")
      .select("colormap", "Colour map", () => COLORMAP_NAMES.map((n) => [n, n]))
      .custom(legend, { refresh: () => { legend.style.background = lutToCss(colormapLut(p.colormap)); } })
      .slider("cmin", "Min", { min: () => -colorLimit(), max: colorLimit, step: valueStep })
      .slider("cmax", "Max", { min: () => -colorLimit(), max: colorLimit, step: valueStep })
      .slider("seedLower", "Surface map lower threshold", { min: 0, max: colorLimit, step: valueStep, tip: "Seed-based connectivity weaker than this shows the anatomy instead." });

    panel.section("Regions & painting")
      .note(() => {
        const k = this.labels.reduce((a, v) => a + (v ? 1 : 0), 0);
        return k ? `${k.toLocaleString()} nodes painted in ${new Set(this.labels).size - (this.labels.includes(0) ? 1 : 0)} region(s).` : `<span class="dim">Paint regions with the Paint tool (or ${PAINT_GESTURE}). Each colour is one region.</span>`;
      })
      .slider("brushSize", "Brush size (mm)", { min: 1, max: 60, step: 0.5 })
      .color("paintColor", "Paint colour")
      .checkbox("showPaint", "Show paint")
      .select("glyphNodes", "Glyphs at", () => [["all", "all nodes"], ["painted", "painted nodes only"]], { tip: "Restrict the glyphs to the painted region of interest, as in brainGL." })
      .buttons([
        { label: "Mean connectivity", tip: "Show the Fisher-z averaged connectivity of all painted nodes as the surface map.", onClick: () => this.averageSeed() },
        { label: "Clear", onClick: () => { this.labels.fill(0); this.labelColors = []; this.refreshPaint(); this.paintChanged(); } },
      ])
      .buttons([
        { label: "Load ROI…", tip: ".1D (one value per node: one region), .rgb (one region per colour other than white) or a list of node ids (one region per region number in a second column, as written by Save labels).", onClick: () => pickFiles({}, (f) => void this.loadRoi(f[0])) },
        { label: "Save .1D", tip: "One line per node: 1 inside the painted region, 0 outside (brainGL / AFNI .1D).", onClick: () => downloadBlob(new Blob([writeRoi1D(this.labels.map((v) => (v ? 1 : 0)))]), "roi.1D") },
        { label: "Save labels", tip: "One line per painted node: node id and region number (brainGL .1D.roi).", onClick: () => this.saveLabels() },
      ]);

    panel.section("Anatomical background glyphs", true)
      .checkbox("littleBrains", "Show little brains", { tip: "A miniature brain surface behind each glyph of the painted region (or of the selected node if nothing is painted), to see which areas a glyph's points belong to." })
      .select("lbColorMode", "Little brain colour", () => [[1, "vertex data (connectivity)"], [2, "anatomy"], [0, "per mesh"]], { visible: () => p.littleBrains })
      .slider("lbMax", "Maximum number", { min: 1, max: 2000, step: 1, lazy: true, visible: () => p.littleBrains })
      .note(() => (p.littleBrains && p.glyphGeometry === -1 ? `<span class="warn">Not available with the polar projection.</span>` : ""), { visible: () => p.littleBrains && p.glyphGeometry === -1 });

    panel.section("Connections & bundling", true)
      .note(() => this.connexels
        ? `${this.connexels.values.length.toLocaleString()} connexels${this.connexels.truncated ? " (strongest kept)" : ""}${this.bundles ? ", bundled" : ""}.`
        : `<span class="dim">Turn the connections that pass the current threshold and minimum length into lines, then bundle them.</span>`)
      .slider("maxConnexels", "Maximum connexels", { min: 100, max: 40000, step: 100 })
      .buttons([
        { label: "Make connections", primary: true, onClick: () => this.makeConnections() },
        { label: "Bundle", tip: "Mean-shift edge bundling (Böttger et al. 2014).", onClick: () => this.bundle() },
        { label: "Clear", onClick: () => { this.worker?.terminate(); this.worker = null; this.progress(null); this.connexels = null; this.bundles = null; this.renderer.setSegments(null, 0); this.invalidate(); } },
      ])
      .checkbox("showConnections", "Show connections")
      .select("lineColorMode", "Line colour", () => [[0, "orientation"], [1, "value"]])
      .slider("lineWidth", "Line width", { min: 0.5, max: 8, step: 0.1 })
      .slider("lineAlpha", "Line alpha", { min: 0.02, max: 1, step: 0.01 })
      .slider("bundleCompat", "Compatibility threshold", { min: 0.5, max: 0.99, step: 0.01, tip: "How similar two connections must be to attract each other (default 0.8)." })
      .slider("bundleBell", "Kernel width (mm)", { min: 1, max: 30, step: 0.5, tip: "Radius of the Gaussian mean-shift kernel (default 5 mm)." })
      .buttons([
        { label: "Save .cxls", tip: "Weighted connexels as text: x1 y1 z1 x2 y2 z2 value", onClick: () => { if (this.connexels) downloadBlob(new Blob([writeCxls(this.connexels.edges, this.connexels.values)]), "connections.cxls"); } },
        { label: "Save .fib", tip: "Lines as binary VTK polydata, readable by brainGL, TrackVis and DSI Studio.", onClick: () => { const l = this.currentLines(); if (l) downloadBlob(new Blob([writeFibVtk(l)]), this.bundles ? "bundles.fib" : "connections.fib"); } },
      ]);

    const exp = panel.section("Export");
    exp.slider("screenshotScale", "Screenshot scale", { min: 1, max: 8, step: 0.5, tip: "Multiple of the screen resolution." })
      .buttons([
        { label: "Screenshot", primary: true, onClick: () => this.screenshot() },
        { label: "Save scene", tip: "All settings, views and painted regions as a JSON file.", onClick: () => this.saveScene() },
        { label: "Load scene…", onClick: () => pickFiles({ accept: ".json,.scn" }, (f) => f[0] && void this.loadScene(f[0])) },
      ]);
    const bridge: { label: string; onClick: () => void; tip?: string }[] = [];
    if (this.hooks.openInDirectionality) {
      bridge.push({
        label: "Regions → Directionality", tip: "Open the displayed surface with the painted regions as a parcellation in the Directionality workspace. The direction field is derived at the borders that regions share, so arrows appear only where painted regions touch: paint at least two adjacent regions (different paint colours).",
        onClick: () => { const s = this.surfaceExport(); if (s) this.hooks.openInDirectionality!(s, "labels"); },
      });
      bridge.push({
        label: "Map → Directionality", tip: "Open the displayed surface with the current surface map (seed connectivity or overlay) binned into ordered regions.",
        onClick: () => { const s = this.surfaceExport(); if (s) this.hooks.openInDirectionality!(s, "scalars"); },
      });
    }
    if (bridge.length) exp.buttons(bridge);
    exp.buttons([{
      label: "Reset to defaults", onClick: () => {
        Object.assign(p, defaultGlyphParams);
        this.renderer.setLut(colormapLut(p.colormap));
        this.diffRestore = null;
        try { localStorage.removeItem(STORAGE + ".dataset"); localStorage.removeItem(STORAGE + ".unit"); } catch { /* ignore */ }
        if (this.ds) this.setDataset(this.ds, this.fileRoi, null, null, this.targets);
      },
    }]);
    panel.refresh();
  }

  private averageSeed(): void {
    const ds = this.ds;
    if (!ds) return;
    const k = averageConnectivity(ds.conn, this.labels, this.seedRow);
    if (!k) return;
    this.seedIsAverage = true;
    this.cursorNode = -1;
    this.renderer.setScalars(this.seedRow);
    this.invalidate();
  }

  private async loadRoi(file: File | undefined): Promise<void> {
    const ds = this.ds;
    if (!ds || !file) return;
    try {
      const roi = parseRoiRegions(file.name, await file.text(), ds.n);
      const r = assignRoiRegions(this.labels, this.labelColors, roi, this.params.paintColor);
      this.labels = r.labels;
      this.labelColors = r.labelColors;
      this.refreshPaint();
      this.paintChanged();
    } catch (e) {
      this.fail(e);
    }
  }

  private saveLabels(): void {
    downloadBlob(new Blob([writeRoiLabels(this.labels)]), "regions.1D.roi");
  }
}

// ------------------------------------------------------------------ helpers

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

function fmtCount(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(2) + " M" : n >= 1e4 ? Math.round(n / 1e3) + " k" : n.toLocaleString();
}

function stamp(): string {
  return new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
}

function isCameraState(s: unknown): s is CameraState {
  const c = s as CameraState | null;
  const nums = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every((v) => typeof v === "number" && Number.isFinite(v));
  return !!c && typeof c === "object" && nums(c.rotation, 4) && nums(c.target, 3) && typeof c.halfHeight === "number" && c.halfHeight > 0 && Number.isFinite(c.halfHeight);
}

function loadStored<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function store(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be unavailable */ }
}

/** Run-length encode labels as (value, count<=255) byte pairs. */
function rle(a: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length;) {
    let j = i;
    while (j < a.length && a[j] === a[i] && j - i < 255) j++;
    out.push(a[i], j - i);
    i = j;
  }
  return out;
}

function unrle(bytes: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let k = 0;
  for (let i = 0; i + 1 < bytes.length && k < n; i += 2) {
    out.fill(bytes[i], k, Math.min(n, k + bytes[i + 1]));
    k += bytes[i + 1];
  }
  return out;
}

/** Files of a drop event, descending into dropped folders. */
async function collectDroppedFiles(dt: DataTransfer | null): Promise<File[]> {
  if (!dt) return [];
  const entries = Array.from(dt.items ?? []).map((it) => it.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Array.from(dt.files);
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const b of batch) await walk(b);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}
