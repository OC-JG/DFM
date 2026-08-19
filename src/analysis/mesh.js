import { buildBVH, castRay } from '../geometry/bvh.js';
import { computeBounds } from '../geometry/weld.js';
import { stats, resolvePullDir, makeRandom } from './stats.js';
import { clusterUndercuts } from './undercuts.js';
import { detectWallTransitions } from './transitions.js';
import { computeFlowLengths, searchGateCandidates, buildAdjacency } from './flow.js';

/*
 * Mesh analysis: per-triangle draft, wall thickness, sink risk, undercuts,
 * wall transitions and flow length.
 *
 * This module is deliberately free of any DOM access. The original read
 * `document.getElementById('material').value` from the middle of the maths,
 * which made the analysis impossible to run off the main thread and — in
 * two-shot mode — silently analysed shot 2 using shot 1's material. Every
 * process input now arrives through `opts`.
 */

/* Above this triangle count, per-triangle thickness is subsampled. Full
   coverage is one BVH ray per triangle, which is affordable well past the
   old 20k limit, especially in a worker.

   Overridable through opts.thicknessFullCap: the behaviour either side of the
   threshold differs — sink coverage switches to a sampled denominator and
   transition detection turns itself off — and a test should be able to reach
   that path without building a 200,000-triangle fixture. */
const THICKNESS_FULL_CAP = 200000;

export function analyseMesh(geom, opts = {}) {
  const {
    material,
    finishKey = 'spi-a2',
    moldType = 'two-piece',
    minDraft: minDraftOpt,
    manualWall,
    gateLocation,
    samples = 3000,
    onProgress,
  } = opts;

  if (!material) throw new Error('analyseMesh requires a material');

  const [pdx, pdy, pdz] = resolvePullDir(opts.pullDir, opts.pullAxis);
  const { vertices, indices, triCount } = geom;

  const boundsInfo = computeBounds(vertices);
  const bbox = { min: boundsInfo.min, max: boundsInfo.max, size: boundsInfo.size };
  const diag = boundsInfo.diag;
  const eps = diag * 1e-5;

  const minDraft = minDraftOpt != null ? minDraftOpt : material.draftMin;
  const baseMinDraft = material.draftMin;
  const isTwoPiece = moldType !== 'single-pull';

  // ── Per-triangle geometry ────────────────────────────────────────────────
  const triAreas = new Float32Array(triCount);
  const triFNorm = new Float32Array(triCount * 3);
  const triCentroid = new Float32Array(triCount * 3);
  const triPullDot = new Float32Array(triCount);   // n · pullDir, signed
  const triDraft = new Float32Array(triCount);
  const triUndercut = new Uint8Array(triCount);    // 0 none, 1 slide, 2 lifter
  let area = 0, volume = 0;

  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
    const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2];
    const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2];
    const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const dlen = Math.sqrt(nx * nx + ny * ny + nz * nz);

    triAreas[t] = 0.5 * dlen;
    area += triAreas[t];
    /* Signed tetrahedron volume against the origin; summed over a closed
       mesh this is the enclosed volume. */
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;

    const inv = 1 / (dlen || 1);
    const nnx = nx * inv, nny = ny * inv, nnz = nz * inv;
    triFNorm[t * 3] = nnx; triFNorm[t * 3 + 1] = nny; triFNorm[t * 3 + 2] = nnz;
    triCentroid[t * 3] = (ax + bx + cx) / 3;
    triCentroid[t * 3 + 1] = (ay + by + cy) / 3;
    triCentroid[t * 3 + 2] = (az + bz + cz) / 3;

    /* +1 faces with the pull (top), −1 against it (bottom), 0 sidewall. */
    triPullDot[t] = nnx * pdx + nny * pdy + nnz * pdz;
  }
  volume = Math.abs(volume);

  if (onProgress) onProgress(0.2, 'Building BVH');
  const bvh = buildBVH(geom);

  // ── Inner vs outer face classification ───────────────────────────────────
  // For each sidewall triangle, cast four short rays outward along the face
  // normal from points spread across a small disc in the face plane. Rays
  // that hit more mesh mean this face looks into a cavity.
  //
  // Sampling four origins rather than one centroid makes the test robust to
  // glancing rays and small mesh gaps. A correctly drafted *inner* wall has
  // its normal pointing inward, so its raw pullDot sign reads as negative
  // draft even though the draft is right — hence the sign correction below.
  const triFaceSide = new Uint8Array(triCount); // 0 outer/top/bottom, 1 inner
  const discR = eps * 50;
  for (let t = 0; t < triCount; t++) {
    if (Math.abs(triPullDot[t]) > 0.7) continue; // top/bottom: side is irrelevant

    const cx = triCentroid[t * 3], cy = triCentroid[t * 3 + 1], cz = triCentroid[t * 3 + 2];
    const nx = triFNorm[t * 3], ny = triFNorm[t * 3 + 1], nz = triFNorm[t * 3 + 2];

    /* Two tangents spanning the face plane, via Gram-Schmidt off the normal. */
    let ux = Math.abs(nx) < 0.9 ? 1 : 0, uy = Math.abs(nx) < 0.9 ? 0 : 1, uz = 0;
    const d = ux * nx + uy * ny + uz * nz;
    ux -= d * nx; uy -= d * ny; uz -= d * nz;
    const uLen = Math.hypot(ux, uy, uz) || 1;
    ux /= uLen; uy /= uLen; uz /= uLen;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;

    let hits = 0;
    for (let k = 0; k < 4; k++) {
      const ang = (k - 1) * (2 * Math.PI / 3);
      const du = k === 0 ? 0 : discR * Math.cos(ang);
      const dv = k === 0 ? 0 : discR * Math.sin(ang);
      const ox = cx + ux * du + vx * dv + nx * eps;
      const oy = cy + uy * du + vy * dv + ny * eps;
      const oz = cz + uz * du + vz * dv + nz * eps;
      const dist = castRay(bvh, geom, ox, oy, oz, nx, ny, nz, eps, t);
      if (dist !== Infinity && dist < diag * 0.95) hits++;
    }
    if (hits >= 2) triFaceSide[t] = 1; // majority rules
  }

  for (let t = 0; t < triCount; t++) {
    const effectivePD = triFaceSide[t] === 1 ? -triPullDot[t] : triPullDot[t];
    triDraft[t] = Math.asin(Math.max(-1, Math.min(1, effectivePD))) * 180 / Math.PI;
  }

  // ── Area-weighted sidewall draft, split by face side ─────────────────────
  // In a two-piece mould the same sidewall may belong to either half, so a
  // face passes if it releases cleanly from *either* — that is, |draft| ≥ min.
  // This is what makes drafted-then-shelled parts pass: the outer and inner
  // walls of one feature have opposite signs and both are correct.
  // A single-pull mould gets the strict test.
  let sideArea = 0, sideAreaUnderMin = 0, sideAreaUnderHalf = 0, sideCount = 0;
  let outerArea = 0, outerAreaUnderMin = 0;
  let innerArea = 0, innerAreaUnderMin = 0;

  for (let t = 0; t < triCount; t++) {
    if (Math.abs(triPullDot[t]) >= 0.5) continue;
    const a = triAreas[t];
    const isInner = triFaceSide[t] === 1;
    sideArea += a;
    sideCount++;
    if (isInner) innerArea += a; else outerArea += a;

    const effectiveDraft = isTwoPiece ? Math.abs(triDraft[t]) : triDraft[t];
    if (effectiveDraft < minDraft) {
      sideAreaUnderMin += a;
      if (isInner) innerAreaUnderMin += a; else outerAreaUnderMin += a;
    }
    if (effectiveDraft < minDraft * 0.5) sideAreaUnderHalf += a;
  }

  if (onProgress) onProgress(0.4, 'Sampling wall thickness');

  // ── Wall thickness ───────────────────────────────────────────────────────
  const sampled = sampleWallThickness(
    geom, bvh, triAreas, triCentroid, triFNorm, diag, samples, opts.sampleSeed);
  const thicknesses = sampled.ray;
  const wallStats = stats(thicknesses);
  const sphereStats = sampled.sphere.length > 10 ? stats(sampled.sphere) : null;

  /* Ray and sphere measure different things, and where they disagree the
     geometry is telling us something. See sphereThicknessAt below. */
  const wallMethod = (sphereStats && wallStats.n > 10) ? {
    rayMedian: wallStats.median,
    sphereMedian: sphereStats.median,
    ratio: wallStats.median > 0.01 ? sphereStats.median / wallStats.median : 1,
    sphereP5: sphereStats.p5,
    sphereP95: sphereStats.p95,
  } : null;

  if (onProgress) onProgress(0.6, 'Tagging thin/thick regions');

  /* Per-triangle local thickness, for the heatmap and the sink/transition
     checks. Below the cap every triangle gets a ray; above it only a fraction
     do, and the coverage figures below are then measured against the sampled
     area rather than the full surface area. The original always used total
     area as the denominator, so on any mesh over 20k triangles it
     under-reported sink coverage by exactly the stride factor.

     Which triangles get sampled is drawn from the seeded generator rather
     than marched in index order. A fixed stride aliases against tessellation:
     triangles come off a tessellator in a repeating pattern — so many per
     segment, in the same order each time — and a stride that shares a factor
     with that period samples the same *role* on every segment and never the
     others. Measured on a stepped tube whose wall steps 2 mm to 6 mm, index
     order gave 8.9% severe sink at full coverage, 3.3% at stride 3, and 0.0%
     at stride 6: the thick band was simply never sampled. Selecting at random
     decorrelates the subset from the order, and seeding it keeps the run
     reproducible. */
  const fullCap = opts.thicknessFullCap > 0 ? opts.thicknessFullCap : THICKNESS_FULL_CAP;
  const heatStride = triCount > fullCap ? Math.ceil(triCount / fullCap) : 1;
  const triThickness = new Float32Array(triCount).fill(NaN);
  let measuredArea = 0;
  let sampledTris = 0;
  /* Derived from the same seed, on its own stream so the two samplers cannot
     shift each other's results. */
  const heatRandom = makeRandom(((opts.sampleSeed != null ? opts.sampleSeed : DEFAULT_SAMPLE_SEED) ^ 0x5BF03635) >>> 0);
  const keepProbability = 1 / heatStride;
  for (let t = 0; t < triCount; t++) {
    if (heatStride > 1 && heatRandom() >= keepProbability) continue;
    sampledTris++;
    const cx = triCentroid[t * 3], cy = triCentroid[t * 3 + 1], cz = triCentroid[t * 3 + 2];
    const nx = triFNorm[t * 3], ny = triFNorm[t * 3 + 1], nz = triFNorm[t * 3 + 2];
    const dist = castRay(bvh, geom, cx - nx * eps, cy - ny * eps, cz - nz * eps, -nx, -ny, -nz, eps, t);
    if (dist !== Infinity && dist < diag) {
      triThickness[t] = dist;
      measuredArea += triAreas[t];
    }
  }

  if (onProgress) onProgress(0.75, 'Computing sink risk');

  // ── Sink-mark risk ───────────────────────────────────────────────────────
  // Sink appears where local thickness runs well above nominal: the mass
  // behind the visible surface cannot cool uniformly. Ribs are kept to ≤0.6×
  // wall for exactly this reason, so accumulated mass at ratio > 1.6 is the
  // point where risk starts, reaching full severity by 3.0×.
  const meshNominal = (wallStats.n > 10) ? wallStats.median : null;
  const nominalWall = meshNominal != null ? meshNominal
    : (manualWall || (material.wallLo + material.wallHi) / 2);

  const triSinkRisk = new Float32Array(triCount);
  let sinkArea = 0, sinkAreaModerate = 0, sinkAreaSevere = 0;
  for (let t = 0; t < triCount; t++) {
    const th = triThickness[t];
    if (isNaN(th)) continue;
    const ratio = th / nominalWall;
    const risk = ratio > 1.6 ? Math.min(1, (ratio - 1.6) / 1.4) : 0;
    triSinkRisk[t] = risk;
    if (risk > 0) sinkArea += triAreas[t];
    if (risk > 0.3) sinkAreaModerate += triAreas[t];
    if (risk > 0.6) sinkAreaSevere += triAreas[t];
  }
  const sinkDenom = measuredArea > 0 ? measuredArea : area;

  if (onProgress) onProgress(0.82, 'Measuring projected area');
  const projectedArea = measureProjectedArea(geom, bvh, bbox, [pdx, pdy, pdz], diag);

  if (onProgress) onProgress(0.85, 'Detecting undercuts');

  // ── Undercut detection ───────────────────────────────────────────────────
  // A face is a true undercut when releasing the part would drag the tool
  // over solid material. Cases handled:
  //
  //  (1) Sidewall undercut — near-vertical wall leaning toward the parting
  //      plane. Only meaningful for single-pull moulds: in a two-piece mould
  //      such a wall simply belongs to the other half.
  //  (2) External underbelly — a face pointing against pull whose outward ray
  //      escapes to infinity. Lip undersides, snap-hook barbs.
  //  (3) Excluded — faces near the part's pull-minimum boundary, which are
  //      formed by the cavity half and release with its retraction, not with
  //      a slide or lifter.
  //
  // Slide vs lifter comes from the outward-normal ray: escaping to infinity
  // means external (slide), hitting more mesh means an internal pocket
  // (lifter).
  classifyUndercutFaces({
    geom, bvh, triCentroid, triFNorm, triPullDot, triUndercut, triCount,
    pullDir: [pdx, pdy, pdz], minDraft, isTwoPiece, diag, eps,
  });

  let slideArea = 0, lifterArea = 0;
  for (let t = 0; t < triCount; t++) {
    if (triUndercut[t] === 1) slideArea += triAreas[t];
    else if (triUndercut[t] === 2) lifterArea += triAreas[t];
  }

  if (onProgress) onProgress(0.95, 'Clustering tooling regions');
  const undercutRegions = clusterUndercuts(
    triCentroid, triAreas, triFNorm, triUndercut, triCount, diag, [pdx, pdy, pdz], geom);

  if (onProgress) onProgress(0.97, 'Detecting wall transitions');
  /* Transitions need both triangles of an edge pair to carry a reading, so
     they are only meaningful over a full-coverage thickness pass. */
  const wallTransitions = heatStride === 1 && wallStats.n > 10
    ? detectWallTransitions(geom, triThickness, triCentroid, triCount, wallStats.median, diag)
    : [];

  if (onProgress) onProgress(0.99, 'Computing flow lengths');
  /* One adjacency graph, shared by the gate the user picked and by any search
     for a better one. */
  let flowGraph = null;
  const graph = () => (flowGraph || (flowGraph = buildAdjacency(geom.indices, triCount, geom.vertCount)));

  const flowAnalysis = (gateLocation && Array.isArray(gateLocation))
    ? computeFlowLengths(geom, gateLocation, triCentroid, triThickness, triCount, material.ltMax, triAreas, graph())
    : null;

  /* With no gate picked the flow check has nothing to say, which is a waste:
     the solver is right here and the part is already measured. Searching a
     spread of positions turns "pick a gate" into "here is where to put it". */
  const gateSuggestion = (!flowAnalysis && opts.suggestGate !== false && wallStats.n > 10)
    ? searchGateCandidates({
      geom, triCentroid, triThickness, triAreas, triFaceSide, triCount,
      ltMax: material.ltMax,
      candidateCount: opts.gateCandidates || defaultGateCandidates(geom.vertCount),
      adjacency: graph(),
    })
    : null;

  return {
    bbox, area, volume, triCount, diag,
    projectedArea,

    triAreas, triDraft, triFNorm, triCentroid, triThickness,
    triPullDot, triUndercut, triSinkRisk, triFaceSide,

    sideCount, sideArea,
    sidePctUnderMin: sideArea > 0 ? (sideAreaUnderMin / sideArea) * 100 : 0,
    sidePctUnderHalf: sideArea > 0 ? (sideAreaUnderHalf / sideArea) * 100 : 0,
    outerArea, innerArea, outerAreaUnderMin, innerAreaUnderMin,
    outerPctUnderMin: outerArea > 0 ? (outerAreaUnderMin / outerArea) * 100 : 0,
    innerPctUnderMin: innerArea > 0 ? (innerAreaUnderMin / innerArea) * 100 : 0,

    wallStats, thicknesses,
    sphereStats, wallMethod,
    thicknessCoverage: heatStride === 1 ? 1 : sampledTris / triCount,

    sinkArea, sinkAreaModerate, sinkAreaSevere,
    sinkPctModerate: sinkDenom > 0 ? (sinkAreaModerate / sinkDenom) * 100 : 0,
    sinkPctSevere: sinkDenom > 0 ? (sinkAreaSevere / sinkDenom) * 100 : 0,

    slideArea, lifterArea, undercutRegions,
    wallTransitions, flowAnalysis, gateSuggestion,

    bvh,
    nominalWall,
    pullDir: [pdx, pdy, pdz],
    pullAxis: opts.pullAxis || '+z',
    minDraft, baseMinDraft, finishKey, moldType,
    material,
  };
}

/*
 * Area-weighted wall thickness sampling, by two independent methods.
 *
 * Triangles are drawn from the cumulative area distribution by stratified
 * sampling, so large faces contribute proportionally and the resulting
 * percentiles describe the part rather than its tessellation.
 *
 * The stratum jitter comes from a seeded generator, not Math.random(). The
 * same file has to produce the same report twice; see makeRandom in stats.js
 * for why a regular grid is not a safe substitute.
 */
function sampleWallThickness(geom, bvh, triAreas, triCentroid, triFNorm, diag, target, seed) {
  const { triCount } = geom;
  const cdf = new Float64Array(triCount);
  let acc = 0;
  for (let i = 0; i < triCount; i++) { acc += triAreas[i]; cdf[i] = acc; }
  const totalArea = acc;
  if (totalArea <= 0) return { ray: [], sphere: [] };

  const ray = [];
  const sphere = [];
  const samples = Math.min(target, triCount);
  const eps = diag * 1e-5;
  const random = makeRandom(seed != null ? seed : DEFAULT_SAMPLE_SEED);

  /* Which sampled points also get the sphere probe. Drawn on its own seeded
     stream at the rate the budget implies, rather than by striding: a stride of
     ceil(3000/2000) = 2 would take 1500 points and quietly make the budget mean
     something other than it says. */
  const sphereRandom = makeRandom(((seed != null ? seed : DEFAULT_SAMPLE_SEED) ^ 0x2545F491) >>> 0);
  const sphereRate = Math.min(1, SPHERE_SAMPLE_BUDGET / Math.max(1, samples));

  for (let s = 0; s < samples; s++) {
    const u = (s + random()) / samples * totalArea;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cdf[m] < u) lo = m + 1; else hi = m;
    }
    const t = lo;
    const cx = triCentroid[t * 3], cy = triCentroid[t * 3 + 1], cz = triCentroid[t * 3 + 2];
    const nx = triFNorm[t * 3], ny = triFNorm[t * 3 + 1], nz = triFNorm[t * 3 + 2];
    const dist = castRay(bvh, geom, cx - nx * eps, cy - ny * eps, cz - nz * eps, -nx, -ny, -nz, eps, t);
    if (dist !== Infinity && dist < diag) {
      ray.push(dist);
      if (sphereRate >= 1 || sphereRandom() < sphereRate) {
        sphere.push(sphereThicknessAt(bvh, geom, t, cx, cy, cz, nx, ny, nz, eps, diag, dist));
      }
    }
  }
  return { ray, sphere };
}

/*
 * How many of the sampled points also get the 33-ray sphere treatment.
 *
 * This is the figure the wall check now judges the part on, so it needs enough
 * samples that the confidence interval it reports describes the part rather than
 * the sampler — the check adds a "not pinned down" caveat above ±5%, and that
 * caveat should fire because a wall genuinely varies, never because the estimate
 * was taken cheaply. On a cylinder whose wall sweeps 1.0 to 4.0 mm, which is
 * more variation than most real parts carry, the median's interval comes out at
 * ±7.6% from 500 samples, ±5.6% from 1000, ±4.0% from 2000 and ±3.2% from 3000.
 * Two thousand is the first that stays clear of the threshold, and it costs
 * about a third less than sampling every point.
 *
 * The probe is 33 rays per sample, so this is the single biggest lever on run
 * time — worth revisiting together with the ring count in CONE_RINGS_DEG if a
 * part ever feels slow.
 */
const SPHERE_SAMPLE_BUDGET = 2000;

/* Default jitter seed. Any fixed value does; this one is the golden-ratio
   constant, which is conventional and carries no other meaning. */
const DEFAULT_SAMPLE_SEED = 0x9E3779B9;

/*
 * Probe directions for the inscribed-sphere estimate: the axial ray plus four
 * rings around it, stored as coefficients on the (inward, u, v) basis.
 *
 * For two surfaces converging at angle α the binding direction sits at
 * θ = α/2, so rings out to 60° cover convergence up to 120° — well past
 * anything a moulded wall does. Thirty-three rays per sample, on 3000
 * samples, is around 99k extra casts: cheap next to the per-triangle pass.
 */
export const CONE_RINGS_DEG = [15, 30, 45, 60];
export const CONE_AZIMUTHS = 8;
const CONE_DIRS = (() => {
  const out = [];
  for (const deg of CONE_RINGS_DEG) {
    const th = deg * Math.PI / 180;
    const st = Math.sin(th), ct = Math.cos(th);
    for (let k = 0; k < CONE_AZIMUTHS; k++) {
      const ph = (k / CONE_AZIMUTHS) * Math.PI * 2;
      out.push([ct, st * Math.cos(ph), st * Math.sin(ph)]);
    }
  }
  return out;
})();

/*
 * Local wall thickness as the diameter of the largest sphere that fits inside
 * the solid and touches the surface at this point.
 *
 * The single inward ray that this codebase has always used is directional. On
 * a wall whose opposite face is parallel it is exactly right, but on a wedge,
 * a tapered boss or a rib meeting a wall at an angle it reads the *slant*
 * distance and so overstates the wall — which is the optimistic direction,
 * and therefore the dangerous one for a sink or short-shot call.
 *
 * The sphere is the quantity a moulder means by "wall". Deriving it is easy:
 * a sphere of radius R tangent at p has its centre at p + R·n̂, so along a
 * direction d at angle θ from n̂ its far surface sits 2R·cos θ from p. A mesh
 * hit at distance t along d therefore bounds R ≤ t / (2·cos θ), and
 *
 *     thickness = 2R = min over probe directions of ( t / cos θ )
 *
 * which collapses to the plain ray value when θ = 0 binds, and is otherwise
 * strictly smaller. Rays that escape the part constrain nothing and are
 * skipped.
 *
 * A consequence worth knowing: near an external edge the largest inscribed
 * sphere is genuinely small, so this reads lower there than the ray does.
 * That is correct — it is local material, not slant distance — but it is why
 * the two medians are reported side by side rather than one replacing the
 * other.
 */
function sphereThicknessAt(bvh, geom, t, cx, cy, cz, nx, ny, nz, eps, diag, axialHit) {
  /* Probe into the solid, i.e. around the inward normal. */
  const ix = -nx, iy = -ny, iz = -nz;
  let best = axialHit;

  /* Two tangents spanning the plane, via Gram-Schmidt off the normal. */
  let ux = Math.abs(ix) < 0.9 ? 1 : 0, uy = Math.abs(ix) < 0.9 ? 0 : 1, uz = 0;
  const d = ux * ix + uy * iy + uz * iz;
  ux -= d * ix; uy -= d * iy; uz -= d * iz;
  const uLen = Math.hypot(ux, uy, uz) || 1;
  ux /= uLen; uy /= uLen; uz /= uLen;
  const vx = iy * uz - iz * uy, vy = iz * ux - ix * uz, vz = ix * uy - iy * ux;

  const ox = cx + ix * eps, oy = cy + iy * eps, oz = cz + iz * eps;

  for (let k = 0; k < CONE_DIRS.length; k++) {
    const cn = CONE_DIRS[k][0], cu = CONE_DIRS[k][1], cv = CONE_DIRS[k][2];
    const dx = ix * cn + ux * cu + vx * cv;
    const dy = iy * cn + uy * cu + vy * cv;
    const dz = iz * cn + uz * cu + vz * cv;
    /* A hit only matters if it lowers the bound, and bound = hit / cos θ, so
       nothing past best·cos θ can. Capping the ray there prunes most of the BVH
       traversal — the probe is 33 rays per sampled point and this is what makes
       running it on every sample affordable. */
    const hit = castRay(bvh, geom, ox, oy, oz, dx, dy, dz, eps, t, best * cn);
    if (hit === Infinity || hit >= diag) continue; // escapes, or too far to bind
    const bound = hit / cn;
    if (bound < best) best = bound;
  }
  return best;
}

/*
 * Mark each triangle as no undercut (0), a slide (1) or a lifter (2).
 *
 * A face is a true undercut when releasing the part would drag the tool over
 * solid material. Cases handled:
 *
 *  (1) Sidewall undercut — near-vertical wall leaning toward the parting
 *      plane. Only meaningful for single-pull moulds: in a two-piece mould
 *      such a wall simply belongs to the other half.
 *  (2) External underbelly — a face pointing against pull whose outward ray
 *      escapes to infinity. Lip undersides, snap-hook barbs.
 *  (3) Excluded — faces near the part's pull-minimum boundary, which are
 *      formed by the cavity half and release with its retraction, not with
 *      a slide or lifter.
 *
 * Slide vs lifter comes from the outward-normal ray: escaping to infinity
 * means external (slide), hitting more mesh means an internal pocket (lifter).
 *
 * Lifted out of analyseMesh so that suggestPullDirection can score candidate
 * axes with the same definition the report will use. It previously used its own
 * — a sidewall-lean test with a hardcoded 1° threshold and no mould-type
 * awareness — and on a part with an overhanging step it recommended +Z as
 * having "0.0% undercut area (lowest)" when +Z is the one axis with 420 mm² of
 * undercut and four others have none. Two definitions of the same thing is one
 * too many.
 */
export function classifyUndercutFaces({
  geom, bvh, triCentroid, triFNorm, triPullDot, triUndercut, triCount,
  pullDir, minDraft, isTwoPiece, diag, eps,
}) {
  const { vertices } = geom;
  const [pdx, pdy, pdz] = pullDir;

  let pullMin = Infinity, pullMax = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const d = vertices[i] * pdx + vertices[i + 1] * pdy + vertices[i + 2] * pdz;
    if (d < pullMin) pullMin = d;
    if (d > pullMax) pullMax = d;
  }
  const partingBand = (pullMax - pullMin) * 0.08;
  const minSin = Math.sin(minDraft * Math.PI / 180);

  for (let t = 0; t < triCount; t++) {
    const pd = triPullDot[t];
    const cd = triCentroid[t * 3] * pdx + triCentroid[t * 3 + 1] * pdy + triCentroid[t * 3 + 2] * pdz;
    const distFromPullMin = cd - pullMin;

    let isCandidate;
    if (isTwoPiece) {
      isCandidate = pd < -0.7 && distFromPullMin > partingBand;
    } else {
      isCandidate = (Math.abs(pd) < 0.7 && pd < -minSin)
                 || (pd < -0.7 && distFromPullMin > partingBand);
    }
    if (!isCandidate) { triUndercut[t] = 0; continue; }

    const cx = triCentroid[t * 3], cy = triCentroid[t * 3 + 1], cz = triCentroid[t * 3 + 2];
    const nx = triFNorm[t * 3], ny = triFNorm[t * 3 + 1], nz = triFNorm[t * 3 + 2];
    const outwardHit = castRay(bvh, geom,
      cx + nx * eps * 10, cy + ny * eps * 10, cz + nz * eps * 10, nx, ny, nz, eps, t);
    const exitsToInfinity = outwardHit === Infinity || outwardHit > diag * 0.99;

    if (pd < -0.7 && !exitsToInfinity) {
      /* An underbelly facing into a fully enclosed void. The tool has nothing
         useful to say about a cavity nothing can get into at all — that is a
         lost-core problem, not a slide-or-lifter one. */
      triUndercut[t] = 0;
    } else {
      triUndercut[t] = slideCanReachFace(
        bvh, geom, t, cx, cy, cz, nx, ny, nz, pullDir, eps, diag) ? 1 : 2;
    }
  }
  return triUndercut;
}

/* Directions tried in the parting plane, and how many must get out before a
   slide is judged able to reach the face. Two rather than one because a single
   ray can escape along a grazing tangent and say nothing useful. */
const SLIDE_PROBE_AZIMUTHS = 8;
const SLIDE_PROBE_MIN_ESCAPES = 2;

/*
 * Could a side-action core reach this face from outside the part?
 *
 * This is what separates a slide from a lifter, and it was previously decided by
 * whether a ray along the face's own normal escaped — which gets internal
 * features exactly wrong. The underside of a snap ledge inside a housing points
 * down into the open cavity, so that ray escapes straight out through the
 * opening and the feature was reported as needing a slide. No slide can reach
 * it: it is walled in on all four sides, and it has to be served from the core
 * side by a lifter. On the housing fixture that misclassified 1,200 mm² across
 * two regions, and because in a two-piece mould every candidate face points
 * against the pull, the lifter branch was unreachable and the tool could not
 * report a lifter at all.
 *
 * A slide travels in the parting plane, so the question is whether any path in
 * that plane gets from the face out of the part. Rays are cast from just off the
 * face, spread around the plane; if enough of them get out, a slide can come in
 * the same way.
 *
 * Note what this does *not* decide: whether the face is an undercut in the first
 * place. That still rests on the parting line being flat at the pull minimum,
 * which is the assumption the rest of this function makes and the one worth
 * revisiting — a stepped parting line resolves an overhang with no side action
 * at all.
 */
function slideCanReachFace(bvh, geom, t, cx, cy, cz, nx, ny, nz, pullDir, eps, diag) {
  const [pdx, pdy, pdz] = pullDir;

  /* Two axes spanning the parting plane, via Gram-Schmidt off the pull axis. */
  let ux = Math.abs(pdx) < 0.9 ? 1 : 0, uy = Math.abs(pdx) < 0.9 ? 0 : 1, uz = 0;
  const d = ux * pdx + uy * pdy + uz * pdz;
  ux -= d * pdx; uy -= d * pdy; uz -= d * pdz;
  const uLen = Math.hypot(ux, uy, uz) || 1;
  ux /= uLen; uy /= uLen; uz /= uLen;
  const vx = pdy * uz - pdz * uy, vy = pdz * ux - pdx * uz, vz = pdx * uy - pdy * ux;

  /* Start just clear of the surface, on the free side. */
  const ox = cx + nx * eps * 10, oy = cy + ny * eps * 10, oz = cz + nz * eps * 10;

  let escapes = 0;
  for (let k = 0; k < SLIDE_PROBE_AZIMUTHS; k++) {
    const a = (k / SLIDE_PROBE_AZIMUTHS) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const hit = castRay(bvh, geom, ox, oy, oz,
      ux * ca + vx * sa, uy * ca + vy * sa, uz * ca + vz * sa, eps, t);
    if (hit === Infinity || hit > diag * 0.99) {
      if (++escapes >= SLIDE_PROBE_MIN_ESCAPES) return true;
    }
  }
  return false;
}

/*
 * How many gate positions to try, given the size of the mesh.
 *
 * The search is one Dijkstra sweep per candidate, so its cost is linear in both
 * the candidate count and the vertex count: twelve candidates on a 48k-vertex
 * part costs about half a second. Holding that roughly flat as parts get larger
 * means trying fewer positions on them, which is the right trade — a coarser
 * search still answers the question that matters, which is whether gate
 * position is worth thinking about on this part at all.
 */
function defaultGateCandidates(vertCount) {
  if (vertCount > 250000) return 6;
  if (vertCount > 100000) return 8;
  return 12;
}

/* Grid resolution for the silhouette pass, per axis. 256² is 65k rays — the
   same order as the per-triangle thickness pass — and puts the discretisation
   error at well under a percent for any part this tool handles. */
const PROJECTION_GRID = 256;

/*
 * Area of the part's shadow along the pull axis.
 *
 * This is what clamp tonnage is calculated from: melt pressure acting over the
 * projected area of the cavity is the force trying to push the mould halves
 * apart.
 *
 * Measured by casting a grid of rays down the pull axis and counting the ones
 * that hit, rather than by summing ½·Σ|n̂·p̂|·A over the triangles. That sum is
 * exact only for a convex part and overstates everything else, because a fold
 * in the silhouette gets counted once per surface it passes through. Ray
 * casting also gets through-holes right for free: a hole running along the pull
 * axis is formed by a core pin shutting off against the opposite half, so no
 * melt bears on it and it must not count towards clamp force.
 */
function measureProjectedArea(geom, bvh, bbox, pullDir, diag) {
  const [pdx, pdy, pdz] = pullDir;

  /* Two axes spanning the parting plane. */
  let ux = Math.abs(pdx) < 0.9 ? 1 : 0, uy = Math.abs(pdx) < 0.9 ? 0 : 1, uz = 0;
  const d = ux * pdx + uy * pdy + uz * pdz;
  ux -= d * pdx; uy -= d * pdy; uz -= d * pdz;
  const uLen = Math.hypot(ux, uy, uz) || 1;
  ux /= uLen; uy /= uLen; uz /= uLen;
  const vx = pdy * uz - pdz * uy, vy = pdz * ux - pdx * uz, vz = pdx * uy - pdy * ux;

  /* Extent of the part in those two axes, over the bounding box corners. */
  const extent = (ax, ay, az) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      const bx = (i & 1) ? bbox.max[0] : bbox.min[0];
      const by = (i & 2) ? bbox.max[1] : bbox.min[1];
      const bz = (i & 4) ? bbox.max[2] : bbox.min[2];
      const p = bx * ax + by * ay + bz * az;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    return { lo, hi, span: hi - lo };
  };
  const eu = extent(ux, uy, uz);
  const ev = extent(vx, vy, vz);
  if (!(eu.span > 0) || !(ev.span > 0)) return 0;

  /* Launch from a plane clear of the part, pointing along the pull axis. */
  const startOffset = extent(pdx, pdy, pdz).lo - diag * 0.05;
  const eps = diag * 1e-6;
  const cellU = eu.span / PROJECTION_GRID;
  const cellV = ev.span / PROJECTION_GRID;
  let hits = 0;

  for (let i = 0; i < PROJECTION_GRID; i++) {
    const su = eu.lo + (i + 0.5) * cellU;
    for (let j = 0; j < PROJECTION_GRID; j++) {
      const sv = ev.lo + (j + 0.5) * cellV;
      const ox = ux * su + vx * sv + pdx * startOffset;
      const oy = uy * su + vy * sv + pdy * startOffset;
      const oz = uz * su + vz * sv + pdz * startOffset;
      if (castRay(bvh, geom, ox, oy, oz, pdx, pdy, pdz, eps, -1) !== Infinity) hits++;
    }
  }
  return hits * cellU * cellV;
}

/*
 * Suggest a pull direction by scoring all six cardinal axes.
 *
 * Ranked on the undercut area each axis would actually produce — measured with
 * classifyUndercutFaces, the same function the report uses, so the axis this
 * recommends cannot be one the report then finds undercuts on. It used to score
 * axes with its own sidewall-lean test at a hardcoded 1°, ignoring the mould
 * type entirely, and on a part with an overhanging step it recommended the one
 * axis that has an undercut while claiming "0.0% undercut area (lowest)".
 *
 * Ties are broken on draft: among axes that need no moving tooling, prefer the
 * one where least of the side-wall area falls under the minimum draft. In a
 * two-piece tool a face releases from whichever half suits it, so what matters
 * is the magnitude of the draft — and |draft| is asin(|n̂·p̂|) whichever side of
 * the wall the face is on, so this needs no ray casting.
 *
 * Costs one BVH build plus a ray per candidate face per axis. It runs on file
 * load, where a fraction of a second buys an answer that agrees with itself.
 */
export function suggestPullDirection(geom, opts = {}) {
  const { indices, vertices, triCount } = geom;
  const minDraft = opts.minDraft > 0 ? opts.minDraft : 1;
  const isTwoPiece = opts.moldType !== 'single-pull';

  const axes = [
    { name: '+Z', vec: [0, 0, 1] }, { name: '-Z', vec: [0, 0, -1] },
    { name: '+X', vec: [1, 0, 0] }, { name: '-X', vec: [-1, 0, 0] },
    { name: '+Y', vec: [0, 1, 0] }, { name: '-Y', vec: [0, -1, 0] },
  ];

  const triAreas = new Float32Array(triCount);
  const triFNorm = new Float32Array(triCount * 3);
  const triCentroid = new Float32Array(triCount * 3);
  let totalArea = 0;
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
    const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2];
    const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2];
    const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const dlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    triAreas[t] = 0.5 * dlen;
    totalArea += triAreas[t];
    triFNorm[t * 3] = nx / dlen; triFNorm[t * 3 + 1] = ny / dlen; triFNorm[t * 3 + 2] = nz / dlen;
    triCentroid[t * 3] = (ax + bx + cx) / 3;
    triCentroid[t * 3 + 1] = (ay + by + cy) / 3;
    triCentroid[t * 3 + 2] = (az + bz + cz) / 3;
  }

  const boundsInfo = computeBounds(vertices);
  const diag = boundsInfo.diag;
  const eps = diag * 1e-5;
  const bbox = { min: boundsInfo.min, max: boundsInfo.max };
  const bvh = buildBVH(geom);

  const triPullDot = new Float32Array(triCount);
  const triUndercut = new Uint8Array(triCount);
  const minSin = Math.sin(minDraft * Math.PI / 180);

  const scored = axes.map((a) => {
    const [pdx, pdy, pdz] = a.vec;
    let sideArea = 0, sideUnderMin = 0;
    for (let t = 0; t < triCount; t++) {
      const pd = triFNorm[t * 3] * pdx + triFNorm[t * 3 + 1] * pdy + triFNorm[t * 3 + 2] * pdz;
      triPullDot[t] = pd;
      if (Math.abs(pd) < 0.5) {
        sideArea += triAreas[t];
        if (Math.abs(pd) < minSin) sideUnderMin += triAreas[t];
      }
    }

    classifyUndercutFaces({
      geom, bvh, triCentroid, triFNorm, triPullDot, triUndercut, triCount,
      pullDir: a.vec, minDraft, isTwoPiece, diag, eps,
    });

    let undercutArea = 0;
    for (let t = 0; t < triCount; t++) if (triUndercut[t] !== 0) undercutArea += triAreas[t];

    return {
      name: a.name,
      dir: a.vec,
      undercutArea,
      undercutPct: totalArea > 0 ? (undercutArea / totalArea) * 100 : 0,
      draftUnderMinPct: sideArea > 0 ? (sideUnderMin / sideArea) * 100 : 0,
    };
  });

  scored.sort((x, y) =>
    (x.undercutArea - y.undercutArea) || (x.draftUnderMinPct - y.draftUnderMinPct));

  const best = scored[0];
  const reason = best.undercutArea > 0
    ? `${best.name} — ${best.undercutPct.toFixed(1)}% undercut area, the lowest of the six axes`
    : `${best.name} — no undercuts, ${best.draftUnderMinPct.toFixed(0)}% of side-wall area under ${minDraft.toFixed(1)}° draft`;

  void bbox;
  return { dir: best.dir, name: best.name, reason, ranked: scored };
}
