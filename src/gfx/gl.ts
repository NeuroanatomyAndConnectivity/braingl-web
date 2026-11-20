/** Thin WebGL2 helpers: shader programs with cached uniform lookups, data textures. */

export class Program {
  readonly handle: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(private readonly gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string, label = "program") {
    const vs = compile(gl, gl.VERTEX_SHADER, vertSrc, `${label}.vert`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc, `${label}.frag`);
    const p = gl.createProgram();
    if (!p) throw new Error("createProgram failed");
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`Link failed (${label}): ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.handle = p;
  }

  use(): void {
    this.gl.useProgram(this.handle);
  }

  loc(name: string): WebGLUniformLocation | null {
    let l = this.uniforms.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.handle, name);
      this.uniforms.set(name, l);
    }
    return l;
  }

  f(name: string, v: number): void { this.gl.uniform1f(this.loc(name), v); }
  i(name: string, v: number): void { this.gl.uniform1i(this.loc(name), v); }
  u(name: string, v: number): void { this.gl.uniform1ui(this.loc(name), v); }
  v2(name: string, x: number, y: number): void { this.gl.uniform2f(this.loc(name), x, y); }
  v3(name: string, v: ArrayLike<number>): void { this.gl.uniform3f(this.loc(name), v[0], v[1], v[2]); }
  v4(name: string, v: ArrayLike<number>): void { this.gl.uniform4f(this.loc(name), v[0], v[1], v[2], v[3]); }
  m3(name: string, m: Float32Array | number[]): void { this.gl.uniformMatrix3fv(this.loc(name), false, m as Float32Array); }
  m4(name: string, m: Float32Array | number[]): void { this.gl.uniformMatrix4fv(this.loc(name), false, m as Float32Array); }

  /** Bind a 2D texture to a unit and point the sampler uniform at it. */
  tex(name: string, unit: number, texture: WebGLTexture | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.loc(name), unit);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error("createShader failed");
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Compile failed (${label}): ${log}`);
  }
  return s;
}

/** Width of the per-node lookup textures; node id -> texel (id % W, id / W). Must match common.glsl. */
export const NODE_TEX_WIDTH = 1024;

function nearestTex(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** Per-node xyz positions as an RGBA32F texture (texelFetch only, so no float-filter extension needed). */
export function createPositionTexture(gl: WebGL2RenderingContext, xyz: Float32Array): WebGLTexture {
  const n = xyz.length / 3;
  const h = Math.max(1, Math.ceil(n / NODE_TEX_WIDTH));
  const data = new Float32Array(NODE_TEX_WIDTH * h * 4);
  for (let i = 0; i < n; i++) {
    data[4 * i] = xyz[3 * i];
    data[4 * i + 1] = xyz[3 * i + 1];
    data[4 * i + 2] = xyz[3 * i + 2];
    data[4 * i + 3] = 1;
  }
  const t = nearestTex(gl);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, NODE_TEX_WIDTH, h, 0, gl.RGBA, gl.FLOAT, data);
  return t;
}

/** 256x1 RGBA8 colour lookup table (linear filtering). */
export function createLutTexture(gl: WebGL2RenderingContext, rgba: Uint8Array): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rgba.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  return t;
}

export function updateLutTexture(gl: WebGL2RenderingContext, t: WebGLTexture, rgba: Uint8Array): void {
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rgba.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
}

/** Rows of signed 16-bit connectivity values (one row per little brain), fetched with texelFetch. */
export function createRowTexture(gl: WebGL2RenderingContext, width: number, rows: number, data: Int16Array): WebGLTexture {
  const t = nearestTex(gl);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, width, rows, 0, gl.RED_INTEGER, gl.SHORT, data);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  return t;
}

export function createBuffer(gl: WebGL2RenderingContext, target: number, data: ArrayBufferView | ArrayBufferLike | null, usage: number = gl.STATIC_DRAW): WebGLBuffer {
  const b = gl.createBuffer();
  if (!b) throw new Error("createBuffer failed");
  gl.bindBuffer(target, b);
  if (data) gl.bufferData(target, data as BufferSource, usage);
  return b;
}
