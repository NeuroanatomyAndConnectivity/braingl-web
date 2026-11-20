"""Tests for tools/make_glyphset.py.

Run from the repository root:

    python -m pytest tests/python -q

Needs numpy, scipy, nibabel (and nilearn for the one nki-demo test, which
replaces nilearn's download functions by local synthetic files: nothing is
ever fetched from the network).

Expectations are computed independently of the tool (closed forms or
brute-force loops), never copied from its output.  Cases marked
``xfail(strict=True)`` document real defects of the tool; they turn into
failures (XPASS) as soon as the defect is fixed, so that the mark gets removed.
"""
from __future__ import annotations

import importlib.util
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

nib = pytest.importorskip("nibabel")

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "make_glyphset.py"


def _load_tool():
    # tools/ is not a package; do not leave a __pycache__ behind in it
    old = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec = importlib.util.spec_from_file_location("make_glyphset_under_test", TOOL)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = old
    return module


mg = _load_tool()


# ---------------------------------------------------------------- test meshes
OCT_V = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], np.float32)
OCT_T = np.array([[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]], np.int32)


def octahedron(radius=1.0, center=(0.0, 0.0, 0.0)):
    return (OCT_V * radius + np.asarray(center, np.float32)).astype(np.float32), OCT_T.copy()


def icosphere(levels):
    """Unit icosphere whose vertices are nested like FreeSurfer's fsaverage
    meshes: the vertices of level k are the first vertices of level k + 1."""
    t = (1 + 5 ** 0.5) / 2
    verts = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t),
             (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    faces = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2),
             (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5),
             (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    verts = [np.array(v, float) / np.linalg.norm(v) for v in verts]
    for _ in range(levels):
        mid = {}

        def midpoint(a, b):
            key = (a, b) if a < b else (b, a)
            if key not in mid:
                m = verts[a] + verts[b]
                verts.append(m / np.linalg.norm(m))
                mid[key] = len(verts) - 1
            return mid[key]

        nxt = []
        for a, b, c in faces:
            ab, bc, ca = midpoint(a, b), midpoint(b, c), midpoint(c, a)
            nxt += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = nxt
    return np.array(verts, np.float32), np.array(faces, np.int32)


def neighbours(tri, n):
    """1-ring of every vertex, by brute force."""
    nb = [set() for _ in range(n)]
    for a, b, c in np.asarray(tri).tolist():
        nb[a] |= {b, c}
        nb[b] |= {a, c}
        nb[c] |= {a, b}
    return nb


def sym_matrix(n, seed, lo=-1.0, hi=1.0):
    rng = np.random.default_rng(seed)
    m = rng.uniform(lo, hi, (n, n))
    m = (m + m.T) / 2
    np.fill_diagonal(m, 1.0)
    return m.astype(np.float32)


# ------------------------------------------------------------ file helpers
def write_gii_surface(path, xyz, tri):
    g = nib.gifti.GiftiImage(darrays=[
        nib.gifti.GiftiDataArray(np.asarray(xyz, np.float32), intent="NIFTI_INTENT_POINTSET", datatype="NIFTI_TYPE_FLOAT32"),
        nib.gifti.GiftiDataArray(np.asarray(tri, np.int32), intent="NIFTI_INTENT_TRIANGLE", datatype="NIFTI_TYPE_INT32"),
    ])
    nib.save(g, str(path))
    return str(path)


def write_gii_scalars(path, data):
    """data [nodes] or [nodes, time] -> one data array per time point (like a .func.gii)."""
    data = np.asarray(data, np.float32)
    cols = [data] if data.ndim == 1 else [data[:, k] for k in range(data.shape[1])]
    g = nib.gifti.GiftiImage(darrays=[
        nib.gifti.GiftiDataArray(np.ascontiguousarray(c), intent="NIFTI_INTENT_TIME_SERIES", datatype="NIFTI_TYPE_FLOAT32")
        for c in cols])
    nib.save(g, str(path))
    return str(path)


def write_asc(path, xyz, tri, header=True):
    """FreeSurfer ASCII surface, written without any help from the tool."""
    lines = []
    if header:
        lines.append("#!ascii version of test surface")
    lines.append(f"{len(xyz)} {len(tri)}")
    lines += [f"{x!r}  {y!r}  {z!r}  0" for x, y, z in np.asarray(xyz, float).tolist()]
    lines += [f"{a} {b} {c} 0" for a, b, c in np.asarray(tri).tolist()]
    Path(path).write_text("\n".join(lines) + "\n")
    return str(path)


def read_asc(path):
    """Independent, strict FreeSurfer ASCII reader (the rules of src/io/freesurferAsc.ts)."""
    lines = Path(path).read_text().split("\n")
    assert lines[-1] == "", "file must end with a newline"
    lines = lines[:-1]
    k = 1 if lines[0].startswith("#") else 0
    head = lines[k].split()
    assert len(head) == 2, f"header must be 'nVerts nTris', got {lines[k]!r}"
    nv, nt = int(head[0]), int(head[1])
    assert len(lines) == k + 1 + nv + nt, "line count does not match the header"
    xyz = np.zeros((nv, 3))
    for i in range(nv):
        tok = lines[k + 1 + i].split()
        assert len(tok) >= 3, f"vertex line {i} has fewer than three numbers"
        xyz[i] = [float(t) for t in tok[:3]]
    tri = np.zeros((nt, 3), np.int64)
    for i in range(nt):
        tok = lines[k + 1 + nv + i].split()
        assert len(tok) >= 3, f"triangle line {i} has fewer than three indices"
        tri[i] = [int(t) for t in tok[:3]]  # int() rejects "1.0": indices must be integers
    assert nt == 0 or (tri.min() >= 0 and tri.max() < nv), "triangle index out of range"
    return xyz, tri


def read_web(folder):
    """Read a web glyphset the way src/data/loadWeb.ts does, with its checks."""
    folder = Path(folder)
    man = json.loads((folder / "glyphset.json").read_text())
    assert man["format"] == "braingl-web-glyphset"
    n = man["nodes"]
    out = {"manifest": man, "n": n}
    out["triangles"] = np.fromfile(folder / man["triangles"], dtype="<u4").reshape(-1, 3)
    out["surfaces"] = {}
    for s in man["surfaces"]:
        xyz = np.fromfile(folder / s["file"], dtype="<f4")
        assert xyz.size == 3 * n, f"surface {s['name']} has {xyz.size / 3} nodes, expected {n}"
        out["surfaces"][s["name"]] = xyz.reshape(n, 3)
    out["overlays"] = {o["name"]: np.fromfile(folder / o["file"], dtype="<f4") for o in man.get("overlays", [])}
    out["mask"] = np.fromfile(folder / man["mask"], dtype=np.uint8) if man.get("mask") else None
    c = man["connectivity"]
    raw = np.fromfile(folder / c["file"], dtype={"int8": "<i1", "int16": "<i2", "float32": "<f4"}[c["dtype"]])
    out["raw"] = raw
    out["scale"] = c.get("scale", 1.0)
    full = np.zeros((n, n))
    if c["layout"] == "upper":
        assert raw.size == n * (n - 1) // 2
        k = 0
        for i in range(n):  # row-major strict upper triangle, as ConnMatrix.fromUpper
            for j in range(i + 1, n):
                full[i, j] = full[j, i] = float(raw[k]) * out["scale"]
                k += 1
    else:
        assert raw.size == n * n
        full[:] = raw.reshape(n, n).astype(float) * out["scale"]
    out["conn"] = full
    return out


def offdiag(m):
    return m[~np.eye(m.shape[0], dtype=bool)]


def cli(*args):
    """Run a sub-command in-process through the tool's argparse entry point."""
    return mg.main([str(a) for a in args])


# =============================================================== quantize_upper
def test_quantize_int8_closed_form():
    m = np.array([[9.0, 1.0, -0.5, 0.25],
                  [1.0, 9.0, 0.1, -1.0],
                  [-0.5, 0.1, 9.0, 0.0],
                  [0.25, -1.0, 0.0, 9.0]], np.float32)
    q, scale = mg.quantize_upper(m, "int8")
    # (0,1) (0,2) (0,3) (1,2) (1,3) (2,3); 0.1 * 127 = 12.7 -> 13; 0.25 * 127 = 31.75 -> 32; 0.5 * 127 = 63.5 -> 64
    assert q.tolist() == [127, -64, 32, 13, -127, 0]
    assert scale == pytest.approx(1 / 127)


def test_quantize_scale_is_max_abs_over_top():
    m = np.zeros((3, 3), np.float32)
    m[0, 1] = m[1, 0] = 0.5
    m[1, 2] = m[2, 1] = -0.25
    q8, s8 = mg.quantize_upper(m, "int8")
    q16, s16 = mg.quantize_upper(m, "int16")
    assert s8 == pytest.approx(0.5 / 127)
    assert s16 == pytest.approx(0.5 / 32767)
    assert q8.tolist() == [127, 0, -64]            # -0.25 / 0.5 * 127 = -63.5 -> -64 (round half to even)
    assert q16.tolist() == [32767, 0, -16384]      # -16383.5 -> -16384


def test_quantize_order_is_row_major_upper_triangle():
    n = 7
    m = np.zeros((n, n), np.float32)
    expected = []
    for i in range(n):
        for j in range(i + 1, n):
            m[i, j] = m[j, i] = len(expected) + 1
            expected.append(len(expected) + 1)
    vals, scale = mg.quantize_upper(m, "float32")
    assert vals.tolist() == expected
    assert scale == 1.0


@pytest.mark.parametrize("n", [2, 3, 10, 33])
def test_quantize_length(n):
    q, _ = mg.quantize_upper(sym_matrix(n, n), "int8")
    assert q.shape == (n * (n - 1) // 2,)


@pytest.mark.parametrize("dtype,np_dtype", [("int8", "<i1"), ("int16", "<i2"), ("float32", "<f4")])
def test_quantize_storage_dtype(dtype, np_dtype):
    q, _ = mg.quantize_upper(sym_matrix(5, 1), dtype)
    assert q.dtype == np.dtype(np_dtype)


@pytest.mark.parametrize("dtype,top", [("int8", 127), ("int16", 32767)])
def test_quantize_error_is_at_most_half_a_step(dtype, top):
    m = sym_matrix(40, 7, lo=-0.8, hi=0.8)
    q, scale = mg.quantize_upper(m, dtype)
    iu = np.triu_indices(40, k=1)
    assert scale == pytest.approx(np.abs(m[iu]).max() / top, rel=1e-6)
    err = np.abs(q.astype(np.float64) * scale - m[iu])
    assert err.max() <= scale / 2 * (1 + 1e-4)
    assert np.abs(q.astype(np.int64)).max() == top   # the full integer range is used ...
    assert q.astype(np.int64).min() >= -top          # ... but never -128 / -32768


def test_quantize_int16_is_finer_than_int8():
    m = sym_matrix(30, 11)
    iu = np.triu_indices(30, k=1)
    q8, s8 = mg.quantize_upper(m, "int8")
    q16, s16 = mg.quantize_upper(m, "int16")
    e8 = np.abs(q8 * s8 - m[iu]).max()
    e16 = np.abs(q16 * s16 - m[iu]).max()
    assert e16 < e8 / 100


def test_quantize_float32_is_lossless():
    m = sym_matrix(12, 3)
    vals, scale = mg.quantize_upper(m, "float32")
    assert scale == 1.0
    assert np.array_equal(vals, m[np.triu_indices(12, k=1)])


def test_quantize_all_zero_matrix():
    q, scale = mg.quantize_upper(np.zeros((4, 4), np.float32), "int8")
    assert not q.any()
    assert math.isfinite(scale) and scale > 0


def test_quantize_non_finite_values_become_zero():
    m = np.zeros((4, 4), np.float32)
    m[0, 1] = np.nan
    m[0, 2] = np.inf
    m[0, 3] = -np.inf
    m[1, 2] = 0.5
    m[2, 3] = -1.0
    q, scale = mg.quantize_upper(m, "int8")
    assert q.tolist() == [0, 0, 0, 64, 0, -127]
    assert scale == pytest.approx(1 / 127)
    f, _ = mg.quantize_upper(m, "float32")
    assert f.tolist() == [0, 0, 0, 0.5, 0, -1.0]


def test_quantize_ignores_diagonal_and_lower_triangle():
    m = np.array([[100.0, 0.5, -0.5], [7.0, -100.0, 0.25], [8.0, 9.0, 100.0]], np.float32)
    q, scale = mg.quantize_upper(m, "int8")
    assert scale == pytest.approx(0.5 / 127)
    assert q.tolist() == [127, -127, 64]


def test_quantize_does_not_modify_its_input():
    m = sym_matrix(9, 5)
    m[0, 1] = np.nan
    before = m.copy()
    mg.quantize_upper(m, "int8")
    assert np.array_equal(m, before, equal_nan=True)


def test_quantize_accepts_float64_and_memmap(tmp_path):
    m = sym_matrix(8, 2)
    m.tofile(tmp_path / "m.bin")
    mm = np.memmap(tmp_path / "m.bin", dtype="<f4", mode="r", shape=(8, 8))
    a = mg.quantize_upper(m, "int8")
    b = mg.quantize_upper(m.astype(np.float64), "int8")
    c = mg.quantize_upper(mm, "int8")
    assert np.array_equal(a[0], b[0]) and np.array_equal(a[0], c[0])
    assert a[1] == pytest.approx(b[1]) and a[1] == pytest.approx(c[1])


def test_quantize_requantising_is_idempotent():
    """Decoding and encoding again reproduces the same integers (needed for round trips)."""
    m = sym_matrix(25, 21)
    q, scale = mg.quantize_upper(m, "int8")
    n = 25
    full = np.zeros((n, n), np.float32)
    full[np.triu_indices(n, k=1)] = q.astype(np.float32) * np.float32(scale)
    full = full + full.T
    q2, scale2 = mg.quantize_upper(full, "int8")
    assert np.array_equal(q, q2)
    assert scale2 == pytest.approx(scale, rel=1e-6)


@pytest.mark.xfail(strict=True, raises=ValueError,
                   reason="KNOWN BUG (minor) tools/make_glyphset.py:100: np.abs(vals).max() on the empty upper "
                          "triangle of a 1x1 matrix raises 'zero-size array to reduction operation maximum'")
def test_quantize_single_node_matrix():
    q, scale = mg.quantize_upper(np.ones((1, 1), np.float32), "int8")
    assert q.size == 0 and scale > 0


# ========================================================== separate_hemispheres
def _gap(l, r):
    return float(r[:, 0].min() - l[:, 0].max())


def test_separate_overlapping_hemispheres_leaves_exactly_the_gap():
    l, _ = octahedron(10, (-3, 0, 0))   # x in [-13, 7]
    r, _ = octahedron(10, (3, 0, 0))    # x in [-7, 13]
    l2, r2 = mg.separate_hemispheres(l, r)
    assert _gap(l2, r2) == pytest.approx(5.0, abs=1e-5)


def test_separate_shift_is_symmetric_and_closed_form():
    l, _ = octahedron(10, (-3, 0, 0))
    r, _ = octahedron(10, (3, 0, 0))
    l2, r2 = mg.separate_hemispheres(l, r, gap=5.0)
    # overlap = 7 - (-7) = 14 -> each side moves (14 + 5) / 2 = 9.5
    assert np.allclose(l2[:, 0] - l[:, 0], -9.5, atol=1e-6)
    assert np.allclose(r2[:, 0] - r[:, 0], +9.5, atol=1e-6)


def test_separate_only_moves_along_x():
    l, _ = octahedron(10, (0, 1, 2))
    r, _ = octahedron(10, (0, -1, -2))
    l2, r2 = mg.separate_hemispheres(l, r)
    assert np.array_equal(l2[:, 1:], l[:, 1:])
    assert np.array_equal(r2[:, 1:], r[:, 1:])


def test_separate_keeps_shape_and_relative_geometry():
    l, _ = icosphere(1)
    r, _ = icosphere(1)
    l2, r2 = mg.separate_hemispheres(l * 100, r * 100)
    assert l2.shape == l.shape and r2.shape == r.shape
    # rigid translation: all pairwise differences inside a hemisphere are unchanged
    assert np.allclose(l2 - l2[0], (l - l[0]) * 100, atol=1e-4)
    assert np.allclose(r2 - r2[0], (r - r[0]) * 100, atol=1e-4)
    # two spheres of radius 100 around the origin end up 5 apart: centres at -/+ 102.5
    assert l2.mean(axis=0) == pytest.approx([-102.5, 0, 0], abs=1e-3)
    assert r2.mean(axis=0) == pytest.approx([102.5, 0, 0], abs=1e-3)


def test_separate_does_not_modify_its_inputs():
    l, _ = octahedron(10)
    r, _ = octahedron(10)
    lb, rb = l.copy(), r.copy()
    mg.separate_hemispheres(l, r)
    assert np.array_equal(l, lb) and np.array_equal(r, rb)


def test_separate_leaves_well_separated_hemispheres_alone():
    l, _ = octahedron(10, (-30, 0, 0))
    r, _ = octahedron(10, (30, 0, 0))   # 40 apart
    l2, r2 = mg.separate_hemispheres(l, r)
    assert np.array_equal(l2, l) and np.array_equal(r2, r)


def test_separate_exact_gap_is_left_alone():
    l, _ = octahedron(10, (-12.5, 0, 0))   # max x = -2.5
    r, _ = octahedron(10, (12.5, 0, 0))    # min x = +2.5
    l2, r2 = mg.separate_hemispheres(l, r, gap=5.0)
    assert np.array_equal(l2, l) and np.array_equal(r2, r)


def test_separate_widens_a_gap_that_is_too_small():
    l, _ = octahedron(10, (-11, 0, 0))   # max x = -1
    r, _ = octahedron(10, (11, 0, 0))    # min x = +1: 2 apart
    l2, r2 = mg.separate_hemispheres(l, r, gap=5.0)
    assert _gap(l2, r2) == pytest.approx(5.0, abs=1e-5)
    assert np.allclose(l2[:, 0] - l[:, 0], -1.5, atol=1e-6)


@pytest.mark.parametrize("gap", [0.0, 1.0, 12.5])
def test_separate_custom_gap(gap):
    l, _ = octahedron(10)
    r, _ = octahedron(10)
    l2, r2 = mg.separate_hemispheres(l, r, gap=gap)
    assert _gap(l2, r2) == pytest.approx(gap, abs=1e-5)


def test_separate_is_idempotent():
    l, _ = octahedron(10)
    r, _ = octahedron(10)
    l2, r2 = mg.separate_hemispheres(l, r)
    l3, r3 = mg.separate_hemispheres(l2, r2)
    assert np.allclose(l3, l2, atol=1e-5) and np.allclose(r3, r2, atol=1e-5)


# ================================================================== stack_hemis
def test_stack_hemis_offsets_right_triangles():
    lx, lt = octahedron(1, (-2, 0, 0))
    rx, rt = icosphere(0)
    xyz, tri = mg.stack_hemis((lx, lt), (rx, rt))
    assert xyz.shape == (6 + 12, 3)
    assert np.array_equal(xyz[:6], lx) and np.array_equal(xyz[6:], rx)
    assert np.array_equal(tri[:8], lt)
    assert np.array_equal(tri[8:], rt + 6)
    assert tri[8:].min() == 6 and tri[8:].max() == 17


# ================================================================== correlation
def test_correlation_matches_numpy_corrcoef():
    rng = np.random.default_rng(42)
    ts = rng.normal(size=(15, 200)) + 0.5 * rng.normal(size=(1, 200))
    r, valid = mg.correlation(ts.astype(np.float32))
    assert valid.all()
    assert np.allclose(r, np.corrcoef(ts), atol=1e-5)


def test_correlation_brute_force_formula():
    rng = np.random.default_rng(1)
    ts = rng.normal(size=(4, 30))
    r, _ = mg.correlation(ts)
    for i in range(4):
        for j in range(4):
            a, b = ts[i] - ts[i].mean(), ts[j] - ts[j].mean()
            expected = (a * b).sum() / math.sqrt((a * a).sum() * (b * b).sum())
            assert r[i, j] == pytest.approx(expected, abs=1e-5)


def test_correlation_perfect_and_anti_correlation():
    t = np.linspace(0, 1, 50)
    ts = np.stack([t, 3 * t + 7, -2 * t + 1])
    r, valid = mg.correlation(ts)
    assert valid.all()
    assert np.allclose(r, [[1, 1, -1], [1, 1, -1], [-1, -1, 1]], atol=1e-5)


def test_correlation_orthogonal_signals():
    t = np.arange(64) * 2 * np.pi / 64
    r, _ = mg.correlation(np.stack([np.sin(t), np.cos(t), np.sin(2 * t)]))
    assert np.allclose(r, np.eye(3), atol=1e-5)


def test_correlation_known_value():
    # a = (1, 1, -1, -1), b = (1, -1, -1, -1): cov = 1/2, var a = 1, var b = 3/4 -> r = 1 / sqrt(3)
    r, _ = mg.correlation(np.array([[1, 1, -1, -1], [1, -1, -1, -1.0]]))
    a = np.array([1, 1, -1, -1.0])
    b = np.array([1, -1, -1, -1.0])
    assert r[0, 1] == pytest.approx(np.corrcoef(a, b)[0, 1], abs=1e-6)
    assert r[0, 1] == pytest.approx(1 / math.sqrt(3), abs=1e-6)


def test_correlation_is_symmetric_with_unit_diagonal_and_bounded():
    rng = np.random.default_rng(3)
    r, _ = mg.correlation(rng.normal(size=(20, 40)))
    assert np.allclose(r, r.T, atol=1e-6)
    assert np.allclose(np.diag(r), 1, atol=1e-5)
    assert r.max() <= 1.0 and r.min() >= -1.0


def test_correlation_is_invariant_to_offset_and_scale():
    rng = np.random.default_rng(4)
    ts = rng.normal(size=(6, 80))
    gain = np.array([1, 2, 0.5, 10, 3, 7.0])[:, None]
    r1, _ = mg.correlation(ts)
    r2, _ = mg.correlation(ts * gain + 100 * gain)
    assert np.allclose(r1, r2, atol=1e-4)


def test_correlation_constant_rows_are_invalid_and_zero():
    rng = np.random.default_rng(5)
    ts = rng.normal(size=(6, 50))
    ts[1] = 0
    ts[4] = 3.5
    r, valid = mg.correlation(ts)
    assert valid.tolist() == [True, False, True, True, False, True]
    assert not r[[1, 4], :].any() and not r[:, [1, 4]].any()   # including the diagonal
    keep = [0, 2, 3, 5]
    assert np.allclose(r[np.ix_(keep, keep)], np.corrcoef(ts[keep]), atol=1e-5)


def test_correlation_nan_row_is_invalid_and_does_not_spread():
    rng = np.random.default_rng(6)
    ts = rng.normal(size=(4, 30))
    ts[2, 5] = np.nan
    r, valid = mg.correlation(ts)
    assert valid.tolist() == [True, True, False, True]
    assert np.isfinite(r).all()
    assert not r[2].any() and not r[:, 2].any()


def test_correlation_returns_float32_and_keeps_its_input():
    rng = np.random.default_rng(7)
    ts = rng.normal(size=(5, 20)).astype(np.float32)
    before = ts.copy()
    r, valid = mg.correlation(ts)
    assert r.dtype == np.float32 and r.shape == (5, 5)
    assert valid.dtype == bool and valid.shape == (5,)
    assert np.array_equal(ts, before)


def test_zscore_rows_mean_zero_unit_variance():
    rng = np.random.default_rng(8)
    ts = rng.normal(3, 5, size=(7, 100))
    ts[3] = 2.0
    z, valid = mg.zscore_rows(ts)
    assert valid.tolist() == [True, True, True, False, True, True, True]
    assert np.allclose(z.mean(axis=1), 0, atol=1e-5)
    assert np.allclose(z[valid].std(axis=1), 1, atol=1e-5)   # population standard deviation
    assert not z[3].any()


# ======================================================== ico_neighbour_average
def _brute_average(ts, tri, n_keep):
    ts = np.asarray(ts, np.float64)
    nb = neighbours(tri, ts.shape[0])
    out = np.zeros((n_keep, ts.shape[1]))
    for i in range(n_keep):
        if not np.abs(ts[i]).sum() > 0:
            continue                                   # an empty node stays empty
        members = [j for j in sorted(nb[i] | {i}) if np.abs(ts[j]).sum() > 0]
        out[i] = np.mean([ts[j] for j in members], axis=0)
    return out


def test_icosphere_helper_is_nested_and_closed():
    v1, t1 = icosphere(1)
    v2, t2 = icosphere(2)
    assert v1.shape == (42, 3) and t1.shape == (80, 3)
    assert v2.shape == (162, 3) and t2.shape == (320, 3)
    assert np.array_equal(v2[:42], v1)
    deg = [len(s) for s in neighbours(t2, 162)]
    assert deg[:12] == [5] * 12 and set(deg[12:]) == {6}


def test_neighbour_average_matches_brute_force():
    v, tri = icosphere(2)
    rng = np.random.default_rng(10)
    ts = rng.normal(size=(162, 9)).astype(np.float32)
    out = mg.ico_neighbour_average(ts, tri, 42)
    assert np.allclose(out, _brute_average(ts, tri, 42), atol=1e-5)


def test_neighbour_average_shape_and_dtype():
    v, tri = icosphere(2)
    ts = np.random.default_rng(11).normal(size=(162, 4))
    out = mg.ico_neighbour_average(ts, tri, 42)
    assert out.shape == (42, 4) and out.dtype == np.float32


def test_neighbour_average_of_constant_field_is_constant():
    v, tri = icosphere(2)
    ts = np.full((162, 3), 2.5, np.float32)
    assert np.allclose(mg.ico_neighbour_average(ts, tri, 42), 2.5, atol=1e-6)


def test_neighbour_average_weights_are_uniform_over_the_one_ring():
    """An identity 'time series' reads the averaging weights off directly."""
    v, tri = icosphere(2)
    n = 162
    out = mg.ico_neighbour_average(np.eye(n, dtype=np.float32), tri, 42)
    nb = neighbours(tri, n)
    expected = np.zeros((42, n))
    for i in range(42):
        ring = nb[i] | {i}
        expected[i, sorted(ring)] = 1 / len(ring)
    assert np.allclose(out, expected, atol=1e-6)
    assert np.allclose(out[:12].max(axis=1), 1 / 6)    # the 12 pentagon vertices: self + 5
    assert np.allclose(out[12:].max(axis=1), 1 / 7)    # all others: self + 6
    assert np.allclose(out.sum(axis=1), 1, atol=1e-6)


def test_neighbour_average_ignores_empty_neighbours():
    v, tri = icosphere(1)
    nb = neighbours(tri, 42)
    ts = np.ones((42, 2), np.float32)
    ts[:, 1] = np.arange(42)
    dead = sorted(nb[0])[:2]
    ts[dead] = 0
    out = mg.ico_neighbour_average(ts, tri, 12)
    alive = [j for j in sorted(nb[0] | {0}) if j not in dead]
    assert len(alive) == 4
    assert out[0, 0] == pytest.approx(1.0)                      # not 4 / 6
    assert out[0, 1] == pytest.approx(np.mean(alive), abs=1e-5)


def test_neighbour_average_keeps_empty_nodes_empty():
    v, tri = icosphere(1)
    ts = np.random.default_rng(12).normal(size=(42, 5)).astype(np.float32)
    ts[3] = 0
    ts[7] = 0
    out = mg.ico_neighbour_average(ts, tri, 12)
    assert not out[3].any() and not out[7].any()
    assert np.allclose(out, _brute_average(ts, tri, 12), atol=1e-5)


def test_neighbour_average_isolated_signal_keeps_its_value():
    v, tri = icosphere(1)
    ts = np.zeros((42, 3), np.float32)
    ts[5] = [1, 2, 3]
    out = mg.ico_neighbour_average(ts, tri, 12)
    assert np.allclose(out[5], [1, 2, 3])
    assert not np.delete(out, 5, axis=0).any()


def test_neighbour_average_does_not_depend_on_triangle_winding_or_duplicates():
    v, tri = icosphere(1)
    ts = np.random.default_rng(13).normal(size=(42, 6)).astype(np.float32)
    ref = mg.ico_neighbour_average(ts, tri, 12)
    flipped = tri[:, ::-1]
    doubled = np.vstack([tri, tri])
    assert np.allclose(mg.ico_neighbour_average(ts, flipped, 12), ref, atol=1e-6)
    assert np.allclose(mg.ico_neighbour_average(ts, doubled, 12), ref, atol=1e-6)


def test_neighbour_average_keep_all():
    v, tri = icosphere(1)
    ts = np.random.default_rng(14).normal(size=(42, 3)).astype(np.float32)
    out = mg.ico_neighbour_average(ts, tri, 42)
    assert out.shape == (42, 3)
    assert np.allclose(out, _brute_average(ts, tri, 42), atol=1e-5)


def test_neighbour_average_does_not_modify_its_input():
    v, tri = icosphere(1)
    ts = np.random.default_rng(15).normal(size=(42, 3)).astype(np.float32)
    ts[2] = 0
    before = ts.copy()
    mg.ico_neighbour_average(ts, tri, 12)
    assert np.array_equal(ts, before)


# ====================================================================== loaders
def test_load_surface_gifti(tmp_path):
    v, t = icosphere(1)
    xyz, tri = mg.load_surface(write_gii_surface(tmp_path / "lh.pial.gii", v * 50, t))
    assert xyz.dtype == np.float32 and tri.dtype == np.int32
    assert np.array_equal(xyz, v * 50) and np.array_equal(tri, t)


@pytest.mark.parametrize("header", [True, False])
def test_load_surface_asc(tmp_path, header):
    v, t = octahedron(12.5, (1, 2, 3))
    xyz, tri = mg.load_surface(write_asc(tmp_path / "lh.pial.asc", v, t, header=header))
    assert xyz.dtype == np.float32 and tri.dtype == np.int32
    assert np.array_equal(xyz, v) and np.array_equal(tri, t)


def test_load_surface_freesurfer_binary(tmp_path):
    v, t = icosphere(1)
    nib.freesurfer.write_geometry(str(tmp_path / "lh.sphere"), v.astype(np.float64) * 100, t)
    xyz, tri = mg.load_surface(tmp_path / "lh.sphere")
    assert xyz.dtype == np.float32 and tri.dtype == np.int32
    assert np.allclose(xyz, v * 100, atol=1e-4) and np.array_equal(tri, t)


def test_load_matrix_npy(tmp_path):
    m = sym_matrix(6, 1)
    np.save(tmp_path / "m.npy", m)
    assert np.array_equal(np.asarray(mg.load_matrix(tmp_path / "m.npy")), m)


def test_load_matrix_raw_float32_with_and_without_n(tmp_path):
    m = sym_matrix(9, 2)
    m.astype("<f4").tofile(tmp_path / "m.bin")
    assert np.array_equal(np.asarray(mg.load_matrix(tmp_path / "m.bin", 9)), m)
    got = mg.load_matrix(tmp_path / "m.bin")       # n from the file size
    assert got.shape == (9, 9) and np.array_equal(np.asarray(got), m)


def test_load_matrix_rejects_a_file_that_is_not_square(tmp_path):
    np.zeros(9 * 9 + 1, "<f4").tofile(tmp_path / "m.bin")
    with pytest.raises(SystemExit):
        mg.load_matrix(tmp_path / "m.bin")
    with pytest.raises(SystemExit):
        mg.load_matrix(tmp_path / "m.bin", 9)


def test_load_matrix_rejects_wrong_node_count(tmp_path):
    np.zeros(8 * 8, "<f4").tofile(tmp_path / "m.bin")
    with pytest.raises(SystemExit):
        mg.load_matrix(tmp_path / "m.bin", 6)


def test_load_scalars_npy_gifti_and_morph(tmp_path):
    rng = np.random.default_rng(20)
    one = rng.normal(size=42).astype(np.float32)
    many = rng.normal(size=(42, 5)).astype(np.float32)
    np.save(tmp_path / "a.npy", one)
    assert np.array_equal(mg.load_scalars(tmp_path / "a.npy"), one)
    assert np.array_equal(mg.load_scalars(write_gii_scalars(tmp_path / "a.shape.gii", one)), one)
    got = mg.load_scalars(write_gii_scalars(tmp_path / "a.func.gii", many))
    assert got.shape == (42, 5) and np.array_equal(got, many)      # [nodes, time]
    nib.freesurfer.write_morph_data(str(tmp_path / "lh.sulc"), one)
    assert np.allclose(mg.load_scalars(tmp_path / "lh.sulc"), one)


# =============================================================== write_glyphset
@pytest.fixture
def two_hemi():
    """Two octahedra (left nodes first), three surfaces, mask, overlay, matrix."""
    lx, lt = octahedron(10, (-20, 0, 0))
    rx, rt = octahedron(10, (20, 0, 0))
    xyz = np.vstack([lx, rx])
    tri = np.vstack([lt, rt + 6])
    rng = np.random.default_rng(100)
    return {
        "n": 12, "ln": 6, "lt": 8, "tri": tri,
        "surfaces": [("pial", xyz), ("inflated", (xyz * 1.5).astype(np.float32)),
                     ("sphere", (xyz + rng.normal(size=xyz.shape)).astype(np.float32))],
        "conn": sym_matrix(12, 101),
        "mask": np.array([1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1], np.uint8),
        "sulc": rng.normal(size=12).astype(np.float32),
    }


def _write(tmp_path, d, **kw):
    out = tmp_path / "web"
    args = dict(left_nodes=d["ln"], left_triangles=d["lt"], overlays=[("sulc", d["sulc"])], mask=d["mask"])
    args.update(kw)
    mg.write_glyphset(out, "test set", d["surfaces"], d["tri"], d["conn"], **args)
    return out


def test_write_manifest_fields(tmp_path, two_hemi):
    out = _write(tmp_path, two_hemi, description="a description")
    man = json.loads((out / "glyphset.json").read_text())
    assert man["format"] == "braingl-web-glyphset"
    assert man["version"] == 1
    assert man["name"] == "test set"
    assert man["description"] == "a description"
    assert (man["nodes"], man["leftNodes"], man["leftTriangles"]) == (12, 6, 8)
    assert [s["name"] for s in man["surfaces"]] == ["pial", "inflated", "sphere"]
    assert [o["name"] for o in man["overlays"]] == ["sulc"]
    assert man["connectivity"]["dtype"] == "int8"
    assert man["connectivity"]["layout"] == "upper"
    assert isinstance(man["connectivity"]["scale"], float)


def test_write_manifest_has_the_keys_the_browser_reads(tmp_path, two_hemi):
    """Required members of WebGlyphsetManifest (src/data/loadWeb.ts)."""
    man = json.loads((_write(tmp_path, two_hemi) / "glyphset.json").read_text())
    for key in ("format", "version", "name", "nodes", "triangles", "surfaces", "connectivity"):
        assert key in man
    assert {"file", "dtype", "layout"} <= set(man["connectivity"])
    assert all(set(s) == {"name", "file"} for s in man["surfaces"] + man["overlays"])
    assert all(isinstance(man[k], int) for k in ("nodes", "leftNodes", "leftTriangles", "version"))


def test_write_manifest_agrees_with_the_shipped_example(tmp_path, two_hemi):
    example = REPO / "public" / "data" / "nki_fsaverage4" / "glyphset.json"
    if not example.exists():
        pytest.skip("demo data set is not present")
    ref = json.loads(example.read_text())
    man = json.loads((_write(tmp_path, two_hemi) / "glyphset.json").read_text())
    assert set(man) <= set(ref)                      # no key the shipped manifest does not have
    assert set(ref) - set(man) <= {"source", "subjects"}
    assert set(man["connectivity"]) == set(ref["connectivity"])
    assert man["format"] == ref["format"] and man["version"] == ref["version"]


def test_write_every_referenced_file_exists_and_nothing_else(tmp_path, two_hemi):
    out = _write(tmp_path, two_hemi)
    man = json.loads((out / "glyphset.json").read_text())
    referenced = {"glyphset.json", man["triangles"], man["mask"], man["connectivity"]["file"]}
    referenced |= {s["file"] for s in man["surfaces"]} | {o["file"] for o in man["overlays"]}
    assert {p.name for p in out.iterdir()} == referenced


def test_write_triangles_read_back(tmp_path, two_hemi):
    out = _write(tmp_path, two_hemi)
    raw = np.fromfile(out / "triangles.u32", dtype="<u4")
    assert raw.size == 16 * 3
    assert np.array_equal(raw.reshape(-1, 3), two_hemi["tri"])
    assert (out / "triangles.u32").stat().st_size == 16 * 3 * 4


def test_write_surfaces_read_back(tmp_path, two_hemi):
    out = _write(tmp_path, two_hemi)
    for name, xyz in two_hemi["surfaces"]:
        assert (out / f"{name}.f32").stat().st_size == 12 * 3 * 4
        got = np.fromfile(out / f"{name}.f32", dtype="<f4").reshape(12, 3)
        assert np.array_equal(got, xyz)


def test_write_overlay_and_mask_read_back(tmp_path, two_hemi):
    out = _write(tmp_path, two_hemi)
    assert np.array_equal(np.fromfile(out / "sulc.f32", dtype="<f4"), two_hemi["sulc"])
    assert np.array_equal(np.fromfile(out / "mask.u8", dtype=np.uint8), two_hemi["mask"])


def test_write_boolean_mask_becomes_zero_one_bytes(tmp_path, two_hemi):
    out = _write(tmp_path, two_hemi, mask=two_hemi["mask"].astype(bool))
    raw = (out / "mask.u8").read_bytes()
    assert len(raw) == 12
    assert list(raw) == two_hemi["mask"].tolist()


def test_write_without_mask_and_overlays(tmp_path, two_hemi):
    out = _write(tmp_path, two_hemi, mask=None, overlays=None)
    man = json.loads((out / "glyphset.json").read_text())
    assert "mask" not in man                      # the browser then treats every node as valid
    assert man["overlays"] == []
    assert not (out / "mask.u8").exists()
    assert read_web(out)["mask"] is None


@pytest.mark.parametrize("dtype,ext,itemsize", [("int8", "i8", 1), ("int16", "i16", 2), ("float32", "f32", 4)])
def test_write_connectivity_file_per_dtype(tmp_path, two_hemi, dtype, ext, itemsize):
    out = _write(tmp_path, two_hemi, dtype=dtype)
    man = json.loads((out / "glyphset.json").read_text())
    assert man["connectivity"]["file"] == f"connectivity.{ext}"
    assert man["connectivity"]["dtype"] == dtype
    assert (out / f"connectivity.{ext}").stat().st_size == 12 * 11 // 2 * itemsize


@pytest.mark.parametrize("dtype,top", [("int8", 127), ("int16", 32767), ("float32", None)])
def test_write_connectivity_values_read_back(tmp_path, two_hemi, dtype, top):
    out = _write(tmp_path, two_hemi, dtype=dtype)
    web = read_web(out)
    conn = two_hemi["conn"].astype(np.float64)
    vmax = np.abs(offdiag(conn)).max()
    if top is None:
        assert web["scale"] == 1.0
        tol = 0.0
    else:
        assert web["scale"] == pytest.approx(vmax / top, rel=1e-6)
        tol = web["scale"] / 2 * (1 + 1e-4)
    assert np.abs(offdiag(web["conn"]) - offdiag(conn)).max() <= tol
    assert np.allclose(web["conn"], web["conn"].T)


def test_write_connectivity_is_row_major_upper_triangle(tmp_path):
    v, t = octahedron()
    n = 6
    conn = np.zeros((n, n), np.float32)
    for i in range(n):
        for j in range(i + 1, n):
            conn[i, j] = conn[j, i] = 10 * i + j
    mg.write_glyphset(tmp_path / "w", "x", [("pial", v)], t, conn, dtype="float32")
    raw = np.fromfile(tmp_path / "w" / "connectivity.f32", dtype="<f4")
    assert raw.tolist() == [10 * i + j for i in range(n) for j in range(i + 1, n)]


def test_write_single_mesh_defaults_to_no_hemisphere_split(tmp_path):
    v, t = icosphere(1)
    mg.write_glyphset(tmp_path / "w", "x", [("pial", v)], t, sym_matrix(42, 1))
    man = json.loads((tmp_path / "w" / "glyphset.json").read_text())
    assert man["nodes"] == 42 and man["leftNodes"] == 0 and man["leftTriangles"] == 0
    assert "mask" not in man


def test_write_extra_keys_are_merged_into_the_manifest(tmp_path, two_hemi):
    out = _write(tmp_path, two_hemi, extra={"source": "somewhere", "subjects": 3})
    man = json.loads((out / "glyphset.json").read_text())
    assert man["source"] == "somewhere" and man["subjects"] == 3
    assert man["nodes"] == 12


def test_write_creates_missing_parent_folders(tmp_path):
    v, t = octahedron()
    out = tmp_path / "a" / "b" / "c"
    mg.write_glyphset(out, "x", [("pial", v)], t, sym_matrix(6, 1))
    assert (out / "glyphset.json").is_file()


def test_write_rejects_matrix_of_the_wrong_size(tmp_path):
    v, t = octahedron()
    with pytest.raises(AssertionError):
        mg.write_glyphset(tmp_path / "w", "x", [("pial", v)], t, sym_matrix(7, 1))


def test_write_rejects_surfaces_with_different_node_counts(tmp_path):
    v, t = octahedron()
    v2, _ = icosphere(0)
    with pytest.raises(AssertionError):
        mg.write_glyphset(tmp_path / "w", "x", [("pial", v), ("sphere", v2)], t, sym_matrix(6, 1))


def test_write_accepts_a_memory_mapped_matrix(tmp_path):
    v, t = octahedron()
    m = sym_matrix(6, 9)
    np.save(tmp_path / "m.npy", m)
    mg.write_glyphset(tmp_path / "w", "x", [("pial", v)], t, np.load(tmp_path / "m.npy", mmap_mode="r"), dtype="float32")
    assert np.array_equal(np.fromfile(tmp_path / "w" / "connectivity.f32", "<f4"), m[np.triu_indices(6, k=1)])


# ================================================================== from-matrix
@pytest.fixture
def hemi_files(tmp_path):
    """Three surfaces per hemisphere as GIFTI and as .asc, a matrix as raw float32 and .npy."""
    src = tmp_path / "src"
    src.mkdir()
    lv, lt = octahedron(10, (-3, 1, 0))            # x in [-13, 7]
    rv, rt = icosphere(0)                          # 12 nodes, 20 triangles
    rv = (rv * 10 + np.array([3, -1, 0], np.float32)).astype(np.float32)   # x in [-7, 13] at most
    geo = {
        "pial": (lv, rv),
        "inflated": ((lv * 1.5).astype(np.float32), (rv * 1.5).astype(np.float32)),
        "sphere": ((OCT_V * 100).astype(np.float32), (icosphere(0)[0] * 100).astype(np.float32)),
    }
    d = {"dir": src, "geo": geo, "lt": lt, "rt": rt, "n": 18, "ln": 6, "ntl": 8,
         "gii_l": [], "gii_r": [], "asc_l": [], "asc_r": []}
    for name, (l, r) in geo.items():
        d["gii_l"].append(write_gii_surface(src / f"lh.{name}.gii", l, lt))
        d["gii_r"].append(write_gii_surface(src / f"rh.{name}.gii", r, rt))
        d["asc_l"].append(write_asc(src / f"lh.{name}.asc", l, lt))
        d["asc_r"].append(write_asc(src / f"rh.{name}.asc", r, rt))
    d["conn"] = sym_matrix(18, 200)
    d["conn"].astype("<f4").tofile(src / "conn.bin")
    np.save(src / "conn.npy", d["conn"])
    return d


def _expected_separated(l, r, gap=5.0):
    """Closed form of the default hemisphere separation."""
    shift = (float(l[:, 0].max()) - float(r[:, 0].min()) + gap) / 2
    if shift <= 0:
        return l, r
    return l + np.array([-shift, 0, 0], np.float32), r + np.array([shift, 0, 0], np.float32)


def test_from_matrix_two_hemispheres_manifest(tmp_path, hemi_files):
    d = hemi_files
    out = tmp_path / "web"
    cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.bin", "--out", out)
    man = json.loads((out / "glyphset.json").read_text())
    assert man["nodes"] == 18
    assert man["leftNodes"] == 6            # left nodes come first
    assert man["leftTriangles"] == 8
    assert [s["name"] for s in man["surfaces"]] == ["pial", "inflated", "sphere"]   # from lh.<name>.gii
    assert man["name"] == "web"             # default: name of the output folder
    assert man["connectivity"]["dtype"] == "int8"
    assert "mask" not in man


def test_from_matrix_triangles_are_left_then_right_with_offset(tmp_path, hemi_files):
    d = hemi_files
    out = tmp_path / "web"
    cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.bin", "--out", out)
    tri = read_web(out)["triangles"]
    assert tri.shape == (8 + 20, 3)
    assert np.array_equal(tri[:8], d["lt"])
    assert np.array_equal(tri[8:], d["rt"] + 6)
    assert tri[:8].max() < 6 and tri[8:].min() >= 6


def test_from_matrix_separates_inflated_and_spherical_hemispheres_by_default(tmp_path, hemi_files):
    d = hemi_files
    out = tmp_path / "web"
    cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.bin", "--out", out)
    web = read_web(out)
    for name in ("inflated", "sphere"):
        l, r = d["geo"][name]
        got = web["surfaces"][name]
        el, er = _expected_separated(l, r)
        assert np.allclose(got[:6], el, atol=1e-4), name
        assert np.allclose(got[6:], er, atol=1e-4), name
        assert got[6:, 0].min() - got[:6, 0].max() == pytest.approx(5.0, abs=1e-4), name
    # "sphere": an octahedron (x up to 100) and an icosahedron (x down to -100 * phi / sqrt(1 + phi^2))
    # around the origin; each is moved by half of (overlap + 5)
    phi = (1 + math.sqrt(5)) / 2
    shift = (100 + 100 * phi / math.sqrt(1 + phi * phi) + 5) / 2
    assert web["surfaces"]["sphere"][:6].mean(axis=0) == pytest.approx([-shift, 0, 0], abs=1e-3)
    assert web["surfaces"]["sphere"][6:].mean(axis=0) == pytest.approx([shift, 0, 0], abs=1e-3)


def test_from_matrix_leaves_the_pial_surface_in_place(tmp_path, hemi_files):
    """Anatomical surfaces share a coordinate system: they must keep their
    coordinates even when the hemispheres touch (here they overlap by 14 mm)."""
    d = hemi_files
    out = tmp_path / "web"
    cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.bin", "--out", out)
    l, r = d["geo"]["pial"]
    assert l[:, 0].max() > r[:, 0].min()
    assert np.array_equal(read_web(out)["surfaces"]["pial"], np.vstack([l, r]))


@pytest.mark.parametrize("label,moved", [("pial", False), ("white", False), ("midthickness", False),
                                         ("inflated", True), ("very_inflated", True), ("sphere", True)])
def test_from_matrix_separation_depends_on_the_kind_of_surface(tmp_path, label, moved):
    lv, lt = octahedron(10, (-3, 0, 0))
    rv, rt = octahedron(10, (3, 0, 0))                # overlap: 14 mm
    left = write_gii_surface(tmp_path / f"L.{label}.surf.gii", lv, lt)
    right = write_gii_surface(tmp_path / f"R.{label}.surf.gii", rv, rt)
    out = tmp_path / "web"
    cli("from-matrix", "--left", left, "--right", right, "--matrix", _square(tmp_path, 12, 3), "--out", out)
    web = read_web(out)
    assert list(web["surfaces"]) == [label]
    got = web["surfaces"][label]
    if moved:
        assert got[6:, 0].min() - got[:6, 0].max() == pytest.approx(5.0, abs=1e-4)
        assert np.allclose(got[:6], lv + np.array([-9.5, 0, 0], np.float32), atol=1e-5)      # (14 + 5) / 2
        assert np.allclose(got[6:], rv + np.array([9.5, 0, 0], np.float32), atol=1e-5)
    else:
        assert np.array_equal(got, np.vstack([lv, rv]))


def test_from_matrix_no_separate_keeps_coordinates(tmp_path, hemi_files):
    d = hemi_files
    out = tmp_path / "web"
    cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.bin",
        "--no-separate", "--out", out)
    web = read_web(out)
    for name, (l, r) in d["geo"].items():
        assert np.array_equal(web["surfaces"][name], np.vstack([l, r])), name


def test_from_matrix_connectivity_within_quantisation(tmp_path, hemi_files):
    d = hemi_files
    out = tmp_path / "web"
    cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.bin", "--out", out)
    web = read_web(out)
    conn = d["conn"].astype(np.float64)
    assert web["scale"] == pytest.approx(np.abs(offdiag(conn)).max() / 127, rel=1e-6)
    assert np.abs(offdiag(web["conn"]) - offdiag(conn)).max() <= web["scale"] / 2 * (1 + 1e-4)


@pytest.mark.parametrize("dtype,top", [("int16", 32767), ("float32", None)])
def test_from_matrix_dtype_option(tmp_path, hemi_files, dtype, top):
    d = hemi_files
    out = tmp_path / "web"
    cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.npy",
        "--dtype", dtype, "--out", out)
    web = read_web(out)
    assert web["manifest"]["connectivity"]["dtype"] == dtype
    tol = 0 if top is None else np.abs(offdiag(d["conn"])).max() / top / 2 * (1 + 1e-4)
    assert np.abs(offdiag(web["conn"]) - offdiag(d["conn"].astype(np.float64))).max() <= tol


def test_from_matrix_npy_and_raw_matrix_give_the_same_result(tmp_path, hemi_files):
    d = hemi_files
    for kind in ("bin", "npy"):
        cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / f"conn.{kind}",
            "--out", tmp_path / kind)
    assert (tmp_path / "bin" / "connectivity.i8").read_bytes() == (tmp_path / "npy" / "connectivity.i8").read_bytes()


def test_from_matrix_asc_and_gifti_surfaces_give_the_same_result(tmp_path, hemi_files):
    d = hemi_files
    cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.bin", "--out", tmp_path / "g")
    cli("from-matrix", "--left", *d["asc_l"], "--right", *d["asc_r"], "--matrix", d["dir"] / "conn.bin", "--out", tmp_path / "a")
    g, a = read_web(tmp_path / "g"), read_web(tmp_path / "a")
    assert [s["name"] for s in a["manifest"]["surfaces"]] == ["pial", "inflated", "sphere"]   # from lh.<name>.asc
    assert np.array_equal(g["triangles"], a["triangles"])
    for name in g["surfaces"]:
        assert np.allclose(g["surfaces"][name], a["surfaces"][name], atol=1e-5)
    assert np.array_equal(g["raw"], a["raw"])


def test_from_matrix_single_mesh(tmp_path, hemi_files):
    d = hemi_files
    out = tmp_path / "web"
    cli("from-matrix", "--left", d["gii_l"][0], d["gii_l"][1], "--matrix", _square(tmp_path, 6, 5), "--out", out)
    web = read_web(out)
    man = web["manifest"]
    assert man["nodes"] == 6 and man["leftNodes"] == 0 and man["leftTriangles"] == 0
    assert np.array_equal(web["triangles"], d["lt"])
    assert np.array_equal(web["surfaces"]["pial"], d["geo"]["pial"][0])       # a lone mesh is never shifted
    assert np.array_equal(web["surfaces"]["inflated"], d["geo"]["inflated"][0])


def _square(tmp_path, n, seed):
    p = tmp_path / f"square{n}_{seed}.bin"
    sym_matrix(n, seed).astype("<f4").tofile(p)
    return p


def test_from_matrix_names_and_name_options(tmp_path, hemi_files):
    d = hemi_files
    out = tmp_path / "web"
    cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.bin",
        "--names", "a,b,c", "--name", "My set", "--out", out)
    man = json.loads((out / "glyphset.json").read_text())
    assert man["name"] == "My set"
    assert [(s["name"], s["file"]) for s in man["surfaces"]] == [("a", "a.f32"), ("b", "b.f32"), ("c", "c.f32")]
    assert all((out / f).is_file() for f in ("a.f32", "b.f32", "c.f32"))


def test_from_matrix_name_from_freesurfer_binary_file(tmp_path):
    v, t = icosphere(0)
    nib.freesurfer.write_geometry(str(tmp_path / "lh.inflated"), v.astype(np.float64), t)
    out = tmp_path / "web"
    cli("from-matrix", "--left", tmp_path / "lh.inflated", "--matrix", _square(tmp_path, 12, 1), "--out", out)
    web = read_web(out)
    assert list(web["surfaces"]) == ["inflated"]
    assert np.allclose(web["surfaces"]["inflated"], v, atol=1e-5)


def test_from_matrix_default_names_for_surf_gii_files(tmp_path):
    """GIFTI's standard '<hemi>.<name>.surf.gii': every surface keeps its own name and file."""
    v, t = octahedron(10)
    pial = write_gii_surface(tmp_path / "L.pial.surf.gii", v, t)
    infl = write_gii_surface(tmp_path / "L.inflated.surf.gii", v * 2, t)
    out = tmp_path / "web"
    cli("from-matrix", "--left", pial, infl, "--matrix", _square(tmp_path, 6, 1), "--out", out)
    man = json.loads((out / "glyphset.json").read_text())
    assert [(s["name"], s["file"]) for s in man["surfaces"]] == [("pial", "pial.f32"), ("inflated", "inflated.f32")]
    web = read_web(out)
    assert np.array_equal(web["surfaces"]["pial"], v)
    assert np.array_equal(web["surfaces"]["inflated"], v * 2)


@pytest.mark.parametrize("filename,expected", [
    ("lh.pial", "pial"),                                              # FreeSurfer binary
    ("rh.white", "white"),
    ("lh.sphere", "sphere"),
    ("L.inflated.asc", "inflated"),                                   # brainGL
    ("lh.pial.gii", "pial"),
    ("L.midthickness.surf.gii", "midthickness"),                      # Connectome Workbench
    ("sub.L.pial.32k_fs_LR.surf.gii", "pial"),
    ("S1200.L.very_inflated_MSMAll.32k_fs_LR.surf.gii", "very_inflated"),
    ("pial_left.gii.gz", "pial"),                                     # nilearn's fsaverage files
])
def test_from_matrix_default_surface_name(tmp_path, filename, expected):
    v, t = octahedron(10)
    path = tmp_path / filename
    if filename.endswith(".asc"):
        write_asc(path, v, t)
    elif filename.endswith(".gii.gz"):
        import gzip
        write_gii_surface(tmp_path / "plain.gii", v, t)
        with gzip.open(path, "wb") as fh:
            fh.write((tmp_path / "plain.gii").read_bytes())
    elif filename.endswith(".gii"):
        write_gii_surface(path, v, t)
    else:
        nib.freesurfer.write_geometry(str(path), v.astype(np.float64), t)
    out = tmp_path / "web"
    cli("from-matrix", "--left", path, "--matrix", _square(tmp_path, 6, 1), "--out", out)
    web = read_web(out)
    assert list(web["surfaces"]) == [expected]
    assert web["manifest"]["surfaces"][0]["file"] == expected + ".f32"
    assert np.allclose(web["surfaces"][expected], v, atol=1e-5)


@pytest.mark.xfail(strict=True,
                   reason="KNOWN BUG tools/make_glyphset.py cmd_from_matrix / write_glyphset (:121-123): surface names "
                          "are not checked for duplicates. Two files with the same label (FreeSurfer's lh.sphere and "
                          "lh.sphere.reg, or --names a,a) are both written to <name>.f32, the second overwriting the "
                          "first, and the manifest lists the surviving surface twice (silent data loss)")
def test_from_matrix_surfaces_with_the_same_label_do_not_overwrite_each_other(tmp_path):
    v, t = icosphere(0)
    nib.freesurfer.write_geometry(str(tmp_path / "lh.sphere"), v.astype(np.float64) * 100, t)
    nib.freesurfer.write_geometry(str(tmp_path / "lh.sphere.reg"), v[:, [1, 2, 0]].astype(np.float64) * 100, t)
    out = tmp_path / "web"
    try:
        cli("from-matrix", "--left", tmp_path / "lh.sphere", tmp_path / "lh.sphere.reg",
            "--matrix", _square(tmp_path, 12, 1), "--out", out)
    except SystemExit as e:
        assert e.code not in (0, None)          # refusing with an error message is fine as well
        return
    man = json.loads((out / "glyphset.json").read_text())
    files = [s["file"] for s in man["surfaces"]]
    assert len(set(files)) == 2, f"both surfaces were written to {files[0]}"
    first = np.fromfile(out / files[0], dtype="<f4").reshape(-1, 3)
    assert np.allclose(first, v * 100, atol=1e-4)


def test_from_matrix_overlays_are_concatenated_left_then_right(tmp_path, hemi_files):
    d = hemi_files
    rng = np.random.default_rng(30)
    sl, sr = rng.normal(size=6).astype(np.float32), rng.normal(size=12).astype(np.float32)
    cl, cr = rng.normal(size=6).astype(np.float32), rng.normal(size=12).astype(np.float32)
    np.save(d["dir"] / "lh.sulc.npy", sl)
    np.save(d["dir"] / "rh.sulc.npy", sr)
    write_gii_scalars(d["dir"] / "lh.curv.shape.gii", cl)
    nib.freesurfer.write_morph_data(str(d["dir"] / "rh.curv"), cr)
    out = tmp_path / "web"
    cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.bin",
        "--overlay", f"sulc={d['dir'] / 'lh.sulc.npy'},{d['dir'] / 'rh.sulc.npy'}",
        "--overlay", f"curv={d['dir'] / 'lh.curv.shape.gii'},{d['dir'] / 'rh.curv'}", "--out", out)
    web = read_web(out)
    assert list(web["overlays"]) == ["sulc", "curv"]
    assert np.array_equal(web["overlays"]["sulc"], np.concatenate([sl, sr]))
    assert np.allclose(web["overlays"]["curv"], np.concatenate([cl, cr]))


def test_from_matrix_rejects_overlay_of_the_wrong_length(tmp_path, hemi_files):
    """A left-hemisphere-only overlay for a two-hemisphere glyphset would be
    dropped silently by the browser (src/data/loadWeb.ts), so the tool refuses it."""
    d = hemi_files
    np.save(d["dir"] / "lh.sulc.npy", np.arange(6, dtype=np.float32))   # 6 values for 18 nodes
    with pytest.raises((SystemExit, AssertionError, ValueError)) as e:
        cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", d["dir"] / "conn.bin",
            "--overlay", f"sulc={d['dir'] / 'lh.sulc.npy'}", "--out", tmp_path / "web")
    if isinstance(e.value, SystemExit):
        assert e.value.code not in (0, None)
    assert not (tmp_path / "web" / "glyphset.json").exists()            # nothing half-written is left behind


def test_from_matrix_rejects_matrix_with_the_wrong_node_count(tmp_path, hemi_files):
    d = hemi_files
    with pytest.raises((SystemExit, AssertionError)):
        cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", _square(tmp_path, 12, 1),
            "--out", tmp_path / "web")
    np.save(tmp_path / "m12.npy", sym_matrix(12, 1))
    with pytest.raises((SystemExit, AssertionError)):
        cli("from-matrix", "--left", *d["gii_l"], "--right", *d["gii_r"], "--matrix", tmp_path / "m12.npy",
            "--out", tmp_path / "web2")


def test_from_matrix_requires_left_out_and_matrix():
    for argv in (["from-matrix", "--out", "x", "--matrix", "m"],
                 ["from-matrix", "--left", "a", "--matrix", "m"],
                 ["from-matrix", "--left", "a", "--out", "x"],
                 []):
        with pytest.raises(SystemExit) as e:
            mg.main(argv)
        assert e.value.code == 2


def test_cli_subprocess_from_matrix(tmp_path, hemi_files):
    """The real command line: python tools/make_glyphset.py from-matrix ..."""
    d = hemi_files
    out = tmp_path / "web"
    res = subprocess.run(
        [sys.executable, "-B", str(TOOL), "from-matrix", "--left", *d["asc_l"], "--right", *d["asc_r"],
         "--matrix", str(d["dir"] / "conn.bin"), "--dtype", "int16", "--out", str(out)],
        capture_output=True, text=True, timeout=120)
    assert res.returncode == 0, res.stderr
    assert "18 nodes" in res.stdout
    web = read_web(out)
    assert web["n"] == 18 and web["manifest"]["leftNodes"] == 6
    assert np.abs(offdiag(web["conn"]) - offdiag(d["conn"].astype(np.float64))).max() <= web["scale"] / 2 * (1 + 1e-4)


def test_cli_subprocess_help_lists_the_sub_commands():
    res = subprocess.run([sys.executable, "-B", str(TOOL), "--help"], capture_output=True, text=True, timeout=120)
    assert res.returncode == 0
    for cmd in ("from-matrix", "from-timeseries", "nki-demo", "to-braingl"):
        assert cmd in res.stdout


# ============================================================== from-timeseries
def test_from_timeseries_npy_single_mesh(tmp_path):
    v, t = icosphere(0)
    surf = write_gii_surface(tmp_path / "lh.pial.gii", v * 50, t)
    rng = np.random.default_rng(40)
    ts = (rng.normal(size=(12, 120)) + rng.normal(size=(1, 120))).astype(np.float32)
    np.save(tmp_path / "ts.npy", ts)
    out = tmp_path / "web"
    cli("from-timeseries", "--left", surf, "--timeseries", tmp_path / "ts.npy", "--dtype", "int16", "--out", out)
    web = read_web(out)
    expected = np.corrcoef(ts.astype(np.float64))
    assert web["n"] == 12
    assert np.abs(offdiag(web["conn"]) - offdiag(expected)).max() <= web["scale"] / 2 + 1e-5
    assert not (out / "_conn.npy").exists()       # the temporary matrix is removed
    man = web["manifest"]
    referenced = {"glyphset.json", man["triangles"], man["connectivity"]["file"]} | {s["file"] for s in man["surfaces"]}
    if "mask" in man:
        referenced.add(man["mask"])
        assert web["mask"].tolist() == [1] * 12   # every node has a signal
    assert {p.name for p in out.iterdir()} == referenced


def test_from_timeseries_func_gifti_two_hemispheres(tmp_path, hemi_files):
    d = hemi_files
    rng = np.random.default_rng(41)
    common = rng.normal(size=(1, 80))
    tl = (rng.normal(size=(6, 80)) + common).astype(np.float32)
    tr = (rng.normal(size=(12, 80)) - common).astype(np.float32)
    fl = write_gii_scalars(d["dir"] / "lh.func.gii", tl)
    fr = write_gii_scalars(d["dir"] / "rh.func.gii", tr)
    out = tmp_path / "web"
    cli("from-timeseries", "--left", *d["gii_l"], "--right", *d["gii_r"], "--timeseries", fl, fr,
        "--dtype", "float32", "--out", out)
    web = read_web(out)
    expected = np.corrcoef(np.vstack([tl, tr]).astype(np.float64))     # left nodes first
    assert web["n"] == 18 and web["manifest"]["leftNodes"] == 6
    assert np.abs(offdiag(web["conn"]) - offdiag(expected)).max() < 1e-5
    assert [s["name"] for s in web["manifest"]["surfaces"]] == ["pial", "inflated", "sphere"]


def test_from_timeseries_empty_time_series_have_zero_connectivity(tmp_path):
    v, t = icosphere(0)
    surf = write_gii_surface(tmp_path / "lh.pial.gii", v * 50, t)
    rng = np.random.default_rng(42)
    ts = rng.normal(size=(12, 60)).astype(np.float32)
    ts[[2, 9]] = 0                                    # medial wall
    np.save(tmp_path / "ts.npy", ts)
    out = tmp_path / "web"
    cli("from-timeseries", "--left", surf, "--timeseries", tmp_path / "ts.npy", "--dtype", "float32", "--out", out)
    conn = read_web(out)["conn"]
    assert not conn[[2, 9], :].any() and not conn[:, [2, 9]].any()
    keep = [i for i in range(12) if i not in (2, 9)]
    assert np.abs(offdiag(conn[np.ix_(keep, keep)]) - offdiag(np.corrcoef(ts[keep].astype(np.float64)))).max() < 1e-5


def test_from_timeseries_writes_a_mask_for_empty_time_series(tmp_path):
    """Nodes without signal (medial wall: all zero, or constant) are masked, as in nki-demo."""
    v, t = icosphere(0)
    surf = write_gii_surface(tmp_path / "lh.pial.gii", v * 50, t)
    ts = np.random.default_rng(43).normal(size=(12, 60)).astype(np.float32)
    ts[2] = 0
    ts[9] = 4.25
    np.save(tmp_path / "ts.npy", ts)
    out = tmp_path / "web"
    cli("from-timeseries", "--left", surf, "--timeseries", tmp_path / "ts.npy", "--out", out)
    web = read_web(out)
    assert web["mask"] is not None
    assert web["mask"].tolist() == [1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1]
    assert (out / "mask.u8").stat().st_size == 12


def test_from_timeseries_mask_covers_both_hemispheres(tmp_path, hemi_files):
    d = hemi_files
    rng = np.random.default_rng(44)
    tl = rng.normal(size=(6, 40)).astype(np.float32)
    tr = rng.normal(size=(12, 40)).astype(np.float32)
    tl[5] = 0
    tr[0] = 0
    np.save(d["dir"] / "l.npy", tl)
    np.save(d["dir"] / "r.npy", tr)
    out = tmp_path / "web"
    cli("from-timeseries", "--left", *d["gii_l"], "--right", *d["gii_r"],
        "--timeseries", d["dir"] / "l.npy", d["dir"] / "r.npy", "--out", out)
    expected = [1] * 18
    expected[5] = 0            # last left node
    expected[6] = 0            # first right node
    assert read_web(out)["mask"].tolist() == expected


def test_from_timeseries_removes_its_temporary_matrix_after_an_error(tmp_path):
    v, t = icosphere(0)
    surf = write_gii_surface(tmp_path / "lh.pial.gii", v * 50, t)
    np.save(tmp_path / "ts.npy", np.random.default_rng(45).normal(size=(7, 30)).astype(np.float32))   # 7 rows, 12 nodes
    out = tmp_path / "web"
    with pytest.raises((SystemExit, AssertionError)):
        cli("from-timeseries", "--left", surf, "--timeseries", tmp_path / "ts.npy", "--out", out)
    assert not (out / "_conn.npy").exists()


# =================================================================== to-braingl
@pytest.fixture
def web_two_hemi(tmp_path, two_hemi):
    return _write(tmp_path, two_hemi), two_hemi


def test_to_braingl_writes_the_expected_files(tmp_path, web_two_hemi):
    web, d = web_two_hemi
    out = tmp_path / "bgl"
    cli("to-braingl", web, "--out", out)
    expected = {"data.glyphset", "L.set", "R.set", "connectivity.bin"}
    expected |= {f"{h}.{s}.asc" for h in "LR" for s in ("pial", "inflated", "sphere")}
    assert {p.name for p in out.iterdir()} == expected


def test_to_braingl_glyphset_file_has_three_lines(tmp_path, web_two_hemi):
    """Line 1: anatomy; line 2: left.set right.set; line 3: matrix + minimum threshold
    (the format parseGlyphsetFile in src/io/glyphsetFiles.ts reads)."""
    web, d = web_two_hemi
    out = tmp_path / "bgl"
    cli("to-braingl", web, "--out", out, "--min-threshold", "0.25")
    lines = (out / "data.glyphset").read_text().split("\n")
    assert lines[-1] == "" and len(lines) == 4
    assert lines[0].strip() != ""
    assert lines[1].split() == ["L.set", "R.set"]         # left hemisphere first
    tok = lines[2].split()
    assert tok[0] == "connectivity.bin" and float(tok[1]) == 0.25
    assert (out / tok[0]).is_file()


def test_to_braingl_default_threshold(tmp_path, web_two_hemi):
    web, d = web_two_hemi
    out = tmp_path / "bgl"
    cli("to-braingl", web, "--out", out)
    assert float((out / "data.glyphset").read_text().split("\n")[2].split()[1]) == 0.5


def test_to_braingl_set_files_list_existing_surfaces_in_order(tmp_path, web_two_hemi):
    web, d = web_two_hemi
    out = tmp_path / "bgl"
    cli("to-braingl", web, "--out", out)
    for h in "LR":
        names = [l.split()[0] for l in (out / f"{h}.set").read_text().split("\n") if l.strip()]
        assert names == [f"{h}.pial.asc", f"{h}.inflated.asc", f"{h}.sphere.asc"]
        assert all((out / n).is_file() for n in names)


def test_to_braingl_asc_surfaces_per_hemisphere(tmp_path, web_two_hemi):
    web, d = web_two_hemi
    out = tmp_path / "bgl"
    cli("to-braingl", web, "--out", out)
    for name, xyz in d["surfaces"]:
        lx, lt = read_asc(out / f"L.{name}.asc")
        rx, rt = read_asc(out / f"R.{name}.asc")
        assert lx.shape == (6, 3) and rx.shape == (6, 3)
        assert np.allclose(lx, xyz[:6], atol=1e-5) and np.allclose(rx, xyz[6:], atol=1e-5)
        assert np.array_equal(lt, d["tri"][:8])
        assert np.array_equal(rt, d["tri"][8:] - 6)        # right triangles are re-based to 0
        assert rt.min() == 0 and rt.max() == 5


def test_to_braingl_asc_is_readable_by_the_tool_itself(tmp_path, web_two_hemi):
    web, d = web_two_hemi
    out = tmp_path / "bgl"
    cli("to-braingl", web, "--out", out)
    xyz, tri = mg.load_surface(out / "R.inflated.asc")
    assert np.allclose(xyz, d["surfaces"][1][1][6:], atol=1e-5)
    assert np.array_equal(tri, d["tri"][8:] - 6)


def test_to_braingl_matrix_is_full_float32_symmetric_unit_diagonal(tmp_path, web_two_hemi):
    web, d = web_two_hemi
    out = tmp_path / "bgl"
    cli("to-braingl", web, "--out", out)
    assert (out / "connectivity.bin").stat().st_size == 12 * 12 * 4
    m = np.fromfile(out / "connectivity.bin", dtype="<f4").reshape(12, 12)
    assert np.array_equal(m, m.T)
    assert np.array_equal(np.diag(m), np.ones(12, np.float32))
    ref = read_web(web)
    assert np.allclose(offdiag(m), offdiag(ref["conn"]), atol=1e-7)          # = integer * scale
    conn = d["conn"].astype(np.float64)
    assert np.abs(offdiag(m) - offdiag(conn)).max() <= ref["scale"] / 2 * (1 + 1e-4)


@pytest.mark.parametrize("dtype,top", [("int16", 32767), ("float32", None)])
def test_to_braingl_matrix_other_dtypes(tmp_path, two_hemi, dtype, top):
    web = _write(tmp_path, two_hemi, dtype=dtype)
    out = tmp_path / "bgl"
    cli("to-braingl", web, "--out", out)
    m = np.fromfile(out / "connectivity.bin", dtype="<f4").reshape(12, 12)
    conn = two_hemi["conn"]
    if top is None:
        assert np.array_equal(offdiag(m), offdiag(conn))
    else:
        step = np.abs(offdiag(conn)).max() / top
        assert np.abs(offdiag(m).astype(np.float64) - offdiag(conn)).max() <= step / 2 * (1 + 1e-3) + 1e-7


def test_to_braingl_single_mesh(tmp_path):
    v, t = icosphere(0)
    conn = sym_matrix(12, 50)
    mg.write_glyphset(tmp_path / "web", "x", [("pial", v * 40), ("sphere", v * 100)], t, conn, dtype="float32")
    out = tmp_path / "bgl"
    cli("to-braingl", tmp_path / "web", "--out", out)
    assert {p.name for p in out.iterdir()} == {"data.glyphset", "all.set", "pial.asc", "sphere.asc", "connectivity.bin"}
    lines = (out / "data.glyphset").read_text().split("\n")
    assert lines[1].split() == ["all.set"]
    assert (out / "all.set").read_text().split() == ["pial.asc", "sphere.asc"]
    xyz, tri = read_asc(out / "sphere.asc")
    assert np.allclose(xyz, v * 100, atol=1e-5) and np.array_equal(tri, t)
    m = np.fromfile(out / "connectivity.bin", dtype="<f4").reshape(12, 12)
    assert np.array_equal(offdiag(m), offdiag(conn))


def test_to_braingl_reads_full_layout_manifests(tmp_path):
    """A hand-written glyphset with a full (not upper-triangle) int16 matrix."""
    v, t = octahedron(10)
    web = tmp_path / "web"
    web.mkdir()
    rng = np.random.default_rng(60)
    raw = rng.integers(-1000, 1000, size=(6, 6)).astype("<i2")
    raw.tofile(web / "c.i16")
    v.astype("<f4").tofile(web / "pial.f32")
    t.astype("<u4").tofile(web / "tri.u32")
    (web / "glyphset.json").write_text(json.dumps({
        "format": "braingl-web-glyphset", "version": 1, "name": "full", "nodes": 6, "triangles": "tri.u32",
        "surfaces": [{"name": "pial", "file": "pial.f32"}],
        "connectivity": {"file": "c.i16", "dtype": "int16", "layout": "full", "scale": 0.001}}))
    out = tmp_path / "bgl"
    cli("to-braingl", web, "--out", out)
    m = np.fromfile(out / "connectivity.bin", dtype="<f4").reshape(6, 6)
    assert np.allclose(m, raw.astype(np.float64) * 0.001, atol=1e-7)     # diagonal included, row-major
    xyz, tri = read_asc(out / "pial.asc")
    assert np.allclose(xyz, v) and np.array_equal(tri, t)


def test_cli_subprocess_to_braingl(tmp_path, web_two_hemi):
    web, d = web_two_hemi
    out = tmp_path / "bgl"
    res = subprocess.run([sys.executable, "-B", str(TOOL), "to-braingl", str(web), "--out", str(out)],
                         capture_output=True, text=True, timeout=120)
    assert res.returncode == 0, res.stderr
    assert "data.glyphset" in res.stdout
    assert (out / "data.glyphset").is_file() and (out / "connectivity.bin").stat().st_size == 12 * 12 * 4


# =================================================================== round trips
def _braingl_to_web(bgl, out, *extra):
    """Follow data.glyphset -> .set -> .asc as brainGL does and convert back."""
    lines = (bgl / "data.glyphset").read_text().split("\n")
    sets = lines[1].split()
    matrix = lines[2].split()[0]
    surf = [[bgl / l.split()[0] for l in (bgl / s).read_text().split("\n") if l.strip()] for s in sets]
    args = ["from-matrix", "--left", *surf[0]]
    if len(surf) > 1:
        args += ["--right", *surf[1]]
    cli(*args, "--matrix", bgl / matrix, "--out", out, *extra)


@pytest.mark.parametrize("dtype", ["int8", "int16", "float32"])
def test_round_trip_web_braingl_web(tmp_path, two_hemi, dtype):
    web = _write(tmp_path, two_hemi, dtype=dtype)
    cli("to-braingl", web, "--out", tmp_path / "bgl")
    _braingl_to_web(tmp_path / "bgl", tmp_path / "web2", "--no-separate", "--dtype", dtype)
    a, b = read_web(web), read_web(tmp_path / "web2")
    assert b["n"] == a["n"] == 12
    assert b["manifest"]["leftNodes"] == 6 and b["manifest"]["leftTriangles"] == 8
    assert [s["name"] for s in b["manifest"]["surfaces"]] == ["pial", "inflated", "sphere"]
    assert np.array_equal(a["triangles"], b["triangles"])
    for name in a["surfaces"]:
        assert np.allclose(a["surfaces"][name], b["surfaces"][name], atol=1e-5), name
    assert np.array_equal(a["raw"], b["raw"])                 # the same stored integers / floats
    assert b["scale"] == pytest.approx(a["scale"], rel=1e-6)
    # and both are the original matrix within half a quantisation step
    tol = 0 if dtype == "float32" else a["scale"] / 2 * (1 + 1e-4)
    assert np.abs(offdiag(b["conn"]) - offdiag(two_hemi["conn"].astype(np.float64))).max() <= tol + 1e-7


def test_round_trip_keeps_separated_hemispheres_where_they_are(tmp_path, two_hemi):
    """Surfaces that are already more than 5 mm apart survive the default (separating) import."""
    web = _write(tmp_path, two_hemi)
    cli("to-braingl", web, "--out", tmp_path / "bgl")
    _braingl_to_web(tmp_path / "bgl", tmp_path / "web2")
    a, b = read_web(web), read_web(tmp_path / "web2")
    for name in ("pial", "inflated"):           # 20 and 30 mm apart
        assert np.allclose(a["surfaces"][name], b["surfaces"][name], atol=1e-5), name


def test_round_trip_braingl_web_braingl(tmp_path, hemi_files):
    """Original brainGL files (.asc + raw float32 matrix) -> web -> brainGL."""
    d = hemi_files
    cli("from-matrix", "--left", *d["asc_l"], "--right", *d["asc_r"], "--matrix", d["dir"] / "conn.bin",
        "--no-separate", "--dtype", "int16", "--out", tmp_path / "web")
    cli("to-braingl", tmp_path / "web", "--out", tmp_path / "bgl")
    for name, (l, r) in d["geo"].items():
        lx, lt = read_asc(tmp_path / "bgl" / f"L.{name}.asc")
        rx, rt = read_asc(tmp_path / "bgl" / f"R.{name}.asc")
        assert np.allclose(lx, l, atol=1e-5) and np.allclose(rx, r, atol=1e-5), name
        assert np.array_equal(lt, d["lt"]) and np.array_equal(rt, d["rt"]), name
    m = np.fromfile(tmp_path / "bgl" / "connectivity.bin", dtype="<f4").reshape(18, 18)
    conn = d["conn"].astype(np.float64)
    step = np.abs(offdiag(conn)).max() / 32767
    assert np.abs(offdiag(m) - offdiag(conn)).max() <= step / 2 * (1 + 1e-3) + 1e-7
    assert np.array_equal(np.diag(m), np.ones(18, np.float32))


def test_round_trip_single_mesh(tmp_path):
    v, t = icosphere(1)
    conn = sym_matrix(42, 70)
    mg.write_glyphset(tmp_path / "web", "x", [("pial", v * 60), ("sphere", v * 100)], t, conn)
    cli("to-braingl", tmp_path / "web", "--out", tmp_path / "bgl")
    _braingl_to_web(tmp_path / "bgl", tmp_path / "web2")
    a, b = read_web(tmp_path / "web"), read_web(tmp_path / "web2")
    assert b["manifest"]["leftNodes"] == 0 and b["manifest"]["leftTriangles"] == 0
    assert list(b["surfaces"]) == ["pial", "sphere"]
    assert np.array_equal(a["triangles"], b["triangles"])
    assert np.allclose(a["surfaces"]["sphere"], b["surfaces"]["sphere"], atol=1e-5)
    assert np.array_equal(a["raw"], b["raw"])


# ===================================================================== nki-demo
def _fake_nki(tmp_path, monkeypatch, subjects, mesh_level):
    """Local stand-ins for nilearn's fetchers: fsaverage5-sized icospheres and
    random 'resting-state' time series.  Nothing is downloaded."""
    datasets = pytest.importorskip("nilearn.datasets")
    v5, t5 = icosphere(5)
    assert v5.shape == (10242, 3)
    vk, tk = icosphere(mesh_level)
    nk = vk.shape[0]
    src = tmp_path / "nilearn_data"
    src.mkdir()
    rng = np.random.default_rng(900)
    fs5, fs, geo, scal = {}, {}, {}, {}
    for h, sign in (("left", -1), ("right", 1)):
        fs5[f"pial_{h}"] = write_gii_surface(src / f"fs5_pial_{h}.gii", v5 * 70 + [sign * 40, 0, 0], t5)
        for key, radius, off in (("pial", 60, 35), ("white", 55, 35), ("infl", 80, 0), ("sphere", 100, 0)):
            xyz = (vk * radius + np.array([sign * off, 0, 0])).astype(np.float32)
            geo[key, h] = xyz
            fs[f"{key}_{h}"] = write_gii_surface(src / f"{key}_{h}.gii", xyz, tk)
        for key in ("sulc", "curv"):
            scal[key, h] = rng.normal(size=nk).astype(np.float32)
            fs[f"{key}_{h}"] = write_gii_scalars(src / f"{key}_{h}.gii", scal[key, h])
    ts = {}
    nki = {"func_left": [], "func_right": []}
    for s in range(subjects):
        shared = rng.normal(size=(1, 24))
        for h in ("left", "right"):
            x = (rng.normal(size=(10242, 24)) + 0.7 * shared).astype(np.float32)
            x[[3, 50, 700, 9000]] = 0                       # medial wall, in every subject
            if s == 1 and h == "left":
                x[17] = 0                                   # missing in one subject only
            ts[s, h] = x
            nki[f"func_{h}"].append(write_gii_scalars(src / f"sub{s}_{h}.func.gii", x))
    calls = []

    def fetch_surf_nki_enhanced(n_subjects=10, data_dir=None, **kw):
        calls.append(("nki", n_subjects))
        return {k: v[:n_subjects] for k, v in nki.items()}

    def fetch_surf_fsaverage(mesh="fsaverage5", data_dir=None, **kw):
        calls.append(("fsaverage", mesh))
        return fs5 if mesh == "fsaverage5" else fs

    monkeypatch.setattr(datasets, "fetch_surf_nki_enhanced", fetch_surf_nki_enhanced)
    monkeypatch.setattr(datasets, "fetch_surf_fsaverage", fetch_surf_fsaverage)
    return {"t5": t5, "tk": tk, "nk": nk, "geo": geo, "scal": scal, "ts": ts, "calls": calls}


def _expected_group_average(fake, hemis, subjects):
    """Fisher-z average of the per-subject correlations of the 1-ring averaged
    time series, by brute force in float64."""
    nk = fake["nk"]
    zsum = np.zeros((nk * len(hemis), nk * len(hemis)))
    valid = np.ones(nk * len(hemis), bool)
    for s in range(subjects):
        ts = np.vstack([_brute_average(fake["ts"][s, h], fake["t5"], nk) for h in hemis])
        ok = ts.std(axis=1) > 1e-6
        r = np.zeros_like(zsum)
        r[np.ix_(ok, ok)] = np.corrcoef(ts[ok])
        valid &= ok
        zsum += np.arctanh(np.clip(r, -0.999999, 0.999999))
    r = np.tanh(zsum / subjects)
    r[~valid, :] = 0
    r[:, ~valid] = 0
    np.fill_diagonal(r, 0)
    return r, valid


def test_nki_demo_group_average_on_local_synthetic_data(tmp_path, monkeypatch):
    fake = _fake_nki(tmp_path, monkeypatch, subjects=2, mesh_level=3)     # 642 nodes: "fsaverage3"
    out = tmp_path / "web"
    cli("nki-demo", "--subjects", 2, "--mesh", "fsaverage3", "--hemi", "both", "--dtype", "float32", "--out", out)
    web = read_web(out)
    nk = fake["nk"]
    assert nk == 642
    man = web["manifest"]
    assert man["nodes"] == 2 * nk and man["leftNodes"] == nk and man["leftTriangles"] == len(fake["tk"])
    assert man["subjects"] == 2
    assert [s["name"] for s in man["surfaces"]] == ["pial", "inflated", "sphere", "white"]
    assert list(web["overlays"]) == ["sulc", "curv"]
    assert ("nki", 2) in fake["calls"] and ("fsaverage", "fsaverage3") in fake["calls"]

    expected, valid = _expected_group_average(fake, ["left", "right"], 2)
    assert web["mask"].tolist() == valid.astype(int).tolist()
    assert web["mask"][[3, 50, 17]].tolist() == [0, 0, 0]          # empty in all / in one subject
    assert web["mask"].sum() == 2 * nk - 5                           # 3, 50 left and right, 17 left
    assert np.abs(web["conn"] - expected).max() < 2e-4

    # anatomical surfaces stay where they are, inflated and sphere are moved apart
    for name, key in (("pial", "pial"), ("white", "white")):
        assert np.array_equal(web["surfaces"][name], np.vstack([fake["geo"][key, "left"], fake["geo"][key, "right"]]))
    for name, key, radius in (("inflated", "infl", 80), ("sphere", "sphere", 100)):
        got = web["surfaces"][name]
        assert got[nk:, 0].min() - got[:nk, 0].max() == pytest.approx(5.0, abs=1e-3)
        assert got[:nk].mean(axis=0) == pytest.approx([-(radius + 2.5), 0, 0], abs=1e-2)
    assert np.array_equal(web["triangles"], np.vstack([fake["tk"], fake["tk"] + nk]))
    assert np.array_equal(web["overlays"]["sulc"], np.concatenate([fake["scal"]["sulc", "left"], fake["scal"]["sulc", "right"]]))
    assert np.array_equal(web["overlays"]["curv"], np.concatenate([fake["scal"]["curv", "left"], fake["scal"]["curv", "right"]]))


def test_nki_demo_single_hemisphere(tmp_path, monkeypatch):
    fake = _fake_nki(tmp_path, monkeypatch, subjects=1, mesh_level=3)
    out = tmp_path / "web"
    cli("nki-demo", "--subjects", 1, "--mesh", "fsaverage3", "--hemi", "rh", "--dtype", "int16", "--out", out)
    web = read_web(out)
    nk = fake["nk"]
    assert web["n"] == nk and web["manifest"]["leftNodes"] == 0 and web["manifest"]["leftTriangles"] == 0
    assert np.array_equal(web["surfaces"]["sphere"], fake["geo"]["sphere", "right"])     # a lone hemisphere is not moved
    assert np.array_equal(web["triangles"], fake["tk"])
    expected, valid = _expected_group_average(fake, ["right"], 1)
    assert web["mask"].tolist() == valid.astype(int).tolist()
    assert np.abs(web["conn"] - expected).max() <= web["scale"] / 2 + 2e-4
