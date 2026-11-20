import { describe, it, expect } from "vitest";
import {
  ALL_FIXTURES, anticorrelated, BLOCK_R, BRAIN_SHAPE, directed, fold, icoBrain, icosphere, icosphereVertexCount, lcg, medialWallNodes,
  octant, singleHemisphere, weighted, withMedialWall,
} from "./fixtures";
import { hemiMesh, hemiSplit } from "./serialise";
import { at, cross, dot, edgeSet, norm, signedVolume6, sub } from "./reference";

describe("lcg", () => {
  it("is deterministic and uniform in [0, 1)", () => {
    const a = lcg(42), b = lcg(42), c = lcg(43);
    const xs = Array.from({ length: 2000 }, () => a());
    expect(Array.from({ length: 2000 }, () => b())).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.47);
    expect(mean).toBeLessThan(0.53);
  });
});

describe.each([0, 1, 2, 3])("icosphere(%i)", (level) => {
  const mesh = icosphere(level);
  const nv = mesh.unit.length / 3, nf = mesh.triangles.length / 3;

  it("has 10 * 4^level + 2 vertices and 20 * 4^level faces", () => {
    expect(nv).toBe(icosphereVertexCount(level));
    expect(nv).toBe([12, 42, 162, 642][level]);
    expect(nf).toBe(20 * 4 ** level);
  });
  it("is a closed manifold: V - E + F = 2 and every edge has two faces", () => {
    const edges = edgeSet(mesh.triangles);
    expect(nv - edges.size + nf).toBe(2);
    expect(edges.size).toBe((3 * nf) / 2);
  });
  it("has unit-length vertices, none of them on a coordinate plane", () => {
    for (let i = 0; i < nv; i++) {
      expect(norm(at(mesh.unit, i))).toBeCloseTo(1, 12);
      for (let k = 0; k < 3; k++) expect(Math.abs(mesh.unit[3 * i + k])).toBeGreaterThan(1e-6);
    }
  });
  it("is wound outward (every face normal points away from the centre)", () => {
    for (let t = 0; t < nf; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => at(mesh.unit, mesh.triangles[3 * t + k]));
      expect(dot(cross(sub(b, a), sub(c, a)), a)).toBeGreaterThan(0);
    }
    // enclosed volume approaches that of the unit sphere from below
    const vol = signedVolume6(mesh.unit, mesh.triangles) / 6;
    expect(vol).toBeGreaterThan(2.5);
    expect(vol).toBeLessThan((4 / 3) * Math.PI);
  });
  it("uses every vertex with valence 5 (twelve times) or 6", () => {
    const valence = new Uint32Array(nv);
    for (const e of edgeSet(mesh.triangles)) for (const v of e.split("-")) valence[Number(v)]++;
    expect(Array.from(valence).filter((v) => v === 5).length).toBe(12);
    expect(Array.from(valence).every((v) => v === 5 || v === 6)).toBe(true);
  });
});

describe("fold", () => {
  it("stays within the documented amplitude", () => {
    const rnd = lcg(7);
    for (let k = 0; k < 5000; k++) {
      const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
      const l = norm(v) || 1;
      const f = fold(v[0] / l, v[1] / l, v[2] / l);
      expect(Math.abs(f - 1)).toBeLessThanOrEqual(BRAIN_SHAPE.foldAmplitude + 1e-12);
    }
  });
});

describe.each(ALL_FIXTURES)("fixture $name", ({ name, make }) => {
  const ds = make();
  const n = ds.n;
  const split = hemiSplit(ds);

  it("is internally consistent", () => {
    expect(ds.name).toBe(name);
    expect(ds.values.length).toBe(n * n);
    expect(ds.conn.n).toBe(n);
    expect(ds.mask.length).toBe(n);
    expect(ds.modules.length).toBe(n);
    expect(ds.unit.length).toBe(3 * n);
    for (const s of ds.surfaces) expect(s.positions.length).toBe(3 * n);
    for (const o of ds.overlays) expect(o.data.length).toBe(n);
    expect(ds.triangles.length % 3).toBe(0);
    expect(Math.max(...ds.triangles)).toBe(n - 1);
    expect(Array.from(ds.surfaces.flatMap((s) => Array.from(s.positions))).every(Number.isFinite)).toBe(true);
  });

  it("has left nodes and left triangles first", () => {
    if (!split.two) {
      expect(ds.leftNodes).toBe(0);
      expect(ds.leftTriangles).toBe(0);
      return;
    }
    expect(ds.leftNodes).toBe(n / 2);
    expect(ds.leftTriangles).toBe(ds.triangles.length / 6);
    expect(Math.max(...ds.triangles.subarray(0, 3 * ds.leftTriangles))).toBe(ds.leftNodes - 1);
    expect(Math.min(...ds.triangles.subarray(3 * ds.leftTriangles))).toBe(ds.leftNodes);
  });

  it("every hemisphere of every surface is a closed, outward-wound manifold (V - E + F = 2)", () => {
    for (let s = 0; s < ds.surfaces.length; s++) {
      for (const right of split.two ? [false, true] : [false]) {
        const m = hemiMesh(ds, s, right);
        const nv = m.positions.length / 3, nf = m.triangles.length / 3;
        expect(nv - edgeSet(m.triangles).size + nf).toBe(2);
        expect(signedVolume6(m.positions, m.triangles)).toBeGreaterThan(0);
      }
    }
  });

  it("has a symmetric matrix whose int16 copy stays within half a quantisation step", () => {
    let worst = 0, asym = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        asym = Math.max(asym, Math.abs(ds.values[i * n + j] - ds.values[j * n + i]));
        worst = Math.max(worst, Math.abs(ds.conn.get(i, j) - ds.values[i * n + j]));
      }
    }
    expect(asym).toBe(0);
    expect(worst).toBeLessThanOrEqual(0.5 * ds.conn.scale + 1e-9);
  });

  it("masks exactly the nodes whose rows are zero", () => {
    for (let i = 0; i < n; i++) {
      let any = false;
      for (let j = 0; j < n; j++) if (j !== i && ds.values[i * n + j] !== 0) any = true;
      expect(any).toBe(ds.mask[i] === 1);
    }
  });

  it("gives homotopic nodes the same module and mirrored positions", () => {
    if (!split.two) return;
    const h = ds.leftNodes;
    for (let i = 0; i < h; i++) {
      expect(ds.modules[i + h]).toBe(ds.modules[i]);
      for (const s of ds.surfaces) {
        expect(s.positions[3 * (i + h)]).toBe(-s.positions[3 * i]);
        expect(s.positions[3 * (i + h) + 1]).toBe(s.positions[3 * i + 1]);
        expect(s.positions[3 * (i + h) + 2]).toBe(s.positions[3 * i + 2]);
      }
    }
  });

  it("keeps the hemispheres apart in every surface (left entirely at x < 0)", () => {
    if (!split.two) return;
    for (const s of ds.surfaces) {
      let maxL = -Infinity, minR = Infinity;
      for (let i = 0; i < ds.leftNodes; i++) maxL = Math.max(maxL, s.positions[3 * i]);
      for (let i = ds.leftNodes; i < n; i++) minR = Math.min(minR, s.positions[3 * i]);
      expect(maxL).toBeLessThan(0);
      expect(minR).toBeGreaterThan(0);
    }
  });
});

describe("icoBrain", () => {
  const ds = icoBrain(2);
  const n = ds.n, h = ds.hemiNodes;

  it.each([[1, 42], [2, 162], [3, 642]])("level %i has %i nodes per hemisphere", (level, nodes) => {
    const d = level === 2 ? ds : icoBrain(level);
    expect(d.hemiNodes).toBe(nodes);
    expect(d.n).toBe(2 * nodes);
    expect(d.surfaces.map((s) => s.name)).toEqual(["pial", "inflated", "sphere"]);
    expect(d.overlays.map((o) => o.name)).toEqual(["sulc"]);
  });

  it("has exact radius-100 spheres around (-105, 0, 0) and (105, 0, 0)", () => {
    const p = ds.surfaces[2].positions;
    for (let i = 0; i < n; i++) {
      const c = i < h ? -105 : 105;
      expect(Math.hypot(p[3 * i] - c, p[3 * i + 1], p[3 * i + 2])).toBeCloseTo(100, 3);
    }
  });

  it("has a folded pial surface (radius varies) and an unfolded inflated one", () => {
    const S = BRAIN_SHAPE;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < h; i++) {
      const rel = (s: number, c: readonly number[], ax: readonly number[]) =>
        Math.hypot(...[0, 1, 2].map((k) => (ds.surfaces[s].positions[3 * i + k] - c[k]) / ax[k]));
      expect(rel(1, S.inflatedCenter, S.inflatedAxes)).toBeCloseTo(1, 5);
      const r = rel(0, S.pialCenter, S.pialAxes);
      lo = Math.min(lo, r); hi = Math.max(hi, r);
    }
    expect(lo).toBeLessThan(0.93);
    expect(hi).toBeGreaterThan(1.07);
  });

  it("has a sulc overlay that is positive where the pial surface is pushed inward", () => {
    const S = BRAIN_SHAPE;
    for (let i = 0; i < h; i++) {
      const r = Math.hypot(...[0, 1, 2].map((k) => (ds.surfaces[0].positions[3 * i + k] - S.pialCenter[k]) / S.pialAxes[k]));
      if (Math.abs(r - 1) > 1e-3) expect(Math.sign(ds.overlays[0].data[i])).toBe(r < 1 ? 1 : -1);
      expect(Math.abs(ds.overlays[0].data[i])).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it("assigns modules by octant, all eight of them populated", () => {
    for (let i = 0; i < n; i++) expect(ds.modules[i]).toBe(octant(ds.unit[3 * i], ds.unit[3 * i + 1], ds.unit[3 * i + 2]));
    expect(new Set(ds.modules).size).toBe(8);
  });

  it("has the documented block structure: within 0.8, homotopic 0.6, other 0.1, each +- 0.05, diagonal 1", () => {
    const sums = { within: 0, homotopic: 0, other: 0 }, counts = { within: 0, homotopic: 0, other: 0 };
    for (let i = 0; i < n; i++) {
      expect(ds.values[i * n + i]).toBe(1);
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const kind = ds.modules[i] !== ds.modules[j] ? "other" : (i < h) === (j < h) ? "within" : "homotopic";
        const v = ds.values[i * n + j];
        expect(Math.abs(v - BLOCK_R[kind])).toBeLessThanOrEqual(BLOCK_R.noise + 1e-6);
        sums[kind] += v; counts[kind]++;
      }
    }
    for (const kind of ["within", "homotopic", "other"] as const) {
      expect(counts[kind]).toBeGreaterThan(100);
      expect(sums[kind] / counts[kind]).toBeCloseTo(BLOCK_R[kind], 2);
    }
    expect(ds.conn.maxAbs).toBeCloseTo(1, 12);
  });

  it("is deterministic", () => {
    const again = icoBrain(2);
    expect(again.values).toEqual(ds.values);
    expect(again.surfaces[0].positions).toEqual(ds.surfaces[0].positions);
    expect(again.triangles).toEqual(ds.triangles);
  });
});

describe("singleHemisphere", () => {
  const ds = singleHemisphere(2);
  it("has one hemisphere, no overlays and no sphere surface", () => {
    expect(ds.n).toBe(162);
    expect(ds.leftNodes).toBe(0);
    expect(ds.leftTriangles).toBe(0);
    expect(ds.overlays).toEqual([]);
    expect(ds.surfaces.map((s) => s.name)).toEqual(["pial", "inflated"]);
  });
  it("has no surface of constant radius", () => {
    for (const s of ds.surfaces) {
      const c = [0, 1, 2].map((k) => { let m = 0; for (let i = 0; i < ds.n; i++) m += s.positions[3 * i + k]; return m / ds.n; });
      const r = Array.from({ length: ds.n }, (_, i) => norm(sub(at(s.positions, i), c)));
      expect(Math.max(...r) / Math.min(...r)).toBeGreaterThan(1.3);
    }
  });
});

describe("withMedialWall", () => {
  const base = icoBrain(2);
  const ds = withMedialWall(base);
  const wall = medialWallNodes(base);

  it("removes a contiguous medial patch of both hemispheres", () => {
    expect(wall.length).toBeGreaterThan(10);
    expect(wall.length).toBeLessThan(base.n / 4);
    expect(wall.filter((i) => i < base.hemiNodes).map((i) => i + base.hemiNodes)).toEqual(wall.filter((i) => i >= base.hemiNodes));
    // medial = facing the other hemisphere
    const p = base.surfaces[2].positions;
    for (const i of wall) expect(Math.abs(p[3 * i])).toBeLessThan(105 - 100 * BRAIN_SHAPE.medialX + 1e-3);
  });
  it("zeroes rows and columns, clears the mask and leaves everything else alone", () => {
    const inWall = new Uint8Array(base.n);
    for (const i of wall) inWall[i] = 1;
    expect(Array.from(ds.mask)).toEqual(Array.from(inWall, (w) => 1 - w));
    for (let i = 0; i < base.n; i++) {
      for (let j = 0; j < base.n; j++) {
        const expected = inWall[i] || inWall[j] ? 0 : base.values[i * base.n + j];
        expect(ds.values[i * base.n + j]).toBe(expected);
        if (inWall[i] || inWall[j]) expect(ds.conn.get(i, j)).toBe(0);
      }
    }
  });
  it("does not modify its input", () => {
    expect(Array.from(base.mask).every((m) => m === 1)).toBe(true);
    expect(base.values[wall[0] * base.n + wall[0]]).toBe(1);
  });
});

describe("anticorrelated", () => {
  const base = withMedialWall(icoBrain(1));
  const ds = anticorrelated(base);
  const n = ds.n;
  it("makes exactly the between-module entries negative and keeps zeros", () => {
    let neg = 0, strong = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const v = ds.values[i * n + j], b = base.values[i * n + j];
        if (i === j || ds.modules[i] === ds.modules[j]) expect(v).toBe(b);
        else if (b === 0) expect(v).toBe(0);
        else {
          expect(v).toBeLessThan(0);
          neg++;
          if ((ds.modules[i] ^ ds.modules[j]) === 7) { expect(v).toBeCloseTo(-(b + 0.4), 6); strong++; } else expect(v).toBe(-b);
        }
      }
    }
    expect(neg).toBeGreaterThan(100);
    expect(strong).toBeGreaterThan(10);
  });
  it("stays symmetric with |r| <= 1", () => {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      expect(ds.values[i * n + j]).toBe(ds.values[j * n + i]);
      expect(Math.abs(ds.values[i * n + j])).toBeLessThanOrEqual(1);
    }
  });
});

describe("weighted", () => {
  const base = icoBrain(1);
  const ds = weighted(base);
  const n = ds.n;
  it("has a zero diagonal and a largest |weight| of 5", () => {
    let maxAbs = 0;
    for (let i = 0; i < n; i++) {
      expect(ds.values[i * n + i]).toBe(0);
      for (let j = 0; j < n; j++) maxAbs = Math.max(maxAbs, Math.abs(ds.values[i * n + j]));
    }
    expect(maxAbs).toBeCloseTo(5, 5);
    expect(ds.conn.maxAbs).toBeCloseTo(5, 5);
    expect(ds.conn.scale).toBeCloseTo(5 / 32767, 9);
  });
  it("is a rescaled copy of the correlations", () => {
    const k = ds.values[1] / base.values[1];
    expect(k).toBeGreaterThan(5);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) expect(ds.values[i * n + j]).toBeCloseTo(base.values[i * n + j] * k, 4);
  });
});

describe("directed", () => {
  it("is asymmetric with a halved lower triangle", () => {
    const base = singleHemisphere(1);
    const ds = directed(base);
    const n = ds.n;
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) {
      expect(ds.values[j * n + i]).toBe(base.values[j * n + i]);
      expect(ds.values[i * n + j]).toBeCloseTo(0.5 * base.values[i * n + j], 7);
      expect(ds.conn.get(i, j)).not.toBeCloseTo(ds.conn.get(j, i), 3);
    }
  });
});
