/**
 * FreeSurfer ASCII surface (`mris_convert lh.pial lh.pial.asc`, AFNI
 * `gifti_tool -write_asc`).
 *
 *   #!ascii version of lh.pial            <- optional comment line
 *   nVerts nTris
 *   x y z flag                            <- nVerts lines (flag optional)
 *   a b c flag                            <- nTris lines  (flag optional)
 *
 * Port of brainGL's `LoaderFreesurfer::loadASC`, made tolerant of a missing
 * comment line, CRLF line ends, tabs / repeated blanks, blank lines and a
 * missing trailing flag.  The triangle winding is returned exactly as stored
 * in the file (brainGL's loaders swap it to (a, c, b) when building the mesh;
 * that is the caller's business).
 */

export interface TriMesh {
  /** xyz per vertex, length 3 * nVerts */
  positions: Float32Array;
  /** vertex indices, length 3 * nTris */
  triangles: Uint32Array;
}

const LF = 10;
const CR = 13;
const HASH = 35;

function isEol(c: number): boolean {
  return c === LF || c === CR;
}

/** blank, tab, vertical tab, form feed, NBSP-free ASCII blanks (not line ends) */
function isBlank(c: number): boolean {
  return c === 32 || c === 9 || c === 11 || c === 12;
}

export function parseFreeSurferAsc(text: string): TriMesh {
  const len = text.length;
  let pos = 0;
  let line = 1;

  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1; // BOM

  /** Advance past the rest of the current line, including its terminator. */
  const skipLine = (): void => {
    while (pos < len && !isEol(text.charCodeAt(pos))) pos++;
    if (pos < len) {
      if (text.charCodeAt(pos) === CR && pos + 1 < len && text.charCodeAt(pos + 1) === LF) pos++;
      pos++;
      line++;
    }
  };

  /** Skip blank lines and `#` comment lines; leaves pos on the first token of a data line. */
  const skipToData = (): boolean => {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (isBlank(c)) {
        pos++;
      } else if (isEol(c)) {
        skipLine();
      } else if (c === HASH) {
        skipLine();
      } else {
        return true;
      }
    }
    return false;
  };

  /**
   * Read the next number on the current line.  Returns NaN when the line has no
   * further token; throws when a token is present but is not a number.
   */
  const nextNumber = (what: string): number => {
    while (pos < len && isBlank(text.charCodeAt(pos))) pos++;
    const start = pos;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (isBlank(c) || isEol(c)) break;
      pos++;
    }
    if (pos === start) return NaN;
    const v = +text.substring(start, pos);
    if (v !== v) {
      throw new Error(
        `FreeSurfer ASC: line ${line}: expected a number for ${what}, got "${text.substring(start, Math.min(pos, start + 40))}"`,
      );
    }
    return v;
  };

  // ---- header -------------------------------------------------------------
  if (!skipToData()) throw new Error("FreeSurfer ASC: file is empty (no 'nVerts nTris' header line)");

  let nVerts = NaN;
  let nTris = NaN;
  // The original unconditionally discards the first line.  Writers do not
  // always start it with '#', so allow exactly one non-numeric line here.
  for (let attempt = 0; attempt < 2; attempt++) {
    const save = pos;
    let ok = true;
    try {
      nVerts = nextNumber("the vertex count");
      nTris = nextNumber("the triangle count");
    } catch {
      ok = false;
    }
    if (ok && Number.isInteger(nVerts) && Number.isInteger(nTris) && nVerts >= 0 && nTris >= 0) {
      skipLine();
      break;
    }
    const headerLine = line;
    pos = save;
    const shown = text.substring(save, Math.min(len, save + 60)).split(/\r|\n/)[0];
    nVerts = NaN;
    if (attempt === 1) {
      throw new Error(
        `FreeSurfer ASC: line ${headerLine}: expected header 'nVerts nTris' (two non-negative integers), got "${shown}"`,
      );
    }
    skipLine();
    if (!skipToData()) {
      throw new Error(
        `FreeSurfer ASC: no 'nVerts nTris' header line found (line ${headerLine} is "${shown}")`,
      );
    }
  }

  // Cheap sanity check before allocating: every entry needs at least 6 chars
  // ("0 0 0\n"), so a count far beyond the text length is a corrupt header.
  if ((nVerts + nTris) * 5 > len - pos + 1) {
    throw new Error(
      `FreeSurfer ASC: header announces ${nVerts} vertices and ${nTris} triangles but the file is too short to hold them`,
    );
  }

  // ---- vertices -----------------------------------------------------------
  const positions = new Float32Array(nVerts * 3);
  for (let i = 0; i < nVerts; i++) {
    if (!skipToData()) {
      throw new Error(`FreeSurfer ASC: unexpected end of file: expected ${nVerts} vertices, found ${i}`);
    }
    const x = nextNumber("a vertex coordinate");
    const y = nextNumber("a vertex coordinate");
    const z = nextNumber("a vertex coordinate");
    if (z !== z) {
      throw new Error(`FreeSurfer ASC: line ${line}: vertex ${i} needs three coordinates 'x y z [flag]'`);
    }
    const o = i * 3;
    positions[o] = x;
    positions[o + 1] = y;
    positions[o + 2] = z;
    skipLine(); // optional flag and anything after it
  }

  // ---- triangles ----------------------------------------------------------
  const triangles = new Uint32Array(nTris * 3);
  for (let i = 0; i < nTris; i++) {
    if (!skipToData()) {
      throw new Error(`FreeSurfer ASC: unexpected end of file: expected ${nTris} triangles, found ${i}`);
    }
    const a = nextNumber("a triangle index");
    const b = nextNumber("a triangle index");
    const c = nextNumber("a triangle index");
    if (c !== c) {
      throw new Error(`FreeSurfer ASC: line ${line}: triangle ${i} needs three vertex indices 'a b c [flag]'`);
    }
    // One combined test covers negatives, fractions and out-of-range indices.
    if (
      !(a >= 0 && a < nVerts && b >= 0 && b < nVerts && c >= 0 && c < nVerts) ||
      a !== Math.floor(a) ||
      b !== Math.floor(b) ||
      c !== Math.floor(c)
    ) {
      throw new Error(
        `FreeSurfer ASC: line ${line}: triangle ${i} (${a} ${b} ${c}) has an index that is not an integer in 0..${nVerts - 1}`,
      );
    }
    const o = i * 3;
    triangles[o] = a;
    triangles[o + 1] = b;
    triangles[o + 2] = c;
    skipLine();
  }

  return { positions, triangles };
}
