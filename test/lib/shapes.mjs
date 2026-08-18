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
