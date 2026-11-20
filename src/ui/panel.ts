/**
 * A small declarative side panel: collapsible sections of sliders, selects,
 * checkboxes, colour pickers and buttons bound to the fields of a parameter
 * object. Used by every workspace of the app, so the workspaces look and behave
 * alike.
 */
export interface ControlOptions {
  tip?: string;
  /** hide the control unless this returns true (re-evaluated on every refresh) */
  visible?: () => boolean;
}

export interface SliderOptions extends ControlOptions {
  min: number;
  /** may depend on the loaded data */
  max: number | (() => number);
  step: number;
  digits?: number;
  /** fire onChange only when the slider is released (for expensive work) */
  lazy?: boolean;
}

interface Control {
  row: HTMLElement;
  refresh: () => void;
  visible?: () => boolean;
}

export class Panel<P extends object> {
  readonly el: HTMLElement;
  private readonly controls: Control[] = [];
  private readonly collapsed: Record<string, boolean>;

  constructor(
    host: HTMLElement,
    readonly params: P,
    private readonly onChange: (key: keyof P) => void,
    private readonly storageKey: string,
    title: string,
  ) {
    this.el = document.createElement("div");
    this.el.className = "panel";
    const bar = document.createElement("div");
    bar.className = "panel-titlebar";
    bar.innerHTML = `<span class="panel-title"></span>`;
    (bar.firstChild as HTMLElement).textContent = title;
    this.el.appendChild(bar);
    host.appendChild(this.el);
    let c: Record<string, boolean> = {};
    try { c = JSON.parse(localStorage.getItem(storageKey + ".collapsed") ?? "{}"); } catch { /* ignore */ }
    this.collapsed = c;
  }

  section(title: string, startCollapsed = false): Section<P> {
    return new Section<P>(this, title, this.collapsed[title] ?? startCollapsed);
  }

  /** @internal */
  setCollapsed(title: string, v: boolean): void {
    this.collapsed[title] = v;
    try { localStorage.setItem(this.storageKey + ".collapsed", JSON.stringify(this.collapsed)); } catch { /* ignore */ }
  }

  /** @internal */
  register(c: Control): void { this.controls.push(c); }

  /** @internal */
  changed(key: keyof P): void {
    this.onChange(key);
    this.refreshVisibility();
  }

  /** Re-read every control from the parameter object (after programmatic changes). */
  refresh(): void {
    for (const c of this.controls) c.refresh();
    this.refreshVisibility();
  }

  refreshVisibility(): void {
    for (const c of this.controls) if (c.visible) c.row.style.display = c.visible() ? "" : "none";
  }
}

export class Section<P extends object> {
  readonly body: HTMLElement;

  constructor(private readonly panel: Panel<P>, title: string, collapsed: boolean) {
    const sec = document.createElement("section");
    sec.className = "panel-section" + (collapsed ? " collapsed" : "");
    const head = document.createElement("button");
    head.className = "panel-heading";
    head.type = "button";
    head.innerHTML = `<span class="panel-heading-caret">▾</span><span class="panel-heading-title"></span>`;
    (head.lastChild as HTMLElement).textContent = title;
    head.addEventListener("click", () => {
      const c = !sec.classList.contains("collapsed");
      sec.classList.toggle("collapsed", c);
      panel.setCollapsed(title, c);
    });
    this.body = document.createElement("div");
    this.body.className = "panel-section-body";
    sec.append(head, this.body);
    panel.el.appendChild(sec);
  }

  private row(label: string | null, opt?: ControlOptions): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";
    if (opt?.tip) row.title = opt.tip;
    if (label !== null) {
      const l = document.createElement("label");
      l.className = "row-label";
      l.textContent = label;
      row.appendChild(l);
    }
    this.body.appendChild(row);
    return row;
  }

  slider(key: keyof P, label: string, opt: SliderOptions): this {
    const p = this.panel.params as Record<keyof P, unknown>;
    const row = this.row(label, opt);
    row.classList.add("row-slider");
    const digits = opt.digits ?? Math.max(0, Math.ceil(-Math.log10(opt.step)));
    const val = document.createElement("input");
    const max = () => (typeof opt.max === "function" ? opt.max() : opt.max);
    val.type = "number"; val.className = "row-value"; val.step = String(opt.step); val.min = String(opt.min);
    const range = document.createElement("input");
    range.type = "range"; range.min = String(opt.min); range.step = String(opt.step);
    const show = () => {
      range.max = val.max = String(max());
      range.value = String(p[key]);
      val.value = Number(p[key]).toFixed(digits);
    };
    const set = (v: number, fire: boolean) => {
      if (!Number.isFinite(v)) return;
      p[key] = Math.min(max(), Math.max(opt.min, v));
      show();
      if (fire) this.panel.changed(key);
    };
    range.addEventListener("input", () => set(Number(range.value), !opt.lazy));
    range.addEventListener("change", () => { if (opt.lazy) this.panel.changed(key); });
    val.addEventListener("change", () => set(Number(val.value), true));
    row.append(val, range);
    show();
    this.panel.register({ row, refresh: show, visible: opt.visible });
    return this;
  }

  select(key: keyof P, label: string, options: () => [string | number, string][], opt?: ControlOptions): this {
    const p = this.panel.params as Record<keyof P, unknown>;
    const row = this.row(label, opt);
    const sel = document.createElement("select");
    let signature = "";
    const fill = () => {
      const o = options();
      const sig = JSON.stringify(o);
      if (sig !== signature) {
        signature = sig;
        sel.replaceChildren(...o.map(([v, text]) => {
          const e = document.createElement("option");
          e.value = String(v); e.textContent = text;
          return e;
        }));
      }
      sel.value = String(p[key]);
    };
    sel.addEventListener("change", () => {
      const o = options().find(([v]) => String(v) === sel.value);
      if (o) { p[key] = o[0]; this.panel.changed(key); }
    });
    row.appendChild(sel);
    fill();
    this.panel.register({ row, refresh: fill, visible: opt?.visible });
    return this;
  }

  checkbox(key: keyof P, label: string, opt?: ControlOptions): this {
    const p = this.panel.params as Record<keyof P, unknown>;
    const row = this.row(null, opt);
    row.classList.add("row-check");
    const l = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const show = () => { cb.checked = !!p[key]; };
    cb.addEventListener("change", () => { p[key] = cb.checked; this.panel.changed(key); });
    const span = document.createElement("span");
    span.textContent = label;
    l.append(cb, span);
    row.appendChild(l);
    show();
    this.panel.register({ row, refresh: show, visible: opt?.visible });
    return this;
  }

  color(key: keyof P, label: string, opt?: ControlOptions): this {
    const p = this.panel.params as Record<keyof P, unknown>;
    const row = this.row(label, opt);
    const c = document.createElement("input");
    c.type = "color";
    const show = () => { c.value = String(p[key]); };
    c.addEventListener("input", () => { p[key] = c.value; this.panel.changed(key); });
    row.appendChild(c);
    show();
    this.panel.register({ row, refresh: show, visible: opt?.visible });
    return this;
  }

  /** A row of buttons. `active` marks toggle-style buttons. */
  buttons(items: { label: string; onClick: () => void; tip?: string; active?: () => boolean; primary?: boolean }[], opt?: ControlOptions): this {
    const row = this.row(null, opt);
    row.classList.add("row-buttons");
    const els = items.map((it) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn" + (it.primary ? " btn-primary" : "");
      b.textContent = it.label;
      if (it.tip) b.title = it.tip;
      b.addEventListener("click", () => { it.onClick(); this.panel.refresh(); });
      row.appendChild(b);
      return b;
    });
    const refresh = () => items.forEach((it, i) => els[i].classList.toggle("active", !!it.active?.()));
    refresh();
    this.panel.register({ row, refresh, visible: opt?.visible });
    return this;
  }

  /** Free text that is recomputed on every refresh. */
  note(text: () => string, opt?: ControlOptions): this {
    const row = this.row(null, opt);
    row.classList.add("row-note");
    const refresh = () => { row.innerHTML = text(); };
    refresh();
    this.panel.register({ row, refresh, visible: opt?.visible });
    return this;
  }

  custom(el: HTMLElement, opt?: ControlOptions & { refresh?: () => void }): this {
    const row = this.row(null, opt);
    row.appendChild(el);
    this.panel.register({ row, refresh: opt?.refresh ?? (() => {}), visible: opt?.visible });
    return this;
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
