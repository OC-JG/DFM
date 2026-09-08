import { castRay, closestPoint } from '../geometry/bvh.js';
import { jacobiEigen } from './linalg.js';
import { makeRandom } from './stats.js';

/*
 * Rigid registration of the overmould onto the substrate.
 *
 * The interface pass assumed both shots were exported in one coordinate
 * system. When they were not — one part exported in its own frame rather than
 * the assembly's is the ordinary way this happens — every ray cast from shot 2
 * misses, coverage comes out near zero, and `ts_coverage` reports a design
 * problem that is really a file problem. Its own weight comment conceded as
 * much: "usually a mesh alignment problem".
 *
 * ── What this can and cannot do ──────────────────────────────────────────
 *
 * The roadmap proposed principal axes for the coarse stage, then ICP. Half of
 * that premise does not survive contact: principal axes align two instances
 * of the *same* shape, and a substrate and its overmould are different shapes.
 * Their inertia frames have no reason to coincide even when the pair is
 * perfectly positioned, so an axis alignment is a candidate starting pose, not
 * an answer. It is tried here alongside ideas that are no worse — leaving the
 * pose alone, and matching centroids or bounding-box centres — and the
 * residual decides between them.
 *
 * The refinement is ICP over the mating surface only, and picking out that
 * surface is most of the work. Only some of shot 2 touches shot 1 — the rest
 * is the free outer skin, sitting one wall thickness away — so a fit over all
 * of it is dominated by the part that is *supposed* to be apart. Keeping the
 * closest fraction of correspondences was the first attempt and does not hold:
 * the right fraction is the mating area, which is unknown, and on the box
 * fixture a 60% trim leaves a mated pair reading a 1 mm residual purely from
 * the outer-surface points it had to include.
 *
 * What separates the two surfaces without a magic number is the direction each
 * correspondence points. Shot 2's mating surface faces *into* shot 1, so the
 * nearest substrate point lies along its outward normal; the free outer skin
 * faces away, and its nearest substrate point is behind it. Keeping only the
 * correspondences that agree with the outward normal selects the mating
 * surface geometrically, whatever fraction of the part it happens to be, and
 * the residual then genuinely is a residual at the interface.
 *
 * ── What decides that a pose is right ────────────────────────────────────
 *
 * Not interface coverage, which was the obvious answer and is wrong. Coverage
 * counts shot 2 faces with the substrate somewhere beneath them, and a shell
 * shoved 15 mm sideways still has the substrate beneath most of it — measured
 * on a box and its overmould, the misaligned pair scored *higher* coverage
 * than the mated one (42% against 37%), with overmould thickness reading
 * 0.05 mm to 9 mm where the truth is 2 mm everywhere. Coverage is not even
 * monotonic in alignment, so it cannot referee it.
 *
 * The residual at the mating surface can: two shots are registered when shot
 * 2's cavity lies *on* shot 1's surface, which is the trimmed residual going
 * to zero. So that is the decision — a transform is applied only when it cuts
 * the residual decisively and lands inside the mating tolerance — and coverage
 * is reported as an outcome rather than consulted as a criterion.
 *
 * Scale is deliberately not fitted. A pair 25.4× apart is a unit mistake and
 * the bridge tests cover it at the source; inferring a scale factor between
 * two different shapes is the kind of confident guess this tool avoids.
 */

/* Correspondences sampled from the shot 2 surface, area-weighted. Enough that
   the coverage estimate is stable to about a point, which is what the accept
   decision below turns on; the cost is one closest-point query each per
   iteration. */
export const REGISTER_SAMPLES = 1500;

/* Fraction of the normal-agreeing correspondences kept for the fit. Generous,
   because the geometric filter has already done the separating: this only has
   to shed the tail — a cavity point over a hole in the substrate, or one at a
   corner the two shapes do not share. */
export const REGISTER_TRIM = 0.8;

/* Correspondence directions within this many degrees of the shot 2 outward
   normal count as facing the substrate. Ninety degrees would be the bare
   geometric statement; 70° tightens it enough that a grazing hit at the edge
   of the mating region does not join the fit. */
export const NORMAL_AGREE_DEG = 70;

/* Below this many normal-agreeing correspondences the filter is abandoned for
   that iteration and every correspondence is used. A badly misaligned start
   can leave almost nothing facing the substrate, and a filter that starves the
   fit prevents the very convergence that would make it meaningful. */
const NORMAL_FILTER_FLOOR = 50;

export const REGISTER_MAX_ITER = 40;

/* Iterations each coarse candidate gets before the field is narrowed to one.
   Six is enough to separate a starting pose that is converging from one that
   is not, at a seventh of the cost of running them all to convergence. */
export const PROBE_ITER = 6;

/*
 * How far out the mating surface has to be, as a fraction of the part
 * diagonal, before registration engages at all — with an absolute floor for
 * very small parts.
 *
 * Set to only correct gross misalignment, and the reason is what sits just
 * below it: a two-shot pair modelled with a deliberate tenth-millimetre
 * clearance has a real, intended residual, and closing it would move shot 2
 * onto the substrate and change every reported overmould thickness by that
 * tenth. An export in the wrong coordinate system is out by millimetres or
 * tens of them, never by a tenth, so 1% of the part's diagonal separates the
 * two cases with room to spare.
 */
export const ENGAGE_FRACTION = 0.01;
export const ENGAGE_FLOOR_MM = 0.2;

/* The residual has to fall by at least this factor for the transform to be
   worth applying. Decisive rather than marginal: a pose that only improves
   things slightly is more likely to be ICP sliding along a surface than a
   coordinate system being corrected. */
export const RESIDUAL_IMPROVE = 0.25;

/* Sampling jitter seed. Fixed, because the same pair of files must register
   the same way twice — see makeRandom in stats.js. */
const REGISTER_SEED = 0x5BD1E995;

/* Identity, in the { r, t } form used throughout: r is row-major 3×3. */
export function identityXform() {
  return { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
}

/* Transform a point. */
export function xformPoint(x, y, z, m, out) {
  const { r, t } = m;
  out[0] = r[0] * x + r[1] * y + r[2] * z + t[0];
  out[1] = r[3] * x + r[4] * y + r[5] * z + t[1];
  out[2] = r[6] * x + r[7] * y + r[8] * z + t[2];
  return out;
}

/* Transform a direction: rotation only, no translation. */
export function xformDir(x, y, z, m, out) {
  const { r } = m;
  out[0] = r[0] * x + r[1] * y + r[2] * z;
  out[1] = r[3] * x + r[4] * y + r[5] * z;
  out[2] = r[6] * x + r[7] * y + r[8] * z;
  return out;
}

/* b ∘ a — apply `a`, then `b`. */
function compose(b, a) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = b.r[i * 3] * a.r[j] + b.r[i * 3 + 1] * a.r[3 + j] + b.r[i * 3 + 2] * a.r[6 + j];
    }
  }
  const t = [
    b.r[0] * a.t[0] + b.r[1] * a.t[1] + b.r[2] * a.t[2] + b.t[0],
    b.r[3] * a.t[0] + b.r[4] * a.t[1] + b.r[5] * a.t[2] + b.t[1],
    b.r[6] * a.t[0] + b.r[7] * a.t[1] + b.r[8] * a.t[2] + b.t[2],
  ];
  return { r, t };
}

/* The rotation angle a transform carries, in degrees, from the trace. */
export function rotationDegOf(m) {
  const tr = m.r[0] + m.r[4] + m.r[8];
  const c = Math.max(-1, Math.min(1, (tr - 1) / 2));
  return Math.acos(c) * 180 / Math.PI;
}

/* Rotation matrix from a unit quaternion (w, x, y, z). */
function quatToMatrix(w, x, y, z) {
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z),     2 * (x * z + w * y),
    2 * (x * y + w * z),     1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y),     2 * (y * z + w * x),     1 - 2 * (x * x + y * y),
  ];
}

/*
 * The rigid transform that best carries points `p` onto points `q`, by Horn's
 * quaternion method (1987).
 *
 * The quaternion route rather than an SVD because the largest eigenvector of
 * the symmetric 4×4 below is a rotation by construction — there is no
 * reflection case to detect and correct, which is the step an SVD solution
 * gets wrong when the correspondences are nearly coplanar. Nearly coplanar is
 * the normal condition here: the mating region of an overmould is a shell.
 *
 * `idx` selects which of the correspondence arrays take part, so the trimmed
 * subset can be fitted without copying it out.
 */
export function fitRigid(p, q, idx, count) {
  if (count < 3) return null;

  let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
  for (let k = 0; k < count; k++) {
    const i = idx[k] * 3;
    px += p[i]; py += p[i + 1]; pz += p[i + 2];
    qx += q[i]; qy += q[i + 1]; qz += q[i + 2];
  }
  px /= count; py /= count; pz /= count;
  qx /= count; qy /= count; qz /= count;

  /* S[row][col] = Σ (p − p̄)_row (q − q̄)_col */
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0;
  for (let k = 0; k < count; k++) {
    const i = idx[k] * 3;
    const ax = p[i] - px, ay = p[i + 1] - py, az = p[i + 2] - pz;
    const bx = q[i] - qx, by = q[i + 1] - qy, bz = q[i + 2] - qz;
    sxx += ax * bx; sxy += ax * by; sxz += ax * bz;
    syx += ay * bx; syy += ay * by; syz += ay * bz;
    szx += az * bx; szy += az * by; szz += az * bz;
  }

  const n = [
    [sxx + syy + szz, syz - szy,       szx - sxz,        sxy - syx],
    [syz - szy,       sxx - syy - szz, sxy + syx,        szx + sxz],
    [szx - sxz,       sxy + syx,       -sxx + syy - szz, syz + szy],
    [sxy - syx,       szx + sxz,       syz + szy,        -sxx - syy + szz],
  ];

  const eig = jacobiEigen(n);
  const [w, x, y, z] = eig[3].vector;   // largest eigenvalue
  const r = quatToMatrix(w, x, y, z);

  return {
    r,
    t: [
      qx - (r[0] * px + r[1] * py + r[2] * pz),
      qy - (r[3] * px + r[4] * py + r[5] * pz),
      qz - (r[6] * px + r[7] * py + r[8] * pz),
    ],
  };
}

/* Area-weighted centroid of a triangulated surface, from an analysis result. */
function surfaceCentroid(tri) {
  const { triCount, triAreas, triCentroid } = tri;
  let ax = 0, ay = 0, az = 0, w = 0;
  for (let t = 0; t < triCount; t++) {
    const a = triAreas[t];
    if (!(a > 0)) continue;
    ax += triCentroid[t * 3] * a;
    ay += triCentroid[t * 3 + 1] * a;
    az += triCentroid[t * 3 + 2] * a;
    w += a;
  }
  return w > 0 ? [ax / w, ay / w, az / w] : [0, 0, 0];
}

/* Principal axes of a surface: eigenvectors of the area-weighted covariance
   of triangle centroids, largest spread last. */
function principalAxes(tri, centre) {
  const { triCount, triAreas, triCentroid } = tri;
  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0, w = 0;
  for (let t = 0; t < triCount; t++) {
    const a = triAreas[t];
    if (!(a > 0)) continue;
    const x = triCentroid[t * 3] - centre[0];
    const y = triCentroid[t * 3 + 1] - centre[1];
    const z = triCentroid[t * 3 + 2] - centre[2];
    c00 += a * x * x; c01 += a * x * y; c02 += a * x * z;
    c11 += a * y * y; c12 += a * y * z; c22 += a * z * z;
    w += a;
  }
  if (!(w > 0)) return null;
  const eig = jacobiEigen([
    [c00 / w, c01 / w, c02 / w],
    [c01 / w, c11 / w, c12 / w],
    [c02 / w, c12 / w, c22 / w],
  ]);
  return eig.map((e) => e.vector);
}

/* Columns-as-axes rotation carrying basis `from` onto basis `to`. */
function basisRotation(from, to) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = to[0][i] * from[0][j] + to[1][i] * from[1][j] + to[2][i] * from[2][j];
    }
  }
  return r;
}

function det3(r) {
  return r[0] * (r[4] * r[8] - r[5] * r[7])
       - r[1] * (r[3] * r[8] - r[5] * r[6])
       + r[2] * (r[3] * r[7] - r[4] * r[6]);
}

/*
 * Area-weighted stratified sample of the shot 2 surface: a point, and the
 * inward normal the interface pass casts along.
 *
 * Stratified rather than independent draws, and off a seeded generator, for
 * the reason given in mesh.js: the same file has to produce the same report
 * twice, and a regular grid is not a safe substitute for jitter.
 */
function sampleSurface(geom, shot2, target, seed) {
  const { triCount, triAreas, triFNorm } = shot2;
  const { vertices, indices } = geom;
  const cdf = new Float64Array(triCount);
  let acc = 0;
  for (let t = 0; t < triCount; t++) { acc += triAreas[t]; cdf[t] = acc; }
  if (!(acc > 0)) return { n: 0, pts: new Float64Array(0), nrm: new Float64Array(0) };

  const n = target;
  const pts = new Float64Array(n * 3);
  const nrm = new Float64Array(n * 3);
  const random = makeRandom(seed);

  for (let s = 0; s < n; s++) {
    const u = (s + random()) / n * acc;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cdf[m] < u) lo = m + 1; else hi = m;
    }

    /* A point inside the triangle, not its centroid — which is where this
       sampler parts company with the one in mesh.js, and why it is not capped
       at one sample per triangle. That one measures per-triangle quantities it
       has already computed, so a centroid is the natural representative. This
       one is fitting a pose, and a coarse mesh has few triangles: twenty-four
       face centres on a shelled box are not enough points to pin a rotation,
       and worse, they are the most symmetric twenty-four points the shape has.
       The square-root map below spreads samples uniformly over the triangle. */
    const r1 = Math.sqrt(random());
    const r2 = random();
    const wa = 1 - r1, wb = r1 * (1 - r2), wc = r1 * r2;
    const ia = indices[lo * 3] * 3, ib = indices[lo * 3 + 1] * 3, ic = indices[lo * 3 + 2] * 3;
    pts[s * 3]     = wa * vertices[ia]     + wb * vertices[ib]     + wc * vertices[ic];
    pts[s * 3 + 1] = wa * vertices[ia + 1] + wb * vertices[ib + 1] + wc * vertices[ic + 1];
    pts[s * 3 + 2] = wa * vertices[ia + 2] + wb * vertices[ib + 2] + wc * vertices[ic + 2];

    nrm[s * 3] = -triFNorm[lo * 3];
    nrm[s * 3 + 1] = -triFNorm[lo * 3 + 1];
    nrm[s * 3 + 2] = -triFNorm[lo * 3 + 2];
  }
  return { n, pts, nrm };
}

/*
 * Interface coverage under a candidate transform, estimated on the sample.
 *
 * Deliberately the same measurement `analyseInterface` makes — a ray inward
 * from the surface, a hit on the substrate inside `maxDist` — so the accept
 * decision is made on the quantity the user is shown, not a proxy for it.
 * Area-weighted sampling makes every sample carry equal area, so the hit
 * fraction estimates the area fraction directly.
 */
function sampledCoverage(sample, geom1, bvh1, maxDist, m, eps) {
  const p = [0, 0, 0], d = [0, 0, 0];
  let hits = 0;
  for (let s = 0; s < sample.n; s++) {
    xformPoint(sample.pts[s * 3], sample.pts[s * 3 + 1], sample.pts[s * 3 + 2], m, p);
    xformDir(sample.nrm[s * 3], sample.nrm[s * 3 + 1], sample.nrm[s * 3 + 2], m, d);
    const dist = castRay(bvh1, geom1,
      p[0] + d[0] * eps, p[1] + d[1] * eps, p[2] + d[2] * eps,
      d[0], d[1], d[2], eps, -1, maxDist);
    if (isFinite(dist)) hits++;
  }
  return sample.n > 0 ? (hits / sample.n) * 100 : 0;
}

/*
 * Scratch for the correspondence passes. One registration runs at a time and
 * every pass writes the whole set, so these are allocated per registration
 * rather than per iteration.
 */
function makeScratch(n) {
  return {
    moved: new Float64Array(n * 3),
    target: new Float64Array(n * 3),
    dist: new Float64Array(n),
    agrees: new Uint8Array(n),
    pick: new Uint32Array(n),
  };
}

/*
 * Nearest substrate point for every sample under pose `m`, filtered to the
 * mating surface.
 *
 * A correspondence is kept when the substrate lies along the sample's outward
 * normal — the geometric test that separates shot 2's mating surface from its
 * free outer skin, in place of a guessed overlap fraction. `sample.nrm` holds
 * the inward normal, the one the interface pass casts along, so the outward
 * normal is its negation and agreement is a negative dot product with it.
 *
 * Fills `sc` in place; returns the number of correspondences and whether the
 * filter survived (it is abandoned below NORMAL_FILTER_FLOOR, since a badly
 * misaligned start can leave almost nothing facing the substrate).
 */
function correspond(sample, geom1, bvh1, m, corrMax, sc) {
  const hit = new Float64Array(4);
  const p = [0, 0, 0], d = [0, 0, 0];
  const cosGate = Math.cos(NORMAL_AGREE_DEG * Math.PI / 180);

  let found = 0, agreeing = 0;
  for (let s = 0; s < sample.n; s++) {
    xformPoint(sample.pts[s * 3], sample.pts[s * 3 + 1], sample.pts[s * 3 + 2], m, p);
    const dist = closestPoint(bvh1, geom1, p[0], p[1], p[2], corrMax, hit);
    if (!isFinite(dist)) continue;

    /* Outward normal, rotated into shot 1's frame. */
    xformDir(-sample.nrm[s * 3], -sample.nrm[s * 3 + 1], -sample.nrm[s * 3 + 2], m, d);
    /* A coincident correspondence has no direction to test, and is exactly the
       kind that belongs in the fit. */
    const agrees = dist <= 0
      || ((hit[0] - p[0]) * d[0] + (hit[1] - p[1]) * d[1] + (hit[2] - p[2]) * d[2]) / dist >= cosGate;

    const i = found * 3;
    sc.moved[i] = p[0]; sc.moved[i + 1] = p[1]; sc.moved[i + 2] = p[2];
    sc.target[i] = hit[0]; sc.target[i + 1] = hit[1]; sc.target[i + 2] = hit[2];
    sc.dist[found] = dist;
    sc.agrees[found] = agrees ? 1 : 0;
    if (agrees) agreeing++;
    found++;
  }

  const filtered = agreeing >= NORMAL_FILTER_FLOOR;
  let n = 0;
  for (let k = 0; k < found; k++) {
    if (!filtered || sc.agrees[k]) sc.pick[n++] = k;
  }
  return { count: n, filtered };
}

/*
 * Trim the correspondence set and measure it.
 *
 * Sorted by distance and cut to REGISTER_TRIM, which after the normal filter
 * only has the tail to shed. Returns the kept indices — the fit and the
 * residual are then over exactly the same points, which is what makes the
 * residual answerable for the pose.
 */
function trimAndMeasure(sc, count) {
  if (count < 3) return { keep: null, rms: Infinity, p95: Infinity, kept: 0 };
  const idx = Array.from(sc.pick.subarray(0, count)).sort((a, b) => sc.dist[a] - sc.dist[b]);
  const keepN = Math.max(3, Math.round(count * REGISTER_TRIM));
  const keep = new Uint32Array(idx.slice(0, keepN));

  let sumSq = 0;
  for (let k = 0; k < keepN; k++) sumSq += sc.dist[keep[k]] * sc.dist[keep[k]];
  return {
    keep,
    rms: Math.sqrt(sumSq / keepN),
    p95: sc.dist[keep[Math.min(keepN - 1, Math.floor(keepN * 0.95))]],
    kept: keepN,
  };
}

/*
 * The residual of a pose, without fitting anything. Needed on its own for the
 * pose the files arrived in: that figure decides whether there is a
 * misalignment to correct, and it is reported either way.
 */
function poseResidual(sample, geom1, bvh1, m, corrMax, sc) {
  const { count } = correspond(sample, geom1, bvh1, m, corrMax, sc);
  return trimAndMeasure(sc, count);
}

/*
 * One ICP run from a starting pose. Returns the refined transform and the
 * residual over the points it fitted.
 */
function icp(sample, geom1, bvh1, start, corrMax, iterations, stopEps, sc) {
  let m = start;
  let rms = Infinity, p95 = Infinity, kept = 0, filtered = false;
  let iter = 0, converged = false;

  for (; iter < iterations; iter++) {
    const found = correspond(sample, geom1, bvh1, m, corrMax, sc);
    const measured = trimAndMeasure(sc, found.count);
    if (!measured.keep) break;
    rms = measured.rms; p95 = measured.p95; kept = measured.kept;
    filtered = found.filtered;

    const step = fitRigid(sc.moved, sc.target, measured.keep, measured.kept);
    if (!step) break;
    m = compose(step, m);

    const move = Math.hypot(step.t[0], step.t[1], step.t[2]);
    if (move < stopEps && rotationDegOf(step) < 1e-3) { converged = true; iter++; break; }
  }

  /* The residual above belongs to the pose *before* the last step. One more
     correspondence pass so the figure reported describes the transform
     returned — a step that moved the fit is otherwise credited with the
     residual it was fixing. */
  if (iter > 0) {
    const final = poseResidual(sample, geom1, bvh1, m, corrMax, sc);
    if (final.keep) { rms = final.rms; p95 = final.p95; kept = final.kept; }
  }

  return { m, rms, p95, kept, filtered, iterations: iter, converged };
}

/*
 * Register shot 2 onto shot 1.
 *
 * `shot1`/`shot2` are the analysis results (for triangle areas, bounds and
 * normals) and `geom2` the overmould the correspondences are sampled from;
 * `geom1`/`bvh1` are the substrate the rays and closest-point queries run
 * against. `maxDist` is the interface search distance, so that
 * coverage here means what it means in the report.
 *
 * The transform returned maps shot 2's coordinates into shot 1's. Nothing is
 * rewritten: `analyseInterface` applies it per ray, which leaves shot 2's own
 * draft and wall measurements — taken in its own frame, against its own
 * declared pull direction — exactly as they were.
 */
export function registerShots({
  geom1, bvh1, shot1, geom2, shot2, maxDist, samples, seed,
  /* Overridable so a test can stop the loop short. The residual reported
     belongs to the pose returned rather than to the one the last step
     started from, and the two only differ before convergence — which a run
     allowed to converge, by definition, never reaches. */
  probeIter = PROBE_ITER, maxIter = REGISTER_MAX_ITER,
}) {
  const sample = sampleSurface(geom2, shot2, samples || REGISTER_SAMPLES, seed != null ? seed : REGISTER_SEED);
  const identity = identityXform();

  if (sample.n < 3) {
    return {
      attempted: false, applied: false, reason: 'no-surface',
      transform: null, samples: sample.n,
    };
  }

  const eps = Math.max(shot1.diag, shot2.diag) * 1e-5;
  const corrMax = Math.max(shot1.diag, shot2.diag);
  const engageTol = Math.max(ENGAGE_FLOOR_MM, shot1.diag * ENGAGE_FRACTION);
  const coverageBefore = sampledCoverage(sample, geom1, bvh1, maxDist, identity, eps);
  const sc = makeScratch(sample.n);
  const before = poseResidual(sample, geom1, bvh1, identity, corrMax, sc);

  /* Inside the mating tolerance there is nothing to correct, and the safest
     transform is none. Reported rather than silent, so a reader can tell
     "arrived mated" from "nobody looked". */
  if (before.rms <= engageTol) {
    return {
      attempted: false, applied: false, reason: 'already-mated',
      transform: null,
      engageTol,
      residualBefore: before.rms,
      residualRms: before.rms, residualP95: before.p95,
      inlierCount: before.kept,
      coveragePctBefore: coverageBefore, coveragePctAfter: coverageBefore,
      samples: sample.n,
    };
  }

  // ── coarse candidates ──────────────────────────────────────────────────
  const c1 = surfaceCentroid(shot1);
  const c2 = surfaceCentroid(shot2);
  const b1 = shot1.bbox, b2 = shot2.bbox;

  const candidates = [{ name: 'identity', m: identity }];
  candidates.push({
    name: 'centroid',
    m: { r: identity.r.slice(), t: [c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]] },
  });
  candidates.push({
    name: 'bbox-centre',
    m: {
      r: identity.r.slice(),
      t: [
        (b1.min[0] + b1.max[0]) / 2 - (b2.min[0] + b2.max[0]) / 2,
        (b1.min[1] + b1.max[1]) / 2 - (b2.min[1] + b2.max[1]) / 2,
        (b1.min[2] + b1.max[2]) / 2 - (b2.min[2] + b2.max[2]) / 2,
      ],
    },
  });

  /* Principal axes, all four proper sign combinations. An eigenvector's sign
     is arbitrary, so aligning axes to axes leaves a four-way ambiguity among
     rotations (the odd flips are reflections and are dropped). This is the
     candidate the roadmap asked for; it is one of four here rather than the
     coarse stage on its own because two different shapes have no reason to
     share an inertia frame. */
  const a1 = principalAxes(shot1, c1);
  const a2 = principalAxes(shot2, c2);
  if (a1 && a2) {
    for (const flip of [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]) {
      const to = a1.map((v, i) => [v[0] * flip[i], v[1] * flip[i], v[2] * flip[i]]);
      const r = basisRotation(a2, to);
      if (det3(r) < 0) continue;
      candidates.push({
        name: 'principal-axes',
        m: {
          r,
          t: [
            c1[0] - (r[0] * c2[0] + r[1] * c2[1] + r[2] * c2[2]),
            c1[1] - (r[3] * c2[0] + r[4] * c2[1] + r[5] * c2[2]),
            c1[2] - (r[6] * c2[0] + r[7] * c2[1] + r[8] * c2[2]),
          ],
        },
      });
    }
  }

  // ── probe every candidate, refine the best ─────────────────────────────
  const stopEps = shot1.diag * 1e-6;

  let best = null;
  for (const cand of candidates) {
    const probe = icp(sample, geom1, bvh1, cand.m, corrMax, probeIter, stopEps, sc);
    if (!best || probe.rms < best.probe.rms) best = { cand, probe };
  }

  const run = icp(sample, geom1, bvh1, best.probe.m, corrMax, maxIter, stopEps, sc);
  const coverageAfter = sampledCoverage(sample, geom1, bvh1, maxDist, run.m, eps);

  /* Both halves are needed. The first says the pose is decisively better than
     the one the files arrived in; the second says it is actually mated, which
     rules out a large improvement that still leaves the shots apart — two
     shapes that cannot meet produce exactly that. */
  const applied = run.rms <= before.rms * RESIDUAL_IMPROVE && run.rms <= engageTol;

  return {
    attempted: true,
    applied,
    reason: applied ? 'registered' : 'no-improvement',
    transform: applied ? run.m : null,
    coarse: best.cand.name,
    candidatesTried: candidates.length,
    engageTol,
    offsetMm: Math.hypot(run.m.t[0], run.m.t[1], run.m.t[2]),
    rotationDeg: rotationDegOf(run.m),
    residualBefore: before.rms,
    residualRms: run.rms,
    residualP95: run.p95,
    inlierCount: run.kept,
    normalFiltered: run.filtered,
    coveragePctBefore: coverageBefore,
    coveragePctAfter: coverageAfter,
    iterations: probeIter * candidates.length + run.iterations,
    converged: run.converged,
    samples: sample.n,
  };
}
