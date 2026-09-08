/*
 * Per-face measurement.
 *
 * An STL is a bag of triangles, so every measurement over one is a statistic:
 * "42% of side-wall area is under the minimum" is the most a heap of triangles
 * can say. A B-rep carries the faces the part was modelled with, and a face is
 * the thing a designer can go and change — so where the geometry carries them,
 * the same measurement becomes "this face, 0.3°", and a radius becomes
 * measurable at all.
 *
 * Draft is aggregated, never re-measured: draft per triangle, the inner/outer
 * classification and the two-piece rule all run in mesh.js before this does,
 * and grouping their results is what stops a face's angle and the area
 * statistic from ever disagreeing.
 *
 * Radius is different — it is fitted, because there is nothing to aggregate.
 * The reader hands back a triangle range per face and nothing else: no surface
 * type, no radius, no axis. So a cylindrical face is recognised by the shape
 * of its own normals and its radius recovered from its vertices, which has the
 * advantage of working on any B-rep source and of failing honestly — a face
 * that fits nothing is reported as unmeasured rather than as a number.
 */

/* Above this spread between a face's triangle normals, the face is not flat
   and one angle does not describe it. Tessellation of a genuine plane comes
   back well inside a thousandth of a degree, so this is loose enough to be
   about geometry rather than about floating point. */
export const FACE_PLANAR_TOL_DEG = 0.25;

/* A fitted cylinder is only believed when the vertices sit on it this closely,
   as a fraction of the radius. Tessellation puts the facets *inside* the true
   surface, so a coarse mesh reads slightly small and slightly scattered; 2% is
   comfortably above that and well below anything that is not a cylinder. */
const CYL_FIT_TOL = 0.02;

/* Below this angular sweep a cylindrical face is a corner blend rather than a
   hole or a boss: 360° is a bore, ~90° is a fillet on an edge. */
const FULL_ROUND_MIN_DEG = 300;

// ── small linear algebra ────────────────────────────────────────────────────

/* Eigen-decomposition of a symmetric 3×3 by cyclic Jacobi rotations. Written
   out rather than pulled in because it is thirty lines and the alternative is
   a dependency in a file that has none. Converges in a handful of sweeps for
   a matrix this size. */
function jacobiEigen(m) {
  const a = [m[0].slice(), m[1].slice(), m[2].slice()];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;

    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const out = [0, 1, 2].map((i) => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] }));
  out.sort((x, y) => x.value - y.value);
  return out;
}

function normalise(v) {
  const m = Math.hypot(v[0], v[1], v[2]);
  return m > 0 ? [v[0] / m, v[1] / m, v[2] / m] : null;
}

/* Two unit directions spanning the plane square to `axis`. */
function basisFor(axis) {
  const seed = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const d = seed[0] * axis[0] + seed[1] * axis[1] + seed[2] * axis[2];
  const u = normalise([seed[0] - d * axis[0], seed[1] - d * axis[1], seed[2] - d * axis[2]]);
  const w = [
    axis[1] * u[2] - axis[2] * u[1],
    axis[2] * u[0] - axis[0] * u[2],
    axis[0] * u[1] - axis[1] * u[0],
  ];
  return [u, w];
}

/*
 * Kåsa's algebraic circle fit: least squares on x² + y² = 2cx·x + 2cy·y + k,
 * which is linear in the unknowns and so closes in one 3×3 solve. It biases
 * slightly small on a short arc, which is why a fillet's radius is checked
 * against a tolerance rather than quoted to four figures.
 */
function fitCircle(pts) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    sz += z; sxz += x * z; syz += y * z;
  }
  const a11 = 2 * (sxx - sx * sx / n);
  const a12 = 2 * (sxy - sx * sy / n);
  const a22 = 2 * (syy - sy * sy / n);
  const b1 = sxz - sx * sz / n;
  const b2 = syz - sy * sz / n;
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-18) return null;
  const cx = (b1 * a22 - b2 * a12) / det;
  const cy = (a11 * b2 - a12 * b1) / det;

  let rSum = 0, rMin = Infinity, rMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(pts[i * 2] - cx, pts[i * 2 + 1] - cy);
    rSum += r;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
  }
  return { cx, cy, radius: rSum / n, rMin, rMax };
}

/*
 * Try to read one face group as a cylinder.
 *
 * A cylinder's outward normals all lie square to its axis, so they span a
 * plane and the axis is the direction they never point in — the eigenvector
 * of their covariance with the smallest eigenvalue. A plane's normals span a
 * line and a sphere's span all three, so both are rejected by the same test
 * rather than by a special case.
 *
 * Returns null when the face is not a cylinder, which is the common answer and
 * not a failure.
 */
export function fitCylinder(geom, first, last, triAreas, triFNorm, triCentroid) {
  const { vertices, indices } = geom;

  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0, wSum = 0;
  for (let t = first; t <= last; t++) {
    const a = triAreas[t];
    if (!(a > 0)) continue;
    const x = triFNorm[t * 3], y = triFNorm[t * 3 + 1], z = triFNorm[t * 3 + 2];
    c00 += a * x * x; c01 += a * x * y; c02 += a * x * z;
    c11 += a * y * y; c12 += a * y * z; c22 += a * z * z;
    wSum += a;
  }
  if (wSum <= 0) return null;

  const eig = jacobiEigen([[c00 / wSum, c01 / wSum, c02 / wSum],
                           [c01 / wSum, c11 / wSum, c12 / wSum],
                           [c02 / wSum, c12 / wSum, c22 / wSum]]);

  /* The normals must genuinely span a plane: one direction they avoid, and
     two they do not. A plane fails the second test — its normals sit on a
     line, so only the largest eigenvalue is non-trivial. */
  const axis = normalise(eig[0].vector);
  if (!axis) return null;
  if (eig[0].value > 1e-4) return null;              // normals are not coplanar
  if (eig[1].value < 0.05) return null;              // they collapse to a line: a plane

  const [u, w] = basisFor(axis);

  /* Every distinct vertex of the face, projected square to the axis. */
  const seen = new Set();
  const pts = [];
  for (let t = first; t <= last; t++) {
    if (!(triAreas[t] > 0)) continue;
    for (let k = 0; k < 3; k++) {
      const vi = indices[t * 3 + k];
      if (seen.has(vi)) continue;
      seen.add(vi);
      const px = vertices[vi * 3], py = vertices[vi * 3 + 1], pz = vertices[vi * 3 + 2];
      pts.push(px * u[0] + py * u[1] + pz * u[2], px * w[0] + py * w[1] + pz * w[2]);
    }
  }
  if (pts.length < 8) return null;

  const circle = fitCircle(pts);
  if (!circle || !(circle.radius > 0)) return null;

  const spread = Math.max(circle.rMax - circle.radius, circle.radius - circle.rMin) / circle.radius;
  if (spread > CYL_FIT_TOL) return null;

  /* How far round the face goes. A bore sweeps the full turn; an edge blend
     sweeps about a quarter of it, and that is what tells them apart. */
  let aMin = Infinity, aMax = -Infinity;
  const angles = [];
  for (let i = 0; i < pts.length / 2; i++) {
    const ang = Math.atan2(pts[i * 2 + 1] - circle.cy, pts[i * 2] - circle.cx);
    angles.push(ang);
    if (ang < aMin) aMin = ang;
    if (ang > aMax) aMax = ang;
  }
  /* atan2 wraps at ±π, so the sweep is found by taking out the largest gap
     between successive samples rather than by subtracting the extremes.
     On a closed face that "gap" is just the spacing between two adjacent
     tessellation columns, which would otherwise report a full turn as 355°,
     so a gap no wider than a few times the typical one is not a gap at all
     and the face is closed. */
  angles.sort((p, q) => p - q);
  const gaps = [];
  for (let i = 1; i < angles.length; i++) gaps.push(angles[i] - angles[i - 1]);
  gaps.push((angles[0] + Math.PI * 2) - angles[angles.length - 1]);
  const widestGap = Math.max(...gaps);
  /* Every angular column of a tessellated cylinder carries a vertex at each
     end of the face, so half the gaps are zero and a plain median would be
     zero too. The spacing that matters is between distinct columns. */
  const columnGaps = gaps.filter((g) => g > 1e-9).sort((p, q) => p - q);
  const typicalGap = columnGaps.length ? columnGaps[Math.floor(columnGaps.length / 2)] : 0;
  const closed = widestGap <= Math.max(typicalGap * 3, 1e-6);
  const extentDeg = closed ? 360 : Math.min(360, 360 - (widestGap * 180 / Math.PI));

  /* Convex or concave: does the outward normal lead away from the axis, or
     back towards it? A boss points away; a bore and an internal fillet point
     in. Area-weighted, so a stray facet cannot flip the verdict. */
  let convexArea = 0, concaveArea = 0;
  for (let t = first; t <= last; t++) {
    const a = triAreas[t];
    if (!(a > 0)) continue;
    const cx = triCentroid[t * 3], cy = triCentroid[t * 3 + 1], cz = triCentroid[t * 3 + 2];
    const pu = cx * u[0] + cy * u[1] + cz * u[2] - circle.cx;
    const pw = cx * w[0] + cy * w[1] + cz * w[2] - circle.cy;
    const radial = [u[0] * pu + w[0] * pw, u[1] * pu + w[1] * pw, u[2] * pu + w[2] * pw];
    const rl = Math.hypot(...radial) || 1;
    const dot = (triFNorm[t * 3] * radial[0] + triFNorm[t * 3 + 1] * radial[1] + triFNorm[t * 3 + 2] * radial[2]) / rl;
    if (dot >= 0) convexArea += a; else concaveArea += a;
  }

  const centre = [
    u[0] * circle.cx + w[0] * circle.cy,
    u[1] * circle.cx + w[1] * circle.cy,
    u[2] * circle.cx + w[2] * circle.cy,
  ];

  return {
    type: 'cylinder',
    radius: circle.radius,
    axis,
    /* A point on the axis, not the face's centre of mass. */
    centre,
    extentDeg,
    convex: convexArea >= concaveArea,
    fitSpread: spread,
  };
}

/*
 * What a cylindrical face is, in the words the checks use.
 *
 *   bore    concave, all the way round  — a hole
 *   boss    convex, all the way round   — a pin or a spigot
 *   fillet  concave, part of the way    — an internal corner blend
 *   round   convex, part of the way     — an external corner blend
 *
 * The internal/external distinction is the one the corner-radius guidance
 * turns on: an internal corner concentrates stress and wants ≥ 0.5× wall, an
 * external one impedes flow and wants ≥ 1.5× wall.
 */
export function classifyCylinder(cyl) {
  const full = cyl.extentDeg >= FULL_ROUND_MIN_DEG;
  if (cyl.convex) return full ? 'boss' : 'round';
  return full ? 'bore' : 'fillet';
}

export function aggregateFaces(geom, ctx) {
  const { triAreas, triFNorm, triPullDot, triDraft, triFaceSide, triCentroid, minDraft, isTwoPiece } = ctx;
  const out = [];

  for (const g of geom.faceGroups) {
    let area = 0, nx = 0, ny = 0, nz = 0;
    let innerArea = 0, sideArea = 0;
    let draftSum = 0, draftMin = Infinity, draftMax = -Infinity;
    let pullDotSum = 0;
    let n = 0;

    for (let t = g.first; t <= g.last; t++) {
      const a = triAreas[t];
      if (!(a > 0)) continue;          // degenerate triangles carry no direction
      area += a;
      n++;
      nx += triFNorm[t * 3] * a; ny += triFNorm[t * 3 + 1] * a; nz += triFNorm[t * 3 + 2] * a;
      pullDotSum += triPullDot[t] * a;
      draftSum += triDraft[t] * a;
      if (triDraft[t] < draftMin) draftMin = triDraft[t];
      if (triDraft[t] > draftMax) draftMax = triDraft[t];
      if (triFaceSide[t] === 1) innerArea += a;
      if (Math.abs(triPullDot[t]) < 0.5) sideArea += a;
    }

    if (!n || area <= 0) continue;

    const nLen = Math.hypot(nx, ny, nz) || 1;
    const normal = [nx / nLen, ny / nLen, nz / nLen];

    /* How far the flattest reading is from the most tilted one, as an angle
       between triangle normals and the face's own. */
    let devDeg = 0;
    for (let t = g.first; t <= g.last; t++) {
      if (!(triAreas[t] > 0)) continue;
      const dot = triFNorm[t * 3] * normal[0] + triFNorm[t * 3 + 1] * normal[1] + triFNorm[t * 3 + 2] * normal[2];
      const d = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
      if (d > devDeg) devDeg = d;
    }

    const planar = devDeg <= FACE_PLANAR_TOL_DEG;

    /* Only a face that is not flat can be a cylinder, so the fit is not even
       attempted on the common case — which is also what keeps this cheap on a
       part whose faces are overwhelmingly planar. */
    const cyl = planar ? null : fitCylinder(geom, g.first, g.last, triAreas, triFNorm, triCentroid);
    const surface = cyl
      ? { ...cyl, kind: classifyCylinder(cyl) }
      : { type: planar ? 'plane' : 'unknown' };
    const draftDeg = draftSum / area;
    const isSide = sideArea > area * 0.5;
    const effective = isTwoPiece ? Math.abs(draftDeg) : draftDeg;

    out.push({
      faceId: g.faceId,
      bodyId: g.bodyId != null ? g.bodyId : 0,
      triCount: n,
      area,
      normal,
      pullDot: pullDotSum / area,
      planar,
      planarDevDeg: devDeg,
      /* One angle only where one angle is true. */
      draftDeg: planar ? draftDeg : null,
      draftMinDeg: draftMin,
      draftMaxDeg: draftMax,
      side: innerArea > area * 0.5 ? 'inner' : 'outer',
      kind: isSide ? 'side' : (normal[2] >= 0 ? 'top' : 'bottom'),
      underMin: isSide && effective < minDraft,
      /* What the face *is*, as distinct from how it is oriented: a plane, a
         fitted cylinder with its radius and what that cylinder is for, or an
         honest "unknown" on a curved face nothing recognises. */
      surface,
    });
  }

  return out;
}

/*
 * The headline a per-face measurement buys: not how much area is short of
 * draft, but which faces are, and by how much. Worst first, because that is
 * the order someone fixes them in.
 */
export function summariseFaceDraft(faces) {
  const sides = faces.filter((f) => f.kind === 'side');
  const under = sides.filter((f) => f.underMin);
  const sideArea = sides.reduce((a, f) => a + f.area, 0);
  const underArea = under.reduce((a, f) => a + f.area, 0);

  const worst = under
    .slice()
    .sort((a, b) => (Math.abs(a.draftDeg ?? a.draftMinDeg) - Math.abs(b.draftDeg ?? b.draftMinDeg))
      || (b.area - a.area))
    .slice(0, 5)
    .map((f) => ({
      faceId: f.faceId,
      bodyId: f.bodyId,
      draftDeg: f.draftDeg,
      draftMinDeg: f.draftMinDeg,
      draftMaxDeg: f.draftMaxDeg,
      planar: f.planar,
      side: f.side,
      areaPct: sideArea > 0 ? (f.area / sideArea) * 100 : 0,
    }));

  return {
    faceCount: faces.length,
    sideFaceCount: sides.length,
    underMinCount: under.length,
    underMinAreaPct: sideArea > 0 ? (underArea / sideArea) * 100 : 0,
    curvedSideCount: sides.filter((f) => !f.planar).length,
    worst,
  };
}

/*
 * The cylindrical features found on the part, and the radii to judge them by.
 *
 * One honesty constraint runs through all of this and is worth stating where
 * the data is built rather than only where it is reported: **a corner that was
 * modelled sharp has no cylindrical face at all**, so it cannot appear here. A
 * clean result therefore means "every radius present is adequate", never
 * "every corner has a radius". Anything reading this must say so, or it
 * implies a guarantee the geometry cannot give.
 */
export function summariseFeatures(faces) {
  const cyls = faces
    .filter((f) => f.surface && f.surface.type === 'cylinder')
    .map((f) => ({
      faceId: f.faceId,
      bodyId: f.bodyId,
      kind: f.surface.kind,
      radius: f.surface.radius,
      diameter: f.surface.radius * 2,
      extentDeg: f.surface.extentDeg,
      axis: f.surface.axis,
      area: f.area,
    }));

  const by = (k) => cyls.filter((c) => c.kind === k).sort((p, q) => p.radius - q.radius);
  return {
    /* Corner blends: a partial sweep. Internal wants ≥ 0.5× wall, external
       ≥ 1.5× wall, which is the distinction the guidance turns on. */
    fillets: by('fillet'),
    rounds: by('round'),
    /* Whole features: a full turn. Not corners, and not judged as corners —
       reported because "three Ø8 bores and a Ø12 boss" is what someone wants
       to know before quoting a tool. */
    bores: by('bore'),
    bosses: by('boss'),
    /* Faces that are neither flat nor a cylinder anything could fit. Reported
       rather than ignored, because a part that is mostly this is a part these
       measurements have little to say about. */
    unfittedCount: faces.filter((f) => f.surface && f.surface.type === 'unknown').length,
    cylinderCount: cyls.length,
  };
}
