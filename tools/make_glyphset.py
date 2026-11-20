#!/usr/bin/env python3
"""Create glyphsets for brainGL-web.

A *web glyphset* is a folder with a ``glyphset.json`` manifest plus raw
little-endian binary files (surfaces, triangles, connectivity). It is the
browser-friendly successor of brainGL's ``.glyphset`` / ``.set`` / ``.asc`` /
float32-matrix file family (see docs/reference/data-formats.md).

Sub-commands
------------
from-matrix      surfaces + an existing symmetric node-by-node matrix
                 (.npy or raw float32)
from-timeseries  surfaces + per-node time series (.func.gii / .npy) -> Pearson r
nki-demo         group-average functional connectivity of the enhanced NKI
                 Rockland sample (the data set of Boettger et al. 2014),
                 downloaded through nilearn, on fsaverage3, 4 or 5
to-braingl       convert a web glyphset back to the original brainGL files

Surfaces are read from GIFTI (.gii, .gii.gz), FreeSurfer binary (lh.pial) or
FreeSurfer ASCII (.asc) files. Run a sub-command with --help for its options.

Requires numpy and nibabel; ``nki-demo`` also needs nilearn and scipy.
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
    vmax = (float(np.abs(vals).max()) if vals.size else 0.0) or 1.0   # a 1 x 1 matrix has no upper triangle
    top = 127 if dtype == "int8" else 32767
    q = np.rint(vals / vmax * top).astype("<i1" if dtype == "int8" else "<i2")
    return q, vmax / top


def unique_names(names, taken=()):
    """Make names unique by numbering repeats: pial, pial -> pial, pial_2.

    Every surface and overlay is stored as ``<name>.f32``, so two entries with
    the same name would overwrite each other. Names are compared without
    regard to case (the files may live on a case-insensitive file system);
    ``taken`` lists names that are in use already."""
    seen = {str(t).lower() for t in taken}
    out = []
    for nm in names:
        nm = str(nm)
        if not nm or nm in (".", "..") or any(c in nm for c in "/\\\0"):
            raise SystemExit(f"{nm!r} cannot be used as a surface or overlay name (it becomes a file name)")
        cand, k = nm, 1
        while cand.lower() in seen:
            k += 1
            cand = f"{nm}_{k}"
        seen.add(cand.lower())
        out.append(cand)
    return out


def write_glyphset(out, name, surfaces, triangles, conn, left_nodes=0, left_triangles=0,
                   overlays=None, mask=None, dtype="int8", description="", extra=None):
    """surfaces: list of (name, xyz[n,3]); conn: symmetric [n,n] array-like.

    Surfaces (and overlays) that share a name are numbered (pial, pial_2), in
    the file names as well as in the manifest."""
    n = surfaces[0][1].shape[0]
    assert conn.shape == (n, n), f"matrix is {conn.shape}, surfaces have {n} nodes"
    for sname, xyz in surfaces:
        assert xyz.shape == (n, 3), f"surface {sname} has {xyz.shape[0]} nodes, expected {n}"
    overlays = list(overlays or [])
    # "connectivity.f32" is the matrix of a float32 glyphset
    snames = unique_names([s for s, _ in surfaces], taken=["connectivity"])
    onames = unique_names([o for o, _ in overlays], taken=["connectivity", *snames])
    for old, new in zip([s for s, _ in surfaces] + [o for o, _ in overlays], snames + onames):
        if old != new:
            print(f"note: there is more than one \"{old}\"; one of them is stored as \"{new}\"")
    surfaces = [(nm, xyz) for nm, (_, xyz) in zip(snames, surfaces)]
    overlays = [(nm, data) for nm, (_, data) in zip(onames, overlays)]
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    man = {
        "format": "braingl-web-glyphset", "version": 1, "name": name, "description": description,
        "nodes": int(n), "leftNodes": int(left_nodes), "leftTriangles": int(left_triangles),
        "triangles": "triangles.u32", "surfaces": [], "overlays": [],
    }
    np.asarray(triangles, dtype="<u4").tofile(out / "triangles.u32")
    for sname, xyz in surfaces:
        fn = f"{sname}.f32"
        np.asarray(xyz, dtype="<f4").tofile(out / fn)
        man["surfaces"].append({"name": sname, "file": fn})
    for oname, data in overlays:
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


def nodes_with_data(conn, chunk=1024):
    """True for every node that has at least one non-zero value off the diagonal, in its row or its column
    (the rule of the browser's loaders for matrices that come without a mask: the others are the medial wall)."""
    n = conn.shape[0]
    has = np.zeros(n, dtype=bool)
    for lo in range(0, n, chunk):
        block = np.nan_to_num(np.asarray(conn[lo:lo + chunk], dtype=np.float32), nan=0.0, posinf=0.0, neginf=0.0) != 0
        rows = np.arange(lo, min(n, lo + chunk))
        block[rows - lo, rows] = False
        has[rows] |= block.any(axis=1)
        has |= block.any(axis=0)
    return has


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


def cmd_from_matrix(a, mask=None, conn=None):
    """Write a glyphset from the surfaces and the matrix named on the command line
    (or from `conn`, a matrix that is in memory already)."""
    names = [x.strip() for x in a.names.split(",")] if a.names else None
    if names and len(names) != len(a.left):
        raise SystemExit(f"--names lists {len(names)} names for {len(a.left)} surfaces")
    if a.right and len(a.right) != len(a.left):
        raise SystemExit(f"--right lists {len(a.right)} surfaces, --left {len(a.left)}: give the same surfaces for both hemispheres, in the same order")
    left = [load_surface(p) for p in a.left]
    right = [load_surface(p) for p in a.right] if a.right else None
    surfaces, tri, ln, lt = [], None, 0, 0
    for k, lh in enumerate(left):
        nm = names[k] if names else surface_label(a.left[k])
        if right:
            rh = right[k]
            # anatomical surfaces are already in a common space; only inflated / spherical ones overlap
            lx, rx = (lh[0], rh[0]) if a.no_separate or nm in ANATOMICAL else separate_hemispheres(lh[0], rh[0])
            xyz, tri = stack_hemis((lx, lh[1]), (rx, rh[1]))
            ln, lt = lh[0].shape[0], lh[1].shape[0]
        else:
            xyz, tri = lh
        if surfaces and xyz.shape[0] != surfaces[0][1].shape[0]:
            raise SystemExit(f"surface {nm} has {xyz.shape[0]} nodes, {surfaces[0][0]} has {surfaces[0][1].shape[0]}")
        surfaces.append((nm, xyz))
    n = surfaces[0][1].shape[0]
    if conn is None:
        conn = load_matrix(a.matrix, n)
    if conn.ndim != 2 or conn.shape != (n, n):
        raise SystemExit(f"the matrix has shape {tuple(conn.shape)}, the surfaces have {n} nodes (expected {n} x {n})")
    overlays = []
    for spec in a.overlay or []:
        nm, sep, files = spec.partition("=")
        if not sep or not nm or not files:
            raise SystemExit(f"--overlay {spec!r}: expected name=left_file[,right_file]")
        data = np.concatenate([np.ravel(load_scalars(p)) for p in files.split(",")])
        if data.shape[0] != n:
            raise SystemExit(f"overlay {nm} has {data.shape[0]} values, the surfaces have {n} nodes")
        overlays.append((nm, data))
    if mask is None:
        # nodes with an empty row and column (the medial wall of most matrices) carry no data
        mask = nodes_with_data(conn)
        if mask.all():
            mask = None
    write_glyphset(a.out, a.name or Path(a.out).name, surfaces, tri, conn, ln, lt, overlays, mask=mask, dtype=a.dtype)


def cmd_from_timeseries(a):
    ts = np.concatenate([np.atleast_2d(load_scalars(p)) for p in a.timeseries], axis=0)
    print("time series", ts.shape)
    r, valid = correlation(ts)
    # the matrix is handed over in memory: nothing temporary is written to the output folder
    cmd_from_matrix(a, mask=valid, conn=r)  # nodes without signal (medial wall) are masked


NKI_SOURCE = "http://fcon_1000.projects.nitrc.org/indi/enhanced/"


def nki_description(subjects, mesh, hemis):
    """Manifest description of the NKI demo; hemis is ["left", "right"], ["left"] or ["right"]."""
    which = "both hemispheres" if len(hemis) == 2 else f"{hemis[0]} hemisphere"
    return ("Group-average resting-state functional connectivity (Pearson r, Fisher-z averaged) of "
            f"{subjects} participant{'' if subjects == 1 else 's'} of the enhanced NKI Rockland Sample (Nooner et al. 2012, "
            f"doi:10.3389/fnins.2012.00152) on the FreeSurfer {mesh} surface, {which}.")


def nki_credit(mesh):
    """Manifest "credit" line of the NKI demo: the data are redistributed with attribution."""
    return ("Data: enhanced Nathan Kline Institute - Rockland Sample (Nooner et al. 2012), 1000 Functional "
            f"Connectomes Project / INDI. Surfaces: FreeSurfer {mesh} (Fischl et al. 1999).")


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
    write_glyphset(a.out, f"NKI Rockland average (n={used}, {a.mesh})", surfaces, tri, r, ln, lt,
                   overlays=[("sulc", sulc), ("curv", curv)], mask=valid_all, dtype=a.dtype,
                   description=nki_description(used, a.mesh, hemis),
                   extra={"source": NKI_SOURCE, "subjects": used, "credit": nki_credit(a.mesh)})


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
    # .set files list one file name per line, separated from the offsets by blanks: no blanks in the names
    stems = unique_names(["_".join(str(s["name"]).split()) or "surface" for s in man["surfaces"]])
    for s, stem in zip(man["surfaces"], stems):
        xyz = np.fromfile(src / s["file"], dtype="<f4").reshape(-1, 3)
        if ln:
            write_asc(out / f"L.{stem}.asc", xyz[:ln], tri[:lt])
            write_asc(out / f"R.{stem}.asc", xyz[ln:], tri[lt:] - ln)
            sets["L"].append(f"L.{stem}.asc")
            sets["R"].append(f"R.{stem}.asc")
        else:
            write_asc(out / f"{stem}.asc", xyz, tri)
            sets["all"].append(f"{stem}.asc")
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


DTYPE_HELP = ("how the connectivity values are stored: int8 (default; 1 byte per pair, values rounded to 1/127 of the "
              "largest |value|), int16 (1/32767) or float32 (unchanged)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--left", nargs="+", required=True, metavar="SURFACE",
                       help="surface files of the left hemisphere (or of the only mesh), e.g. lh.pial lh.inflated lh.sphere; "
                            "the first one should be the anatomical surface, all need the same nodes")
        p.add_argument("--right", nargs="+", metavar="SURFACE",
                       help="the same surfaces of the right hemisphere, in the same order; its nodes follow those of the left")
        p.add_argument("--names", help="comma separated surface names, one per --left file (default: pial, inflated, sphere ... "
                                       "taken from the file names); repeated names are numbered (pial, pial_2)")
        p.add_argument("--overlay", action="append", metavar="NAME=LEFT[,RIGHT]",
                       help="per-node scalars (.npy, GIFTI or FreeSurfer curv), e.g. sulc=lh.sulc,rh.sulc; may be given several times")
        p.add_argument("--no-separate", action="store_true",
                       help="keep all coordinates as they are (by default the two hemispheres of every surface that is not "
                            "pial, white, midthickness, smoothwm or orig are moved apart along x until they are 5 mm apart)")
        p.add_argument("--dtype", default="int8", choices=["int8", "int16", "float32"], help=DTYPE_HELP)
        p.add_argument("--name", help="name of the glyphset shown in the browser (default: the name of the output folder)")
        p.add_argument("--out", required=True, help="output folder (created if needed); it receives glyphset.json and the binary files")

    p = sub.add_parser("from-matrix", help="surfaces + node-by-node matrix",
                       description="Write a web glyphset from surfaces and an existing connectivity matrix. Nodes whose "
                                   "row and column are entirely zero (the medial wall) are masked.")
    common(p)
    p.add_argument("--matrix", required=True,
                   help="square matrix with one row per node (left hemisphere first), as .npy or raw little-endian float32 "
                        "(the brainGL format); it is taken to be symmetric: only the upper triangle is stored")
    p.set_defaults(func=cmd_from_matrix)

    p = sub.add_parser("from-timeseries", help="surfaces + surface time series",
                       description="Write a web glyphset whose connectivity is the Pearson correlation between the time "
                                   "series of the nodes. Nodes without signal (constant time series) are masked.")
    common(p)
    p.add_argument("--timeseries", nargs="+", required=True, metavar="FILE",
                   help="time series of the left [and right] hemisphere: .func.gii (one data array per time point) "
                        "or .npy of shape [nodes, time]")
    p.set_defaults(func=cmd_from_timeseries)

    p = sub.add_parser("nki-demo", help="enhanced NKI Rockland group average via nilearn",
                       description="Download surface time series of the enhanced NKI Rockland sample and the fsaverage "
                                   "surfaces with nilearn, and write the Fisher-z average of the participants' "
                                   "correlation matrices as a web glyphset (pial, inflated, sphere and white surfaces, "
                                   "sulc and curv overlays).")
    p.add_argument("--subjects", type=int, default=40, help="number of participants to average (default: 40)")
    p.add_argument("--mesh", default="fsaverage4", choices=["fsaverage3", "fsaverage4", "fsaverage5"],
                   help="surface mesh: 642, 2562 (default) or 10242 nodes per hemisphere; for the two smaller meshes the "
                        "fsaverage5 time series are averaged over each node and its neighbours before sub-sampling")
    p.add_argument("--hemi", default="both", choices=["both", "lh", "rh"], help="hemispheres to include (default: both, left first)")
    p.add_argument("--dtype", default="int8", choices=["int8", "int16", "float32"], help=DTYPE_HELP)
    p.add_argument("--data-dir", default=None, help="where nilearn keeps its downloads (default: nilearn's own data folder)")
    p.add_argument("--out", required=True, help="output folder (created if needed)")
    p.set_defaults(func=cmd_nki_demo)

    p = sub.add_parser("to-braingl", help="web glyphset -> original brainGL .glyphset/.set/.asc/float32",
                       description="Convert a web glyphset to the files the original brainGL reads: data.glyphset, one "
                                   ".set file and one FreeSurfer .asc surface per hemisphere and surface, and the full "
                                   "matrix as raw float32 (connectivity.bin; for a glyphset that stores only the upper "
                                   "triangle the diagonal is set to 1). Overlays and the mask have no brainGL counterpart.")
    p.add_argument("glyphset", help="folder that contains glyphset.json")
    p.add_argument("--out", required=True, help="output folder (created if needed)")
    p.add_argument("--min-threshold", type=float, default=0.5,
                   help="load-time minimum threshold written to data.glyphset (default: 0.5)")
    p.set_defaults(func=cmd_to_braingl)

    a = ap.parse_args(argv)
    try:
        a.func(a)
    except OSError as e:   # a file that is missing or cannot be read: a message instead of a traceback
        raise SystemExit(f"error: {e}") from None


if __name__ == "__main__":
    sys.exit(main())
