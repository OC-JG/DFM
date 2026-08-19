import { buildBVH, castRay } from '../../src/geometry/bvh.js';
import { computeBounds } from '../../src/geometry/weld.js';

/*
 * Slow, obviously-correct implementations, for checking the fast ones against.
 *
 * The point of a reference is that it is written from the definition and
 * nothing else — no shared helpers with the code under test, no cleverness to
 * get a fact wrong in the same direction twice. These are far too slow to
 * ship and that is the whole idea.
 */

/*
 * Largest inscribed sphere at a surface point, by brute force.
 *
 * Same derivation the shipped estimator uses — a sphere of radius R tangent
 * at p reaches 2R·cos θ along a direction θ off the normal, so a hit at t
 * bounds the diameter at t/cos θ — but swept with 2561 directions instead of
 * 33. If the shipped version is right, it lands slightly above this (fewer
 * directions can only miss constraints, never invent them).
 */
export function referenceSphereThickness(bvh, geom, t, p, outwardNormal, eps, diag, opts = {}) {
  const { nTheta = 40, nPhi = 64, extraThetaDeg = [] } = opts;
  const [nx, ny, nz] = outwardNormal;
  const ix = -nx, iy = -ny, iz = -nz;

  let ux = Math.abs(ix) < 0.9 ? 1 : 0, uy = Math.abs(ix) < 0.9 ? 0 : 1, uz = 0;
  const d = ux * ix + uy * iy + uz * iz;
  ux -= d * ix; uy -= d * iy; uz -= d * iz;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = iy * uz - iz * uy, vy = iz * ux - ix * uz, vz = ix * uy - iy * ux;

  const ox = p[0] + ix * eps, oy = p[1] + iy * eps, oz = p[2] + iz * eps;
  let best = Infinity;

  /* The sweep must be a superset of whatever the estimator probes, or
     "reference ≤ estimate" is a coincidence rather than a theorem: two
     approximations of the same minimum, taken on different direction sets,
     can each come out under the other. Feeding the estimator's own polar
     angles in makes the inequality structural, so a violation is a real bug
     rather than a sampling artefact. */
  const thetas = [];
  for (let a = 0; a <= nTheta; a++) thetas.push((a / nTheta) * (85 * Math.PI / 180));
  for (const deg of extraThetaDeg) thetas.push(deg * Math.PI / 180);
  thetas.sort((x, y) => x - y);

  for (let a = 0; a < thetas.length; a++) {
    const th = thetas[a];
    const ct = Math.cos(th), st = Math.sin(th);
    const phis = th === 0 ? 1 : nPhi;
    for (let b = 0; b < phis; b++) {
      const ph = (b / phis) * Math.PI * 2;
      const cu = st * Math.cos(ph), cv = st * Math.sin(ph);
      const dx = ix * ct + ux * cu + vx * cv;
      const dy = iy * ct + uy * cu + vy * cv;
      const dz = iz * ct + uz * cu + vz * cv;
      const hit = castRay(bvh, geom, ox, oy, oz, dx, dy, dz, eps, t);
      if (hit === Infinity || hit >= diag) continue;
      const bound = hit / ct;
      if (bound < best) best = bound;
    }
  }
  return best;
}

/* Per-triangle centroid, unit normal and area, computed straight from the
   index buffer so the tests do not depend on analyseMesh to check itself. */
export function triangleData(geom) {
  const { vertices, indices, triCount } = geom;
  const centroid = new Float64Array(triCount * 3);
  const normal = new Float64Array(triCount * 3);
  const area = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
    const cx = vertices[c], cy = vertices[c + 1], cz = vertices[c + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    area[t] = len / 2;
    normal[t * 3] = nx / len; normal[t * 3 + 1] = ny / len; normal[t * 3 + 2] = nz / len;
    centroid[t * 3] = (ax + bx + cx) / 3;
    centroid[t * 3 + 1] = (ay + by + cy) / 3;
    centroid[t * 3 + 2] = (az + bz + cz) / 3;
  }
  return { centroid, normal, area };
}

/* Ray-cast wall thickness at a triangle, straight from the definition. */
export function rayThicknessAt(bvh, geom, t, centroid, normal, eps, diag) {
  const p = [centroid[t * 3], centroid[t * 3 + 1], centroid[t * 3 + 2]];
  const n = [normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]];
  const hit = castRay(bvh, geom,
    p[0] - n[0] * eps, p[1] - n[1] * eps, p[2] - n[2] * eps,
    -n[0], -n[1], -n[2], eps, t);
  return (hit === Infinity || hit >= diag) ? null : hit;
}

/* Undirected edge census, written independently of src/geometry/validate.js
   so the two can disagree. */
export function referenceEdgeCensus(geom) {
  const { indices, triCount } = geom;
  const seen = new Map();
  for (let t = 0; t < triCount; t++) {
    const v = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (a === b) continue;
      const key = `${Math.min(a, b)}_${Math.max(a, b)}`;
      const rec = seen.get(key) || { fwd: 0, rev: 0 };
      if (a < b) rec.fwd++; else rec.rev++;
      seen.set(key, rec);
    }
  }
  let boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const rec of seen.values()) {
    const total = rec.fwd + rec.rev;
    if (total === 1) boundary++;
    else if (total > 2) nonManifold++;
    else if (rec.fwd !== 1 || rec.rev !== 1) inconsistent++;
  }
  return { total: seen.size, boundary, nonManifold, inconsistent };
}

/* Signed volume by the divergence theorem, summed over triangles. */
export function referenceSignedVolume(geom) {
  const { vertices, indices, triCount } = geom;
  let v = 0;
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
    const cx = vertices[c], cy = vertices[c + 1], cz = vertices[c + 2];
    v += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

export function bvhFor(geom) {
  return { bvh: buildBVH(geom), bounds: computeBounds(geom.vertices) };
}
