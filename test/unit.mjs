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
import * as S from './lib/shapes.mjs';
import * as R from './lib/reference.mjs';
import { weldGeometry } from '../src/geometry/weld.js';
import { castRay } from '../src/geometry/bvh.js';
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
import { compareRuns } from '../src/rules/compare.js';
import { estimateShot, nextMachineSize, CAVITY_PRESSURE_MPA } from '../src/analysis/shot.js';
import { searchGateCandidates, computeFlowLengths, buildAdjacency, geodesicFrom } from '../src/analysis/flow.js';
import { effectiveMinDraft } from '../src/core/finishes.js';
import { MATERIALS } from '../src/core/materials.js';
import { DEFAULT_SETTINGS } from '../src/app/state.js';

// ── harness ────────────────────────────────────────────────────────────────

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
    it(`${name}: jittered soup welds identically to clean`, () => {
      const clean = weld(soup);
      const dirty = weld(S.jitterSoup(soup));
      eq(clean.vertCount, expectVerts, 'clean vertex count:');
      eq(dirty.vertCount, expectVerts, 'jittered vertex count:');
      eq(R.referenceEdgeCensus(dirty).boundary, 0, 'jittered mesh must stay closed:');
    });
  }

  it('reports how many merges needed the neighbour probe', () => {
    const clean = weld(S.tube(20, 2, 40, 96));
    const dirty = weld(S.jitterSoup(S.tube(20, 2, 40, 96)));
    assert(dirty.weld.nearMerges > clean.weld.nearMerges,
      `jittered input should need more near merges (clean ${clean.weld.nearMerges}, jittered ${dirty.weld.nearMerges})`);
    assert(clean.weld.exactMerges > 0, 'clean input should merge mostly on the exact path');
  });

  it('a part far from the origin welds the same as one at it', () => {
    /* Quantising against the origin overflows int32 for a small part in a
       global CAD frame, silently welding unrelated vertices together. */
    const near = S.tube(20, 2, 40, 96);
    const far = {
      positions: Float32Array.from(near.positions, (v, i) => v + [4.0e6, 2.5e6, 1.0e6][i % 3]),
      triCount: near.triCount,
    };
    eq(weld(far).vertCount, weld(near).vertCount, 'vertex count at 4e6 mm offset:');
  });

  it('seams no longer corrupt flow length', () => {
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

  it('the same geometry gives bit-identical results across runs', () => {
    const runs = Array.from({ length: 4 }, () => analyse(geom).wallStats);
    for (const key of ['median', 'p5', 'p25', 'p75', 'p95', 'mean']) {
      const vals = runs.map((r) => r[key]);
      assert(vals.every((v) => v === vals[0]), `${key} drifted across runs: ${vals.join(', ')}`);
    }
  });

  it('sink and draft percentages are stable too', () => {
    const a = analyse(geom), b = analyse(geom);
    eq(a.sinkPctSevere, b.sinkPctSevere, 'severe sink area:');
    eq(a.sinkPctModerate, b.sinkPctModerate, 'moderate sink area:');
    eq(a.sidePctUnderMin, b.sidePctUnderMin, 'sidewall under min draft:');
  });

  it('the seed is genuinely in use, not ignored', () => {
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
  it('brackets the median', () => {
    const vals = Array.from({ length: 2000 }, (_, i) => Math.sin(i * 1.7) * 2 + 5);
    const s = stats(vals);
    assert(s.medLo <= s.median && s.median <= s.medHi,
      `CI [${s.medLo}, ${s.medHi}] does not contain median ${s.median}`);
  });

  it('narrows as the sample grows', () => {
    const gen = (n) => {
      const rnd = makeRandom(7);
      return stats(Array.from({ length: n }, () => rnd() * 4 + 1));
    };
    const small = gen(200), large = gen(20000);
    assert(large.medUncertainty < small.medUncertainty,
      `20k samples (±${large.medUncertainty}) should be tighter than 200 (±${small.medUncertainty})`);
  });

  it('a constant distribution has zero width', () => {
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
    it(`${name} measures ${truth} mm`, () => {
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

  it('equals the ray estimate on parallel walls', () => {
    for (const [name, soup] of [['hollow box', S.hollowBox()], ['tube', S.tube(20, 2, 40, 128)]]) {
      const wm = analyse(weld(soup)).wallMethod;
      close(wm.ratio, 1, 0.005, `${name}: sphere/ray ratio`);
    }
  });

  it('never exceeds the ray estimate', () => {
    /* It is a minimum over a set that includes the axial ray, so by
       construction it cannot come out larger. */
    for (const [name, soup] of battery) {
      const wm = analyse(weld(soup)).wallMethod;
      assert(wm.sphereMedian <= wm.rayMedian + 1e-6,
        `${name}: sphere ${wm.sphereMedian} exceeded ray ${wm.rayMedian}`);
    }
  });

  it('agrees with a 2561-ray brute-force reference', () => {
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
    it(`${deg}° frustum reads exactly ${deg}° on every side wall`, () => {
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

  it('the under-minimum area flips cleanly either side of the threshold', () => {
    const geom = weld(S.frustum(20, 30, 3));
    close(analyse(geom, { minDraft: 2.9 }).sidePctUnderMin, 0, 0.01, 'at 2.9° required:');
    close(analyse(geom, { minDraft: 3.1 }).sidePctUnderMin, 100, 0.01, 'at 3.1° required:');
  });
}

describe('validation — topology');
{
  it('a closed box is sound', () => {
    const v = validateGeometry(weld(S.box([40, 30, 20])));
    eq(v.confidence, 'high'); eq(v.closed, true); eq(v.inverted, false);
    eq(v.analysable, true);
    close(v.volume, 24000, 1, 'enclosed volume:');
    eq(v.issues.length, 0, 'issue count:');
  });

  it('an open box is detected, with the right edge count', () => {
    const geom = weld(S.box([40, 30, 20], { omit: ['pz'] }));
    const v = validateGeometry(geom);
    eq(v.closed, false);
    eq(v.edges.boundary, R.referenceEdgeCensus(geom).boundary, 'boundary edges vs reference:');
    eq(v.edges.boundary, 4);
    eq(v.volume, null, 'volume must not be reported for an open surface');
    assert(v.issues.some((i) => i.code === 'open-mesh'), 'no open-mesh issue raised');
  });

  it('inverted normals are detected and the offered fix works', () => {
    const bad = weld(S.box([40, 30, 20], { invert: true }));
    const vBad = validateGeometry(bad);
    eq(vBad.inverted, true);
    assert(R.referenceSignedVolume(bad) < 0, 'reference disagrees that this is inverted');
    const vFixed = validateGeometry(flipWinding(bad));
    eq(vFixed.inverted, false);
    eq(vFixed.confidence, 'high');
  });

  it('inconsistent winding is counted per affected edge', () => {
    const geom = weld(S.boxWithFlippedFace());
    const v = validateGeometry(geom);
    eq(v.windingConsistent, false);
    eq(v.edges.inconsistent, 4, 'one flipped quad has four edges:');
    eq(v.edges.inconsistent, R.referenceEdgeCensus(geom).inconsistent, 'vs reference:');
    eq(v.volume, null, 'volume is meaningless when winding disagrees');
  });

  it('non-manifold edges are found', () => {
    const geom = weld(S.box([40, 30, 20], { extraFin: true }));
    const v = validateGeometry(geom);
    eq(v.edges.nonManifold, 1);
    eq(v.edges.nonManifold, R.referenceEdgeCensus(geom).nonManifold, 'vs reference:');
  });

  it('a surface with no interior is refused rather than analysed', () => {
    const out = [];
    S.quad(out, [0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0]);
    const v = validateGeometry(weld(S.toSoup(out)));
    eq(v.analysable, false);
    eq(v.confidence, 'unusable');
  });

  it('every edge census agrees with the independent reference', () => {
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
  it('flags a part authored in inches', () => {
    const v = validateGeometry(weld(S.scaleSoup(S.tube(20, 2, 40), 1 / 25.4)));
    assert(v.scale.suspect, 'no scale suspicion raised');
    const fix = v.issues.find((i) => i.code === 'scale').fixes.find((f) => f.factor === 25.4);
    assert(fix, 'no inch→mm conversion offered');
  });

  it('flags a part authored in metres', () => {
    const v = validateGeometry(weld(S.scaleSoup(S.tube(20, 2, 40), 1 / 1000)));
    eq(v.scale.suspect, 'too-small');
    assert(v.issues.find((i) => i.code === 'scale').fixes.some((f) => f.factor === 1000),
      'no metre→mm conversion offered');
  });

  it('leaves a normal part alone', () => {
    const v = validateGeometry(weld(S.tube(20, 2, 40)));
    eq(v.scale.suspect, null);
  });

  it('asks rather than asserts on a genuinely small part', () => {
    /* An 8 mm clip is a real thing. It gets a question, not a verdict. */
    const v = validateGeometry(weld(S.scaleSoup(S.tube(20, 2, 40), 8 / 44.72)));
    eq(v.scale.suspect, 'maybe-inches');
    eq(v.scale.level, 'warn');
    eq(v.analysable, true);
  });

  it('rescaling restores the part exactly', () => {
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

describe('scoring — the weight table');
{
  it('the checks that run by default sum to exactly 100', () => {
    const total = DEFAULT_CHECK_KEYS.reduce((sum, k) => sum + CHECK_RISK_PROFILES[k].weight, 0);
    eq(total, 100, 'default budget:');
  });

  it('the two-shot table sums to 100 as well', () => {
    const total = Object.values(TWO_SHOT_RISK_PROFILES).reduce((sum, p) => sum + p.weight, 0);
    eq(total, 100, 'two-shot budget:');
  });

  it('the corner advisory holds no budget it could never spend', () => {
    eq(CHECK_RISK_PROFILES.corners.weight, 0);
  });

  it('every severity band deducts exactly its share of the weight', () => {
    for (const [key, profile] of Object.entries(CHECK_RISK_PROFILES)) {
      for (const [band, factor] of Object.entries(SEVERITY_FACTOR)) {
        const checks = [{ key, status: 'fail', severity: band }];
        const { totalDeduction } = scoreChecks(checks, PART_GRADES);
        close(totalDeduction, profile.weight * factor, 1e-9, `${key} at ${band}:`);
      }
    }
  });

  it('escalate only ever raises a severity', () => {
    eq(escalate('critical', 'minor'), 'critical');
    eq(escalate('minor', 'major'), 'major');
    eq(escalate('none', 'minor'), 'minor');
    eq(escalate(undefined, 'major'), 'major');
  });

  it('the score is exactly 100 × (1 − deduction / budget)', () => {
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowBox([40, 30, 20], 2)) });
    eq(r.score, Math.max(0, Math.round(100 * (1 - r.totalDeduction / r.budget))), 'reported score:');
  });
}

describe('scoring — advisories are not defects');
{
  it('a part with no findings scores exactly 100', () => {
    /* Before this, the same part scored 96: the flow check charged it 4.5
       points for a gate the user had not picked yet, and the corner advisory
       held 3 points of budget it could never spend. */
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowFrustum(20, 30, 3, 2)) });
    eq(r.score, 100, `score (deductions: ${r.checks.filter((c) => c.scoreDeduction > 0).map((c) => `${c.key} −${c.scoreDeduction}`).join(', ') || 'none'})`);
    eq(r.budget, 100, 'budget:');
    eq(r.criticalCount, 0, 'critical findings:');
    eq(r.grade.label, 'PRODUCTION READY');
  });

  it('not having picked a gate costs nothing', () => {
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowFrustum(20, 30, 3, 2)) });
    const flow = r.checks.find((c) => c.key === 'flow');
    eq(flow.status, 'info', 'status for an unrun check:');
    eq(flow.scoreDeduction, 0, 'deduction:');
    /* Still in the budget: the check is available and will deduct once it can
       actually measure something. */
    eq(CHECK_RISK_PROFILES.flow.weight > 0, true);
  });

  it('the corner advisory is marked as advice and costs nothing', () => {
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowFrustum(20, 30, 3, 2)) });
    const corners = r.checks.find((c) => c.key === 'corners');
    eq(corners.status, 'info');
    eq(corners.scoreDeduction, 0);
  });

  it('surface finish reports even when it passes, so the budget is stable', () => {
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
  it('one critical finding rules out PRODUCTION READY even at a high score', () => {
    /* A declared lifter is a critical finding on a 10-point check, so the
       arithmetic alone leaves 90 — comfortably inside the production-ready
       band, which would be an untraceable verdict. */
    const r = runDFM({ ...CLEAN_INPUT, hasUndercut: '2' });
    eq(r.criticalCount, 1, 'critical findings:');
    assert(r.score >= 85, `score should be high for this test to mean anything, got ${r.score}`);
    eq(r.grade.label, 'MINOR REWORK');
  });

  it('two criticals rule out MINOR REWORK', () => {
    const checks = [
      { key: 'wall', status: 'fail', severity: 'critical' },
      { key: 'draft', status: 'fail', severity: 'critical' },
    ];
    const { grade } = scoreChecks(checks, PART_GRADES);
    assert(['MAJOR REWORK', 'NOT MANUFACTURABLE'].includes(grade.label), `got ${grade.label}`);
  });

  it('the advisory checks cannot contribute a critical', () => {
    const { criticalCount } = scoreChecks([{ key: 'corners', status: 'fail', severity: 'critical' }], PART_GRADES);
    eq(criticalCount, 0, 'a zero-weight check must not gate the grade:');
  });
}

describe('scoring — draft follows the surface finish');
{
  it('the required draft includes the texture allowance', () => {
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

  it('a stated draft that clears the material minimum can still fail on texture', () => {
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

  it('the area figure is labelled with the threshold it was measured against', () => {
    const r = runDFM({ ...CLEAN_INPUT, surfaceFinish: 'edm-heavy', mesh: meshFor(S.hollowBox([40, 30, 20], 2), 'edm-heavy') });
    const draft = r.checks.find((c) => c.key === 'draft');
    const areaRow = draft.metrics.find(([k]) => k.startsWith('Area <'));
    assert(areaRow, 'no area metric');
    assert(areaRow[0].includes('6.50'), `area metric is labelled "${areaRow[0]}" but was measured against 6.50°`);
  });
}

describe('scoring — one source of truth');
{
  it('no check carries a penalty field any more', () => {
    const r = runDFM({ ...CLEAN_INPUT, mesh: meshFor(S.hollowBox([40, 30, 20], 2)) });
    for (const c of r.checks) {
      eq(c.penalty, undefined, `${c.key} still has a penalty field:`);
      assert(c.severity !== undefined, `${c.key} has no severity`);
      assert(c.weight !== undefined, `${c.key} has no weight`);
    }
  });

  it('the JSON export carries one deduction per check, not two', () => {
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

  it('two-shot scores through the same mechanism', () => {
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

  it('a check list with no findings scores 100', () => {
    const clean = Object.keys(TWO_SHOT_RISK_PROFILES).map((key) => ({ key, status: 'ok', severity: 'none' }));
    const { score, grade, budget } = scoreChecks(clean, INTERFACE_GRADES, TWO_SHOT_RISK_PROFILES);
    eq(score, 100); eq(budget, 100); eq(grade.label, 'INTERFACE OK');
  });

  it('a fusion weld is not graded as substrate destruction', () => {
    /* Two grades of the same polymer necessarily have shot 2's melt far above
       shot 1's HDT, so the thermal rule condemned every fusion pair in the
       compatibility table as a critical failure — while the adhesion check on
       the same page called them the strongest bond available. The ASA-natural
       window on a PC/ASA body, which is the reason those grades are in the
       table at all, came out MAJOR REWORK. */
    for (const [a, b] of [['pcasa', 'asa_n'], ['asa_n', 'pcasa'], ['asa', 'asa_n'], ['asa', 'asa']]) {
      const ts = runTwoShotDFM({ mat1: a, mat2: b, interface: null, opticalWindow: 'none' });
      const thermal = ts.checks.find((c) => c.key === 'ts_thermal');
      eq(thermal.severity, 'minor', `${a}+${b} thermal:`);
      eq(ts.criticalCount, 0, `${a}+${b} critical findings:`);
      eq(ts.grade.label, 'INTERFACE OK', `${a}+${b} graded on score ${ts.score}:`);
    }
  });

  it('a genuinely incompatible pair is still condemned', () => {
    /* The counterweight to the test above: relaxing the fusion case must not
       have relaxed the case the rule exists for. */
    const ts = runTwoShotDFM({ mat1: 'abs', mat2: 'pp', interface: null, opticalWindow: 'none' });
    eq(ts.checks.find((c) => c.key === 'ts_adhesion').severity, 'critical', 'ABS+PP adhesion:');
    eq(ts.checks.find((c) => c.key === 'ts_thermal').severity, 'critical', 'ABS+PP thermal:');
    eq(ts.grade.label, 'NOT COMPATIBLE');
  });

  it('the textbook overmould pair is not treated as a problem', () => {
    /* ABS with a TPU grip. The adhesion table calls it "Excellent. Classic
       over-mould pair", and TPU's 200 °C melt is above ABS's 98 °C HDT, as it
       is for essentially every real overmould — so the thermal advisory has to
       be a minor finding or the tool disagrees with itself. */
    const ts = runTwoShotDFM({ mat1: 'abs', mat2: 'tpu', interface: null, opticalWindow: 'none' });
    eq(ts.criticalCount, 0, 'critical findings on the classic pair:');
    eq(ts.checks.find((c) => c.key === 'ts_adhesion').severity, 'none', 'adhesion:');
    eq(ts.checks.find((c) => c.key === 'ts_thermal').severity, 'minor', 'thermal:');
    eq(ts.grade.label, 'INTERFACE OK', `score ${ts.score}, deductions: ${ts.checks.filter((c) => c.scoreDeduction > 0).map((c) => `${c.key} −${c.scoreDeduction}`).join(', ')}`);
  });
}


describe('undercuts — an overhang with a known answer');
{
  /* overhangBlock is a 14 mm overhang across a 30 mm extrusion: 420 mm² of
     external undercut, needing one slide that withdraws 14 mm in +X. */
  const EXPECT_AREA = 14 * 30;

  it('finds one slide region of the right area', () => {
    const m = analyse(weld(S.overhangBlock()));
    const regions = m.undercutRegions.filter((r) => r.area > 1);
    eq(regions.length, 1, 'region count:');
    eq(regions[0].type, 1, 'type (1 = slide):');
    within(regions[0].area, EXPECT_AREA, 1, 'undercut area:');
    within(m.slideArea, EXPECT_AREA, 1, 'total slide area:');
    eq(m.lifterArea, 0, 'lifter area:');
  });

  it('reports a usable retraction direction and stroke', () => {
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

  it('gives the same answer however finely the part is tessellated', () => {
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

  it('a straight-pull part reports nothing', () => {
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

  it('sink risk survives subsampling', () => {
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

  it('reports the coverage it actually achieved', () => {
    for (const cap of [2000, 400]) {
      const m = analyse(geom, { thicknessFullCap: cap });
      const stride = Math.ceil(geom.triCount / cap);
      within(m.thicknessCoverage, 1 / stride, 15, `cap ${cap} reported coverage:`);
    }
    eq(truth.thicknessCoverage, 1, 'full coverage below the cap:');
  });

  it('wall transitions stand down rather than under-report', () => {
    /* They need both triangles of an edge pair to carry a reading, which a
       partial pass almost never gives — so the check reports nothing found
       instead of quietly finding a fraction of what is there. */
    assert(truth.wallTransitions.length > 0, 'fixture should have transitions at full coverage');
    eq(analyse(geom, { thicknessFullCap: 2000 }).wallTransitions.length, 0);
  });

  it('subsampling stays reproducible', () => {
    const a = analyse(geom, { thicknessFullCap: 800 });
    const b = analyse(geom, { thicknessFullCap: 800 });
    eq(a.sinkPctSevere, b.sinkPctSevere, 'severe sink across runs:');
    eq(a.thicknessCoverage, b.thicknessCoverage, 'coverage across runs:');
  });
}


describe('projected area — the part\u2019s shadow along the pull axis');
{
  it('is exact on flat-sided shapes', () => {
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

  it('excludes a hole running along the pull axis', () => {
    /* A through-hole is formed by a core pin shutting off against the opposite
       half, so no melt bears on it and it must not count towards clamp force.
       Summing ½·Σ|n̂·p̂|·A over the triangles would give the full 1257 mm² disc;
       the answer is the 239 mm² annulus. */
    const m = analyse(weld(S.tube(20, 2, 40, 256)), { pullAxis: '+z' });
    const annulus = Math.PI * (20 * 20 - 18 * 18);
    within(m.projectedArea, annulus, 1, 'tube projected area:');
    assert(m.projectedArea < Math.PI * 400 * 0.25, 'the bore was counted as solid');
  });

  it('follows the pull direction', () => {
    const soup = S.box([40, 30, 20]);
    const z = analyse(weld(soup), { pullAxis: '+z' }).projectedArea;
    const x = analyse(weld(soup), { pullAxis: '+x' }).projectedArea;
    assert(z > x, `+Z (${z}) should project larger than +X (${x}) on this box`);
    within(analyse(weld(soup), { pullAxis: '-z' }).projectedArea, z, 0.5, 'pull sign must not matter:');
  });
}

describe('moulding estimates');
{
  it('mass is volume times density', () => {
    for (const key of ['abs', 'pp', 'pc', 'pa66gf']) {
      const material = MATERIALS[key];
      const e = estimateShot({ material, volume: 100000, projectedArea: 4000 });
      within(e.massG, 100 * material.density, 0.01, `${material.name} mass:`);
    }
  });

  it('clamp force is cavity pressure over projected area', () => {
    const e = estimateShot({ material: MATERIALS.abs, volume: 100000, projectedArea: 40000 });
    const band = CAVITY_PRESSURE_MPA[MATERIALS.abs.flow];
    within(e.clampTonnes.lo, 40000 * band.lo / 9806.65, 0.01, 'lower bound:');
    within(e.clampTonnes.hi, 40000 * band.hi / 9806.65, 0.01, 'upper bound:');
  });

  it('a stiffer-flowing material needs more clamp for the same part', () => {
    const shape = { volume: 100000, projectedArea: 40000 };
    const pp = estimateShot({ material: MATERIALS.pp, ...shape });
    const pc = estimateShot({ material: MATERIALS.pc, ...shape });
    assert(pc.clampTonnes.hi > pp.clampTonnes.hi,
      `PC (${pc.clampTonnes.hi.toFixed(0)} t) should need more clamp than PP (${pp.clampTonnes.hi.toFixed(0)} t)`);
  });

  it('machine size is the next standard clamp up, with margin', () => {
    const e = estimateShot({ material: MATERIALS.abs, volume: 180000, projectedArea: 40000 });
    assert(e.machineTonnes >= e.clampTonnes.hi * 1.15,
      `${e.machineTonnes} t does not cover ${e.clampTonnes.hi.toFixed(0)} t plus margin`);
    eq(nextMachineSize(0), 20, 'smallest standard size:');
    eq(nextMachineSize(121), 150);
    eq(nextMachineSize(1e9), null, 'past the largest machine:');
  });

  it('a runner allowance lands on the shot, not the part', () => {
    const e = estimateShot({ material: MATERIALS.abs, volume: 100000, projectedArea: 4000, runnerPct: 20 });
    within(e.shotMassG, e.massG * 1.2, 0.01, 'shot mass:');
    within(e.massG, 100 * MATERIALS.abs.density, 0.01, 'part mass is unchanged:');
  });

  it('refuses to invent a mass for a mesh with no enclosed volume', () => {
    /* The validator withholds volume on an open surface; this must not quietly
       substitute a zero or a bounding-box guess. */
    const e = estimateShot({ material: MATERIALS.abs, volume: null, projectedArea: 4000 });
    eq(e.massG, null);
    eq(e.shotMassG, null);
    assert(e.notes.some((n) => n.includes('enclosed volume')), 'no explanation offered');
    assert(e.clampTonnes !== null, 'clamp force does not need a volume and should still be given');
  });

  it('end to end, on a measured part', () => {
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

  it('runs when no gate was given, and not when one was', () => {
    assert(m.gateSuggestion, 'no suggestion produced for a part with no gate');
    assert(m.gateSuggestion.best, 'suggestion has no best candidate');
    const withGate = analyse(geom, { gateLocation: [100, 10, 2] });
    eq(withGate.gateSuggestion, null, 'searching is wasted once a gate is set:');
    assert(withGate.flowAnalysis, 'a set gate should produce a flow analysis');
  });

  it('picks the middle of a bar', () => {
    /* Anywhere in the middle third is a defensible answer; an end is not. */
    const x = m.gateSuggestion.best.point[0];
    assert(x > 66 && x < 134, `best gate at x=${x.toFixed(1)} is not in the middle third of a 0–200 bar`);
  });

  it('ranks every candidate above the one it beat', () => {
    const c = m.gateSuggestion.candidates;
    assert(c.length >= 8, `only ${c.length} candidates`);
    for (let i = 1; i < c.length; i++) {
      assert(c[i].maxLT >= c[i - 1].maxLT - 1e-9,
        `candidate ${i} (L/T ${c[i].maxLT}) ranked below ${i - 1} (L/T ${c[i - 1].maxLT})`);
    }
    eq(c[0], m.gateSuggestion.best, 'best is not the first candidate');
  });

  it('shows that the choice matters', () => {
    const { best, worst } = m.gateSuggestion;
    assert(worst.maxLT / best.maxLT > 1.5,
      `on a 200 mm bar the gate should matter a lot; got only ${(worst.maxLT / best.maxLT).toFixed(2)}×`);
  });

  it('agrees with the flow solver it will hand over to', () => {
    /* The suggestion is only useful if actually placing the gate there
       reproduces the L/T the search promised. */
    const promised = m.gateSuggestion.best;
    const actual = analyse(geom, { gateLocation: promised.point }).flowAnalysis;
    within(actual.maxLT, promised.maxLT, 0.1, 'L/T at the suggested gate:');
    within(actual.maxFlow, promised.maxFlow, 0.1, 'flow length at the suggested gate:');
  });

  it('only offers positions a sprue could reach', () => {
    /* Candidates come from outward-facing triangles: the inside of a cavity is
       not somewhere a gate can go. */
    const shell = weld(S.hollowFrustum(20, 30, 3, 2));
    const sm = analyse(shell);
    assert(sm.gateSuggestion, 'no suggestion for the shell');
    for (const c of sm.gateSuggestion.candidates) {
      eq(sm.triFaceSide[c.triangle], 0, `candidate on triangle ${c.triangle} is an inner face:`);
    }
  });

  it('is reproducible', () => {
    const a = analyse(geom).gateSuggestion.best;
    const b = analyse(geom).gateSuggestion.best;
    eq(a.triangle, b.triangle, 'chosen triangle across runs:');
    eq(a.maxLT, b.maxLT, 'L/T across runs:');
  });

  it('reuses one adjacency graph across candidates', () => {
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

  it('geodesic distance is zero at the source and rises away from it', () => {
    const graph = buildAdjacency(geom.indices, geom.triCount, geom.vertCount);
    const dist = geodesicFrom(geom.vertices, geom.vertCount, graph, 0);
    eq(dist[0], 0, 'distance to the source:');
    let reached = 0, maxD = 0;
    for (let v = 0; v < geom.vertCount; v++) {
      if (isFinite(dist[v])) { reached++; maxD = Math.max(maxD, dist[v]); }
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

  it('never recommends an axis the report finds undercuts on', () => {
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

  it('reports the same undercut area the analysis would', () => {
    const geom = weld(S.overhangBlock());
    for (const entry of suggestPullDirection(geom, { minDraft: 1 }).ranked) {
      within(entry.undercutArea, reportedUndercut(geom, entry.name), 1,
        `${entry.name}: suggestion vs analysis`);
    }
  });

  it('breaks ties on draft rather than arbitrarily', () => {
    /* Every axis on a drafted frustum is undercut-free, so the tie-break
       decides — and the only axis the part is actually drafted for is +Z. */
    const geom = weld(S.frustum(20, 30, 3));
    const s = suggestPullDirection(geom, { minDraft: 1 });
    eq(s.name, '+Z', `reason given: ${s.reason}`);
    eq(s.ranked[0].draftUnderMinPct, 0, 'the winning axis should have no under-draft area:');
  });

  it('ranks worst-first-last', () => {
    const ranked = suggestPullDirection(weld(S.overhangBlock()), { minDraft: 1 }).ranked;
    eq(ranked.length, 6, 'all six axes considered:');
    for (let i = 1; i < ranked.length; i++) {
      assert(ranked[i].undercutArea >= ranked[i - 1].undercutArea - 1e-6,
        `${ranked[i].name} ranked after ${ranked[i - 1].name} despite less undercut`);
    }
  });

  it('honours the mould type it is given', () => {
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

  it('reports the score movement and the grade change', () => {
    const d = compareRuns(undrafted, drafted);
    assert(d, 'no diff produced');
    eq(d.score.before, undrafted.score, 'before:');
    eq(d.score.after, drafted.score, 'after:');
    eq(d.score.delta, drafted.score - undrafted.score, 'delta:');
    assert(d.score.delta > 0, `fixing draft should raise the score, got ${d.score.delta}`);
    eq(d.grade.changed, undrafted.grade !== drafted.grade);
  });

  it('names the check that was resolved', () => {
    const d = compareRuns(undrafted, drafted);
    const draft = d.checks.find((c) => c.key === 'draft');
    eq(draft.change, 'improved', `draft went ${draft.severityBefore} → ${draft.severityAfter}:`);
    eq(draft.resolved, true, 'draft should read as resolved:');
    assert(/Resolved:.*Draft/i.test(d.headline), `headline does not mention it: "${d.headline}"`);
  });

  it('reads the reverse comparison as a regression', () => {
    const d = compareRuns(drafted, undrafted);
    assert(d.score.delta < 0, 'score should fall');
    const draft = d.checks.find((c) => c.key === 'draft');
    eq(draft.change, 'worsened');
    eq(draft.appeared, true, 'draft should read as newly appeared:');
    assert(/New:.*Draft/i.test(d.headline), `headline: "${d.headline}"`);
  });

  it('says nothing moved when nothing did', () => {
    const d = compareRuns(drafted, drafted);
    eq(d.score.delta, 0);
    eq(d.checks.every((c) => c.change === 'unchanged'), true,
      d.checks.filter((c) => c.change !== 'unchanged').map((c) => `${c.key}:${c.change}`).join(', '));
    assert(/No check changed band/.test(d.headline), d.headline);
  });

  it('tracks measurements that moved, with the right sense of better', () => {
    const d = compareRuns(undrafted, drafted);
    const draftArea = d.measurements.find((m) => m.label === 'Sidewall under draft');
    assert(draftArea, 'sidewall draft area not tracked');
    assert(draftArea.after < draftArea.before, 'under-draft area should fall');
    eq(draftArea.direction, 'better', 'less under-draft area is an improvement:');
  });

  it('warns when the comparison is not like for like', () => {
    /* A five-point gain from switching material is not a five-point gain in
       the part, and the panel has to say so. */
    const inAbs = record(S.hollowFrustum(20, 30, 3, 2));
    const inPp = record(S.hollowFrustum(20, 30, 3, 2), { material: 'pp' });
    const d = compareRuns(inAbs, inPp);
    assert(d.caveats.some((c) => /Material changed/.test(c)), `caveats: ${d.caveats.join(' | ')}`);
  });

  it('notices when the same geometry is compared with itself', () => {
    const d = compareRuns(drafted, drafted);
    assert(d.caveats.some((c) => /same geometry twice/.test(c)), `caveats: ${d.caveats.join(' | ')}`);
  });

  it('survives an older record with fields missing', () => {
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

  it('refuses to invent a comparison from nothing', () => {
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

  it('an enclosed internal feature needs a lifter, not a slide', () => {
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

  it('measures the enclosed features it finds', () => {
    const areas = cupMesh.undercutRegions.filter((r) => r.area > 1).map((r) => r.area).sort((a, b) => a - b);
    within(areas[0], LEDGE_AREA, 2, 'ledge underside area:');
    within(areas[1], CEILING_AREA, 2, 'cavity ceiling area:');
  });

  it('lifters are reportable in a two-piece mould at all', () => {
    /* They were not. Every candidate face in a two-piece tool points against
       the pull, and the branch that could yield a lifter required a face that
       did not — so the type was unreachable, while the rule engine had a whole
       critical-severity branch for it and the tooling panel rendered cards that
       could never appear. */
    const twoPiece = analyse(cup, { moldType: 'two-piece', suggestGate: false });
    assert(twoPiece.lifterArea > 0, 'still no lifter in two-piece mode');
  });

  it('describes a lifter that could be built', () => {
    const lifter = cupMesh.undercutRegions.find((r) => r.type === 2 && r.area > 1);
    assert(lifter.lifterAngleDeg > 0 && lifter.lifterAngleDeg <= 15,
      `lifter angle ${lifter.lifterAngleDeg.toFixed(1)}° is outside the slim-lifter limit`);
    assert(lifter.pullTravel > 0, 'lifter has no travel');
    close(Math.hypot(...lifter.action), 1, 1e-6, 'action must be a unit vector:');
  });

  it('an external feature is still a slide', () => {
    /* The counterweight: reclassifying enclosed features must not reclassify
       reachable ones. A barb on an outer wall has clear paths in. */
    const m = analyse(weld(S.overhangBlock()), { suggestGate: false });
    eq(m.lifterArea, 0, 'lifter area on a purely external undercut:');
    within(m.slideArea, 14 * 30, 1, 'slide area:');
    eq(m.undercutRegions.filter((r) => r.area > 1)[0].type, 1);
  });

  it('the rule engine treats a lifter as the more serious finding', () => {
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

  it('judges the part on the inscribed sphere, not the ray cast', () => {
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

  it('reports both measures so the gap is visible', () => {
    const mesh = analyse(weld(S.wedgeSlab(60, 30, 6, 45)), { suggestGate: false });
    const check = wallCheck(mesh);
    assert(metric(check, 'Sphere / ray'), 'no side-by-side metric');
    assert(/disagree by \d+%/.test(check.detail),
      `detail should call out the disagreement: ${check.detail.slice(0, 200)}`);
  });

  it('says nothing about a disagreement when there is none', () => {
    const mesh = analyse(weld(S.tube(20, 2, 40, 128)), { suggestGate: false });
    close(mesh.wallMethod.ratio, 1, 0.005, 'parallel walls should agree exactly:');
    assert(!/disagree by/.test(wallCheck(mesh).detail), 'spurious disagreement note');
  });

  it('falls back to the ray figure when the sphere pass did not run', () => {
    const mesh = analyse(weld(S.tube(20, 2, 40, 128)), { suggestGate: false });
    const stripped = { ...mesh, sphereStats: null };
    eq(metric(wallCheck(stripped), 'Measured as'), 'ray cast');
    within(parseFloat(metric(wallCheck(stripped), 'Nominal (median)')), mesh.wallStats.median, 1,
      'fallback nominal:');
  });

  it('still measures a uniform wall correctly either way', () => {
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

  it('leaves the sink check measuring ray against ray', () => {
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

  it('bossOD is finally read by something', () => {
    /* It had been collected, persisted and printed on the report since the
       rebuild without any rule looking at it. */
    const narrow = ribs({ bossOD: 4.0, bossWall: 1.0 });
    const wide = ribs({ bossOD: 6.0, bossWall: 1.0 });
    assert(window(narrow) !== window(wide), 'changing bossOD changed nothing');
  });

  it('accepts a boss wall inside both guidelines', () => {
    /* Ø4 with a 1 mm wall on a 2 mm part: screw retention wants ≥1.00 mm, the
       sink limit caps at 1.40 mm, so 1.00 sits in the window. */
    const check = ribs({ bossOD: 4.0, bossWall: 1.0 });
    eq(window(check), '1.00–1.40 mm');
    assert(!/cannot satisfy both/.test(check.detail), 'spurious conflict reported');
    assert(!/split around/.test(check.detail), 'spurious retention warning');
  });

  it('flags a boss wall too thin for its own hole', () => {
    const check = ribs({ bossOD: 4.0, bossWall: 0.8 });
    assert(/under the 1.00 mm/.test(check.detail), check.detail.slice(0, 200));
    /* And says there is room to fix it, which there is. */
    assert(/sink limit here is 1.40/.test(check.detail), 'no headroom stated');
    eq(check.severity, 'major');
  });

  it('names the bind when the two guidelines cannot both be met', () => {
    /* bossOD > 2.8 × wall makes the window empty: retention wants more boss
       wall than the sink limit allows, and no boss wall value satisfies both. */
    const check = ribs({ bossOD: 6.0, bossWall: 1.0 });
    assert(/cannot satisfy both/.test(check.detail), check.detail.slice(0, 220));
    eq(window(check), 'none — screw wants ≥1.50, sink caps at 1.40 mm');
    /* The resolutions are geometric, not a different boss wall. */
    assert(/gusset|support rib|core the boss/i.test(check.detail), 'no resolution offered');
  });

  it('reports the bind whatever the boss wall is set to', () => {
    /* The conflict is a property of the boss diameter against the part wall.
       Thickening the boss cannot resolve it, so the finding must not disappear
       when someone tries. */
    for (const bossWall of [0.8, 1.0, 1.4, 1.5, 2.0]) {
      assert(/cannot satisfy both/.test(ribs({ bossOD: 6.0, bossWall }).detail),
        `conflict vanished at bossWall ${bossWall}`);
    }
  });

  it('the bind goes away on a thicker wall', () => {
    /* Ø6 needs 1.50 mm; a 3 mm part wall caps at 2.10 mm, so there is a window. */
    const check = ribs({ bossOD: 6.0, bossWall: 1.5, wallThk: 3.0, ribThk: 1.35, ribH: 3.0 });
    eq(window(check), '1.50–2.10 mm');
    assert(!/cannot satisfy both/.test(check.detail), check.detail.slice(0, 200));
  });

  it('does not apply the screw guideline to a solid post', () => {
    const check = ribs({ bossOD: 2.0, bossWall: 1.0 });
    assert(/solid post/.test(check.detail), check.detail.slice(0, 160));
    eq(window(check), '—');
  });

  it('the shipped defaults satisfy their own guidelines', () => {
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
  it('status is raised to warn wherever a deduction exists', () => {
    /* Several rules escalate severity for a secondary finding without touching
       the status, which showed a green tick beside a deduction. */
    const list = [{ key: 'ribs', status: 'ok', severity: 'minor' }];
    scoreChecks(list, PART_GRADES);
    eq(list[0].status, 'warn');
    assert(list[0].scoreDeduction > 0, 'no deduction to justify the warn');
  });

  it('leaves a genuine pass alone', () => {
    const list = [{ key: 'ribs', status: 'ok', severity: 'none' }];
    scoreChecks(list, PART_GRADES);
    eq(list[0].status, 'ok');
    eq(list[0].scoreDeduction, 0);
  });

  it('leaves an advisory as an advisory', () => {
    const list = [{ key: 'corners', status: 'info', severity: 'none' }];
    scoreChecks(list, PART_GRADES);
    eq(list[0].status, 'info');
  });

  it('holds across every check the engine can emit', () => {
    const meshes = [
      analyse(weld(S.hollowFrustum(20, 30, 3, 2)), { suggestGate: false }),
      analyse(weld(S.hollowBox([40, 30, 20], 2)), { suggestGate: false }),
      analyse(weld(S.internalLedgeCup()), { suggestGate: false }),
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

// ── report ─────────────────────────────────────────────────────────────────

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} of ${passed + failures.length} assertions FAILED\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`  ${passed} assertions passed\n`);
