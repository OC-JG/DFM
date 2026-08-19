/*
 * Analytic mesh generators for the unit tests.
 *
 * Every shape here has a closed-form answer for whatever it is used to test:
 * a known wall thickness, a known draft angle, a known number of boundary
 * edges. Tests assert against those numbers rather than against "a value was
 * produced", which is the gap the browser smoke test leaves open.
 *
 * Shapes are emitted as unindexed triangle soup — the same shape an STL
 * arrives in — so weldGeometry is exercised on the way in rather than
 * bypassed.
 */

/* Emit one quad as two triangles. Vertices must be listed counter-clockwise
   as seen from outside the solid, which puts the face normal outward. */
export function quad(out, a, b, c, d) {
  out.push(...a, ...b, ...c);
  out.push(...a, ...c, ...d);
}

export function tri(out, a, b, c) {
  out.push(...a, ...b, ...c);
}

export function toSoup(list) {
  const positions = new Float32Array(list);
  return { positions, triCount: positions.length / 9 };
}

/* The six faces of an axis-aligned box, each already wound outward. Returned
   as quads so callers can drop, reverse or duplicate individual faces. */
export function boxFaces(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    px: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
    nx: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    py: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    ny: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    pz: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    nz: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
  };
}

/*
 * Closed axis-aligned box. 12 triangles, outward winding, positive volume.
 *   opts.omit    array of face keys to leave out, producing boundary edges
 *   opts.invert  reverse every triangle, producing inward normals
 *   opts.extraFin add a triangle hanging off one edge, producing a
 *                 non-manifold edge with three incident faces
 */
export function box(size = [40, 30, 20], opts = {}) {
  const [w, h, d] = size;
  const min = [0, 0, 0];
  const max = [w, h, d];
  const faces = boxFaces(min, max);
  const out = [];
  for (const [key, v] of Object.entries(faces)) {
    if (opts.omit && opts.omit.includes(key)) continue;
    quad(out, v[0], v[1], v[2], v[3]);
  }
  if (opts.extraFin) {
    /* Shares the edge (0,0,0)-(0,0,d) with the -X and -Y faces. */
    tri(out, [0, 0, 0], [0, 0, d], [-w * 0.3, -h * 0.3, d * 0.5]);
  }
  if (opts.invert) {
    for (let t = 0; t < out.length; t += 9) {
      for (let k = 0; k < 3; k++) {
        const tmp = out[t + 3 + k]; out[t + 3 + k] = out[t + 6 + k]; out[t + 6 + k] = tmp;
      }
    }
  }
  return toSoup(out);
}

/*
 * Box shelled to an exact uniform wall. The cavity is fully enclosed, so the
 * solid is the region between the two surfaces and the true wall thickness is
 * `wall` everywhere except at the corners.
 */
export function hollowBox(size = [40, 30, 20], wall = 2) {
  const [w, h, d] = size;
  const outer = boxFaces([0, 0, 0], [w, h, d]);
  const inner = boxFaces([wall, wall, wall], [w - wall, h - wall, d - wall]);
  const out = [];
  for (const v of Object.values(outer)) quad(out, v[0], v[1], v[2], v[3]);
  /* Cavity surface reversed: its normals must point into the void, which is
     "outward from the solid". */
  for (const v of Object.values(inner)) quad(out, v[0], v[3], v[2], v[1]);
  return toSoup(out);
}

/*
 * Hollow cylinder with an exact uniform wall. Curved, so it also exercises
 * the area-weighted sampler on faces of unequal size.
 */
export function tube(rOuter = 20, wall = 2, height = 40, seg = 96) {
  const rInner = rOuter - wall;
  const out = [];
  const at = (r, a, z) => [r * Math.cos(a), r * Math.sin(a), z];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    quad(out, at(rOuter, a0, 0), at(rOuter, a1, 0), at(rOuter, a1, height), at(rOuter, a0, height));
    quad(out, at(rInner, a0, 0), at(rInner, a0, height), at(rInner, a1, height), at(rInner, a1, 0));
    quad(out, at(rOuter, a0, 0), at(rInner, a0, 0), at(rInner, a1, 0), at(rOuter, a1, 0));
    quad(out, at(rOuter, a0, height), at(rOuter, a1, height), at(rInner, a1, height), at(rInner, a0, height));
  }
  return toSoup(out);
}

/*
 * Square frustum: a box whose four side walls are drafted by exactly
 * `draftDeg` from the pull axis (+Z). Every side face therefore has
 * n·ẑ = sin(draftDeg), so the measured draft is the stated draft.
 */
export function frustum(baseHalf = 20, height = 30, draftDeg = 3) {
  const t = Math.tan(draftDeg * Math.PI / 180) * height;
  const a = baseHalf;
  const b = baseHalf - t;
  const out = [];
  const B = [[-a, -a, 0], [a, -a, 0], [a, a, 0], [-a, a, 0]];
  const T = [[-b, -b, height], [b, -b, height], [b, b, height], [-b, b, height]];
  quad(out, B[0], B[3], B[2], B[1]);            // base, normal -Z
  quad(out, T[0], T[1], T[2], T[3]);            // top, normal +Z
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(out, B[i], B[j], T[j], T[i]);
  }
  return toSoup(out);
}

/*
 * Slab whose two large faces converge at `angleDeg`. The bottom face is flat
 * at z = 0; the top face tilts about the Y axis.
 *
 * Used to give the ray and sphere thickness estimates something to disagree
 * about. There is a tidy closed form for two infinite converging planes, but
 * it does not describe this fixture: at anything past a shallow angle the
 * block's other faces bind first, and the sphere at a point on the large face
 * is limited by the sides rather than by the convergence. The tests therefore
 * check the estimator against the brute-force reference in reference.mjs,
 * which needs no such assumption.
 */
export function wedgeSlab(length = 60, width = 30, h0 = 6, angleDeg = 45) {
  const tanA = Math.tan(angleDeg * Math.PI / 180);
  const zTop = (x) => h0 + x * tanA;
  const out = [];
  const x0 = 0, x1 = length, y0 = 0, y1 = width;
  quad(out, [x0, y0, 0], [x0, y1, 0], [x1, y1, 0], [x1, y0, 0]);                     // -Z
  quad(out, [x0, y0, zTop(x0)], [x1, y0, zTop(x1)], [x1, y1, zTop(x1)], [x0, y1, zTop(x0)]); // top
  quad(out, [x0, y0, 0], [x1, y0, 0], [x1, y0, zTop(x1)], [x0, y0, zTop(x0)]);       // -Y
  quad(out, [x0, y1, 0], [x0, y1, zTop(x0)], [x1, y1, zTop(x1)], [x1, y1, 0]);       // +Y
  quad(out, [x0, y0, 0], [x0, y0, zTop(x0)], [x0, y1, zTop(x0)], [x0, y1, 0]);       // -X
  quad(out, [x1, y0, 0], [x1, y1, 0], [x1, y1, zTop(x1)], [x1, y0, zTop(x1)]);       // +X
  return toSoup(out);
}

/*
 * Perturb every vertex occurrence by a deterministic sub-tolerance amount, so
 * occurrences of the same logical vertex straddle the welder's quantisation
 * cells. Every pair stays strictly inside the weld tolerance, so a correct
 * welder merges them all and the mesh stays closed.
 *
 * amount is a fraction of the weld tolerance (diag × 1e-5). Each axis moves
 * by at most ±amount·tol, so the worst-case separation between two
 * occurrences is 2·amount·tol·√3 — kept under tol by the caller's choice.
 */
export function jitterSoup(soup, amount = 0.28) {
  const p = soup.positions;
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < mnx) mnx = p[i];         if (p[i] > mxx) mxx = p[i];
    if (p[i + 1] < mny) mny = p[i + 1]; if (p[i + 1] > mxy) mxy = p[i + 1];
    if (p[i + 2] < mnz) mnz = p[i + 2]; if (p[i + 2] > mxz) mxz = p[i + 2];
  }
  const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz);
  const tol = Math.max(diag * 1e-5, 1e-6);
  const step = tol * amount;

  const out = new Float32Array(p.length);
  /* A fixed integer sequence rather than a random one: the fixture has to be
     the same on every run or a failure is not reproducible. */
  let s = 1;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return ((s >> 8) % 3) - 1; };
  for (let i = 0; i < p.length; i++) out[i] = p[i] + next() * step;
  return { positions: out, triCount: soup.triCount, tol };
}

/* Uniformly scale a soup, for the unit-detection tests. */
export function scaleSoup(soup, factor) {
  const out = new Float32Array(soup.positions.length);
  for (let i = 0; i < out.length; i++) out[i] = soup.positions[i] * factor;
  return { positions: out, triCount: soup.triCount };
}

/*
 * Closed box with one face wound backwards. Still watertight, still one
 * enclosed volume — but four of its edges are now traversed the same way by
 * both of their triangles, which is what winding-inconsistency detection is
 * looking for.
 */
export function boxWithFlippedFace(size = [40, 30, 20], face = 'pz') {
  const [w, h, d] = size;
  const faces = boxFaces([0, 0, 0], [w, h, d]);
  const out = [];
  for (const [key, v] of Object.entries(faces)) {
    if (key === face) quad(out, v[0], v[3], v[2], v[1]);
    else quad(out, v[0], v[1], v[2], v[3]);
  }
  return toSoup(out);
}

/*
 * Frustum shelled to a uniform wall: drafted side walls *and* a moulding-
 * sensible wall thickness at the same time.
 *
 * The solid frustum is the natural draft fixture but it is 30 mm of solid
 * plastic, so every wall-thickness rule fails on it. This is the shape needed
 * to test that a part with nothing wrong with it scores full marks.
 *
 * The inner frustum keeps the same wall angle and steps in by `wall`, so the
 * perpendicular wall is wall·cos(draft) — 0.14% under nominal at 3°, which is
 * inside the tolerance any test here asserts to.
 */
export function hollowFrustum(baseHalf = 20, height = 30, draftDeg = 3, wall = 2) {
  const t = Math.tan(draftDeg * Math.PI / 180);
  const ring = (half, z) => [
    [-half, -half, z], [half, -half, z], [half, half, z], [-half, half, z],
  ];
  const out = [];

  const oB = ring(baseHalf, 0);
  const oT = ring(baseHalf - t * height, height);
  const iB = ring(baseHalf - wall, wall);
  const iT = ring(baseHalf - wall - t * (height - 2 * wall), height - wall);

  quad(out, oB[0], oB[3], oB[2], oB[1]);   // outer base, normal −Z
  quad(out, oT[0], oT[1], oT[2], oT[3]);   // outer top, normal +Z
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(out, oB[i], oB[j], oT[j], oT[i]); // outer walls
  }

  /* Cavity, wound so its normals face into the void. */
  quad(out, iB[0], iB[1], iB[2], iB[3]);
  quad(out, iT[0], iT[3], iT[2], iT[1]);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(out, iB[i], iT[i], iT[j], iB[j]);
  }
  return toSoup(out);
}

/*
 * Overhanging step: an L-shaped profile extruded along Y.
 *
 *      z
 *   20 +--------------+
 *      |              |
 *   10 +-------+      |
 *      |       |      |     the underside of the overhang, z = 10 from
 *    0 +-------+······+     x = 30 to 44, faces against a +Z pull and its
 *      0      30      44 x  outward ray leaves the part: one external
 *                          undercut, needing one slide.
 *
 * Built as an extruded profile rather than a barb stuck on a box face,
 * because a barb leaves T-junctions: the box's side faces span the full
 * height with a single edge, while the face the barb grows out of is split
 * at the barb's top and bottom, so the two no longer share edges and the
 * mesh is not closed. Every vertex here is on both the profile outline and
 * the faces that meet it.
 *
 * Known answers: enclosed volume 22,200 mm³, and 420 mm² of slide undercut
 * (14 mm of overhang × 30 mm of extrusion) on a +Z pull.
 */
export function overhangBlock(lower = 30, upper = 44, depth = 30, zStep = 10, zTop = 20) {
  /* Profile outline, counter-clockwise in XZ — corners only, now that the caps
     are triangulated rather than hand-written. */
  const P = [
    [0, 0], [lower, 0], [lower, zStep], [upper, zStep],
    [upper, zTop], [0, zTop],
  ];
  return extrudeProfileXZ(P, depth);
}

/*
 * Split every triangle into four by its edge midpoints.
 *
 * For asserting that an answer depends on the geometry and not on how finely
 * it was exported — the same shape, four and sixteen times the triangles, has
 * to give the same undercut regions and the same wall thickness.
 */
export function subdivideSoup(soup, times = 1) {
  let positions = soup.positions;
  let triCount = soup.triCount;
  for (let pass = 0; pass < times; pass++) {
    const out = new Float32Array(triCount * 4 * 9);
    let o = 0;
    const mid = (p, a, b, k) => (p[a + k] + p[b + k]) / 2;
    for (let t = 0; t < triCount; t++) {
      const A = t * 9, B = t * 9 + 3, C = t * 9 + 6;
      const ab = [mid(positions, A, B, 0), mid(positions, A, B, 1), mid(positions, A, B, 2)];
      const bc = [mid(positions, B, C, 0), mid(positions, B, C, 1), mid(positions, B, C, 2)];
      const ca = [mid(positions, C, A, 0), mid(positions, C, A, 1), mid(positions, C, A, 2)];
      const a = [positions[A], positions[A + 1], positions[A + 2]];
      const b = [positions[B], positions[B + 1], positions[B + 2]];
      const c = [positions[C], positions[C + 1], positions[C + 2]];
      for (const tri of [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]) {
        for (const v of tri) { out[o++] = v[0]; out[o++] = v[1]; out[o++] = v[2]; }
      }
    }
    positions = out;
    triCount *= 4;
  }
  return { positions, triCount };
}

/*
 * Cup open at the bottom, with an annular snap ledge inside — the case a lifter
 * exists for, and the case no slide can reach.
 *
 * Half-section, revolved about the Z axis:
 *
 *     z
 *  20 |####################|        <- top wall, solid disc
 *  18 |###|            |###|        <- cavity ceiling
 *     |###|            |###|
 *  12 |###|        |###|###|        <- ledge top
 *   8 |###|        |###|###|        <- ledge underside, faces -Z
 *     |###|            |###|
 *   0 |###|            |###|        <- mouth, open
 *     0  16           18  20  r
 *
 * The core fills the cavity and withdraws downward through the mouth. Above the
 * ledge it is 16 mm in radius; the gap at the ledge is 14 mm. So it cannot come
 * out — the ledge needs a lifter. And unlike an extruded channel, nothing can
 * reach the cavity sideways: revolving closes it all the way round, so a
 * side-action slide has no way in from any direction.
 *
 * Revolved rather than extruded for exactly that reason. An extruded C-section
 * looks like a housing in cross-section but is a through-channel in the third
 * dimension, and a slide can enter from either open end — which is what the
 * first attempt at this fixture got wrong, and the tool was right to say so.
 */
export function internalLedgeCup(opts = {}) {
  const {
    rOuter = 20, wall = 2, height = 20, seg = 96,
    ledgeZ = 8, ledgeH = 4, ledgeD = 2,
  } = opts;
  const rInner = rOuter - wall;
  const hCeil = height - wall;
  const rLedge = rInner - ledgeD;

  const profile = [
    [rInner, 0],                  // inner edge of the mouth
    [rOuter, 0],                  // outer edge of the mouth
    [rOuter, height],             // up the outside
    [0, height],                  // across the top
    [0, hCeil],                   // down the axis (no surface; skipped)
    [rInner, hCeil],              // cavity ceiling, outward from the axis
    [rInner, ledgeZ + ledgeH],    // down the inner wall to the ledge
    [rLedge, ledgeZ + ledgeH],    // ledge top
    [rLedge, ledgeZ],             // ledge inner face
    [rInner, ledgeZ],             // ledge underside
  ];
  return revolveProfileRZ(profile, seg);
}

/*
 * Revolve a closed (r, z) profile about the Z axis into a watertight solid.
 *
 * Watertight by construction: each profile segment becomes a ring of quads whose
 * edges are shared with the rings either side and with the neighbouring angular
 * step, so there is nowhere for a T-junction to appear. That is why the awkward
 * fixtures here are revolved rather than extruded — an extrusion needs its end
 * caps triangulated over the profile's own vertices, and getting that wrong
 * fails quietly.
 *
 * Segments lying on the axis carry no surface and are skipped; segments touching
 * it become triangle fans.
 */
export function revolveProfileRZ(profile, seg = 96) {
  const out = [];
  const n = profile.length;
  const pt = (r, z, a) => [r * Math.cos(a), r * Math.sin(a), z];

  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    for (let j = 0; j < n; j++) {
      const [r0, z0] = profile[j];
      const [r1, z1] = profile[(j + 1) % n];
      if (r0 === 0 && r1 === 0) continue;
      if (r0 === 0) tri(out, pt(0, z0, a0), pt(r1, z1, a1), pt(r1, z1, a0));
      else if (r1 === 0) tri(out, pt(r0, z0, a0), pt(r0, z0, a1), pt(0, z1, a0));
      else quad(out, pt(r0, z0, a0), pt(r0, z0, a1), pt(r1, z1, a1), pt(r1, z1, a0));
    }
  }
  return toSoup(out);
}

/*
 * Extrude a closed XZ profile along Y into a watertight solid.
 *
 * The caps are triangulated by ear clipping over the profile's own vertices —
 * no new points. That is the whole trick: a cap that introduces a midpoint the
 * neighbouring side wall does not have leaves a T-junction, and the mesh stops
 * being closed. Ear clipping also means any simple polygon works, which
 * hand-written cap lists emphatically do not: the first attempt at the housing
 * below both left two outline edges uncovered and produced a zero-area triangle
 * from three collinear points, and neither was obvious by inspection.
 */
export function extrudeProfileXZ(profile, depth) {
  const tris = earClipXZ(profile);
  const at = (i, y) => [profile[i][0], y, profile[i][1]];
  const out = [];
  for (const [a, b, c] of tris) {
    tri(out, at(a, 0), at(b, 0), at(c, 0));            // front cap, normal −Y
    tri(out, at(c, depth), at(b, depth), at(a, depth)); // back cap, normal +Y
  }
  for (let i = 0; i < profile.length; i++) {
    const j = (i + 1) % profile.length;
    quad(out, at(i, 0), at(i, depth), at(j, depth), at(j, 0));
  }
  return toSoup(out);
}

/*
 * Ear clipping over a counter-clockwise simple polygon in the XZ plane.
 *
 * Returns triangles as index triples. Every polygon edge ends up in exactly one
 * triangle and every diagonal in exactly two, which is what makes the extruded
 * solid watertight.
 */
export function earClipXZ(profile) {
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const inside = (p, a, b, c) => {
    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
  };

  const live = profile.map((_, i) => i);
  const tris = [];
  let guard = profile.length * profile.length + 8;

  while (live.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < live.length; k++) {
      const ia = live[(k - 1 + live.length) % live.length];
      const ib = live[k];
      const ic = live[(k + 1) % live.length];
      const a = profile[ia], b = profile[ib], c = profile[ic];

      /* Convex corner of a counter-clockwise polygon, with real area. */
      const turn = cross(a, b, c);
      if (turn <= 1e-9) continue;

      /* No other live vertex may fall inside the ear. */
      let blocked = false;
      for (const io of live) {
        if (io === ia || io === ib || io === ic) continue;
        if (inside(profile[io], a, b, c)) { blocked = true; break; }
      }
      if (blocked) continue;

      tris.push([ia, ib, ic]);
      live.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // not a simple CCW polygon; caller will see an open mesh
  }
  if (live.length === 3) tris.push([live[0], live[1], live[2]]);
  return tris;
}
