/*
 * Bounding volume hierarchy for O(log n) ray casting.
 *
 * Build strategy is a mid-point split on the longest axis of the centroid
 * bounds, falling back to an equal-count split (quickselect) when the
 * mid-point lands outside the spread and leaves a child empty. This replaces
 * the original full sort at every node — that allocated a fresh JS array and
 * sorted it per node, which is O(n log²n) with a great deal of garbage. The
 * mid-point/quickselect pass is O(n) per level with no allocation at all.
 *
 * Nodes are stored in parallel typed arrays:
 *   bounds[i*6 .. i*6+5]  minx miny minz maxx maxy maxz
 *   meta[i*3 + 0]         leaf ? firstPrim : leftChild
 *   meta[i*3 + 1]         leaf ? primCount : rightChild
 *   meta[i*3 + 2]         1 = leaf, 0 = internal
 */

const LEAF_THRESH = 8;
const MAX_DEPTH = 40;

/* Traversal scratch, reused across every castRay call. Depth is bounded by
   MAX_DEPTH, so twice that is ample headroom for the sibling pushes. */
const RAY_STACK = new Int32Array(MAX_DEPTH * 2 + 8);

/*
 * Work counters, for the performance budget in test/perf.mjs.
 *
 * Wall clock cannot be the budget. Six runs of the same analysis on the same
 * machine spread 320–497 ms, and a CI runner is worse, so a threshold loose
 * enough not to fail on noise is too loose to catch anything. What *is*
 * deterministic is how much work the analysis asks for: rays cast, BVH nodes
 * visited, triangles tested. Those are identical run to run and on every
 * machine, so they can be budgeted exactly, and they move when either of the
 * two levers named in docs/ASSESSMENT.md moves.
 *
 * Counted here rather than at the call sites because this is where the work
 * happens, and because `nodes` and `tris` catch a class `rays` cannot: a BVH
 * that stops partitioning well costs the same rays and many times the
 * traversal. Three increments in the traversal loop, whose cost is below the
 * run-to-run noise of the thing being measured — the point above, arriving
 * from the other side — and worth paying for a check that fails on a real
 * regression rather than on which runner drew the job.
 */
export const bvhWork = { rays: 0, nodes: 0, tris: 0 };

export function resetBvhWork() {
  bvhWork.rays = 0;
  bvhWork.nodes = 0;
  bvhWork.tris = 0;
}

export function buildBVH(geom) {
  const { vertices, indices, triCount } = geom;

  const triAABB = new Float32Array(triCount * 6);
  const triCent = new Float32Array(triCount * 3);
  const triIdx = new Uint32Array(triCount);

  for (let t = 0; t < triCount; t++) {
    triIdx[t] = t;
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
    const cx = vertices[c], cy = vertices[c + 1], cz = vertices[c + 2];
    triAABB[t * 6]     = Math.min(ax, bx, cx);
    triAABB[t * 6 + 1] = Math.min(ay, by, cy);
    triAABB[t * 6 + 2] = Math.min(az, bz, cz);
    triAABB[t * 6 + 3] = Math.max(ax, bx, cx);
    triAABB[t * 6 + 4] = Math.max(ay, by, cy);
    triAABB[t * 6 + 5] = Math.max(az, bz, cz);
    triCent[t * 3]     = (ax + bx + cx) / 3;
    triCent[t * 3 + 1] = (ay + by + cy) / 3;
    triCent[t * 3 + 2] = (az + bz + cz) / 3;
  }

  /* With LEAF_THRESH primitives per leaf the tree needs roughly 2·N/L nodes.
     Start there with headroom and grow if a lopsided model needs more. */
  let capacity = Math.max(64, Math.ceil(triCount / (LEAF_THRESH / 2)) + 64);
  let bounds = new Float32Array(capacity * 6);
  let meta = new Int32Array(capacity * 3);
  let nodeCount = 0;

  function allocNode() {
    if (nodeCount >= capacity) {
      capacity = Math.ceil(capacity * 1.6);
      const nb = new Float32Array(capacity * 6); nb.set(bounds); bounds = nb;
      const nm = new Int32Array(capacity * 3); nm.set(meta); meta = nm;
    }
    return nodeCount++;
  }

  /* Partition triIdx[start..end) so that everything with centroid[axis] < mid
     comes first. Returns the split index. */
  function partitionByPlane(start, end, axis, mid) {
    let i = start, j = end - 1;
    while (i <= j) {
      if (triCent[triIdx[i] * 3 + axis] < mid) {
        i++;
      } else {
        const tmp = triIdx[i]; triIdx[i] = triIdx[j]; triIdx[j] = tmp;
        j--;
      }
    }
    return i;
  }

  /* Equal-count fallback: quickselect triIdx[start..end) around the median
     on `axis`, leaving the lower half before position `nth`. */
  function selectNth(start, end, axis, nth) {
    let lo = start, hi = end - 1;
    while (lo < hi) {
      /* Median-of-three pivot keeps sorted or reversed input from degrading
         this to O(n²). */
      const mid = (lo + hi) >> 1;
      const a = triCent[triIdx[lo] * 3 + axis];
      const b = triCent[triIdx[mid] * 3 + axis];
      const c = triCent[triIdx[hi] * 3 + axis];
      const pivot = a < b ? (b < c ? b : (a < c ? c : a)) : (a < c ? a : (b < c ? c : b));

      let i = lo, j = hi;
      while (i <= j) {
        while (triCent[triIdx[i] * 3 + axis] < pivot) i++;
        while (triCent[triIdx[j] * 3 + axis] > pivot) j--;
        if (i <= j) {
          const tmp = triIdx[i]; triIdx[i] = triIdx[j]; triIdx[j] = tmp;
          i++; j--;
        }
      }
      if (nth <= j) hi = j;
      else if (nth >= i) lo = i;
      else break;
    }
  }

  /* Explicit work stack rather than recursion: a 500k-triangle mesh with an
     unlucky distribution can otherwise blow the JS call stack. */
  const root = allocNode();
  const work = [[root, 0, triCount, 0]];

  while (work.length) {
    const [nodeIdx, start, end, depth] = work.pop();

    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    let cminx = Infinity, cminy = Infinity, cminz = Infinity;
    let cmaxx = -Infinity, cmaxy = -Infinity, cmaxz = -Infinity;
    for (let i = start; i < end; i++) {
      const t = triIdx[i];
      if (triAABB[t * 6]     < minx) minx = triAABB[t * 6];
      if (triAABB[t * 6 + 1] < miny) miny = triAABB[t * 6 + 1];
      if (triAABB[t * 6 + 2] < minz) minz = triAABB[t * 6 + 2];
      if (triAABB[t * 6 + 3] > maxx) maxx = triAABB[t * 6 + 3];
      if (triAABB[t * 6 + 4] > maxy) maxy = triAABB[t * 6 + 4];
      if (triAABB[t * 6 + 5] > maxz) maxz = triAABB[t * 6 + 5];
      const cx = triCent[t * 3], cy = triCent[t * 3 + 1], cz = triCent[t * 3 + 2];
      if (cx < cminx) cminx = cx; if (cx > cmaxx) cmaxx = cx;
      if (cy < cminy) cminy = cy; if (cy > cmaxy) cmaxy = cy;
      if (cz < cminz) cminz = cz; if (cz > cmaxz) cmaxz = cz;
    }
    bounds[nodeIdx * 6]     = minx; bounds[nodeIdx * 6 + 1] = miny; bounds[nodeIdx * 6 + 2] = minz;
    bounds[nodeIdx * 6 + 3] = maxx; bounds[nodeIdx * 6 + 4] = maxy; bounds[nodeIdx * 6 + 5] = maxz;

    const count = end - start;
    if (count <= LEAF_THRESH || depth >= MAX_DEPTH) {
      meta[nodeIdx * 3] = start;
      meta[nodeIdx * 3 + 1] = count;
      meta[nodeIdx * 3 + 2] = 1;
      continue;
    }

    /* Split on the longest axis of the *centroid* bounds — using the full
       triangle bounds instead biases splits on meshes with a few very large
       triangles. */
    const dx = cmaxx - cminx, dy = cmaxy - cminy, dz = cmaxz - cminz;
    const axis = dx > dy ? (dx > dz ? 0 : 2) : (dy > dz ? 1 : 2);
    const spread = axis === 0 ? dx : axis === 1 ? dy : dz;

    let split;
    if (spread < 1e-12) {
      split = start + (count >> 1); // all centroids coincident — split evenly
    } else {
      const cmin = axis === 0 ? cminx : axis === 1 ? cminy : cminz;
      split = partitionByPlane(start, end, axis, cmin + spread * 0.5);
      if (split === start || split === end) {
        split = start + (count >> 1);
        selectNth(start, end, axis, split);
      }
    }

    const left = allocNode();
    const right = allocNode();
    meta[nodeIdx * 3] = left;
    meta[nodeIdx * 3 + 1] = right;
    meta[nodeIdx * 3 + 2] = 0;
    work.push([left, start, split, depth + 1]);
    work.push([right, split, end, depth + 1]);
  }

  return {
    bounds: bounds.slice(0, nodeCount * 6),
    meta: meta.slice(0, nodeCount * 3),
    triIdx,
    triCount,
    nodeCount,
  };
}

/*
 * Ray vs AABB, slab method. Returns t-near, or -1 for a miss.
 *
 * When a direction component is zero the reciprocal is ±Infinity and the
 * products may be NaN (0 × Infinity) for a ray whose origin sits exactly on
 * a slab plane. The comparison form below is deliberate: every NaN
 * comparison is false, so such an axis is skipped rather than poisoning the
 * interval — which is the conservative choice. Rewriting this with
 * Math.min/Math.max would propagate the NaN and drop valid hits.
 */
function rayAABB(ox, oy, oz, idx, idy, idz, bounds, b6) {
  let tmin = -Infinity, tmax = Infinity;

  let t1 = (bounds[b6] - ox) * idx, t2 = (bounds[b6 + 3] - ox) * idx;
  if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;

  t1 = (bounds[b6 + 1] - oy) * idy; t2 = (bounds[b6 + 4] - oy) * idy;
  if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;

  t1 = (bounds[b6 + 2] - oz) * idz; t2 = (bounds[b6 + 5] - oz) * idz;
  if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;

  return tmax < 0 ? -1 : (tmin < 0 ? 0 : tmin);
}

/* Möller–Trumbore ray/triangle intersection. Returns the hit distance, or -1. */
function rayTriIdx(ox, oy, oz, dx, dy, dz, vertices, indices, t) {
  const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
  const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2];
  const e1x = vertices[ib] - ax, e1y = vertices[ib + 1] - ay, e1z = vertices[ib + 2] - az;
  const e2x = vertices[ic] - ax, e2y = vertices[ic + 1] - ay, e2z = vertices[ic + 2] - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-10 && det < 1e-10) return -1; // ray parallel to the triangle plane
  const inv = 1 / det;
  const tvx = ox - ax, tvy = oy - ay, tvz = oz - az;
  const u = (tvx * px + tvy * py + tvz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = tvy * e1z - tvz * e1y;
  const qy = tvz * e1x - tvx * e1z;
  const qz = tvx * e1y - tvy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/*
 * Nearest hit along a ray, or Infinity for a miss.
 * excludeTri skips the originating triangle so a face does not self-hit.
 *
 * maxDist caps the search: nodes and hits beyond it are discarded, and the
 * result is Infinity if nothing closer exists. Callers that only care whether
 * anything lies within a known distance — the inscribed-sphere probe, which
 * only wants rays that beat the bound it already has — save most of the
 * traversal by saying so.
 */
export function castRay(bvh, geom, ox, oy, oz, dx, dy, dz, eps, excludeTri, maxDist) {
  const { bounds, meta, triIdx } = bvh;
  const { vertices, indices } = geom;
  const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;

  const stack = RAY_STACK;
  let sp = 0;
  stack[sp++] = 0;
  let nearest = maxDist > 0 ? maxDist : Infinity;
  bvhWork.rays++;

  while (sp > 0) {
    const ni = stack[--sp];
    const b6 = ni * 6, m3 = ni * 3;
    bvhWork.nodes++;
    const tBox = rayAABB(ox, oy, oz, idx, idy, idz, bounds, b6);
    if (tBox < 0 || tBox > nearest) continue;

    if (meta[m3 + 2] === 1) {
      const first = meta[m3];
      const count = meta[m3 + 1];
      bvhWork.tris += count;
      for (let k = 0; k < count; k++) {
        const t = triIdx[first + k];
        if (t === excludeTri) continue;
        const hit = rayTriIdx(ox, oy, oz, dx, dy, dz, vertices, indices, t);
        if (hit > eps && hit < nearest) nearest = hit;
      }
    } else {
      stack[sp++] = meta[m3];
      stack[sp++] = meta[m3 + 1];
    }
  }
  /* Reaching the cap means nothing was found inside it. */
  return nearest === maxDist ? Infinity : nearest;
}

/* Traversal scratch for the closest-point query. Separate from RAY_STACK
   because the two are not mutually exclusive — registration evaluates
   coverage by ray-cast between closest-point iterations. */
const NEAR_STACK = new Int32Array(MAX_DEPTH * 2 + 8);

/* Squared distance from a point to an axis-aligned box: zero inside, and
   otherwise the sum over the axes on which the point falls outside. */
function pointAABBDistSq(px, py, pz, bounds, b6) {
  let d = 0;
  const dx = px < bounds[b6] ? bounds[b6] - px : (px > bounds[b6 + 3] ? px - bounds[b6 + 3] : 0);
  const dy = py < bounds[b6 + 1] ? bounds[b6 + 1] - py : (py > bounds[b6 + 4] ? py - bounds[b6 + 4] : 0);
  const dz = pz < bounds[b6 + 2] ? bounds[b6 + 2] - pz : (pz > bounds[b6 + 5] ? pz - bounds[b6 + 5] : 0);
  d = dx * dx + dy * dy + dz * dz;
  return d;
}

/*
 * Closest point on one triangle, by the region test in Ericson,
 * "Real-Time Collision Detection" §5.1.5: the barycentric solution is only
 * valid inside the triangle, so each vertex and edge Voronoi region is
 * checked first and the answer clamped onto whichever feature owns the point.
 *
 * Writing the result into a caller-supplied array rather than returning an
 * object matters here: this runs a few million times over a registration.
 */
function closestOnTri(px, py, pz, vertices, indices, t, out) {
  const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
  const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2];
  const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2];
  const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2];

  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v; return;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w; return;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w; return;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}

/* Scratch for closestOnTri, reused per call rather than per triangle. */
const NEAR_HIT = new Float64Array(3);

/*
 * Nearest point on the mesh surface to (px, py, pz), unsigned.
 *
 * `out` receives the surface point and, when a caller wants it, the owning
 * triangle in out[3]; the return value is the distance, or Infinity when
 * nothing lies within `maxDist`. A cap is not an optimisation here so much as
 * a statement of intent: a correspondence further away than the search radius
 * is not a correspondence, and the traversal should not pay to find it.
 */
export function closestPoint(bvh, geom, px, py, pz, maxDist, out) {
  const { bounds, meta, triIdx } = bvh;
  const { vertices, indices } = geom;

  const stack = NEAR_STACK;
  let sp = 0;
  stack[sp++] = 0;
  let bestSq = maxDist > 0 ? maxDist * maxDist : Infinity;
  let bestTri = -1;
  let bx = 0, by = 0, bz = 0;
  bvhWork.rays++;

  while (sp > 0) {
    const ni = stack[--sp];
    const b6 = ni * 6, m3 = ni * 3;
    bvhWork.nodes++;
    if (pointAABBDistSq(px, py, pz, bounds, b6) >= bestSq) continue;

    if (meta[m3 + 2] === 1) {
      const first = meta[m3];
      const count = meta[m3 + 1];
      bvhWork.tris += count;
      for (let k = 0; k < count; k++) {
        const t = triIdx[first + k];
        closestOnTri(px, py, pz, vertices, indices, t, NEAR_HIT);
        const dx = NEAR_HIT[0] - px, dy = NEAR_HIT[1] - py, dz = NEAR_HIT[2] - pz;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq < bestSq) {
          bestSq = dSq; bestTri = t;
          bx = NEAR_HIT[0]; by = NEAR_HIT[1]; bz = NEAR_HIT[2];
        }
      }
    } else {
      /* Descend into the nearer child first: it usually tightens bestSq
         enough to reject the sibling outright at the top of the loop. */
      const l = meta[m3], r = meta[m3 + 1];
      const dl = pointAABBDistSq(px, py, pz, bounds, l * 6);
      const dr = pointAABBDistSq(px, py, pz, bounds, r * 6);
      if (dl < dr) { stack[sp++] = r; stack[sp++] = l; } else { stack[sp++] = l; stack[sp++] = r; }
    }
  }

  if (bestTri < 0) return Infinity;
  if (out) { out[0] = bx; out[1] = by; out[2] = bz; out[3] = bestTri; }
  return Math.sqrt(bestSq);
}

/* Its own traversal scratch: the other two are each entered from callers that
   also use this one, and a shared stack only stays safe while no two of them
   are ever in flight together. */
const ALL_STACK = new Int32Array(MAX_DEPTH * 2 + 8);

/*
 * Every crossing of the surface along a ray, ascending, written into `out`.
 *
 * `castRay` answers "what is the nearest thing in this direction", which is
 * the wrong question when what is wanted is how much *material* lies along a
 * ray. An assembly that models a clearance pocket around an insert puts a
 * surface immediately in front of the insert's own, so the nearest hit is the
 * pocket wall and the cover reads as the clearance. Every crossing, with
 * parity, gives the polymer actually traversed — see materialAlongRay in
 * analysis/fpc.js, which is the only caller and explains the arithmetic.
 *
 * Hits within `eps` of each other are merged: a ray through an edge, a vertex
 * or a facet diagonal is reported by every incident triangle, and a duplicated
 * crossing inverts the parity for the rest of the ray. Because that merge
 * happens after collection, duplicates spend the buffer — so `out` needs room
 * for raw hits, of which there can be two or three per crossing, not for
 * crossings.
 *
 * Returns the number of distinct crossings, or **−1** when `out` filled up.
 * A truncated list is not a short list: the crossings missing from the end
 * flip the parity of everything a caller would infer from it, and after the
 * merge the count alone cannot show that anything was dropped — four raw hits
 * on a diagonal collapse to two, which looks exactly like a ray that crossed
 * twice. So truncation is its own answer rather than a number to be
 * second-guessed.
 */
export function castRayAll(bvh, geom, ox, oy, oz, dx, dy, dz, eps, out, maxDist) {
  const { bounds, meta, triIdx } = bvh;
  const { vertices, indices } = geom;
  const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
  const limit = maxDist > 0 ? maxDist : Infinity;

  const stack = ALL_STACK;
  let sp = 0;
  stack[sp++] = 0;
  let n = 0;
  bvhWork.rays++;

  while (sp > 0) {
    const ni = stack[--sp];
    const b6 = ni * 6, m3 = ni * 3;
    bvhWork.nodes++;
    const tBox = rayAABB(ox, oy, oz, idx, idy, idz, bounds, b6);
    if (tBox < 0 || tBox > limit) continue;

    if (meta[m3 + 2] === 1) {
      const first = meta[m3];
      const count = meta[m3 + 1];
      bvhWork.tris += count;
      for (let k = 0; k < count; k++) {
        const hit = rayTriIdx(ox, oy, oz, dx, dy, dz, vertices, indices, triIdx[first + k]);
        if (!(hit > eps) || hit > limit) continue;
        if (n >= out.length) return -1;
        out[n++] = hit;
      }
    } else {
      stack[sp++] = meta[m3];
      stack[sp++] = meta[m3 + 1];
    }
  }

  if (n < 2) return n;
  const sorted = out.subarray(0, n).sort();
  let w = 1;
  for (let i = 1; i < n; i++) {
    if (sorted[i] - sorted[w - 1] > eps) sorted[w++] = sorted[i];
  }
  return w;
}
