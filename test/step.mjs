/*
 * Tests for the STEP path.
 *
 * This path had no fixture at all, which mattered more than it sounds: .ipt
 * is the tool's headline input and it arrives as STEP — main.js routes an
 * Inventor part through parseSTEP, the same function a dropped .step uses —
 * so the path a user is most likely to take was the one a regression was
 * most likely to survive on.
 *
 * Fixtures are authored, not exported: lib/solids.mjs defines each solid
 * analytically and lib/step-write.mjs emits a real AP214 file from it. A
 * file exported by OpenCascade and read back by OpenCascade could agree with
 * itself and still be wrong; a 3° taper written from tan(3°) cannot.
 *
 * Separate from unit.mjs because this one needs a dependency — the
 * OpenCascade WASM reader — and unit.mjs is deliberately runnable with no
 * install at all. Run: node test/step.mjs
 */

import { createRequire } from 'node:module';
import { parseSTEP } from '../src/geometry/step.js';
import { writeStepSolids } from './lib/step-write.mjs';
import { stepBox, stepTaperedBox, stepCup, stepTwoBodies } from './lib/solids.mjs';
import { analyseMesh } from '../src/analysis/mesh.js';
import { weldGeometry } from '../src/geometry/weld.js';
import { MATERIALS } from '../src/core/materials.js';

const require = createRequire(import.meta.url);

let passed = 0;
const failures = [];
let group = '';

function describe(name) { group = name; console.log(`\n${name}`); }
function it(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(`${group} › ${name}: ${err.message}`);
    console.log(`  FAIL  ${name}\n          ${err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg = '') {
  if (actual !== expected) throw new Error(`${msg} expected ${expected}, got ${actual}`);
}
function close(actual, expected, tol, msg = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg} expected ${expected} ±${tol}, got ${actual}`);
  }
}

const occt = await (require('occt-import-js'))();
const load = (solids, name) => parseSTEP(new TextEncoder().encode(writeStepSolids(solids, name)).buffer, null, occt);
const analyse = (geom, opts = {}) =>
  analyseMesh(geom, { material: MATERIALS.abs, minDraft: 0.5, pullAxis: '+z', ...opts });

/* Triangulate the same face loops into unindexed soup, so one definition can
   be measured as a B-rep and as a mesh and the two answers compared. Every
   fixture face is a convex polygon, so a fan from the first vertex is exact. */
function toSoup(solid) {
  const out = [];
  for (const loop of solid.faces) {
    for (let k = 1; k < loop.length - 1; k++) {
      out.push(...solid.vertices[loop[0]], ...solid.vertices[loop[k]], ...solid.vertices[loop[k + 1]]);
    }
  }
  const positions = new Float32Array(out);
  return weldGeometry(positions, positions.length / 9);
}

const bboxOf = (geom) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < geom.vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], geom.vertices[i + k]);
      mx[k] = Math.max(mx[k], geom.vertices[i + k]);
    }
  }
  return { min: mn, max: mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
};

/* The unit normal of one triangle of the merged mesh. */
function triNormal(geom, t) {
  const { vertices: v, indices: ix } = geom;
  const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
  const e1 = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
  const e2 = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const m = Math.hypot(...n);
  return m === 0 ? null : n.map((x) => x / m);
}

// ═══════════════════════════════════════════════════════════════════════════

describe('step — the face groups the STL path cannot carry');
{
  const box = stepBox();
  const geom = await load([box], 'box');

  it('a box reads back as six B-rep faces', () => {
    assert(geom.faceGroups, 'faceGroups is null — the B-rep faces were lost');
    eq(geom.faceGroups.length, box.expect.faceCount, 'face count:');
  });

  it('the face ranges partition every triangle exactly once', () => {
    /* This is the assertion an off-by-one in the index remapping has to get
       past. A range that starts one late leaves a triangle unclaimed; one
       that ends one late claims a triangle twice. */
    const owner = new Int32Array(geom.triCount).fill(-1);
    for (const g of geom.faceGroups) {
      assert(g.first >= 0 && g.last < geom.triCount, `range ${g.first}..${g.last} outside 0..${geom.triCount - 1}`);
      for (let t = g.first; t <= g.last; t++) {
        eq(owner[t], -1, `triangle ${t} claimed by two faces —`);
        owner[t] = g.faceId;
      }
    }
    for (let t = 0; t < geom.triCount; t++) assert(owner[t] !== -1, `triangle ${t} belongs to no face`);
  });

  it('every triangle in a face group shares that face plane', () => {
    /* The property the whole milestone rests on: a face group is not just a
       label, it is a set of triangles that genuinely lie in one plane. This
       is what lets draft be measured per face rather than per triangle. */
    for (const g of geom.faceGroups) {
      const ref = triNormal(geom, g.first);
      assert(ref, `face ${g.faceId} starts on a degenerate triangle`);
      for (let t = g.first + 1; t <= g.last; t++) {
        const n = triNormal(geom, t);
        const dot = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
        close(dot, 1, 1e-6, `face ${g.faceId} triangle ${t} is not coplanar with its face:`);
      }
    }
  });

  it('every index is inside the merged vertex buffer', () => {
    const n = geom.vertCount;
    for (let i = 0; i < geom.indices.length; i++) {
      assert(geom.indices[i] >= 0 && geom.indices[i] < n, `index ${geom.indices[i]} outside 0..${n - 1}`);
    }
    eq(geom.vertices.length, n * 3, 'vertex buffer length:');
  });

  it('a box measures its authored size', () => {
    const b = bboxOf(geom);
    for (let k = 0; k < 3; k++) close(b.size[k], box.expect.bbox[k], 1e-4, `axis ${k}:`);
  });

  it('a box measures its authored volume', () => {
    close(analyse(geom).volume, box.expect.volume, box.expect.volume * 1e-4, 'volume:');
  });

  it('a box has no draft at all on its four side faces', () => {
    /* Vertical walls: the outward normal is horizontal, so the angle from
       the pull axis is exactly 90° and the draft exactly 0°. */
    const sides = geom.faceGroups.filter((g) => Math.abs(triNormal(geom, g.first)[2]) < 1e-6);
    eq(sides.length, 4, 'side face count:');
    for (const g of sides) {
      const draft = 90 - (Math.acos(Math.abs(triNormal(geom, g.first)[2])) * 180) / Math.PI;
      close(draft, box.expect.sideDraftDeg, 1e-6, `face ${g.faceId} draft:`);
    }
  });
}

describe('step — draft, per face and exact');
{
  const taper = stepTaperedBox([40, 30], 20, 3);
  const geom = await load([taper], 'tapered');

  it('a 3° tapered box reads back as six faces', () => {
    eq(geom.faceGroups.length, taper.expect.faceCount, 'face count:');
  });

  it('each side face reports 3.000°, not a distribution', () => {
    /* The reading a per-face measurement is supposed to give: one number per
       face, exact. Measured off the tessellation, so it also proves the
       tessellation did not round the taper away. */
    const sides = geom.faceGroups
      .map((g) => ({ g, n: triNormal(geom, g.first) }))
      .filter(({ n }) => Math.abs(n[2]) > 1e-6 && Math.abs(n[2]) < 1 - 1e-6);
    eq(sides.length, 4, 'tapered side count:');
    for (const { g, n } of sides) {
      const draft = 90 - (Math.acos(Math.min(1, Math.abs(n[2]))) * 180) / Math.PI;
      close(draft, taper.expect.draftDeg, 1e-3, `face ${g.faceId} draft:`);
    }
  });

  it('the taper narrows the top by twice the run', () => {
    const b = bboxOf(geom);
    close(b.size[2], taper.expect.height, 1e-4, 'height:');
    /* The top face is the one whose normal is +z; its own extent is the
       narrowed size. */
    const top = geom.faceGroups.find((g) => triNormal(geom, g.first)[2] > 1 - 1e-6);
    assert(top, 'no +z face found');
    const xs = [], ys = [];
    for (let t = top.first; t <= top.last; t++) {
      for (let k = 0; k < 3; k++) {
        xs.push(geom.vertices[geom.indices[t * 3 + k] * 3]);
        ys.push(geom.vertices[geom.indices[t * 3 + k] * 3 + 1]);
      }
    }
    close(Math.max(...xs) - Math.min(...xs), taper.expect.topSize[0], 1e-3, 'top x:');
    close(Math.max(...ys) - Math.min(...ys), taper.expect.topSize[1], 1e-3, 'top y:');
  });
}

describe('step — wall thickness through the B-rep path');
{
  const cup = stepCup([40, 30, 20], 2);
  const geom = await load([cup], 'cup');

  it('a shelled box reads back as fourteen faces', () => {
    eq(geom.faceGroups.length, cup.expect.faceCount, 'face count:');
  });

  it('the 2 mm wall measures 2 mm', () => {
    const a = analyse(geom);
    close(a.wallStats.median, cup.expect.wall, 0.05, 'median wall:');
    /* Judged on the sphere figure, as the checks are: it must not read the
       cavity's diagonal as the wall. */
    close(a.wallMethod.sphereMedian, cup.expect.wall, 0.05, 'sphere median:');
  });

  it('the shelled volume matches the analytic one', () => {
    close(analyse(geom).volume, cup.expect.volume, cup.expect.volume * 1e-3, 'volume:');
  });

  it('STEP and STL of the same solid agree', () => {
    /* Same face loops, one read as a B-rep and one triangulated into soup.
       The measurements must not depend on which door the geometry came in
       through — and if they ever do, this is the test that says so. */
    const viaStl = analyse(toSoup(cup));
    const viaStep = analyse(geom);
    close(viaStep.volume, viaStl.volume, viaStl.volume * 1e-3, 'volume:');
    close(viaStep.wallStats.median, viaStl.wallStats.median, 0.05, 'median wall:');
    close(viaStep.wallMethod.sphereMedian, viaStl.wallMethod.sphereMedian, 0.05, 'sphere median:');
    close(viaStep.area, viaStl.area, viaStl.area * 1e-3, 'surface area:');
  });
}

describe('step — bodies');
{
  const two = stepTwoBodies();
  const geom = await load(two.solids, 'twobody');
  const single = await load([stepBox()], 'single');

  it('two solids come back as two bodies', () => {
    assert(geom.bodies, 'bodies is null for a two-solid file');
    eq(geom.bodies.length, two.expect.bodyCount, 'body count:');
  });

  it('one solid leaves the body selector unbuilt', () => {
    /* step.js only populates `bodies` above one, on the grounds that a
       selector for a single body earns nothing. */
    eq(single.bodies, null, 'single-body bodies:');
  });

  it('the body ranges partition every triangle exactly once', () => {
    const owner = new Int32Array(geom.triCount).fill(-1);
    for (const b of geom.bodies) {
      assert(b.triEnd > b.triStart, `body ${b.id} has an empty range`);
      for (let t = b.triStart; t < b.triEnd; t++) {
        eq(owner[t], -1, `triangle ${t} claimed by two bodies —`);
        owner[t] = b.id;
      }
    }
    for (let t = 0; t < geom.triCount; t++) assert(owner[t] !== -1, `triangle ${t} belongs to no body`);
  });

  it("each body's triangles sit inside that body, not the other one", () => {
    /* The assertion that actually catches a wrong vertex offset in the
       merge: with the offset off by anything at all, a triangle indexes into
       the neighbouring solid's vertices and lands 20 mm away. The two boxes
       are deliberately separated along x so that failure is unambiguous. */
    const spans = geom.bodies.map((b) => {
      let lo = Infinity, hi = -Infinity;
      for (let t = b.triStart; t < b.triEnd; t++) {
        for (let k = 0; k < 3; k++) {
          const x = geom.vertices[geom.indices[t * 3 + k] * 3];
          lo = Math.min(lo, x); hi = Math.max(hi, x);
        }
      }
      return { lo, hi };
    }).sort((p, q) => p.lo - q.lo);
    close(spans[0].lo, 0, 1e-4, 'left body min x:');
    close(spans[0].hi, 10, 1e-4, 'left body max x:');
    close(spans[1].lo, 20, 1e-4, 'right body min x:');
    close(spans[1].hi, 30, 1e-4, 'right body max x:');
  });

  it('a body with no name of its own still gets one', () => {
    for (const b of geom.bodies) assert(b.name && b.name.trim(), `body ${b.id} has no name`);
  });

  it('both bodies together span the whole part', () => {
    const b = bboxOf(geom);
    for (let k = 0; k < 3; k++) close(b.size[k], two.expect.bbox[k], 1e-4, `axis ${k}:`);
  });
}

describe('step — normals');
{
  const geom = await load([stepBox()], 'normals');

  it('every vertex normal is a unit vector', () => {
    for (let i = 0; i < geom.normals.length; i += 3) {
      const m = Math.hypot(geom.normals[i], geom.normals[i + 1], geom.normals[i + 2]);
      close(m, 1, 1e-4, `normal at vertex ${i / 3}:`);
    }
  });

  it('normals point out of the solid', () => {
    /* A box centred on its own bbox: the outward direction at any vertex is
       away from the centre, so an inside-out shell shows up as a negative
       dot product on every face. */
    const b = bboxOf(geom);
    const c = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
    for (let i = 0; i < geom.vertices.length; i += 3) {
      const r = [0, 1, 2].map((k) => geom.vertices[i + k] - c[k]);
      const dot = r[0] * geom.normals[i] + r[1] * geom.normals[i + 1] + r[2] * geom.normals[i + 2];
      assert(dot > 0, `vertex ${i / 3} normal points inward (dot ${dot.toFixed(3)})`);
    }
  });
}

describe('step — malformed input');
{
  it('a file that is not STEP at all is refused', async () => {
    let threw = null;
    try {
      await parseSTEP(new TextEncoder().encode('this is not a STEP file').buffer, null, occt);
    } catch (err) { threw = err; }
    assert(threw, 'a non-STEP file was accepted');
    assert(/STEP import failed|no solid geometry/.test(threw.message), `unexpected message: ${threw.message}`);
  });
}

// ── report ─────────────────────────────────────────────────────────────────

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} of ${passed + failures.length} assertions FAILED\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`  ${passed} STEP assertions passed\n`);
