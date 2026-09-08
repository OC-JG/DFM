/*
 * Unit tests for the pure analysis modules.
 *
 * These assert numbers. The browser smoke test in smoke.mjs proves the
 * pipeline is wired together — that a score appears, that a PDF starts with
 * %PDF- — which is a different and much weaker claim than proving the score
 * is right. Everything here has a known answer: a closed-form one where the
 * geometry gives one, and otherwise a brute-force reference in lib/reference.mjs
 * written from the definition rather than from the implementation.
 *
 * No browser, no network, no build step. Run: node test/unit.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './lib/shapes.mjs';
import * as R from './lib/reference.mjs';
import { weldGeometry } from '../src/geometry/weld.js';
import { buildBVH, castRay, closestPoint } from '../src/geometry/bvh.js';
import { validateGeometry, rescaleGeometry, flipWinding } from '../src/geometry/validate.js';
import { analyseMesh, suggestPullDirection, CONE_RINGS_DEG, CONE_AZIMUTHS } from '../src/analysis/mesh.js';
import { stats, medianCI95, makeRandom } from '../src/analysis/stats.js';
import { runDFM } from '../src/rules/engine.js';
import { runTwoShotDFM } from '../src/rules/twoshot.js';
import {
  CHECK_RISK_PROFILES, TWO_SHOT_RISK_PROFILES, SEVERITY_FACTOR,
  scoreChecks, escalate, PART_GRADES, INTERFACE_GRADES,
} from '../src/rules/scoring.js';
import { buildExportJSON } from '../src/export/json.js';
import { createZip, crc32, crc32Hex } from '../src/export/zip.js';
import { buildFindingsPackage, safeName } from '../src/export/package.js';
import { compareRuns } from '../src/rules/compare.js';
import { buildIdentity, buildLabel, TOOL_VERSION, BUILD_FINGERPRINT } from '../src/core/build-info.js';
import { featureId, checkRef, FEATURE_GRID_MM, FEATURE_KINDS } from '../src/rules/findings.js';
import { estimateShot, nextMachineSize, CAVITY_PRESSURE_MPA } from '../src/analysis/shot.js';
import {
  estimateCycle, estimatePartCost, toolingDrivers,
  PRACTICAL_COOLING_FACTOR, COOLING_SHARE,
} from '../src/analysis/cost.js';
import { searchGateCandidates, buildAdjacency, geodesicFrom } from '../src/analysis/flow.js';
import { jacobiEigen } from '../src/analysis/linalg.js';
import {
  registerShots, fitRigid, rotationDegOf, identityXform, xformPoint,
  ENGAGE_FRACTION, ENGAGE_FLOOR_MM, RESIDUAL_IMPROVE, REGISTER_TRIM,
} from '../src/analysis/register.js';
import { analyseInterface } from '../src/analysis/interface.js';
import { analyseFpcRegion, FPC_SAMPLES, MAX_CROSSINGS } from '../src/analysis/fpc.js';
import { tagVersion, isPrerelease, section, releaseProblems, releaseNotes } from '../release.js';
import { castRayAll } from '../src/geometry/bvh.js';
import { effectiveMinDraft } from '../src/core/finishes.js';
import { MATERIALS, MATERIAL_ORDER } from '../src/core/materials.js';
import { DEFAULT_SETTINGS } from '../src/app/state.js';
import {
  createCameraState, quatFromThetaPhi,
  vDot, vLen, vSub, vUnit, vScale, PITCH_LIMIT, ZOOM_MIN_FACTOR, ZOOM_MAX_FACTOR,
} from '../src/app/camera-state.js';
import { applyRates, shape, isIdle, createNavigatorLoop, NAVIGATOR_DEFAULTS } from '../src/app/navigator.js';
import {
  axesFromCollections, decodeReport, readField, createHidSource,
  AXIS_USAGES, hidAvailable,
} from '../src/app/spacemouse.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// ── harness ────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];
let group = '';

function describe(name) { group = name; console.log(`\n${name}`); }

/* Awaited, and every call site awaits it. An earlier version of this did not:
   `fn()` inside a synchronous try/catch means an async body's rejection never
   reaches the catch — so an async test reports `ok` before it has run, and its
   work carries on after the summary is printed. Eight did, and the leftover
   work held the process open long enough for CI to shoot the runner. The same
   fix test/step.mjs already carries, for the same reason.

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
    throw new Error(`${msg} expected ${expected} ±${tol}, got ${actual} (off by ${Math.abs(actual - expected).toPrecision(3)})`);
  }
}

function within(actual, expected, pct, msg = '') {
  const tol = Math.abs(expected) * pct / 100;
  close(actual, expected, tol, `${msg} (${pct}%)`);
}

// ── helpers ────────────────────────────────────────────────────────────────

const weld = (soup) => weldGeometry(soup.positions, soup.triCount);
const analyse = (geom, opts = {}) =>
  analyseMesh(geom, { material: MATERIALS.abs, minDraft: 0.5, pullAxis: '+z', ...opts });

/*
 * Analysing a fixture is seconds of ray casting, and a dozen assertions want
 * the same one. Memoised so each is measured once per run.
 *
 * Safe to share: nothing downstream mutates a mesh analysis — `scoreChecks`
 * annotates the checks it is given, not the measurements they came from. The
 * exception is a test whose subject is reproducibility, which has to analyse
 * twice on purpose and says so where it does.
 */
const analysedOnce = new Map();
function analysedFixture(key, make, opts = {}) {
  if (!analysedOnce.has(key)) {
    analysedOnce.set(key, analyse(weld(make()), { suggestGate: false, ...opts }));
  }
  return analysedOnce.get(key);
}
const LEDGE_CUP = () => analysedFixture('ledge-cup', () => S.internalLedgeCup());
const SHELL_BOX = () => analysedFixture('shell-box', () => S.hollowBox([40, 30, 20], 2));

// ═══════════════════════════════════════════════════════════════════════════

describe('weld — quantisation seams');
{
  /* Sub-tolerance vertex noise is physically the same part. A welder whose
     tolerance means Euclidean distance produces the same mesh either way. */
  for (const [name, soup, expectVerts] of [
    ['box', S.box(), 8],
    ['hollow box', S.hollowBox(), 16],
    ['tube (96 seg)', S.tube(20, 2, 40, 96), 384],
  ]) {
    await it(`${name}: jittered soup welds identically to clean`, () => {
      const clean = weld(soup);
      const dirty = weld(S.jitterSoup(soup));
      eq(clean.vertCount, expectVerts, 'clean vertex count:');
      eq(dirty.vertCount, expectVerts, 'jittered vertex count:');
      eq(R.referenceEdgeCensus(dirty).boundary, 0, 'jittered mesh must stay closed:');
    });
  }

  await it('reports how many merges needed the neighbour probe', () => {
    const clean = weld(S.tube(20, 2, 40, 96));
    const dirty = weld(S.jitterSoup(S.tube(20, 2, 40, 96)));
    assert(dirty.weld.nearMerges > clean.weld.nearMerges,
      `jittered input should need more near merges (clean ${clean.weld.nearMerges}, jittered ${dirty.weld.nearMerges})`);
    assert(clean.weld.exactMerges > 0, 'clean input should merge mostly on the exact path');
  });

  await it('a part far from the origin welds the same as one at it', () => {
    /* Quantising against the origin overflows int32 for a small part in a
       global CAD frame, silently welding unrelated vertices together. */
    const near = S.tube(20, 2, 40, 96);
    const far = {
      positions: Float32Array.from(near.positions, (v, i) => v + [4.0e6, 2.5e6, 1.0e6][i % 3]),
      triCount: near.triCount,
    };
    eq(weld(far).vertCount, weld(near).vertCount, 'vertex count at 4e6 mm offset:');
  });

  await it('seams no longer corrupt flow length', () => {
    /* The damage seams actually do is to anything that walks the mesh as a
       graph. Before the fix this read 203.7 mm against a true 98.2 mm. */
    const gate = [20, 0, 0];
    const cleanFlow = analyse(weld(S.tube(20, 2, 40, 96)), { gateLocation: gate }).flowAnalysis;
    const dirtyFlow = analyse(weld(S.jitterSoup(S.tube(20, 2, 40, 96))), { gateLocation: gate }).flowAnalysis;
    within(dirtyFlow.maxFlow, cleanFlow.maxFlow, 1, 'max flow length:');
    within(dirtyFlow.maxLT, cleanFlow.maxLT, 1, 'max L/T:');
  });
}

describe('sampling — determinism');
{
  const geom = weld(S.tube(20, 2, 40, 1200));

  await it('the same geometry gives bit-identical results across runs', () => {
    const runs = Array.from({ length: 4 }, () => analyse(geom).wallStats);
    for (const key of ['median', 'p5', 'p25', 'p75', 'p95', 'mean']) {
      const vals = runs.map((r) => r[key]);
      assert(vals.every((v) => v === vals[0]), `${key} drifted across runs: ${vals.join(', ')}`);
    }
  });

  await it('sink and draft percentages are stable too', () => {
    const a = analyse(geom), b = analyse(geom);
    eq(a.sinkPctSevere, b.sinkPctSevere, 'severe sink area:');
    eq(a.sinkPctModerate, b.sinkPctModerate, 'moderate sink area:');
    eq(a.sidePctUnderMin, b.sidePctUnderMin, 'sidewall under min draft:');
  });

  await it('the seed is genuinely in use, not ignored', () => {
    /* A test that only checked "two runs agree" would also pass if the
       sampler had been hard-coded to a fixed grid. */
    const varied = weld(S.frustum(20, 30, 8));
    const a = analyse(varied, { sampleSeed: 1 }).wallStats.mean;
    const b = analyse(varied, { sampleSeed: 999 }).wallStats.mean;
    assert(a !== b, 'different seeds produced identical means — is the seed wired through?');
  });
}

describe('stats — median confidence interval');
{
  await it('brackets the median', () => {
    const vals = Array.from({ length: 2000 }, (_, i) => Math.sin(i * 1.7) * 2 + 5);
    const s = stats(vals);
    assert(s.medLo <= s.median && s.median <= s.medHi,
      `CI [${s.medLo}, ${s.medHi}] does not contain median ${s.median}`);
  });

  await it('narrows as the sample grows', () => {
    const gen = (n) => {
      const rnd = makeRandom(7);
      return stats(Array.from({ length: n }, () => rnd() * 4 + 1));
    };
    const small = gen(200), large = gen(20000);
    assert(large.medUncertainty < small.medUncertainty,
      `20k samples (±${large.medUncertainty}) should be tighter than 200 (±${small.medUncertainty})`);
  });

  await it('a constant distribution has zero width', () => {
    const [lo, hi] = medianCI95(Float64Array.from({ length: 500 }, () => 2));
    eq(lo, 2); eq(hi, 2);
  });
}

describe('wall thickness — ray method against known geometry');
{
  for (const [name, soup, truth] of [
    ['hollow box, 2 mm wall', S.hollowBox([40, 30, 20], 2), 2],
    ['tube, 2 mm wall', S.tube(20, 2, 40, 128), 2],
    ['tube, 1.5 mm wall', S.tube(20, 1.5, 40, 128), 1.5],
    ['tube, 0.8 mm wall', S.tube(20, 0.8, 40, 128), 0.8],
  ]) {
    await it(`${name} measures ${truth} mm`, () => {
      within(analyse(weld(soup)).wallStats.median, truth, 1, 'median wall:');
    });
  }
}

describe('wall thickness — inscribed sphere');
{
  const battery = [
    ['solid box', S.box()],
    ['hollow box', S.hollowBox()],
    ['tube', S.tube(20, 2, 40, 64)],
    ['frustum 5°', S.frustum(20, 30, 5)],
    ['wedge 30°', S.wedgeSlab(60, 30, 6, 30)],
    ['wedge 45°', S.wedgeSlab(60, 30, 6, 45)],
  ];

  await it('equals the ray estimate on parallel walls', () => {
    for (const [name, soup] of [['hollow box', S.hollowBox()], ['tube', S.tube(20, 2, 40, 128)]]) {
      const wm = analyse(weld(soup)).wallMethod;
      close(wm.ratio, 1, 0.005, `${name}: sphere/ray ratio`);
    }
  });

  await it('never exceeds the ray estimate', () => {
    /* It is a minimum over a set that includes the axial ray, so by
       construction it cannot come out larger. */
    for (const [name, soup] of battery) {
      const wm = analyse(weld(soup)).wallMethod;
      assert(wm.sphereMedian <= wm.rayMedian + 1e-6,
        `${name}: sphere ${wm.sphereMedian} exceeded ray ${wm.rayMedian}`);
    }
  });

  await it('agrees with a 2561-ray brute-force reference', () => {
    for (const [name, soup] of battery) {
      const geom = weld(soup);
      const { bvh, bounds } = R.bvhFor(geom);
      const { centroid, normal } = R.triangleData(geom);
      const eps = bounds.diag * 1e-5;
      const step = Math.max(1, Math.floor(geom.triCount / 40));
      const errors = [];
      for (let t = 0; t < geom.triCount; t += step) {
        const axial = R.rayThicknessAt(bvh, geom, t, centroid, normal, eps, bounds.diag);
        if (axial === null) continue;
        const ref = Math.min(axial, R.referenceSphereThickness(
          bvh, geom, t,
          [centroid[t * 3], centroid[t * 3 + 1], centroid[t * 3 + 2]],
          [normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]],
          eps, bounds.diag, { extraThetaDeg: CONE_RINGS_DEG }));
        const est = analyseSphereAt(geom, bvh, t, centroid, normal, eps, bounds.diag, axial);
        /* The reference sweeps a superset of the estimator's directions, so
           it is a genuine lower bound. Coming in under it means a real bug. */
        assert(est >= ref - 1e-6, `${name} tri ${t}: estimate ${est} below reference ${ref}`);
        errors.push((est - ref) / ref * 100);
      }
      errors.sort((a, b) => a - b);
      const median = errors[errors.length >> 1];
      const worst = errors[errors.length - 1];
      /* What ships is a median over a thousand sampled points, so the median
         error is the one that reaches the report. The worst case sits on
         isolated triangles at external edges, where the binding direction
         falls between azimuth samples; quadrupling the ray budget moves it to
         about 1% and the reported median not at all. */
      assert(median < 1, `${name}: median overshoot ${median.toFixed(2)}% (expected under 1%)`);
      assert(worst < 8, `${name}: worst-case overshoot ${worst.toFixed(2)}% (expected under 8%)`);
    }
  });
}

/* Re-derives the shipped estimator's answer for one triangle. analyseMesh
   only exposes aggregate statistics, and the reference comparison needs the
   two evaluated at the same point. */
function analyseSphereAt(geom, bvh, t, centroid, normal, eps, diag, axial) {
  const RINGS = CONE_RINGS_DEG, AZ = CONE_AZIMUTHS;
  const ix = -normal[t * 3], iy = -normal[t * 3 + 1], iz = -normal[t * 3 + 2];
  let ux = Math.abs(ix) < 0.9 ? 1 : 0, uy = Math.abs(ix) < 0.9 ? 0 : 1, uz = 0;
  const d = ux * ix + uy * iy + uz * iz;
  ux -= d * ix; uy -= d * iy; uz -= d * iz;
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  const vx = iy * uz - iz * uy, vy = iz * ux - ix * uz, vz = ix * uy - iy * ux;
  const ox = centroid[t * 3] + ix * eps, oy = centroid[t * 3 + 1] + iy * eps, oz = centroid[t * 3 + 2] + iz * eps;
  let best = axial;
  for (const deg of RINGS) {
    const th = deg * Math.PI / 180, st = Math.sin(th), ct = Math.cos(th);
    for (let k = 0; k < AZ; k++) {
      const ph = (k / AZ) * Math.PI * 2;
      const cu = st * Math.cos(ph), cv = st * Math.sin(ph);
      const hit = castRay(bvh, geom,
        ox, oy, oz,
        ix * ct + ux * cu + vx * cv, iy * ct + uy * cu + vy * cv, iz * ct + uz * cu + vz * cv,
        eps, t);
      if (hit === Infinity || hit >= diag) continue;
      const bound = hit / ct;
      if (bound < best) best = bound;
    }
  }
  return best;
}

describe('draft — frustum with a known wall angle');
{
  for (const deg of [1, 3, 5, 10]) {
    await it(`${deg}° frustum reads exactly ${deg}° on every side wall`, () => {
      const m = analyse(weld(S.frustum(20, 30, deg)), { minDraft: deg });
      let lo = Infinity, hi = -Infinity, n = 0;
      for (let t = 0; t < m.triCount; t++) {
        if (Math.abs(m.triPullDot[t]) >= 0.5) continue;
        lo = Math.min(lo, m.triDraft[t]); hi = Math.max(hi, m.triDraft[t]); n++;
      }
      assert(n > 0, 'no side-wall triangles found');
      close(lo, deg, 0.01, 'minimum side-wall draft:');
      close(hi, deg, 0.01, 'maximum side-wall draft:');
    });
  }

  await it('the under-minimum area flips cleanly either side of the threshold', () => {
    const geom = weld(S.frustum(20, 30, 3));
    close(analyse(geom, { minDraft: 2.9 }).sidePctUnderMin, 0, 0.01, 'at 2.9° required:');
    close(analyse(geom, { minDraft: 3.1 }).sidePctUnderMin, 100, 0.01, 'at 3.1° required:');
  });
}

describe('validation — topology');
{
  await it('a closed box is sound', () => {
    const v = validateGeometry(weld(S.box([40, 30, 20])));
    eq(v.confidence, 'high'); eq(v.closed, true); eq(v.inverted, false);
    eq(v.analysable, true);
    close(v.volume, 24000, 1, 'enclosed volume:');
    eq(v.issues.length, 0, 'issue count:');
  });

  await it('an open box is detected, with the right edge count', () => {
    const geom = weld(S.box([40, 30, 20], { omit: ['pz'] }));
    const v = validateGeometry(geom);
    eq(v.closed, false);
    eq(v.edges.boundary, R.referenceEdgeCensus(geom).boundary, 'boundary edges vs reference:');
    eq(v.edges.boundary, 4);
    eq(v.volume, null, 'volume must not be reported for an open surface');
    assert(v.issues.some((i) => i.code === 'open-mesh'), 'no open-mesh issue raised');
  });

  await it('inverted normals are detected and the offered fix works', () => {
    const bad = weld(S.box([40, 30, 20], { invert: true }));
    const vBad = validateGeometry(bad);
    eq(vBad.inverted, true);
    assert(R.referenceSignedVolume(bad) < 0, 'reference disagrees that this is inverted');
    const vFixed = validateGeometry(flipWinding(bad));
    eq(vFixed.inverted, false);
    eq(vFixed.confidence, 'high');
  });

  await it('inconsistent winding is counted per affected edge', () => {
    const geom = weld(S.boxWithFlippedFace());
    const v = validateGeometry(geom);
    eq(v.windingConsistent, false);
    eq(v.edges.inconsistent, 4, 'one flipped quad has four edges:');
    eq(v.edges.inconsistent, R.referenceEdgeCensus(geom).inconsistent, 'vs reference:');
    eq(v.volume, null, 'volume is meaningless when winding disagrees');
  });

  await it('non-manifold edges are found', () => {
    const geom = weld(S.box([40, 30, 20], { extraFin: true }));
    const v = validateGeometry(geom);
    eq(v.edges.nonManifold, 1);
    eq(v.edges.nonManifold, R.referenceEdgeCensus(geom).nonManifold, 'vs reference:');
  });

  await it('a surface with no interior is refused rather than analysed', () => {
    const out = [];
    S.quad(out, [0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0]);
    const v = validateGeometry(weld(S.toSoup(out)));
    eq(v.analysable, false);
    eq(v.confidence, 'unusable');
  });

  await it('every edge census agrees with the independent reference', () => {
    for (const [name, soup] of [
      ['box', S.box()], ['open', S.box([40, 30, 20], { omit: ['nx'] })],
      ['fin', S.box([40, 30, 20], { extraFin: true })], ['flipped face', S.boxWithFlippedFace()],
      ['tube', S.tube(20, 2, 40, 32)], ['hollow box', S.hollowBox()],
    ]) {
      const geom = weld(soup);
      const mine = validateGeometry(geom).edges;
      const ref = R.referenceEdgeCensus(geom);
      for (const k of ['total', 'boundary', 'nonManifold', 'inconsistent']) {
        eq(mine[k], ref[k], `${name} ${k}:`);
      }
    }
  });
}

describe('validation — units');
{
  await it('flags a part authored in inches', () => {
    const v = validateGeometry(weld(S.scaleSoup(S.tube(20, 2, 40), 1 / 25.4)));
    assert(v.scale.suspect, 'no scale suspicion raised');
    const fix = v.issues.find((i) => i.code === 'scale').fixes.find((f) => f.factor === 25.4);
    assert(fix, 'no inch→mm conversion offered');
  });

  await it('flags a part authored in metres', () => {
    const v = validateGeometry(weld(S.scaleSoup(S.tube(20, 2, 40), 1 / 1000)));
    eq(v.scale.suspect, 'too-small');
    assert(v.issues.find((i) => i.code === 'scale').fixes.some((f) => f.factor === 1000),
      'no metre→mm conversion offered');
  });

  await it('leaves a normal part alone', () => {
    const v = validateGeometry(weld(S.tube(20, 2, 40)));
    eq(v.scale.suspect, null);
  });

  await it('asks rather than asserts on a genuinely small part', () => {
    /* An 8 mm clip is a real thing. It gets a question, not a verdict. */
    const v = validateGeometry(weld(S.scaleSoup(S.tube(20, 2, 40), 8 / 44.72)));
    eq(v.scale.suspect, 'maybe-inches');
    eq(v.scale.level, 'warn');
    eq(v.analysable, true);
  });

  await it('rescaling restores the part exactly', () => {
    const inch = weld(S.scaleSoup(S.tube(20, 2, 40, 96), 1 / 25.4));
    const fixed = rescaleGeometry(inch, 25.4);
    const native = weld(S.tube(20, 2, 40, 96));
    const v = validateGeometry(fixed);
    eq(v.confidence, 'high');
    within(v.volume, validateGeometry(native).volume, 0.01, 'volume after rescale:');
    within(analyse(fixed).wallStats.median, 2, 1, 'wall thickness after rescale:');
  });
}


// ═══════════════════════════════════════════════════════════════════════════

/* A part with nothing wrong with it: 2 mm walls, 3° draft, ribs and bosses in
   band, no undercuts, a material that does not warp, a finish it can hold. */
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

function meshFor(soup, finishKey = 'spi-a2') {
  const mat = MATERIALS.abs;
  return analyseMesh(weld(soup), {
    material: mat, finishKey, moldType: 'two-piece',
    minDraft: effectiveMinDraft(mat, finishKey), manualWall: 2, pullAxis: '+z',
  });
}

const DEFAULT_CHECK_KEYS = ['wall', 'draft', 'sink', 'flow', 'ribs', 'warp', 'undercut', 'finish_compat'];

describe('materials — the cooling coefficient is written for the full wall');
{
  /* The question that blocked cycle time, kept answered.
     Rearranging tc = k·s² through the plate-cooling solution, each coefficient
     implies a thermal diffusivity:
         α = ln[(4/π)·(Tmelt − Tmould)/(Teject − Tmould)] / (π²·k)
     under the full-wall reading, and a quarter of that under the half-wall
     one. Diffusivity is a measured property, so the two readings can be held
     against physics rather than against opinion. See docs/coolk.md. */
  const LOG_CONST = 4 / Math.PI;
  const PROCESS = {
    abs: [50, 90], pp: [30, 80], pc: [90, 130], pa6: [80, 120],
    pa66gf: [90, 150], pom: [90, 120], hdpe: [30, 70], pe: [30, 65],
    ps: [40, 80], pbt: [80, 130], petg: [20, 70], pmma: [70, 95],
    tpu: [25, 60], asa: [50, 90], asa_n: [50, 90], pcasa: [70, 105],
  };
  /* Unfilled thermoplastics measure roughly 0.05–0.20 mm²/s. */
  const DIFFUSIVITY_LO = 0.05, DIFFUSIVITY_HI = 0.20;

  const impliedAlpha = (key) => {
    const m = MATERIALS[key];
    const [mould, eject] = PROCESS[key];
    const L = Math.log(LOG_CONST * (m.meltC - mould) / (eject - mould));
    return L / (Math.PI ** 2 * m.coolK);
  };

  await it('every coefficient implies a diffusivity a real polymer has', () => {
    for (const key of MATERIAL_ORDER) {
      const a = impliedAlpha(key);
      assert(a >= DIFFUSIVITY_LO && a <= DIFFUSIVITY_HI,
        `${MATERIALS[key].name}: coolK ${MATERIALS[key].coolK} implies α = ${a.toFixed(4)} mm²/s, outside ${DIFFUSIVITY_LO}–${DIFFUSIVITY_HI}`);
    }
  });

  await it('the half-wall reading is impossible for every material, not merely unlikely', () => {
    /* This is the assertion that pins the convention. If someone rewrites a
       coefficient into the half-wall form — multiplying it by four — its
       implied diffusivity lands in a range no thermoplastic occupies, and the
       test above fails. This one states the other half: that the alternative
       reading of the current numbers is not a close call. */
    for (const key of MATERIAL_ORDER) {
      const a = impliedAlpha(key) / 4;
      assert(a < DIFFUSIVITY_LO,
        `${MATERIALS[key].name}: the half-wall reading implies α = ${a.toFixed(4)} mm²/s, which is not obviously impossible — the convention is no longer settled by arithmetic alone`);
    }
  });

  await it('a 2 mm wall cools in seconds, not in a fraction of one', () => {
    /* The sanity check a moulder would apply without any of the above: no
       2 mm thermoplastic section leaves a tool in under a second. */
    for (const key of MATERIAL_ORDER) {
      const floor = MATERIALS[key].coolK * 2 * 2;   // full wall, so s = 2 mm
      assert(floor >= 3 && floor <= 12,
        `${MATERIALS[key].name}: a 2 mm wall would cool in ${floor.toFixed(1)} s`);
    }
  });
}

describe('cycle time — a derived floor and two stated assumptions');
{
  await it('the cooling floor is k·s² on the full wall, and nothing else', () => {
    /* The number the coolK derivation settled. If this ever disagrees with
       coolK × wall², the convention has drifted again. */
    const c = estimateCycle({ material: MATERIALS.abs, wallMm: 2 });
    close(c.coolingFloorS, MATERIALS.abs.coolK * 4, 1e-9, 'cooling floor:');
  });

  await it('the floor is a floor: practical cooling and the cycle are both longer', () => {
    const c = estimateCycle({ material: MATERIALS.abs, wallMm: 2 });
    assert(c.practicalCoolingS > c.coolingFloorS, 'practical cooling did not exceed the floor');
    assert(c.cycleS.lo > c.practicalCoolingS, 'the cycle was shorter than the cooling inside it');
    assert(c.cycleS.hi > c.cycleS.lo, 'the cycle band is inverted');
  });

  await it('each step is the stated factor, not a hidden one', () => {
    /* The point of publishing the factors is that a reader can check them. */
    const c = estimateCycle({ material: MATERIALS.pc, wallMm: 3 });
    close(c.practicalCoolingS, c.coolingFloorS * PRACTICAL_COOLING_FACTOR, 1e-9, 'practical cooling:');
    close(c.cycleS.lo, c.practicalCoolingS / COOLING_SHARE.hi, 1e-9, 'cycle lo:');
    close(c.cycleS.hi, c.practicalCoolingS / COOLING_SHARE.lo, 1e-9, 'cycle hi:');
  });

  await it('cooling goes as the square of the wall', () => {
    const thin = estimateCycle({ material: MATERIALS.abs, wallMm: 1 });
    const thick = estimateCycle({ material: MATERIALS.abs, wallMm: 2 });
    close(thick.coolingFloorS / thin.coolingFloorS, 4, 1e-9, 'doubling the wall:');
  });

  await it('output scales with cavities but the cycle does not', () => {
    const one = estimateCycle({ material: MATERIALS.abs, wallMm: 2, cavities: 1 });
    const four = estimateCycle({ material: MATERIALS.abs, wallMm: 2, cavities: 4 });
    close(four.cycleS.lo, one.cycleS.lo, 1e-9, 'cycle with more cavities:');
    close(four.partsPerHour.lo, one.partsPerHour.lo * 4, 1e-6, 'parts per hour:');
  });

  await it('an unmeasured part gets no cycle time and says why', () => {
    const c = estimateCycle({ material: MATERIALS.abs, wallMm: null });
    eq(c.coolingFloorS, null, 'cooling floor without a wall:');
    assert(/needs a wall thickness/.test(c.notes.join(' ')), `no explanation given: ${c.notes}`);
  });

  await it('every assumption is published with the number', () => {
    const c = estimateCycle({ material: MATERIALS.abs, wallMm: 2 });
    const text = c.assumptions.join(' ');
    assert(/full-wall/.test(text), 'the convention is not stated');
    assert(new RegExp(String(PRACTICAL_COOLING_FACTOR)).test(text), 'the cooling factor is not stated');
    assert(/50–80%|50-80%/.test(text), 'cooling’s share of the cycle is not stated');
  });
}

describe('cost — arithmetic on stated rates, and silence without them');
{
  const cycleS = { lo: 10, hi: 20 };

  await it('no rate, no cost — and the reason names what is missing', () => {
    /* The rule the module exists to keep: a plausible-looking default resin
       price would be indistinguishable on screen from a real quotation. */
    const c = estimatePartCost({ shotMassG: 10, cycleS, cavities: 1 });
    eq(c.totalCost, null, 'total without rates:');
    eq(c.materialCost, null, 'material without a resin price:');
    assert(c.missing.some((m) => /resin price/.test(m)), `missing did not name the resin price: ${c.missing}`);
    assert(c.missing.some((m) => /machine rate/.test(m)), `missing did not name the machine rate: ${c.missing}`);
  });

  await it('material is shot weight at the price given', () => {
    const c = estimatePartCost({ shotMassG: 10, cycleS, resinPerKg: 2, machinePerHour: 60 });
    close(c.materialCost, 0.02, 1e-9, '10 g at 2/kg:');
  });

  await it('scrap is an allowance on material, not on machine time', () => {
    const plain = estimatePartCost({ shotMassG: 10, cycleS, resinPerKg: 2, machinePerHour: 60 });
    const scrap = estimatePartCost({ shotMassG: 10, cycleS, resinPerKg: 2, machinePerHour: 60, scrapPct: 10 });
    close(scrap.materialCost, plain.materialCost * 1.1, 1e-9, 'material with 10% scrap:');
    close(scrap.machineCost.lo, plain.machineCost.lo, 1e-9, 'machine cost with scrap:');
  });

  await it('machine time is shared across the cavities', () => {
    const one = estimatePartCost({ shotMassG: 10, cycleS, cavities: 1, resinPerKg: 2, machinePerHour: 3600 });
    const four = estimatePartCost({ shotMassG: 10, cycleS, cavities: 4, resinPerKg: 2, machinePerHour: 3600 });
    /* 3600/hour is 1 per second, so a 10 s cycle is 10 in one cavity. */
    close(one.machineCost.lo, 10, 1e-9, 'machine cost, one cavity:');
    close(four.machineCost.lo, 2.5, 1e-9, 'machine cost, four cavities:');
  });

  await it('the total is material plus machine and nothing else', () => {
    const c = estimatePartCost({ shotMassG: 10, cycleS, resinPerKg: 2, machinePerHour: 3600 });
    close(c.totalCost.lo, c.materialCost + c.machineCost.lo, 1e-9, 'total lo:');
    close(c.totalCost.hi, c.materialCost + c.machineCost.hi, 1e-9, 'total hi:');
  });

  await it('it says out loud that it is not a piece price', () => {
    /* The caveat is the point. A figure this shape gets pasted into a
       spreadsheet, and the spreadsheet does not carry the tooltip. */
    const c = estimatePartCost({ shotMassG: 10, cycleS, resinPerKg: 2, machinePerHour: 60 });
    assert(/labour|margin|overhead/i.test(c.notes.join(' ')), `no caveat given: ${c.notes}`);
  });
}

describe('cost — and the score, which must not notice it');
{
  await it('nothing about cost or cycle time can move the score', () => {
    /* The separation the milestone turned on: these are not pass-or-fail
       properties of a part, so they must not appear as a check, carry a
       weight, or widen the budget. A part scores the same whether or not
       anyone has entered a resin price. */
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowBox([40, 30, 20], 2)) });
    for (const c of r.checks) {
      assert(!/cost|cycle|price|tooling_cost/i.test(c.key),
        `${c.key} is a scored check about cost`);
    }
    for (const key of Object.keys(CHECK_RISK_PROFILES)) {
      assert(!/cost|cycle|price/i.test(key), `${key} carries a weight for a cost figure`);
    }
    eq(r.budget, 100, 'budget with the default checks:');
  });
}

describe('tooling — the drivers, never a price');
{
  const mat = MATERIALS.abs;

  await it('slides and lifters are counted the way the undercut check counts them', () => {
    /* Same fields, same 1 mm² noise threshold, so the two can never disagree
       about the same part. */
    const analysis = {
      undercutRegions: [
        { type: 1, area: 40 }, { type: 1, area: 0.5 },   // one slide, one speck
        { type: 2, area: 12 },                            // one lifter
      ],
    };
    const t = toolingDrivers({ analysis, material: mat, cavities: 1 });
    eq(t.slides, 1, 'slides:');
    eq(t.lifters, 1, 'lifters:');
  });

  await it('a part needing no moving tooling is told so', () => {
    const t = toolingDrivers({ analysis: { undercutRegions: [] }, material: mat, cavities: 1 });
    assert(t.drivers.some((d) => /No moving tooling/.test(d.driver)), 'the clean case went unsaid');
  });

  await it('an abrasive material is a tool-life driver', () => {
    const t = toolingDrivers({ analysis: { undercutRegions: [] }, material: MATERIALS.pa66gf, cavities: 1 });
    assert(t.drivers.some((d) => /abrasive/i.test(d.driver)), 'glass fill was not flagged');
  });

  await it('it never produces a currency figure', () => {
    /* The deliberate omission. What a tool costs depends on the toolmaker,
       the steel and the country, none of which is in the file. */
    const t = toolingDrivers({
      analysis: { undercutRegions: [{ type: 1, area: 40 }] },
      material: mat, cavities: 8, finishName: 'SPI-A1', bboxMm: [40, 30, 20],
    });
    assert(!('cost' in t) && !('price' in t), 'tooling produced a cost');
    assert(/not a price/i.test(t.note), 'the note does not disclaim a price');
    assert(/parting line/i.test(t.partingCaveat), 'the parting-line caveat is missing');
  });

  await it('the moving-tooling count inherits the parting-line assumption, and says so', () => {
    const t = toolingDrivers({
      analysis: { undercutRegions: [{ type: 1, area: 40 }] }, material: mat, cavities: 1,
    });
    assert(/features needing a decision/i.test(t.partingCaveat),
      'the count is presented as a slide count rather than as features to decide');
  });
}

describe('scoring — the weight table');
{
  await it('the checks that run by default sum to exactly 100', () => {
    const total = DEFAULT_CHECK_KEYS.reduce((sum, k) => sum + CHECK_RISK_PROFILES[k].weight, 0);
    eq(total, 100, 'default budget:');
  });

  await it('the two-shot table sums to 100 as well', () => {
    /* The thermal check gave up its 25 points when melt-versus-HDT stopped
       being scored; they were redistributed across the surviving five in
       proportion, so the interface score is still out of a full 100. */
    const total = Object.values(TWO_SHOT_RISK_PROFILES).reduce((sum, p) => sum + p.weight, 0);
    eq(total, 100, 'two-shot budget:');
    eq(TWO_SHOT_RISK_PROFILES.ts_thermal.weight, 0, 'thermal advisory weight:');
  });

  await it('the corner advisory holds no budget it could never spend', () => {
    eq(CHECK_RISK_PROFILES.corners.weight, 0);
  });

  await it('every severity band deducts exactly its share of the weight', () => {
    for (const [key, profile] of Object.entries(CHECK_RISK_PROFILES)) {
      for (const [band, factor] of Object.entries(SEVERITY_FACTOR)) {
        const checks = [{ key, status: 'fail', severity: band }];
        const { totalDeduction } = scoreChecks(checks, PART_GRADES);
        close(totalDeduction, profile.weight * factor, 1e-9, `${key} at ${band}:`);
      }
    }
  });

  await it('escalate only ever raises a severity', () => {
    eq(escalate('critical', 'minor'), 'critical');
    eq(escalate('minor', 'major'), 'major');
    eq(escalate('none', 'minor'), 'minor');
    eq(escalate(undefined, 'major'), 'major');
  });

  await it('the score is exactly 100 × (1 − deduction / budget)', () => {
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowBox([40, 30, 20], 2)) });
    eq(r.score, Math.max(0, Math.round(100 * (1 - r.totalDeduction / r.budget))), 'reported score:');
  });
}

describe('scoring — advisories are not defects');
{
  await it('a part with no findings scores exactly 100', () => {
    /* Before this, the same part scored 96: the flow check charged it 4.5
       points for a gate the user had not picked yet, and the corner advisory
       held 3 points of budget it could never spend. */
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowFrustum(20, 30, 3, 2)) });
    eq(r.score, 100, `score (deductions: ${r.checks.filter((c) => c.scoreDeduction > 0).map((c) => `${c.key} −${c.scoreDeduction}`).join(', ') || 'none'})`);
    eq(r.budget, 100, 'budget:');
    eq(r.criticalCount, 0, 'critical findings:');
    eq(r.grade.label, 'PRODUCTION READY');
  });

  await it('not having picked a gate costs nothing', () => {
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowFrustum(20, 30, 3, 2)) });
    const flow = r.checks.find((c) => c.key === 'flow');
    eq(flow.status, 'info', 'status for an unrun check:');
    eq(flow.scoreDeduction, 0, 'deduction:');
    /* Still in the budget: the check is available and will deduct once it can
       actually measure something. */
    eq(CHECK_RISK_PROFILES.flow.weight > 0, true);
  });

  await it('the corner advisory is marked as advice and costs nothing', () => {
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowFrustum(20, 30, 3, 2)) });
    const corners = r.checks.find((c) => c.key === 'corners');
    eq(corners.status, 'info');
    eq(corners.scoreDeduction, 0);
  });

  await it('surface finish reports even when it passes, so the budget is stable', () => {
    /* Silence used to be the pass condition, which made the denominator depend
       on whether this check happened to have anything to say. */
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowFrustum(20, 30, 3, 2)) });
    const finish = r.checks.find((c) => c.key === 'finish_compat');
    assert(finish, 'finish check missing on a compatible pairing');
    eq(finish.status, 'ok');
    eq(finish.scoreDeduction, 0);
  });
}

describe('scoring — grade cannot outrun the findings');
{
  await it('one critical finding rules out PRODUCTION READY even at a high score', () => {
    /* A declared lifter is a critical finding on a 10-point check, so the
       arithmetic alone leaves 90 — comfortably inside the production-ready
       band, which would be an untraceable verdict. */
    const r = runDFM({ ...CLEAN_INPUT, hasUndercut: '2' });
    eq(r.criticalCount, 1, 'critical findings:');
    assert(r.score >= 85, `score should be high for this test to mean anything, got ${r.score}`);
    eq(r.grade.label, 'MINOR REWORK');
  });

  await it('two criticals rule out MINOR REWORK', () => {
    const checks = [
      { key: 'wall', status: 'fail', severity: 'critical' },
      { key: 'draft', status: 'fail', severity: 'critical' },
    ];
    const { grade } = scoreChecks(checks, PART_GRADES);
    assert(['MAJOR REWORK', 'NOT MANUFACTURABLE'].includes(grade.label), `got ${grade.label}`);
  });

  await it('the advisory checks cannot contribute a critical', () => {
    const { criticalCount } = scoreChecks([{ key: 'corners', status: 'fail', severity: 'critical' }], PART_GRADES);
    eq(criticalCount, 0, 'a zero-weight check must not gate the grade:');
  });
}

describe('scoring — draft follows the surface finish');
{
  await it('the required draft includes the texture allowance', () => {
    const mat = MATERIALS.abs;
    for (const [finish, expected] of [['spi-a2', 0.5], ['tex-med', 3.5], ['edm-heavy', 6.5]]) {
      const r = runDFM({ ...CLEAN_INPUT, surfaceFinish: finish, mesh: meshFor(S.hollowFrustum(20, 30, 8, 2), finish) });
      const draft = r.checks.find((c) => c.key === 'draft');
      const required = draft.metrics.find(([k]) => k === 'Required');
      assert(required, `no Required metric for ${finish}`);
      close(parseFloat(required[1]), expected, 0.01, `${finish} required draft:`);
      close(effectiveMinDraft(mat, finish), expected, 0.01, `${finish} effectiveMinDraft:`);
    }
  });

  await it('a stated draft that clears the material minimum can still fail on texture', () => {
    /* The regression. This part has 8° walls, so the mesh is happy either way;
       what changed is that a stated 3° is now judged against the 6.5° a
       heavy-EDM cavity needs instead of the 0.5° ABS needs. It used to read
       "comfortably exceeds ABS minimum (0.5°)" and score 96, PRODUCTION READY. */
    const polished = runDFM({ ...CLEAN_INPUT, draftAngle: 3.0, surfaceFinish: 'spi-a2', mesh: meshFor(S.hollowFrustum(20, 30, 8, 2), 'spi-a2') });
    const textured = runDFM({ ...CLEAN_INPUT, draftAngle: 3.0, surfaceFinish: 'edm-heavy', mesh: meshFor(S.hollowFrustum(20, 30, 8, 2), 'edm-heavy') });
    eq(polished.checks.find((c) => c.key === 'draft').status, 'ok', 'polished:');
    eq(textured.checks.find((c) => c.key === 'draft').status, 'fail', 'heavy-EDM:');
    assert(textured.score < polished.score, `textured (${textured.score}) should score below polished (${polished.score})`);
  });

  await it('the area figure is labelled with the threshold it was measured against', () => {
    const r = runDFM({ ...CLEAN_INPUT, surfaceFinish: 'edm-heavy', mesh: meshFor(S.hollowBox([40, 30, 20], 2), 'edm-heavy') });
    const draft = r.checks.find((c) => c.key === 'draft');
    const areaRow = draft.metrics.find(([k]) => k.startsWith('Area <'));
    assert(areaRow, 'no area metric');
    assert(areaRow[0].includes('6.50'), `area metric is labelled "${areaRow[0]}" but was measured against 6.50°`);
  });
}

describe('scoring — one source of truth');
{
  await it('no check carries a penalty field any more', () => {
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowBox([40, 30, 20], 2)) });
    for (const c of r.checks) {
      eq(c.penalty, undefined, `${c.key} still has a penalty field:`);
      assert(c.severity !== undefined, `${c.key} has no severity`);
      assert(c.weight !== undefined, `${c.key} has no weight`);
    }
  });

  await it('the JSON export carries one deduction per check, not two', () => {
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowBox([40, 30, 20], 2)) });
    const json = buildExportJSON({
      sessionId: 'TEST', dfm: { input: CLEAN_INPUT, result: r },
      analysis: null, twoShot: null, interface: null, validation: null,
      settings: { analysisMode: 'single', windowType: 'none' },
    });
    const serialised = JSON.stringify(json);
    assert(!serialised.includes('"penalty"'), 'the export still writes a penalty field');
    for (const c of json.checks) {
      assert(typeof c.score_deduction === 'number', `${c.key} has no score_deduction`);
      assert(typeof c.weight === 'number', `${c.key} has no weight`);
      assert(typeof c.severity === 'string', `${c.key} has no severity`);
    }
    eq(json.scoring.budget, r.budget, 'exported budget:');
    close(json.scoring.deduction, r.totalDeduction, 0.05, 'exported deduction:');
  });

  await it('the JSON export says which frame the interface figures are in', () => {
    const IFACE = { coverPct: 45, coverArea: 5200, minThk: 2, avgThk: 2, totalArea2: 11936 };
    const REG = {
      attempted: true, applied: true, reason: 'registered',
      transform: { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [3, 0, 0] },
      coarse: 'centroid', candidatesTried: 7, engageTol: 0.54,
      offsetMm: 3, rotationDeg: 0, residualBefore: 6.2,
      residualRms: 0.001, residualP95: 0.002, inlierCount: 640,
      coveragePctBefore: 42, coveragePctAfter: 45, samples: 1500,
    };
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowBox([40, 30, 20], 2)) });
    const base = {
      sessionId: 'TEST', dfm: { input: CLEAN_INPUT, result: r }, analysis: null,
      twoShot: runTwoShotDFM({ mat1: 'pcasa', mat2: 'asa_n', interface: IFACE, opticalWindow: 'ir' }),
      interface: IFACE, validation: null,
      settings: { analysisMode: 'twoshot', windowType: 'ir' },
    };

    const moved = buildExportJSON({ ...base, registration: REG });
    eq(moved.two_shot.interface.measured_in, 'registered', 'frame:');
    eq(moved.two_shot.registration.applied, true, 'applied:');
    close(moved.two_shot.registration.interface_gap_as_loaded_mm, 6.2, 0, 'gap as loaded:');
    close(moved.two_shot.registration.offset_applied_mm, 3, 0, 'offset:');
    /* The transform itself, so the pose can be reproduced rather than trusted. */
    eq(moved.two_shot.registration.transform.translation_mm.length, 3, 'translation:');
    eq(moved.two_shot.registration.transform.rotation_row_major.length, 9, 'rotation:');

    const asLoaded = buildExportJSON({ ...base, registration: null });
    eq(asLoaded.two_shot.interface.measured_in, 'as_loaded', 'frame with no registration:');
    eq(asLoaded.two_shot.registration, null, 'registration block:');

    const declined = buildExportJSON({
      ...base,
      registration: { ...REG, applied: false, reason: 'no-improvement', transform: null },
    });
    eq(declined.two_shot.interface.measured_in, 'as_loaded', 'frame when declined:');
    eq(declined.two_shot.registration.offset_applied_mm, null, 'no offset was applied:');
    eq(declined.two_shot.registration.transform, null, 'no transform:');
  });

  await it('two-shot scores through the same mechanism', () => {
    const ts = runTwoShotDFM({ mat1: 'abs', mat2: 'pp', interface: null, opticalWindow: 'none' });
    eq(typeof ts.budget, 'number', 'two-shot has no budget:');
    eq(typeof ts.criticalCount, 'number', 'two-shot has no critical count:');
    eq(ts.score, Math.max(0, Math.round(100 * (1 - ts.totalDeduction / ts.budget))), 'two-shot score:');
    /* ABS and PP do not bond. That is a critical finding, and the grade must
       reflect it rather than whatever the arithmetic happened to leave. */
    const adhesion = ts.checks.find((c) => c.key === 'ts_adhesion');
    eq(adhesion.severity, 'critical');
    assert(ts.grade.label !== 'INTERFACE OK', `ABS+PP graded "${ts.grade.label}"`);
  });

  await it('a check list with no findings scores 100', () => {
    const clean = Object.keys(TWO_SHOT_RISK_PROFILES).map((key) => ({ key, status: 'ok', severity: 'none' }));
    const { score, grade, budget } = scoreChecks(clean, INTERFACE_GRADES, TWO_SHOT_RISK_PROFILES);
    eq(score, 100); eq(budget, 100); eq(grade.label, 'INTERFACE OK');
  });

  await it('substrate softening is an advisory, not a graded verdict', () => {
    /* Melt-versus-HDT was 25 of the interface's 100 points, which condemned
       every fusion pair in the compatibility table — two grades of the same
       polymer necessarily have shot 2's melt far above shot 1's HDT — while
       the adhesion check on the same page called them the strongest bond
       available. The ASA-natural window on a PC/ASA body, the reason those
       grades are in the table at all, came out MAJOR REWORK. HDT is a
       sustained-load deflection property and cannot settle the question, so
       the check now reports and does not score. */
    const pairs = [['pcasa', 'asa_n'], ['asa_n', 'pcasa'], ['asa', 'asa_n'], ['asa', 'asa'],
                   ['abs', 'tpu'], ['pp', 'tpu'], ['pc', 'tpu']];
    for (const [a, b] of pairs) {
      const ts = runTwoShotDFM({ mat1: a, mat2: b, interface: null, opticalWindow: 'none' });
      const thermal = ts.checks.find((c) => c.key === 'ts_thermal');
      eq(thermal.status, 'info', `${a}+${b} thermal status:`);
      eq(thermal.severity, 'none', `${a}+${b} thermal severity:`);
      eq(thermal.scoreDeduction, 0, `${a}+${b} thermal deduction:`);
      eq(thermal.weight, 0, `${a}+${b} thermal weight:`);
    }
  });

  await it('the check and the property it needs are locked to each other', () => {
    /*
     * `ts_thermal` is dark because the material table has no Vicat softening
     * point, and materials.js carries an instruction not to restore a
     * melt-versus-HDT threshold without adding one. This is that instruction
     * made checkable, in both directions, because either half alone is a
     * regression:
     *
     *   Vicat entered, weight still 0 — the data is in the table and the check
     *   is still refusing to judge, which is the work half-done.
     *
     *   weight raised, no Vicat — the threshold is back and the property it
     *   was supposed to rest on never arrived. That is precisely the state
     *   this check was rescued from: it held 25 of the interface's 100 points
     *   and decided the grade from a sustained-load deflection test.
     *
     * Whoever adds the sixteen values will see this fail, which is the point:
     * the failure names the other half of the change.
     */
    const withVicat = MATERIAL_ORDER.filter((k) => MATERIALS[k].vicatC != null);
    const weight = TWO_SHOT_RISK_PROFILES.ts_thermal.weight;
    if (weight > 0) {
      eq(withVicat.length, MATERIAL_ORDER.length,
        `ts_thermal scores at weight ${weight}, so every material needs a Vicat point; missing: ${MATERIAL_ORDER.filter((k) => MATERIALS[k].vicatC == null).join(', ')} —`);
    } else {
      eq(withVicat.length, 0,
        `these materials carry a Vicat point but ts_thermal is still unscored: ${withVicat.join(', ')} —`);
    }
  });

  await it('the fusion pairs that HDT condemned now grade on adhesion', () => {
    for (const [a, b] of [['pcasa', 'asa_n'], ['asa_n', 'pcasa'], ['asa', 'asa_n'], ['asa', 'asa']]) {
      const ts = runTwoShotDFM({ mat1: a, mat2: b, interface: null, opticalWindow: 'none' });
      eq(ts.criticalCount, 0, `${a}+${b} critical findings:`);
      eq(ts.grade.label, 'INTERFACE OK', `${a}+${b} graded on score ${ts.score}:`);
    }
  });


  await it('a genuinely incompatible pair is still condemned', () => {
    /* The counterweight to the test above: relaxing the fusion case must not
       have relaxed the case the rule exists for. */
    const ts = runTwoShotDFM({ mat1: 'abs', mat2: 'pp', interface: null, opticalWindow: 'none' });
    eq(ts.checks.find((c) => c.key === 'ts_adhesion').severity, 'critical', 'ABS+PP adhesion:');
    eq(ts.grade.label, 'NOT COMPATIBLE');
  });

  await it('the textbook overmould pair is left with only its real finding', () => {
    /* ABS with a TPU grip. The adhesion table calls it "Excellent. Classic
       over-mould pair", so with melt-versus-HDT out of the score the only
       deduction left is the one that survives inspection: ABS shrinks ~0.55%
       and TPU ~1.5%, a 0.95% differential, which the shrinkage rule calls a
       minor finding and prescribes balanced cooling for. That is a real
       statement about the pair; the thermal 25 was not. */
    const ts = runTwoShotDFM({ mat1: 'abs', mat2: 'tpu', interface: null, opticalWindow: 'none' });
    eq(ts.criticalCount, 0, 'critical findings on the classic pair:');
    eq(ts.checks.find((c) => c.key === 'ts_adhesion').severity, 'none', 'adhesion:');
    const deducting = ts.checks.filter((c) => c.scoreDeduction > 0).map((c) => c.key);
    eq(deducting.join(','), 'ts_shrinkage', 'checks still deducting:');
    eq(ts.checks.find((c) => c.key === 'ts_shrinkage').severity, 'minor', 'shrinkage:');
    eq(ts.grade.label, 'INTERFACE OK', `score ${ts.score}:`);
  });

  await it('polypropylene is no longer condemned as a substrate on temperature alone', () => {
    /* PP's HDT is 60 °C, so the old 120 °C margin over HDT made any shot 2
       above 180 °C a critical thermal failure — which is every material in the
       table. PP + TPU scored 49, NOT COMPATIBLE, on a pair whose actual
       problem is adhesion, and PP + TPU with a primer is a real product. The
       adhesion check should be the one talking. */
    const ts = runTwoShotDFM({ mat1: 'pp', mat2: 'tpu', interface: null, opticalWindow: 'none' });
    const adhesion = ts.checks.find((c) => c.key === 'ts_adhesion');
    eq(ts.checks.find((c) => c.key === 'ts_thermal').scoreDeduction, 0, 'thermal deduction:');
    assert(adhesion.scoreDeduction > 0, `adhesion should carry the finding, deducted ${adhesion.scoreDeduction}`);
    assert(ts.score > 49, `score should rise above the old thermal-driven 49, got ${ts.score}`);
  });
}


describe('undercuts — an overhang with a known answer');
{
  /* overhangBlock is a 14 mm overhang across a 30 mm extrusion: 420 mm² of
     external undercut, needing one slide that withdraws 14 mm in +X. */
  const EXPECT_AREA = 14 * 30;

  await it('finds one slide region of the right area', () => {
    const m = analyse(weld(S.overhangBlock()));
    const regions = m.undercutRegions.filter((r) => r.area > 1);
    eq(regions.length, 1, 'region count:');
    eq(regions[0].type, 1, 'type (1 = slide):');
    within(regions[0].area, EXPECT_AREA, 1, 'undercut area:');
    within(m.slideArea, EXPECT_AREA, 1, 'total slide area:');
    eq(m.lifterArea, 0, 'lifter area:');
  });

  await it('reports a usable retraction direction and stroke', () => {
    /* The underside of an overhang points straight down the pull axis, so the
       mean normal projected into the parting plane is the zero vector. The
       tool used to report a direction of (0.00, 0.00, 0.00) and a stroke of
       0.0 mm — for the most common undercut there is. */
    const region = analyse(weld(S.overhangBlock())).undercutRegions[0];
    const len = Math.hypot(...region.action);
    close(len, 1, 1e-6, 'the action direction must be a unit vector:');
    close(region.action[0], 1, 1e-6, 'a +X overhang retracts in +X:');
    within(region.stroke, 14, 1, 'stroke must clear the 14 mm overhang:');
  });

  await it('gives the same answer however finely the part is tessellated', () => {
    /* Grid clustering made this depend on the export: the same overhang came
       out as 2, 8, 27 and 7 regions at successive subdivision levels, which
       the rule engine reads as the difference between a minor and a major
       finding. */
    const answers = [0, 1, 2].map((n) => {
      const m = analyse(weld(S.subdivideSoup(S.overhangBlock(), n)));
      const regions = m.undercutRegions.filter((r) => r.area > 1);
      return { tris: m.triCount, count: regions.length, area: m.slideArea, stroke: regions[0].stroke };
    });
    for (const a of answers) {
      eq(a.count, 1, `at ${a.tris} triangles, region count:`);
      within(a.area, EXPECT_AREA, 1, `at ${a.tris} triangles, area:`);
      within(a.stroke, 14, 1, `at ${a.tris} triangles, stroke:`);
    }
  });

  await it('a straight-pull part reports nothing', () => {
    for (const [name, soup] of [
      ['solid box', S.box()],
      ['frustum', S.frustum(20, 30, 3)],
      ['hollow frustum', S.hollowFrustum(20, 30, 3, 2)],
      ['tube', S.tube(20, 2, 40, 64)],
    ]) {
      const m = analyse(weld(soup));
      eq(m.undercutRegions.filter((r) => r.area > 1).length, 0, `${name}:`);
      eq(m.slideArea, 0, `${name} slide area:`);
    }
  });
}

describe('large meshes — the subsampled thickness path');
{
  /* A tube whose wall steps from 2 mm to 6 mm halfway up, so there is real
     sink area for the subsampled pass to find or miss. */
  function steppedTube(seg = 400) {
    const out = [];
    const at = (r, a, z) => [r * Math.cos(a), r * Math.sin(a), z];
    const R = 20, h = 40, hStep = 20;
    const rIn = (z) => (z < hStep ? R - 2.0 : R - 6.0);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      S.quad(out, at(R, a0, 0), at(R, a1, 0), at(R, a1, h), at(R, a0, h));
      for (const [z0, z1] of [[0, hStep], [hStep, h]]) {
        const r = rIn(z0 + 0.001);
        S.quad(out, at(r, a0, z0), at(r, a0, z1), at(r, a1, z1), at(r, a1, z0));
      }
      S.quad(out, at(rIn(0.001), a0, hStep), at(rIn(0.001), a1, hStep), at(rIn(hStep + 1), a1, hStep), at(rIn(hStep + 1), a0, hStep));
      S.quad(out, at(R, a0, 0), at(rIn(0.001), a0, 0), at(rIn(0.001), a1, 0), at(R, a1, 0));
      S.quad(out, at(R, a0, h), at(R, a1, h), at(rIn(h - 1), a1, h), at(rIn(h - 1), a0, h));
    }
    return S.toSoup(out);
  }

  const geom = weld(steppedTube());
  const truth = analyse(geom);

  await it('sink risk survives subsampling', () => {
    /* Sampling in index order aliased against the tessellation: triangles come
       off a tessellator in a repeating per-segment order, and a stride sharing
       a factor with that period samples one role on every segment and never
       the others. The thick band vanished — 8.9% severe sink at full coverage,
       3.3% at stride 3, 0.0% at stride 6. */
    assert(truth.sinkPctSevere > 5, `fixture should have real sink area, got ${truth.sinkPctSevere}`);
    for (const cap of [4000, 2000, 800, 400]) {
      const m = analyse(geom, { thicknessFullCap: cap });
      assert(m.thicknessCoverage < 1, `cap ${cap} did not subsample`);
      within(m.sinkPctSevere, truth.sinkPctSevere, 25, `cap ${cap} severe sink area:`);
      within(m.sinkPctModerate, truth.sinkPctModerate, 25, `cap ${cap} moderate sink area:`);
    }
  });

  await it('reports the coverage it actually achieved', () => {
    for (const cap of [2000, 400]) {
      const m = analyse(geom, { thicknessFullCap: cap });
      const stride = Math.ceil(geom.triCount / cap);
      within(m.thicknessCoverage, 1 / stride, 15, `cap ${cap} reported coverage:`);
    }
    eq(truth.thicknessCoverage, 1, 'full coverage below the cap:');
  });

  await it('wall transitions stand down rather than under-report', () => {
    /* They need both triangles of an edge pair to carry a reading, which a
       partial pass almost never gives — so the check reports nothing found
       instead of quietly finding a fraction of what is there. */
    assert(truth.wallTransitions.length > 0, 'fixture should have transitions at full coverage');
    eq(analyse(geom, { thicknessFullCap: 2000 }).wallTransitions.length, 0);
  });

  await it('subsampling stays reproducible', () => {
    const a = analyse(geom, { thicknessFullCap: 800 });
    const b = analyse(geom, { thicknessFullCap: 800 });
    eq(a.sinkPctSevere, b.sinkPctSevere, 'severe sink across runs:');
    eq(a.thicknessCoverage, b.thicknessCoverage, 'coverage across runs:');
  });
}


describe('projected area — the part\u2019s shadow along the pull axis');
{
  await it('is exact on flat-sided shapes', () => {
    for (const [name, soup, axis, exact] of [
      ['box on +Z', S.box([40, 30, 20]), '+z', 40 * 30],
      ['box on +X', S.box([40, 30, 20]), '+x', 30 * 20],
      ['box on +Y', S.box([40, 30, 20]), '+y', 40 * 20],
      ['frustum on +Z', S.frustum(20, 30, 3), '+z', 40 * 40],
      ['overhang on +Z', S.overhangBlock(), '+z', 44 * 30],
    ]) {
      within(analyse(weld(soup), { pullAxis: axis }).projectedArea, exact, 0.5, `${name}:`);
    }
  });

  await it('excludes a hole running along the pull axis', () => {
    /* A through-hole is formed by a core pin shutting off against the opposite
       half, so no melt bears on it and it must not count towards clamp force.
       Summing ½·Σ|n̂·p̂|·A over the triangles would give the full 1257 mm² disc;
       the answer is the 239 mm² annulus. */
    const m = analyse(weld(S.tube(20, 2, 40, 256)), { pullAxis: '+z' });
    const annulus = Math.PI * (20 * 20 - 18 * 18);
    within(m.projectedArea, annulus, 1, 'tube projected area:');
    assert(m.projectedArea < Math.PI * 400 * 0.25, 'the bore was counted as solid');
  });

  await it('follows the pull direction', () => {
    const soup = S.box([40, 30, 20]);
    const z = analyse(weld(soup), { pullAxis: '+z' }).projectedArea;
    const x = analyse(weld(soup), { pullAxis: '+x' }).projectedArea;
    assert(z > x, `+Z (${z}) should project larger than +X (${x}) on this box`);
    within(analyse(weld(soup), { pullAxis: '-z' }).projectedArea, z, 0.5, 'pull sign must not matter:');
  });
}

describe('moulding estimates');
{
  await it('mass is volume times density', () => {
    for (const key of ['abs', 'pp', 'pc', 'pa66gf']) {
      const material = MATERIALS[key];
      const e = estimateShot({ material, volume: 100000, projectedArea: 4000 });
      within(e.massG, 100 * material.density, 0.01, `${material.name} mass:`);
    }
  });

  await it('clamp force is cavity pressure over projected area', () => {
    const e = estimateShot({ material: MATERIALS.abs, volume: 100000, projectedArea: 40000 });
    const band = CAVITY_PRESSURE_MPA[MATERIALS.abs.flow];
    within(e.clampTonnes.lo, 40000 * band.lo / 9806.65, 0.01, 'lower bound:');
    within(e.clampTonnes.hi, 40000 * band.hi / 9806.65, 0.01, 'upper bound:');
  });

  await it('a stiffer-flowing material needs more clamp for the same part', () => {
    const shape = { volume: 100000, projectedArea: 40000 };
    const pp = estimateShot({ material: MATERIALS.pp, ...shape });
    const pc = estimateShot({ material: MATERIALS.pc, ...shape });
    assert(pc.clampTonnes.hi > pp.clampTonnes.hi,
      `PC (${pc.clampTonnes.hi.toFixed(0)} t) should need more clamp than PP (${pp.clampTonnes.hi.toFixed(0)} t)`);
  });

  await it('machine size is the next standard clamp up, with margin', () => {
    const e = estimateShot({ material: MATERIALS.abs, volume: 180000, projectedArea: 40000 });
    assert(e.machineTonnes >= e.clampTonnes.hi * 1.15,
      `${e.machineTonnes} t does not cover ${e.clampTonnes.hi.toFixed(0)} t plus margin`);
    eq(nextMachineSize(0), 20, 'smallest standard size:');
    eq(nextMachineSize(121), 150);
    eq(nextMachineSize(1e9), null, 'past the largest machine:');
  });

  await it('a runner allowance lands on the shot, not the part', () => {
    const e = estimateShot({ material: MATERIALS.abs, volume: 100000, projectedArea: 4000, runnerPct: 20 });
    within(e.shotMassG, e.massG * 1.2, 0.01, 'shot mass:');
    within(e.massG, 100 * MATERIALS.abs.density, 0.01, 'part mass is unchanged:');
  });

  await it('refuses to invent a mass for a mesh with no enclosed volume', () => {
    /* The validator withholds volume on an open surface; this must not quietly
       substitute a zero or a bounding-box guess. */
    const e = estimateShot({ material: MATERIALS.abs, volume: null, projectedArea: 4000 });
    eq(e.massG, null);
    eq(e.shotMassG, null);
    assert(e.notes.some((n) => n.includes('enclosed volume')), 'no explanation offered');
    assert(e.clampTonnes !== null, 'clamp force does not need a volume and should still be given');
  });

  await it('end to end, on a measured part', () => {
    const geom = weld(S.hollowFrustum(20, 30, 3, 2));
    const m = analyse(geom);
    const v = validateGeometry(geom);
    const e = estimateShot({ material: MATERIALS.abs, volume: v.volume, projectedArea: m.projectedArea });
    within(e.volumeCm3, 13.116, 1, 'volume:');
    within(e.massG, 13.116 * MATERIALS.abs.density, 1, 'mass:');
    assert(e.machineTonnes > 0, 'no machine size');
  });
}


describe('gate placement — searching instead of guessing');
{
  /* A 200 × 20 × 2 bar: gate position genuinely decides whether it fills, and
     the right answer is unarguable — the middle, because flow length from the
     gate to the far end is what sets L/T. */
  function bar(len = 200, wide = 20, thick = 2, n = 100) {
    const out = [];
    const seg = len / n;
    for (let i = 0; i < n; i++) {
      const x0 = i * seg, x1 = (i + 1) * seg;
      S.quad(out, [x0, 0, thick], [x1, 0, thick], [x1, wide, thick], [x0, wide, thick]);
      S.quad(out, [x0, 0, 0], [x0, wide, 0], [x1, wide, 0], [x1, 0, 0]);
      S.quad(out, [x0, 0, 0], [x1, 0, 0], [x1, 0, thick], [x0, 0, thick]);
      S.quad(out, [x0, wide, 0], [x0, wide, thick], [x1, wide, thick], [x1, wide, 0]);
    }
    S.quad(out, [0, 0, 0], [0, 0, thick], [0, wide, thick], [0, wide, 0]);
    S.quad(out, [len, 0, 0], [len, wide, 0], [len, wide, thick], [len, 0, thick]);
    return S.toSoup(out);
  }

  const geom = weld(bar());
  const m = analyse(geom);

  await it('runs when no gate was given, and not when one was', () => {
    assert(m.gateSuggestion, 'no suggestion produced for a part with no gate');
    assert(m.gateSuggestion.best, 'suggestion has no best candidate');
    const withGate = analyse(geom, { gateLocation: [100, 10, 2] });
    eq(withGate.gateSuggestion, null, 'searching is wasted once a gate is set:');
    assert(withGate.flowAnalysis, 'a set gate should produce a flow analysis');
  });

  await it('picks the middle of a bar', () => {
    /* Anywhere in the middle third is a defensible answer; an end is not. */
    const x = m.gateSuggestion.best.point[0];
    assert(x > 66 && x < 134, `best gate at x=${x.toFixed(1)} is not in the middle third of a 0–200 bar`);
  });

  await it('ranks every candidate above the one it beat', () => {
    const c = m.gateSuggestion.candidates;
    assert(c.length >= 8, `only ${c.length} candidates`);
    for (let i = 1; i < c.length; i++) {
      assert(c[i].maxLT >= c[i - 1].maxLT - 1e-9,
        `candidate ${i} (L/T ${c[i].maxLT}) ranked below ${i - 1} (L/T ${c[i - 1].maxLT})`);
    }
    eq(c[0], m.gateSuggestion.best, 'best is not the first candidate');
  });

  await it('shows that the choice matters', () => {
    const { best, worst } = m.gateSuggestion;
    assert(worst.maxLT / best.maxLT > 1.5,
      `on a 200 mm bar the gate should matter a lot; got only ${(worst.maxLT / best.maxLT).toFixed(2)}×`);
  });

  await it('agrees with the flow solver it will hand over to', () => {
    /* The suggestion is only useful if actually placing the gate there
       reproduces the L/T the search promised. */
    const promised = m.gateSuggestion.best;
    const actual = analyse(geom, { gateLocation: promised.point }).flowAnalysis;
    within(actual.maxLT, promised.maxLT, 0.1, 'L/T at the suggested gate:');
    within(actual.maxFlow, promised.maxFlow, 0.1, 'flow length at the suggested gate:');
  });

  await it('only offers positions a sprue could reach', () => {
    /* Candidates come from outward-facing triangles: the inside of a cavity is
       not somewhere a gate can go. */
    const shell = weld(S.hollowFrustum(20, 30, 3, 2));
    const sm = analyse(shell);
    assert(sm.gateSuggestion, 'no suggestion for the shell');
    for (const c of sm.gateSuggestion.candidates) {
      eq(sm.triFaceSide[c.triangle], 0, `candidate on triangle ${c.triangle} is an inner face:`);
    }
  });

  await it('is reproducible', () => {
    const a = analyse(geom).gateSuggestion.best;
    const b = analyse(geom).gateSuggestion.best;
    eq(a.triangle, b.triangle, 'chosen triangle across runs:');
    eq(a.maxLT, b.maxLT, 'L/T across runs:');
  });

  await it('reuses one adjacency graph across candidates', () => {
    /* Rebuilding the graph per candidate would dominate the cost, so the graph
       is passed in. Verified by checking that a prebuilt graph gives the same
       answer as letting each call build its own. */
    const graph = buildAdjacency(geom.indices, geom.triCount, geom.vertCount);
    const shared = searchGateCandidates({
      geom, triCentroid: m.triCentroid, triThickness: m.triThickness, triAreas: m.triAreas,
      triFaceSide: m.triFaceSide, triCount: m.triCount, ltMax: 180, adjacency: graph,
    });
    const own = searchGateCandidates({
      geom, triCentroid: m.triCentroid, triThickness: m.triThickness, triAreas: m.triAreas,
      triFaceSide: m.triFaceSide, triCount: m.triCount, ltMax: 180,
    });
    eq(shared.best.triangle, own.best.triangle);
    within(shared.best.maxLT, own.best.maxLT, 0.001, 'L/T:');
  });

  await it('geodesic distance is zero at the source and rises away from it', () => {
    const graph = buildAdjacency(geom.indices, geom.triCount, geom.vertCount);
    const dist = geodesicFrom(geom.vertices, geom.vertCount, graph, 0);
    eq(dist[0], 0, 'distance to the source:');
    let reached = 0, maxD = 0;
    for (let v = 0; v < geom.vertCount; v++) {
      if (Number.isFinite(dist[v])) { reached++; maxD = Math.max(maxD, dist[v]); }
    }
    eq(reached, geom.vertCount, 'a closed mesh must be fully reachable:');
    assert(maxD > 100, `a 200 mm bar should have paths over 100 mm, got ${maxD.toFixed(1)}`);
  });
}


describe('pull direction — the suggestion must agree with the report');
{
  const AXES = {
    '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0],
    '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1],
  };

  /* Undercut area the full analysis reports for a given axis. */
  const reportedUndercut = (geom, axis) => {
    const m = analyse(geom, { pullDir: AXES[axis], pullAxis: axis.toLowerCase(), suggestGate: false });
    return m.slideArea + m.lifterArea;
  };

  await it('never recommends an axis the report finds undercuts on', () => {
    /* The regression. On the overhang block the old heuristic recommended +Z as
       having "0.0% undercut area (lowest)" — and +Z is the one axis with
       420 mm² of undercut, while four others have none. It scored axes with its
       own sidewall-lean test rather than the classifier the report uses. */
    const geom = weld(S.overhangBlock());
    const clean = Object.keys(AXES).filter((a) => reportedUndercut(geom, a) === 0);
    assert(clean.length > 0, 'fixture should have at least one undercut-free axis');
    const suggested = suggestPullDirection(geom, { minDraft: 1 }).name;
    assert(clean.includes(suggested),
      `suggested ${suggested}, which reports ${reportedUndercut(geom, suggested).toFixed(0)} mm² of undercut; clean axes are ${clean.join(', ')}`);
  });

  await it('reports the same undercut area the analysis would', () => {
    const geom = weld(S.overhangBlock());
    for (const entry of suggestPullDirection(geom, { minDraft: 1 }).ranked) {
      within(entry.undercutArea, reportedUndercut(geom, entry.name), 1,
        `${entry.name}: suggestion vs analysis`);
    }
  });

  await it('breaks ties on draft rather than arbitrarily', () => {
    /* Every axis on a drafted frustum is undercut-free, so the tie-break
       decides — and the only axis the part is actually drafted for is +Z. */
    const geom = weld(S.frustum(20, 30, 3));
    const s = suggestPullDirection(geom, { minDraft: 1 });
    eq(s.name, '+Z', `reason given: ${s.reason}`);
    eq(s.ranked[0].draftUnderMinPct, 0, 'the winning axis should have no under-draft area:');
  });

  await it('ranks worst-first-last', () => {
    const ranked = suggestPullDirection(weld(S.overhangBlock()), { minDraft: 1 }).ranked;
    eq(ranked.length, 6, 'all six axes considered:');
    for (let i = 1; i < ranked.length; i++) {
      assert(ranked[i].undercutArea >= ranked[i - 1].undercutArea - 1e-6,
        `${ranked[i].name} ranked after ${ranked[i - 1].name} despite less undercut`);
    }
  });

  await it('honours the mould type it is given', () => {
    /* A single-pull tool cannot let a leaning sidewall belong to the other
       half, so it must find at least as much undercut as a two-piece one. */
    const geom = weld(S.frustum(20, 30, 3));
    const two = suggestPullDirection(geom, { minDraft: 1, moldType: 'two-piece' });
    const one = suggestPullDirection(geom, { minDraft: 1, moldType: 'single-pull' });
    const total = (s) => s.ranked.reduce((sum, r) => sum + r.undercutArea, 0);
    assert(total(one) >= total(two) - 1e-6,
      `single-pull (${total(one).toFixed(0)} mm²) should find at least as much as two-piece (${total(two).toFixed(0)} mm²)`);
  });
}


describe('revision comparison');
{
  /* Two real runs of the same shell, one without draft and one with. Exported
     through the same path the app uses, so the diff is tested against the
     records it will actually be handed. */
  const record = (soup, opts = {}) => {
    const geom = weld(soup);
    const mesh = analyse(geom, { finishKey: 'spi-a2', suggestGate: false });
    const result = runDFM({ ...CLEAN_INPUT, ...opts, mesh });
    return buildExportJSON({
      sessionId: 'TEST', dfm: { input: { ...CLEAN_INPUT, ...opts }, result },
      analysis: mesh, twoShot: null, interface: null,
      validation: validateGeometry(geom), shot: null,
      settings: { analysisMode: 'single', windowType: 'none' },
    });
  };

  const undrafted = record(S.hollowBox([40, 30, 20], 2), { draftAngle: 0.2 });
  const drafted = record(S.hollowFrustum(20, 30, 3, 2));

  await it('reports the score movement and the grade change', () => {
    const d = compareRuns(undrafted, drafted);
    assert(d, 'no diff produced');
    eq(d.score.before, undrafted.score, 'before:');
    eq(d.score.after, drafted.score, 'after:');
    eq(d.score.delta, drafted.score - undrafted.score, 'delta:');
    assert(d.score.delta > 0, `fixing draft should raise the score, got ${d.score.delta}`);
    eq(d.grade.changed, undrafted.grade !== drafted.grade);
  });

  await it('names the check that was resolved', () => {
    const d = compareRuns(undrafted, drafted);
    const draft = d.checks.find((c) => c.key === 'draft');
    eq(draft.change, 'improved', `draft went ${draft.severityBefore} → ${draft.severityAfter}:`);
    eq(draft.resolved, true, 'draft should read as resolved:');
    assert(/Resolved:.*Draft/i.test(d.headline), `headline does not mention it: "${d.headline}"`);
  });

  await it('reads the reverse comparison as a regression', () => {
    const d = compareRuns(drafted, undrafted);
    assert(d.score.delta < 0, 'score should fall');
    const draft = d.checks.find((c) => c.key === 'draft');
    eq(draft.change, 'worsened');
    eq(draft.appeared, true, 'draft should read as newly appeared:');
    assert(/New:.*Draft/i.test(d.headline), `headline: "${d.headline}"`);
  });

  await it('says nothing moved when nothing did', () => {
    const d = compareRuns(drafted, drafted);
    eq(d.score.delta, 0);
    eq(d.checks.every((c) => c.change === 'unchanged'), true,
      d.checks.filter((c) => c.change !== 'unchanged').map((c) => `${c.key}:${c.change}`).join(', '));
    assert(/No check changed band/.test(d.headline), d.headline);
  });

  await it('tracks measurements that moved, with the right sense of better', () => {
    const d = compareRuns(undrafted, drafted);
    const draftArea = d.measurements.find((m) => m.label === 'Sidewall under draft');
    assert(draftArea, 'sidewall draft area not tracked');
    assert(draftArea.after < draftArea.before, 'under-draft area should fall');
    eq(draftArea.direction, 'better', 'less under-draft area is an improvement:');
  });

  await it('warns when the comparison is not like for like', () => {
    /* A five-point gain from switching material is not a five-point gain in
       the part, and the panel has to say so. */
    const inAbs = record(S.hollowFrustum(20, 30, 3, 2));
    const inPp = record(S.hollowFrustum(20, 30, 3, 2), { material: 'pp' });
    const d = compareRuns(inAbs, inPp);
    assert(d.caveats.some((c) => /Material changed/.test(c)), `caveats: ${d.caveats.join(' | ')}`);
  });

  await it('says when the rules may have moved between the two runs', () => {
    /*
     * The caveat the comparison could not carry until exports named their
     * build. Three states, and each is its own sentence: a version change, a
     * source change at the same version — the normal state between releases,
     * and exactly when thresholds move most — and a record from before builds
     * were named at all, which is a gap rather than a match.
     */
    const stamp = (rec, build) => ({ ...rec, build });
    const here = buildIdentity();

    const olderVersion = compareRuns(
      stamp(drafted, { ...here, tool_version: '1.9.0', source_fingerprint: 'aaaaaaaaaaaa' }),
      stamp(drafted, here));
    assert(olderVersion.caveats.some((c) => /tool changed between these runs: 1\.9\.0/.test(c)),
      `caveats: ${olderVersion.caveats.join(' | ')}`);

    const sameVersion = compareRuns(
      stamp(drafted, { ...here, tool_version: '2.0.0', source_fingerprint: 'aaaaaaaaaaaa' }),
      stamp(drafted, { ...here, tool_version: '2.0.0', source_fingerprint: 'bbbbbbbbbbbb' }));
    assert(sameVersion.caveats.some((c) => /different sources/.test(c)),
      `caveats: ${sameVersion.caveats.join(' | ')}`);

    /* An export from before builds were named. `drafted` carries one now, so
       the old shape has to be reconstructed rather than assumed. */
    const { build: _dropped, ...unstamped } = drafted;
    const unnamed = compareRuns(unstamped, stamp(drafted, here));
    assert(unnamed.caveats.some((c) => /does not name the build/.test(c)),
      `caveats: ${unnamed.caveats.join(' | ')}`);

    /* And silence when the two agree — a caveat on every comparison is a
       caveat nobody reads. */
    const same = compareRuns(stamp(drafted, here), stamp(drafted, here));
    assert(!same.caveats.some((c) => /build|tool changed|different sources/i.test(c)),
      `an identical build should raise no build caveat: ${same.caveats.join(' | ')}`);
  });

  await it('notices when the same geometry is compared with itself', () => {
    const d = compareRuns(drafted, drafted);
    assert(d.caveats.some((c) => /same geometry twice/.test(c)), `caveats: ${d.caveats.join(' | ')}`);
  });

  await it('survives an older record with fields missing', () => {
    /* Comparisons are made against files from weeks ago. A missing field is
       reported as unavailable, never assumed to be zero. */
    const old = {
      score: 70, grade: 'MINOR REWORK', material: 'ABS',
      checks: [{ key: 'draft', name: 'Draft angles', severity: 'major', score_deduction: 9 }],
    };
    const d = compareRuns(old, drafted);
    assert(d, 'no diff produced for a sparse record');
    eq(d.score.delta, drafted.score - 70);
    for (const m of d.measurements) {
      if (m.before === null) eq(m.delta, null, `${m.label} delta must be null when a side is missing:`);
    }
    const added = d.checks.filter((c) => c.change === 'added');
    assert(added.length > 0, 'checks absent from the old record should read as added');
  });

  await it('refuses to invent a comparison from nothing', () => {
    eq(compareRuns(null, drafted), null);
    eq(compareRuns(drafted, null), null);
  });
}


describe('undercuts — slide or lifter');
{
  const P = Math.PI;
  /* internalLedgeCup: rOuter 20, wall 2 so rInner 18, ledge 2 mm deep so
     rLedge 16, cavity ceiling at z 18. */
  const LEDGE_AREA = P * (18 * 18 - 16 * 16);   // 214 mm²
  const CEILING_AREA = P * 18 * 18;             // 1018 mm²

  const cup = weld(S.internalLedgeCup());
  const cupMesh = analyse(cup, { suggestGate: false });

  await it('an enclosed internal feature needs a lifter, not a slide', () => {
    /* The regression. The ledge underside points down into the open cavity, so
       a ray along its own normal escapes through the mouth and it was reported
       as needing a slide — which cannot reach it: revolving the cup walls it in
       from every direction. */
    eq(cupMesh.slideArea, 0, 'slide area on a part nothing can reach sideways:');
    assert(cupMesh.lifterArea > 0, 'no lifter area reported');
    const regions = cupMesh.undercutRegions.filter((r) => r.area > 1);
    eq(regions.length, 2, `regions found: ${regions.map((r) => r.area.toFixed(0)).join(', ')}`);
    for (const r of regions) eq(r.type, 2, `region at z=${r.centroid[2].toFixed(1)} should be a lifter:`);
  });

  await it('measures the enclosed features it finds', () => {
    const areas = cupMesh.undercutRegions.filter((r) => r.area > 1).map((r) => r.area).sort((a, b) => a - b);
    within(areas[0], LEDGE_AREA, 2, 'ledge underside area:');
    within(areas[1], CEILING_AREA, 2, 'cavity ceiling area:');
  });

  await it('lifters are reportable in a two-piece mould at all', () => {
    /* They were not. Every candidate face in a two-piece tool points against
       the pull, and the branch that could yield a lifter required a face that
       did not — so the type was unreachable, while the rule engine had a whole
       critical-severity branch for it and the tooling panel rendered cards that
       could never appear. */
    const twoPiece = analyse(cup, { moldType: 'two-piece', suggestGate: false });
    assert(twoPiece.lifterArea > 0, 'still no lifter in two-piece mode');
  });

  await it('describes a lifter that could be built', () => {
    const lifter = cupMesh.undercutRegions.find((r) => r.type === 2 && r.area > 1);
    assert(lifter.lifterAngleDeg > 0 && lifter.lifterAngleDeg <= 15,
      `lifter angle ${lifter.lifterAngleDeg.toFixed(1)}° is outside the slim-lifter limit`);
    assert(lifter.pullTravel > 0, 'lifter has no travel');
    close(Math.hypot(...lifter.action), 1, 1e-6, 'action must be a unit vector:');
  });

  await it('an external feature is still a slide', () => {
    /* The counterweight: reclassifying enclosed features must not reclassify
       reachable ones. A barb on an outer wall has clear paths in. */
    const m = analyse(weld(S.overhangBlock()), { suggestGate: false });
    eq(m.lifterArea, 0, 'lifter area on a purely external undercut:');
    within(m.slideArea, 14 * 30, 1, 'slide area:');
    eq(m.undercutRegions.filter((r) => r.area > 1)[0].type, 1);
  });

  await it('the rule engine treats a lifter as the more serious finding', () => {
    const lifterInput = { ...CLEAN_INPUT, mesh: cupMesh };
    const slideInput = { ...CLEAN_INPUT, mesh: analyse(weld(S.overhangBlock()), { suggestGate: false }) };
    const lifterCheck = runDFM(lifterInput).checks.find((c) => c.key === 'undercut');
    const slideCheck = runDFM(slideInput).checks.find((c) => c.key === 'undercut');
    eq(lifterCheck.severity, 'critical', 'lifter severity:');
    assert(slideCheck.severity !== 'critical', `slide severity should be lighter, got ${slideCheck.severity}`);
    assert(/lifter/i.test(lifterCheck.detail), `detail does not mention a lifter: ${lifterCheck.detail.slice(0, 120)}`);
  });
}


describe('wall thickness — which measure the verdict rests on');
{
  const wallCheck = (mesh, extra = {}) =>
    runDFM({ ...CLEAN_INPUT, ...extra, mesh }).checks.find((c) => c.key === 'wall');
  const metric = (check, label) => {
    const row = check.metrics.find(([k]) => k === label);
    return row ? row[1] : null;
  };

  await it('judges the part on the inscribed sphere, not the ray cast', () => {
    /* The ray reads the distance straight through to the far surface, which
       overstates any wall whose opposite face is not parallel — the optimistic
       direction, and the one that lets a section which will sink read as
       comfortably in band. On this wedge the two differ by a third. */
    const mesh = analyse(weld(S.wedgeSlab(60, 30, 6, 45)), { suggestGate: false });
    assert(mesh.wallMethod.sphereMedian < mesh.wallMethod.rayMedian * 0.8,
      'fixture should make the two measures disagree substantially');
    const check = wallCheck(mesh);
    eq(metric(check, 'Measured as'), 'inscribed sphere');
    within(parseFloat(metric(check, 'Nominal (median)')), mesh.wallMethod.sphereMedian, 1,
      'the nominal it judged on:');
  });

  await it('reports both measures so the gap is visible', () => {
    const mesh = analyse(weld(S.wedgeSlab(60, 30, 6, 45)), { suggestGate: false });
    const check = wallCheck(mesh);
    assert(metric(check, 'Sphere / ray'), 'no side-by-side metric');
    assert(/disagree by \d+%/.test(check.detail),
      `detail should call out the disagreement: ${check.detail.slice(0, 200)}`);
  });

  await it('says nothing about a disagreement when there is none', () => {
    const mesh = analyse(weld(S.tube(20, 2, 40, 128)), { suggestGate: false });
    close(mesh.wallMethod.ratio, 1, 0.005, 'parallel walls should agree exactly:');
    assert(!/disagree by/.test(wallCheck(mesh).detail), 'spurious disagreement note');
  });

  await it('falls back to the ray figure when the sphere pass did not run', () => {
    const mesh = analyse(weld(S.tube(20, 2, 40, 128)), { suggestGate: false });
    const stripped = { ...mesh, sphereStats: null };
    eq(metric(wallCheck(stripped), 'Measured as'), 'ray cast');
    within(parseFloat(metric(wallCheck(stripped), 'Nominal (median)')), mesh.wallStats.median, 1,
      'fallback nominal:');
  });

  await it('still measures a uniform wall correctly either way', () => {
    /* Switching basis must not move the answer on a part where the two agree,
       which is most parts. */
    for (const [name, soup, truth] of [
      ['hollow box 2 mm', S.hollowBox([40, 30, 20], 2), 2],
      ['tube 1.5 mm', S.tube(20, 1.5, 40, 128), 1.5],
    ]) {
      const mesh = analyse(weld(soup), { suggestGate: false });
      within(parseFloat(metric(wallCheck(mesh), 'Nominal (median)')), truth, 1, `${name}:`);
    }
  });

  await it('leaves the sink check measuring ray against ray', () => {
    /* Sink asks how much mass sits behind a surface relative to nominal. Holding
       a ray-derived local thickness against a sphere-derived nominal would make
       every part look like it was about to sink. */
    const mesh = analyse(weld(S.wedgeSlab(60, 30, 6, 45)), { suggestGate: false });
    within(mesh.nominalWall, mesh.wallStats.median, 1,
      'the nominal the sink check uses must stay on the ray figure:');
  });
}


describe('bosses — the outer diameter, and what it fights with');
{
  const BOSS = {
    ...CLEAN_INPUT,
    wallThk: 2.0, ribThk: 0.9, ribH: 2.0, ribRadius: 0.5, mesh: null,
  };
  const ribs = (over) => runDFM({ ...BOSS, ...over }).checks.find((c) => c.key === 'ribs');
  const window = (check) => check.metrics.find(([k]) => k === 'Boss wall window')[1];

  await it('bossOD is finally read by something', () => {
    /* It had been collected, persisted and printed on the report since the
       rebuild without any rule looking at it. */
    const narrow = ribs({ bossOD: 4.0, bossWall: 1.0 });
    const wide = ribs({ bossOD: 6.0, bossWall: 1.0 });
    assert(window(narrow) !== window(wide), 'changing bossOD changed nothing');
  });

  await it('accepts a boss wall inside both guidelines', () => {
    /* Ø4 with a 1 mm wall on a 2 mm part: screw retention wants ≥1.00 mm, the
       sink limit caps at 1.40 mm, so 1.00 sits in the window. */
    const check = ribs({ bossOD: 4.0, bossWall: 1.0 });
    eq(window(check), '1.00–1.40 mm');
    assert(!/cannot satisfy both/.test(check.detail), 'spurious conflict reported');
    assert(!/split around/.test(check.detail), 'spurious retention warning');
  });

  await it('flags a boss wall too thin for its own hole', () => {
    const check = ribs({ bossOD: 4.0, bossWall: 0.8 });
    assert(/under the 1.00 mm/.test(check.detail), check.detail.slice(0, 200));
    /* And says there is room to fix it, which there is. */
    assert(/sink limit here is 1.40/.test(check.detail), 'no headroom stated');
    eq(check.severity, 'major');
  });

  await it('names the bind when the two guidelines cannot both be met', () => {
    /* bossOD > 2.8 × wall makes the window empty: retention wants more boss
       wall than the sink limit allows, and no boss wall value satisfies both. */
    const check = ribs({ bossOD: 6.0, bossWall: 1.0 });
    assert(/cannot satisfy both/.test(check.detail), check.detail.slice(0, 220));
    eq(window(check), 'none — screw wants ≥1.50, sink caps at 1.40 mm');
    /* The resolutions are geometric, not a different boss wall. */
    assert(/gusset|support rib|core the boss/i.test(check.detail), 'no resolution offered');
  });

  await it('reports the bind whatever the boss wall is set to', () => {
    /* The conflict is a property of the boss diameter against the part wall.
       Thickening the boss cannot resolve it, so the finding must not disappear
       when someone tries. */
    for (const bossWall of [0.8, 1.0, 1.4, 1.5, 2.0]) {
      assert(/cannot satisfy both/.test(ribs({ bossOD: 6.0, bossWall }).detail),
        `conflict vanished at bossWall ${bossWall}`);
    }
  });

  await it('the bind goes away on a thicker wall', () => {
    /* Ø6 needs 1.50 mm; a 3 mm part wall caps at 2.10 mm, so there is a window. */
    const check = ribs({ bossOD: 6.0, bossWall: 1.5, wallThk: 3.0, ribThk: 1.35, ribH: 3.0 });
    eq(window(check), '1.50–2.10 mm');
    assert(!/cannot satisfy both/.test(check.detail), check.detail.slice(0, 200));
  });

  await it('does not apply the screw guideline to a solid post', () => {
    const check = ribs({ bossOD: 2.0, bossWall: 1.0 });
    assert(/solid post/.test(check.detail), check.detail.slice(0, 160));
    eq(window(check), '—');
  });

  await it('the shipped defaults satisfy their own guidelines', () => {
    /* The out-of-box configuration should not be reporting a design bind. */
    const d = DEFAULT_SETTINGS;
    const screwMin = d.bossOD / 4;
    const sinkMax = 0.7 * d.wallThk;
    assert(screwMin <= sinkMax, `defaults leave no boss window: need ≥${screwMin}, capped at ${sinkMax}`);
    assert(d.bossWall >= screwMin && d.bossWall <= sinkMax,
      `default bossWall ${d.bossWall} is outside ${screwMin}–${sinkMax}`);
  });
}

describe('a check that costs points cannot look like a pass');
{
  await it('status is raised to warn wherever a deduction exists', () => {
    /* Several rules escalate severity for a secondary finding without touching
       the status, which showed a green tick beside a deduction. */
    const list = [{ key: 'ribs', status: 'ok', severity: 'minor' }];
    scoreChecks(list, PART_GRADES);
    eq(list[0].status, 'warn');
    assert(list[0].scoreDeduction > 0, 'no deduction to justify the warn');
  });

  await it('leaves a genuine pass alone', () => {
    const list = [{ key: 'ribs', status: 'ok', severity: 'none' }];
    scoreChecks(list, PART_GRADES);
    eq(list[0].status, 'ok');
    eq(list[0].scoreDeduction, 0);
  });

  await it('leaves an advisory as an advisory', () => {
    const list = [{ key: 'corners', status: 'info', severity: 'none' }];
    scoreChecks(list, PART_GRADES);
    eq(list[0].status, 'info');
  });

  await it('holds across every check the engine can emit', () => {
    const meshes = [
      analysedFixture('hollow-frustum', () => S.hollowFrustum(20, 30, 3, 2)),
      SHELL_BOX(),
      LEDGE_CUP(),
    ];
    for (const mesh of meshes) {
      for (const c of runDFM({ ...CLEAN_INPUT, mesh }).checks) {
        if (c.scoreDeduction > 0) {
          assert(c.status === 'warn' || c.status === 'fail',
            `${c.key} deducts ${c.scoreDeduction} but reports status "${c.status}"`);
        }
      }
    }
  });
}


// ═══════════════════════════════════════════════════════════════════════════

describe('closest point on a mesh');
{
  /* The primitive registration is built on, so it gets a reference of its own
     rather than being trusted because the thing above it converged. */
  const geom = weld(S.subdivideSoup(S.box([40, 30, 20]), 1));
  const bvh = buildBVH(geom);
  const out = new Float64Array(4);

  const probes = [
    ['outside a face', [20, 15, 30]],
    ['outside a corner', [-7, -7, -7]],
    ['outside an edge', [50, 15, -6]],
    ['inside the solid', [20, 15, 10]],
    ['on the surface', [20, 15, 20]],
    ['far away, off-axis', [-40, 70, 55]],
  ];

  for (const [name, [px, py, pz]] of probes) {
    await it(`${name}: matches a brute-force sweep of every triangle`, () => {
      const got = closestPoint(bvh, geom, px, py, pz, Infinity, out);
      const want = R.referenceClosestPoint(geom, px, py, pz);
      /* The reference samples a barycentric grid, so it can only over-report.
         The shipped answer must not exceed it, and must not fall far below. */
      assert(got <= want + 1e-9, `found ${got}, reference floor ${want}`);
      close(got, want, Math.max(0.05, want * 0.02), `${name}:`);
    });
  }

  await it('the returned point lies on the surface, at the returned distance', () => {
    const got = closestPoint(bvh, geom, -7, 40, 26, Infinity, out);
    close(Math.hypot(out[0] + 7, out[1] - 40, out[2] - 26), got, 1e-9, 'point vs distance:');
    assert(out[3] >= 0 && out[3] < geom.triCount, `triangle index ${out[3]} out of range`);
  });

  /*
   * A lone triangle, so each of the seven regions of the point–triangle test
   * is the only thing that can produce the answer. On a closed mesh they are
   * not: a probe outside a box edge is in some triangle's edge region and some
   * other triangle's vertex region, so a broken branch is covered for by a
   * neighbour and the box probes above pass with it broken.
   */
  {
    const lone = weld(S.toSoup([0, 0, 0, 10, 0, 0, 0, 8, 0]));
    const loneBvh = buildBVH(lone);
    for (const [region, [px, py, pz]] of [
      ['vertex A', [-4, -3, 2]],
      ['vertex B', [16, -3, -2]],
      ['vertex C', [-3, 14, 1]],
      ['edge AB', [5, -6, 3]],
      ['edge AC', [-6, 4, -3]],
      ['edge BC', [9, 8, 2]],
      ['the face interior', [3, 2, 5]],
    ]) {
      await it(`lone triangle, ${region} region: matches the definition`, () => {
        const got = closestPoint(loneBvh, lone, px, py, pz, Infinity, out);
        const want = R.referenceClosestPoint(lone, px, py, pz, 200);
        assert(got <= want + 1e-9, `found ${got}, reference floor ${want}`);
        close(got, want, 0.01, `${region}:`);
      });
    }
  }

  await it('respects the search cap, and reports Infinity beyond it', () => {
    /* 30 mm off the +z face: inside a 31 mm cap, outside a 29 mm one. */
    assert(Number.isFinite(closestPoint(bvh, geom, 20, 15, 50, 31, out)), 'should find within 31 mm');
    eq(closestPoint(bvh, geom, 20, 15, 50, 29, out), Infinity, 'should not find within 29 mm:');
  });
}

describe('rigid fit — Horn quaternion');
{
  /* Proves the convention, which is the part of Horn's method that is easy to
     get transposed: a transposed correlation matrix yields the inverse
     rotation, which converges just as prettily onto the wrong pose. */
  const src = [];
  const seed = makeRandom(7);
  for (let i = 0; i < 40; i++) src.push(seed() * 60 - 30, seed() * 40 - 20, seed() * 20 - 10);

  for (const [name, axis, deg, t] of [
    ['pure translation', [0, 0, 1], 0, [12, -5, 3]],
    ['90° about z', [0, 0, 1], 90, [0, 0, 0]],
    ['25° about (1,2,3), translated', [1, 2, 3], 25, [15, -9, 7]],
    ['179° about y', [0, 1, 0], 179, [-4, 4, -4]],
  ]) {
    await it(`recovers ${name}`, () => {
      const truth = S.transformSoup({ positions: new Float32Array(src), triCount: 0 },
        { axis, deg, translate: t }).xform;
      const p = new Float64Array(src);
      const q = new Float64Array(src.length);
      const tmp = [0, 0, 0];
      for (let i = 0; i < src.length; i += 3) {
        xformPoint(p[i], p[i + 1], p[i + 2], truth, tmp);
        q[i] = tmp[0]; q[i + 1] = tmp[1]; q[i + 2] = tmp[2];
      }
      const idx = Uint32Array.from({ length: src.length / 3 }, (_, i) => i);
      const fit = fitRigid(p, q, idx, idx.length);

      /* Compare by what the transform does, not by its nine numbers: any two
         that move every point to the same place are the same transform. */
      for (let i = 0; i < src.length; i += 3) {
        xformPoint(p[i], p[i + 1], p[i + 2], fit, tmp);
        close(Math.hypot(tmp[0] - q[i], tmp[1] - q[i + 1], tmp[2] - q[i + 2]), 0, 1e-6, 'point:');
      }
      close(rotationDegOf(fit), deg, 1e-4, 'rotation angle:');
    });
  }

  await it('declines a fit with fewer than three correspondences', () => {
    eq(fitRigid(new Float64Array(6), new Float64Array(6), Uint32Array.from([0, 1]), 2), null,
      'two points cannot fix a rotation:');
  });
}

describe('jacobiEigen at 4×4');
{
  /* Registration needs the 4×4 case, which the 3×3 cylinder fit never
     exercised. Checked against the definition — A·v = λv — rather than
     against a table of eigenvalues copied from somewhere. */
  await it('every eigenpair satisfies A·v = λv, and they come out ascending', () => {
    const a = [
      [4, 1, -2, 0.5],
      [1, 3, 0.25, -1],
      [-2, 0.25, 6, 2],
      [0.5, -1, 2, -1],
    ];
    const eig = jacobiEigen(a);
    eq(eig.length, 4, 'eigenpair count:');
    for (let k = 1; k < 4; k++) {
      assert(eig[k].value >= eig[k - 1].value, 'eigenvalues must ascend');
    }
    for (const { value, vector } of eig) {
      close(Math.hypot(...vector), 1, 1e-9, 'eigenvector should be unit:');
      for (let i = 0; i < 4; i++) {
        let av = 0;
        for (let j = 0; j < 4; j++) av += a[i][j] * vector[j];
        close(av, value * vector[i], 1e-8, 'A·v vs λv:');
      }
    }
  });
}

describe('two-shot registration');
{
  /*
   * The fixture is a box and a shell whose cavity is exactly that box, so
   * every answer is closed-form: overmould thickness is the shell wall
   * everywhere, and the mating surface is the cavity.
   *
   * Subdivided because registration fits a pose: twenty-four face centres on
   * a shelled box are both too few points and the most symmetric points the
   * shape has.
   */
  const WALL = 2;
  const SUB = 3;
  const substrate = weld(S.subdivideSoup(S.box([40, 30, 20]), SUB));
  const bvh1 = buildBVH(substrate);
  const shellSoup = S.subdivideSoup(S.shellAround([0, 0, 0], [40, 30, 20], WALL), SUB);

  const shot1 = analyse(substrate, { suggestGate: false });
  const MAX_DIST = 20;

  /* One place where the pair is measured, so a test can say "the same
     interface figures" and mean it. */
  function measure(soup2, { register = true } = {}) {
    const geom2 = weld(soup2);
    const shot2 = analyse(geom2, { material: MATERIALS.tpu, suggestGate: false });
    const reg = register
      ? registerShots({ geom1: substrate, bvh1, shot1, geom2, shot2, maxDist: MAX_DIST })
      : null;
    const iface = analyseInterface(substrate, bvh1, shot2, MAX_DIST,
      reg && reg.applied ? reg.transform : null);
    return { reg, iface, geom2 };
  }

  const MISALIGN = { axis: [1, 2, 3], deg: 25, translate: [15, -9, 7] };
  const aligned = measure(shellSoup);
  const movedSoup = S.transformSoup(shellSoup, MISALIGN);
  const asLoaded = measure(movedSoup, { register: false });
  const registered = measure(movedSoup);

  await it('a pair that arrives mated is left alone', () => {
    eq(aligned.reg.applied, false, 'nothing to correct:');
    eq(aligned.reg.reason, 'already-mated', 'reason:');
    eq(aligned.reg.transform, null, 'no transform:');
    close(aligned.reg.residualBefore, 0, 1e-3, 'residual at the interface:');
    close(aligned.iface.minThk, WALL, 0.01, 'min overmould thickness:');
    close(aligned.iface.avgThk, WALL, 0.01, 'avg overmould thickness:');
  });

  await it('the mating surface is found by direction, not by keeping the closest few', () => {
    /*
     * Why the normal filter is there, in numbers. The shell's cavity is 5200
     * mm² of its 11936 mm² — 43.6% — so any trim above that has to include
     * outer-surface points sitting a full wall away, and the residual of a
     * perfectly mated pair comes out around a millimetre. The test above
     * would fail on that alone; this one records the figure so the reason
     * cannot be lost.
     */
    assert(REGISTER_TRIM > 0.436,
      'the trim is above the fixture mating fraction, which is the whole point');
    const out = new Float64Array(4);
    const dists = [];
    const { triCount, triAreas, triCentroid } = analyse(weld(shellSoup), { suggestGate: false });
    for (let t = 0; t < triCount; t++) {
      if (!(triAreas[t] > 0)) continue;
      dists.push(closestPoint(bvh1, substrate,
        triCentroid[t * 3], triCentroid[t * 3 + 1], triCentroid[t * 3 + 2], Infinity, out));
    }
    dists.sort((a, b) => a - b);
    const keep = Math.round(dists.length * REGISTER_TRIM);
    let sumSq = 0;
    for (let k = 0; k < keep; k++) sumSq += dists[k] * dists[k];
    const unfiltered = Math.sqrt(sumSq / keep);
    assert(unfiltered > 0.5,
      `closest-${REGISTER_TRIM} residual on a mated pair should be polluted, got ${unfiltered.toFixed(3)}`);
    assert(aligned.reg.residualBefore < unfiltered / 50,
      `filtered ${aligned.reg.residualBefore} should be far below unfiltered ${unfiltered}`);
  });

  await it('without registration a misaligned pair measures nonsense, not nothing', () => {
    /* The defect this milestone exists for. Coverage barely moves — it is
       higher than the mated pair's, which is why it cannot referee alignment —
       while the thickness it reports has nothing to do with the part. */
    assert(asLoaded.iface.coverPct > 10,
      `a misaligned pair still reports coverage, got ${asLoaded.iface.coverPct.toFixed(1)}%`);
    assert(asLoaded.iface.minThk < WALL / 2,
      `min thickness should be wrong, got ${asLoaded.iface.minThk.toFixed(2)}`);
    assert(asLoaded.iface.avgThk > WALL * 2,
      `avg thickness should be wrong, got ${asLoaded.iface.avgThk.toFixed(2)}`);
  });

  await it('registers a misaligned pair, and recovers the transform that was applied', () => {
    eq(registered.reg.applied, true, 'should register:');
    eq(registered.reg.reason, 'registered', 'reason:');

    /* Composed with the misalignment, the recovered transform must be the
       identity — the strongest available statement, and independent of any
       tolerance the tool chose for itself. */
    const truth = movedSoup.xform;
    const rec = registered.reg.transform;
    const probe = [[0, 0, 0], [40, 0, 0], [0, 30, 0], [0, 0, 20], [40, 30, 20]];
    const a = [0, 0, 0], b = [0, 0, 0];
    for (const [x, y, z] of probe) {
      xformPoint(x, y, z, truth, a);
      xformPoint(a[0], a[1], a[2], rec, b);
      close(Math.hypot(b[0] - x, b[1] - y, b[2] - z), 0, 0.01, 'round trip:');
    }
    close(registered.reg.rotationDeg, MISALIGN.deg, 0.05, 'rotation recovered:');
    close(registered.reg.offsetMm, Math.hypot(...MISALIGN.translate), 0.05, 'offset recovered:');
  });

  await it('and the interface figures come back to the truth', () => {
    close(registered.iface.minThk, WALL, 0.01, 'min overmould thickness:');
    /* The mean sits slightly above the wall where the mated fixture's is exact:
       rotated rays are no longer parallel to the substrate's faces, so a few
       near the edge of the cavity footprint hit obliquely instead of missing.
       An artefact of a fixture whose faces are exactly axis-aligned, not of the
       registration — the minimum, which is the figure the thickness check
       judges on, is exact. */
    close(registered.iface.avgThk, WALL, 0.3, 'avg overmould thickness:');
    assert(registered.reg.residualRms <= registered.reg.engageTol,
      `residual ${registered.reg.residualRms} should be inside the mating tolerance`);
    assert(registered.reg.residualRms < asLoaded.iface.minThk + 0.01
        || registered.reg.residualRms < 0.01,
      'the residual should be at measurement precision');
  });

  await it('reports the residual it settled on, in millimetres', () => {
    const r = registered.reg;
    assert(r.residualRms >= 0 && r.residualP95 >= r.residualRms,
      `p95 ${r.residualP95} should not be below rms ${r.residualRms}`);
    assert(r.inlierCount > 100, `too few points behind the residual: ${r.inlierCount}`);
    assert(r.candidatesTried >= 3, `too few starting poses: ${r.candidatesTried}`);
    close(r.engageTol, Math.max(ENGAGE_FLOOR_MM, shot1.diag * ENGAGE_FRACTION), 1e-9, 'mating tolerance:');
  });

  await it('leaves a pair no rigid move can mate alone, so the finding stands', () => {
    /* A 6 mm cube against a shell built for a 100 mm one: the ordinary shape
       of a wrong part or a units mistake. Every pose leaves the cavity tens of
       millimetres off the substrate, so there is nothing to apply. */
    const tiny = weld(S.subdivideSoup(S.box([6, 6, 6]), 2));
    const tinyShot = analyse(tiny, { suggestGate: false });
    const bigShell = weld(S.subdivideSoup(S.shellAround([0, 0, 0], [100, 100, 100], WALL), SUB));
    const bigShot = analyse(bigShell, { material: MATERIALS.tpu, suggestGate: false });

    const reg = registerShots({
      geom1: tiny, bvh1: buildBVH(tiny), shot1: tinyShot,
      geom2: bigShell, shot2: bigShot, maxDist: MAX_DIST,
    });
    eq(reg.attempted, true, 'should have tried:');
    eq(reg.applied, false, 'nothing worth applying:');
    eq(reg.reason, 'no-improvement', 'reason:');
    eq(reg.transform, null, 'no transform:');
    assert(reg.residualRms > reg.engageTol,
      `best residual ${reg.residualRms} should still be outside the mating tolerance`);

    const iface = analyseInterface(tiny, buildBVH(tiny), bigShot, MAX_DIST, null);
    assert(iface.coverPct < 10, `the coverage finding must stand, got ${iface.coverPct.toFixed(1)}%`);
  });

  await it('gives the same answer twice', () => {
    /* Seeded sampling, so a report is reproducible. */
    const again = measure(movedSoup);
    for (let i = 0; i < 9; i++) {
      close(again.reg.transform.r[i], registered.reg.transform.r[i], 0, `r[${i}]:`);
    }
    for (let i = 0; i < 3; i++) {
      close(again.reg.transform.t[i], registered.reg.transform.t[i], 0, `t[${i}]:`);
    }
    close(again.reg.residualRms, registered.reg.residualRms, 0, 'residual:');
  });

  await it('an improvement that stops short of mating is still not applied', () => {
    /*
     * The two halves of the accept test do different jobs, and this is the
     * case that needs the second one. The same mismatched pair, loaded half a
     * metre apart: alignment cuts the gap by more than the relative test asks
     * — hundreds of millimetres down to tens — and the shots still do not
     * touch. Without the absolute half that would be applied, and every
     * overmould thickness below it would be measured in a pose the two parts
     * never occupy.
     */
    const tiny = weld(S.subdivideSoup(S.box([6, 6, 6]), 2));
    const tinyShot = analyse(tiny, { suggestGate: false });
    const far = weld(S.transformSoup(
      S.subdivideSoup(S.shellAround([0, 0, 0], [100, 100, 100], WALL), SUB),
      { translate: [500, 0, 0] },
    ));
    const farShot = analyse(far, { material: MATERIALS.tpu, suggestGate: false });

    const reg = registerShots({
      geom1: tiny, bvh1: buildBVH(tiny), shot1: tinyShot,
      geom2: far, shot2: farShot, maxDist: MAX_DIST,
    });
    assert(reg.residualRms <= reg.residualBefore * RESIDUAL_IMPROVE,
      `the relative test should pass: ${reg.residualBefore.toFixed(1)} → ${reg.residualRms.toFixed(1)} mm`);
    assert(reg.residualRms > reg.engageTol,
      `and the absolute one should fail: ${reg.residualRms.toFixed(1)} mm vs ${reg.engageTol.toFixed(2)} mm`);
    eq(reg.applied, false, 'so nothing is applied:');
  });

  await it('reports the residual of the pose it returns, not of the one before it', () => {
    /* Cut short after a single step, so the loop stops mid-refinement. The
       residual reported has to describe the transform reported beside it: a
       figure measured before the last step belongs to a pose the caller never
       sees. A run allowed to converge cannot show the difference, which is why
       the iteration counts are reachable from here at all. */
    const geom2 = weld(movedSoup);
    const shot2 = analyse(geom2, { material: MATERIALS.tpu, suggestGate: false });
    const short = registerShots({
      geom1: substrate, bvh1, shot1, geom2, shot2, maxDist: MAX_DIST,
      probeIter: 0, maxIter: 1,
    });
    /* No probe, so the refinement starts from the identity — the same pose
       `residualBefore` describes. One step later the two figures must differ,
       and the reported one must be the better of them. */
    eq(short.iterations, 1, 'iteration budget was honoured:');
    assert(Math.abs(short.residualRms - short.residualBefore) > 1e-9,
      `residual ${short.residualRms} should not still be the starting pose's ${short.residualBefore}`);
    assert(short.residualRms < short.residualBefore,
      `one step should have improved on ${short.residualBefore}, got ${short.residualRms}`);
  });
}

describe('two-shot registration — how it is reported');
{
  const IFACE = { coverPct: 45, coverArea: 5200, minThk: 2, avgThk: 2, totalArea2: 11936 };
  const baseline = runTwoShotDFM({
    mat1: 'pcasa', mat2: 'asa_n', interface: IFACE, opticalWindow: 'ir',
  });
  const reg = (extra) => runTwoShotDFM({
    mat1: 'pcasa', mat2: 'asa_n', interface: IFACE, opticalWindow: 'ir',
    registration: extra,
  });
  const find = (res, key) => res.checks.find((c) => c.key === key);

  const APPLIED = {
    attempted: true, applied: true, reason: 'registered',
    transform: identityXform(), coarse: 'centroid', candidatesTried: 7,
    engageTol: 0.54, offsetMm: 18.84, rotationDeg: 25,
    residualBefore: 6.2, residualRms: 0.0001, residualP95: 0.0002,
    inlierCount: 640, coveragePctBefore: 42, coveragePctAfter: 45,
    iterations: 56, converged: true, samples: 1500,
  };

  await it('says, in the finding, that the figures below were measured after the move', () => {
    const c = find(reg(APPLIED), 'ts_registration');
    assert(c, 'ts_registration should be present when a transform was applied');
    eq(c.status, 'warn', 'status:');
    assert(/measured after that move/.test(c.detail), 'must say which frame the figures are in');
    assert(c.detail.includes('18.8 mm'), 'must state how far shot 2 moved');
    assert(c.detail.includes('25.0°'), 'must state how far it was rotated');
    assert(c.detail.includes('0.000 mm'), 'must state the residual');
  });

  await it('names both readings of a gap it cannot tell apart', () => {
    const c = find(reg(APPLIED), 'ts_registration');
    assert(/geometry cannot say/.test(c.detail), 'must not pick one');
    assert(/does not reach the substrate/.test(c.detail), 'must state the design-error reading');
    assert(/its own frame/.test(c.detail), 'must state the export-error reading');
    assert(/[Rr]e-export/.test(c.detail), 'must say how to settle it');
  });

  await it('costs nothing, either way — the score cannot move on it', () => {
    const applied = reg(APPLIED);
    const declined = reg({ ...APPLIED, applied: false, reason: 'no-improvement', transform: null });
    eq(applied.score, baseline.score, 'applied vs no registration:');
    eq(declined.score, baseline.score, 'declined vs no registration:');
    eq(applied.budget, baseline.budget, 'budget must not widen:');
    eq(find(applied, 'ts_registration').scoreDeduction, 0, 'deduction:');
    eq(TWO_SHOT_RISK_PROFILES.ts_registration.weight, 0, 'weight:');
  });

  await it('when nothing was applied, blames the geometry rather than the files', () => {
    const c = find(reg({
      ...APPLIED, applied: false, reason: 'no-improvement', transform: null,
      residualRms: 57, coveragePctBefore: 0, coveragePctAfter: 0,
    }), 'ts_registration');
    eq(c.status, 'info', 'status:');
    assert(/no transform was applied/.test(c.detail), 'must say nothing was moved');
    assert(/measured as loaded/.test(c.detail), 'must say which frame the figures are in');
    assert(/exported in millimetres/.test(c.detail), 'must name the likely causes');
  });

  await it('and says so when the pair simply arrived mated', () => {
    const c = find(reg({
      attempted: false, applied: false, reason: 'already-mated', transform: null,
      residualBefore: 0.0001, residualRms: 0.0001, residualP95: 0.0002,
      coveragePctBefore: 45, coveragePctAfter: 45, inlierCount: 640, samples: 1500,
      engageTol: 0.54,
    }), 'ts_registration');
    eq(c.status, 'ok', 'status:');
    assert(/one coordinate system/.test(c.detail), 'must distinguish mated from unexamined');
    assert(/as loaded/.test(c.detail), 'must say which frame the figures are in');
  });

  await it('the coverage finding says which frame it was measured in', () => {
    const applied = find(reg(APPLIED), 'ts_coverage');
    assert(/after the alignment above/.test(applied.detail), 'registered case:');
    const asLoaded = find(baseline, 'ts_coverage');
    assert(!/after the alignment/.test(asLoaded.detail), 'unregistered case must not claim it:');
  });

  await it('a coverage failure that survived alignment points at the geometry', () => {
    const c = find(runTwoShotDFM({
      mat1: 'pcasa', mat2: 'asa_n', opticalWindow: 'none',
      interface: { ...IFACE, coverPct: 3, coverArea: 300 },
      registration: { ...APPLIED, applied: false, reason: 'no-improvement', transform: null },
    }), 'ts_coverage');
    eq(c.status, 'warn', 'status:');
    assert(/did not help/.test(c.detail), 'must say alignment was tried');
    assert(/Shot alignment above/.test(c.detail), 'must point at the alignment finding');
  });
}


// ═══════════════════════════════════════════════════════════════════════════

describe('crossings along a ray');
{
  const geom = weld(S.box([10, 10, 10]));
  const bvh = buildBVH(geom);
  const hits = new Float64Array(32);

  await it('reports both faces of a solid it passes through', () => {
    eq(castRayAll(bvh, geom, 5, 5, -3, 0, 0, 1, 1e-4, hits), 2, 'crossings:');
    close(hits[0], 3, 1e-6, 'entry:');
    close(hits[1], 13, 1e-6, 'exit:');
  });

  await it('reports one crossing from inside, which is what fixes the parity', () => {
    /* The parity of the count is how the cover measurement knows which side
       of the surface a ray started on. */
    eq(castRayAll(bvh, geom, 5, 5, 4, 0, 0, 1, 1e-4, hits), 1, 'crossings from inside:');
    close(hits[0], 6, 1e-6, 'exit:');
  });

  await it('merges the duplicate a ray through an edge produces', () => {
    /* Straight along the +x face at z = 10, which both triangles of the top
       face and both of the +z... the shared edge is reported by every
       incident triangle, and a duplicated crossing inverts the parity for the
       rest of the ray. */
    const n = castRayAll(bvh, geom, -5, 5, 10, 1, 0, 0, 1e-4, hits);
    for (let i = 1; i < n; i++) {
      assert(hits[i] - hits[i - 1] > 1e-4, `crossings ${i - 1} and ${i} were not merged`);
    }
  });

  await it('finds nothing along a ray that misses', () => {
    eq(castRayAll(bvh, geom, 5, 5, -3, 0, 0, -1, 1e-4, hits), 0, 'crossings:');
  });

  {
    /* Three boxes in a row: six crossings, on a ray placed off the facet
       diagonals so each is reported once. */
    const three = weld(S.joinBodies([
      S.box([10, 10, 10]),
      S.transformSoup(S.box([10, 10, 10]), { translate: [20, 0, 0] }),
      S.transformSoup(S.box([10, 10, 10]), { translate: [40, 0, 0] }),
    ]));
    const threeBvh = buildBVH(three);
    const shoot = (out) => castRayAll(threeBvh, three, -5, 5, 4, 1, 0, 0, 1e-4, out);

    await it('reports every crossing of a ray through several solids', () => {
      const wide = new Float64Array(16);
      eq(shoot(wide), 6, 'crossings:');
      for (let i = 0; i < 6; i++) close(wide[i], 5 + i * 10, 1e-6, `crossing ${i}:`);
    });

    await it('refuses to answer at all once the buffer fills', () => {
      /*
       * A truncated list is not a short list — the crossings dropped from the
       * end flip the parity of anything inferred from it — and the count
       * cannot show that it happened, because the merge collapses raw hits:
       * four hits on a facet diagonal come back as two, which looks exactly
       * like a ray that crossed twice. So it is −1, not a number to be
       * second-guessed.
       */
      eq(shoot(new Float64Array(4)), -1, 'four slots for six crossings:');
      eq(shoot(new Float64Array(6)), 6, 'exactly enough:');
    });

    await it('a ray down a facet diagonal spends the buffer twice over', () => {
      /* Which is why the budget is stated in raw hits. z = 5 puts the ray on
         the diagonal of every face it crosses, so each crossing is reported
         by both triangles. */
      const wide = new Float64Array(16);
      eq(castRayAll(threeBvh, three, -5, 5, 5, 1, 0, 0, 1e-4, wide), 6, 'crossings after merging:');
      /* Twelve raw hits for six crossings, so twelve slots are needed. */
      eq(castRayAll(threeBvh, three, -5, 5, 5, 1, 0, 0, 1e-4, new Float64Array(11)), -1,
        'eleven slots is not enough for six crossings on a diagonal:');
    });
  }
}

describe('FPC — a located insert');
{
  /*
   * A polymer slab with a flex plate on its mid-plane. Cover is
   * (slab − flex) / 2 by construction, on both large faces, so every figure
   * below has a closed-form answer.
   */
  const REQUIRED = 0.5;

  function measure(fx, { gate = null, required = REQUIRED, region } = {}) {
    const geom = weld(fx);
    const shot = analyse(geom, { material: MATERIALS.pp, suggestGate: false, gateLocation: gate });
    return {
      geom,
      region: analyseFpcRegion({
        geom, shot, region: region || [fx.bodies[1]], requiredCover: required, gateLocation: gate,
      }),
    };
  }

  await it('welding leaves the body ranges intact, which the designation depends on', () => {
    /* A body is a contiguous triangle range from the STEP reader, and the
       designation is that range. If welding reordered triangles the range
       would point at someone else's geometry. */
    const fx = S.slabWithInsert();
    const geom = weld(fx);
    eq(geom.triCount, fx.triCount, 'triangle count:');
    const insert = fx.bodies[1];
    /* Every vertex of every triangle in the insert's range must lie inside
       the insert's own bounding box, and none of the slab's may. */
    const zLo = 4 / 2 - 0.1, zHi = 4 / 2 + 0.1;
    for (let t = insert.triStart; t < insert.triEnd; t++) {
      for (let k = 0; k < 3; k++) {
        const z = geom.vertices[geom.indices[t * 3 + k] * 3 + 2];
        assert(z >= zLo - 1e-4 && z <= zHi + 1e-4, `triangle ${t} is not the insert (z=${z})`);
      }
    }
  });

  await it('measures the cover the fixture was built with', () => {
    const fx = S.slabWithInsert();
    const { region } = measure(fx);
    assert(region && region.located, 'the insert should be located');
    close(region.coverStats.min, fx.cover, 0.01, 'min cover:');
    close(region.coverStats.median, fx.cover, 0.01, 'median cover:');
    close(region.uncoveredPct, 0, 0.01, 'nothing should be exposed:');
    close(region.belowRequiredPct, 0, 0.01, 'nothing below the requirement:');
    eq(region.samples, FPC_SAMPLES, 'samples:');
    /* Area, not triangle count: the two large faces plus the four edges. */
    within(region.regionArea, fx.insertArea, 1, 'insert area:');
  });

  await it('reads the same cover whether or not a clearance pocket was modelled', () => {
    /*
     * The reason cover is the polymer along the ray rather than the nearest
     * hit. With a 0.05 mm pocket drawn around the insert, the nearest surface
     * is the pocket wall — a first-hit measurement reports 0.05 mm of cover on
     * a part that has 1.85 mm.
     */
    const CLEAR = 0.05;
    const fx = S.slabWithInsert([40, 30, 4], 0.2, { pocket: CLEAR });
    const { region } = measure(fx);
    close(region.coverStats.min, fx.cover - CLEAR, 0.01, 'min cover through the pocket:');
    close(region.uncoveredPct, 0, 0.01, 'the pocket is not exposure:');
    assert(region.coverStats.min > CLEAR * 10,
      `a first-hit measurement would report about ${CLEAR} mm; got ${region.coverStats.min}`);
  });

  await it('reports thin cover as thin, and over how much of the insert', () => {
    const fx = S.slabWithInsert([40, 30, 0.9], 0.2);
    const { region } = measure(fx);
    close(region.coverStats.min, fx.cover, 0.01, 'min cover:');
    assert(region.coverStats.min < REQUIRED, 'the fixture should be under-covered');
    /* The two large faces are almost all of the insert's area, and both are
       thin, so nearly all of it is below the requirement. */
    assert(region.belowRequiredPct > 90,
      `expected nearly all of the insert under-covered, got ${region.belowRequiredPct.toFixed(1)}%`);
  });

  await it('separates area with no cover from area with thin cover', () => {
    /* An insert standing above the surface. Its top face and edges reach open
       air, which is exposure rather than a small cover — folding the two
       together would report zero cover on a part with a deliberate pad. */
    const fx = S.slabWithInsert([40, 30, 4], 0.2, { proud: true });
    const { region } = measure(fx);
    within(region.uncoveredPct, 100 * (fx.insertArea - fx.insertFaceArea / 2) / fx.insertArea, 5,
      'exposed area:');
    assert(region.coverStats.min > 1, 'what cover remains should not read as thin');
    close(region.belowRequiredPct, 0, 0.01, 'exposure is not thin cover:');
  });

  await it('samples inside each facet, not only at its centre', () => {
    /*
     * A tapered slab, so the cover over the insert's two large facets varies
     * across each of them — from 0.17 mm at one end of the footprint to
     * 2.83 mm at the other. A sampler that takes each triangle's centroid can
     * only ever report the values a third of the way in from each end, and so
     * reports neither the thinnest cover on the part nor the thickest. The
     * thinnest is the figure this check fails on.
     */
    const fx = S.slabWithInsert([40, 30, 4], 0.2, {
      taper: [1.2, 4.0], insertZ: 1.0, insertSize: [38, 28],
    });
    const { region } = measure(fx);
    const [xLo, xHi] = fx.insertFootprint;
    close(region.coverStats.min, fx.cover, 0.03, 'thinnest cover:');
    close(region.coverStats.max, fx.coverMax, 0.03, 'thickest cover:');

    /* Where a centroid sampler would have stopped, from the fixture's own
       formula rather than from anything the code did. */
    const centroidHi = fx.topCoverAt(xLo + (xHi - xLo) * 2 / 3);
    assert(region.coverStats.max > centroidHi + 0.3,
      `centroids cap the maximum at about ${centroidHi.toFixed(2)} mm; got ${region.coverStats.max.toFixed(2)}`);
    assert(region.coverStats.min < 0.5,
      `the thinnest cover on this part is ${fx.cover.toFixed(2)} mm and must be found`);
  });

  await it('measures the distance from the gate to the insert', () => {
    const fx = S.slabWithInsert();
    /* A corner of the slab. The insert is centred, so the nearest point of it
       is the near corner of the plate: 10 mm in x, 10 mm in y, 1.9 in z. */
    const gate = [0, 0, 0];
    const { region } = measure(fx, { gate });
    close(region.gateDistance, Math.hypot(10, 10, 1.9), 0.05, 'gate to insert:');
  });

  await it('reports no gate distance until a gate is picked', () => {
    const { region } = measure(S.slabWithInsert());
    eq(region.gateDistance, null, 'gate distance:');
  });

  await it('declines to measure what has not been designated', () => {
    const fx = S.slabWithInsert();
    const geom = weld(fx);
    const shot = analyse(geom, { material: MATERIALS.pp, suggestGate: false });
    const call = (region) => analyseFpcRegion({ geom, shot, region, requiredCover: REQUIRED });
    eq(call(null), null, 'no designation:');
    eq(call([]), null, 'an empty designation:');
    /* Everything designated leaves no part to measure the cover against, and
       nothing designated leaves nothing to measure. Both must decline rather
       than produce a verdict from an empty set. */
    eq(call([{ triStart: 0, triEnd: geom.triCount }]), null, 'the whole part:');
    eq(call([{ triStart: 5, triEnd: 5 }]), null, 'an empty range:');
  });

  await it('reports cover it could not follow as unknown, not as zero', () => {
    /*
     * A ray with more crossings than the budget holds has its parity in doubt,
     * so the material along it is unknowable — and unknowable is not the same
     * claim as uncovered. Reached by shrinking the budget rather than by a
     * fixture of sixty-five nested walls: every ray off this insert crosses
     * the pocket wall and then the outside of the part, so a budget of one
     * truncates all of them.
     */
    const fx = S.slabWithInsert([40, 30, 4], 0.2, { pocket: 0.05 });
    const geom = weld(fx);
    const shot = analyse(geom, { material: MATERIALS.pp, suggestGate: false });
    const capped = analyseFpcRegion({
      geom, shot, region: [fx.bodies[1]], requiredCover: REQUIRED, maxCrossings: 1,
    });
    close(capped.indeterminatePct, 100, 0.01, 'every sample should be unknown:');
    close(capped.uncoveredPct, 0, 0.01, 'and none of it called uncovered:');
    eq(capped.coverStats, null, 'with no distribution to report:');

    /* The same fixture with the real budget measures it. */
    const full = analyseFpcRegion({
      geom, shot, region: [fx.bodies[1]], requiredCover: REQUIRED, maxCrossings: MAX_CROSSINGS,
    });
    close(full.indeterminatePct, 0, 0.01, 'nothing unknown at the shipped budget:');
    assert(full.coverStats && full.coverStats.n > 0, 'and a distribution to report');
  });

  await it('gives the same answer twice', () => {
    const fx = S.slabWithInsert();
    const a = measure(fx).region;
    const b = measure(fx).region;
    close(b.coverStats.min, a.coverStats.min, 0, 'min cover:');
    close(b.coverStats.median, a.coverStats.median, 0, 'median cover:');
    close(b.uncoveredPct, a.uncoveredPct, 0, 'exposed area:');
  });
}

describe('FPC — what the located insert changes in the rules');
{
  const FPC_ON = {
    ...CLEAN_INPUT,
    fpc: { enabled: true, thickness: 0.2, cover: 0.5, anchors: 'holes' },
    runChecks: { ...CLEAN_INPUT.runChecks, fpc: true, wall: true },
  };
  const find = (r, key) => r.checks.find((c) => c.key === key);

  /* A 4 mm slab with a 0.2 mm insert on its mid-plane: 1.9 mm of cover, which
     is far above the 0.5 mm asked for, on a part whose 4 mm wall is thicker
     than PP's 3.8 mm maximum — so the wall check has something of its own to
     say either way and cannot be confused with the FPC floor. */
  const good = S.slabWithInsert();
  const goodGeom = weld(good);
  const goodMesh = analyse(goodGeom, { material: MATERIALS.pp, suggestGate: false });
  const goodRegion = analyseFpcRegion({
    geom: goodGeom, shot: goodMesh, region: [good.bodies[1]], requiredCover: 0.5,
  });

  await it('the part-wide FPC floor stands down once the insert is located', () => {
    /* A wall floor of thickness + 2 × cover applied to the whole part is the
       thing being replaced: with a 3 mm cover requirement the floor is 6.2 mm
       and every part fails it, insert or no insert. */
    const strict = {
      ...FPC_ON,
      fpc: { enabled: true, thickness: 0.2, cover: 3, anchors: 'holes' },
      mesh: meshFor(S.hollowBox([40, 30, 20], 2)),
    };
    const wide = find(runDFM(strict), 'wall');
    assert(/FPC-overmould floor/.test(wide.detail),
      'without a designation the part-wide floor should still apply');

    const located = find(runDFM({ ...strict, fpcRegion: { located: true, coverStats: { n: 1, min: 3.5, median: 3.5 }, uncoveredPct: 0, indeterminatePct: 0, belowRequiredPct: 0, samples: 2000, gateDistance: null } }), 'wall');
    assert(!/FPC-overmould floor/.test(located.detail),
      'with the insert located the wall check should judge the wall, not the floor');
  });

  await it('judges the measured cover, and says that is what it did', () => {
    const c = find(runDFM({ ...FPC_ON, mesh: goodMesh, fpcRegion: goodRegion }), 'fpc');
    assert(/Cover over the insert is/.test(c.detail), 'must report the measured cover');
    assert(c.detail.includes('1.90 mm'), `must state the figure, got: ${c.detail.slice(0, 400)}`);
    const insert = c.metrics.find((m) => m[0] === 'Insert');
    eq(insert[1], 'Located — cover measured', 'metric:');
    assert(!c.metrics.some((m) => m[0] === 'Effective wall floor'),
      'the part-wide floor should not be quoted once the cover is measured');
  });

  await it('and admits the part-wide version for what it is when it has to use it', () => {
    const c = find(runDFM({ ...FPC_ON, mesh: goodMesh, fpcRegion: null }), 'fpc');
    assert(/over-reports/.test(c.detail), 'must own the over-reporting');
    assert(/Solid bodies/.test(c.detail), 'must say how to get the measurement instead');
    eq(c.metrics.find((m) => m[0] === 'Insert')[1], 'Not located — judged part-wide', 'metric:');
  });

  await it('fails a part whose cover is under what was asked for', () => {
    const thin = S.slabWithInsert([40, 30, 0.9], 0.2);
    const thinGeom = weld(thin);
    const thinMesh = analyse(thinGeom, { material: MATERIALS.pp, suggestGate: false });
    const region = analyseFpcRegion({
      geom: thinGeom, shot: thinMesh, region: [thin.bodies[1]], requiredCover: 0.5,
    });
    const c = find(runDFM({ ...FPC_ON, mesh: thinMesh, fpcRegion: region }), 'fpc');
    eq(c.status, 'fail', 'status:');
    eq(c.severity, 'critical', 'severity:');
    assert(c.scoreDeduction > 0, 'a critical FPC finding must cost points');
    assert(/falls to 0\.3\d mm against the 0\.50 mm/.test(c.detail),
      `must name both figures, got: ${c.detail.slice(0, 300)}`);
  });

  await it('asks about exposed insert area rather than passing over it', () => {
    const proud = S.slabWithInsert([40, 30, 4], 0.2, { proud: true });
    const proudGeom = weld(proud);
    const proudMesh = analyse(proudGeom, { material: MATERIALS.tpu, suggestGate: false });
    const region = analyseFpcRegion({
      geom: proudGeom, shot: proudMesh, region: [proud.bodies[1]], requiredCover: 0.5,
    });
    /* TPU rather than PP, and deliberately: PP is high-warp, so the FPC check
       warns about shrinkage on its own and the status would read the same
       whether or not exposure raised it. TPU passes every other branch of
       this check, which leaves the exposure as the only thing that can. */
    const c = find(runDFM({ ...FPC_ON, material: 'tpu', mesh: proudMesh, fpcRegion: region }), 'fpc');
    const clean = find(runDFM({
      ...FPC_ON, material: 'tpu', mesh: proudMesh,
      fpcRegion: { ...region, uncoveredPct: 0 },
    }), 'fpc');
    eq(clean.status, 'ok', 'the same part with nothing exposed:');
    assert(/reach open air/.test(c.detail), 'must report the exposure');
    assert(/cannot tell an opening from an oversight/.test(c.detail),
      'must say why it is a question rather than a verdict');
    assert(c.status === 'warn' || c.status === 'fail', `status was "${c.status}"`);
  });

  await it('measures gate proximity instead of asking the reader to check it', () => {
    const near = { ...goodRegion, gateDistance: 0.4 };
    const c = find(runDFM({ ...FPC_ON, mesh: goodMesh, fpcRegion: near }), 'fpc');
    eq(c.status, 'fail', 'a gate inside one wall of the insert:');
    assert(/0\.4 mm from the insert/.test(c.detail), 'must state the distance');
    assert(!/Verify gate is at least/.test(c.detail),
      'the advisory it replaces should be gone once the distance is known');
    eq(c.metrics.find((m) => m[0] === 'Gate to insert')[1], '0.4 mm', 'metric:');

    const clear = { ...goodRegion, gateDistance: 40 };
    const ok = find(runDFM({ ...FPC_ON, mesh: goodMesh, fpcRegion: clear }), 'fpc');
    assert(/comfortably clear/.test(ok.detail), 'a distant gate should read as clear');
  });

  await it('the export says whether the cover was measured or inferred', () => {
    const r = runDFM({ ...FPC_ON, mesh: goodMesh, fpcRegion: goodRegion });
    const base = {
      sessionId: 'TEST', dfm: { input: { ...FPC_ON, fpcRegion: goodRegion }, result: r },
      analysis: null, twoShot: null, interface: null, validation: null,
      settings: { analysisMode: 'single', windowType: 'none' },
    };
    const located = buildExportJSON({ ...base, fpcRegion: goodRegion });
    eq(located.fpc_insert.located, true, 'located:');
    close(located.fpc_insert.cover_min_mm, good.cover, 0.01, 'min cover:');
    close(located.fpc_insert.required_cover_mm, 0.5, 0, 'required cover:');
    /* Three states, kept apart: thin, absent, unmeasurable. */
    for (const k of ['area_below_required_pct', 'area_uncovered_pct', 'area_indeterminate_pct']) {
      eq(typeof located.fpc_insert[k], 'number', `${k}:`);
    }

    const not = buildExportJSON({ ...base, fpcRegion: null });
    eq(not.fpc_insert.located, false, 'not located:');
    eq(not.fpc_insert.cover_min_mm, undefined, 'and no cover figures to mistake for measured ones:');
  });

  await it('keeps the advisory when the insert is located but no gate is picked', () => {
    const c = find(runDFM({ ...FPC_ON, mesh: goodMesh, fpcRegion: goodRegion }), 'fpc');
    assert(/Pick a gate location and re-run/.test(c.detail), 'must ask for a gate');
    assert(!c.metrics.some((m) => m[0] === 'Gate to insert'), 'and quote no distance');
  });
}


// ═══════════════════════════════════════════════════════════════════════════

describe('camera — the pose the theta/phi pair used to hold');
{
  /*
   * The camera was the most hand-tuned code in the repository and had no
   * automated coverage: its correctness lived in whether an orbit felt right.
   * The refactor to a quaternion is the moment to fix that, and the reference
   * to assert against is the arithmetic it replaced — written out here from
   * the old source rather than from the new.
   */
  const oldEye = (theta, phi, radius, t = [0, 0, 0]) => [
    t[0] + radius * Math.sin(phi) * Math.cos(theta),
    t[1] + radius * Math.cos(phi),
    t[2] + radius * Math.sin(phi) * Math.sin(theta),
  ];
  const ORBIT_PER_PX = 0.008;
  const make = (theta, phi, distance = 200, target = [0, 0, 0]) => createCameraState({
    orientation: quatFromThetaPhi(theta, phi), distance, target, partSize: distance / 2.2,
  });

  await it('puts the eye exactly where the old formula did', () => {
    for (const [theta, phi] of [
      [Math.PI / 4, Math.PI / 3],   // iso
      [0, 0.01],                    // top
      [Math.PI / 2, Math.PI / 2],   // front
      [0, Math.PI / 2],             // right
      [-1.2, 2.4], [5.1, 0.3],
    ]) {
      const cam = make(theta, phi, 200, [3, -4, 5]);
      const want = oldEye(theta, phi, 200, [3, -4, 5]);
      close(vLen(vSub(cam.eye, want)), 0, 1e-9, `θ=${theta} φ=${phi}:`);
    }
  });

  await it('orbits by the same amount a drag used to move theta and phi', () => {
    /* The feel constant is unchanged, so a given drag has to land in the same
       place it always did. */
    for (const [dx, dy] of [[10, 0], [0, 10], [-7, 4], [120, -60]]) {
      const cam = make(Math.PI / 4, Math.PI / 3);
      cam.orbit(dx * ORBIT_PER_PX, -dy * ORBIT_PER_PX);
      const want = oldEye(Math.PI / 4 - dx * ORBIT_PER_PX, Math.PI / 3 - dy * ORBIT_PER_PX, 200);
      close(vLen(vSub(cam.eye, want)), 0, 1e-9, `drag ${dx},${dy}:`);
    }
  });

  await it('keeps the horizon level however far it is orbited', () => {
    /* The property the theta/phi pair gave away for free and a quaternion has
       to be made to hold: yaw about a world axis, pitch about the camera's
       own. Doing both on one side is the classic way to get a camera that
       slowly rolls as you circle a part — after a hundred drags it would be
       visibly crooked. */
    const cam = make(Math.PI / 4, Math.PI / 3);
    for (let i = 0; i < 100; i++) cam.orbit(0.09, 0.03 * Math.sin(i));
    const right = cam.right;
    close(vDot(right, [0, 1, 0]), 0, 1e-9, 'the camera right axis should stay horizontal:');
  });

  await it('will not orbit over the pole', () => {
    for (const direction of [1, -1]) {
      const cam = make(0, Math.PI / 3);
      for (let i = 0; i < 200; i++) cam.orbit(0, direction * 0.05);
      /* How far up or down the world axis the view has got: ±1 is straight
         through the pole, which is the singularity being avoided. */
      const upness = vDot(vUnit(vSub(cam.eye, cam.target)), [0, 1, 0]);
      assert(Math.abs(upness) <= Math.cos(PITCH_LIMIT) + 1e-9,
        `orbiting should stop short of the pole: cos=${upness}`);
      assert(Math.abs(upness) > 0.9,
        `and should have got most of the way there: cos=${upness}`);
    }
  });

  await it('holds a point still while zooming toward it', () => {
    /* What makes a wheel zoom feel like a zoom rather than a jump. */
    const cam = make(Math.PI / 4, Math.PI / 3, 200);
    const point = [10, 5, -3];
    const before = cam.distance;
    cam.zoomToward(0.5, point);
    close(cam.distance, before * 0.5, 1e-9, 'distance:');
    /* The target moved half the way to the point, which is the same fraction
       the distance shrank — that is the invariant, and it is what keeps the
       point on the same screen position. */
    const wanted = [0 + (10 - 0) * 0.5, 0 + (5 - 0) * 0.5, 0 + (-3 - 0) * 0.5];
    close(vLen(vSub(cam.target, wanted)), 0, 1e-9, 'target:');
  });

  await it('clamps the distance to the part it is looking at', () => {
    const cam = make(0, Math.PI / 3, 200);
    cam.setPartSize(100);
    for (let i = 0; i < 100; i++) cam.zoom(0.5);
    close(cam.distance, 100 * ZOOM_MIN_FACTOR, 1e-9, 'closest:');
    for (let i = 0; i < 100; i++) cam.zoom(2);
    close(cam.distance, 100 * ZOOM_MAX_FACTOR, 1e-9, 'furthest:');
  });

  await it('pans across the view plane, not across the world axes', () => {
    /* A pan has to move the target in the plane the user is looking at, which
       is what makes dragging feel like sliding the part. */
    const cam = make(Math.PI / 4, Math.PI / 3, 200);
    const before = cam.target;
    cam.pan(7, 0);
    const moved = vSub(cam.target, before);
    close(vLen(moved), 7, 1e-9, 'distance moved:');
    close(vDot(vUnit(moved), cam.right), 1, 1e-9, 'direction:');
    /* And the eye follows the target: a pan does not orbit. */
    close(vLen(vSub(cam.eye, vSub(cam.target, vScale(cam.forward, cam.distance)))), 0, 1e-6,
      'eye should stay at target − forward × distance:');
  });

  await it('can roll, which is the whole reason for the change', () => {
    /* A theta/phi camera cannot represent this at all: there is no pair of
       angles that leaves the eye where it is and turns the horizon. */
    const cam = make(Math.PI / 4, Math.PI / 3, 200);
    const eyeBefore = cam.eye;
    const rightBefore = cam.right;
    cam.rotateLocal(0, 0, 0.4);
    close(vLen(vSub(cam.eye, eyeBefore)), 0, 1e-9, 'a roll must not move the eye:');
    const turned = Math.acos(Math.max(-1, Math.min(1, vDot(rightBefore, cam.right))));
    close(turned, 0.4, 1e-9, 'and must turn the horizon by the angle asked for:');
  });
}

describe('camera — a 6-DoF sample, integrated');
{
  const cam = () => createCameraState({
    orientation: quatFromThetaPhi(Math.PI / 4, Math.PI / 3), distance: 200, partSize: 100,
  });
  const S6 = (o) => ({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, ...o });

  await it('ignores a puck that is merely resting', () => {
    /*
     * A spring-centred device does not read zero at rest; it wanders. Without
     * a dead zone that is a camera that drifts on its own, sixty times a
     * second, while nobody is touching anything.
     */
    const dz = NAVIGATOR_DEFAULTS.deadZone;
    eq(shape(0, dz), 0, 'dead centre:');
    eq(shape(dz * 0.99, dz), 0, 'just inside:');
    eq(shape(-dz * 0.99, dz), 0, 'just inside, the other way:');
    assert(shape(dz * 1.5, dz) > 0, 'just outside should respond');
    assert(isIdle(S6({ tx: dz * 0.9, ry: -dz * 0.5 }), dz), 'a resting puck should read idle');
    assert(!isIdle(S6({ ry: 0.9 }), dz), 'a pushed puck should not');

    const c = cam();
    const before = c.eye;
    eq(applyRates(c, S6({ tx: dz * 0.9 }), 1 / 60), false, 'a resting sample moves nothing:');
    close(vLen(vSub(c.eye, before)), 0, 0, 'and the camera did not move:');
  });

  await it('responds from zero at the edge of the dead zone, not with a step', () => {
    /* Rescaled from the zone edge rather than passed through, so the first
       perceptible push is a slow one. A step here is the difference between a
       control that can line a part up and one that cannot. */
    const dz = NAVIGATOR_DEFAULTS.deadZone;
    close(shape(dz + 1e-9, dz), 0, 1e-9, 'at the edge:');
    close(shape(1, dz), 1, 1e-12, 'at full deflection:');
    close(shape(-1, dz), -1, 1e-12, 'and at full deflection the other way:');
    /* Quadratic, so fine near centre and fast at the extremes. */
    const half = shape(dz + (1 - dz) / 2, dz);
    close(half, 0.25, 1e-9, 'halfway out should be a quarter speed:');
  });

  await it('integrates over time rather than jumping', () => {
    /* The axis value is a velocity. Two half-steps must land where one whole
       step does, or the camera's speed depends on the frame rate. */
    const one = cam();
    applyRates(one, S6({ ry: 1 }), 0.1);
    const two = cam();
    applyRates(two, S6({ ry: 1 }), 0.05);
    applyRates(two, S6({ ry: 1 }), 0.05);
    close(vLen(vSub(one.eye, two.eye)), 0, 1e-9, 'one step vs two halves:');
  });

  await it('turns a full push into the stated rate', () => {
    /* Accumulated over enough frames to make a second, rather than asked for
       in one — a whole second in a single step is exactly what maxStep
       refuses, and the test below is what refuses it. */
    const c = cam();
    for (let i = 0; i < 100; i++) applyRates(c, S6({ ry: 1 }), 0.01);
    const start = cam();
    const a = vUnit(vSub(c.eye, c.target));
    const b = vUnit(vSub(start.eye, start.target));
    close(Math.acos(Math.max(-1, Math.min(1, vDot(a, b)))), NAVIGATOR_DEFAULTS.rotateRate, 1e-6,
      'a second at full deflection:');
  });

  await it('scales panning to the part, and dollying to the distance', () => {
    /* Neither should need retuning between a 10 mm connector and a 400 mm
       housing, which is what an absolute rate would force. */
    const small = createCameraState({ distance: 22, partSize: 10 });
    const large = createCameraState({ distance: 880, partSize: 400 });
    applyRates(small, S6({ tx: 1 }), 0.1);
    applyRates(large, S6({ tx: 1 }), 0.1);
    close(vLen(small.target) / 10, vLen(large.target) / 400, 1e-9,
      'the same push should cross the same fraction of each part:');

    const near = createCameraState({ distance: 50, partSize: 100 });
    const far = createCameraState({ distance: 500, partSize: 100 });
    applyRates(near, S6({ tz: 1 }), 0.1);
    applyRates(far, S6({ tz: 1 }), 0.1);
    close((50 - near.distance) / 50, (500 - far.distance) / 500, 1e-9,
      'and should close the same fraction of each distance:');
  });

  await it('refuses to integrate a frame that never happened', () => {
    /* A backgrounded tab comes back with an enormous dt. Integrating it would
       fling the camera somewhere unrecoverable before the first frame draws. */
    const c = cam();
    applyRates(c, S6({ tz: 1 }), 60);
    const capped = cam();
    applyRates(capped, S6({ tz: 1 }), NAVIGATOR_DEFAULTS.maxStep);
    close(c.distance, capped.distance, 1e-9, 'a minute-long frame is capped:');
  });

  await it('can be told not to roll', () => {
    const rolling = cam();
    applyRates(rolling, S6({ rz: 1 }), 0.1, { ...NAVIGATOR_DEFAULTS, roll: true });
    const level = cam();
    const before = level.right;
    eq(applyRates(level, S6({ rz: 1 }), 0.1, { ...NAVIGATOR_DEFAULTS, roll: false }), false,
      'with roll off, a pure twist moves nothing:');
    close(vLen(vSub(level.right, before)), 0, 0, 'and the horizon is untouched:');
    assert(vLen(vSub(rolling.right, before)) > 1e-3, 'with roll on it should turn');
  });

  await it('drives a camera from a source a test can feed', () => {
    /*
     * Nothing about a physical puck is testable in CI, so the transport sits
     * behind an interface — `read()` returns a sample or null — and this is
     * that interface being exercised end to end with a synthetic source and a
     * synthetic clock. It is the same trick as the bridge fixture: the part
     * that can be verified is kept on this side of the line.
     */
    const c = cam();
    const controls = {
      applyRates: (sample, dt) => applyRates(c, sample, dt),
    };
    let t = 1000;
    const frames = [];
    const samples = [S6({ ry: 1 }), S6({ ry: 1 }), null, S6({ ry: 1 })];
    let i = 0;
    const loop = createNavigatorLoop({
      source: {
        read: () => {
          if (i < samples.length) return samples[i++];
          loop.stop();
          return null;
        },
      },
      controls,
      now: () => t,
      schedule: (fn) => { t += 100; frames.push(t); if (frames.length < 12) fn(); },
    });
    const before = c.eye;
    loop.start();
    eq(loop.running, false, 'the loop stops when the source runs dry:');
    assert(vLen(vSub(c.eye, before)) > 1, 'the samples should have moved the camera');
    /*
     * Three live samples at 0.1 s each; the null one contributes nothing, and
     * neither does the first frame — it starts the clock and reads nothing,
     * because a sample integrated over zero seconds is a sample thrown away.
     */
    eq(i, samples.length, 'every sample should have been offered:');
    const expected = cam();
    for (let k = 0; k < 3; k++) applyRates(expected, S6({ ry: 1 }), 0.1);
    close(vLen(vSub(c.eye, expected.eye)), 0, 1e-6, 'and by exactly the live ones:');
  });
}

describe('a 6-DoF device, read from its own descriptor');
{
  /*
   * The layout comes from the device's report descriptor rather than a table
   * of byte offsets per model, because a Compact is not a SpacePilot and a
   * guessed offset produces a camera that lurches in the wrong axis on
   * hardware nobody tested on. What that makes testable is everything from
   * the descriptor onwards — which is all of the decoding.
   *
   * The descriptors below are the shape WebHID documents, built by hand: two
   * reports, translation in one and rotation in the other, which is how these
   * devices are usually laid out.
   */
  const GD = 0x0001;
  const usage = (id) => (GD << 16) | id;
  const axis16 = (usages, min = -350, max = 350) => ({
    reportSize: 16, reportCount: usages.length, usages,
    logicalMinimum: min, logicalMaximum: max,
  });

  const TWO_REPORT_PUCK = [{
    inputReports: [
      { reportId: 1, items: [axis16([usage(0x30), usage(0x31), usage(0x32)])] },
      { reportId: 2, items: [axis16([usage(0x33), usage(0x34), usage(0x35)])] },
    ],
  }];

  /* Little-endian 16-bit fields, which is what the descriptor above declares. */
  const report = (...values) => {
    const buf = new ArrayBuffer(values.length * 2);
    const view = new DataView(buf);
    values.forEach((v, i) => { view.setInt16(i * 2, v, true); });
    return view;
  };

  await it('finds each axis where the descriptor says it is', () => {
    const axes = axesFromCollections(TWO_REPORT_PUCK);
    eq(Object.keys(axes).sort().join(','), '1,2', 'reports:');
    eq(axes[1].map((f) => f.axis).join(','), 'tx,ty,tz', 'translation report:');
    eq(axes[2].map((f) => f.axis).join(','), 'rx,ry,rz', 'rotation report:');
    eq(axes[1].map((f) => f.bitOffset).join(','), '0,16,32', 'offsets accumulate:');
    eq(axes[1][0].bitSize, 16, 'field width:');
  });

  await it('skips past fields it does not recognise rather than mis-aligning', () => {
    /* A button array or a padding field occupies its bits like anything else.
       Getting this wrong is precisely the failure descriptor-driven decoding
       exists to avoid: every axis after the unknown field shifts. */
    const withButtons = [{
      inputReports: [{
        reportId: 3,
        items: [
          /* Eight buttons, one bit each, on a page this does not care about. */
          { reportSize: 1, reportCount: 8, usages: [0x00090001], logicalMinimum: 0, logicalMaximum: 1 },
          /* Then the axes. */
          axis16([usage(0x30), usage(0x31)]),
        ],
      }],
    }];
    const axes = axesFromCollections(withButtons);
    eq(axes[3].map((f) => `${f.axis}@${f.bitOffset}`).join(','), 'tx@8,ty@24',
      'the axes must sit after the eight button bits:');
  });

  await it('decodes a report into normalised axes', () => {
    const axes = axesFromCollections(TWO_REPORT_PUCK);
    close(decodeReport(axes, 1, report(350, -350, 0)).tx, 1, 1e-12, 'full push:');
    close(decodeReport(axes, 1, report(350, -350, 0)).ty, -1, 1e-12, 'full pull:');
    close(decodeReport(axes, 1, report(350, -350, 0)).tz, 0, 1e-12, 'centred:');
    close(decodeReport(axes, 1, report(175, 0, 0)).tx, 0.5, 1e-12, 'half:');
    /* Signed, because the descriptor's minimum is negative — read unsigned, a
       small pull would decode as an enormous push. */
    close(decodeReport(axes, 1, report(-1, 0, 0)).tx, -1 / 350, 1e-12, 'the smallest pull:');
  });

  await it('reports only the axes the report carries', () => {
    /* Translation and rotation arrive separately, so a rotation report must
       not blank the translation the previous one set. */
    const axes = axesFromCollections(TWO_REPORT_PUCK);
    const rotation = decodeReport(axes, 2, report(0, 350, 0));
    eq(Object.keys(rotation).sort().join(','), 'rx,ry,rz', 'keys:');
    close(rotation.ry, 1, 1e-12, 'value:');
    eq(decodeReport(axes, 9, report(1, 2, 3)), null, 'an unknown report id:');
  });

  await it('clamps a device that overshoots its own declared range', () => {
    /* Firmware does report past its logical maximum. The camera's rate curve
       assumes −1…1 and would otherwise be handed 1.4. */
    const axes = axesFromCollections(TWO_REPORT_PUCK);
    close(decodeReport(axes, 1, report(500, -500, 0)).tx, 1, 1e-12, 'over:');
    close(decodeReport(axes, 1, report(500, -500, 0)).ty, -1, 1e-12, 'under:');
  });

  await it('reads a field that is not byte-aligned', () => {
    /* The descriptor is allowed to put an axis anywhere, so the reader works
       in bits. A 12-bit field starting four bits in is the awkward case. */
    const buf = new Uint8Array([0b0000_0000, 0b1010_0101, 0b0000_1111]);
    const view = new DataView(buf.buffer);
    /*
     * Bits 4..15 of the little-endian bit stream, derived rather than written
     * out: the field's bits 0..3 are the top four of byte 0, which are zero,
     * and its bits 4..11 are the whole of byte 1. So the value is byte 1
     * shifted up by four.
     */
    eq(readField(view, 4, 12, false), buf[1] << 4, 'unsigned:');
    eq(readField(view, 4, 12, false), 2640, 'and the number that comes to:');
    eq(readField(view, 0, 8, true), 0, 'signed zero:');
    eq(readField(view, 8, 8, true), -91, 'signed negative:');
    /* Past the end of the buffer stops rather than throwing. */
    eq(readField(view, 20, 16, false), 0, 'past the end:');
  });

  await it('holds the latest deflection of every axis, merged across reports', () => {
    /*
     * The whole source, driven by a fake device. This is what makes the
     * transport testable at all: a HIDDevice is an event target with a
     * `collections` array, and both of those a test can supply.
     */
    const listeners = [];
    const device = {
      collections: TWO_REPORT_PUCK,
      opened: true,
      addEventListener: (_, fn) => listeners.push(fn),
      removeEventListener: (_, fn) => listeners.splice(listeners.indexOf(fn), 1),
      close: () => { device.opened = false; },
    };
    const source = createHidSource(device);
    eq(source.axisCount, 6, 'axes declared:');
    eq(source.read(), null, 'silence before the first report:');

    const send = (id, view) => { listeners.forEach((fn) => { fn({ reportId: id, data: view }); }); };
    send(1, report(350, 0, 0));
    close(source.read().tx, 1, 1e-12, 'translation arrived:');
    close(source.read().ry, 0, 1e-12, 'and rotation is still centred:');

    send(2, report(0, 350, 0));
    close(source.read().ry, 1, 1e-12, 'rotation arrived:');
    close(source.read().tx, 1, 1e-12,
      'and a rotation-only report must not blank the translation:');

    /* Superseded rather than queued: a slow frame drops stale samples instead
       of accumulating a backlog that plays back as a lurch. */
    send(1, report(0, 0, 0));
    close(source.read().tx, 0, 1e-12, 'the latest report wins:');

    source.close();
    eq(listeners.length, 0, 'closing detaches the listener:');
    eq(device.opened, false, 'and closes the device:');
  });

  await it('is absent, silently, where the API is not', () => {
    /* Chromium-only, and it has to degrade to nothing at all: no error, no
       chip, no mention. Node has no navigator.hid, which is the case. */
    eq(hidAvailable(), false, 'in Node:');
    eq(Object.keys(AXIS_USAGES).length, 6, 'the six axes are all mapped:');
  });
}

describe('the findings package');
{
  /*
   * Read back by `unzip`, not by this repository's own reader. An archive
   * that only its author can open is not an archive — the file goes to a
   * factory, and whatever is on that machine has to be able to open it. The
   * assertions below therefore go through a real extractor; that is the whole
   * point of the test, and a self-consistency check would prove nothing.
   */
  const OUT = join(tmpdir(), `dfm-zip-${process.pid}`);

  async function extract(blob, label) {
    const dir = join(OUT, label);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const zipPath = join(dir, 'a.zip');
    writeFileSync(zipPath, Buffer.from(await blob.arrayBuffer()));
    /* -qq so a failure is the exit status rather than buried in a listing.
       `unzip` returns 1 for warnings and 2+ for a broken archive. */
    execFileSync('unzip', ['-qq', '-o', zipPath, '-d', dir]);
    const names = execFileSync('zipinfo', ['-1', zipPath], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    return {
      dir,
      names,
      read: (name) => readFileSync(join(dir, name)),
    };
  }

  await it('crc32 agrees with an independent implementation', () => {
    /* The manifest publishes these for a recipient to check, so they have to
       be the CRC everybody else computes. Values from the zlib test vectors. */
    eq(crc32Hex(new TextEncoder().encode('')), '00000000', 'empty:');
    eq(crc32Hex(new TextEncoder().encode('a')), 'e8b7be43', '"a":');
    eq(crc32Hex(new TextEncoder().encode('123456789')), 'cbf43926', '"123456789":');
    /* And on bytes that are not ASCII, where a sign error would show. */
    eq(crc32(Uint8Array.from([0, 255, 128, 1])), crc32(Uint8Array.from([0, 255, 128, 1])),
      'stable across calls:');
  });

  await it('writes an archive unzip can read, byte for byte', async () => {
    const payloads = {
      'plain.txt': new TextEncoder().encode('hello'),
      /* Highly compressible, so deflate is exercised. */
      'repeated.txt': new TextEncoder().encode('STEP;'.repeat(4000)),
      /* Incompressible, so the store fallback is exercised on the same run —
         deflate on random bytes comes out larger and must not be used. */
      'random.bin': (() => {
        const rand = makeRandom(11);
        return Uint8Array.from({ length: 4096 }, () => Math.floor(rand() * 256));
      })(),
      'nested/dir/file.json': new TextEncoder().encode('{"a":1}'),
    };
    const zip = await createZip(Object.entries(payloads).map(([name, bytes]) => ({ name, bytes })));
    const got = await extract(zip.blob, 'roundtrip');

    eq(got.names.sort().join(','), Object.keys(payloads).sort().join(','), 'members:');
    for (const [name, bytes] of Object.entries(payloads)) {
      const back = got.read(name);
      eq(back.length, bytes.length, `${name} length:`);
      assert(Buffer.from(bytes).equals(back), `${name} came back different`);
    }

    const summary = new Map(zip.entries.map((e) => [e.name, e]));
    assert(summary.get('repeated.txt').deflated, 'repeated text should have been deflated');
    assert(summary.get('repeated.txt').stored < summary.get('repeated.txt').bytes / 5,
      `deflate barely helped: ${summary.get('repeated.txt').stored} of ${summary.get('repeated.txt').bytes}`);
    assert(!summary.get('random.bin').deflated,
      'random bytes must be stored rather than grown by deflating them');
    eq(summary.get('plain.txt').crc32, crc32Hex(payloads['plain.txt']), 'reported crc:');
  });

  await it('refuses a member too large for the format before allocating it', async () => {
    /*
     * No Zip64 here, so the 32-bit fields have a limit. Reached by declaring a
     * length rather than by allocating four gigabytes — and the first version
     * of this test only *said* that: the writer coerced the declared length
     * into a typed array before checking it, so saying no to four gigabytes
     * cost four gigabytes, and the suite was killed by the OOM reaper. The
     * check now runs before the allocation, which is what makes this test
     * cheap enough to have.
     */
    const before = process.memoryUsage().heapTotal;
    let threw = null;
    try {
      await createZip([{ name: 'big.bin', bytes: { length: 0x100000000 } }]);
    } catch (err) { threw = err; }
    assert(threw, 'a 4 GB member should be refused');
    assert(/too large/.test(threw.message), `unhelpful message: ${threw.message}`);
    /* And refused without having built it: a gigabyte of headroom is far
       tighter than the four the old order would have taken. */
    const grew = process.memoryUsage().heapTotal - before;
    assert(grew < 1e9, `refusing it grew the heap by ${(grew / 1e6).toFixed(0)} MB`);
  });

  await it('packages the report, the record and the file that was measured', async () => {
    const mesh = SHELL_BOX();
    const result = runDFM({ ...CLEAN_INPUT, mesh });
    const json = buildExportJSON({
      sessionId: 'ABCDE', dfm: { input: CLEAN_INPUT, result }, analysis: mesh,
      twoShot: null, interface: null, validation: null,
      settings: { analysisMode: 'single', windowType: 'none' },
    });
    const stepBytes = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n');
    const pkg = await buildFindingsPackage({
      sessionId: 'ABCDE',
      partName: 'housing_rev4.step',
      source: { name: 'housing_rev4.step', bytes: stepBytes },
      pdfBytes: new TextEncoder().encode('%PDF-1.3\nnot really a pdf\n'),
      json,
      result,
      twoShot: null,
    });

    const got = await extract(pkg.blob, 'package');
    eq(got.names.sort().join(','),
      ['MANIFEST.txt', 'findings.json', 'geometry/housing_rev4.step', 'report.pdf'].sort().join(','),
      'members:');
    assert(pkg.filename.startsWith('dfm_findings_housing_rev4_ABCDE'), `filename: ${pkg.filename}`);

    /* The geometry is the bytes that were measured, not a re-read of anything. */
    assert(Buffer.from(stepBytes).equals(got.read('geometry/housing_rev4.step')),
      'the geometry in the archive is not the geometry that went in');
    /* And the record is the record, still parseable after the round trip. */
    const back = JSON.parse(got.read('findings.json').toString('utf8'));
    eq(back.score, result.score, 'exported score survived:');
    eq(back.build.tool_version, json.build.tool_version, 'build identity survived:');
  });

  await it('the manifest names the file, its checksum, and every finding reference', async () => {
    const mesh = LEDGE_CUP();
    const result = runDFM({ ...CLEAN_INPUT, mesh });
    const stepBytes = new TextEncoder().encode('ISO-10303-21;\nENDSEC;\n');
    const pkg = await buildFindingsPackage({
      sessionId: 'ZZZZZ', partName: 'cup.step',
      source: { name: 'cup.step', bytes: stepBytes },
      pdfBytes: null,
      json: { score: result.score }, result, twoShot: null,
      now: new Date('2026-09-08T10:30:00Z'),
    });
    const m = pkg.manifest;

    assert(m.includes('cup.step'), 'the part is not named');
    assert(m.includes('2026-09-08T10:30:00Z'), `no timestamp: ${m.slice(0, 200)}`);
    assert(m.includes(`${result.score} / 100`), 'the score is not stated');
    /* The checksum a recipient checks the attachment against. */
    assert(m.includes(crc32Hex(stepBytes)),
      `the geometry's crc32 (${crc32Hex(stepBytes)}) is not in the manifest`);
    assert(/not a signature/.test(m), 'the manifest must say what a CRC is not');
    /* Every finding, by the reference a response is written against. */
    for (const c of result.checks) {
      assert(m.includes(checkRef(c.key)), `${c.key} is missing from the manifest's finding list`);
    }
    /* And it is inside the archive, not only returned here. */
    const got = await extract(pkg.blob, 'manifest');
    eq(got.read('MANIFEST.txt').toString('utf8'), m, 'the manifest in the archive:');
  });

  await it('says loudly when there is no geometry to include', async () => {
    /* A part loaded before the bytes were kept, or by a route with none. The
       package is still worth having; silently shipping two files that describe
       a third nobody attached is not. */
    const result = runDFM({ ...CLEAN_INPUT, mesh: analysedFixture('plain-box', () => S.box()) });
    const pkg = await buildFindingsPackage({
      sessionId: 'NOGEO', partName: 'part.stl', source: null,
      pdfBytes: null, json: { score: result.score }, result, twoShot: null,
    });
    assert(/NO GEOMETRY IS INCLUDED/.test(pkg.manifest), 'the absence must be stated, not implied');
    const got = await extract(pkg.blob, 'nogeo');
    assert(!got.names.some((n) => n.startsWith('geometry/')), `unexpected geometry: ${got.names}`);
  });

  await it('an unbuilt source tree is not passed off as a release', async () => {
    const pkg = await buildFindingsPackage({
      sessionId: 'DEV', partName: 'part.stl', source: null,
      pdfBytes: null, json: {}, result: null, twoShot: null,
    });
    assert(/RUNNING FROM SOURCE/.test(pkg.manifest),
      `the manifest should not imply a release: ${pkg.manifest.slice(0, 300)}`);
  });

  await it('turns a hostile filename into a harmless member name', () => {
    /* A member called ../etc is the classic archive escape, and a Windows
       path in a name makes an entry nothing can extract. */
    /* The directory part is dropped, not escaped: the file's name is
       "passwd", and mangling the path into the name would be safe but absurd. */
    eq(safeName('../../etc/passwd'), 'passwd', 'traversal:');
    eq(safeName('C:\\Users\\me\\part.step'), 'part.step', 'windows path:');
    eq(safeName(''), 'part', 'empty:');
    eq(safeName(null), 'part', 'missing:');
    assert(safeName('x'.repeat(500)).length <= 80, 'a very long name must be truncated');
    for (const hostile of ['../../etc/passwd', 'a/b', 'x\u0000y', '....//x']) {
      assert(!safeName(hostile).includes('/') && !safeName(hostile).includes('\\'),
        `safeName left a separator in "${hostile}" → "${safeName(hostile)}"`);
    }
  });
}

describe('finding references');
{
  await it('a check is quoted by its key, not by a second identifier', () => {
    /* A run emits at most one finding per key, so the key already identifies
       it permanently. Anything derived from it would be a second thing to keep
       in step with the first. */
    eq(checkRef('wall'), 'WALL', 'plain key:');
    eq(checkRef('corner_radii'), 'CORNER-RADII', 'underscores read as hyphens:');
    eq(checkRef('ts_coverage'), 'TS-COVERAGE', 'two-shot key:');
    for (const key of Object.keys(CHECK_RISK_PROFILES)) {
      assert(/^[A-Z0-9-]+$/.test(checkRef(key)), `${key} → "${checkRef(key)}" is not quotable`);
    }
    /* Distinct keys must stay distinct once upper-cased and hyphenated. */
    const refs = Object.keys(CHECK_RISK_PROFILES).map(checkRef);
    eq(new Set(refs).size, refs.length, 'two checks share a reference:');
  });

  await it('a located feature is identified by where it is, not by its index', () => {
    const a = featureId(FEATURE_KINDS.slide, [12.4, 30.1, 5.0]);
    eq(a, featureId(FEATURE_KINDS.slide, [12.4, 30.1, 5.0]), 'the same place twice:');
    assert(a.startsWith('UCS-'), `the kind should be readable: ${a}`);
    assert(a.length <= 12, `too long to write in an email: ${a}`);
    /* A slide and a lifter at the same place are different findings, and the
       prefix is what says so. */
    const lifter = featureId(FEATURE_KINDS.lifter, [12.4, 30.1, 5.0]);
    assert(lifter !== a, 'kind must discriminate');
    eq(lifter.split('-')[1], a.split('-')[1],
      'the same place should hash the same whichever action it needs:');
  });

  await it('survives a move smaller than the grid, and not one larger', () => {
    /*
     * This is the property the id exists for and the one worth stating: a
     * response written against last month's revision still matches a boss
     * that moved a tenth, and does not match one that moved across the part.
     * The consequence is intended, and documented at the grid constant.
     */
    /* Stated in millimetres rather than in grid cells, so the assertion is
       about the behaviour someone gets and not about whatever the constant
       happens to be: a quarter of a millimetre is a revision tweak and must
       survive, twenty millimetres is somewhere else and must not. */
    const base = [20, 20, 20];
    eq(featureId('UCS', [20.25, 19.75, 20]), featureId('UCS', base),
      'a quarter-millimetre move:');
    assert(featureId('UCS', [40, 20, 20]) !== featureId('UCS', base),
      'a twenty-millimetre move must produce a different reference');
    assert(FEATURE_GRID_MM >= 0.5 && FEATURE_GRID_MM <= 5,
      `the grid is ${FEATURE_GRID_MM} mm, which is outside what those two statements can both hold for`);
  });

  await it('does not depend on the sign of zero, or on how the number was reached', () => {
    /* -0 and 0 stringify differently, which would give one physical place two
       references depending on which way a centroid was averaged into it. */
    eq(featureId('WT', [-0, 0, -0]), featureId('WT', [0, 0, 0]), 'negative zero:');
    eq(featureId('WT', [0.1 + 0.2, 0, 0]), featureId('WT', [0.3, 0, 0]),
      'floating-point noise well inside the grid:');
  });

  await it('a wall transition carries one too', () => {
    /* The other located finding. Same requirement, and the same measurement
       rather than an assertion about the helper: two analyses of one part
       must agree transition for transition. */
    const soup = S.subdivideSoup(S.hollowBox([40, 30, 20], 2), 1);
    const step = S.toSoup([
      ...soup.positions,
      ...S.subdivideSoup(S.box([10, 10, 26]), 1).positions,
    ]);
    const first = analyse(weld(step), { suggestGate: false });
    const second = analyse(weld(step), { suggestGate: false });
    const ids = (a) => (a.wallTransitions || []).map((t) => t.id);
    assert(ids(first).length > 0, 'the fixture should produce wall transitions to identify');
    eq(ids(first).join(','), ids(second).join(','), 'transition references across two runs:');
    for (const id of ids(first)) assert(/^WT-[A-Z0-9]+$/.test(id), `malformed reference ${id}`);
  });

  await it('two runs of the same part give every region the same reference', () => {
    /* The exit criterion, measured rather than asserted about the helper: two
       analyses of the same geometry, and the ids have to agree region for
       region — including across the sort, which orders by area. */
    /* Two analyses on purpose: reproducibility is the subject, so the
       memoised fixture would assert nothing. */
    const soup = S.internalLedgeCup();
    const first = analyse(weld(soup), { suggestGate: false });
    const second = analyse(weld(soup), { suggestGate: false });
    const ids = (a) => (a.undercutRegions || []).filter((r) => r.area > 1).map((r) => r.id);
    const one = ids(first);
    assert(one.length > 0, 'the fixture should produce undercut regions to identify');
    eq(one.join(','), ids(second).join(','), 'region references across two runs:');
    eq(new Set(one).size, one.length, `two regions share a reference: ${one.join(', ')}`);
    for (const id of one) assert(/^UC[SL]-[A-Z0-9]+$/.test(id), `malformed reference ${id}`);
  });

  await it('a region reference does not move when another region appears', () => {
    /*
     * The defect this replaces. Regions are sorted by area, so adding one
     * elsewhere on the part used to renumber the rest — and a factory's "point
     * 3" then pointed at something else entirely.
     */
    const plain = LEDGE_CUP();
    const more = analysedFixture('ledge-cup-2', () => S.internalLedgeCup({ ledgeZ: [8, 2] }));
    const byId = (a) => new Map((a.undercutRegions || [])
      .filter((r) => r.area > 1).map((r) => [r.id, r]));
    const before = byId(plain);
    const after = byId(more);
    const shared = [...before.keys()].filter((id) => after.has(id));
    assert(shared.length > 0,
      `no region survived the addition: ${[...before.keys()].join(',')} vs ${[...after.keys()].join(',')}`);
    for (const id of shared) {
      close(after.get(id).centroid[2], before.get(id).centroid[2], FEATURE_GRID_MM,
        `${id} kept its reference but moved:`);
    }
  });
}

describe('build identity');
{
  await it('an unbuilt source tree says so rather than claiming a version', () => {
    /* These tests run against src/, which build.js has not substituted. The
       honest answer is "not a build", and every artifact made here has to
       carry that rather than a version number it did not come from. */
    eq(TOOL_VERSION, 'dev', 'version from source:');
    eq(BUILD_FINGERPRINT, 'source', 'fingerprint from source:');
    eq(buildIdentity().built, false, 'built:');
    eq(buildIdentity().release, null, 'release:');
    assert(buildLabel().includes('dev'), `label: ${buildLabel()}`);
  });

  await it('the export carries every reference a response could be written against', () => {
    /* An export that omits the references is an export nobody can answer
       point by point, which is the whole reason they exist. */
    const mesh = LEDGE_CUP();
    const r = runDFM({ ...CLEAN_INPUT, mesh });
    const json = buildExportJSON({
      sessionId: 'TEST', dfm: { input: CLEAN_INPUT, result: r },
      analysis: mesh, twoShot: null, interface: null, validation: null,
      settings: { analysisMode: 'single', windowType: 'none' },
    });
    for (const c of json.checks) {
      eq(c.ref, checkRef(c.key), `check ${c.key} reference:`);
    }
    const regions = json.mesh_summary.undercut_regions;
    assert(regions.length > 0, 'the fixture should export undercut regions');
    for (const region of regions) {
      assert(/^UC[SL]-[A-Z0-9]+$/.test(region.id || ''),
        `exported region has no usable reference: ${JSON.stringify(region.id)}`);
    }
    /* Same references the analysis produced, not a second set minted here. */
    const fromAnalysis = mesh.undercutRegions.filter((x) => x.area > 1).map((x) => x.id);
    eq(regions.map((x) => x.id).join(','), fromAnalysis.join(','), 'exported vs measured:');
  });

  await it('every export carries the same identity, from one place', () => {
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowBox([40, 30, 20], 2)) });
    const json = buildExportJSON({
      sessionId: 'TEST', dfm: { input: CLEAN_INPUT, result: r },
      analysis: null, twoShot: null, interface: null, validation: null,
      settings: { analysisMode: 'single', windowType: 'none' },
    });
    /* Not a copy of the block, but the block: a second description of the
       build is a second thing that can be wrong. */
    eq(JSON.stringify(json.build), JSON.stringify(buildIdentity()), 'export build block:');
    for (const k of ['tool_version', 'source_fingerprint', 'release', 'built']) {
      assert(k in json.build, `the export is missing build.${k}`);
    }
  });
}

// ── release gates ──────────────────────────────────────────────────────────

{
  describe('release: the tag, the version and the changelog');

  await it('a release tag is v followed by a whole version, and nothing else', () => {
    eq(tagVersion('v2.1.0'), '2.1.0', 'plain tag:');
    eq(tagVersion('v2.1.0-rc.1'), '2.1.0-rc.1', 'pre-release tag:');
    eq(tagVersion('  v2.1.0  '), '2.1.0', 'surrounding whitespace:');
    /* Each of these is a plausible thing to type and none of them is
       interpreted, because a tag is permanent and two spellings of one
       release pointing at different commits is unrecoverable. */
    for (const bad of ['2.1.0', 'v2.1', 'v2', 'release-2.1.0', 'v2.1.0+build.7', 'v 2.1.0', 'vX.Y.Z', '', null, undefined]) {
      eq(tagVersion(bad), null, `rejects ${JSON.stringify(bad)}:`);
    }
  });

  await it('a pre-release suffix is what marks a pre-release', () => {
    assert(!isPrerelease('2.1.0'), '2.1.0 is not a pre-release');
    assert(isPrerelease('2.1.0-rc.1'), '2.1.0-rc.1 is a pre-release');
    assert(isPrerelease('2.1.0-beta'), '2.1.0-beta is a pre-release');
  });

  const DOC = [
    '# Changelog', '', 'preamble', '', '---', '',
    '## Unreleased', '', 'nothing yet', '',
    '## v2.1.0 — 2026-09-09', '', 'the notes', '', '### Added', '', '- a thing', '',
    '---', '',
    '## v2.0.0 — 2026-08-17', '', 'older notes', '',
    '## v1.9.0 — 2026-01-01', '',
  ].join('\n');

  await it('a section stops at the next release and keeps its own subsections', () => {
    const notes = section(DOC, 'v2.1.0');
    assert(notes.includes('the notes'), 'the section body is missing');
    assert(notes.includes('### Added'), 'a subsection of the release was dropped');
    assert(notes.includes('- a thing'), 'a subsection\'s content was dropped');
    assert(!notes.includes('older notes'), 'the next release bled into this one');
    assert(!notes.includes('nothing yet'), 'the previous section bled into this one');
    /* The rule between sections belongs to neither. */
    assert(!/-{3,}\s*$/.test(notes), `a horizontal rule was kept: ${JSON.stringify(notes.slice(-20))}`);
  });

  await it('a date after the version does not stop the heading matching', () => {
    assert(section(DOC, 'v2.0.0') !== null, 'a dated heading was not found');
    eq(section(DOC, 'v2.0.0'), 'older notes', 'dated heading body:');
  });

  await it('a missing section and an empty one are told apart', () => {
    eq(section(DOC, 'v3.0.0'), null, 'a heading that is not there:');
    eq(section(DOC, 'v1.9.0'), '', 'a heading with nothing under it:');
  });

  await it('a version is not a prefix of another version', () => {
    /* `v2.1.0` must not match `v2.1.0-rc.1`, or releasing the candidate would
       publish the release's notes and vice versa. */
    const doc = '## v2.1.0-rc.1\n\ncandidate\n\n## v2.1.0\n\nfinal\n';
    eq(section(doc, 'v2.1.0'), 'final', 'the release:');
    eq(section(doc, 'v2.1.0-rc.1'), 'candidate', 'the candidate:');
  });

  await it('every problem with a release is reported at once', () => {
    /* Bumped neither package.json nor the changelog: two mistakes, and being
       told about the second one after fixing the first costs another tag. */
    const problems = releaseProblems('v2.1.0', { version: '2.0.0', changelog: DOC.replace('## v2.1.0 — 2026-09-09', '## v9.9.9') });
    eq(problems.length, 2, 'problems found:');
    assert(problems.some((p) => p.includes('2.0.0') && p.includes('2.1.0')), 'the version mismatch does not name both versions');
    /* Specifically the *missing* one. A section that exists and is empty has
       its own message, and the two must not be able to stand in for each
       other — "add the section" and "fill the section in" are different
       instructions. */
    assert(problems.some((p) => p.includes('has no "## v2.1.0" section')), `the missing changelog section was not reported: ${problems.join(' | ')}`);
  });

  await it('a bad tag is the only thing reported, because nothing else can be checked', () => {
    const problems = releaseProblems('2.1.0', { version: '2.1.0', changelog: DOC });
    eq(problems.length, 1, 'problems found:');
    assert(problems[0].includes('not a release tag'), `unexpected problem: ${problems[0]}`);
  });

  await it('an empty section is a problem in its own right', () => {
    const problems = releaseProblems('v1.9.0', { version: '1.9.0', changelog: DOC });
    eq(problems.length, 1, 'problems found:');
    assert(problems[0].includes('nothing in it'), `unexpected problem: ${problems[0]}`);
  });

  await it('a release that lines up has no problems, and its notes are the section', () => {
    eq(releaseProblems('v2.1.0', { version: '2.1.0', changelog: DOC }).length, 0, 'problems:');
    eq(releaseNotes(DOC, '2.1.0'), section(DOC, 'v2.1.0'), 'notes:');
  });

  await it("this repository's own changelog satisfies the gates it will be judged by", () => {
    const doc = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
    assert(section(doc, 'Unreleased') !== null, 'CHANGELOG.md has no Unreleased section');
    /* Every release heading must name a version this tool would accept as a
       tag, and carry something. A heading added by hand in the wrong shape
       would otherwise only be discovered by a release failing. */
    const headings = [...doc.matchAll(/^##\s+(v\S+)/gm)].map((m) => m[1]);
    for (const h of headings) {
      assert(tagVersion(h) !== null, `CHANGELOG.md heading "${h}" is not a version a tag could name`);
      assert(section(doc, h), `CHANGELOG.md section "${h}" is empty`);
    }
  });

  await it('the release workflow checks the cheap thing first', () => {
    /* The gate above costs a second and the browser suite costs minutes.
       Ordering them the other way round is a real temptation when adding a
       step, and the cost of getting it wrong is invisible until a release
       fails four minutes in. */
    const yml = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
    assert(/tags:\s*\['v\*'\]/.test(yml), 'the release workflow does not fire on v* tags');
    const gate = yml.indexOf('node release.js');
    const browser = yml.indexOf('playwright install');
    assert(gate > 0, 'the release workflow does not run the release gate');
    assert(browser > 0, 'the release workflow does not install a browser');
    assert(gate < browser, 'the release gate runs after the browser download');
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
console.log(`  ${passed} assertions passed\n`);
