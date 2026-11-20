"""Tests for public/blender/import_braingl.py (the Blender importer of brainGL-web scenes).

Run it either inside Blender or with the stand-alone ``bpy`` module:

    blender --background --python tests/blender/test_import.py
    python tests/blender/test_import.py            # a Python that has `bpy` and numpy

No pytest is needed: the file has its own small runner that prints one
PASS / FAIL / SKIP / XFAIL line per case and exits non-zero when a case fails.
(The cases are plain ``test_*`` functions without fixtures, so pytest can
collect the file as well.)  Set ``BRAINGL_BLENDER_TESTS=substring`` to run only
the cases whose name contains the substring.

Every case writes its own tiny scene (scene.json + binary PLY layers in the
byte layout of ``writePly`` in src/export/ply.ts) into a temporary folder and
starts from an empty Blender file.  Expected values are closed forms computed
here, not copies of what the importer returns.

A defect of the importer that cannot be fixed at once can be documented with
``@known_bug``: such a case is reported as XFAIL while the defect exists and as
FAIL once it is fixed, so that the mark gets removed. (No case is marked at
present.)
"""
import contextlib
import functools
import importlib.util
import io
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import traceback
import unittest
import warnings

import numpy as np

try:
    import bpy
except ImportError:                       # e.g. `pytest tests` in an environment without Blender
    if "pytest" in sys.modules:
        import pytest
        pytest.skip("needs Blender's bpy module", allow_module_level=True)
    raise SystemExit("tests/blender/test_import.py must run inside Blender (blender --background --python ...) "
                     "or with a Python that has the bpy module")
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(REPO, "public", "blender", "import_braingl.py")
#: True inside the Blender application, False with the stand-alone bpy module
IN_BLENDER_APP = bool(bpy.app.binary_path)


def load_importer(path=SCRIPT, name="import_braingl_under_test"):
    """Import the script as a module (its ``main()`` only runs as ``__main__``)."""
    old = sys.dont_write_bytecode
    sys.dont_write_bytecode = True          # leave no __pycache__ next to the script
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = old
    return module


ib = load_importer()


# ------------------------------------------------------------------ runner bits
class Skip(unittest.SkipTest):
    """Raised by a case that cannot run in this environment."""


class UnexpectedPass(Exception):
    pass


def known_bug(reason, strict=True):
    """Expected failure: the wrapped case must fail with an AssertionError."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper():
            wrapper.hit = False
            try:
                fn()
            except AssertionError:
                wrapper.hit = True
                return
            if strict:
                raise UnexpectedPass(f"passes although it is marked as a known bug ({reason}); remove the mark")
        wrapper.known_bug = reason
        wrapper.hit = False
        return wrapper
    return deco


def approx(a, b, tol=1e-5):
    return np.allclose(np.asarray(a, float), np.asarray(b, float), rtol=0, atol=tol)


# ------------------------------------------------------------ scene on disk
def write_ply(path, xyz, rgba, faces=None, edges=None, kind="mesh", name="layer"):
    """Binary little-endian PLY, byte for byte as writePly() in src/export/ply.ts:
    vertex = 3 float32 + 4 uchar, face = uchar 3 + 3 int32, edge = 2 int32."""
    nv = len(xyz)
    nf = 0 if faces is None else len(faces)
    ne = 0 if edges is None else len(edges)
    header = (f"ply\nformat binary_little_endian 1.0\ncomment brainGL-web {kind} layer: {name}\n"
              f"element vertex {nv}\nproperty float x\nproperty float y\nproperty float z\n"
              "property uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\n")
    if nf:
        header += f"element face {nf}\nproperty list uchar int vertex_indices\n"
    if ne:
        header += f"element edge {ne}\nproperty int vertex1\nproperty int vertex2\n"
    header += "end_header\n"
    data = bytearray(header.encode("utf-8"))
    for p, c in zip(np.asarray(xyz, float).tolist(), np.asarray(rgba).tolist()):
        data += struct.pack("<3f4B", *p, *c)
    for f in (np.asarray(faces).tolist() if nf else []):
        data += struct.pack("<B3i", 3, *f)
    for e in (np.asarray(edges).tolist() if ne else []):
        data += struct.pack("<2i", *e)
    assert len(data) == len(header.encode("utf-8")) + nv * 16 + nf * 13 + ne * 8
    with open(path, "wb") as fh:
        fh.write(data)


def layer_entry(file, name, kind, shading, n, smooth=False, opacity=1, radius=0, truncated=False):
    """One entry of scene.json's "layers", as buildBundleFiles() writes it."""
    return {"file": file, "name": name, "kind": kind, "shading": shading, "smooth": smooth, "opacity": opacity,
            "radius": radius, "vertices": n, "truncated": truncated}


OCT_V = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], np.float32)
OCT_F = np.array([[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]], np.int32)

# a surface (lit), point glyphs, connections (both flat) and pie glyphs (flat mesh)
SURF_XYZ = (OCT_V * np.array([70, 90, 60], np.float32) + np.array([0, -15, 10], np.float32)).astype(np.float32)
SURF_RGBA = np.array([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 128], [128, 128, 128, 255],
                      [10, 20, 30, 0], [200, 150, 100, 255]], np.uint8)
PTS_XYZ = np.array([[0, 0, 0], [12.5, -3, 40], [-60, 20, 5], [33, 80, -41], [1, 2, 3]], np.float32)
PTS_RGBA = np.array([[255, 255, 255, 255], [0, 0, 0, 255], [51, 102, 153, 255], [5, 250, 77, 200], [128, 64, 32, 255]], np.uint8)
PTS_RADIUS = 0.75
SEG_XYZ = np.array([[0, 0, 0], [30, 0, 0], [30, 0, 40], [10, 25, 55]], np.float32)   # along x, along z, oblique
SEG_RGBA = np.array([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [240, 240, 16, 255]], np.uint8)
SEG_EDGES = np.array([[0, 1], [1, 2], [2, 3]], np.int32)
SEG_RADIUS = 0.5
PIE_XYZ = np.array([[0, 0, 0], [5, 0, 0], [0, 5, 0], [0, 0, 5]], np.float32)
PIE_F = np.array([[0, 1, 2], [0, 2, 3]], np.int32)
PIE_RGBA = np.array([[230, 25, 75, 255]] * 4, np.uint8)
BACKGROUND = [0.2, 0.4, 0.6]


def camera_from_view(forward, up, target, half_height, aspect, distance):
    """scene.json "camera" for a view direction, built like buildBundleFiles() does
    (src/export/blenderBundle.ts) but without quaternion algebra from a library:
    the camera sits `distance` behind the target, looks down its local -Z, +Y is up."""
    f = np.asarray(forward, float)
    f /= np.linalg.norm(f)
    r = np.cross(f, np.asarray(up, float))
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    m = np.column_stack([r, u, -f])                   # camera -> world rotation
    # rotation matrix -> quaternion (w, x, y, z)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1) * 2
        q = [s / 4, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [(m[2, 1] - m[1, 2]) / s, s / 4, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, s / 4, (m[1, 2] + m[2, 1]) / s]
    else:
        s = math.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, s / 4]
    target = np.asarray(target, float)
    spec = {"type": "ORTHO", "location": (target - f * distance).tolist(), "rotation_quaternion": q,
            "ortho_scale": 2 * half_height * max(1, aspect), "aspect": aspect}
    return spec, {"forward": f, "right": r, "up": u, "target": target, "half_height": half_height, "aspect": aspect}


CAMERA, VIEW = camera_from_view(forward=(0.6, 0.64, -0.48), up=(0, 0, 1), target=(5, -10, 12),
                                half_height=110, aspect=1.6, distance=900)


def write_scene(folder, camera=CAMERA, title="unit test", layers=("surface", "points", "segments", "pies"),
                background=BACKGROUND, surface_opacity=0.6, fmt="braingl-blender-scene"):
    os.makedirs(folder, exist_ok=True)
    entries = []
    if "surface" in layers:
        write_ply(os.path.join(folder, "surface_pial.ply"), SURF_XYZ, SURF_RGBA, faces=OCT_F, kind="mesh", name="surface pial")
        entries.append(layer_entry("surface_pial.ply", "surface pial", "mesh", "lit", 6, smooth=True, opacity=surface_opacity))
    if "points" in layers:
        write_ply(os.path.join(folder, "glyphs_points.ply"), PTS_XYZ, PTS_RGBA, kind="points", name="glyphs points")
        entries.append(layer_entry("glyphs_points.ply", "glyphs points", "points", "flat", 5, radius=PTS_RADIUS, truncated=True))
    if "segments" in layers:
        write_ply(os.path.join(folder, "connections.ply"), SEG_XYZ, SEG_RGBA, edges=SEG_EDGES, kind="segments", name="connections")
        entries.append(layer_entry("connections.ply", "connections", "segments", "flat", 4, radius=SEG_RADIUS))
    if "pies" in layers:
        write_ply(os.path.join(folder, "glyphs_pies.ply"), PIE_XYZ, PIE_RGBA, faces=PIE_F, kind="mesh", name="glyphs pies")
        entries.append(layer_entry("glyphs_pies.ply", "glyphs pies", "mesh", "flat", 4, smooth=False))
    scene = {"format": fmt, "version": 1, "title": title, "units": "mm", "background": background,
             "camera": camera, "layers": entries}
    with open(os.path.join(folder, "scene.json"), "w") as fh:
        json.dump(scene, fh, indent=1)
    return folder


@contextlib.contextmanager
def scene_dir(**kw):
    with tempfile.TemporaryDirectory(prefix="braingl_blender_test_") as tmp:
        yield write_scene(os.path.join(tmp, "scene"), **kw)


def fresh():
    """Empty Blender file: no objects, no world, default render settings."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    assert len(bpy.data.objects) == 0


# ------------------------------------------------------------ Blender helpers
def srgb8_to_linear(v):
    """IEC 61966-2-1 transfer function for 8-bit values (independent of the importer)."""
    c = np.asarray(v, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def expected_linear_rgba(rgba):
    out = np.zeros((len(rgba), 4))
    out[:, :3] = srgb8_to_linear(np.asarray(rgba)[:, :3])
    out[:, 3] = np.asarray(rgba)[:, 3] / 255.0        # alpha is not gamma encoded
    return out


def mesh_vertices(mesh):
    co = np.zeros(len(mesh.vertices) * 3, np.float32)
    mesh.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def mesh_faces(mesh):
    return [tuple(p.vertices) for p in mesh.polygons]


def mesh_colors(mesh, name="Col"):
    attr = mesh.color_attributes[name]
    col = np.zeros(len(attr.data) * 4, np.float32)
    attr.data.foreach_get("color", col)
    return col.reshape(-1, 4)


def material_nodes(mat):
    nodes = {n.bl_idname: n for n in mat.node_tree.nodes}
    links = {(l.from_node.bl_idname, l.from_socket.name, l.to_node.bl_idname, l.to_socket.name) for l in mat.node_tree.links}
    return nodes, links


def camera_axes(cam):
    bpy.context.view_layer.update()
    m = np.array(cam.matrix_world)
    return m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3]      # right, up, backward, location


def project(cam, points):
    """Normalised image coordinates (0..1, origin bottom left) of world points."""
    bpy.context.view_layer.update()
    scene = bpy.context.scene
    return np.array([world_to_camera_view(scene, cam, Vector([float(c) for c in p]))[:2] for p in np.asarray(points)])


def dist_to_axis(p, a, b):
    d = (b - a) / np.linalg.norm(b - a)
    rel = p - a
    return np.linalg.norm(rel - np.outer(rel @ d, d), axis=1)


def run_script_cli(script, args, timeout=600):
    """Run the importer the way a user does: as a script with options after `--`."""
    if IN_BLENDER_APP:
        cmd = [bpy.app.binary_path, "--background", "--factory-startup", "--python-exit-code", "1", "--python", script, "--", *args]
    else:
        cmd = [sys.executable, "-B", script, "--", *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def read_png(path):
    """8-bit RGBA rows (bottom row first) of a rendered still."""
    img = bpy.data.images.load(path)
    w, h = img.size
    px = (np.array(img.pixels[:]).reshape(h, w, 4) * 255).round()
    bpy.data.images.remove(img)
    return px


# ======================================================================== PLY
def test_read_ply_mesh_layer():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "m.ply")
        write_ply(path, SURF_XYZ, SURF_RGBA, faces=OCT_F)
        xyz, rgba, faces, edges = ib.read_ply(path)
    assert xyz.shape == (6, 3) and xyz.dtype == np.float32
    assert rgba.shape == (6, 4) and rgba.dtype == np.uint8
    assert faces.shape == (8, 3) and faces.dtype == np.int32
    assert edges.shape == (0, 2)
    assert np.array_equal(xyz, SURF_XYZ)
    assert np.array_equal(rgba, SURF_RGBA)
    assert np.array_equal(faces, OCT_F)


def test_read_ply_points_layer():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "p.ply")
        write_ply(path, PTS_XYZ, PTS_RGBA, kind="points")
        xyz, rgba, faces, edges = ib.read_ply(path)
    assert np.array_equal(xyz, PTS_XYZ) and np.array_equal(rgba, PTS_RGBA)
    assert faces.shape == (0, 3) and edges.shape == (0, 2)


def test_read_ply_segments_layer():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "s.ply")
        write_ply(path, SEG_XYZ, SEG_RGBA, edges=SEG_EDGES, kind="segments")
        xyz, rgba, faces, edges = ib.read_ply(path)
    assert np.array_equal(xyz, SEG_XYZ) and np.array_equal(rgba, SEG_RGBA)
    assert faces.shape == (0, 3)
    assert edges.shape == (3, 2) and edges.dtype == np.int32
    assert np.array_equal(edges, SEG_EDGES)


def test_read_ply_faces_and_edges_in_one_file():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "fe.ply")
        write_ply(path, SURF_XYZ, SURF_RGBA, faces=OCT_F[:3], edges=[[0, 5], [4, 1]])
        xyz, rgba, faces, edges = ib.read_ply(path)
    assert np.array_equal(faces, OCT_F[:3])
    assert np.array_equal(edges, [[0, 5], [4, 1]])


def test_read_ply_extreme_values_survive():
    xyz = np.array([[-1e6, 1e-6, 0], [3.4e38, -3.4e38, 123.456]], np.float32)
    rgba = np.array([[0, 0, 0, 0], [255, 255, 255, 255]], np.uint8)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "x.ply")
        write_ply(path, xyz, rgba, faces=[[0, 1, 0]])
        got = ib.read_ply(path)
    assert np.array_equal(got[0], xyz) and np.array_equal(got[1], rgba)
    assert np.array_equal(got[2], [[0, 1, 0]])


def test_read_ply_layer_name_with_keywords_in_the_comment():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "c.ply")
        write_ply(path, PTS_XYZ, PTS_RGBA, name="element vertex 99 format ascii")
        xyz, _, _, _ = ib.read_ply(path)
    assert len(xyz) == 5


def test_read_ply_empty_layer():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "e.ply")
        write_ply(path, np.zeros((0, 3)), np.zeros((0, 4), np.uint8))
        xyz, rgba, faces, edges = ib.read_ply(path)
    assert xyz.shape == (0, 3) and rgba.shape == (0, 4) and faces.shape == (0, 3) and edges.shape == (0, 2)


def test_read_ply_rejects_other_files():
    with tempfile.TemporaryDirectory() as tmp:
        cases = {
            "not a ply": b"solid nothing\nendsolid\n",
            "ascii ply": b"ply\nformat ascii 1.0\nelement vertex 0\nend_header\n",
            "big endian ply": b"ply\nformat binary_big_endian 1.0\nelement vertex 0\nend_header\n",
            "header without end": b"ply\nformat binary_little_endian 1.0\nelement vertex 3\n",
        }
        for label, content in cases.items():
            path = os.path.join(tmp, "bad.ply")
            with open(path, "wb") as fh:
                fh.write(content)
            try:
                ib.read_ply(path)
            except ValueError:
                continue
            raise AssertionError(f"{label}: read_ply did not raise ValueError")


def test_read_ply_rejects_truncated_data():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "t.ply")
        write_ply(path, SURF_XYZ, SURF_RGBA, faces=OCT_F)
        with open(path, "rb") as fh:
            data = fh.read()
        with open(path, "wb") as fh:
            fh.write(data[:-20])
        try:
            ib.read_ply(path)
        except ValueError:
            return
    raise AssertionError("a PLY whose face block is cut short was read without an error")


# ============================================================== expand_points
def test_expand_points_shapes_and_colours():
    v, c, f = ib.expand_points(PTS_XYZ, PTS_RGBA, PTS_RADIUS)
    assert v.shape == (30, 3) and c.shape == (30, 4) and f.shape == (40, 3)     # octahedra: 6 vertices, 8 faces
    assert np.array_equal(c.reshape(5, 6, 4), np.repeat(PTS_RGBA[:, None, :], 6, axis=1))
    assert c.dtype == np.uint8


def test_expand_points_centre_and_radius():
    for radius in (0.25, 0.75, 12.0):
        v, _, _ = ib.expand_points(PTS_XYZ, PTS_RGBA, radius)
        groups = v.reshape(5, 6, 3)
        assert approx(groups.mean(axis=1), PTS_XYZ, 1e-4)                      # centred on the point
        dist = np.linalg.norm(groups - PTS_XYZ[:, None, :], axis=2)
        assert approx(dist, radius, 1e-4)                                      # every vertex on the sphere
        # the six vertices are the +-x, +-y, +-z poles
        offs = np.sort((groups - PTS_XYZ[:, None, :]).reshape(5, 18), axis=1)
        assert approx(offs[:, :3], -radius, 1e-4) and approx(offs[:, -3:], radius, 1e-4) and approx(offs[:, 3:-3], 0, 1e-4)


def test_expand_points_faces_are_closed_and_point_outward():
    radius = 2.0
    v, _, f = ib.expand_points(PTS_XYZ, PTS_RGBA, radius)
    for k in range(5):
        faces = f[8 * k:8 * k + 8]
        assert faces.min() == 6 * k and faces.max() == 6 * k + 5               # only its own vertices
        directed = [(a, b) for tri in faces.tolist() for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0]))]
        assert len(set(directed)) == 24                                        # 12 edges, each used once per direction
        assert all((b, a) in set(directed) for a, b in directed)               # watertight and consistently wound
        p = v[faces].astype(np.float64) - PTS_XYZ[k]
        volume = np.einsum("ij,ij->i", p[:, 0], np.cross(p[:, 1], p[:, 2])).sum() / 6
        assert abs(volume - 4 / 3 * radius ** 3) < 1e-3                        # positive: normals point outward


def test_expand_points_does_not_modify_its_input():
    xyz, rgba = PTS_XYZ.copy(), PTS_RGBA.copy()
    ib.expand_points(xyz, rgba, 1.0)
    assert np.array_equal(xyz, PTS_XYZ) and np.array_equal(rgba, PTS_RGBA)


# ============================================================ expand_segments
SEGMENT_CASES = {
    "along x": ([0, 0, 0], [10, 0, 0]),
    "along -y": ([1, 2, 3], [1, -7, 3]),
    "along z": ([0, 0, 0], [0, 0, 5]),
    "along -z": ([4, 4, 4], [4, 4, -6]),
    "steep": ([0, 0, 0], [1, 1, 10]),
    "oblique": ([-3, 2, 1], [5, -4, 7]),
}


def _tube(a, b, radius=0.5):
    xyz = np.array([a, b], np.float32)
    rgba = np.array([[255, 0, 0, 255], [0, 0, 255, 128]], np.uint8)
    v, c, f = ib.expand_segments(xyz, rgba, np.array([[0, 1]], np.int32), radius)
    return xyz.astype(np.float64), v.astype(np.float64), c, f


def test_expand_segments_shapes_and_colours():
    v, c, f = ib.expand_segments(SEG_XYZ, SEG_RGBA, SEG_EDGES, SEG_RADIUS)
    assert v.shape == (18, 3) and v.dtype == np.float32                        # 3-sided tube: 2 x 3 vertices
    assert c.shape == (18, 4) and f.shape == (18, 3)                           # 3 quads = 6 triangles
    for k, (i, j) in enumerate(SEG_EDGES.tolist()):
        assert np.array_equal(c[6 * k:6 * k + 3], np.repeat(SEG_RGBA[i][None], 3, axis=0))       # start ring
        assert np.array_equal(c[6 * k + 3:6 * k + 6], np.repeat(SEG_RGBA[j][None], 3, axis=0))   # end ring
        assert f[6 * k:6 * k + 6].min() == 6 * k and f[6 * k:6 * k + 6].max() == 6 * k + 5


def test_expand_segments_vertices_lie_at_radius_from_the_axis():
    for label, (a, b) in SEGMENT_CASES.items():
        for radius in (0.5, 3.0):
            xyz, v, _, _ = _tube(a, b, radius)
            assert approx(dist_to_axis(v, xyz[0], xyz[1]), radius, 1e-4), label


def test_expand_segments_rings_sit_at_the_two_ends():
    for label, (a, b) in SEGMENT_CASES.items():
        xyz, v, _, _ = _tube(a, b)
        d = (xyz[1] - xyz[0]) / np.linalg.norm(xyz[1] - xyz[0])
        along = (v - xyz[0]) @ d
        assert approx(along[:3], 0, 1e-4), label                               # ring around the start point
        assert approx(along[3:], np.linalg.norm(xyz[1] - xyz[0]), 1e-4), label  # ring around the end point
        assert approx(v[:3].mean(axis=0), xyz[0], 1e-4) and approx(v[3:].mean(axis=0), xyz[1], 1e-4), label
        assert approx(v[3:] - v[:3], xyz[1] - xyz[0], 1e-4), label             # a straight prism, no twist


def test_expand_segments_ring_is_an_equilateral_triangle():
    for label, (a, b) in SEGMENT_CASES.items():
        radius = 2.0
        _, v, _, _ = _tube(a, b, radius)
        side = radius * math.sqrt(3)
        for ring in (v[:3], v[3:]):
            sides = [np.linalg.norm(ring[i] - ring[(i + 1) % 3]) for i in range(3)]
            assert approx(sides, side, 1e-4), label


def test_expand_segments_side_walls_point_outward_and_cover_the_prism():
    for label, (a, b) in SEGMENT_CASES.items():
        radius = 1.5
        xyz, v, _, f = _tube(a, b, radius)
        d = (xyz[1] - xyz[0]) / np.linalg.norm(xyz[1] - xyz[0])
        tri = v[f]
        normal = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        centre = tri.mean(axis=1) - xyz[0]
        radial = centre - np.outer(centre @ d, d)
        assert (np.einsum("ij,ij->i", normal, radial) > 0).all(), label        # consistent, outward winding
        area = np.linalg.norm(normal, axis=1).sum() / 2
        expected = 3 * radius * math.sqrt(3) * np.linalg.norm(xyz[1] - xyz[0])  # three rectangular walls
        assert abs(area - expected) < 1e-3 * expected, label


def test_expand_segments_zero_length_segment_stays_finite():
    xyz, v, _, f = _tube([1, 2, 3], [1, 2, 3], 0.5)
    assert np.isfinite(v).all()
    assert np.linalg.norm(v - xyz[0], axis=1).max() <= 0.5 + 1e-5
    assert f.shape == (6, 3)


def test_expand_segments_does_not_modify_its_input():
    xyz, rgba, edges = SEG_XYZ.copy(), SEG_RGBA.copy(), SEG_EDGES.copy()
    ib.expand_segments(xyz, rgba, edges, 1.0)
    assert np.array_equal(xyz, SEG_XYZ) and np.array_equal(rgba, SEG_RGBA) and np.array_equal(edges, SEG_EDGES)


# ============================================================= srgb_to_linear
def test_srgb_to_linear_closed_form():
    got = ib.srgb_to_linear(np.array([0, 10, 11, 128, 255], np.uint8))
    assert approx(got[0], 0.0, 1e-9) and approx(got[4], 1.0, 1e-6)
    assert approx(got[1], 10 / 255 / 12.92, 1e-7)                              # linear toe: 10/255 < 0.04045
    assert approx(got[2], ((11 / 255 + 0.055) / 1.055) ** 2.4, 1e-7)           # power segment
    assert approx(got[3], 0.2158605, 1e-6)                                     # the familiar value of mid grey


def test_srgb_to_linear_all_byte_values():
    values = np.arange(256, dtype=np.uint8)
    got = ib.srgb_to_linear(values)
    assert approx(got, srgb8_to_linear(values), 1e-6)
    assert (np.diff(got) > 0).all()                                            # strictly increasing, no uint8 overflow
    # the inverse transfer function gives the bytes back
    back = np.where(got <= 0.0031308, got * 12.92, 1.055 * np.power(got, 1 / 2.4) - 0.055) * 255
    assert approx(back, values, 1e-2)


def test_srgb_to_linear_keeps_the_shape():
    got = ib.srgb_to_linear(SURF_RGBA[:, :3])
    assert got.shape == (6, 3)
    assert approx(got, srgb8_to_linear(SURF_RGBA[:, :3]), 1e-6)


# ================================================================ scene import
def test_import_creates_one_object_per_layer():
    fresh()
    with scene_dir() as d:
        spec, aspect, objects = ib.import_scene(d)
    assert [o.name for o in objects] == ["surface pial", "glyphs points", "connections", "glyphs pies"]
    assert all(o.type == "MESH" for o in objects)
    assert [o["braingl_kind"] for o in objects] == ["mesh", "points", "segments", "mesh"]
    assert spec["title"] == "unit test" and aspect == 1.6
    assert {o.name: o.type for o in bpy.data.objects} == {
        "surface pial": "MESH", "glyphs points": "MESH", "connections": "MESH", "glyphs pies": "MESH",
        "brainGL camera": "CAMERA", "brainGL headlight": "LIGHT"}


def test_import_puts_everything_into_one_collection_of_the_scene():
    fresh()
    with scene_dir() as d:
        ib.import_scene(d)
    coll = bpy.data.collections["brainGL: unit test"]
    assert coll.name in bpy.context.scene.collection.children
    assert {o.name for o in coll.objects} == {o.name for o in bpy.data.objects}
    assert {o.name for o in bpy.context.scene.objects} == {o.name for o in bpy.data.objects}


def test_import_mesh_layer_geometry_is_exact():
    fresh()
    with scene_dir() as d:
        ib.import_scene(d)
    mesh = bpy.data.objects["surface pial"].data
    assert len(mesh.vertices) == 6 and len(mesh.polygons) == 8 and len(mesh.edges) == 12
    assert np.array_equal(mesh_vertices(mesh), SURF_XYZ)
    assert mesh_faces(mesh) == [tuple(f) for f in OCT_F.tolist()]
    assert all(p.loop_total == 3 for p in mesh.polygons)
    assert all(p.use_smooth for p in mesh.polygons)                             # "smooth": true
    # outward winding is preserved: face normals point away from the centre
    centre = SURF_XYZ.mean(axis=0)
    assert all((np.array(p.center) - centre) @ np.array(p.normal) > 0 for p in mesh.polygons)


def test_import_colour_attribute_is_linear_rgb_with_straight_alpha():
    fresh()
    with scene_dir() as d:
        ib.import_scene(d)
    for name, rgba in (("surface pial", SURF_RGBA), ("glyphs pies", PIE_RGBA), ("glyphs points", PTS_RGBA)):
        mesh = bpy.data.objects[name].data
        attr = mesh.color_attributes.get("Col")
        assert attr is not None, name
        assert attr.domain == "POINT" and attr.data_type == "FLOAT_COLOR", name
        assert approx(mesh_colors(mesh), expected_linear_rgba(rgba), 1e-6), name
    # spot values: sRGB 128 -> 0.2159 linear, alpha 128 -> 0.502 (not gamma decoded)
    col = mesh_colors(bpy.data.objects["surface pial"].data)
    assert approx(col[3], [0.2158605, 0.2158605, 0.2158605, 1.0], 1e-6)
    assert approx(col[2], [0, 0, 1, 128 / 255], 1e-6)


def test_import_points_as_point_cloud_nodes():
    """--points nodes (the default): bare vertices + a geometry-nodes modifier."""
    fresh()
    with scene_dir() as d:
        objects = ib.main([d, "--points", "nodes"])
    obj = bpy.data.objects["glyphs points"]
    assert obj in objects
    mesh = obj.data
    assert len(mesh.vertices) == 5 and len(mesh.polygons) == 0 and len(mesh.edges) == 0
    assert np.array_equal(mesh_vertices(mesh), PTS_XYZ)
    mods = [m for m in obj.modifiers if m.type == "NODES"]
    assert len(mods) == 1 and mods[0].node_group is not None
    nodes = {n.bl_idname: n for n in mods[0].node_group.nodes}
    assert approx(nodes["GeometryNodeMeshToPoints"].inputs["Radius"].default_value, PTS_RADIUS, 1e-6)
    assert nodes["GeometryNodeSetMaterial"].inputs["Material"].default_value == mesh.materials[0]


def test_import_point_cloud_evaluates_to_points_with_radius_and_colour():
    fresh()
    with scene_dir() as d:
        ib.import_scene(d, points_mode="nodes")
    obj = bpy.data.objects["glyphs points"]
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    if not hasattr(evaluated, "evaluated_geometry"):
        raise Skip("Object.evaluated_geometry() needs Blender 4.4 or newer")
    geometry = evaluated.evaluated_geometry()       # keep the set alive: it owns the point cloud
    cloud = geometry.pointcloud
    assert cloud is not None and len(cloud.points) == 5
    pos = np.zeros(15, np.float32)
    cloud.attributes["position"].data.foreach_get("vector", pos)
    assert np.array_equal(pos.reshape(5, 3), PTS_XYZ)
    radius = np.zeros(5, np.float32)
    cloud.attributes["radius"].data.foreach_get("value", radius)
    assert approx(radius, PTS_RADIUS, 1e-6)
    col = np.zeros(20, np.float32)
    cloud.attributes["Col"].data.foreach_get("color", col)                      # the data colours reach the renderer
    assert approx(col.reshape(5, 4), expected_linear_rgba(PTS_RGBA), 1e-6)
    assert [m.name for m in cloud.materials] == ["brainGL glyphs points"]


def test_import_points_default_mode_is_nodes():
    fresh()
    with scene_dir() as d:
        ib.main([d])
    obj = bpy.data.objects["glyphs points"]
    assert len(obj.data.vertices) == 5 and [m.type for m in obj.modifiers] == ["NODES"]


def test_import_points_as_mesh_octahedra():
    """--points mesh: every point becomes an octahedron of the layer's radius."""
    fresh()
    with scene_dir() as d:
        ib.main([d, "--points", "mesh"])
    obj = bpy.data.objects["glyphs points"]
    mesh = obj.data
    assert len(obj.modifiers) == 0
    assert len(mesh.vertices) == 5 * 6 and len(mesh.polygons) == 5 * 8 and len(mesh.edges) == 5 * 12
    groups = mesh_vertices(mesh).reshape(5, 6, 3).astype(np.float64)
    assert approx(groups.mean(axis=1), PTS_XYZ, 1e-4)
    assert approx(np.linalg.norm(groups - PTS_XYZ[:, None, :], axis=2), PTS_RADIUS, 1e-4)
    assert approx(mesh_colors(mesh), np.repeat(expected_linear_rgba(PTS_RGBA), 6, axis=0), 1e-6)
    # faces of glyph k only use the vertices of glyph k, and point away from its centre
    for k, p in enumerate(mesh.polygons):
        g = k // 8
        assert all(6 * g <= v < 6 * g + 6 for v in p.vertices)
        assert (np.array(p.center) - PTS_XYZ[g]) @ np.array(p.normal) > 0
    assert obj["braingl_kind"] == "points"


def test_import_segments_become_tubes():
    fresh()
    with scene_dir() as d:
        ib.import_scene(d)
    mesh = bpy.data.objects["connections"].data
    assert len(mesh.vertices) == 3 * 6 and len(mesh.polygons) == 3 * 6        # per segment: 6 vertices, 6 triangles
    v = mesh_vertices(mesh).astype(np.float64)
    col = mesh_colors(mesh)
    expect_col = expected_linear_rgba(SEG_RGBA)
    for k, (i, j) in enumerate(SEG_EDGES.tolist()):
        a, b = SEG_XYZ[i].astype(np.float64), SEG_XYZ[j].astype(np.float64)
        ring = v[6 * k:6 * k + 6]
        assert approx(dist_to_axis(ring, a, b), SEG_RADIUS, 1e-4)
        assert approx(ring[:3].mean(axis=0), a, 1e-4) and approx(ring[3:].mean(axis=0), b, 1e-4)
        assert approx(col[6 * k:6 * k + 3], np.repeat(expect_col[i][None], 3, axis=0), 1e-6)
        assert approx(col[6 * k + 3:6 * k + 6], np.repeat(expect_col[j][None], 3, axis=0), 1e-6)
    assert all(p.loop_total == 3 for p in mesh.polygons)


def test_import_materials_lit_and_flat():
    fresh()
    with scene_dir() as d:
        ib.import_scene(d, points_mode="mesh")
    for name, shading in (("surface pial", "lit"), ("glyphs points", "flat"), ("connections", "flat"), ("glyphs pies", "flat")):
        mesh = bpy.data.objects[name].data
        assert len(mesh.materials) == 1, name
        mat = mesh.materials[0]
        assert mat.name == "brainGL " + name
        nodes, links = material_nodes(mat)
        assert nodes["ShaderNodeAttribute"].attribute_name == "Col", name     # the data colours drive the shader
        if shading == "flat":
            # emission only: lighting cannot change colours that encode data
            assert "ShaderNodeEmission" in nodes and "ShaderNodeBsdfPrincipled" not in nodes, name
            assert ("ShaderNodeAttribute", "Color", "ShaderNodeEmission", "Color") in links, name
            assert ("ShaderNodeEmission", "Emission", "ShaderNodeOutputMaterial", "Surface") in links, name
            assert approx(nodes["ShaderNodeEmission"].inputs["Strength"].default_value, 1.0, 1e-6), name
        else:
            assert "ShaderNodeBsdfPrincipled" in nodes and "ShaderNodeEmission" not in nodes, name
            assert ("ShaderNodeAttribute", "Color", "ShaderNodeBsdfPrincipled", "Base Color") in links, name
            assert ("ShaderNodeBsdfPrincipled", "BSDF", "ShaderNodeOutputMaterial", "Surface") in links, name


def test_import_lit_material_opacity():
    for opacity in (0.6, 1):
        fresh()
        with scene_dir(surface_opacity=opacity) as d:
            ib.import_scene(d)
        mat = bpy.data.objects["surface pial"].data.materials[0]
        bsdf = material_nodes(mat)[0]["ShaderNodeBsdfPrincipled"]
        assert approx(bsdf.inputs["Alpha"].default_value, opacity, 1e-6)
        if hasattr(mat, "surface_render_method"):                               # Blender 4.2+
            assert (mat.surface_render_method == "BLENDED") == (opacity < 1)
        else:
            assert (mat.blend_method == "BLEND") == (opacity < 1)


def test_import_camera_matches_scene_json():
    fresh()
    with scene_dir() as d:
        ib.main([d])
    cam = bpy.context.scene.camera
    assert cam is not None and cam.name == "brainGL camera" and cam.type == "CAMERA"
    assert cam.data.type == "ORTHO"
    assert approx(cam.data.ortho_scale, CAMERA["ortho_scale"], 1e-3)
    assert approx(cam.data.ortho_scale, 2 * 110 * 1.6, 1e-3)
    assert approx(cam.location, CAMERA["location"], 1e-3)
    assert cam.rotation_mode == "QUATERNION"
    q, ref = np.array(cam.rotation_quaternion), np.array(CAMERA["rotation_quaternion"])
    assert approx(q, ref, 1e-6) or approx(q, -ref, 1e-6)
    right, up, backward, location = camera_axes(cam)
    assert approx(-backward, VIEW["forward"], 1e-5)                             # looks down its local -Z ...
    to_target = VIEW["target"] - location
    assert approx(-backward, to_target / np.linalg.norm(to_target), 1e-5)       # ... from its location to the target
    assert approx(up, VIEW["up"], 1e-5) and approx(right, VIEW["right"], 1e-5)
    assert up[2] > 0                                                            # superior is up in the image
    assert cam.data.clip_start < 900 - 200 and cam.data.clip_end > 900 + 200    # nothing of the scene is clipped


def _check_framing(aspect):
    camera, view = camera_from_view(forward=(-1, 0.2, -0.1), up=(0, 0, 1), target=(3, -20, 15),
                                    half_height=80, aspect=aspect, distance=700)
    fresh()
    with scene_dir(camera=camera) as d:
        ib.main([d, "--resolution", "800"])
    scene = bpy.context.scene
    assert scene.render.resolution_x == 800
    assert scene.render.resolution_y == round(800 / aspect)
    t, hh = view["target"], view["half_height"]
    pts = [t, t + view["up"] * hh, t - view["up"] * hh, t + view["right"] * hh * aspect, t - view["right"] * hh * aspect]
    uv = project(scene.camera, pts)
    # the target is in the middle; +-half_height reaches the top / bottom edge and
    # +-half_height * aspect the right / left edge of the rendered image
    assert approx(uv, [[0.5, 0.5], [0.5, 1.0], [0.5, 0.0], [1.0, 0.5], [0.0, 0.5]], 1e-4), (aspect, uv)


def test_import_camera_frames_the_browser_view_landscape():
    _check_framing(1.6)


def test_import_camera_frames_the_browser_view_portrait():
    _check_framing(0.625)


def test_import_camera_frames_the_browser_view_square():
    _check_framing(1.0)


def test_import_default_camera_is_a_left_lateral_orthographic_view():
    fresh()
    with scene_dir(camera=None) as d:
        spec, aspect, _ = ib.import_scene(d)
    cam = bpy.context.scene.camera
    assert cam is not None and cam.data.type == "ORTHO"
    assert approx(aspect, 16 / 9, 1e-9)
    right, up, backward, location = camera_axes(cam)
    assert approx(-backward, [1, 0, 0], 1e-6)          # looks along +x: from the left
    assert approx(up, [0, 0, 1], 1e-6)                 # superior up
    assert approx(right, [0, -1, 0], 1e-6)             # anterior (+y) on the left of the image
    every = np.vstack([SURF_XYZ, PTS_XYZ, SEG_XYZ, PIE_XYZ])
    lo, hi = every.min(axis=0), every.max(axis=0)
    centre = (lo + hi) / 2
    assert location[0] < lo[0]                         # in front of everything ...
    assert approx(location[1:], centre[1:], 1e-3)      # ... and centred on the bounding box
    assert approx(project(cam, [centre])[0], [0.5, 0.5], 1e-4)
    assert cam.data.ortho_scale >= (hi - lo)[1]        # the antero-posterior extent fits horizontally
    assert cam.data.clip_end > hi[0] - location[0]


BRAIN_BOX = np.array([70, 87.5, 65], np.float32)      # half sizes with the proportions of a brain: 140 x 175 x 130 mm


def _write_box_scene(folder, half, centre=(0, 0, 0)):
    xyz = (OCT_V * np.asarray(half, np.float32) + np.asarray(centre, np.float32)).astype(np.float32)
    write_ply(os.path.join(folder, "brain.ply"), xyz, np.full((6, 4), 255, np.uint8), faces=OCT_F)
    with open(os.path.join(folder, "scene.json"), "w") as fh:
        json.dump({"format": "braingl-blender-scene", "version": 1, "title": "brain", "units": "mm",
                   "background": BACKGROUND, "camera": None,
                   "layers": [layer_entry("brain.ply", "brain", "mesh", "lit", 6, smooth=True)]}, fh)
    return xyz


def _box_corners(xyz):
    lo, hi = xyz.min(axis=0), xyz.max(axis=0)
    return np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])


def _assert_framed(cam, corners, label):
    """All corners inside the image, and the box fills the image in its tighter direction (margin <= 10 %)."""
    uv = project(cam, corners)
    assert uv[:, 0].min() >= 0 and uv[:, 0].max() <= 1, f"{label}: cropped horizontally: u in {uv[:, 0].min():.3f}..{uv[:, 0].max():.3f}"
    assert uv[:, 1].min() >= 0 and uv[:, 1].max() <= 1, f"{label}: cropped vertically: v in {uv[:, 1].min():.3f}..{uv[:, 1].max():.3f}"
    fill = max(np.ptp(uv[:, 0]), np.ptp(uv[:, 1]))
    assert 0.9 <= fill <= 1.0, f"{label}: the scene fills only {fill:.2f} of the image"
    assert approx(uv.mean(axis=0), [0.5, 0.5], 1e-4), f"{label}: not centred: {uv.mean(axis=0)}"


def test_import_default_camera_shows_the_whole_scene():
    """scene.json "camera": null (older directionality exports): at the 16:9 default a brain-shaped box
    (175 mm long, 130 mm high) must not be cropped at the top and bottom."""
    fresh()
    with tempfile.TemporaryDirectory() as tmp:
        xyz = _write_box_scene(tmp, BRAIN_BOX)
        ib.main([tmp])
    scene = bpy.context.scene
    assert (scene.render.resolution_x, scene.render.resolution_y) == (1920, 1080)
    _assert_framed(scene.camera, _box_corners(xyz), "brain box at 16:9")
    # the box is limited by its height here: 130 mm of the 1080 rows, so less than the full width is used
    uv = project(scene.camera, _box_corners(xyz))
    assert np.ptp(uv[:, 1]) > np.ptp(uv[:, 0])


def test_import_default_camera_frames_boxes_of_any_shape():
    shapes = {"long": [40, 120, 20], "tall": [40, 30, 110], "deep": [150, 30, 30], "cube": [50, 50, 50], "off centre": [70, 87.5, 65]}
    for label, half in shapes.items():
        fresh()
        with tempfile.TemporaryDirectory() as tmp:
            xyz = _write_box_scene(tmp, half, centre=(12, -30, 45) if label == "off centre" else (0, 0, 0))
            ib.main([tmp, "--resolution", "640"])
        cam = bpy.context.scene.camera
        _assert_framed(cam, _box_corners(xyz), label)
        _, _, backward, location = camera_axes(cam)
        assert approx(-backward, [1, 0, 0], 1e-6), label
        assert location[0] < xyz[:, 0].min() - 1, label                         # the camera is outside the box


def test_frame_left_lateral_for_other_aspects():
    """The helper behind the fallback camera, for image shapes other than the 16:9 default."""
    for aspect in (16 / 9, 1.0, 0.5, 2.4, 4 / 3):
        for half in ([70, 87.5, 65], [40, 120, 20], [40, 30, 110]):
            fresh()
            with tempfile.TemporaryDirectory() as tmp:
                xyz = _write_box_scene(tmp, half)
                ib.import_scene(tmp)
            cam = bpy.context.scene.camera
            location, rotation, ortho_scale = ib.frame_left_lateral(xyz.min(axis=0), xyz.max(axis=0), aspect)
            cam.location, cam.rotation_quaternion, cam.data.ortho_scale = location, rotation, ortho_scale
            ib.setup_render(aspect, width=800)
            _assert_framed(cam, _box_corners(xyz), f"aspect {aspect:.2f}, box {half}")
            # closed form: visible height = ortho_scale / max(1, aspect), visible width = that * aspect
            height = ortho_scale / max(1, aspect)
            assert height >= 2 * half[2] and height * aspect >= 2 * half[1]
            assert approx(min(height / (2 * half[2]), height * aspect / (2 * half[1])), 1.06, 1e-4)


def test_import_headlight_follows_the_camera():
    fresh()
    with scene_dir() as d:
        ib.import_scene(d)
    sun = bpy.data.objects["brainGL headlight"]
    cam = bpy.context.scene.camera
    assert sun.type == "LIGHT" and sun.data.type == "SUN" and sun.data.energy > 0
    assert sun.parent == cam
    bpy.context.view_layer.update()
    # a sun shines down its local -Z: the same direction the camera looks in
    assert approx(-np.array(sun.matrix_world)[:3, 2], VIEW["forward"], 1e-5)


def test_import_scene_settings_units_colour_management_world():
    fresh()
    with scene_dir() as d:
        ib.import_scene(d)
    scene = bpy.context.scene
    assert scene.unit_settings.system == "METRIC"
    assert approx(scene.unit_settings.scale_length, 0.001, 1e-9)                # 1 unit = 1 mm
    assert scene.unit_settings.length_unit == "MILLIMETERS"
    assert scene.view_settings.view_transform == "Standard"                    # no tone mapping of data colours
    bg = scene.world.node_tree.nodes["Background"]
    expected = [((c + 0.055) / 1.055) ** 2.4 for c in BACKGROUND]              # scene.json has sRGB 0..1
    assert approx(list(bg.inputs["Color"].default_value)[:3], expected, 1e-6)
    assert approx(bg.inputs["Strength"].default_value, 1.0, 1e-6)
    assert any(l.from_node == bg and l.to_node.bl_idname == "ShaderNodeOutputWorld" for l in scene.world.node_tree.links)


def test_setup_render_resolution_and_engine():
    fresh()
    with scene_dir() as d:
        ib.main([d, "--resolution", "640", "--samples", "7"])
    r = bpy.context.scene.render
    assert (r.resolution_x, r.resolution_y, r.resolution_percentage) == (640, 400, 100)      # aspect 1.6
    assert r.engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE")
    assert not r.film_transparent
    assert bpy.context.scene.eevee.taa_render_samples == 7
    ib.setup_render(0.5, width=300, cycles=True, samples=3)
    assert (r.resolution_x, r.resolution_y) == (300, 600)
    assert r.engine == "CYCLES" and bpy.context.scene.cycles.samples == 3


def test_main_default_render_size():
    fresh()
    with scene_dir() as d:
        ib.main([d])
    r = bpy.context.scene.render
    assert (r.resolution_x, r.resolution_y) == (1920, 1200)                    # 1920 wide, aspect 1.6 from scene.json


def test_import_replaces_existing_objects_unless_keep():
    for keep in (False, True):
        fresh()
        old = bpy.data.objects.new("already there", None)
        bpy.context.scene.collection.objects.link(old)
        with scene_dir() as d:
            ib.main([d] + (["--keep"] if keep else []))
        assert ("already there" in bpy.data.objects) == keep
        assert "surface pial" in bpy.data.objects


def test_import_twice_gives_the_same_objects_again():
    fresh()
    with scene_dir() as d:
        ib.main([d])
        first = sorted(o.name for o in bpy.context.scene.objects)
        ib.main([d])
    assert sorted(o.name for o in bpy.context.scene.objects) == first          # no "surface pial.001"
    assert len(bpy.data.objects["surface pial"].data.vertices) == 6
    assert bpy.context.scene.camera.name == "brainGL camera"


def test_import_twice_leaves_no_empty_collections():
    fresh()
    with scene_dir() as d:
        ib.main([d])
        ib.main([d])
        ib.main([d])
    names = [c.name for c in bpy.context.scene.collection.children]
    assert names == ["brainGL: unit test"], f"collections in the scene after three imports: {names}"
    assert [c.name for c in bpy.data.collections] == ["brainGL: unit test"]


def test_import_twice_leaves_no_orphan_datablocks():
    """A re-import replaces the meshes, materials, node groups, camera and light of the previous run."""
    fresh()
    with scene_dir() as d:
        ib.main([d])
        first = {kind: sorted(b.name for b in getattr(bpy.data, kind)) for kind in ("meshes", "materials", "node_groups", "cameras", "lights")}
        ib.main([d])
        ib.main([d])
    again = {kind: sorted(b.name for b in getattr(bpy.data, kind)) for kind in first}
    assert again == first, again
    assert first["materials"] == ["brainGL connections", "brainGL glyphs pies", "brainGL glyphs points", "brainGL surface pial"]
    assert len(first["meshes"]) == 4 and len(first["node_groups"]) == 1 and len(first["cameras"]) == 1 and len(first["lights"]) == 1


def test_reimport_keeps_datablocks_that_are_not_its_own():
    fresh()
    mine = bpy.data.materials.new("brainGL look-alike")        # unused, but not made by the importer
    mesh = bpy.data.meshes.new("my mesh")
    coll = bpy.data.collections.new("brainGL: my own")          # empty, but not made by the importer
    bpy.context.scene.collection.children.link(coll)
    with scene_dir() as d:
        ib.main([d])
        ib.main([d])
    assert mine.name in bpy.data.materials and mesh.name in bpy.data.meshes
    assert "brainGL: my own" in bpy.data.collections


def test_import_keep_adds_a_second_collection():
    fresh()
    with scene_dir() as d:
        ib.main([d])
        ib.main([d, "--keep"])
    assert len(bpy.context.scene.collection.children) == 2
    assert len([o for o in bpy.context.scene.objects if o.type == "MESH"]) == 8


def test_import_skips_empty_layers():
    fresh()
    with scene_dir() as d:
        write_ply(os.path.join(d, "empty.ply"), np.zeros((0, 3)), np.zeros((0, 4), np.uint8))
        with open(os.path.join(d, "scene.json")) as fh:
            scene = json.load(fh)
        scene["layers"].insert(0, layer_entry("empty.ply", "nothing here", "points", "flat", 0, radius=1))
        with open(os.path.join(d, "scene.json"), "w") as fh:
            json.dump(scene, fh)
        _, _, objects = ib.import_scene(d)
    assert "nothing here" not in bpy.data.objects
    assert [o.name for o in objects] == ["surface pial", "glyphs points", "connections", "glyphs pies"]


def test_import_accepts_the_path_of_scene_json():
    fresh()
    with scene_dir() as d:
        _, _, objects = ib.import_scene(os.path.join(d, "scene.json"))
    assert len(objects) == 4


def test_import_rejects_foreign_json():
    fresh()
    with scene_dir(fmt="something-else") as d:
        try:
            ib.import_scene(d)
        except ValueError:
            return
    raise AssertionError("a scene.json with another 'format' was imported")


def test_default_scene_dir_is_the_folder_of_the_script():
    """Scripting > Open > import_braingl.py > Run Script: scene.json lies next to the script."""
    fresh()
    with scene_dir(title="next to the script") as d:
        copy = os.path.join(d, "import_braingl.py")
        shutil.copyfile(SCRIPT, copy)
        module = load_importer(copy, "import_braingl_copy")
        assert os.path.samefile(module.default_scene_dir(), d)
        objects = module.main([])
        assert len(objects) == 4
        assert "brainGL: next to the script" in bpy.data.collections


def test_import_flat_shaded_layers_have_sharp_faces():
    fresh()
    with scene_dir() as d:
        ib.import_scene(d, points_mode="mesh")
    for name in ("glyphs pies", "connections", "glyphs points"):               # all have "smooth": false
        mesh = bpy.data.objects[name].data
        assert len(mesh.polygons) > 0
        assert not any(p.use_smooth for p in mesh.polygons), f"{name}: faces are smooth although the layer says smooth=false"
    assert all(p.use_smooth for p in bpy.data.objects["surface pial"].data.polygons)      # "smooth": true


def test_import_flat_layers_neither_light_nor_shade_the_anatomy():
    """Emission is a light source in Cycles: data layers must be visible to the camera only."""
    fresh()
    with scene_dir() as d:
        ib.import_scene(d)
    for name, flat in (("surface pial", False), ("glyphs points", True), ("connections", True), ("glyphs pies", True)):
        obj = bpy.data.objects[name]
        assert obj.visible_camera, name
        for prop in ("visible_diffuse", "visible_glossy", "visible_shadow"):
            assert getattr(obj, prop) == (not flat), f"{name}.{prop}"


def test_import_emits_no_deprecation_warnings():
    """Material.use_nodes / World.use_nodes are deprecated in Blender 5.0 (and removed in 6.0)."""
    fresh()
    with scene_dir() as d, warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        ib.main([d])
        ib.main([d, "--points", "mesh"])
        ib.setup_render(1.5, width=320, cycles=True, samples=2)
    messages = [f"{w.category.__name__}: {w.message}" for w in caught]
    assert not messages, messages


def test_import_background_into_an_existing_world():
    """A world that is already in the file (other node names, colour driven by a texture) is reused."""
    fresh()
    world = bpy.data.worlds.new("existing")
    bpy.context.scene.world = world
    nt = ib.enable_nodes(world)
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.name = "Hintergrund"
    sky = nt.nodes.new("ShaderNodeRGB")
    nt.links.new(sky.outputs[0], bg.inputs["Color"])
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    with scene_dir() as d:
        ib.import_scene(d)
    assert bpy.context.scene.world == world
    assert not bg.inputs["Color"].is_linked
    expected = [((c + 0.055) / 1.055) ** 2.4 for c in BACKGROUND]
    assert approx(list(bg.inputs["Color"].default_value)[:3], expected, 1e-6)
    # ... and a world without any node gets a background
    nt.nodes.clear()
    with scene_dir() as d:
        ib.import_scene(d)
    made = [n for n in nt.nodes if n.bl_idname == "ShaderNodeBackground"]
    assert len(made) == 1 and approx(list(made[0].inputs["Color"].default_value)[:3], expected, 1e-6)
    assert any(l.from_node == made[0] and l.to_node.bl_idname == "ShaderNodeOutputWorld" for l in nt.links)


# ============================================================ command line, render
def test_cli_save_blend_file():
    """python import_braingl.py -- SCENE --points mesh --save out.blend (blender --python ... in Blender)."""
    with scene_dir() as d:
        blend = os.path.join(d, "out.blend")
        res = run_script_cli(SCRIPT, [d, "--points", "mesh", "--save", blend])
        assert res.returncode == 0, res.stdout[-2000:] + res.stderr[-2000:]
        assert "imported 'unit test' with 4 layer(s)" in res.stdout
        assert os.path.isfile(blend)
        bpy.ops.wm.open_mainfile(filepath=blend)
    names = {o.name: o.type for o in bpy.data.objects}
    assert names == {"surface pial": "MESH", "glyphs points": "MESH", "connections": "MESH", "glyphs pies": "MESH",
                     "brainGL camera": "CAMERA", "brainGL headlight": "LIGHT"}
    assert len(bpy.data.objects["glyphs points"].data.vertices) == 30
    assert bpy.context.scene.camera.data.type == "ORTHO"
    assert approx(mesh_colors(bpy.data.objects["surface pial"].data), expected_linear_rgba(SURF_RGBA), 1e-6)
    fresh()


def _render_scene(folder):
    """A flat (data colour) and a lit white rectangle in front of the camera, 100 mm x 100 mm view."""
    def quad(x0, x1):
        return np.array([[x0, 0, -20], [x1, 0, -20], [x1, 0, 20], [x0, 0, 20]], np.float32), [[0, 1, 2], [0, 2, 3]]
    os.makedirs(folder, exist_ok=True)
    v, f = quad(-40, -10)
    write_ply(os.path.join(folder, "flat.ply"), v, [[200, 100, 50, 255]] * 4, faces=f)
    v, f = quad(10, 40)
    write_ply(os.path.join(folder, "lit.ply"), v, [[255, 255, 255, 255]] * 4, faces=f)
    camera, _ = camera_from_view(forward=(0, 1, 0), up=(0, 0, 1), target=(0, 0, 0), half_height=50, aspect=1.0, distance=300)
    with open(os.path.join(folder, "scene.json"), "w") as fh:
        json.dump({"format": "braingl-blender-scene", "version": 1, "title": "render", "units": "mm",
                   "background": BACKGROUND, "camera": camera,
                   "layers": [layer_entry("flat.ply", "flat quad", "mesh", "flat", 4),
                              layer_entry("lit.ply", "lit quad", "mesh", "lit", 4)]}, fh)
    return folder


def _check_render(png):
    px = read_png(png)
    assert px.shape == (64, 64, 4)
    flat, lit, background = px[32, 16, :3], px[32, 48, :3], px[3, 3, :3]
    # emission + "Standard" view transform: the rendered pixel is the exported sRGB data colour
    assert np.abs(flat - [200, 100, 50]).max() <= 2, f"flat layer rendered as {flat}"
    assert np.abs(background - [51, 102, 153]).max() <= 2, f"background rendered as {background}"
    assert lit.min() > 128, f"the lit layer is not illuminated by the headlight: {lit}"
    assert (px[..., 3] == 255).all()                                           # opaque film


def test_render_cycles_in_process():
    fresh()
    with tempfile.TemporaryDirectory() as tmp:
        d = _render_scene(os.path.join(tmp, "scene"))
        png = os.path.join(tmp, "cycles.png")
        ib.main([d, "--render", png, "--cycles", "--samples", "4", "--resolution", "64"])
        assert bpy.context.scene.render.engine == "CYCLES" and bpy.context.scene.cycles.samples == 4
        assert os.path.isfile(png)
        _check_render(png)


def test_cli_render_default_engine():
    """... -- SCENE --render out.png: EEVEE needs a GPU, so a failure to render is a SKIP, wrong pixels a FAIL."""
    with tempfile.TemporaryDirectory() as tmp:
        d = _render_scene(os.path.join(tmp, "scene"))
        png = os.path.join(tmp, "eevee.png")
        res = run_script_cli(SCRIPT, [d, "--render", png, "--samples", "4", "--resolution", "64"])
        if res.returncode != 0 or not os.path.isfile(png):
            raise Skip("EEVEE could not render here (no GPU context?): " + (res.stderr or res.stdout)[-300:].strip())
        assert "brainGL: rendered" in res.stdout
        _check_render(png)


def test_cli_engine_cycles_option():
    """... -- SCENE --render out.png --engine cycles: the documented way to choose Cycles."""
    with tempfile.TemporaryDirectory() as tmp:
        d = _render_scene(os.path.join(tmp, "scene"))
        png = os.path.join(tmp, "cycles.png")
        res = run_script_cli(SCRIPT, [d, "--render", png, "--engine", "cycles", "--samples", "4", "--resolution", "64"])
        assert res.returncode == 0 and os.path.isfile(png), (res.stderr or res.stdout)[-300:].strip()
        assert "Cycles" in res.stdout + res.stderr or "brainGL: rendered" in res.stdout
        _check_render(png)


def test_cli_cycles_option():
    """The old spelling `--cycles`. Blender's Cycles add-on parses everything after `--` itself with an
    abbreviating argparse (scripts/addons_core/cycles/engine.py, _parse_command_line: --cycles-print-stats,
    --cycles-device) and used to abort with "ambiguous option: --cycles could match ..." when bpy was imported.
    The script now renames the flag before that import; inside the Blender application the add-on is
    registered before any script runs, so only `--engine cycles` can work there."""
    if IN_BLENDER_APP:
        raise Skip("the Blender application rejects --cycles itself; use --engine cycles")
    with tempfile.TemporaryDirectory() as tmp:
        d = _render_scene(os.path.join(tmp, "scene"))
        png = os.path.join(tmp, "cycles.png")
        res = run_script_cli(SCRIPT, [d, "--render", png, "--cycles", "--samples", "4", "--resolution", "64"])
        assert "ambiguous option" not in res.stderr + res.stdout, (res.stderr or res.stdout)[-300:].strip()
        assert res.returncode == 0 and os.path.isfile(png), (res.stderr or res.stdout)[-300:].strip()
        _check_render(png)


def test_cli_passes_blenders_own_cycles_options_through():
    """`--cycles-device CPU` after the `--` belongs to Blender; the script must not stumble over it."""
    with tempfile.TemporaryDirectory() as tmp:
        d = _render_scene(os.path.join(tmp, "scene"))
        png = os.path.join(tmp, "cycles.png")
        res = run_script_cli(SCRIPT, [d, "--render", png, "--engine", "cycles", "--cycles-device", "CPU", "--samples", "2", "--resolution", "64"])
        assert res.returncode == 0 and os.path.isfile(png), (res.stderr or res.stdout)[-300:].strip()


def test_cli_rejects_unknown_options():
    with scene_dir() as d:
        res = run_script_cli(SCRIPT, [d, "--no-such-option"])
    assert res.returncode != 0
    assert "--no-such-option" in res.stderr + res.stdout


def test_rename_cycles_option():
    cases = [
        (["x.py", "--", "scene", "--cycles", "--samples", "8"], ["x.py", "--", "scene", "--engine", "cycles", "--samples", "8"]),
        (["blender", "--cycles", "--", "scene"], ["blender", "--cycles", "--", "scene"]),               # only after the `--`
        (["x.py", "--", "--cycles-device", "CPU", "--cycles"], ["x.py", "--", "--cycles-device", "CPU", "--engine", "cycles"]),
        (["x.py", "--cycles"], ["x.py", "--cycles"]),                                                    # no `--`: nothing of ours
        (["x.py", "--"], ["x.py", "--"]),
    ]
    for argv, expected in cases:
        got = list(argv)
        ib._rename_cycles_option(got)
        assert got == expected, (argv, got)


def test_main_engine_selection():
    fresh()
    with scene_dir() as d:
        for args, engine in (([], "eevee"), (["--engine", "eevee"], "eevee"), (["--engine", "cycles"], "cycles"), (["--cycles"], "cycles")):
            ib.main([d, *args])
            got = bpy.context.scene.render.engine
            assert (got == "CYCLES") == (engine == "cycles"), (args, got)
            assert got in ("CYCLES", "BLENDER_EEVEE", "BLENDER_EEVEE_NEXT")


# ------------------------------------------------- what the renderer makes of it
POINT_RGB = (40, 180, 230)
INSIDE_RGB = (200, 100, 50)


def _look_scene(folder, opacity=0.25):
    """100 mm x 100 mm view along +y with, from left to right:
    a point glyph of radius 12 mm, a lit green rectangle, and a flat rectangle behind a transparent lit white one."""
    def quad(x0, x1, y, z=18):
        return np.array([[x0, y, -z], [x1, y, -z], [x1, y, z], [x0, y, z]], np.float32), [[0, 1, 2], [0, 2, 3]]
    os.makedirs(folder, exist_ok=True)
    write_ply(os.path.join(folder, "point.ply"), [[-32, 0, 0]], [[*POINT_RGB, 255]], kind="points")
    v, f = quad(-12, 8, 0)
    write_ply(os.path.join(folder, "lit.ply"), v, [[0, 255, 0, 255]] * 4, faces=f)
    v, f = quad(20, 44, 30, z=10)
    write_ply(os.path.join(folder, "inside.ply"), v, [[*INSIDE_RGB, 255]] * 4, faces=f)
    v, f = quad(16, 48, 0, z=30)
    write_ply(os.path.join(folder, "shell.ply"), v, [[255, 255, 255, 255]] * 4, faces=f)
    camera, _ = camera_from_view(forward=(0, 1, 0), up=(0, 0, 1), target=(0, 0, 0), half_height=50, aspect=1.0, distance=300)
    with open(os.path.join(folder, "scene.json"), "w") as fh:
        json.dump({"format": "braingl-blender-scene", "version": 1, "title": "look", "units": "mm",
                   "background": BACKGROUND, "camera": camera,
                   "layers": [layer_entry("point.ply", "point", "points", "flat", 1, radius=12),
                              layer_entry("lit.ply", "lit green", "mesh", "lit", 4),
                              layer_entry("inside.ply", "inside", "mesh", "flat", 4),
                              layer_entry("shell.ply", "shell", "mesh", "lit", 4, opacity=opacity)]}, fh)
    return folder


def _check_look(png, label):
    px = read_png(png)
    assert px.shape == (96, 96, 4), px.shape
    at = lambda x, z: px[int(round((z + 50) / 100 * 96 - 0.5)), int(round((x + 50) / 100 * 96 - 0.5)), :3]   # world mm -> pixel
    background = np.array([51, 102, 153])
    # the point glyph is a disc of its radius in the data colour ("Col" reaches the emission shader of the cloud / octahedron)
    assert np.abs(at(-32, 0) - POINT_RGB).max() <= 3, f"{label}: point glyph rendered as {at(-32, 0)}"
    assert np.abs(at(-32, 5) - POINT_RGB).max() <= 3, f"{label}: point glyph rendered as {at(-32, 5)} off its centre"
    assert np.abs(at(-32, 20) - background).max() <= 3, f"{label}: the point glyph is larger than its radius"
    assert np.abs(at(-32, -40) - background).max() <= 3, label
    # "Col" drives the base colour of the lit material: a green rectangle lit by the headlight
    lit = at(-2, 0)
    assert lit[1] > 150 and lit[1] - max(lit[0], lit[2]) > 100, f"{label}: lit green layer rendered as {lit}"   # some specular white on top
    # transparent surface: the flat layer behind it shows through, tinted by the surface in front
    through, shell_only = at(32, 0).astype(float), at(32, 22).astype(float)
    assert np.abs(shell_only - background).max() > 12, f"{label}: the transparent surface is invisible ({shell_only})"
    assert shell_only.min() < 250 and np.ptp(shell_only) > 15, f"{label}: the transparent surface is opaque ({shell_only})"
    assert through[0] - through[2] > 40, f"{label}: the layer behind the transparent surface is hidden ({through})"
    assert through[2] > INSIDE_RGB[2] + 15, f"{label}: the surface in front leaves no trace ({through})"
    assert np.abs(through - shell_only).max() > 30, label


def test_render_look_cycles_point_cloud():
    fresh()
    with tempfile.TemporaryDirectory() as tmp:
        d = _look_scene(os.path.join(tmp, "scene"))
        png = os.path.join(tmp, "look.png")
        ib.main([d, "--render", png, "--engine", "cycles", "--samples", "16", "--resolution", "96", "--points", "nodes"])
        _check_look(png, "cycles, point cloud")


def test_render_look_cycles_octahedra():
    fresh()
    with tempfile.TemporaryDirectory() as tmp:
        d = _look_scene(os.path.join(tmp, "scene"))
        png = os.path.join(tmp, "look.png")
        ib.main([d, "--render", png, "--engine", "cycles", "--samples", "16", "--resolution", "96", "--points", "mesh"])
        px = read_png(png)
        # an octahedron seen along an axis is a square standing on a corner: its centre has the data colour
        assert np.abs(px[48, 17, :3] - POINT_RGB).max() <= 3, px[48, 17, :3]
        assert np.abs(px[48 + 9, 17 + 9, :3] - [51, 102, 153]).max() <= 3, "the octahedron reaches beyond |x| + |z| = radius"


def test_render_look_eevee():
    """The same picture with the default engine (needs a GPU: a failure to render is a SKIP)."""
    for mode in ("nodes", "mesh"):
        with tempfile.TemporaryDirectory() as tmp:
            d = _look_scene(os.path.join(tmp, "scene"))
            png = os.path.join(tmp, "look.png")
            res = run_script_cli(SCRIPT, [d, "--render", png, "--samples", "16", "--resolution", "96", "--points", mode])
            if res.returncode != 0 or not os.path.isfile(png):
                raise Skip("EEVEE could not render here (no GPU context?): " + (res.stderr or res.stdout)[-300:].strip())
            if mode == "nodes":
                _check_look(png, "eevee, point cloud")
            else:
                px = read_png(png)
                assert np.abs(px[48, 17, :3] - POINT_RGB).max() <= 3, px[48, 17, :3]


# ====================================================================== runner
def run():
    only = os.environ.get("BRAINGL_BLENDER_TESTS", "")
    cases = [(n, f) for n, f in globals().items() if n.startswith("test_") and callable(f) and only in n]
    print(f"\nbrainGL-web Blender importer tests: Blender {bpy.app.version_string} "
          f"({'application' if IN_BLENDER_APP else 'bpy module'}), Python {sys.version.split()[0]}, numpy {np.__version__}")
    print(f"script under test: {SCRIPT}\n")
    counts = {"PASS": 0, "FAIL": 0, "SKIP": 0, "XFAIL": 0}
    failures = []
    start = time.time()
    for name, fn in cases:
        t0 = time.time()
        out = io.StringIO()
        detail = ""
        try:
            with contextlib.redirect_stdout(out):
                fn()
            if getattr(fn, "known_bug", None) and fn.hit:
                status, detail = "XFAIL", "KNOWN BUG " + fn.known_bug
            else:
                status = "PASS"
        except unittest.SkipTest as e:
            status, detail = "SKIP", str(e)
        except Exception:
            status, detail = "FAIL", traceback.format_exc()
            failures.append((name, detail, out.getvalue()))
        counts[status] += 1
        print(f"{status:5s} {name}  ({time.time() - t0:.2f} s)", flush=True)
        if status in ("SKIP", "XFAIL"):
            print(f"      {detail}", flush=True)
    for name, detail, captured in failures:
        print(f"\n{'=' * 78}\nFAIL {name}\n{'-' * 78}\n{detail}")
        if captured.strip():
            print(f"--- captured output ---\n{captured}")
    total = sum(counts.values())
    print(f"\n{total} cases in {time.time() - start:.1f} s: {counts['PASS']} passed, {counts['FAIL']} failed, "
          f"{counts['XFAIL']} known bug(s), {counts['SKIP']} skipped")
    if not cases:
        print("no case selected")
        return 1
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    code = run()
    sys.stdout.flush()
    sys.exit(code)
