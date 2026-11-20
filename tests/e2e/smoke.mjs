#!/usr/bin/env node
// End-to-end smoke test of brainGL-web in headless Chrome (puppeteer-core, no bundled browser).
//
//   npm run test:e2e                          build, then run this script against `vite preview`
//   node tests/e2e/smoke.mjs                  run against the existing dist/ (no build)
//   node tests/e2e/smoke.mjs --url http://localhost:5173/     use a server that is already running
//
// Flags
//   --url <url>        test this server instead of starting `vite preview` (dev server or deployment)
//   --port <n>         first port to try for `vite preview` (default 4317; 5173 is never used)
//   --timeout <ms>     time allowed for the demo dataset to load (default 90000)
//   --headed           show the browser window
//   --screenshots      save a screenshot after every check, not only after failed ones
//   --artifacts <dir>  where screenshots go (default tests/e2e/.artifacts, git-ignored)
//
// Environment
//   CHROME_PATH        Chrome / Chromium executable. Default: Google Chrome.app on macOS,
//                      `google-chrome` (looked up on PATH) elsewhere.
//   E2E_NO_SANDBOX=1   pass --no-sandbox (also done automatically when CI is set or running as root)
//
// What is checked (one PASS / FAIL line each, summary at the end, exit code 1 if anything failed):
//   1. the demo glyphset loads (window.braingl.glyphs.ds, 5124 nodes)
//   2. every glyph style (points, vectors, pies, diffpoints) and the polar geometry draw coloured
//      pixels, the styles differ from one another, and "off" removes the glyphs again
//   3. selecting a seed node recolours the inset (second view)
//   4. no console errors, page errors, failed requests or HTTP errors during the whole run
//   5. the Directionality workspace mounts and draws
//   6. the glyphs -> Directionality bridge loads the seed map into the Directionality workspace
//   7. "Export for Blender" downloads a zip with scene.json and the layers it lists
//   8. the view (surface, camera, glyph style) is restored after a reload
//
// Checks that document a defect of the application are registered with `knownBug` and reported as
// "KNOWN BUG (expected failure)"; they do not fail the run, and say so once the defect is fixed:
//   2*. diffpoints draws nothing at the default threshold (the regular diffpoints check lowers it)
//   9.  the loading progress box is never visible
//   10. the Directionality workspace raises a WebGL error (glGenerateMipmap) on every frame
//
// Pixels are read in the page: the WebGL canvases are created with preserveDrawingBuffer, so they
// can be copied into a 2D canvas and inspected with getImageData. This file is plain JavaScript on
// purpose (the repository's tsc only covers src/ and tools/).

import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO_NODES = 5124;
const SEED_NODE = 1200;
const VIEWPORT = { width: 1400, height: 900, deviceScaleFactor: 1 };
const GLYPH_CANVAS = "#ws-glyphs .ws-view canvas";
const DIR_CANVAS = "#ws-directionality .ws-view canvas";

// ------------------------------------------------------------------- options

function parseArgs(argv) {
  const o = { url: null, port: 4317, timeout: 90000, headed: false, screenshots: false, artifacts: path.join(ROOT, "tests/e2e/.artifacts") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--url") o.url = value();
    else if (a === "--port") o.port = Number(value());
    else if (a === "--timeout") o.timeout = Number(value());
    else if (a === "--artifacts") o.artifacts = path.resolve(value());
    else if (a === "--headed") o.headed = true;
    else if (a === "--screenshots") o.screenshots = true;
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
      process.exit(0);
    } else throw new Error(`unknown argument ${a} (see --help)`);
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error("--port must be a port number");
  if (!(o.timeout > 0)) throw new Error("--timeout must be a positive number of milliseconds");
  if (o.url && !o.url.endsWith("/")) o.url += "/";
  return o;
}

function chromePath() {
  const mac = process.platform === "darwin";
  const p = process.env.CHROME_PATH || (mac ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
  if (p.includes(path.sep)) {
    if (!fs.existsSync(p)) throw new Error(`Chrome was not found at ${p}; set CHROME_PATH`);
    return p;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const full = path.join(dir, p);
    if (dir && fs.existsSync(full)) return full;
  }
  throw new Error(`"${p}" is not on PATH; set CHROME_PATH to a Chrome or Chromium executable`);
}

// -------------------------------------------------------------------- server

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Child processes (vite preview, Chrome) to kill if this process is interrupted or exits early. */
const children = new Set();
const tempDirs = new Set();
process.on("exit", () => {
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));

function withTimeout(promise, ms, what) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function freePort(start) {
  for (let p = start; p < start + 50 && p <= 65535; p++) {
    if (p === 5173) continue; // a dev server may live there
    if (await portIsFree(p)) return p;
  }
  throw new Error(`no free port in ${start}..${start + 49}`);
}

function newestMtime(p) {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.mtimeMs;
  let m = 0;
  for (const e of fs.readdirSync(p)) m = Math.max(m, newestMtime(path.join(p, e)));
  return m;
}

/** Start `vite preview` on a free port and wait until it serves the app. */
async function startPreview(firstPort) {
  const index = path.join(ROOT, "dist/index.html");
  if (!fs.existsSync(index)) throw new Error("dist/index.html is missing: run `npm run build` first (or `npm run test:e2e`, which builds)");
  const built = fs.statSync(index).mtimeMs;
  if (Math.max(newestMtime(path.join(ROOT, "src")), newestMtime(path.join(ROOT, "index.html"))) > built) {
    console.log("note: dist/ is older than the sources; `npm run test:e2e` rebuilds before testing");
  }
  const port = await freePort(firstPort);
  // same rule as vite.config.ts: the site lives under /<repo>/ on GitHub Actions
  const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
  const base = process.env.GITHUB_ACTIONS && repo ? `/${repo}/` : "/";
  const url = `http://127.0.0.1:${port}${base}`;
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  let exited = null;
  children.add(child);
  child.once("exit", (code, signal) => { exited = `exit ${code ?? signal}`; children.delete(child); });
  const stop = () => { if (exited === null) child.kill("SIGTERM"); };
  const t0 = Date.now();
  for (;;) {
    if (exited !== null) throw new Error(`vite preview stopped (${exited}):\n${log}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok && (await res.text()).includes("brainGL")) return { url, stop };
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 30000) { stop(); throw new Error(`vite preview did not answer at ${url} within 30 s:\n${log}`); }
    await sleep(150);
  }
}

// --------------------------------------------------- helpers run in the page

/** Installed once as window.__e2e; everything that touches pixels lives here. */
function installPageHelpers() {
  const E = (window.__e2e = { snaps: new Map() });
  const scratch = document.createElement("canvas");
  const tiny = document.createElement("canvas");
  tiny.width = 128; tiny.height = 80;

  const canvasOf = (sel) => {
    const c = document.querySelector(sel);
    if (!(c instanceof HTMLCanvasElement)) throw new Error(`no canvas matches ${sel}`);
    if (!c.width || !c.height) throw new Error(`canvas ${sel} has no size (${c.width}x${c.height})`);
    return c;
  };

  /** Copy a (WebGL) canvas into ImageData and keep it under `name`. */
  E.snap = (name, sel) => {
    const c = canvasOf(sel);
    scratch.width = c.width; scratch.height = c.height;
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(c, 0, 0);
    E.snaps.set(name, ctx.getImageData(0, 0, c.width, c.height));
    return { w: c.width, h: c.height };
  };

  /** Rectangle of a DOM element in the pixel grid of a canvas (top-left origin), or null when it is not shown. */
  E.rectOf = (canvasSel, elSel) => {
    const c = canvasOf(canvasSel);
    const e = document.querySelector(elSel);
    if (!e) return null;
    const cr = c.getBoundingClientRect(), er = e.getBoundingClientRect();
    if (er.width < 1 || er.height < 1) return null;
    const sx = c.width / cr.width, sy = c.height / cr.height;
    return { x: Math.round((er.left - cr.left) * sx), y: Math.round((er.top - cr.top) * sy), w: Math.round(er.width * sx), h: Math.round(er.height * sy) };
  };

  const get = (name) => {
    const img = E.snaps.get(name);
    if (!img) throw new Error(`no snapshot named ${name}`);
    return img;
  };
  const clip = (img, rect) => {
    const r = rect ?? { x: 0, y: 0, w: img.width, h: img.height };
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
    return { x0, y0, x1: Math.min(img.width, r.x + r.w), y1: Math.min(img.height, r.y + r.h) };
  };
  const inside = (x, y, r) => !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

  /**
   * Count pixels of a snapshot inside `rect` (minus `exclude`):
   *   nonBackground  differ from the background (the pixel 3 px inside the top-left corner of the region)
   *   coloured       non-background pixels whose chroma (max - min of r, g, b) is above `chroma`,
   *                  i.e. neither the grey surface nor the near-black background
   */
  E.stats = (name, { rect = null, exclude = null, chroma = 48, tolerance = 24 } = {}) => {
    const img = get(name), d = img.data, W = img.width;
    const { x0, y0, x1, y1 } = clip(img, rect);
    const b = 4 * ((y0 + 3) * W + x0 + 3);
    const bg = [d[b], d[b + 1], d[b + 2], d[b + 3]];
    let total = 0, nonBackground = 0, coloured = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (inside(x, y, exclude)) continue;
        const i = 4 * (y * W + x);
        const r = d[i], g = d[i + 1], bl = d[i + 2], a = d[i + 3];
        total++;
        if (Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(bl - bg[2]), Math.abs(a - bg[3])) <= tolerance) continue;
        nonBackground++;
        if (a > 0 && Math.max(r, g, bl) - Math.min(r, g, bl) > chroma) coloured++;
      }
    }
    return { total, nonBackground, coloured, background: bg };
  };

  /** Number of pixels that differ between two snapshots inside `rect` (minus `exclude`). */
  E.diff = (nameA, nameB, { rect = null, exclude = null, tolerance = 24 } = {}) => {
    const A = get(nameA), B = get(nameB);
    if (A.width !== B.width || A.height !== B.height) throw new Error(`snapshots ${nameA} and ${nameB} differ in size`);
    const a = A.data, b = B.data, W = A.width;
    const { x0, y0, x1, y1 } = clip(A, rect);
    let total = 0, changed = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (inside(x, y, exclude)) continue;
        const i = 4 * (y * W + x);
        total++;
        if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) > tolerance) changed++;
      }
    }
    return { total, changed };
  };

  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  /**
   * Wait until the canvas has been redrawn and stopped changing: at least `minFrames` animation
   * frames, then `stableFrames` consecutive frames with an identical (downscaled) picture.
   */
  E.settle = async (sel, { minFrames = 3, stableFrames = 3, timeoutMs = 30000 } = {}) => {
    const ctx = tiny.getContext("2d", { willReadFrequently: true });
    const t0 = performance.now();
    let last = null, stable = 0, frames = 0;
    for (;;) {
      await raf();
      frames++;
      const c = canvasOf(sel);
      ctx.clearRect(0, 0, tiny.width, tiny.height);
      ctx.drawImage(c, 0, 0, tiny.width, tiny.height);
      const d = ctx.getImageData(0, 0, tiny.width, tiny.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
      if (h === last) stable++; else { stable = 0; last = h; }
      if (frames >= minFrames && stable >= stableFrames) return { frames, ms: Math.round(performance.now() - t0) };
      if (performance.now() - t0 > timeoutMs) throw new Error(`canvas ${sel} did not settle within ${timeoutMs} ms`);
    }
  };
}

// ------------------------------------------------------------------- zip

/** Minimal zip reader (stored and deflated entries), enough to verify the Blender bundle. */
function readZip(buf) {
  if (buf.length < 22 || buf.toString("latin1", 0, 2) !== "PK") throw new Error(`not a zip file: starts with ${JSON.stringify(buf.toString("latin1", 0, 4))}`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) throw new Error(`zip: ${name} is truncated`);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`zip: ${name} uses unsupported compression method ${method}`);
    if (data.length !== usize) throw new Error(`zip: ${name} has ${data.length} bytes, directory says ${usize}`);
    files.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ------------------------------------------------------------------ runner

const results = [];

const LABEL = { PASS: "PASS ", FAIL: "FAIL ", SKIP: "SKIP ", KNOWN: "KNOWN BUG (expected failure) " };

function line(status, name, detail) {
  console.log(`${LABEL[status]} ${name}${detail ? " — " + detail : ""}`);
}

class Skip extends Error {}

/**
 * Run one named check. `fn` returns a short detail string or throws.
 *   needs     names of checks that must have passed (otherwise this one is skipped and counts as failed)
 *   knownBug  description of an application defect this check documents; a failure is then expected
 */
async function check(ctx, name, fn, { needs = [], knownBug = null } = {}) {
  const t0 = Date.now();
  const rec = { name, status: "PASS", detail: "", ms: 0, knownBug };
  const missing = needs.filter((n) => results.find((r) => r.name === n)?.status !== "PASS");
  try {
    if (missing.length) throw new Skip(`needs "${missing[0]}"${missing.length > 1 ? ` and ${missing.length - 1} more` : ""}`);
    rec.detail = (await withTimeout(Promise.resolve().then(fn), ctx.checkTimeout, `check "${name}"`)) ?? "";
    if (knownBug) rec.detail = `known bug no longer reproduces, remove its knownBug marker (${knownBug})` + (rec.detail ? "; " + rec.detail : "");
  } catch (e) {
    rec.status = e instanceof Skip ? "SKIP" : knownBug ? "KNOWN" : "FAIL";
    rec.detail = e instanceof Error ? e.message : String(e);
  }
  rec.ms = Date.now() - t0;
  results.push(rec);
  line(rec.status, name, `${rec.detail}${rec.detail ? " " : ""}[${rec.ms} ms]`);
  if (ctx.page && (rec.status === "FAIL" || ctx.opts.screenshots)) {
    try {
      fs.mkdirSync(ctx.opts.artifacts, { recursive: true });
      const file = path.join(ctx.opts.artifacts, `${String(results.length).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}.png`);
      await withTimeout(ctx.page.screenshot({ path: file }), 15000, "screenshot");
      if (rec.status === "FAIL") console.log(`      screenshot: ${file}`);
    } catch (e) {
      console.log(`      (no screenshot: ${e instanceof Error ? e.message : e})`);
    }
  }
  return rec.status === "PASS";
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const pct = (part, total) => `${((100 * part) / Math.max(1, total)).toFixed(1)}%`;

// -------------------------------------------------------------------- main

async function run(opts) {
  const cleanup = [];
  const ctx = { opts, page: null, checkTimeout: 60000 };
  const problems = []; // console errors, page errors, failed requests, HTTP errors
  const glErrors = []; // WebGL errors, which Chrome logs as console warnings
  let failedEarly = null;
  try {
    let url = opts.url;
    if (!url) {
      const server = await startPreview(opts.port);
      cleanup.push(server.stop);
      url = server.url;
    }
    console.log(`brainGL-web e2e smoke test — ${url}`);

    const mac = process.platform === "darwin";
    const noSandbox = process.env.E2E_NO_SANDBOX === "1" || !!process.env.CI || process.getuid?.() === 0;
    const browser = await puppeteer.launch({
      executablePath: chromePath(),
      headless: !opts.headed, // puppeteer >= 22: true is the "new" headless mode
      args: [
        ...(mac ? ["--use-angle=metal"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
        "--ignore-gpu-blocklist", "--enable-webgl", "--enable-gpu", "--hide-scrollbars",
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        ...(noSandbox ? ["--no-sandbox"] : []),
      ],
      defaultViewport: VIEWPORT,
    });
    const chrome = browser.process();
    if (chrome) { children.add(chrome); chrome.once("exit", () => children.delete(chrome)); }
    cleanup.push(() => browser.close());

    // downloads go to a temporary directory, named by their GUID
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "braingl-e2e-"));
    tempDirs.add(downloadDir);
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadDir, eventsEnabled: true });
    const downloads = new Map(); // guid -> { name, state }
    cdp.on("Browser.downloadWillBegin", (e) => downloads.set(e.guid, { name: e.suggestedFilename, state: "inProgress" }));
    cdp.on("Browser.downloadProgress", (e) => { const d = downloads.get(e.guid); if (d) d.state = e.state; });
    /** Run `trigger` and return the file it downloads. */
    const download = async (trigger, timeoutMs = 30000) => {
      const before = new Set(downloads.keys());
      await trigger();
      const t0 = Date.now();
      for (;;) {
        const guid = [...downloads.keys()].find((g) => !before.has(g));
        const d = guid ? downloads.get(guid) : null;
        if (d?.state === "completed") return { name: d.name, data: fs.readFileSync(path.join(downloadDir, guid)) };
        if (d?.state === "canceled") throw new Error(`download of ${d.name} was cancelled`);
        if (Date.now() - t0 > timeoutMs) throw new Error(d ? `download of ${d.name} did not finish within ${timeoutMs} ms` : `no download started within ${timeoutMs} ms`);
        await sleep(50);
      }
    };

    const page = await browser.newPage();
    ctx.page = page;
    const isFavicon = (u) => /\/favicon\.ico(\?|$)/.test(u);
    page.on("console", (m) => {
      if (/^warn/.test(m.type()) && /GL_INVALID|GL_OUT_OF_MEMORY|WebGL: (INVALID|CONTEXT_LOST)/.test(m.text())) glErrors.push(m.text().replace(/^\[\.WebGL-0x[0-9a-f]+\]\s*/i, ""));
      if (m.type() !== "error") return;
      const loc = m.location();
      if (loc?.url && isFavicon(loc.url)) return;
      problems.push(`console.error: ${m.text()}${loc?.url ? ` (${loc.url}${loc.lineNumber !== undefined ? ":" + loc.lineNumber : ""})` : ""}`);
    });
    page.on("pageerror", (e) => problems.push(`page error: ${e instanceof Error ? e.stack || e.message : String(e)}`));
    page.on("requestfailed", (r) => {
      const why = r.failure()?.errorText ?? "failed";
      // a blob: download started through <a download> is reported as an aborted navigation
      if (isFavicon(r.url()) || (r.url().startsWith("blob:") && why === "net::ERR_ABORTED")) return;
      problems.push(`request failed: ${r.method()} ${r.url()} (${why})`);
    });
    page.on("response", (r) => { if (r.status() >= 400 && !isFavicon(r.url())) problems.push(`HTTP ${r.status()}: ${r.url()}`); });

    const ev = (fn, ...args) => page.evaluate(fn, ...args);
    /** Wait for a canvas to be redrawn and stable, then keep its pixels under `name`. */
    const settleAndSnap = async (name, sel) => {
      await ev((s) => window.__e2e.settle(s), sel);
      return ev((n, s) => window.__e2e.snap(n, s), name, sel);
    };
    const glyphErrors = () => ev(() => [...document.querySelectorAll("#ws-glyphs .hud-status .err")].map((e) => e.textContent).join("; "));
    const banner = () => ev(() => { const b = document.getElementById("banner"); return b && getComputedStyle(b).display !== "none" ? b.textContent : ""; });
    const assertNoAppError = async () => {
      const e = await glyphErrors(), b = await banner();
      assert(!e, `the glyph workspace reports: ${e}`);
      assert(!b, `the error banner is shown: ${b}`);
    };

    // Record, from the first script on, whether the loading progress box can be seen whenever the app
    // has put a message into it (check 9).
    await page.evaluateOnNewDocument(() => {
      const rec = (window.__e2eProgress = { withMessage: 0, visible: 0, messages: [] });
      const sample = () => {
        const e = document.querySelector("#ws-glyphs .hud-progress");
        if (!e || e.style.display === "none") return; // not built yet, or hidden by the app
        const text = (e.textContent ?? "").trim();
        if (!text) return;
        rec.withMessage++;
        if (!rec.messages.includes(text)) rec.messages.push(text);
        if (getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0) rec.visible++;
      };
      new MutationObserver(sample).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });

    // ------------------------------------------------------------ 1. demo loads
    const C1 = "1. demo dataset loads";
    await check(ctx, C1, async () => {
      const t0 = Date.now();
      await page.goto(url + "?workspace=glyphs", { waitUntil: "load", timeout: opts.timeout });
      await ev(installPageHelpers);
      try {
        await page.waitForFunction(() => !!window.braingl?.glyphs?.ds, { timeout: opts.timeout });
      } catch {
        const state = await ev(() => ({ api: typeof window.braingl, status: document.querySelector("#ws-glyphs .hud-status")?.textContent ?? "", progress: document.querySelector("#ws-glyphs .hud-progress-text")?.textContent ?? "" }));
        throw new Error(`window.braingl.glyphs.ds was not set within ${opts.timeout} ms (${JSON.stringify(state)})`);
      }
      const info = await ev(() => { const d = window.braingl.glyphs.ds; return { n: d.n, name: d.name, surfaces: d.surfaces.map((s) => s.name) }; });
      assert(info.n === DEMO_NODES, `expected ${DEMO_NODES} nodes, the dataset has ${info.n}`);
      await assertNoAppError();
      return `"${info.name}", n = ${info.n}, surfaces: ${info.surfaces.join(", ")}, ${Date.now() - t0} ms`;
    });

    await check(ctx, "9. loading progress box is visible while the demo loads", async () => {
      const rec = await ev(() => window.__e2eProgress);
      assert(rec.withMessage > 0, "the app never put a message into .hud-progress while loading");
      assert(rec.visible > 0, `.hud-progress held ${rec.messages.length} message(s) (${rec.messages.map((m) => `"${m}"`).join(", ")}) but was never visible (computed display: none)`);
      return `visible in ${rec.visible} of ${rec.withMessage} samples`;
    }, {
      needs: [C1],
      knownBug: "GlyphApp.progress() shows the box with style.display = \"\", which falls back to the stylesheet rule `.hud-progress { display: none }` (index.html), so load and bundling progress is never shown",
    });

    // ------------------------------------------------- 2. glyph styles draw
    // Without a seed the surface is grey (sulcal depth) and the background near black, so every
    // coloured pixel of the main view is a glyph. The inset (which never shows glyphs) is left out.
    let inset = null;
    const styles = [
      { key: "points", patch: { glyphStyle: "points" } },
      { key: "vectors", patch: { glyphStyle: "vectors" } },
      { key: "pies", patch: { glyphStyle: "pies" } },
      // neighbouring connectivity profiles differ by less than the default threshold of 0.5 (see the known bug below)
      { key: "diffpoints", patch: { glyphStyle: "diffpoints", threshold: 0.1 }, label: "diffpoints (threshold 0.1)", restore: ["threshold"] },
      { key: "polar", patch: { glyphStyle: "points", glyphGeometry: -1 }, label: "points, polar geometry (glyphGeometry: -1)" },
    ];
    const styleStats = {};
    let geometry0 = null;
    const setStyle = async (s) => {
      const before = await ev((keys) => Object.fromEntries(keys.map((k) => [k, window.braingl.glyphs.params[k]])), s.restore ?? []);
      await ev((patch) => window.braingl.glyphs.setParams({ showGlyphs: true, ...patch }), s.patch);
      return () => ev((b) => window.braingl.glyphs.setParams(b), before);
    };
    const MIN_COLOURED = 3000; // of ~1.2 M pixels; an empty or grey-only picture has (close to) none
    const styleChecks = [];
    for (const s of styles) {
      if (s.key === "diffpoints") {
        await check(ctx, "2*. glyph style diffpoints draws coloured glyphs at the default threshold", async () => {
          const threshold = await ev(() => window.braingl.glyphs.params.threshold);
          await ev(() => window.braingl.glyphs.setParams({ showGlyphs: true, glyphStyle: "diffpoints" }));
          await settleAndSnap("diffpoints-default", GLYPH_CANVAS);
          const st = await ev((n, ex) => window.__e2e.stats(n, { exclude: ex }), "diffpoints-default", inset);
          const status = await ev(() => document.querySelector("#ws-glyphs .hud-status")?.textContent ?? "");
          assert(st.coloured >= MIN_COLOURED, `${st.coloured} coloured pixels at threshold ${threshold}; status line: "${status.replace(/\s+/g, " ").trim()}"`);
          return `${st.coloured} coloured px at threshold ${threshold}`;
        }, {
          needs: [C1],
          knownBug: "with the default threshold (0.5) the diffpoints style draws no glyph at all on the demo data and the status line gives no hint; glyphs only appear once the threshold is lowered to about 0.3 or less",
        });
      }
      const name = `2. glyph style ${s.label ?? s.key} draws coloured glyphs`;
      styleChecks.push(name);
      await check(ctx, name, async () => {
        if (geometry0 === null) geometry0 = await ev(() => window.braingl.glyphs.params.glyphGeometry);
        const restore = await setStyle(s);
        try {
          await settleAndSnap(s.key, GLYPH_CANVAS);
          inset = await ev((c) => window.__e2e.rectOf(c, "#ws-glyphs .inset-frame"), GLYPH_CANVAS);
          const st = await ev((n, ex) => window.__e2e.stats(n, { exclude: ex }), s.key, inset);
          styleStats[s.key] = st;
          const got = await ev(() => ({ style: window.braingl.glyphs.params.glyphStyle, geometry: window.braingl.glyphs.params.glyphGeometry }));
          assert(got.style === s.patch.glyphStyle, `params.glyphStyle is ${got.style} after setParams`);
          if (s.patch.glyphGeometry !== undefined) assert(got.geometry === s.patch.glyphGeometry, `params.glyphGeometry is ${got.geometry} after setParams`);
          await assertNoAppError();
          assert(st.coloured >= MIN_COLOURED, `only ${st.coloured} coloured pixels in the main view (expected at least ${MIN_COLOURED}; ${st.nonBackground} non-background of ${st.total})`);
          return `${st.coloured} coloured px (${pct(st.coloured, st.total)}), ${st.nonBackground} non-background`;
        } finally {
          await restore();
        }
      }, { needs: [C1] });
    }

    const C2D = "2. glyph styles differ from one another";
    await check(ctx, C2D, async () => {
      const keys = styles.map((s) => s.key);
      const parts = [];
      let worst = Infinity;
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const d = await ev((a, b, ex) => window.__e2e.diff(a, b, { exclude: ex }), keys[i], keys[j], inset);
          worst = Math.min(worst, d.changed);
          parts.push(`${keys[i]}/${keys[j]} ${d.changed}`);
          assert(d.changed >= 2000, `${keys[i]} and ${keys[j]} look the same: only ${d.changed} of ${d.total} pixels differ`);
        }
      }
      return `differing px per pair: ${parts.join(", ")} (minimum ${worst})`;
    }, { needs: styleChecks });

    const C2O = "2. glyph style off removes the glyphs; points come back identical";
    await check(ctx, C2O, async () => {
      await ev((g) => window.braingl.glyphs.setParams({ glyphStyle: "off", glyphGeometry: g }), geometry0);
      await settleAndSnap("off", GLYPH_CANVAS);
      const off = await ev((n, ex) => window.__e2e.stats(n, { exclude: ex }), "off", inset);
      assert(off.coloured < 200, `${off.coloured} coloured pixels remain with glyphStyle "off"`);
      assert(off.nonBackground > 20000, `the surface is not drawn with glyphStyle "off" (${off.nonBackground} non-background pixels)`);
      await ev(() => window.braingl.glyphs.setParams({ glyphStyle: "points" }));
      await settleAndSnap("points2", GLYPH_CANVAS);
      const d = await ev((ex) => window.__e2e.diff("points", "points2", { exclude: ex }), inset);
      assert(d.changed < 200, `the points picture is not restored after cycling through the styles: ${d.changed} pixels differ from the first one`);
      return `off: ${off.coloured} coloured px, surface ${off.nonBackground} px; points again: ${d.changed} px differ from the first picture`;
    }, { needs: styleChecks });

    // ------------------------------------------------- 3. seed recolours the inset
    const C3 = `3. selecting seed node ${SEED_NODE} changes the inset`;
    await check(ctx, C3, async () => {
      assert(await ev(() => window.braingl.glyphs.params.secondView), "params.secondView is off, so there is no inset");
      await settleAndSnap("seed-before", GLYPH_CANVAS);
      inset = await ev((c) => window.__e2e.rectOf(c, "#ws-glyphs .inset-frame"), GLYPH_CANVAS);
      assert(inset, "the inset frame (.inset-frame) is not shown");
      const before = await ev((r) => window.__e2e.stats("seed-before", { rect: r }), inset);
      assert(before.nonBackground > 0.1 * before.total, `the inset is empty before a seed is selected (${before.nonBackground} of ${before.total} px)`);
      await ev((n) => window.braingl.glyphs.selectNode(n), SEED_NODE);
      await settleAndSnap("seed-after", GLYPH_CANVAS);
      const after = await ev((r) => window.__e2e.stats("seed-after", { rect: r }), inset);
      const d = await ev((r) => window.__e2e.diff("seed-before", "seed-after", { rect: r }), inset);
      const cursor = await ev(() => window.braingl.glyphs.cursorNode);
      assert(cursor === SEED_NODE, `cursorNode is ${cursor}`);
      await assertNoAppError();
      assert(d.changed > 0.03 * d.total, `only ${d.changed} of ${d.total} inset pixels changed`);
      assert(after.coloured > before.coloured + 0.03 * after.total, `the inset did not gain coloured pixels (${before.coloured} -> ${after.coloured} of ${after.total})`);
      const status = await ev(() => document.querySelector("#ws-glyphs .hud-status")?.textContent ?? "");
      assert(status.includes(`node ${SEED_NODE}`), `the status line does not name the seed: "${status}"`);
      return `inset ${inset.w}x${inset.h}: ${pct(d.changed, d.total)} of its pixels changed, coloured ${before.coloured} -> ${after.coloured}`;
    }, { needs: [C1] });

    // ------------------------------------------------- 7. Blender export (glyphs)
    const C7 = "7. Export for Blender downloads a zip (glyph workspace)";
    await check(ctx, C7, async () => {
      const file = await download(() => ev(() => window.braingl.exportForBlender()));
      await assertNoAppError();
      assert(file.name.endsWith(".zip"), `downloaded file is called ${file.name}`);
      assert(file.data.toString("latin1", 0, 2) === "PK", `the download does not start with "PK" (${file.data.length} bytes)`);
      const files = readZip(file.data);
      assert(files.has("scene.json"), `scene.json is missing; the zip holds ${[...files.keys()].join(", ")}`);
      const scene = JSON.parse(files.get("scene.json").toString("utf8"));
      assert(scene.format === "braingl-blender-scene", `scene.json has format ${scene.format}`);
      assert(Array.isArray(scene.layers) && scene.layers.length > 0, "scene.json lists no layers");
      for (const l of scene.layers) {
        const ply = files.get(l.file);
        assert(ply, `layer file ${l.file} is listed in scene.json but not in the zip`);
        assert(ply.toString("latin1", 0, 3) === "ply", `${l.file} is not a PLY file`);
        assert(l.vertices > 0, `layer ${l.name} has no vertices`);
      }
      assert(scene.camera && scene.camera.type === "ORTHO", "scene.json has no camera");
      assert(files.has("import_braingl.py"), "import_braingl.py is missing from the zip");
      return `${file.name}, ${(file.data.length / 1e6).toFixed(1)} MB, layers: ${scene.layers.map((l) => `${l.name} [${l.kind}, ${l.vertices} v]`).join("; ")}`;
    }, { needs: [C1] });

    // ------------------------------------------------- 5. Directionality mounts
    const C5 = "5. Directionality workspace mounts and draws";
    await check(ctx, C5, async () => {
      const mounted = await ev(async () => {
        window.braingl.show("directionality");
        return !!(await window.braingl.directionality());
      });
      assert(mounted, `the workspace did not start (banner: "${await banner()}")`);
      assert(await ev(() => !document.getElementById("ws-directionality").hidden && document.getElementById("ws-glyphs").hidden), "the directionality workspace is not the visible one");
      const size = await settleAndSnap("dir-initial", DIR_CANVAS);
      const st = await ev(() => window.__e2e.stats("dir-initial"));
      assert(!(await banner()), `the error banner is shown: ${await banner()}`);
      assert(st.nonBackground > 0.05 * st.total, `the canvas is (almost) empty: ${st.nonBackground} of ${st.total} px differ from the background`);
      assert(st.coloured > 0.01 * st.total, `nothing coloured is drawn (${st.coloured} px)`);
      const loaded = await ev(() => document.querySelector('#ws-directionality [data-role="loaded-status"]')?.textContent ?? "");
      return `canvas ${size.w}x${size.h}, ${pct(st.nonBackground, st.total)} non-background, ${pct(st.coloured, st.total)} coloured; ${loaded.replace(/\s+/g, " ").trim()}`;
    }, { needs: [C1] });

    // ------------------------------------------------- 6. bridge
    const C6 = "6. bridge: seed map opens in Directionality";
    await check(ctx, C6, async () => {
      // as a user would: from the glyph workspace, with a seed selected
      const sent = await ev(async () => {
        const b = window.braingl;
        b.show("glyphs");
        const surface = b.glyphs.surfaceExport();
        if (!surface) return { error: "surfaceExport() returned null" };
        if (!surface.scalars) return { error: "surfaceExport().scalars is null although a seed is selected" };
        await b.glyphs.hooks.openInDirectionality(surface, "scalars");
        return { name: surface.name, scalarName: surface.scalarName, vertices: surface.positions.length / 3 };
      });
      assert(!sent.error, sent.error);
      await assertNoAppError();
      assert(await ev(() => !document.getElementById("ws-directionality").hidden), "the directionality workspace was not brought to the front");
      await settleAndSnap("dir-bridge", DIR_CANVAS);
      const st = await ev(() => window.__e2e.stats("dir-bridge"));
      const d = await ev(() => window.__e2e.diff("dir-initial", "dir-bridge"));
      const loaded = (await ev(() => document.querySelector('#ws-directionality [data-role="loaded-status"]')?.textContent ?? "")).replace(/\s+/g, " ").trim();
      const stored = await ev(() => { try { return JSON.parse(localStorage.getItem("di-panel-params-v1") ?? "{}").lastDatasetName ?? ""; } catch { return ""; } });
      assert(sent.scalarName.includes(String(SEED_NODE)), `the exported map is "${sent.scalarName}"`);
      assert(loaded.includes(sent.scalarName), `the Directionality panel does not name the new dataset: "${loaded}"`);
      assert(stored.includes(sent.scalarName), `the stored dataset name is "${stored}"`);
      assert(st.nonBackground > 0.05 * st.total && st.coloured > 0.01 * st.total, `the new dataset is not drawn (${st.nonBackground} non-background, ${st.coloured} coloured of ${st.total} px)`);
      assert(d.changed > 0.03 * d.total, `the picture hardly changed: ${d.changed} of ${d.total} px differ from the bundled dataset`);
      return `"${sent.name} — ${sent.scalarName}" (${sent.vertices} vertices): ${pct(d.changed, d.total)} of the pixels changed, ${pct(st.coloured, st.total)} coloured`;
    }, { needs: [C5, C3] });

    // ------------------------------------------------- 8. view survives a reload
    await check(ctx, "8. view (surface, camera, glyph style) is restored after a reload", async () => {
      const view = () => ev(() => {
        const g = window.braingl.glyphs;
        const cam = g.cams?.[0]?.getState?.();
        return { surface: g.ds.surfaces[g.params.surface].name, glyphStyle: g.params.glyphStyle, rotation: cam ? Array.from(cam.rotation).map((v) => +v.toFixed(3)).join(",") : "?" };
      });
      const target = await ev(() => {
        const g = window.braingl.glyphs;
        window.braingl.show("glyphs");
        g.setParams({ glyphStyle: "vectors", surface: g.ds.surfaces.findIndex((s, i) => i !== g.params.surface) });
        g.setView("dorsal");
      }).then(view);
      await sleep(600); // the app saves its state 300 ms after the last change
      const stored = await ev(() => Object.keys(localStorage).filter((k) => k.startsWith("braingl.glyphs")));
      await page.goto(url + "?workspace=glyphs", { waitUntil: "load", timeout: opts.timeout });
      await page.waitForFunction(() => !!window.braingl?.glyphs?.ds, { timeout: opts.timeout });
      await ev(installPageHelpers);
      await ev((s) => window.__e2e.settle(s), GLYPH_CANVAS);
      const got = await view();
      await assertNoAppError();
      assert(got.glyphStyle === target.glyphStyle, `glyphStyle is ${got.glyphStyle} after the reload, expected ${target.glyphStyle}`);
      assert(got.surface === target.surface && got.rotation === target.rotation,
        `before the reload: surface ${target.surface}, camera rotation [${target.rotation}]; after: surface ${got.surface}, rotation [${got.rotation}] (localStorage has ${stored.join(", ")})`);
      return `surface ${got.surface}, camera rotation [${got.rotation}], style ${got.glyphStyle}`;
    }, { needs: [C1] });

    // ------------------------------------------------- 4. no errors
    await sleep(300); // let late messages arrive
    await check(ctx, "4. no console errors, page errors or failed requests", async () => {
      assert(problems.length === 0, `${problems.length} problem(s):\n      ` + [...new Set(problems)].slice(0, 20).join("\n      "));
      return "";
    });

    await check(ctx, "10. no WebGL errors in the console", async () => {
      const kinds = [...new Set(glErrors)];
      assert(glErrors.length === 0, `${glErrors.length} WebGL error(s) logged: ${kinds.slice(0, 5).join(" | ")}`);
      return "";
    }, {
      knownBug: "the Directionality workspace calls gl.generateMipmap on its DEPTH_COMPONENT32F depth texture on every frame (src/directionality/gfx/framebuffer.ts, generateMipmaps), which WebGL2 rejects with GL_INVALID_OPERATION",
    });
  } catch (e) {
    failedEarly = e;
  } finally {
    for (const fn of cleanup.reverse()) {
      try { await fn(); } catch { /* best effort */ }
    }
  }

  // ---------------------------------------------------------------- summary
  if (failedEarly) console.error(`\nERROR ${failedEarly instanceof Error ? failedEarly.stack || failedEarly.message : failedEarly}`);
  const by = (s) => results.filter((r) => r.status === s);
  const failed = [...by("FAIL"), ...by("SKIP")];
  console.log("\n" + "-".repeat(72));
  console.log(`${results.length} checks: ${by("PASS").length} passed, ${by("FAIL").length} failed, ${by("SKIP").length} skipped, ${by("KNOWN").length} known bug(s)`);
  const indent = (t) => t.replace(/\n\s*/g, "\n        ");
  for (const r of by("KNOWN")) console.log(`  KNOWN BUG (expected failure): ${r.name}\n        observed: ${indent(r.detail)}\n        cause: ${r.knownBug}`);
  for (const r of failed) console.log(`  ${r.status}: ${r.name}\n        ${indent(r.detail)}`);
  if (problems.length && !failed.some((r) => r.name.startsWith("4."))) console.log(`  (${problems.length} console/network problem(s) were collected)`);
  const ok = !failedEarly && failed.length === 0 && results.length > 0;
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  return ok;
}

const started = Date.now();
let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
}
const ok = await run(opts);
console.log(`total ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(ok ? 0 : 1);
