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
import { analyseMesh, CONE_RINGS_DEG, CONE_AZIMUTHS } from '../src/analysis/mesh.js';
import { stats, medianCI95, makeRandom } from '../src/analysis/stats.js';
import { runDFM } from '../src/rules/engine.js';
import { runTwoShotDFM } from '../src/rules/twoshot.js';
import {
  CHECK_RISK_PROFILES, TWO_SHOT_RISK_PROFILES, SEVERITY_FACTOR,
  scoreChecks, escalate, PART_GRADES, INTERFACE_GRADES,
} from '../src/rules/scoring.js';
import { buildExportJSON } from '../src/export/json.js';
import { effectiveMinDraft } from '../src/core/finishes.js';
import { MATERIALS } from '../src/core/materials.js';

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
  ribThk: 0.9, ribH: 2.0, ribRadius: 0.5, bossOD: 6.0, bossWall: 1.0,
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

// ── report ─────────────────────────────────────────────────────────────────

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} of ${passed + failures.length} assertions FAILED\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`  ${passed} assertions passed\n`);
