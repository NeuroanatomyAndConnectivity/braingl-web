# Mouse and keyboard

Gestures and keys of both workspaces. They are derived from `bindEvents` and `buildToolbar`
in `src/glyphs/glyphApp.ts`, `src/gfx/camera.ts`, and for Directionality from
`src/directionality/gfx/camera.ts` and the upstream README.

## Connectivity glyphs

The main view and the inset (second view) each have their own camera and respond to the
same gestures. The gesture acts in the view under the pointer when the button goes down.
The camera is orthographic, as in brainGL.

### The tool setting

The toolbar at the top of the view (and the keys below) set the **tool**, which decides
what a plain left-button drag does.

| Tool | Key | Plain left-drag |
|---|---|---|
| Navigate | `N` | Rotate. |
| Seed | `S` | Select the node under the pointer, continuously while dragging; shows its connectivity map. |
| Paint | `P` | Paint with the brush; with `Shift`, erase. |
| Erase | `E` | Erase paint. |

The pointer is a hand (`grab`) in Navigate and a cross-hair in the other tools.

The selected node is marked by a white ring with a cross in both views. A view leaves the mark
out while the node is out of sight there: on the far side of an opaque surface, behind the
other hemisphere, or in a hemisphere that is switched off. Through a transparent surface
(alpha below 1) it is always shown.

### Pointer gestures

Evaluated in this order for a pointer press (`pointerdown`):

| Gesture | Action |
|---|---|
| Right button (`button 2`), no modifier | Select node (Seed), in any tool. Dragging keeps selecting. |
| `Alt` (`Option` on macOS) + right button | Paint; with `Shift`, erase. Works on every system, and is the way to paint with a modifier on macOS. |
| Systems other than macOS: `Ctrl` + right button | Paint (brainGL: ctrl + right-drag); with `Shift`, erase (brainGL: ctrl + shift). |
| `Ctrl` + left button | Select node. On macOS a `Ctrl`-click is the system's secondary click (browsers report it with the left or the right button) and always selects a node; it never paints, which is why painting with a modifier uses `Option` there. |
| `Alt` + `Ctrl` + left button | Paint; with `Shift`, erase. |
| Paint tool, plain left-drag | Paint on every system; with `Shift`, erase. |
| Middle button | Pan. |
| `Shift` + left button in Navigate | Pan. |
| Left button in Seed, Paint or Erase | The tool's action (`Shift` in Paint erases). |
| Left button in Navigate | Rotate (trackball). |
| `Cmd`/`Win` (meta) + left button in a non-Navigate tool | Rotate. |
| Double-click | Select the node under the pointer. |
| Wheel | Zoom about the pointer: factor `exp(deltaY * 0.0015)` per event (`exp(deltaY * 0.01)` when `Ctrl` is held, which is how browsers report a trackpad pinch). |

In the inset, paint and erase are replaced by Seed, so regions are painted only in the
main view. Seed in either view selects a node and updates both views.

Details of the motion:

- **Rotate** is a trackball: a drag of the viewport height rotates by 180 degrees
  (`pi / height` radians per pixel), about the view's x axis for vertical motion and the
  view's y axis for horizontal motion.
- **Pan** moves the target by `2 * halfHeight / viewport height` millimetres per pixel.
- **Zoom** changes `halfHeight` (half the visible height in mm) and is clamped to between
  0.4 % and 8 times the scene radius; the point under the pointer stays fixed.
- Picking is exact ray casting against the displayed surface of that view (brute-force
  Möller-Trumbore); the node returned is the nearest vertex of the triangle that was hit.
  Hemispheres hidden by the `Hemispheres` control are not picked.
- Paint and erase touch every node within the brush radius (`brushSize`, in mm on the
  displayed surface), grown along the mesh from the picked node.

### Keys

Keys act while the glyph workspace is in front, the focus is not in a text input or a
drop-down (`INPUT`, `SELECT`) and none of `Ctrl`, `Cmd` and `Alt` is held. They are case-sensitive: `n`, not `N` with caps lock.

| Key | Action |
|---|---|
| `n` | Navigate tool |
| `s` | Seed tool |
| `p` | Paint tool |
| `e` | Erase tool |
| `1` | Glyph style: points |
| `2` | Glyph style: vectors |
| `3` | Glyph style: pies |
| `4` | Glyph style: diffpoints |
| `0` | Glyph style: off |

Browser shortcuts such as `Ctrl`+`S` or `Ctrl`+`P` therefore do not change the tool.

### Toolbar

| Button | Action |
|---|---|
| Navigate, Seed, Paint, Erase | Select the tool (keys above). |
| L, R, A, P, D, V | Snap the main view to left lateral, right lateral, anterior, posterior, dorsal or ventral; this re-frames the whole surface. `Shift`-click acts on the second view. |

### Other interactions

| Action | Effect |
|---|---|
| Drop files or folders on the view | Load a dataset ([Data formats](data-formats.md#loading-rules)). |
| Top bar: panel toggle | Show or hide the control panel. |
| Top bar: workspace tabs | Switch between "Connectivity glyphs" and "Directionality" (also `?workspace=` in the URL). |
| Top bar: Export for Blender | Download the Blender bundle of the workspace in front. |

## Directionality

The vendored workspace has a perspective trackball camera
(`src/directionality/gfx/camera.ts`).

| Gesture | Action |
|---|---|
| Drag | Rotate (trackball about the target, no gimbal lock). About one full turn per canvas width. |
| `Shift` + drag | Pan (translate the target in the screen plane). |
| Wheel | Zoom: the distance is multiplied by `exp(deltaY * 0.001)`, clamped between 0.05 and 30 times the bounding-sphere radius of the mesh. |

The camera position is saved to the browser a short time after every change. The panel has
canonical-view buttons; numeric fields in the panel are committed with
`Enter` and reverted with `Escape`.
