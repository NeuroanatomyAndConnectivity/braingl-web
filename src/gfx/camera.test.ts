import { describe, it, expect } from "vitest";
import { vec3 } from "gl-matrix";
import { Camera } from "./camera";

function toView(cam: Camera, p: [number, number, number]): vec3 {
  cam.update(1);
  return vec3.transformMat4(vec3.create(), p, cam.view);
}

describe("Camera", () => {
  it("left lateral view puts anterior on the left and superior up", () => {
    const cam = new Camera();
    cam.setView("left");
    const origin = toView(cam, [0, 0, 0]);
    const anterior = toView(cam, [0, 10, 0]);
    const superior = toView(cam, [0, 0, 10]);
    const left = toView(cam, [-10, 0, 0]);
    expect(anterior[0] - origin[0]).toBeCloseTo(-10, 4);
    expect(superior[1] - origin[1]).toBeCloseTo(10, 4);
    expect(left[2] - origin[2]).toBeCloseTo(10, 4); // left side faces the viewer
  });

  it("dorsal view has anterior up and right on the right", () => {
    const cam = new Camera();
    cam.setView("dorsal");
    const o = toView(cam, [0, 0, 0]);
    expect(toView(cam, [0, 10, 0])[1] - o[1]).toBeCloseTo(10, 4);
    expect(toView(cam, [10, 0, 0])[0] - o[0]).toBeCloseTo(10, 4);
  });

  it("ray passes through the target for the centre pixel", () => {
    const cam = new Camera();
    cam.setView("anterior");
    cam.frame([5, 6, 7], 80);
    cam.update(1.5);
    const { origin, dir } = cam.ray(0, 0);
    const t = vec3.dot(vec3.sub(vec3.create(), cam.target, origin), dir);
    const hit = vec3.scaleAndAdd(vec3.create(), origin, dir, t);
    expect(vec3.distance(hit, cam.target)).toBeLessThan(1e-3);
  });

  it("zoom keeps the point under the cursor fixed", () => {
    const cam = new Camera();
    cam.frame([0, 0, 0], 100);
    cam.update(1);
    const a = cam.ray(0.5, 0.25).origin;
    cam.zoom(0.5, 0.5, 0.25);
    cam.update(1);
    const b = cam.ray(0.5, 0.25).origin;
    expect(vec3.distance(a, b)).toBeLessThan(1e-3);
  });
});
