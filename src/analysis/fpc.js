import { buildBVH, castRayAll, closestPoint } from '../geometry/bvh.js';
import { stats, makeRandom } from './stats.js';

/*
 * Where the FPC is, and how much polymer covers it.
 *
 * Two rules used to say they could not answer this. The wall check applied the
 * FPC floor — flex thickness plus cover on both faces — to the whole part,
 * because it had no way to know which part of the part was over the insert; and
 * the FPC check's gate advisory was a sentence telling the reader to go and
 * look, because it could not measure the distance itself. Both said so in a
 * comment (`engine.js`), and the second sat inside a check carrying twelve
 * points.
 *
 * What was missing was not a measurement but a designation. A multi-body STEP
 * of an overmoulded assembly already carries the flex as its own solid, and the
 * body selector already lists them; marking which one it is turns both
 * questions into ray casts.
 *
 * ── How cover is measured ────────────────────────────────────────────────
 *
 * Along the outward normal of each sampled point on the insert — a ray, not a
 * nearest point, because the question is how much material lies over *this*
 * piece of surface and a nearest point would happily answer with the distance
 * to a wall beside the insert rather than the wall over it.
 *
 * Not the nearest hit along that ray, either, which is the trap. An assembly
 * that models a clearance pocket around the insert — a perfectly ordinary way
 * to draw one — puts a surface a few hundredths in front of the insert's own,
 * so the nearest hit is the pocket wall and the cover comes back as the
 * clearance. What is wanted is the polymer the ray passes through, so every
 * crossing is enumerated and the segments inside the solid are added up. That
 * reads the same 1.9 mm whether the pocket was modelled or not.
 *
 * A ray that passes through no polymer at all is not a small cover, it is no
 * cover: the insert is exposed there. That may be deliberate — a contact pad or
 * a connector tail has to reach daylight — so it is reported as its own
 * quantity rather than folded into the minimum, where one deliberately exposed
 * pad would drag the figure to zero and condemn the part.
 */

/* Sample points on the insert surface, area-weighted. The insert is a small
   fraction of the assembly, and cover is judged on its minimum, so this is
   dense relative to the surface it covers. */
export const FPC_SAMPLES = 2000;

/*
 * Crossings a single ray may report before the sample is abandoned. A ray
 * through a ribbed section crosses a dozen surfaces; sixty-four is far past
 * anything real, and a ray that exceeds it has its parity in doubt, which
 * makes the material along it unknowable rather than merely large. Counted and
 * reported rather than clamped.
 *
 * The budget is in raw hits rather than crossings, because a ray along a facet
 * edge or diagonal is reported by every incident triangle — so this allows at
 * least thirty crossings, and still far past anything real.
 *
 * Overridable through `maxCrossings` for the same reason mesh.js exposes
 * thicknessFullCap: the behaviour either side of this threshold differs, and a
 * test should be able to reach the far side of it without a fixture built from
 * sixty-five nested walls.
 */
export const MAX_CROSSINGS = 64;

/*
 * Polymer traversed along a ray, from the segments inside the solid.
 *
 * The surface is closed, so the parity of the crossing count says which side
 * the ray starts on: an odd count means it starts inside the polymer, which is
 * the case when no pocket was modelled and the insert sits in solid material.
 * From there the inside segments alternate.
 *
 *   inside at the start:   [0, h0], [h1, h2], [h3, h4], …
 *   outside at the start:  [h0, h1], [h2, h3], …
 *
 * Returns NaN when the crossing budget was exhausted and the parity is
 * therefore unknown.
 */
function materialAlongRay(bvh, geom, ox, oy, oz, dx, dy, dz, eps, hits) {
  const n = castRayAll(bvh, geom, ox, oy, oz, dx, dy, dz, eps, hits);
  if (n < 0) return NaN;    // more crossings than the budget: parity unknown
  if (n === 0) return 0;

  let total = 0;
  if (n % 2 === 1) {
    total = hits[0];
    for (let k = 2; k < n; k += 2) total += hits[k] - hits[k - 1];
  } else {
    for (let k = 0; k + 1 < n; k += 2) total += hits[k + 1] - hits[k];
  }
  return total;
}

/* Fixed jitter seed: the same pair of files must report the same cover twice.
   See makeRandom in stats.js. */
const FPC_SEED = 0x27D4EB2F;

/*
 * A geometry over a subset of the triangles, sharing the vertex buffer.
 *
 * Sharing rather than copying is what makes this cheap enough to do twice per
 * run: only the index array is rebuilt, and the vertex positions — much the
 * larger buffer — are the same ones the caller already has.
 */
function subGeometry(geom, keep) {
  const indices = new Uint32Array(keep.length * 3);
  for (let k = 0; k < keep.length; k++) {
    indices[k * 3] = geom.indices[keep[k] * 3];
    indices[k * 3 + 1] = geom.indices[keep[k] * 3 + 1];
    indices[k * 3 + 2] = geom.indices[keep[k] * 3 + 2];
  }
  return { vertices: geom.vertices, indices, triCount: keep.length, vertCount: geom.vertCount };
}

/* Triangle indices inside, and outside, the designated bodies. Bodies carry
   contiguous triangle ranges (see step.js), so this is a range test. */
function splitRegion(triCount, region) {
  const inside = [];
  const outside = [];
  for (let t = 0; t < triCount; t++) {
    let hit = false;
    for (const r of region) {
      if (t >= r.triStart && t < r.triEnd) { hit = true; break; }
    }
    (hit ? inside : outside).push(t);
  }
  return { inside, outside };
}

/*
 * Measure the designated insert against the rest of the part.
 *
 * `region` is an array of `{ triStart, triEnd }` — the triangle ranges of the
 * bodies the user marked as the flex. `requiredCover` is the cover the process
 * needs on each face, in millimetres, so this can report how much of the
 * insert falls short of it; the threshold is a process input, in the same way
 * `minDraft` is one for analyseMesh, and thresholding elsewhere would mean
 * carrying every sample out of here to do it.
 *
 * Returns null when there is nothing to measure — no designation, or a
 * designation that covers every triangle or none — which is what keeps the
 * rules that read this on their old advisory wording rather than inventing a
 * verdict from an empty set.
 */
export function analyseFpcRegion({ geom, shot, region, requiredCover, gateLocation, samples, seed, maxCrossings = MAX_CROSSINGS }) {
  if (!region || !region.length) return null;

  const { inside, outside } = splitRegion(geom.triCount, region);
  if (!inside.length || !outside.length) return null;

  const { triAreas, triFNorm, diag } = shot;

  /* Area CDF over the insert's triangles only. */
  const cdf = new Float64Array(inside.length);
  let acc = 0;
  for (let k = 0; k < inside.length; k++) { acc += triAreas[inside[k]]; cdf[k] = acc; }
  if (!(acc > 0)) return null;

  const restGeom = subGeometry(geom, outside);
  const restBvh = buildBVH(restGeom);
  const insideGeom = subGeometry(geom, inside);

  const n = samples || FPC_SAMPLES;
  const random = makeRandom(seed != null ? seed : FPC_SEED);
  const eps = diag * 1e-5;

  /* Cover is measured on a ray from the insert surface outward, so a sample
     with nothing over it contributes to `uncovered` rather than to the
     distribution — a deliberately exposed pad is not a thin wall. */
  const covers = [];
  const hits = new Float64Array(maxCrossings);
  let uncovered = 0;
  let below = 0;
  let indeterminate = 0;

  for (let s = 0; s < n; s++) {
    const u = (s + random()) / n * acc;
    let lo = 0, hi = inside.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cdf[m] < u) lo = m + 1; else hi = m;
    }
    const t = inside[lo];

    /* A point inside the triangle rather than its centroid: a flex modelled as
       a handful of large facets would otherwise be measured at a handful of
       places, and the minimum is the figure that matters. */
    const r1 = Math.sqrt(random());
    const r2 = random();
    const wa = 1 - r1, wb = r1 * (1 - r2), wc = r1 * r2;
    const ia = geom.indices[t * 3] * 3, ib = geom.indices[t * 3 + 1] * 3, ic = geom.indices[t * 3 + 2] * 3;
    const px = wa * geom.vertices[ia]     + wb * geom.vertices[ib]     + wc * geom.vertices[ic];
    const py = wa * geom.vertices[ia + 1] + wb * geom.vertices[ib + 1] + wc * geom.vertices[ic + 1];
    const pz = wa * geom.vertices[ia + 2] + wb * geom.vertices[ib + 2] + wc * geom.vertices[ic + 2];

    const nx = triFNorm[t * 3], ny = triFNorm[t * 3 + 1], nz = triFNorm[t * 3 + 2];
    const cover = materialAlongRay(restBvh, restGeom,
      px + nx * eps, py + ny * eps, pz + nz * eps, nx, ny, nz, eps, hits);

    if (Number.isNaN(cover)) { indeterminate++; continue; }
    if (cover <= 0) { uncovered++; continue; }
    covers.push(cover);
    if (requiredCover != null && cover < requiredCover) below++;
  }

  /* Distance from the gate to the nearest point of the insert. The advisory it
     replaces asked the reader to check that the gate is at least one wall
     thickness clear of the flex; a flow front arriving straight onto an insert
     lifts or wrinkles it. */
  let gateDistance = null;
  if (gateLocation && Array.isArray(gateLocation) && gateLocation.length === 3) {
    const insideBvh = buildBVH(insideGeom);
    const d = closestPoint(insideBvh, insideGeom,
      gateLocation[0], gateLocation[1], gateLocation[2], Infinity, new Float64Array(4));
    gateDistance = isFinite(d) ? d : null;
  }

  let regionArea = 0;
  for (const t of inside) regionArea += triAreas[t];
  let partArea = 0;
  for (const t of outside) partArea += triAreas[t];

  return {
    located: true,
    regionTris: inside.length,
    regionArea,
    partArea,
    samples: n,
    /* `stats` already carries min, median and the percentiles, so cover is
       reported through it rather than duplicated alongside. */
    coverStats: covers.length ? stats(covers) : null,
    /* Of the insert's area, how much has no polymer over it at all. */
    uncoveredPct: (uncovered / n) * 100,
    /* And how much could not be measured, so a reader can tell a cover of
       zero from a ray this could not follow. */
    indeterminatePct: (indeterminate / n) * 100,
    /* And how much of the covered area is thinner than the process needs. */
    belowRequiredPct: requiredCover != null ? (below / n) * 100 : null,
    requiredCover: requiredCover != null ? requiredCover : null,
    gateDistance,
  };
}
