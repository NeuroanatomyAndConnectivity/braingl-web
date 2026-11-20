/**
 * FreeSurfer binary files: triangle surfaces (lh.pial, lh.white, lh.inflated,
 * ...) and "new" curvature files (lh.curv, lh.sulc, lh.thickness, ...).
 * Everything is big-endian.
 */

import type { TriMesh } from "./freesurferAsc";

const LF = 10;

function magic3(buf: ArrayBuffer): number {
  if (buf.byteLength < 3) return -1;
  const b = new Uint8Array(buf, 0, 3);
  return (b[0] << 16) | (b[1] << 8) | b[2];
}

const TRIANGLE_MAGIC = 0xfffffe;
const NEW_CURV_MAGIC = 0xffffff; // also the (unsupported) quad surface magic
const NEW_QUAD_MAGIC = 0xfffffd;

/** True when the buffer starts with the triangle-surface magic FF FF FE. */
export function isFreeSurferSurface(buf: ArrayBuffer): boolean {
  return magic3(buf) === TRIANGLE_MAGIC;
}

/** Bytes of a new-curv file that isFreeSurferCurv() needs: magic, vertex count, face count, values per vertex. */
export const CURV_HEADER_BYTES = 15;

/**
 * True when the buffer starts with the new-curv magic FF FF FF and its header
 * is consistent with the file size (old quad surfaces share the magic number).
 * `buf` may be just the first CURV_HEADER_BYTES bytes of a file when the size
 * of the whole file is given as `fileSize`.
 */
export function isFreeSurferCurv(buf: ArrayBuffer, fileSize: number = buf.byteLength): boolean {
  if (magic3(buf) !== NEW_CURV_MAGIC || buf.byteLength < CURV_HEADER_BYTES) return false;
  const dv = new DataView(buf);
  const nVerts = dv.getInt32(3, false);
  const nFaces = dv.getInt32(7, false);
  const valsPerVertex = dv.getInt32(11, false);
  if (nVerts < 0 || nFaces < 0 || valsPerVertex < 1) return false;
  return CURV_HEADER_BYTES + nVerts * valsPerVertex * 4 <= Math.max(fileSize, buf.byteLength);
}

/** True when the buffer starts with FF FF FF (new curvature file or old quad surface) or FF FF FD (new quad surface). */
export function hasFreeSurferCurvOrQuadMagic(buf: ArrayBuffer): boolean {
  const m = magic3(buf);
  return m === NEW_CURV_MAGIC || m === NEW_QUAD_MAGIC;
}

/**
 * Parse a FreeSurfer binary triangle surface.
 *
 *   FF FF FE
 *   "created by ... on ...\n"   comment line
 *   "\n"                        (second, normally empty, line)
 *   int32  nVerts, nFaces
 *   float32 x y z               * nVerts
 *   int32   a b c               * nFaces
 *   [optional trailer: volume geometry, command lines]
 */
export function parseFreeSurferSurface(buf: ArrayBuffer): TriMesh {
  const m = magic3(buf);
  if (m !== TRIANGLE_MAGIC) {
    if (m === NEW_CURV_MAGIC || m === NEW_QUAD_MAGIC) {
      throw new Error(
        "FreeSurfer surface: quadrangle / curvature file (magic FF FF " +
          (m === NEW_CURV_MAGIC ? "FF" : "FD") +
          ") is not a triangle surface; convert it with mris_convert",
      );
    }
    throw new Error("FreeSurfer surface: bad magic number (expected FF FF FE triangle surface)");
  }
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  const size = buf.byteLength;

  const lineEnd = (from: number): number => {
    // comment lines are short; refuse to scan megabytes of binary for a '\n'
    const stop = Math.min(size, from + 4096);
    for (let i = from; i < stop; i++) if (bytes[i] === LF) return i + 1;
    return -1;
  };
  /** Header offset is plausible when both counts fit in the file. */
  const fits = (off: number): boolean => {
    if (off < 0 || off + 8 > size) return false;
    const nv = dv.getInt32(off, false);
    const nf = dv.getInt32(off + 4, false);
    return nv >= 0 && nf >= 0 && off + 8 + nv * 12 + nf * 12 <= size;
  };

  const afterFirst = lineEnd(3);
  if (afterFirst < 0) throw new Error("FreeSurfer surface: missing comment line terminator after the magic number");

  // FreeSurfer writes "created by X on DATE\n\n"; like its reader (and
  // nibabel) swallow one empty second line.  If the counts then do not fit
  // the file, accept a non-empty second comment line as well.
  let off = bytes[afterFirst] === LF ? afterFirst + 1 : afterFirst;
  if (!fits(off)) {
    const afterSecond = lineEnd(afterFirst);
    if (afterSecond >= 0 && fits(afterSecond)) {
      off = afterSecond;
    } else if (off + 8 > size) {
      throw new Error("FreeSurfer surface: file is truncated (no vertex / face counts)");
    } else {
      const nv = dv.getInt32(off, false);
      const nf = dv.getInt32(off + 4, false);
      throw new Error(
        `FreeSurfer surface: header announces ${nv} vertices and ${nf} faces, which does not fit in a ${size}-byte file (truncated or corrupt)`,
      );
    }
  }

  const nVerts = dv.getInt32(off, false);
  const nFaces = dv.getInt32(off + 4, false);
  off += 8;

  const positions = new Float32Array(nVerts * 3);
  for (let i = 0, n = nVerts * 3; i < n; i++, off += 4) positions[i] = dv.getFloat32(off, false);

  const triangles = new Uint32Array(nFaces * 3);
  for (let i = 0, n = nFaces * 3; i < n; i++, off += 4) {
    const v = dv.getInt32(off, false);
    if (v < 0 || v >= nVerts) {
      throw new Error(
        `FreeSurfer surface: face ${Math.floor(i / 3)} references vertex ${v}, outside 0..${nVerts - 1}`,
      );
    }
    triangles[i] = v;
  }
  return { positions, triangles };
}

/**
 * Parse a "new" FreeSurfer curvature file (lh.curv, lh.sulc, lh.thickness):
 * FF FF FF, int32 nVerts, int32 nFaces, int32 valsPerVertex, float32 values.
 */
export function parseFreeSurferCurv(buf: ArrayBuffer): Float32Array {
  if (magic3(buf) !== NEW_CURV_MAGIC) {
    throw new Error(
      "FreeSurfer curv: bad magic number (expected FF FF FF; old-format curv files are not supported)",
    );
  }
  if (buf.byteLength < 15) throw new Error("FreeSurfer curv: file is truncated (incomplete header)");
  const dv = new DataView(buf);
  const nVerts = dv.getInt32(3, false);
  const valsPerVertex = dv.getInt32(11, false);
  if (nVerts < 0) throw new Error(`FreeSurfer curv: invalid vertex count ${nVerts}`);
  if (valsPerVertex !== 1) {
    throw new Error(`FreeSurfer curv: ${valsPerVertex} values per vertex; only 1 is supported`);
  }
  if (15 + nVerts * 4 > buf.byteLength) {
    throw new Error(
      `FreeSurfer curv: header announces ${nVerts} vertices but the file holds only ${Math.floor((buf.byteLength - 15) / 4)} values`,
    );
  }
  const out = new Float32Array(nVerts);
  for (let i = 0, off = 15; i < nVerts; i++, off += 4) out[i] = dv.getFloat32(off, false);
  return out;
}
