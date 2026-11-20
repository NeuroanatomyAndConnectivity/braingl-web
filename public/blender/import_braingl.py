"""Import a brainGL-web scene into Blender.

A scene is a folder (or unzipped archive) written by brainGL-web's
"Export for Blender" button or by `npm run export:blender`:

    scene.json          camera, background, list of layers
    *.ply               one binary PLY per layer (surface, glyphs, connections, arrows ...)
    import_braingl.py   this script

Use it in one of three ways:

  * Blender > Scripting > Open > import_braingl.py > Run Script
    (loads the scene.json that lies next to the script)
  * blender --python import_braingl.py -- /path/to/scene [options]
  * blender --background --python import_braingl.py -- /path/to/scene --render out.png

Options (after the `--`):
    --render FILE      render a still image to FILE and (with --background) quit
    --save FILE        save the result as a .blend file
    --engine NAME      eevee (default) | cycles
    --samples N        render samples (default 64)
    --resolution W     width of the render in pixels (default 1920)
    --points MODE      nodes | mesh: draw point glyphs as a geometry-nodes point
                       cloud (light, default) or as real octahedra (portable)
    --keep             keep the objects that are already in the .blend file

`--cycles` is still understood as `--engine cycles` where that is possible
(with the stand-alone `bpy` Python module). The Blender application itself
rejects it: its Cycles add-on reads the arguments after `--` too and takes
`--cycles` for an ambiguous abbreviation of its own `--cycles-device` /
`--cycles-print-stats`. Use `--engine cycles`.

Works with Blender 3.6 LTS and newer (tested with 5.0). Units are
millimetres; data colours are stored in the "Col" colour attribute of every
object. Layers marked "flat" use an emission material so that lighting does
not change the colours that encode data; "lit" layers (anatomy) are shaded.
A scene.json without a camera gets a left-lateral orthographic camera that
frames everything for the 16:9 render.
"""
import json
import os
import sys


def _rename_cycles_option(argv):
    """Replace our old `--cycles` flag after the `--` by `--engine cycles`, in place.

    Blender's Cycles add-on parses everything after `--` itself when it is registered
    (scripts/addons_core/cycles/engine.py, _parse_command_line) with an argparse parser
    that knows --cycles-device and --cycles-print-stats and accepts abbreviations: a bare
    `--cycles` makes it stop with "ambiguous option". With the bpy module the add-on is
    registered by `import bpy`, so the flag has to be gone before that import. (In the
    Blender application the add-on is registered before any script runs.)"""
    if "--" not in argv:
        return
    start = argv.index("--") + 1
    renamed = []
    for arg in argv[start:]:
        renamed.extend(["--engine", "cycles"] if arg == "--cycles" else [arg])
    argv[start:] = renamed


if __name__ == "__main__":
    _rename_cycles_option(sys.argv)

import bpy
import numpy as np
from mathutils import Quaternion, Vector

COLOR_ATTRIBUTE = "Col"
#: custom property that marks every datablock made by this script (so that a re-import can tidy up)
TAG = "braingl"
#: width / height of the render when scene.json has no camera
DEFAULT_ASPECT = 16 / 9


# ----------------------------------------------------------------------- PLY
def read_ply(path):
    """Read the binary little-endian PLY layout written by brainGL-web.

    Returns (xyz float32 [n,3], rgba uint8 [n,4], faces int32 [m,3], edges int32 [e,2])."""
    with open(path, "rb") as f:
        counts = {}
        line = f.readline().strip()
        if line != b"ply":
            raise ValueError(f"{path}: not a PLY file")
        while True:
            line = f.readline()
            if not line:
                raise ValueError(f"{path}: unexpected end of header")
            parts = line.decode("ascii", "replace").split()
            if not parts:
                continue
            if parts[0] == "format" and parts[1] != "binary_little_endian":
                raise ValueError(f"{path}: only binary_little_endian PLY is supported")
            if parts[0] == "element":
                counts[parts[1]] = int(parts[2])
            if parts[0] == "end_header":
                break
        nv, nf, ne = counts.get("vertex", 0), counts.get("face", 0), counts.get("edge", 0)
        vt = np.dtype([("xyz", "<f4", 3), ("rgba", "u1", 4)])
        ft = np.dtype([("n", "u1"), ("v", "<i4", 3)])
        verts = np.frombuffer(f.read(nv * vt.itemsize), dtype=vt, count=nv)
        faces = np.frombuffer(f.read(nf * ft.itemsize), dtype=ft, count=nf)["v"] if nf else np.zeros((0, 3), np.int32)
        edges = np.frombuffer(f.read(ne * 8), dtype="<i4", count=ne * 2).reshape(-1, 2) if ne else np.zeros((0, 2), np.int32)
    return verts["xyz"].copy(), verts["rgba"].copy(), np.ascontiguousarray(faces), edges


# ------------------------------------------------------------------ geometry
def expand_points(xyz, rgba, radius):
    """Every point becomes a small octahedron (for renderers without point clouds)."""
    offs = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], np.float32) * radius
    tris = np.array([[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]], np.int32)
    n = len(xyz)
    v = (xyz[:, None, :] + offs[None, :, :]).reshape(-1, 3)
    c = np.repeat(rgba, 6, axis=0)
    f = (tris[None, :, :] + (np.arange(n, dtype=np.int32) * 6)[:, None, None]).reshape(-1, 3)
    return v, c, f


def expand_segments(xyz, rgba, edges, radius):
    """Every segment becomes a three-sided tube."""
    a, b = xyz[edges[:, 0]], xyz[edges[:, 1]]
    d = b - a
    length = np.linalg.norm(d, axis=1, keepdims=True)
    d = d / np.maximum(length, 1e-9)
    ref = np.where(np.abs(d[:, 2:3]) < 0.9, np.array([[0, 0, 1]], np.float32), np.array([[1, 0, 0]], np.float32))
    u = np.cross(d, ref)
    u /= np.maximum(np.linalg.norm(u, axis=1, keepdims=True), 1e-9)
    w = np.cross(d, u)
    ring = []
    for k in range(3):
        ang = 2 * np.pi * k / 3
        ring.append((np.cos(ang) * u + np.sin(ang) * w) * radius)
    v = np.stack([a + ring[0], a + ring[1], a + ring[2], b + ring[0], b + ring[1], b + ring[2]], axis=1).reshape(-1, 3)
    ca, cb = rgba[edges[:, 0]], rgba[edges[:, 1]]
    c = np.stack([ca, ca, ca, cb, cb, cb], axis=1).reshape(-1, 4)
    tris = np.array([[0, 1, 4], [0, 4, 3], [1, 2, 5], [1, 5, 4], [2, 0, 3], [2, 3, 5]], np.int32)
    f = (tris[None, :, :] + (np.arange(len(edges), dtype=np.int32) * 6)[:, None, None]).reshape(-1, 3)
    return v.astype(np.float32), c, f


def srgb_to_linear(c):
    c = c.astype(np.float32) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def make_mesh(name, xyz, rgba, faces, smooth=False):
    mesh = bpy.data.meshes.new(name)
    nv, nf = len(xyz), len(faces)
    mesh.vertices.add(nv)
    mesh.vertices.foreach_set("co", np.ascontiguousarray(xyz, np.float32).ravel())
    if nf:
        mesh.loops.add(nf * 3)
        mesh.polygons.add(nf)
        mesh.polygons.foreach_set("loop_start", np.arange(0, nf * 3, 3, dtype=np.int32))
        try:  # read-only (derived) in Blender 4.1+
            mesh.polygons.foreach_set("loop_total", np.full(nf, 3, np.int32))
        except Exception:
            pass
        mesh.loops.foreach_set("vertex_index", np.ascontiguousarray(faces, np.int32).ravel())
        # always written: the faces of a new mesh are flat up to Blender 4.0 and smooth from 4.1 on
        mesh.polygons.foreach_set("use_smooth", np.full(nf, bool(smooth)))
    lin = np.ones((nv, 4), np.float32)
    lin[:, :3] = srgb_to_linear(rgba[:, :3])
    lin[:, 3] = rgba[:, 3] / 255.0
    attr = mesh.color_attributes.new(COLOR_ATTRIBUTE, "FLOAT_COLOR", "POINT")
    attr.data.foreach_set("color", lin.ravel())
    mesh[TAG] = True
    mesh.update()
    mesh.validate()
    return mesh


# ----------------------------------------------------------------- materials
def enable_nodes(block):
    """Give a material or world a node tree. Since Blender 5.0 they always have one and
    `use_nodes` is deprecated (it warns, and goes away in 6.0)."""
    if bpy.app.version < (5, 0, 0):
        block.use_nodes = True
    elif block.node_tree is None and hasattr(block, "use_nodes"):  # not expected; kept as a safety net
        block.use_nodes = True
    return block.node_tree


def make_material(name, shading, opacity=1.0):
    mat = bpy.data.materials.new(name)
    mat[TAG] = True
    nt = enable_nodes(mat)
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (400, 0)
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = COLOR_ATTRIBUTE
    attr.location = (-300, 0)
    if shading == "flat":
        sh = nt.nodes.new("ShaderNodeEmission")
        nt.links.new(attr.outputs["Color"], sh.inputs["Color"])
        nt.links.new(sh.outputs["Emission"], out.inputs["Surface"])
    else:
        sh = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(attr.outputs["Color"], sh.inputs["Base Color"])
        sh.inputs["Roughness"].default_value = 0.65
        if opacity < 0.999:
            # see-through anatomy (e.g. bundles inside the surface): alpha blending in EEVEE, native in Cycles
            sh.inputs["Alpha"].default_value = opacity
            if hasattr(mat, "surface_render_method"):  # Blender 4.2+
                mat.surface_render_method = "BLENDED"
            else:
                mat.blend_method = "BLEND"
        nt.links.new(sh.outputs["BSDF"], out.inputs["Surface"])
    sh.location = (0, 0)
    return mat


def point_cloud_modifier(obj, radius, material):
    """Geometry nodes: mesh vertices -> renderable point cloud with a radius and a material."""
    ng = bpy.data.node_groups.new("brainGL points", "GeometryNodeTree")
    ng[TAG] = True
    if hasattr(ng, "interface"):  # Blender 4.0+
        ng.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
        ng.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    else:
        ng.inputs.new("NodeSocketGeometry", "Geometry")
        ng.outputs.new("NodeSocketGeometry", "Geometry")
    n_in = ng.nodes.new("NodeGroupInput")
    n_out = ng.nodes.new("NodeGroupOutput")
    to_points = ng.nodes.new("GeometryNodeMeshToPoints")
    to_points.inputs["Radius"].default_value = radius
    set_mat = ng.nodes.new("GeometryNodeSetMaterial")
    set_mat.inputs["Material"].default_value = material
    n_in.location, to_points.location, set_mat.location, n_out.location = (-400, 0), (-200, 0), (0, 0), (200, 0)
    ng.links.new(n_in.outputs[0], to_points.inputs["Mesh"])
    ng.links.new(to_points.outputs["Points"], set_mat.inputs["Geometry"])
    ng.links.new(set_mat.outputs["Geometry"], n_out.inputs[0])
    mod = obj.modifiers.new("brainGL points", "NODES")
    mod.node_group = ng
    return mod


# --------------------------------------------------------------------- scene
def remove_previous_import():
    """Take away what an earlier run of this script left in the file: its collections once they are
    empty, and its meshes, materials, node groups, cameras and lights that nothing uses any more."""
    for coll in list(bpy.data.collections):
        if coll.get(TAG) and not coll.all_objects and not coll.children:
            bpy.data.collections.remove(coll)
    for blocks in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights, bpy.data.node_groups, bpy.data.materials):
        for block in list(blocks):
            if block.get(TAG) and block.users == 0:
                blocks.remove(block)


def set_background(world, rgb):
    """World colour = the exported background (sRGB 0..1), unlit by anything else."""
    nt = enable_nodes(world)
    out = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeOutputWorld" and n.is_active_output), None)
    out = out or next((n for n in nt.nodes if n.bl_idname == "ShaderNodeOutputWorld"), None) or nt.nodes.new("ShaderNodeOutputWorld")
    bg = next((l.from_node for l in nt.links if l.to_node == out and l.to_socket.name == "Surface"
               and l.from_node.bl_idname == "ShaderNodeBackground"), None)
    if bg is None:
        bg = nt.nodes.new("ShaderNodeBackground")
        bg.location = (out.location[0] - 220, out.location[1])
        nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    for link in list(bg.inputs["Color"].links):
        nt.links.remove(link)
    lin = srgb_to_linear(np.asarray(rgb, np.float32) * 255.0)
    bg.inputs["Color"].default_value = (float(lin[0]), float(lin[1]), float(lin[2]), 1.0)
    bg.inputs["Strength"].default_value = 1.0


def frame_left_lateral(lo, hi, aspect, margin=1.06):
    """Left-lateral orthographic view (looking along +x, +z up) of the box lo..hi.

    Returns (location, rotation quaternion, ortho_scale). Blender's ortho_scale is the size of
    the LARGER image side, so the visible width is ortho_scale * min(1, aspect) and the visible
    height ortho_scale / max(1, aspect); the box has to fit into both."""
    center, size = (lo + hi) / 2, hi - lo
    width, height = float(size[1]), float(size[2])     # the image shows y horizontally and z vertically
    half_height = margin * max(height / 2, width / (2 * aspect))
    distance = float(np.linalg.norm(size)) * 2 + 100.0
    location = (float(lo[0]) - distance, float(center[1]), float(center[2]))
    # local -Z -> +x (view direction), local +Y -> +z (up)
    return location, (0.5, 0.5, -0.5, -0.5), max(2 * half_height * max(1.0, aspect), 1e-3)


def import_scene(scene_dir, points_mode="nodes", keep=False):
    if os.path.isfile(scene_dir):
        scene_dir = os.path.dirname(os.path.abspath(scene_dir))
    with open(os.path.join(scene_dir, "scene.json")) as f:
        spec = json.load(f)
    if spec.get("format") != "braingl-blender-scene":
        raise ValueError("scene.json is not a brainGL-web Blender scene")
    scene = bpy.context.scene
    if not keep:
        for obj in list(scene.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        remove_previous_import()

    coll = bpy.data.collections.new("brainGL: " + spec.get("title", "scene"))
    coll[TAG] = True
    scene.collection.children.link(coll)
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    objects = []
    for layer in spec["layers"]:
        xyz, rgba, faces, edges = read_ply(os.path.join(scene_dir, layer["file"]))
        if len(xyz) == 0:
            continue
        shading = layer.get("shading", "lit")
        mat = make_material("brainGL " + layer["name"], shading, float(layer.get("opacity", 1.0)))
        radius = float(layer.get("radius") or 0.25)
        kind = layer["kind"]
        smooth = bool(layer.get("smooth", False))
        lo, hi = np.minimum(lo, xyz.min(axis=0)), np.maximum(hi, xyz.max(axis=0))
        as_cloud = False
        if kind == "segments":
            xyz, rgba, faces = expand_segments(xyz, rgba, edges, radius)
        elif kind == "points":
            if points_mode == "nodes":
                as_cloud = True
            else:
                xyz, rgba, faces = expand_points(xyz, rgba, radius)
        mesh = make_mesh(layer["name"], xyz, rgba, faces if not as_cloud else np.zeros((0, 3), np.int32), smooth=smooth)
        obj = bpy.data.objects.new(layer["name"], mesh)
        coll.objects.link(obj)
        mesh.materials.append(mat)
        if as_cloud:
            try:
                point_cloud_modifier(obj, radius, mat)
            except Exception as err:  # very old or very new node API: fall back to real geometry
                print(f"brainGL: point cloud nodes unavailable ({err}); using octahedra for {layer['name']}")
                bpy.data.objects.remove(obj, do_unlink=True)
                v, c, f = expand_points(xyz, rgba, radius)
                mesh = make_mesh(layer["name"], v, c, f)
                obj = bpy.data.objects.new(layer["name"], mesh)
                coll.objects.link(obj)
                mesh.materials.append(mat)
        if shading == "flat":
            # data colours: they neither light the anatomy (Cycles: emission is a light source) nor shade it
            for prop in ("visible_diffuse", "visible_glossy", "visible_transmission", "visible_volume_scatter", "visible_shadow"):
                try:
                    setattr(obj, prop, False)
                except Exception:
                    pass
        obj["braingl_kind"] = kind
        objects.append(obj)
        note = " (subsampled on export)" if layer.get("truncated") else ""
        print(f"brainGL: {layer['name']}: {layer['vertices']:,} {kind} vertices{note}")

    # units, colour management, world
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = "MILLIMETERS"
    try:
        scene.view_settings.view_transform = "Standard"  # keep data colours as exported
    except Exception:
        pass
    world = scene.world or bpy.data.worlds.new("brainGL world")
    scene.world = world
    set_background(world, spec.get("background", [0.06, 0.06, 0.08]))

    # camera: the browser view if it was exported, otherwise a left-lateral view of everything
    if not np.all(np.isfinite(lo)):
        lo, hi = np.full(3, -100.0), np.full(3, 100.0)
    cam_data = bpy.data.cameras.new("brainGL camera")
    cam_data[TAG] = True
    cam_data.type = "ORTHO"
    cam_data.clip_start, cam_data.clip_end = 0.1, 100000.0
    cam = bpy.data.objects.new("brainGL camera", cam_data)
    coll.objects.link(cam)
    cam.rotation_mode = "QUATERNION"
    c = spec.get("camera")
    aspect = DEFAULT_ASPECT
    if c:
        cam.location = Vector(c["location"])
        cam.rotation_quaternion = Quaternion(c["rotation_quaternion"])
        cam_data.ortho_scale = c["ortho_scale"]
        aspect = float(c.get("aspect", aspect))
    else:
        location, rotation, cam_data.ortho_scale = frame_left_lateral(lo, hi, aspect)
        cam.location = Vector(location)
        cam.rotation_quaternion = Quaternion(rotation)
    scene.camera = cam

    # a headlight that follows the camera, as in the browser
    sun_data = bpy.data.lights.new("brainGL headlight", "SUN")
    sun_data[TAG] = True
    sun_data.energy = 3.0
    sun = bpy.data.objects.new("brainGL headlight", sun_data)
    coll.objects.link(sun)
    sun.parent = cam
    return spec, aspect, objects


def setup_render(aspect, width=1920, cycles=False, samples=64):
    scene = bpy.context.scene
    scene.render.resolution_x = int(width)
    scene.render.resolution_y = max(2, int(round(width / max(aspect, 0.1))))
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    if cycles:
        scene.render.engine = "CYCLES"
        scene.cycles.samples = int(samples)
    else:
        for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):  # 4.2 - 4.5 / every other version
            try:
                scene.render.engine = engine
                break
            except Exception:
                continue
        try:
            scene.eevee.taa_render_samples = int(samples)
        except Exception:
            pass


def default_scene_dir():
    """Folder of this script, also when it is run from Blender's text editor."""
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        if os.path.exists(os.path.join(here, "scene.json")):
            return here
    except NameError:
        pass
    for text in bpy.data.texts:
        if text.filepath:
            here = os.path.dirname(bpy.path.abspath(text.filepath))
            if os.path.exists(os.path.join(here, "scene.json")):
                return here
    return os.getcwd()


def main(argv=None):
    import argparse

    argv = sys.argv[sys.argv.index("--") + 1:] if argv is None and "--" in sys.argv else (argv or [])
    ap = argparse.ArgumentParser(prog="import_braingl.py", description="Import a brainGL-web scene into Blender", allow_abbrev=False)
    ap.add_argument("scene", nargs="?", default=None, help="folder that contains scene.json (default: next to this script)")
    ap.add_argument("--render", metavar="FILE", help="render a still image")
    ap.add_argument("--save", metavar="FILE", help="save a .blend file")
    ap.add_argument("--engine", choices=["eevee", "cycles"], default="eevee", help="render engine (default: eevee)")
    ap.add_argument("--cycles", action="store_true", help="same as --engine cycles (not accepted by the Blender application, see the top of the script)")
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--resolution", type=int, default=1920, metavar="W", help="image width in pixels")
    ap.add_argument("--points", choices=["nodes", "mesh"], default="nodes")
    ap.add_argument("--keep", action="store_true", help="keep the objects that are already in the file")
    # Blender's own options for Cycles also come after the `--`; they are not ours to interpret
    ap.add_argument("--cycles-device", help=argparse.SUPPRESS)
    ap.add_argument("--cycles-print-stats", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)

    spec, aspect, objects = import_scene(a.scene or default_scene_dir(), points_mode=a.points, keep=a.keep)
    setup_render(aspect, a.resolution, a.cycles or a.engine == "cycles", a.samples)
    print(f"brainGL: imported '{spec.get('title', '')}' with {len(objects)} layer(s)")
    if a.save:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.save))
    if a.render:
        bpy.context.scene.render.filepath = os.path.abspath(a.render)
        bpy.ops.render.render(write_still=True)
        print("brainGL: rendered", bpy.context.scene.render.filepath)
    return objects


if __name__ == "__main__":
    main()
