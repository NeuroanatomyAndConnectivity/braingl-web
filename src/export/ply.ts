/** One exportable piece of a scene. */
export interface Layer {
  name: string;
  /** mesh: triangles; points: bare vertices; segments: vertex pairs (edges) */
  kind: "mesh" | "points" | "segments";
  positions: Float32Array;
  /** rgba per vertex */
  colors: Uint8Array;
  triangles?: Uint32Array;
  edges?: Uint32Array;
  /** radius in mm of the spheres / tubes that the Blender importer builds for points / segments */
  radius?: number;
  /** "lit": shaded anatomy; "flat": data colours that should not be altered by lighting */
  shading: "lit" | "flat";
  smooth?: boolean;
  /** 1 = opaque */
  opacity?: number;
  truncated?: boolean;
}

/**
 * Binary little-endian PLY with per-vertex colour and optional faces / edges.
 * Readable by Blender's own importer, MeshLab, ParaView etc.; the bundled
 * Blender script reads exactly this layout.
 */
export function writePly(layer: Layer): ArrayBuffer {
  const nv = layer.positions.length / 3;
  const nf = layer.triangles ? layer.triangles.length / 3 : 0;
  const ne = layer.edges ? layer.edges.length / 2 : 0;
  let header = `ply\nformat binary_little_endian 1.0\ncomment brainGL-web ${layer.kind} layer: ${layer.name.replace(/\s+/g, " ")}\n` +
    `element vertex ${nv}\nproperty float x\nproperty float y\nproperty float z\n` +
    `property uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\n`;
  if (nf) header += `element face ${nf}\nproperty list uchar int vertex_indices\n`;
  if (ne) header += `element edge ${ne}\nproperty int vertex1\nproperty int vertex2\n`;
  header += "end_header\n";
  const head = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(head.length + nv * 16 + nf * 13 + ne * 8);
  new Uint8Array(buf).set(head);
  const dv = new DataView(buf);
  let o = head.length;
  for (let i = 0; i < nv; i++) {
    dv.setFloat32(o, layer.positions[3 * i], true);
    dv.setFloat32(o + 4, layer.positions[3 * i + 1], true);
    dv.setFloat32(o + 8, layer.positions[3 * i + 2], true);
    dv.setUint8(o + 12, layer.colors[4 * i]);
    dv.setUint8(o + 13, layer.colors[4 * i + 1]);
    dv.setUint8(o + 14, layer.colors[4 * i + 2]);
    dv.setUint8(o + 15, layer.colors[4 * i + 3]);
    o += 16;
  }
  for (let t = 0; t < nf; t++) {
    dv.setUint8(o, 3);
    dv.setInt32(o + 1, layer.triangles![3 * t], true);
    dv.setInt32(o + 5, layer.triangles![3 * t + 1], true);
    dv.setInt32(o + 9, layer.triangles![3 * t + 2], true);
    o += 13;
  }
  for (let e = 0; e < ne; e++) {
    dv.setInt32(o, layer.edges![2 * e], true);
    dv.setInt32(o + 4, layer.edges![2 * e + 1], true);
    o += 8;
  }
  return buf;
}

// ------------------------------------------------------------------- zip

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP archive (stored, no compression) so a whole scene downloads as one file. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const names = files.map((f) => enc.encode(f.name));
  let size = 22;
  files.forEach((f, i) => { size += 30 + names[i].length + f.data.length + 46 + names[i].length; });
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  const offsets: number[] = [];
  const crcs: number[] = [];
  let o = 0;
  files.forEach((f, i) => {
    offsets.push(o);
    const crc = crc32(f.data);
    crcs.push(crc);
    dv.setUint32(o, 0x04034b50, true); dv.setUint16(o + 4, 20, true); dv.setUint16(o + 6, 0x0800, true); dv.setUint16(o + 8, 0, true);
    dv.setUint16(o + 10, 0, true); dv.setUint16(o + 12, 0x21, true);
    dv.setUint32(o + 14, crc, true); dv.setUint32(o + 18, f.data.length, true); dv.setUint32(o + 22, f.data.length, true);
    dv.setUint16(o + 26, names[i].length, true); dv.setUint16(o + 28, 0, true);
    out.set(names[i], o + 30);
    out.set(f.data, o + 30 + names[i].length);
    o += 30 + names[i].length + f.data.length;
  });
  const cdStart = o;
  files.forEach((f, i) => {
    dv.setUint32(o, 0x02014b50, true); dv.setUint16(o + 4, 20, true); dv.setUint16(o + 6, 20, true); dv.setUint16(o + 8, 0x0800, true);
    dv.setUint16(o + 10, 0, true); dv.setUint16(o + 12, 0, true); dv.setUint16(o + 14, 0x21, true);
    dv.setUint32(o + 16, crcs[i], true); dv.setUint32(o + 20, f.data.length, true); dv.setUint32(o + 24, f.data.length, true);
    dv.setUint16(o + 28, names[i].length, true);
    dv.setUint32(o + 42, offsets[i], true);
    out.set(names[i], o + 46);
    o += 46 + names[i].length;
  });
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 8, files.length, true); dv.setUint16(o + 10, files.length, true);
  dv.setUint32(o + 12, o - cdStart, true); dv.setUint32(o + 16, cdStart, true);
  return out;
}
