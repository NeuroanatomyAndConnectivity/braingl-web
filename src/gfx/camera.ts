import { mat3, mat4, quat, vec3 } from "gl-matrix";

/**
 * Orthographic trackball camera in anatomical (RAS, millimetre) coordinates:
 * +x = right, +y = anterior, +z = superior. brainGL's main views are
 * orthographic as well, which is what makes screen-facing glyphs (pies,
 * polar projections) directly comparable across the surface.
 */
export type CanonicalView = "left" | "right" | "anterior" | "posterior" | "dorsal" | "ventral";

export interface CameraState {
  rotation: [number, number, number, number];
  target: [number, number, number];
  halfHeight: number;
}

export class Camera {
  rotation = quat.create(); // world -> view
  target = vec3.create();
  halfHeight = 100; // half of the visible world height (mm)
  sceneRadius = 150; // for near/far planes
  aspect = 1;

  readonly view = mat4.create();
  readonly proj = mat4.create();
  readonly viewRot = mat3.create();

  constructor() {
    this.setView("left");
  }

  update(aspect: number): void {
    this.aspect = aspect;
    const r = mat4.fromQuat(mat4.create(), this.rotation);
    const depth = this.sceneRadius * 4 + 100;
    mat4.identity(this.view);
    mat4.translate(this.view, this.view, [0, 0, -depth]);
    mat4.multiply(this.view, this.view, r);
    mat4.translate(this.view, this.view, vec3.negate(vec3.create(), this.target));
    mat4.ortho(this.proj, -this.halfHeight * aspect, this.halfHeight * aspect, -this.halfHeight, this.halfHeight, 1, depth * 2);
    mat3.fromMat4(this.viewRot, this.view);
  }

  /** Fit the scene: centre the target and choose the zoom so that `radius` fills the view. */
  frame(center: ArrayLike<number>, radius: number): void {
    vec3.set(this.target, center[0], center[1], center[2]);
    this.sceneRadius = radius;
    this.halfHeight = radius * 1.05;
  }

  setView(v: CanonicalView): void {
    // (toward-viewer axis, up axis) in world coordinates
    const axes: Record<CanonicalView, [vec3, vec3]> = {
      left: [[-1, 0, 0], [0, 0, 1]],
      right: [[1, 0, 0], [0, 0, 1]],
      anterior: [[0, 1, 0], [0, 0, 1]],
      posterior: [[0, -1, 0], [0, 0, 1]],
      dorsal: [[0, 0, 1], [0, 1, 0]],
      ventral: [[0, 0, -1], [0, 1, 0]],
    };
    const [toward, up] = axes[v];
    const right = vec3.cross(vec3.create(), up, toward);
    // rows of the world->view rotation are right, up, toward; gl-matrix is column-major
    const m = mat3.fromValues(right[0], up[0], toward[0], right[1], up[1], toward[1], right[2], up[2], toward[2]);
    quat.fromMat3(this.rotation, m);
    quat.normalize(this.rotation, this.rotation);
  }

  /** Trackball rotation from a pointer drag given in pixels. */
  rotate(dxPx: number, dyPx: number, viewportHeightPx: number): void {
    const k = Math.PI / viewportHeightPx;
    const q = quat.create();
    quat.rotateX(q, q, dyPx * k);
    quat.rotateY(q, q, dxPx * k);
    quat.multiply(this.rotation, q, this.rotation);
    quat.normalize(this.rotation, this.rotation);
  }

  /** Roll around the viewing axis. */
  roll(angle: number): void {
    const q = quat.setAxisAngle(quat.create(), [0, 0, 1], angle);
    quat.multiply(this.rotation, q, this.rotation);
    quat.normalize(this.rotation, this.rotation);
  }

  pan(dxPx: number, dyPx: number, viewportHeightPx: number): void {
    const s = (2 * this.halfHeight) / viewportHeightPx;
    const inv = quat.invert(quat.create(), this.rotation);
    const d = vec3.transformQuat(vec3.create(), [-dxPx * s, dyPx * s, 0], inv);
    vec3.add(this.target, this.target, d);
  }

  /** Zoom keeping the world point under the cursor fixed. ndc in [-1, 1]. */
  zoom(factor: number, ndcX = 0, ndcY = 0): void {
    const before = this.halfHeight;
    this.halfHeight = Math.min(Math.max(before * factor, this.sceneRadius * 0.004), this.sceneRadius * 8);
    const d = before - this.halfHeight;
    const inv = quat.invert(quat.create(), this.rotation);
    const shift = vec3.transformQuat(vec3.create(), [ndcX * this.aspect * d, ndcY * d, 0], inv);
    vec3.add(this.target, this.target, shift);
  }

  /** World-space ray through a point given in normalised device coordinates. */
  ray(ndcX: number, ndcY: number): { origin: vec3; dir: vec3 } {
    const inv = quat.invert(quat.create(), this.rotation);
    const big = this.sceneRadius * 4 + 100;
    const o = vec3.transformQuat(vec3.create(), [ndcX * this.aspect * this.halfHeight, ndcY * this.halfHeight, big], inv);
    vec3.add(o, o, this.target);
    const dir = vec3.transformQuat(vec3.create(), [0, 0, -1], inv);
    return { origin: o, dir };
  }

  /** Millimetres per pixel at the current zoom. */
  mmPerPixel(viewportHeightPx: number): number {
    return (2 * this.halfHeight) / viewportHeightPx;
  }

  getState(): CameraState {
    return {
      rotation: [this.rotation[0], this.rotation[1], this.rotation[2], this.rotation[3]],
      target: [this.target[0], this.target[1], this.target[2]],
      halfHeight: this.halfHeight,
    };
  }

  setState(s: CameraState): void {
    quat.set(this.rotation, s.rotation[0], s.rotation[1], s.rotation[2], s.rotation[3]);
    quat.normalize(this.rotation, this.rotation);
    vec3.set(this.target, s.target[0], s.target[1], s.target[2]);
    this.halfHeight = s.halfHeight;
  }
}
