#!/usr/bin/env python3
"""Create glyphsets for brainGL-web.

A *web glyphset* is a folder with a ``glyphset.json`` manifest plus raw
little-endian binary files (surfaces, triangles, connectivity). It is the
browser-friendly successor of brainGL's ``.glyphset`` / ``.set`` / ``.asc`` /
float32-matrix file family (see docs/reference/data-formats.md).

Sub-commands
------------
from-matrix      surfaces + an existing node-by-node matrix (.npy or raw float32)
from-timeseries  surfaces + surface time series (.func.gii / .npy) -> Pearson r
nki-demo         group-average functional connectivity of the enhanced NKI
                 Rockland sample (the data set of Boettger et al. 2014),
                 downloaded through nilearn, on fsaverage4 or fsaverage5
to-braingl       convert a web glyphset back to the original brainGL files

Requires: numpy, nibabel (and nilearn for ``nki-demo``).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np


# --------------------------------------------------------------------------- IO
def load_surface(path):
    """Return (xyz float32 [n,3], triangles int32 [m,3]) from GIFTI, FreeSurfer
    binary or FreeSurfer ASCII (.asc) surfaces."""
    import nibabel as nib

    p = str(path)
    if p.endswith(".asc"):
        with open(p) as f:
            lines = f.read().split("\n")
        k = 1 if lines[0].startswith("#") else 0
        nv, nt = (int(x) for x in lines[k].split()[:2])
        xyz = np.array([l.split()[:3] for l in lines[k + 1:k + 1 + nv]], dtype=np.float32)
        tri = np.array([l.split()[:3] for l in lines[k + 1 + nv:k + 1 + nv + nt]], dtype=np.int32)
        return xyz, tri
    if p.endswith(".gii") or p.endswith(".gii.gz"):
        g = nib.load(p)
        xyz = g.agg_data("pointset").astype(np.float32)
        tri = g.agg_data("triangle").astype(np.int32)
        return xyz, tri
    xyz, tri = nib.freesurfer.read_geometry(p)
    return xyz.astype(np.float32), tri.astype(np.int32)


def load_scalars(path):
    import nibabel as nib

    p = str(path)
    if p.endswith(".npy"):
        return np.load(p)
    if p.endswith(".gii") or p.endswith(".gii.gz"):
        g = nib.load(p)
        return np.stack([d.data for d in g.darrays], axis=-1).squeeze()
    return nib.freesurfer.read_morph_data(p)


def load_matrix(path, n=None):
    p = str(path)
    if p.endswith(".npy"):
        return np.load(p, mmap_mode="r")
    size = os.path.getsize(p)
    n = n or int(round(np.sqrt(size / 4)))
    if n * n * 4 != size:
        raise SystemExit(f"{p}: not a square float32 matrix ({size} bytes)")
    return np.memmap(p, dtype="<f4", mode="r", shape=(n, n))


# ---------------------------------------------------------------------- writing
def separate_hemispheres(left, right, gap=5.0):
    """Shift two hemispheres apart along x so that they do not overlap (inflated
    and spherical representations are both centred on the origin)."""
    overlap = left[:, 0].max() - right[:, 0].min()
    if overlap <= -gap:
        return left, right
    shift = (overlap + gap) / 2.0
    l, r = left.copy(), right.copy()
    l[:, 0] -= shift
    r[:, 0] += shift
    return l, r


def quantize_upper(conn, dtype="int8"):
    """Pack the strict upper triangle of a symmetric matrix as scaled integers."""
    n = conn.shape[0]
    iu = np.triu_indices(n, k=1)
    vals = np.asarray(conn[iu], dtype=np.float32)
    vals = np.nan_to_num(vals, nan=0.0, posinf=0.0, neginf=0.0)
    if dtype == "float32":
        return vals.astype("<f4"), 1.0
    vmax = float(np.abs(vals).max()) or 1.0
    top = 127 if dtype == "int8" else 32767
    q = np.rint(vals / vmax * top).astype("<i1" if dtype == "int8" else "<i2")
    return q, vmax / top


def write_glyphset(out, name, surfaces, triangles, conn, left_nodes=0, left_triangles=0,
                   overlays=None, mask=None, dtype="int8", description="", extra=None):
    """surfaces: list of (name, xyz[n,3]); conn: symmetric [n,n] array-like."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    n = surfaces[0][1].shape[0]
    assert conn.shape == (n, n), f"matrix is {conn.shape}, surfaces have {n} nodes"
    man = {
        "format": "braingl-web-glyphset", "version": 1, "name": name, "description": description,
        "nodes": int(n), "leftNodes": int(left_nodes), "leftTriangles": int(left_triangles),
        "triangles": "triangles.u32", "surfaces": [], "overlays": [],
    }
    np.asarray(triangles, dtype="<u4").tofile(out / "triangles.u32")
    for sname, xyz in surfaces:
        assert xyz.shape == (n, 3), f"surface {sname} has {xyz.shape[0]} nodes, expected {n}"
        fn = f"{sname}.f32"
        np.asarray(xyz, dtype="<f4").tofile(out / fn)
        man["surfaces"].append({"name": sname, "file": fn})
    for oname, data in (overlays or []):
        fn = f"{oname}.f32"
        np.asarray(data, dtype="<f4").tofile(out / fn)
        man["overlays"].append({"name": oname, "file": fn})
    if mask is not None:
        np.asarray(mask, dtype=np.uint8).tofile(out / "mask.u8")
        man["mask"] = "mask.u8"
    q, scale = quantize_upper(conn, dtype)
    ext = {"int8": "i8", "int16": "i16", "float32": "f32"}[dtype]
    q.tofile(out / f"connectivity.{ext}")
    man["connectivity"] = {"file": f"connectivity.{ext}", "dtype": dtype, "layout": "upper", "scale": scale}
    if extra:
        man.update(extra)
    with open(out / "glyphset.json", "w") as f:
        json.dump(man, f, indent=1)
    total = sum(p.stat().st_size for p in out.iterdir())
    print(f"wrote {out}  ({n} nodes, {total / 1e6:.1f} MB)")


def stack_hemis(lh, rh):
    """Concatenate two (xyz, tri) meshes into one, as brainGL does for two .set files."""
    (lx, lt), (rx, rt) = lh, rh
    return np.vstack([lx, rx]), np.vstack([lt, rt + lx.shape[0]])


# ------------------------------------------------------------------ correlation
def zscore_rows(ts):
    ts = np.asarray(ts, dtype=np.float32)
    ts = ts - ts.mean(axis=1, keepdims=True)
    sd = ts.std(axis=1, keepdims=True)
    valid = sd[:, 0] > 1e-6
    ts[valid] /= sd[valid]
    ts[~valid] = 0
    return ts, valid


def correlation(ts):
    """Pearson correlation between rows of ts [n, t] (float32, memory-lean)."""
    z, valid = zscore_rows(ts)
    r = (z @ z.T) / z.shape[1]
    np.clip(r, -1, 1, out=r)
    return r, valid


def ico_neighbour_average(ts, tri, n_keep):
    """Average each of the first n_keep vertices with its 1-ring neighbours.

    FreeSurfer's fsaverage meshes are nested icospheres: the first 2562 vertices
    of fsaverage5 are the vertices of fsaverage4, etc. Averaging over the 1-ring
    before sub-sampling is a cheap anti-aliasing filter."""
    from scipy import sparse

    n = ts.shape[0]
    e = np.vstack([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
    a = sparse.coo_matrix((np.ones(len(e), np.float32), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    a = ((a + a.T) > 0).astype(np.float32) + sparse.identity(n, dtype=np.float32, format="csr")
    a = a[:n_keep]
    # ignore empty (medial wall) time series in the average
    nz = (np.abs(ts).sum(axis=1) > 0).astype(np.float32)
    w = a.multiply(nz[None, :]).tocsr()
    norm = np.asarray(w.sum(axis=1)).ravel()
    norm[norm == 0] = 1
    out = (w @ ts) / norm[:, None]
    out[nz[:n_keep] == 0] = 0  # keep the medial wall empty
    return out.astype(np.float32)


# ------------------------------------------------------------------ sub-commands
ANATOMICAL = ("pial", "white", "midthickness", "smoothwm", "orig")
KNOWN_SURFACES = ("very_inflated", "veryinflated", "midthickness", "inflated", "sphere", "pial", "white", "flat", "smoothwm", "orig")


def surface_label(path):
    """pial / inflated / sphere ... from names like lh.pial, L.inflated.asc or sub.L.pial.32k_fs_LR.surf.gii."""
    b = Path(path).name.lower()
    for k in KNOWN_SURFACES:
        if k in b:
            return k
    parts = [x for x in b.split(".") if x not in ("lh", "rh", "l", "r", "left", "right", "asc", "gii", "surf", "gz")]
    return parts[0] if parts else b


def cmd_from_matrix(a, mask=None):
    names = a.names.split(",") if a.names else None
    left = [load_surface(p) for p in a.left]
    right = [load_surface(p) for p in a.right] if a.right else None
    surfaces, tri, ln, lt = [], None, 0, 0
    for k, lh in enumerate(left):
        nm = names[k] if names else surface_label(a.left[k])
        if right:
            rh = right[k]
            # anatomical surfaces are already in a common space; only inflated / spherical ones overlap
            lx, rx = (lh[0], rh[0]) if a.no_separate or nm in ANATOMICAL else separate_hemispheres(lh[0], rh[0])
            xyz, t = stack_hemis((lx, lh[1]), (rx, rh[1]))
            ln, lt = lh[0].shape[0], lh[1].shape[0]
        else:
            xyz, t = lh
        surfaces.append((nm, xyz))
        tri = t
    conn = load_matrix(a.matrix, surfaces[0][1].shape[0])
    overlays = []
    for spec in a.overlay or []:
        nm, *paths = spec.split("=")[0], *spec.split("=")[1].split(",")
        data = np.concatenate([np.ravel(load_scalars(p)) for p in paths])
        if data.shape[0] != surfaces[0][1].shape[0]:
            raise SystemExit(f"overlay {nm} has {data.shape[0]} values, the surfaces have {surfaces[0][1].shape[0]} nodes")
        overlays.append((nm, data))
    write_glyphset(a.out, a.name or Path(a.out).name, surfaces, tri, conn, ln, lt, overlays, mask=mask, dtype=a.dtype)


def cmd_from_timeseries(a):
    ts = np.concatenate([np.atleast_2d(load_scalars(p)) for p in a.timeseries], axis=0)
    print("time series", ts.shape)
    r, valid = correlation(ts)
    tmp = Path(a.out) / "_conn.npy"
    Path(a.out).mkdir(parents=True, exist_ok=True)
    np.save(tmp, r)
    a.matrix = str(tmp)
    try:
        cmd_from_matrix(a, mask=valid)  # nodes without signal (medial wall) are masked
    finally:
        tmp.unlink()


def cmd_nki_demo(a):
    from nilearn import datasets
    import nibabel as nib

    nki = datasets.fetch_surf_nki_enhanced(n_subjects=a.subjects, data_dir=a.data_dir)
    fs5 = datasets.fetch_surf_fsaverage("fsaverage5", data_dir=a.data_dir)
    fs = datasets.fetch_surf_fsaverage(a.mesh, data_dir=a.data_dir)
    n5 = 10242
    nk = {"fsaverage3": 642, "fsaverage4": 2562, "fsaverage5": 10242}[a.mesh]
    tri5 = [load_surface(fs5[f"pial_{h}"])[1] for h in ("left", "right")]
    hemis = ["left"] if a.hemi == "lh" else ["right"] if a.hemi == "rh" else ["left", "right"]
    n = nk * len(hemis)
    zsum = np.zeros((n, n), dtype=np.float32)
    valid_all = np.ones(n, dtype=bool)
    used = 0
    for s in range(len(nki["func_left"])):
        parts = []
        for h in hemis:
            g = nib.load(nki[f"func_{h}"][s])
            ts = np.stack([d.data for d in g.darrays], axis=1).astype(np.float32)
            if ts.shape[0] != n5:
                raise SystemExit("unexpected node count")
            if nk < n5:
                ts = ico_neighbour_average(ts, tri5[0 if h == "left" else 1], nk)
            parts.append(ts)
        r, valid = correlation(np.concatenate(parts, axis=0))
        valid_all &= valid
        np.clip(r, -0.999999, 0.999999, out=r)
        zsum += np.arctanh(r)
        used += 1
        print(f"  subject {used}/{len(nki['func_left'])}", flush=True)
    r = np.tanh(zsum / used)  # Fisher r-to-z average, as in the paper
    r[~valid_all, :] = 0
    r[:, ~valid_all] = 0
    np.fill_diagonal(r, 0)
    surfaces = []
    tri, ln, lt = None, 0, 0
    for nm, key in (("pial", "pial"), ("inflated", "infl"), ("sphere", "sphere"), ("white", "white")):
        ms = [load_surface(fs[f"{key}_{h}"]) for h in hemis]
        if len(ms) == 2:
            lx, rx = (ms[0][0], ms[1][0]) if nm in ("pial", "white") else separate_hemispheres(ms[0][0], ms[1][0])
            xyz, tri = stack_hemis((lx, ms[0][1]), (rx, ms[1][1]))
            ln, lt = ms[0][0].shape[0], ms[0][1].shape[0]
        else:
            xyz, tri = ms[0]
        surfaces.append((nm, xyz))
    sulc = np.concatenate([np.ravel(load_scalars(fs[f"sulc_{h}"])) for h in hemis])
    curv = np.concatenate([np.ravel(load_scalars(fs[f"curv_{h}"])) for h in hemis])
    desc = (f"Group-average resting-state functional connectivity (Pearson r, Fisher-z averaged) of "
            f"{used} participants of the enhanced NKI Rockland sample, {a.mesh} "
            f"({'both hemispheres' if len(hemis) == 2 else hemis[0] + ' hemisphere'}).")
    write_glyphset(a.out, f"NKI Rockland average (n={used}, {a.mesh})", surfaces, tri, r, ln, lt,
                   overlays=[("sulc", sulc), ("curv", curv)], mask=valid_all, dtype=a.dtype, description=desc,
                   extra={"source": "http://fcon_1000.projects.nitrc.org/indi/enhanced/", "subjects": used})


def cmd_to_braingl(a):
    src = Path(a.glyphset)
    man = json.load(open(src / "glyphset.json"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    n, ln, lt = man["nodes"], man.get("leftNodes", 0), man.get("leftTriangles", 0)
    tri = np.fromfile(src / man["triangles"], dtype="<u4").reshape(-1, 3)

    def write_asc(path, xyz, t):
        with open(path, "w") as f:
            f.write("#!ascii version of surface, written by braingl-web make_glyphset.py\n")
            f.write(f"{len(xyz)} {len(t)}\n")
            np.savetxt(f, np.c_[xyz, np.zeros(len(xyz))], fmt="%.6f %.6f %.6f %d")
            np.savetxt(f, np.c_[t, np.zeros(len(t), dtype=int)], fmt="%d %d %d %d")

    sets = {"L": [], "R": []} if ln else {"all": []}
    for s in man["surfaces"]:
        xyz = np.fromfile(src / s["file"], dtype="<f4").reshape(-1, 3)
        if ln:
            write_asc(out / f"L.{s['name']}.asc", xyz[:ln], tri[:lt])
            write_asc(out / f"R.{s['name']}.asc", xyz[ln:], tri[lt:] - ln)
            sets["L"].append(f"L.{s['name']}.asc")
            sets["R"].append(f"R.{s['name']}.asc")
        else:
            write_asc(out / f"{s['name']}.asc", xyz, tri)
            sets["all"].append(f"{s['name']}.asc")
    for k, v in sets.items():
        (out / f"{k}.set").write_text("\n".join(v) + "\n")
    c = man["connectivity"]
    dt = {"int8": "<i1", "int16": "<i2", "float32": "<f4"}[c["dtype"]]
    raw = np.fromfile(src / c["file"], dtype=dt).astype(np.float32) * c.get("scale", 1.0)
    m = np.zeros((n, n), dtype="<f4")
    if c.get("layout", "full") == "upper":
        iu = np.triu_indices(n, k=1)
        m[iu] = raw
        m = m + m.T
        np.fill_diagonal(m, 1.0)
    else:
        m[:] = raw.reshape(n, n)
    m.tofile(out / "connectivity.bin")
    (out / "data.glyphset").write_text(
        "anatomy.nii.gz\n" + " ".join(f"{k}.set" for k in sets) + f"\nconnectivity.bin {a.min_threshold}\n")
    print(f"wrote brainGL glyphset to {out}/data.glyphset")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--left", nargs="+", required=True, help="surfaces of the left hemisphere (or of the only mesh), e.g. pial inflated sphere")
        p.add_argument("--right", nargs="+", help="matching surfaces of the right hemisphere")
        p.add_argument("--names", help="comma separated surface names (default: derived from file names)")
        p.add_argument("--overlay", action="append", help="name=left_file[,right_file] per-node scalars, e.g. sulc=lh.sulc,rh.sulc")
        p.add_argument("--no-separate", action="store_true", help="do not move overlapping hemispheres apart")
        p.add_argument("--dtype", default="int8", choices=["int8", "int16", "float32"])
        p.add_argument("--name")
        p.add_argument("--out", required=True)

    p = sub.add_parser("from-matrix", help="surfaces + node-by-node matrix")
    common(p)
    p.add_argument("--matrix", required=True, help=".npy or raw float32 square matrix (brainGL format)")
    p.set_defaults(func=cmd_from_matrix)

    p = sub.add_parser("from-timeseries", help="surfaces + surface time series")
    common(p)
    p.add_argument("--timeseries", nargs="+", required=True, help="left [right] .func.gii or .npy [nodes, time]")
    p.set_defaults(func=cmd_from_timeseries)

    p = sub.add_parser("nki-demo", help="enhanced NKI Rockland group average via nilearn")
    p.add_argument("--subjects", type=int, default=40)
    p.add_argument("--mesh", default="fsaverage4", choices=["fsaverage3", "fsaverage4", "fsaverage5"])
    p.add_argument("--hemi", default="both", choices=["both", "lh", "rh"])
    p.add_argument("--dtype", default="int8", choices=["int8", "int16", "float32"])
    p.add_argument("--data-dir", default=None)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_nki_demo)

    p = sub.add_parser("to-braingl", help="web glyphset -> original brainGL .glyphset/.set/.asc/float32")
    p.add_argument("glyphset")
    p.add_argument("--out", required=True)
    p.add_argument("--min-threshold", type=float, default=0.5)
    p.set_defaults(func=cmd_to_braingl)

    a = ap.parse_args(argv)
    a.func(a)


if __name__ == "__main__":
    sys.exit(main())
