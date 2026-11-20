# Blender scene format

The exported bundle is what the "Export for Blender" button, `npm run export:blender` and
`braingl.exportForBlender()` produce. It is a folder (or a zip of that folder) of plain geometry:
`scene.json` plus one binary PLY file per layer, and the import script. It is written by
`src/export/blenderBundle.ts` and `src/export/ply.ts`; the layers are produced by
`src/export/bake.ts` (glyph workspace) and `src/export/directionalityBake.ts`.

| File | Content |
|---|---|
| `scene.json` | Camera, background and the list of layers. |
| `<layer>.ply` | One PLY per layer. The name is a slug of the layer name (lower case, non-alphanumerics replaced by `_`), with `_2`, `_3` ... added when names repeat. |
| `import_braingl.py` | The Blender import script ([options](cli.md#publicblenderimport_brainglpy)). |
| `README.txt` | Short instructions (zip only). |

The zip uses the "stored" method (no compression) with a CRC-32 per file.

## Units and coordinates

Millimetres, in the coordinate system of the surface files: x right, y anterior, z superior
(RAS) for FreeSurfer and GIFTI data. The Blender importer sets the scene unit scale to 0.001
(`scene.unit_settings`, millimetres), so lengths are in millimetres in Blender too. Colour values
in PLY files are sRGB bytes; the importer converts them to linear colour for Blender's colour
attribute `Col`.

## `scene.json`

```json
{
 "format": "braingl-blender-scene",
 "version": 1,
 "title": "NKI Rockland average (n=40, fsaverage4) (points)",
 "units": "mm",
 "background": [0.0627, 0.0627, 0.0784],
 "camera": { "type": "ORTHO", "location": [..], "rotation_quaternion": [w, x, y, z],
             "ortho_scale": 0.0, "aspect": 1.7 },
 "layers": [ { "file": "surface_pial.ply", "name": "surface pial", "kind": "mesh",
               "shading": "lit", "smooth": true, "opacity": 1, "radius": 0,
               "vertices": 5124, "truncated": false } ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `format` | `"braingl-blender-scene"` | Checked by the importer. |
| `version` | `1` | |
| `title` | string | Names the Blender collection `brainGL: <title>`. |
| `units` | `"mm"` | |
| `background` | `[r, g, b]`, 0 to 1 (sRGB) | World colour. The browser background colour for glyph scenes; `[0.05, 0.05, 0.06]` for Directionality. |
| `camera` | object or `null` | Written for every scene exported by the app, glyph and Directionality alike. `null` or absent in a hand-made scene: the importer then builds a fallback camera (below). |
| `layers` | array | In drawing order. |

### `camera`

An orthographic camera in the convention of the browser's glyph view. The browser stores the
world-to-view rotation as a quaternion `q = [x, y, z, w]`, the target point and `halfHeight` (half the
visible height in mm). A Blender camera looks along its local -Z with +Y up, exactly like the
view space, so the camera orientation is the inverse rotation.

| Field | Value |
|---|---|
| `type` | `"ORTHO"` |
| `location` | `target + inverse(q) * (0, 0, distance)` where `distance = sceneRadius * 4 + 100` |
| `rotation_quaternion` | `inverse(q)` written as `[w, x, y, z]` (Blender's order) |
| `ortho_scale` | `2 * halfHeight * max(1, aspect)`: Blender applies the scale to the longer side of the image |
| `aspect` | width / height of the browser view; the importer sets the render height to `width / aspect` |

**Directionality scenes.** The Directionality workspace has a perspective camera that cannot be copied, so its scene
carries a camera made by `defaultSceneCamera` (`src/export/blenderBundle.ts`): a left-lateral orthographic view (the viewer
at -x looking toward +x, +z up, as the "L" view button) that frames the bounding box of all layers, grown by the radius of
point and tube layers, with a 6 % margin, for the export aspect ratio (width / height). `halfHeight` is the larger of half
the box height (z) and half the box width (y) divided by the aspect, times 1.06, the target is the centre of the box, and
`distance` is twice the box diagonal plus 100 mm, so the camera is outside the scene.

**Fallback camera.** If `camera` is missing, the import script builds a left-lateral orthographic camera (looking along
+x, +z up) that frames the bounding box of all layers for a 16:9 render, with a 6 % margin and `ortho_scale` chosen so that
the box fits both the width and the height; the camera sits outside the box (twice its diagonal plus 100 mm). A scene with
no vertex at all is framed as a box of +-100 mm.

The importer parents a sun lamp (energy 3) to the camera as a headlight, as in the browser, and
sets the view transform to Standard so that data colours stay as exported.

### `layers[]`

| Field | Meaning |
|---|---|
| `file` | PLY file name next to `scene.json`. |
| `name` | Layer (and Blender object) name. |
| `kind` | `"mesh"` (triangles), `"points"` (vertices only) or `"segments"` (vertex pairs joined by edges). |
| `shading` | `"lit"`: shaded anatomy with a Principled material; `"flat"`: emission material, so lighting does not alter colours that encode data. |
| `smooth` | Use smooth shading (meshes). |
| `opacity` | 1 = opaque; below 0.999 a blended material with that alpha (lit layers). |
| `radius` | Radius in mm of the sphere/octahedron (points) or tube (segments) that the importer builds; 0 for meshes. The importer uses 0.25 if it is 0. |
| `vertices` | Number of vertices in the PLY. |
| `truncated` | `true` if the layer was sub-sampled to stay under the primitive limit (400,000 by default from the browser; `maxPrims`), or, for little brains, limited to `min(lbMax, floor(4e6 / n))` copies. |

## Layer kinds produced

| Layer name | Kind | Shading | Content |
|---|---|---|---|
| `surface <name>` | mesh | lit | The displayed surface, with vertex colours that reproduce the surface colour mode (sulcal shading, seed map, overlay, paint). Triangles of hidden hemispheres are dropped. |
| `little brains` | mesh | lit | All anatomical background glyphs merged into one mesh. Not exported for the polar projection. |
| `glyphs points` | points | flat | One vertex per visible connexel. |
| `glyphs vectors` | segments | flat | Two vertices and one edge per connexel; tube radius half of `primRadius`. |
| `glyphs pies` | mesh | flat | Wedge triangles (three vertices each, not shared). |
| `glyphs diffpoints` | points | flat | One vertex per visible edge-target pair. |
| `connections` | segments | flat | Connexels or bundles as polylines (`showConnections`). |
| `parcellated surface` | mesh | lit | Directionality: the PLY surface with its colours. |
| `arrows` | mesh | flat | Directionality: flat arrow polygons just above the surface (the LIC streaks are a screen-space effect and are not exported). |

### How glyphs are placed in a 3-D export

The baker mirrors the vertex shaders on the CPU with one deliberate difference: there is no
fixed camera. On screen, glyphs are lifted toward the viewer and pies and polar projections face
the camera. In the export:

- glyphs are lifted along the **surface normal** of the displayed surface by
  `depthLift * glyphRadius * 100` mm (for pies, with a further `0.05 * (1 - rel)` fraction of
  `glyphRadius * 100`);
- flat glyphs (pies, the polar projection) lie in the plane tangent to the surface at the node: the
  local frame is `n` = normal, `up` = the superior axis (0,0,1) projected into the tangent plane
  (or (0,1,0) if the normal is nearly vertical) and `right = up x n`;
- the formulas for `G(j) - G(i)`, the polar offset and the colour are those of
  [Glyph types](glyph-types.md);
- pies are resampled to at most 48 wedges each, every wedge taking the mean colour of the slices
  it covers (a pie can have thousands of slices); a pie with one or two slices uses 24 wedges, so that its triangles have
  an area;
- point and vector primitives are real geometry, so `primSize` is replaced by the layer `radius`
  (`max(0.03, 0.5 * primSize * mm per pixel)` from the browser);
- diffpoints use the same prefilter and budget as the screen (`GlyphBakeInput.buildThreshold` and `budget`), then the same
  display test on the difference (`threshold < diff <= maxThreshold`) and the minimum length;
- glyph alpha is ignored: all primitives are opaque and carry only their colour;
- the `targets` mask (second ROI) restricts the connexels as on screen.

### Notes on the importer and on rendering

- Point layers made as geometry-nodes point clouds (`--points nodes`, the default) are drawn by EEVEE as small diamonds and by
  Cycles as spheres. Use `--points mesh` for identical geometry in both engines.
- Flat (data-colour) layers do not light or shadow the anatomy in Cycles.
- The arrows of the Directionality bake are projected into the tangent plane of the surface.

## PLY layout

Binary little-endian PLY 1.0, readable by Blender's own importer, MeshLab and ParaView; the bundled
script reads exactly this layout. Header (ASCII):

```
ply
format binary_little_endian 1.0
comment brainGL-web <kind> layer: <name>
element vertex <nv>
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
property uchar alpha
element face <nf>                           only if nf > 0
property list uchar int vertex_indices
element edge <ne>                           only if ne > 0
property int vertex1
property int vertex2
end_header
```

Body, in this order, tightly packed with no padding:

| Block | Record | Size |
|---|---|---|
| vertices | `float32 x, y, z; uint8 r, g, b, a` | 16 bytes each |
| faces | `uint8 3; int32 a, b, c` | 13 bytes each |
| edges | `int32 v1, v2` | 8 bytes each |
