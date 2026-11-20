import { mat3 } from "gl-matrix";
import { Camera } from "../gfx/camera";
import { Program, createBuffer, createLutTexture, createPositionTexture, createRowTexture, updateLutTexture } from "../gfx/gl";
import type { GlyphDataset } from "../data/dataset";
import { computeNormals, normaliseSulc } from "../data/dataset";
import { CONNEXEL_STRIDE, DIFF_STRIDE } from "../glyphs/builders";
import { SHADERS } from "./shaders";

export type GlyphStyle = "points" | "vectors" | "pies" | "diffpoints" | "off";

export interface Viewport { x: number; y: number; w: number; h: number }

/** Everything the draw call needs; derived from the UI parameters by the app. */
export interface DrawState {
  surface: number;
  glyphSurface: number;
  colorSurface: number;
  lengthSurface: number;
  sphereSurface: number; // -1 if the dataset has no spherical representation
  sphereCenterL: [number, number, number];
  sphereCenterR: [number, number, number];
  geometryMode: 0 | 1;
  glyphStyle: GlyphStyle;
  showSurface: boolean;
  showGlyphs: boolean;
  showLittleBrains: boolean;
  showSegments: boolean;
  hemi: 0 | 1 | 2;
  radius: number;
  primSize: number; // device pixels
  roundPoints: boolean;
  normalization: number;
  glyphAlpha: number;
  glyphRot: mat3;
  depthOffset: number; // mm
  threshold: number;
  maxThreshold: number;
  minLength: number;
  sign: 0 | 1 | 2;
  colorMode: 0 | 1;
  cmin: number;
  cmax: number;
  baseColor: [number, number, number];
  useSulc: boolean;
  showScalar: boolean;
  /** which per-node values are colour-mapped: the seed-based connectivity row or the selected overlay */
  scalarSource: "seed" | "overlay";
  scalarLower: number;
  scalarMin: number;
  scalarMax: number;
  showPaint: boolean;
  surfaceAlpha: number;
  lbColorMode: 0 | 1 | 2;
  lbColor: [number, number, number];
  background: [number, number, number];
  lineWidth: number; // device pixels
  segmentAlpha: number;
  cursorNode: number;
  cursorSize: number; // device pixels
  cursorColor: [number, number, number, number];
}

interface SurfaceGL {
  posTex: WebGLTexture;
  posBuf: WebGLBuffer;
  normalBuf: WebGLBuffer;
  surfaceVao: WebGLVertexArrayObject | null;
  littleVao: WebGLVertexArrayObject | null;
}

/**
 * Owns all GPU resources of one glyph dataset and draws it into any number of
 * viewports (brainGL's "main gl" and "main gl 2" share one context here).
 */
export class GlyphRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: Record<keyof typeof SHADERS, Program>;
  private ds: GlyphDataset | null = null;
  private surfaces: SurfaceGL[] = [];
  private indexBuf: WebGLBuffer | null = null;
  private scalarBuf: WebGLBuffer | null = null;
  private overlayBuf: WebGLBuffer | null = null;
  private sulcBuf: WebGLBuffer | null = null;
  private paintBuf: WebGLBuffer | null = null;
  private readonly quadBuf: WebGLBuffer;
  private readonly triCornerBuf: WebGLBuffer;
  private lut: WebGLTexture;

  // glyph buffers
  private conBuf: WebGLBuffer | null = null;
  private conCount = 0;
  private pointsVao: WebGLVertexArrayObject | null = null;
  private vectorsVao: WebGLVertexArrayObject | null = null;
  private pieBuf: WebGLBuffer | null = null;
  private rankBuf: WebGLBuffer | null = null;
  private pieCount = 0;
  private pieMaxCount = 1;
  private piesVao: WebGLVertexArrayObject | null = null;
  private diffBuf: WebGLBuffer | null = null;
  private diffCount = 0;
  private diffVao: WebGLVertexArrayObject | null = null;
  // little brains
  private lbNodeBuf: WebGLBuffer | null = null;
  private lbCount = 0;
  private lbRows: WebGLTexture | null = null;
  // segments
  private segBuf: WebGLBuffer | null = null;
  private segCount = 0;
  private segVao: WebGLVertexArrayObject | null = null;
  private readonly markerVao: WebGLVertexArrayObject;

  readonly maxTextureSize: number;
  readonly maxPointSize: number;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const p = {} as Record<keyof typeof SHADERS, Program>;
    for (const k of Object.keys(SHADERS) as (keyof typeof SHADERS)[]) {
      p[k] = new Program(gl, SHADERS[k][0], SHADERS[k][1], k);
    }
    this.prog = p;
    this.quadBuf = createBuffer(gl, gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]));
    this.triCornerBuf = createBuffer(gl, gl.ARRAY_BUFFER, new Float32Array([0, 1, 2]));
    const grey = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) grey.set([i, i, i, 255], 4 * i);
    this.lut = createLutTexture(gl, grey);
    this.markerVao = gl.createVertexArray()!;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.maxPointSize = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1];
  }

  // ------------------------------------------------------------------ dataset

  setDataset(ds: GlyphDataset): void {
    const gl = this.gl;
    this.disposeDataset();
    this.ds = ds;
    this.surfaces = ds.surfaces.map((s) => ({
      posTex: createPositionTexture(gl, s.positions),
      posBuf: createBuffer(gl, gl.ARRAY_BUFFER, s.positions),
      normalBuf: createBuffer(gl, gl.ARRAY_BUFFER, computeNormals(s.positions, ds.triangles)),
      surfaceVao: null,
      littleVao: null,
    }));
    this.indexBuf = createBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, ds.triangles);
    this.scalarBuf = createBuffer(gl, gl.ARRAY_BUFFER, new Float32Array(ds.n), gl.DYNAMIC_DRAW);
    this.overlayBuf = createBuffer(gl, gl.ARRAY_BUFFER, new Float32Array(ds.n), gl.DYNAMIC_DRAW);
    const sulc = ds.overlays.find((o) => o.name.toLowerCase().includes("sulc")) ?? ds.overlays.find((o) => o.name.toLowerCase().includes("curv"));
    this.sulcBuf = createBuffer(gl, gl.ARRAY_BUFFER, sulc ? normaliseSulc(sulc.data) : new Float32Array(ds.n));
    this.paintBuf = createBuffer(gl, gl.ARRAY_BUFFER, new Uint8Array(ds.n * 4), gl.DYNAMIC_DRAW);
    this.lbNodeBuf = createBuffer(gl, gl.ARRAY_BUFFER, new Uint32Array(1), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  get hasSulc(): boolean {
    return !!this.ds?.overlays.some((o) => /sulc|curv/i.test(o.name));
  }

  private disposeDataset(): void {
    const gl = this.gl;
    for (const s of this.surfaces) {
      gl.deleteTexture(s.posTex); gl.deleteBuffer(s.posBuf); gl.deleteBuffer(s.normalBuf);
      if (s.surfaceVao) gl.deleteVertexArray(s.surfaceVao);
      if (s.littleVao) gl.deleteVertexArray(s.littleVao);
    }
    this.surfaces = [];
    for (const b of [this.indexBuf, this.scalarBuf, this.overlayBuf, this.sulcBuf, this.paintBuf, this.conBuf, this.pieBuf, this.rankBuf, this.diffBuf, this.lbNodeBuf, this.segBuf]) {
      if (b) gl.deleteBuffer(b);
    }
    for (const v of [this.pointsVao, this.vectorsVao, this.piesVao, this.diffVao, this.segVao]) if (v) gl.deleteVertexArray(v);
    if (this.lbRows) gl.deleteTexture(this.lbRows);
    this.indexBuf = this.scalarBuf = this.overlayBuf = this.sulcBuf = this.paintBuf = this.conBuf = this.pieBuf = this.rankBuf = this.diffBuf = this.lbNodeBuf = this.segBuf = null;
    this.pointsVao = this.vectorsVao = this.piesVao = this.diffVao = this.segVao = null;
    this.lbRows = null;
    this.conCount = this.pieCount = this.diffCount = this.lbCount = this.segCount = 0;
  }

  setScalars(values: Float32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.scalarBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, values);
  }

  setOverlay(values: Float32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, values);
  }

  setPaint(rgba: Uint8Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.paintBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, rgba);
  }

  setLut(rgba: Uint8Array): void {
    updateLutTexture(this.gl, this.lut, rgba);
  }

  // ------------------------------------------------------------------- glyphs

  private connexelAttribs(buf: WebGLBuffer): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 2, gl.UNSIGNED_SHORT, CONNEXEL_STRIDE, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.SHORT, true, CONNEXEL_STRIDE, 4);
    gl.vertexAttribDivisor(1, 1);
  }

  /** Connexels (8 bytes each) for point and vector glyphs. */
  setConnexels(data: ArrayBuffer, count: number): void {
    const gl = this.gl;
    if (this.conBuf) gl.deleteBuffer(this.conBuf);
    if (this.pointsVao) gl.deleteVertexArray(this.pointsVao);
    if (this.vectorsVao) gl.deleteVertexArray(this.vectorsVao);
    this.conBuf = createBuffer(gl, gl.ARRAY_BUFFER, data);
    this.conCount = count;

    this.pointsVao = gl.createVertexArray();
    gl.bindVertexArray(this.pointsVao);
    this.connexelAttribs(this.conBuf);

    this.vectorsVao = gl.createVertexArray();
    gl.bindVertexArray(this.vectorsVao);
    this.connexelAttribs(this.conBuf);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Hue/value-sorted connexels plus per-slice (rank, count). */
  setPies(data: ArrayBuffer, count: number, ranks: Uint16Array, maxCount: number): void {
    const gl = this.gl;
    if (this.pieBuf) gl.deleteBuffer(this.pieBuf);
    if (this.rankBuf) gl.deleteBuffer(this.rankBuf);
    if (this.piesVao) gl.deleteVertexArray(this.piesVao);
    this.pieBuf = createBuffer(gl, gl.ARRAY_BUFFER, data);
    this.rankBuf = createBuffer(gl, gl.ARRAY_BUFFER, ranks, gl.DYNAMIC_DRAW);
    this.pieCount = count;
    this.pieMaxCount = Math.max(1, maxCount);
    this.piesVao = gl.createVertexArray();
    gl.bindVertexArray(this.piesVao);
    this.connexelAttribs(this.pieBuf);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rankBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 2, gl.UNSIGNED_SHORT, 4, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triCornerBuf);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  setPieRanks(ranks: Uint16Array, maxCount: number): void {
    const gl = this.gl;
    if (!this.rankBuf) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rankBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, ranks);
    this.pieMaxCount = Math.max(1, maxCount);
  }

  setDiff(data: ArrayBuffer, count: number): void {
    const gl = this.gl;
    if (this.diffBuf) gl.deleteBuffer(this.diffBuf);
    if (this.diffVao) gl.deleteVertexArray(this.diffVao);
    this.diffBuf = createBuffer(gl, gl.ARRAY_BUFFER, data);
    this.diffCount = count;
    this.diffVao = gl.createVertexArray();
    gl.bindVertexArray(this.diffVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_SHORT, DIFF_STRIDE, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.SHORT, true, DIFF_STRIDE, 8);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  /** Nodes that get an anatomical background glyph; rows = their raw connectivity (n values each) or null. */
  setLittleBrains(nodes: Uint32Array, rows: Int16Array | null): void {
    const gl = this.gl;
    if (!this.ds || !this.lbNodeBuf) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lbNodeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, nodes.length ? nodes : new Uint32Array(1), gl.DYNAMIC_DRAW);
    this.lbCount = nodes.length;
    if (this.lbRows) gl.deleteTexture(this.lbRows);
    this.lbRows = null;
    if (rows && nodes.length && this.ds.n <= this.maxTextureSize && nodes.length <= this.maxTextureSize) {
      this.lbRows = createRowTexture(gl, this.ds.n, nodes.length, rows);
    }
  }

  get littleBrainCount(): number { return this.lbCount; }

  /** Line segments: 28 bytes each (p0 xyz, p1 xyz as float32, rgba8). */
  setSegments(data: ArrayBuffer | null, count: number): void {
    const gl = this.gl;
    if (this.segBuf) gl.deleteBuffer(this.segBuf);
    if (this.segVao) gl.deleteVertexArray(this.segVao);
    this.segBuf = null; this.segVao = null; this.segCount = 0;
    if (!data || !count) return;
    this.segBuf = createBuffer(gl, gl.ARRAY_BUFFER, data);
    this.segCount = count;
    this.segVao = gl.createVertexArray();
    gl.bindVertexArray(this.segVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 28, 24);
    gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  // ------------------------------------------------------------------ drawing

  private surfaceVao(idx: number): WebGLVertexArrayObject {
    const gl = this.gl;
    const s = this.surfaces[idx];
    if (!s.surfaceVao) {
      s.surfaceVao = gl.createVertexArray();
      gl.bindVertexArray(s.surfaceVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.posBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.normalBuf);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.scalarBuf);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sulcBuf);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.paintBuf);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf);
      gl.bindVertexArray(null);
    }
    return s.surfaceVao!;
  }

  private littleVao(idx: number): WebGLVertexArrayObject {
    const gl = this.gl;
    const s = this.surfaces[idx];
    if (!s.littleVao) {
      s.littleVao = gl.createVertexArray();
      gl.bindVertexArray(s.littleVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.posBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.normalBuf);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sulcBuf);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lbNodeBuf);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 0, 0);
      gl.vertexAttribDivisor(3, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf);
      gl.bindVertexArray(null);
    }
    return s.littleVao!;
  }

  private glyphUniforms(p: Program, cam: Camera, s: DrawState, vp: Viewport): void {
    const ds = this.ds!;
    p.use();
    p.m4("u_view", cam.view as Float32Array);
    p.m4("u_proj", cam.proj as Float32Array);
    p.tex("u_posDisplay", 0, this.surfaces[s.surface].posTex);
    p.tex("u_posGlyph", 1, this.surfaces[s.glyphSurface].posTex);
    p.tex("u_posColor", 2, this.surfaces[s.colorSurface].posTex);
    p.tex("u_posLength", 3, this.surfaces[s.lengthSurface].posTex);
    p.tex("u_posSphere", 4, this.surfaces[s.sphereSurface >= 0 ? s.sphereSurface : s.glyphSurface].posTex);
    p.tex("u_lut", 5, this.lut);
    p.v3("u_sphereCenterL", s.sphereCenterL);
    p.v3("u_sphereCenterR", s.sphereCenterR);
    p.u("u_leftNodes", ds.leftNodes > 0 && ds.leftNodes < ds.n ? ds.leftNodes : 0);
    p.i("u_geometryMode", s.sphereSurface >= 0 ? s.geometryMode : 0);
    p.m3("u_glyphRot", s.glyphRot as Float32Array);
    p.f("u_radius", s.radius);
    p.f("u_depthOffset", s.depthOffset);
    p.f("u_primBias", s.showLittleBrains && this.lbCount > 0 ? s.depthOffset * 0.15 + 0.2 : 0);
    p.f("u_valueScale", ds.conn.maxAbs);
    p.f("u_threshold", s.threshold);
    p.f("u_maxThreshold", s.maxThreshold);
    p.f("u_minLength", s.minLength);
    p.i("u_sign", s.sign);
    p.i("u_colorMode", s.colorMode);
    p.f("u_cmin", s.cmin);
    p.f("u_cmax", s.cmax === s.cmin ? s.cmin + 1e-6 : s.cmax);
    p.f("u_alphaExp", 10 * (1 - s.glyphAlpha));
    p.f("u_alphaRef", Math.max(1, ds.conn.maxAbs));
    p.f("u_pointSize", Math.min(s.primSize, this.maxPointSize));
    p.f("u_lineWidth", s.primSize);
    p.v2("u_viewport", vp.w, vp.h);
    p.i("u_roundPoints", 0);
  }

  private drawSurface(cam: Camera, s: DrawState): void {
    const gl = this.gl;
    const ds = this.ds!;
    const p = this.prog.surface;
    p.use();
    p.m4("u_view", cam.view as Float32Array);
    p.m4("u_proj", cam.proj as Float32Array);
    p.v3("u_baseColor", s.baseColor);
    p.i("u_useSulc", s.useSulc ? 1 : 0);
    p.i("u_showScalar", s.showScalar ? 1 : 0);
    p.tex("u_lut", 5, this.lut);
    p.f("u_cmin", s.scalarMin);
    p.f("u_cmax", s.scalarMax === s.scalarMin ? s.scalarMin + 1e-6 : s.scalarMax);
    p.f("u_lower", s.scalarLower);
    p.i("u_showPaint", s.showPaint ? 1 : 0);
    p.f("u_alpha", s.surfaceAlpha);
    p.f("u_ambient", 0.32);
    p.f("u_diffuse", 0.72);
    p.f("u_specular", 0.06);
    gl.bindVertexArray(this.surfaceVao(s.surface));
    gl.bindBuffer(gl.ARRAY_BUFFER, s.scalarSource === "overlay" ? this.overlayBuf : this.scalarBuf);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
    const split = ds.leftTriangles > 0 && ds.leftTriangles * 3 < ds.triangles.length ? ds.leftTriangles * 3 : 0;
    let first = 0, count = ds.triangles.length;
    if (split && s.hemi === 1) count = split;
    if (split && s.hemi === 2) { first = split; count = ds.triangles.length - split; }
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, first * 4);
  }

  draw(vp: Viewport, cam: Camera, s: DrawState, clear = true): void {
    const gl = this.gl;
    gl.viewport(vp.x, vp.y, vp.w, vp.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vp.x, vp.y, vp.w, vp.h);
    if (clear) {
      gl.clearColor(s.background[0], s.background[1], s.background[2], 1);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    if (!this.ds) { gl.disable(gl.SCISSOR_TEST); return; }
    cam.update(vp.w / vp.h);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    const opaqueSurface = s.surfaceAlpha >= 0.995;
    if (s.showSurface && opaqueSurface) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      this.drawSurface(cam, s);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    // anatomical background glyphs
    if (s.showGlyphs && s.showLittleBrains && this.lbCount > 0 && s.geometryMode === 0) {
      const p = this.prog.little;
      this.glyphUniforms(p, cam, s, vp);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, this.lbRows);
      p.i("u_rows", 6);
      p.i("u_hasRows", this.lbRows ? 1 : 0);
      p.i("u_lbColorMode", s.lbColorMode);
      p.v3("u_lbColor", s.lbColor);
      gl.bindVertexArray(this.littleVao(s.glyphSurface));
      gl.drawElementsInstanced(gl.TRIANGLES, this.ds.triangles.length, gl.UNSIGNED_INT, 0, this.lbCount);
    }

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (s.showSegments && this.segCount > 0 && this.segVao) {
      const p = this.prog.segments;
      p.use();
      p.m4("u_view", cam.view as Float32Array);
      p.m4("u_proj", cam.proj as Float32Array);
      p.f("u_lineWidth", s.lineWidth);
      p.v2("u_viewport", vp.w, vp.h);
      p.f("u_alpha", s.segmentAlpha);
      p.i("u_roundPoints", 0);
      gl.depthMask(s.segmentAlpha >= 0.995);
      gl.bindVertexArray(this.segVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.segCount);
      gl.depthMask(true);
    }

    if (s.showGlyphs && s.glyphStyle !== "off") {
      gl.depthMask(s.glyphAlpha >= 0.995);
      if (s.glyphStyle === "points" && this.pointsVao && this.conCount) {
        const p = this.prog.points;
        this.glyphUniforms(p, cam, s, vp);
        p.i("u_roundPoints", s.roundPoints && s.primSize >= 3 ? 1 : 0);
        gl.bindVertexArray(this.pointsVao);
        gl.drawArraysInstanced(gl.POINTS, 0, 1, this.conCount);
      } else if (s.glyphStyle === "vectors" && this.vectorsVao && this.conCount) {
        const p = this.prog.vectors;
        this.glyphUniforms(p, cam, s, vp);
        gl.bindVertexArray(this.vectorsVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.conCount);
      } else if (s.glyphStyle === "pies" && this.piesVao && this.pieCount) {
        const p = this.prog.pies;
        this.glyphUniforms(p, cam, s, vp);
        p.f("u_normalization", s.normalization);
        p.f("u_maxCount", this.pieMaxCount);
        gl.depthMask(true);
        gl.bindVertexArray(this.piesVao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, this.pieCount);
      } else if (s.glyphStyle === "diffpoints" && this.diffVao && this.diffCount) {
        const p = this.prog.diff;
        this.glyphUniforms(p, cam, s, vp);
        p.i("u_roundPoints", s.roundPoints && s.primSize >= 3 ? 1 : 0);
        p.i("u_fisher", this.ds.conn.maxAbs <= 1.0001 ? 1 : 0);
        gl.bindVertexArray(this.diffVao);
        gl.drawArraysInstanced(gl.POINTS, 0, 1, this.diffCount);
      }
      gl.depthMask(true);
    }

    if (s.showSurface && !opaqueSurface) {
      gl.depthMask(false);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.FRONT);
      this.drawSurface(cam, s);
      gl.cullFace(gl.BACK);
      this.drawSurface(cam, s);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(true);
    }

    if (s.cursorNode >= 0 && s.cursorNode < this.ds.n) {
      const pos = this.ds.surfaces[s.surface].positions;
      const p = this.prog.marker;
      p.use();
      p.m4("u_view", cam.view as Float32Array);
      p.m4("u_proj", cam.proj as Float32Array);
      p.v3("u_pos", [pos[3 * s.cursorNode], pos[3 * s.cursorNode + 1], pos[3 * s.cursorNode + 2]]);
      p.f("u_size", Math.min(s.cursorSize, this.maxPointSize));
      p.v4("u_color", s.cursorColor);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(this.markerVao);
      gl.drawArrays(gl.POINTS, 0, 1);
      gl.enable(gl.DEPTH_TEST);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
  }
}
