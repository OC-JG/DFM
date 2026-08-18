/*
 * Generates the binary STL fixtures the smoke test drives the app with.
 * Run: node test/make-fixtures.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/* One axis-aligned box as 12 triangles. `invert` flips the winding, which is
   how the shelled part gets an inward-facing cavity. */
function boxTriangles([x0, y0, z0], [x1, y1, z1], invert = false) {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], // bottom (-Z)
    [4, 5, 6], [4, 6, 7], // top (+Z)
    [0, 1, 5], [0, 5, 4], // -Y
    [2, 3, 7], [2, 7, 6], // +Y
    [1, 2, 6], [1, 6, 5], // +X
    [0, 4, 7], [0, 7, 3], // -X
  ];
  return faces.map((f) => {
    const tri = [v[f[0]], v[f[1]], v[f[2]]];
    return invert ? [tri[0], tri[2], tri[1]] : tri;
  });
}

function writeBinarySTL(path, triangles) {
  const buf = Buffer.alloc(84 + triangles.length * 50);
  buf.write('OnlyCat DFM test fixture'.padEnd(80, ' '), 0, 80, 'ascii');
  buf.writeUInt32LE(triangles.length, 80);

  let off = 84;
  for (const [a, b, c] of triangles) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(...n) || 1;
    for (const k of [0, 1, 2]) { buf.writeFloatLE(n[k] / len, off); off += 4; }
    for (const p of [a, b, c]) {
      for (const k of [0, 1, 2]) { buf.writeFloatLE(p[k], off); off += 4; }
    }
    buf.writeUInt16LE(0, off); off += 2;
  }
  writeFileSync(path, buf);
  return triangles.length;
}

mkdirSync(OUT_DIR, { recursive: true });

/* Shelled box: 40 × 30 × 20 outer, 2 mm walls. A solid box would give the
   thickness rays nothing interesting to measure. */
const part = [
  ...boxTriangles([0, 0, 0], [40, 30, 20]),
  ...boxTriangles([2, 2, 2], [38, 28, 18], true),
];

/* Overmould: a 2 mm slab sitting on the part's top face, so interface rays
   from its underside land on the substrate. */
const overmould = boxTriangles([0, 0, 20], [40, 30, 22]);

/* The same shelled box, authored in inches. STL carries no units, so this is
   byte-for-byte a legitimate file — it just describes a 1.57 mm part unless
   somebody notices. The mesh health panel is what notices. */
const inchPart = part.map((triangle) => triangle.map((v) => v.map((c) => c / 25.4)));

/* A shelled box with its lid left off: four boundary edges, so ray casts
   escape and the enclosed volume is undefined. */
const openPart = [
  ...boxTriangles([0, 0, 0], [40, 30, 20]).filter((_, i) => i !== 2 && i !== 3),
  ...boxTriangles([2, 2, 2], [38, 28, 18], true),
];

console.log('part.stl        ', writeBinarySTL(join(OUT_DIR, 'part.stl'), part), 'triangles');
console.log('overmould.stl   ', writeBinarySTL(join(OUT_DIR, 'overmould.stl'), overmould), 'triangles');
console.log('part-inches.stl ', writeBinarySTL(join(OUT_DIR, 'part-inches.stl'), inchPart), 'triangles');
console.log('part-open.stl   ', writeBinarySTL(join(OUT_DIR, 'part-open.stl'), openPart), 'triangles');
