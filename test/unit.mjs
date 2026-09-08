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
import { compareRuns } from '../src/rules/compare.js';
import { buildIdentity, buildLabel, TOOL_VERSION, BUILD_FINGERPRINT } from '../src/core/build-info.js';
import { featureId, checkRef, FEATURE_GRID_MM, FEATURE_KINDS } from '../src/rules/findings.js';
import { estimateShot, nextMachineSize, CAVITY_PRESSURE_MPA } from '../src/analysis/shot.js';
import {
  estimateCycle, estimatePartCost, toolingDrivers,
  PRACTICAL_COOLING_FACTOR, COOLING_SHARE,
} from '../src/analysis/cost.js';
import { searchGateCandidates, computeFlowLengths, buildAdjacency, geodesicFrom } from '../src/analysis/flow.js';
import { jacobiEigen } from '../src/analysis/linalg.js';
import {
  registerShots, fitRigid, rotationDegOf, identityXform, xformPoint,
  ENGAGE_FRACTION, ENGAGE_FLOOR_MM, RESIDUAL_IMPROVE, REGISTER_TRIM,
} from '../src/analysis/register.js';
import { analyseInterface } from '../src/analysis/interface.js';
import { analyseFpcRegion, FPC_SAMPLES, MAX_CROSSINGS } from '../src/analysis/fpc.js';
import { castRayAll } from '../src/geometry/bvh.js';
import { effectiveMinDraft } from '../src/core/finishes.js';
import { MATERIALS, MATERIAL_ORDER } from '../src/core/materials.js';
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

  it('every coefficient implies a diffusivity a real polymer has', () => {
    for (const key of MATERIAL_ORDER) {
      const a = impliedAlpha(key);
      assert(a >= DIFFUSIVITY_LO && a <= DIFFUSIVITY_HI,
        `${MATERIALS[key].name}: coolK ${MATERIALS[key].coolK} implies α = ${a.toFixed(4)} mm²/s, outside ${DIFFUSIVITY_LO}–${DIFFUSIVITY_HI}`);
    }
  });

  it('the half-wall reading is impossible for every material, not merely unlikely', () => {
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

  it('a 2 mm wall cools in seconds, not in a fraction of one', () => {
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
  it('the cooling floor is k·s² on the full wall, and nothing else', () => {
    /* The number the coolK derivation settled. If this ever disagrees with
       coolK × wall², the convention has drifted again. */
    const c = estimateCycle({ material: MATERIALS.abs, wallMm: 2 });
    close(c.coolingFloorS, MATERIALS.abs.coolK * 4, 1e-9, 'cooling floor:');
  });

  it('the floor is a floor: practical cooling and the cycle are both longer', () => {
    const c = estimateCycle({ material: MATERIALS.abs, wallMm: 2 });
    assert(c.practicalCoolingS > c.coolingFloorS, 'practical cooling did not exceed the floor');
    assert(c.cycleS.lo > c.practicalCoolingS, 'the cycle was shorter than the cooling inside it');
    assert(c.cycleS.hi > c.cycleS.lo, 'the cycle band is inverted');
  });

  it('each step is the stated factor, not a hidden one', () => {
    /* The point of publishing the factors is that a reader can check them. */
    const c = estimateCycle({ material: MATERIALS.pc, wallMm: 3 });
    close(c.practicalCoolingS, c.coolingFloorS * PRACTICAL_COOLING_FACTOR, 1e-9, 'practical cooling:');
    close(c.cycleS.lo, c.practicalCoolingS / COOLING_SHARE.hi, 1e-9, 'cycle lo:');
    close(c.cycleS.hi, c.practicalCoolingS / COOLING_SHARE.lo, 1e-9, 'cycle hi:');
  });

  it('cooling goes as the square of the wall', () => {
    const thin = estimateCycle({ material: MATERIALS.abs, wallMm: 1 });
    const thick = estimateCycle({ material: MATERIALS.abs, wallMm: 2 });
    close(thick.coolingFloorS / thin.coolingFloorS, 4, 1e-9, 'doubling the wall:');
  });

  it('output scales with cavities but the cycle does not', () => {
    const one = estimateCycle({ material: MATERIALS.abs, wallMm: 2, cavities: 1 });
    const four = estimateCycle({ material: MATERIALS.abs, wallMm: 2, cavities: 4 });
    close(four.cycleS.lo, one.cycleS.lo, 1e-9, 'cycle with more cavities:');
    close(four.partsPerHour.lo, one.partsPerHour.lo * 4, 1e-6, 'parts per hour:');
  });

  it('an unmeasured part gets no cycle time and says why', () => {
    const c = estimateCycle({ material: MATERIALS.abs, wallMm: null });
    eq(c.coolingFloorS, null, 'cooling floor without a wall:');
    assert(/needs a wall thickness/.test(c.notes.join(' ')), `no explanation given: ${c.notes}`);
  });

  it('every assumption is published with the number', () => {
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

  it('no rate, no cost — and the reason names what is missing', () => {
    /* The rule the module exists to keep: a plausible-looking default resin
       price would be indistinguishable on screen from a real quotation. */
    const c = estimatePartCost({ shotMassG: 10, cycleS, cavities: 1 });
    eq(c.totalCost, null, 'total without rates:');
    eq(c.materialCost, null, 'material without a resin price:');
    assert(c.missing.some((m) => /resin price/.test(m)), `missing did not name the resin price: ${c.missing}`);
    assert(c.missing.some((m) => /machine rate/.test(m)), `missing did not name the machine rate: ${c.missing}`);
  });

  it('material is shot weight at the price given', () => {
    const c = estimatePartCost({ shotMassG: 10, cycleS, resinPerKg: 2, machinePerHour: 60 });
    close(c.materialCost, 0.02, 1e-9, '10 g at 2/kg:');
  });

  it('scrap is an allowance on material, not on machine time', () => {
    const plain = estimatePartCost({ shotMassG: 10, cycleS, resinPerKg: 2, machinePerHour: 60 });
    const scrap = estimatePartCost({ shotMassG: 10, cycleS, resinPerKg: 2, machinePerHour: 60, scrapPct: 10 });
    close(scrap.materialCost, plain.materialCost * 1.1, 1e-9, 'material with 10% scrap:');
    close(scrap.machineCost.lo, plain.machineCost.lo, 1e-9, 'machine cost with scrap:');
  });

  it('machine time is shared across the cavities', () => {
    const one = estimatePartCost({ shotMassG: 10, cycleS, cavities: 1, resinPerKg: 2, machinePerHour: 3600 });
    const four = estimatePartCost({ shotMassG: 10, cycleS, cavities: 4, resinPerKg: 2, machinePerHour: 3600 });
    /* 3600/hour is 1 per second, so a 10 s cycle is 10 in one cavity. */
    close(one.machineCost.lo, 10, 1e-9, 'machine cost, one cavity:');
    close(four.machineCost.lo, 2.5, 1e-9, 'machine cost, four cavities:');
  });

  it('the total is material plus machine and nothing else', () => {
    const c = estimatePartCost({ shotMassG: 10, cycleS, resinPerKg: 2, machinePerHour: 3600 });
    close(c.totalCost.lo, c.materialCost + c.machineCost.lo, 1e-9, 'total lo:');
    close(c.totalCost.hi, c.materialCost + c.machineCost.hi, 1e-9, 'total hi:');
  });

  it('it says out loud that it is not a piece price', () => {
    /* The caveat is the point. A figure this shape gets pasted into a
       spreadsheet, and the spreadsheet does not carry the tooltip. */
    const c = estimatePartCost({ shotMassG: 10, cycleS, resinPerKg: 2, machinePerHour: 60 });
    assert(/labour|margin|overhead/i.test(c.notes.join(' ')), `no caveat given: ${c.notes}`);
  });
}

describe('cost — and the score, which must not notice it');
{
  it('nothing about cost or cycle time can move the score', () => {
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

  it('slides and lifters are counted the way the undercut check counts them', () => {
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

  it('a part needing no moving tooling is told so', () => {
    const t = toolingDrivers({ analysis: { undercutRegions: [] }, material: mat, cavities: 1 });
    assert(t.drivers.some((d) => /No moving tooling/.test(d.driver)), 'the clean case went unsaid');
  });

  it('an abrasive material is a tool-life driver', () => {
    const t = toolingDrivers({ analysis: { undercutRegions: [] }, material: MATERIALS.pa66gf, cavities: 1 });
    assert(t.drivers.some((d) => /abrasive/i.test(d.driver)), 'glass fill was not flagged');
  });

  it('it never produces a currency figure', () => {
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

  it('the moving-tooling count inherits the parting-line assumption, and says so', () => {
    const t = toolingDrivers({
      analysis: { undercutRegions: [{ type: 1, area: 40 }] }, material: mat, cavities: 1,
    });
    assert(/features needing a decision/i.test(t.partingCaveat),
      'the count is presented as a slide count rather than as features to decide');
  });
}

describe('scoring — the weight table');
{
  it('the checks that run by default sum to exactly 100', () => {
    const total = DEFAULT_CHECK_KEYS.reduce((sum, k) => sum + CHECK_RISK_PROFILES[k].weight, 0);
    eq(total, 100, 'default budget:');
  });

  it('the two-shot table sums to 100 as well', () => {
    /* The thermal check gave up its 25 points when melt-versus-HDT stopped
       being scored; they were redistributed across the surviving five in
       proportion, so the interface score is still out of a full 100. */
    const total = Object.values(TWO_SHOT_RISK_PROFILES).reduce((sum, p) => sum + p.weight, 0);
    eq(total, 100, 'two-shot budget:');
    eq(TWO_SHOT_RISK_PROFILES.ts_thermal.weight, 0, 'thermal advisory weight:');
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

  it('the JSON export says which frame the interface figures are in', () => {
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

  it('substrate softening is an advisory, not a graded verdict', () => {
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

  it('the check and the property it needs are locked to each other', () => {
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

  it('the fusion pairs that HDT condemned now grade on adhesion', () => {
    for (const [a, b] of [['pcasa', 'asa_n'], ['asa_n', 'pcasa'], ['asa', 'asa_n'], ['asa', 'asa']]) {
      const ts = runTwoShotDFM({ mat1: a, mat2: b, interface: null, opticalWindow: 'none' });
      eq(ts.criticalCount, 0, `${a}+${b} critical findings:`);
      eq(ts.grade.label, 'INTERFACE OK', `${a}+${b} graded on score ${ts.score}:`);
    }
  });


  it('a genuinely incompatible pair is still condemned', () => {
    /* The counterweight to the test above: relaxing the fusion case must not
       have relaxed the case the rule exists for. */
    const ts = runTwoShotDFM({ mat1: 'abs', mat2: 'pp', interface: null, opticalWindow: 'none' });
    eq(ts.checks.find((c) => c.key === 'ts_adhesion').severity, 'critical', 'ABS+PP adhesion:');
    eq(ts.grade.label, 'NOT COMPATIBLE');
  });

  it('the textbook overmould pair is left with only its real finding', () => {
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

  it('polypropylene is no longer condemned as a substrate on temperature alone', () => {
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

  it('says when the rules may have moved between the two runs', () => {
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
    it(`${name}: matches a brute-force sweep of every triangle`, () => {
      const got = closestPoint(bvh, geom, px, py, pz, Infinity, out);
      const want = R.referenceClosestPoint(geom, px, py, pz);
      /* The reference samples a barycentric grid, so it can only over-report.
         The shipped answer must not exceed it, and must not fall far below. */
      assert(got <= want + 1e-9, `found ${got}, reference floor ${want}`);
      close(got, want, Math.max(0.05, want * 0.02), `${name}:`);
    });
  }

  it('the returned point lies on the surface, at the returned distance', () => {
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
      it(`lone triangle, ${region} region: matches the definition`, () => {
        const got = closestPoint(loneBvh, lone, px, py, pz, Infinity, out);
        const want = R.referenceClosestPoint(lone, px, py, pz, 200);
        assert(got <= want + 1e-9, `found ${got}, reference floor ${want}`);
        close(got, want, 0.01, `${region}:`);
      });
    }
  }

  it('respects the search cap, and reports Infinity beyond it', () => {
    /* 30 mm off the +z face: inside a 31 mm cap, outside a 29 mm one. */
    assert(isFinite(closestPoint(bvh, geom, 20, 15, 50, 31, out)), 'should find within 31 mm');
    eq(closestPoint(bvh, geom, 20, 15, 50, 29, out), Infinity, 'should not find within 29 mm:');
  });
}

describe('rigid fit — Horn quaternion');
{
  /* Proves the convention, which is the part of Horn's method that is easy to
     get transposed: a transposed correlation matrix yields the inverse
     rotation, which converges just as prettily onto the wrong pose. */
  const src = [];
  let seed = makeRandom(7);
  for (let i = 0; i < 40; i++) src.push(seed() * 60 - 30, seed() * 40 - 20, seed() * 20 - 10);

  for (const [name, axis, deg, t] of [
    ['pure translation', [0, 0, 1], 0, [12, -5, 3]],
    ['90° about z', [0, 0, 1], 90, [0, 0, 0]],
    ['25° about (1,2,3), translated', [1, 2, 3], 25, [15, -9, 7]],
    ['179° about y', [0, 1, 0], 179, [-4, 4, -4]],
  ]) {
    it(`recovers ${name}`, () => {
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

  it('declines a fit with fewer than three correspondences', () => {
    eq(fitRigid(new Float64Array(6), new Float64Array(6), Uint32Array.from([0, 1]), 2), null,
      'two points cannot fix a rotation:');
  });
}

describe('jacobiEigen at 4×4');
{
  /* Registration needs the 4×4 case, which the 3×3 cylinder fit never
     exercised. Checked against the definition — A·v = λv — rather than
     against a table of eigenvalues copied from somewhere. */
  it('every eigenpair satisfies A·v = λv, and they come out ascending', () => {
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

  it('a pair that arrives mated is left alone', () => {
    eq(aligned.reg.applied, false, 'nothing to correct:');
    eq(aligned.reg.reason, 'already-mated', 'reason:');
    eq(aligned.reg.transform, null, 'no transform:');
    close(aligned.reg.residualBefore, 0, 1e-3, 'residual at the interface:');
    close(aligned.iface.minThk, WALL, 0.01, 'min overmould thickness:');
    close(aligned.iface.avgThk, WALL, 0.01, 'avg overmould thickness:');
  });

  it('the mating surface is found by direction, not by keeping the closest few', () => {
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

  it('without registration a misaligned pair measures nonsense, not nothing', () => {
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

  it('registers a misaligned pair, and recovers the transform that was applied', () => {
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

  it('and the interface figures come back to the truth', () => {
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

  it('reports the residual it settled on, in millimetres', () => {
    const r = registered.reg;
    assert(r.residualRms >= 0 && r.residualP95 >= r.residualRms,
      `p95 ${r.residualP95} should not be below rms ${r.residualRms}`);
    assert(r.inlierCount > 100, `too few points behind the residual: ${r.inlierCount}`);
    assert(r.candidatesTried >= 3, `too few starting poses: ${r.candidatesTried}`);
    close(r.engageTol, Math.max(ENGAGE_FLOOR_MM, shot1.diag * ENGAGE_FRACTION), 1e-9, 'mating tolerance:');
  });

  it('leaves a pair no rigid move can mate alone, so the finding stands', () => {
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

  it('gives the same answer twice', () => {
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

  it('an improvement that stops short of mating is still not applied', () => {
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

  it('reports the residual of the pose it returns, not of the one before it', () => {
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

  it('says, in the finding, that the figures below were measured after the move', () => {
    const c = find(reg(APPLIED), 'ts_registration');
    assert(c, 'ts_registration should be present when a transform was applied');
    eq(c.status, 'warn', 'status:');
    assert(/measured after that move/.test(c.detail), 'must say which frame the figures are in');
    assert(c.detail.includes('18.8 mm'), 'must state how far shot 2 moved');
    assert(c.detail.includes('25.0°'), 'must state how far it was rotated');
    assert(c.detail.includes('0.000 mm'), 'must state the residual');
  });

  it('names both readings of a gap it cannot tell apart', () => {
    const c = find(reg(APPLIED), 'ts_registration');
    assert(/geometry cannot say/.test(c.detail), 'must not pick one');
    assert(/does not reach the substrate/.test(c.detail), 'must state the design-error reading');
    assert(/its own frame/.test(c.detail), 'must state the export-error reading');
    assert(/[Rr]e-export/.test(c.detail), 'must say how to settle it');
  });

  it('costs nothing, either way — the score cannot move on it', () => {
    const applied = reg(APPLIED);
    const declined = reg({ ...APPLIED, applied: false, reason: 'no-improvement', transform: null });
    eq(applied.score, baseline.score, 'applied vs no registration:');
    eq(declined.score, baseline.score, 'declined vs no registration:');
    eq(applied.budget, baseline.budget, 'budget must not widen:');
    eq(find(applied, 'ts_registration').scoreDeduction, 0, 'deduction:');
    eq(TWO_SHOT_RISK_PROFILES.ts_registration.weight, 0, 'weight:');
  });

  it('when nothing was applied, blames the geometry rather than the files', () => {
    const c = find(reg({
      ...APPLIED, applied: false, reason: 'no-improvement', transform: null,
      residualRms: 57, coveragePctBefore: 0, coveragePctAfter: 0,
    }), 'ts_registration');
    eq(c.status, 'info', 'status:');
    assert(/no transform was applied/.test(c.detail), 'must say nothing was moved');
    assert(/measured as loaded/.test(c.detail), 'must say which frame the figures are in');
    assert(/exported in millimetres/.test(c.detail), 'must name the likely causes');
  });

  it('and says so when the pair simply arrived mated', () => {
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

  it('the coverage finding says which frame it was measured in', () => {
    const applied = find(reg(APPLIED), 'ts_coverage');
    assert(/after the alignment above/.test(applied.detail), 'registered case:');
    const asLoaded = find(baseline, 'ts_coverage');
    assert(!/after the alignment/.test(asLoaded.detail), 'unregistered case must not claim it:');
  });

  it('a coverage failure that survived alignment points at the geometry', () => {
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

  it('reports both faces of a solid it passes through', () => {
    eq(castRayAll(bvh, geom, 5, 5, -3, 0, 0, 1, 1e-4, hits), 2, 'crossings:');
    close(hits[0], 3, 1e-6, 'entry:');
    close(hits[1], 13, 1e-6, 'exit:');
  });

  it('reports one crossing from inside, which is what fixes the parity', () => {
    /* The parity of the count is how the cover measurement knows which side
       of the surface a ray started on. */
    eq(castRayAll(bvh, geom, 5, 5, 4, 0, 0, 1, 1e-4, hits), 1, 'crossings from inside:');
    close(hits[0], 6, 1e-6, 'exit:');
  });

  it('merges the duplicate a ray through an edge produces', () => {
    /* Straight along the +x face at z = 10, which both triangles of the top
       face and both of the +z... the shared edge is reported by every
       incident triangle, and a duplicated crossing inverts the parity for the
       rest of the ray. */
    const n = castRayAll(bvh, geom, -5, 5, 10, 1, 0, 0, 1e-4, hits);
    for (let i = 1; i < n; i++) {
      assert(hits[i] - hits[i - 1] > 1e-4, `crossings ${i - 1} and ${i} were not merged`);
    }
  });

  it('finds nothing along a ray that misses', () => {
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

    it('reports every crossing of a ray through several solids', () => {
      const wide = new Float64Array(16);
      eq(shoot(wide), 6, 'crossings:');
      for (let i = 0; i < 6; i++) close(wide[i], 5 + i * 10, 1e-6, `crossing ${i}:`);
    });

    it('refuses to answer at all once the buffer fills', () => {
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

    it('a ray down a facet diagonal spends the buffer twice over', () => {
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

  it('welding leaves the body ranges intact, which the designation depends on', () => {
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

  it('measures the cover the fixture was built with', () => {
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

  it('reads the same cover whether or not a clearance pocket was modelled', () => {
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

  it('reports thin cover as thin, and over how much of the insert', () => {
    const fx = S.slabWithInsert([40, 30, 0.9], 0.2);
    const { region } = measure(fx);
    close(region.coverStats.min, fx.cover, 0.01, 'min cover:');
    assert(region.coverStats.min < REQUIRED, 'the fixture should be under-covered');
    /* The two large faces are almost all of the insert's area, and both are
       thin, so nearly all of it is below the requirement. */
    assert(region.belowRequiredPct > 90,
      `expected nearly all of the insert under-covered, got ${region.belowRequiredPct.toFixed(1)}%`);
  });

  it('separates area with no cover from area with thin cover', () => {
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

  it('samples inside each facet, not only at its centre', () => {
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

  it('measures the distance from the gate to the insert', () => {
    const fx = S.slabWithInsert();
    /* A corner of the slab. The insert is centred, so the nearest point of it
       is the near corner of the plate: 10 mm in x, 10 mm in y, 1.9 in z. */
    const gate = [0, 0, 0];
    const { region } = measure(fx, { gate });
    close(region.gateDistance, Math.hypot(10, 10, 1.9), 0.05, 'gate to insert:');
  });

  it('reports no gate distance until a gate is picked', () => {
    const { region } = measure(S.slabWithInsert());
    eq(region.gateDistance, null, 'gate distance:');
  });

  it('declines to measure what has not been designated', () => {
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

  it('reports cover it could not follow as unknown, not as zero', () => {
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

  it('gives the same answer twice', () => {
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

  it('the part-wide FPC floor stands down once the insert is located', () => {
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

  it('judges the measured cover, and says that is what it did', () => {
    const c = find(runDFM({ ...FPC_ON, mesh: goodMesh, fpcRegion: goodRegion }), 'fpc');
    assert(/Cover over the insert is/.test(c.detail), 'must report the measured cover');
    assert(c.detail.includes('1.90 mm'), `must state the figure, got: ${c.detail.slice(0, 400)}`);
    const insert = c.metrics.find((m) => m[0] === 'Insert');
    eq(insert[1], 'Located — cover measured', 'metric:');
    assert(!c.metrics.some((m) => m[0] === 'Effective wall floor'),
      'the part-wide floor should not be quoted once the cover is measured');
  });

  it('and admits the part-wide version for what it is when it has to use it', () => {
    const c = find(runDFM({ ...FPC_ON, mesh: goodMesh, fpcRegion: null }), 'fpc');
    assert(/over-reports/.test(c.detail), 'must own the over-reporting');
    assert(/Solid bodies/.test(c.detail), 'must say how to get the measurement instead');
    eq(c.metrics.find((m) => m[0] === 'Insert')[1], 'Not located — judged part-wide', 'metric:');
  });

  it('fails a part whose cover is under what was asked for', () => {
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

  it('asks about exposed insert area rather than passing over it', () => {
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

  it('measures gate proximity instead of asking the reader to check it', () => {
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

  it('the export says whether the cover was measured or inferred', () => {
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

  it('keeps the advisory when the insert is located but no gate is picked', () => {
    const c = find(runDFM({ ...FPC_ON, mesh: goodMesh, fpcRegion: goodRegion }), 'fpc');
    assert(/Pick a gate location and re-run/.test(c.detail), 'must ask for a gate');
    assert(!c.metrics.some((m) => m[0] === 'Gate to insert'), 'and quote no distance');
  });
}


// ═══════════════════════════════════════════════════════════════════════════

describe('finding references');
{
  it('a check is quoted by its key, not by a second identifier', () => {
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

  it('a located feature is identified by where it is, not by its index', () => {
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

  it('survives a move smaller than the grid, and not one larger', () => {
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

  it('does not depend on the sign of zero, or on how the number was reached', () => {
    /* -0 and 0 stringify differently, which would give one physical place two
       references depending on which way a centroid was averaged into it. */
    eq(featureId('WT', [-0, 0, -0]), featureId('WT', [0, 0, 0]), 'negative zero:');
    eq(featureId('WT', [0.1 + 0.2, 0, 0]), featureId('WT', [0.3, 0, 0]),
      'floating-point noise well inside the grid:');
  });

  it('a wall transition carries one too', () => {
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

  it('two runs of the same part give every region the same reference', () => {
    /* The exit criterion, measured rather than asserted about the helper: two
       analyses of the same geometry, and the ids have to agree region for
       region — including across the sort, which orders by area. */
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

  it('a region reference does not move when another region appears', () => {
    /*
     * The defect this replaces. Regions are sorted by area, so adding one
     * elsewhere on the part used to renumber the rest — and a factory's "point
     * 3" then pointed at something else entirely.
     */
    const plain = analyse(weld(S.internalLedgeCup()), { suggestGate: false });
    const more = analyse(weld(S.internalLedgeCup({ ledgeZ: [8, 2] })), { suggestGate: false });
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
  it('an unbuilt source tree says so rather than claiming a version', () => {
    /* These tests run against src/, which build.js has not substituted. The
       honest answer is "not a build", and every artifact made here has to
       carry that rather than a version number it did not come from. */
    eq(TOOL_VERSION, 'dev', 'version from source:');
    eq(BUILD_FINGERPRINT, 'source', 'fingerprint from source:');
    eq(buildIdentity().built, false, 'built:');
    eq(buildIdentity().release, null, 'release:');
    assert(buildLabel().includes('dev'), `label: ${buildLabel()}`);
  });

  it('the export carries every reference a response could be written against', () => {
    /* An export that omits the references is an export nobody can answer
       point by point, which is the whole reason they exist. */
    const mesh = analyse(weld(S.internalLedgeCup()), { suggestGate: false });
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

  it('every export carries the same identity, from one place', () => {
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

// ── report ─────────────────────────────────────────────────────────────────

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} of ${passed + failures.length} assertions FAILED\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`  ${passed} assertions passed\n`);
