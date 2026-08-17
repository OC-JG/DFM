import { weldGeometry } from './weld.js';

/*
 * STL parsing — binary and ASCII, returning welded indexed geometry.
 *
 * Format sniffing: an ASCII STL starts with "solid", but so do plenty of
 * binary files written by careless exporters. The reliable test is whether
 * the declared triangle count matches the file length exactly, so we check
 * that before trusting the header text.
 */
export function parseSTL(buffer, onProgress) {
  const raw = isAsciiSTL(buffer) ? parseAsciiSTL(buffer) : parseBinarySTL(buffer);
  if (!raw.triCount) throw new Error('No triangles found — file may be empty or not an STL');
  if (onProgress) onProgress(0.5, 'Welding vertices');
  return weldGeometry(raw.positions, raw.triCount);
}

export function isAsciiSTL(buffer) {
  if (buffer.byteLength < 84) return true;
  const header = new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength));
  let text = '';
  try {
    text = new TextDecoder().decode(header).trim().toLowerCase();
  } catch {
    return false;
  }
  if (!text.startsWith('solid')) return false;
  const declared = new DataView(buffer).getUint32(80, true);
  return 84 + declared * 50 !== buffer.byteLength;
}

export function parseBinarySTL(buffer) {
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  /* Guard against a corrupt count sending us off the end of the buffer. */
  const maxTris = Math.floor((buffer.byteLength - 84) / 50);
  if (triCount > maxTris) throw new Error(`STL header claims ${triCount} triangles but the file only holds ${maxTris}`);

  const positions = new Float32Array(triCount * 9);
  let off = 84;
  for (let i = 0; i < triCount; i++) {
    off += 12; // skip the stored face normal; we recompute from winding
    for (let j = 0; j < 9; j++) {
      positions[i * 9 + j] = view.getFloat32(off, true);
      off += 4;
    }
    off += 2; // attribute byte count
  }
  return { positions, triCount };
}

export function parseAsciiSTL(buffer) {
  const text = new TextDecoder().decode(buffer);
  const positions = [];
  const vre = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  while ((m = vre.exec(text)) !== null) positions.push(+m[1], +m[2], +m[3]);
  return { positions: new Float32Array(positions), triCount: Math.floor(positions.length / 9) };
}
