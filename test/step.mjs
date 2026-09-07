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
import {
  stepBox, stepTaperedBox, stepCup, stepTwoBodies,
  stepRod, stepTube, stepHalfTube, stepQuarterRod, stepTiltedRod, stepSharpFillet,
} from './lib/solids.mjs';
import { analyseMesh } from '../src/analysis/mesh.js';
import { FACE_PLANAR_TOL_DEG, classifyCylinder, fitCylinder } from '../src/analysis/faces.js';
import { weldGeometry } from '../src/geometry/weld.js';
import { MATERIALS } from '../src/core/materials.js';
import { runDFM } from '../src/rules/engine.js';
import { buildExportJSON } from '../src/export/json.js';

const require = createRequire(import.meta.url);

let passed = 0;
const failures = [];
let group = '';

function describe(name) { group = name; console.log(`\n${name}`); }
/* Awaited, and every call site awaits it. An earlier version of this did not:
   `fn()` inside a synchronous try/catch means an async body's rejection never
   reaches the catch, so a test that threw reported itself as a pass. Two did.
   The unhandledRejection guard below is the second line of defence. */
async function it(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(`${group} › ${name}: ${err.message}`);
    console.log(`  FAIL  ${name}\n          ${err.message}`);
  }
}

process.on('unhandledRejection', (err) => {
  console.log(`\n  UNHANDLED REJECTION — a test body escaped its harness\n          ${err && err.message}\n`);
  process.exit(1);
});
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

/* A part with nothing else wrong with it, so a draft finding is the only
   thing the check can be reacting to. Mirrors CLEAN_INPUT in unit.mjs; kept
   local rather than exported across suites, since the two are free to drift
   apart as each grows. */
const CLEAN_INPUT = {
  wallThk: 2.0, wallMin: 1.6, wallMax: 2.4, draftAngle: 3.0,
  ribThk: 0.9, ribH: 2.0, ribRadius: 0.5, bossOD: 4.0, bossWall: 1.0,
  hasUndercut: '0', material: 'abs', surfaceFinish: 'spi-a2', moldType: 'two-piece',
  fpc: { enabled: false, thickness: 0.2, cover: 0.5, anchors: 'holes' },
  runChecks: {
    wall: true, draft: true, ribs: true, undercut: true, sink: true,
    warp: true, transitions: false, flow: true, fpc: true,
  },
  mesh: null,
};

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

  await it('a box reads back as six B-rep faces', () => {
    assert(geom.faceGroups, 'faceGroups is null — the B-rep faces were lost');
    eq(geom.faceGroups.length, box.expect.faceCount, 'face count:');
  });

  await it('the face ranges partition every triangle exactly once', () => {
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

  await it('every triangle in a face group shares that face plane', () => {
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

  await it('every index is inside the merged vertex buffer', () => {
    const n = geom.vertCount;
    for (let i = 0; i < geom.indices.length; i++) {
      assert(geom.indices[i] >= 0 && geom.indices[i] < n, `index ${geom.indices[i]} outside 0..${n - 1}`);
    }
    eq(geom.vertices.length, n * 3, 'vertex buffer length:');
  });

  await it('a box measures its authored size', () => {
    const b = bboxOf(geom);
    for (let k = 0; k < 3; k++) close(b.size[k], box.expect.bbox[k], 1e-4, `axis ${k}:`);
  });

  await it('a box measures its authored volume', () => {
    close(analyse(geom).volume, box.expect.volume, box.expect.volume * 1e-4, 'volume:');
  });

  await it('a box has no draft at all on its four side faces', () => {
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

  await it('a 3° tapered box reads back as six faces', () => {
    eq(geom.faceGroups.length, taper.expect.faceCount, 'face count:');
  });

  await it('each side face reports 3.000°, not a distribution', () => {
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

  await it('the taper narrows the top by twice the run', () => {
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

describe('step — draft per face, which is what a face group is for');
{
  const taper = stepTaperedBox([40, 30], 20, 3);
  const box = stepBox();

  await it('a 3° taper reports one exact angle per face, not a distribution', async () => {
    /* The whole point of R2.2. An STL can only ever say what fraction of the
       side-wall area is short; a B-rep can name the face and the angle. */
    const a = analyse(await load([taper], 'taper-faces'));
    assert(a.faces, 'no per-face measurement on a B-rep source');
    const sides = a.faces.filter((f) => f.kind === 'side');
    eq(sides.length, 4, 'side face count:');
    for (const f of sides) {
      assert(f.planar, `face ${f.faceId} was not recognised as planar (dev ${f.planarDevDeg}°)`);
      close(Math.abs(f.draftDeg), 3, 1e-3, `face ${f.faceId} draft:`);
    }
  });

  await it('a planar face measures far inside the planarity tolerance', async () => {
    /* Not exactly zero: positions arrive in a Float32Array, so a 3° taper's
       normals carry about a hundredth of a degree of rounding. What matters
       is that it is an order of magnitude inside the threshold the code
       classifies on, so the test is tied to that constant rather than to a
       number chosen to make it pass. */
    const a = analyse(await load([taper], 'taper-planar'));
    for (const f of a.faces) {
      assert(f.planarDevDeg < FACE_PLANAR_TOL_DEG / 10,
        `face ${f.faceId} deviation ${f.planarDevDeg.toFixed(4)}° is not comfortably inside ${FACE_PLANAR_TOL_DEG}°`);
    }
  });

  await it('every side face of a 3° taper clears a 0.5° minimum', async () => {
    const a = analyse(await load([taper], 'taper-pass'));
    eq(a.faceDraft.underMinCount, 0, 'faces under minimum:');
    eq(a.faceDraft.sideFaceCount, 4, 'side faces:');
    close(a.faceDraft.underMinAreaPct, 0, 1e-9, 'area under minimum:');
  });

  await it('a box fails on all four side faces, each at exactly 0°', async () => {
    /* The part the draft check must fail, and now it says which faces and by
       how much rather than only that 100% of the area is short. */
    const a = analyse(await load([box], 'box-faces'));
    eq(a.faceDraft.underMinCount, 4, 'faces under minimum:');
    close(a.faceDraft.underMinAreaPct, 100, 1e-6, 'area under minimum:');
    for (const f of a.faceDraft.worst) close(Math.abs(f.draftDeg), 0, 1e-6, `face ${f.faceId} draft:`);
  });

  await it('the per-face verdict and the area statistic cannot disagree', async () => {
    /* They are the same measurement grouped two ways, and the test says so —
       if per-face draft is ever computed independently, this fails. */
    for (const [name, solid] of [['box', box], ['taper', taper]]) {
      const a = analyse(await load([solid], `${name}-agree`));
      close(a.faceDraft.underMinAreaPct, a.sidePctUnderMin, 1e-6, `${name} under-min area:`);
    }
  });

  await it('the check names the offending faces in its own words', async () => {
    const a = analyse(await load([box], 'box-detail'));
    const dfm = runDFM({ ...CLEAN_INPUT, mesh: a });
    const draft = dfm.checks.find((c) => c.key === 'draft');
    assert(/B-rep names them/.test(draft.detail), `detail did not name faces: ${draft.detail}`);
    assert(/face \d+ 0\.00°/.test(draft.detail), `detail did not carry an exact angle: ${draft.detail}`);
    assert(draft.metrics.some((r) => r && r[0] === 'Measured from' && /B-rep/.test(r[1])),
      'the check does not say where the measurement came from');
  });

  await it('an STL of the same solid says so, and falls back to the statistic', async () => {
    /* The same part through the other door. It must not pretend to a
       per-face reading it cannot have, and it must still find the fault. */
    const a = analyse(toSoup(box));
    eq(a.faces, null, 'faces on a mesh source:');
    eq(a.faceDraft, null, 'faceDraft on a mesh source:');
    eq(a.measuredFrom, 'mesh', 'provenance:');
    close(a.sidePctUnderMin, 100, 1e-6, 'area under minimum:');
    const dfm = runDFM({ ...CLEAN_INPUT, mesh: a });
    const draft = dfm.checks.find((c) => c.key === 'draft');
    assert(!/B-rep names them/.test(draft.detail), 'a mesh source claimed a B-rep reading');
    assert(draft.metrics.some((r) => r && r[0] === 'Measured from' && /mesh/.test(r[1])),
      'the mesh path does not say where the measurement came from');
  });
}

describe('step — radius, which has to be fitted because nothing reports it');
{
  const cylsOf = (a) => a.faces.filter((f) => f.surface.type === 'cylinder');

  await it('a rod fits its authored radius, and knows it is convex', async () => {
    const { solid, expect } = stepRod(8, 20);
    const a = analyse(await load([solid], 'rod'));
    eq(a.faces.length, expect.faceCount, 'face count:');
    const c = cylsOf(a);
    eq(c.length, 1, 'cylindrical faces:');
    close(c[0].surface.radius, expect.radius, 1e-3, 'fitted radius:');
    eq(c[0].surface.kind, expect.kind, 'classification:');
    close(c[0].surface.extentDeg, 360, 1e-6, 'angular extent:');
    close(a.volume, expect.volume, expect.volume * 3e-3, 'volume:');
  });

  await it('a bore is the same surface inside out, and is not called a boss', async () => {
    /* Convexity is the whole difference between a pin and a hole, and it is
       decided by which way the outward normal leans, not by the radius. */
    const { solid, expect } = stepTube(10, 6, 20);
    const a = analyse(await load([solid], 'tube'));
    const c = cylsOf(a);
    eq(c.length, 2, 'cylindrical faces:');
    const bore = c.find((f) => f.surface.kind === 'bore');
    const boss = c.find((f) => f.surface.kind === 'boss');
    assert(bore && boss, `expected one bore and one boss, got ${c.map((f) => f.surface.kind).join(', ')}`);
    close(bore.surface.radius, expect.rInner, 1e-3, 'bore radius:');
    close(boss.surface.radius, expect.rOuter, 1e-3, 'outer radius:');
    close(a.volume, expect.volume, expect.volume * 3e-3, 'volume:');
  });

  await it('a partial sweep is a corner blend, not a hole', async () => {
    /* Same two surfaces as the tube, swept half way: the extent is what tells
       a fillet from a bore, and both partial branches appear here. */
    const { solid, expect } = stepHalfTube(10, 6, 20);
    const a = analyse(await load([solid], 'halftube'));
    const c = cylsOf(a);
    eq(c.length, 2, 'cylindrical faces:');
    const fillet = c.find((f) => f.surface.kind === 'fillet');
    const round = c.find((f) => f.surface.kind === 'round');
    assert(fillet && round, `expected a fillet and a round, got ${c.map((f) => f.surface.kind).join(', ')}`);
    close(fillet.surface.radius, expect.rInner, 1e-2, 'fillet radius:');
    close(round.surface.radius, expect.rOuter, 1e-2, 'round radius:');
    close(fillet.surface.extentDeg, expect.extentDeg, 2, 'fillet extent:');
    close(a.volume, expect.volume, expect.volume * 5e-3, 'volume:');
  });

  await it('a quarter round measures its radius and its quarter', async () => {
    const { solid, expect } = stepQuarterRod(4, 12);
    const a = analyse(await load([solid], 'quarter'));
    const c = cylsOf(a);
    eq(c.length, 1, 'cylindrical faces:');
    eq(c[0].surface.kind, expect.kind, 'classification:');
    close(c[0].surface.radius, expect.radius, 1e-2, 'radius:');
    close(c[0].surface.extentDeg, expect.extentDeg, 2, 'extent:');
    close(a.volume, expect.volume, expect.volume * 5e-3, 'volume:');
  });

  await it('nothing in the fit depends on the cylinder being axis-aligned', async () => {
    const { solid, expect } = stepTiltedRod(7, 25);
    const a = analyse(await load([solid], 'tilted'));
    const c = cylsOf(a);
    eq(c.length, 1, 'cylindrical faces:');
    close(c[0].surface.radius, expect.radius, 1e-3, 'radius down a diagonal:');
    for (let k = 0; k < 3; k++) {
      close(Math.abs(c[0].surface.axis[k]), expect.axis[k], 1e-3, `axis component ${k}:`);
    }
  });

  await it('a box is all planes, and no plane is mistaken for a cylinder', async () => {
    /* The fit must decline far more often than it succeeds. A plane's normals
       collapse to a line rather than spanning one, which is the test that
       keeps every flat face out of the radius report. */
    const a = analyse(await load([stepBox()], 'box-nocyl'));
    eq(cylsOf(a).length, 0, 'cylinders found on a box:');
    eq(a.features.cylinderCount, 0, 'features.cylinderCount:');
    for (const f of a.faces) eq(f.surface.type, 'plane', `face ${f.faceId} surface:`);
  });

  await it('an almost-flat face is flat, not a five-metre fillet', () => {
    /* The guard that earns its place least obviously, and the one a mutation
       test found unprotected. aggregateFaces only offers *non*-planar faces to
       the fit, so an exactly flat face never reaches it — but a face a hair
       outside the planarity tolerance does, and its projected points are not
       collinear, so the circle fit will happily return an enormous radius with
       a tiny residual. Without the guard this face fits as R5000, which is not
       a corner blend on any moulded part; with it, the face is left flat.
       Built by hand rather than authored as STEP, because the fixture wanted
       here is a specific numerical edge rather than a shape. */
    const R = 5000, span = 20, N = 12;
    const verts = [], tris = [];
    for (let i = 0; i <= N; i++) {
      const t = (i / N - 0.5) * (span / R);
      const x = R * Math.sin(t), y = R * Math.cos(t) - R;
      verts.push(x, y, 0, x, y, 10);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      tris.push(a, c, b, b, c, d);
    }
    const vertices = new Float32Array(verts), indices = new Uint32Array(tris);
    const nTri = indices.length / 3;
    const triAreas = new Float64Array(nTri);
    const triFNorm = new Float64Array(nTri * 3), triCentroid = new Float64Array(nTri * 3);
    for (let t = 0; t < nTri; t++) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const e1 = [vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2]];
      const e2 = [vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1], vertices[c + 2] - vertices[a + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const m = Math.hypot(n[0], n[1], n[2]);
      triAreas[t] = m / 2;
      for (let k = 0; k < 3; k++) {
        triFNorm[t * 3 + k] = n[k] / m;
        triCentroid[t * 3 + k] = (vertices[a + k] + vertices[b + k] + vertices[c + k]) / 3;
      }
    }
    eq(fitCylinder({ vertices, indices }, 0, nTri - 1, triAreas, triFNorm, triCentroid), null,
      'fit on a 5 m radius face:');
  });

  await it('classification is decided by convexity and sweep, and nothing else', () => {
    /* The four branches, stated as a table rather than reached through four
       fixtures — the fixtures above prove the fit, this proves the rule. */
    eq(classifyCylinder({ convex: true, extentDeg: 360 }), 'boss');
    eq(classifyCylinder({ convex: false, extentDeg: 360 }), 'bore');
    eq(classifyCylinder({ convex: true, extentDeg: 90 }), 'round');
    eq(classifyCylinder({ convex: false, extentDeg: 90 }), 'fillet');
  });
}

describe('step — the corner radius check, and the limit of what it can see');
{
  await it('generous blends pass, and the check says what it measured', async () => {
    const a = analyse(await load([stepHalfTube(10, 6, 20).solid], 'blends-ok'));
    const c = runDFM({ ...CLEAN_INPUT, mesh: a }).checks.find((x) => x.key === 'corner_radii');
    assert(c, 'no corner_radii check on a part with fitted blends');
    eq(c.status, 'ok', 'status:');
    eq(c.severity, 'none', 'severity:');
    assert(/2 fitted cylindrical faces/.test(c.detail), `detail did not say what it measured: ${c.detail}`);
  });

  await it('a fillet far below the guideline is condemned, not noted', async () => {
    /* R0.2 against a 1.00 mm guideline on a 2 mm wall: a fifth of what it
       needs, which is a crack rather than a note for the next revision. */
    const a = analyse(await load([stepSharpFillet(0.2).solid], 'sharp'));
    const c = runDFM({ ...CLEAN_INPUT, mesh: a }).checks.find((x) => x.key === 'corner_radii');
    eq(c.status, 'fail', 'status:');
    eq(c.severity, 'critical', 'severity:');
    assert(/R0\.20/.test(c.detail), `detail did not name the radius: ${c.detail}`);
  });

  await it('the check always states what it cannot see', async () => {
    /* The honesty constraint: a corner modelled dead sharp has no cylindrical
       face, so it cannot appear. A clean result means the radii that exist
       are adequate, never that every corner has one — and the check has to
       say so even when it passes, or it implies a guarantee it cannot give. */
    for (const [name, solid] of [['pass', stepHalfTube().solid], ['fail', stepSharpFillet(0.2).solid]]) {
      const a = analyse(await load([solid], `limit-${name}`));
      const c = runDFM({ ...CLEAN_INPUT, mesh: a }).checks.find((x) => x.key === 'corner_radii');
      assert(/does not confirm that every corner is filleted/.test(c.detail),
        `the ${name} case did not state the limit of the measurement`);
    }
  });

  await it('a part with nothing to fit keeps the advisory, and no budget moves', async () => {
    /* An STL, or a B-rep with no blends at all. The scored check must not
       appear, the advisory must, and the budget must be the one every
       existing export was scored against. */
    for (const [name, mesh] of [
      ['stl', analyse(toSoup(stepBox()))],
      ['brep-no-blends', analyse(await load([stepBox()], 'box-advisory'))],
    ]) {
      const r = runDFM({ ...CLEAN_INPUT, mesh });
      assert(!r.checks.some((c) => c.key === 'corner_radii'), `${name}: scored check appeared with nothing to measure`);
      assert(r.checks.some((c) => c.key === 'corners'), `${name}: the advisory went missing`);
      eq(r.budget, 100, `${name} budget:`);
    }
  });

  await it('the scored check widens the budget rather than taking from the eight', async () => {
    /* The decision this milestone had to make, asserted rather than left in a
       comment: a part that can be measured is exposed to 8 more points, and
       the other checks keep the weights every previous export was scored on. */
    const a = analyse(await load([stepHalfTube().solid], 'budget'));
    const r = runDFM({ ...CLEAN_INPUT, mesh: a });
    eq(r.budget, 108, 'budget with corner_radii:');
    const c = r.checks.find((x) => x.key === 'corner_radii');
    eq(c.weight, 8, 'corner_radii weight:');
  });

  await it('a critical radius finding spends the whole of its weight', async () => {
    const a = analyse(await load([stepSharpFillet(0.2).solid], 'spend'));
    const r = runDFM({ ...CLEAN_INPUT, mesh: a });
    const c = r.checks.find((x) => x.key === 'corner_radii');
    close(c.scoreDeduction, 8, 1e-9, 'deduction for a critical corner radius:');
  });
}

describe('step — the record that leaves the tool');
{
  await it('the JSON export carries the named faces and their provenance', async () => {
    const a = analyse(await load([stepBox()], 'box-export'));
    const dfm = runDFM({ ...CLEAN_INPUT, mesh: a });
    const out = buildExportJSON({
      sessionId: 'TEST1', dfm: { result: dfm, input: CLEAN_INPUT }, analysis: a,
      twoShot: null, interface: null, validation: null, shot: null,
      settings: { analysisMode: 'single' },
    });
    eq(out.mesh_summary.measured_from, 'brep', 'provenance:');
    const byFace = out.mesh_summary.draft_by_face;
    assert(byFace, 'draft_by_face missing on a B-rep export');
    eq(byFace.under_min_count, 4, 'faces under minimum:');
    eq(byFace.worst.length, 4, 'worst list length:');
    close(byFace.worst[0].draft_deg, 0, 1e-6, 'worst face draft:');
    assert(byFace.worst[0].planar, 'a planar face was exported as curved');
  });

  await it('an STL export says it was measured from the mesh, and names no faces', async () => {
    const a = analyse(toSoup(stepBox()));
    const dfm = runDFM({ ...CLEAN_INPUT, mesh: a });
    const out = buildExportJSON({
      sessionId: 'TEST2', dfm: { result: dfm, input: CLEAN_INPUT }, analysis: a,
      twoShot: null, interface: null, validation: null, shot: null,
      settings: { analysisMode: 'single' },
    });
    eq(out.mesh_summary.measured_from, 'mesh', 'provenance:');
    eq(out.mesh_summary.draft_by_face, null, 'draft_by_face on a mesh export:');
  });
}

describe('step — wall thickness through the B-rep path');
{
  const cup = stepCup([40, 30, 20], 2);
  const geom = await load([cup], 'cup');

  await it('a shelled box reads back as fourteen faces', () => {
    eq(geom.faceGroups.length, cup.expect.faceCount, 'face count:');
  });

  await it('the 2 mm wall measures 2 mm', () => {
    const a = analyse(geom);
    close(a.wallStats.median, cup.expect.wall, 0.05, 'median wall:');
    /* Judged on the sphere figure, as the checks are: it must not read the
       cavity's diagonal as the wall. */
    close(a.wallMethod.sphereMedian, cup.expect.wall, 0.05, 'sphere median:');
  });

  await it('the shelled volume matches the analytic one', () => {
    close(analyse(geom).volume, cup.expect.volume, cup.expect.volume * 1e-3, 'volume:');
  });

  await it('STEP and STL of the same solid agree', () => {
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

  await it('two solids come back as two bodies', () => {
    assert(geom.bodies, 'bodies is null for a two-solid file');
    eq(geom.bodies.length, two.expect.bodyCount, 'body count:');
  });

  await it('one solid leaves the body selector unbuilt', () => {
    /* step.js only populates `bodies` above one, on the grounds that a
       selector for a single body earns nothing. */
    eq(single.bodies, null, 'single-body bodies:');
  });

  await it('the body ranges partition every triangle exactly once', () => {
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

  await it("each body's triangles sit inside that body, not the other one", () => {
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

  await it('a body with no name of its own still gets one', () => {
    for (const b of geom.bodies) assert(b.name && b.name.trim(), `body ${b.id} has no name`);
  });

  await it('both bodies together span the whole part', () => {
    const b = bboxOf(geom);
    for (let k = 0; k < 3; k++) close(b.size[k], two.expect.bbox[k], 1e-4, `axis ${k}:`);
  });
}

describe('step — normals');
{
  const geom = await load([stepBox()], 'normals');

  await it('every vertex normal is a unit vector', () => {
    for (let i = 0; i < geom.normals.length; i += 3) {
      const m = Math.hypot(geom.normals[i], geom.normals[i + 1], geom.normals[i + 2]);
      close(m, 1, 1e-4, `normal at vertex ${i / 3}:`);
    }
  });

  await it('normals point out of the solid', () => {
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
  await it('a file that is not STEP at all is refused', async () => {
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
