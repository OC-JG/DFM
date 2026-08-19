/*
 * Cluster undercut triangles into connected tooling regions and derive the
 * slide or lifter action each one implies.
 *
 * Two things here are easy to get wrong, and both were:
 *
 * Grouping. Regions are found by walking shared edges between undercut
 * triangles of the same type, not by dropping centroids into a grid. A grid
 * makes the answer depend on tessellation rather than on geometry: on a
 * 14 × 30 mm overhang described by two triangles, their centroids land ten
 * millimetres apart in a grid whose cells are 1.4 mm, so one physical feature
 * was reported as two. That is not cosmetic — the rule engine reads the region
 * count, and one slide is a minor finding where two are a major one, so the
 * same part scored differently depending on how finely it had been exported.
 * Edge adjacency is the right primitive, followed by a proximity pass to
 * rejoin patches separated by a sliver of faces that fell just under the
 * undercut threshold.
 *
 * Direction. A slide withdraws along the direction its faces point, projected
 * into the parting plane — but the archetypal undercut is a snap-hook barb or
 * an overhanging lip whose underside points straight *along* the pull axis.
 * That projection is then the zero vector, and the tool reported a retraction
 * direction of (0.00, 0.00, 0.00) with a stroke of 0.0 mm for the most common
 * undercut there is. Where the normal carries no in-plane information, the
 * direction the feature is reachable from does: outward from the part's centre
 * towards the region.
 */

/* Union-find with path halving and union by size. */
function makeUnionFind(n) {
  const parent = new Int32Array(n);
  const size = new Int32Array(n).fill(1);
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) {
    let ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (size[ra] < size[rb]) { const t = ra; ra = rb; rb = t; }
    parent[rb] = ra;
    size[ra] += size[rb];
  }
  return { find, union };
}

/* Below this the mean normal carries no usable in-plane component and the
   slide direction has to come from the part's shape instead. */
const IN_PLANE_EPS = 1e-3;

export function clusterUndercuts(triCentroid, triAreas, triFNorm, triUndercut, triCount, diag, pullDir, geom) {
  const { indices, vertices } = geom;

  /* Union undercut triangles of the same type across shared edges. Only
     undercut triangles enter the edge map, so a shared edge means the two
     faces are part of one continuous patch of the same kind of undercut. */
  const uf = makeUnionFind(triCount);
  const edgeOwner = new Map();
  for (let t = 0; t < triCount; t++) {
    const type = triUndercut[t];
    if (type === 0) continue;
    const v0 = indices[t * 3], v1 = indices[t * 3 + 1], v2 = indices[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const a = k === 0 ? v0 : k === 1 ? v1 : v2;
      const b = k === 0 ? v1 : k === 1 ? v2 : v0;
      if (a === b) continue;
      const key = `${Math.min(a, b)}_${Math.max(a, b)}_${type}`;
      const other = edgeOwner.get(key);
      if (other === undefined) edgeOwner.set(key, t);
      else uf.union(other, t);
    }
  }

  const groups = new Map();
  for (let t = 0; t < triCount; t++) {
    if (triUndercut[t] === 0) continue;
    const root = uf.find(t);
    let g = groups.get(root);
    if (!g) { g = []; groups.set(root, g); }
    g.push(t);
  }
  if (!groups.size) return [];

  /* Summarise each patch: area, area-weighted centroid and normal, and the
     bounds over its vertices rather than its centroids — a small patch
     otherwise reports almost no extent and any stroke derived from it is
     meaningless. */
  let patches = [];
  for (const tris of groups.values()) {
    const type = triUndercut[tris[0]];
    let area = 0, nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
    const bbMin = [Infinity, Infinity, Infinity];
    const bbMax = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) {
      const a = triAreas[t];
      area += a;
      nx += triFNorm[t * 3] * a; ny += triFNorm[t * 3 + 1] * a; nz += triFNorm[t * 3 + 2] * a;
      cx += triCentroid[t * 3] * a; cy += triCentroid[t * 3 + 1] * a; cz += triCentroid[t * 3 + 2] * a;
      for (let v = 0; v < 3; v++) {
        const vi = indices[t * 3 + v] * 3;
        for (let p = 0; p < 3; p++) {
          const c = vertices[vi + p];
          if (c < bbMin[p]) bbMin[p] = c;
          if (c > bbMax[p]) bbMax[p] = c;
        }
      }
    }
    patches.push({
      type, tris, area, triCount: tris.length,
      nSum: [nx, ny, nz],
      centroid: [cx / area, cy / area, cz / area],
      bbMin, bbMax,
    });
  }

  patches = mergeNearbyPatches(patches, diag / 40 || 1);

  /* Part centre, for the fallback retraction direction. */
  const pMin = [Infinity, Infinity, Infinity];
  const pMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const c = vertices[i + k];
      if (c < pMin[k]) pMin[k] = c;
      if (c > pMax[k]) pMax[k] = c;
    }
  }
  const partCentre = [(pMin[0] + pMax[0]) / 2, (pMin[1] + pMax[1]) / 2, (pMin[2] + pMax[2]) / 2];

  const [pdx, pdy, pdz] = pullDir;
  const regions = [];

  for (const patch of patches) {
    const nLen = Math.hypot(...patch.nSum) || 1;
    const normal = [patch.nSum[0] / nLen, patch.nSum[1] / nLen, patch.nSum[2] / nLen];

    const [perpX, perpY, perpZ] = inPlaneAction(normal, patch, partCentre, pullDir);
    const slideAction = [perpX, perpY, perpZ];

    /* Extent of the patch projected onto an axis, over its eight bbox corners. */
    const projectExtent = (ax, ay, az) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < 8; i++) {
        const bx = (i & 1) ? patch.bbMax[0] : patch.bbMin[0];
        const by = (i & 2) ? patch.bbMax[1] : patch.bbMin[1];
        const bz = (i & 4) ? patch.bbMax[2] : patch.bbMin[2];
        const p = bx * ax + by * ay + bz * az;
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
      return hi - lo;
    };

    const slideStroke = projectExtent(perpX, perpY, perpZ);
    const pullExtent = projectExtent(pdx, pdy, pdz);

    /* Lifter travel is set so the angle stays under ~15°, the mechanical
       limit for a slim lifter. */
    const lifterPullTravel = Math.max(pullExtent * 1.2, slideStroke * 4, 5);
    const lifterAngleRad = Math.atan(slideStroke / lifterPullTravel);
    const lifterAction = [
      pdx * Math.cos(lifterAngleRad) + perpX * Math.sin(lifterAngleRad),
      pdy * Math.cos(lifterAngleRad) + perpY * Math.sin(lifterAngleRad),
      pdz * Math.cos(lifterAngleRad) + perpZ * Math.sin(lifterAngleRad),
    ];

    regions.push({
      type: patch.type,
      triCount: patch.triCount,
      area: patch.area,
      bbox: {
        min: patch.bbMin,
        max: patch.bbMax,
        size: [patch.bbMax[0] - patch.bbMin[0], patch.bbMax[1] - patch.bbMin[1], patch.bbMax[2] - patch.bbMin[2]],
      },
      centroid: patch.centroid,
      normal,
      action: patch.type === 1 ? slideAction : lifterAction,
      stroke: patch.type === 1 ? slideStroke : lifterPullTravel,
      perpAxis: slideAction,
      perpStroke: slideStroke,
      pullTravel: lifterPullTravel,
      lifterAngleDeg: lifterAngleRad * 180 / Math.PI,
    });
  }

  regions.sort((a, b) => b.area - a.area);
  return regions;
}

/*
 * The direction a slide has to withdraw in.
 *
 * Normally that is the patch's mean normal flattened into the parting plane:
 * the faces point the way the tool has to come from. But an underbelly — the
 * flat underside of a lip or a snap-hook barb — points straight down the pull
 * axis, and flattening it leaves nothing. Then the useful signal is where the
 * feature sits: a barb on the outside of a part is reachable from outside, so
 * the direction from the part's centre out to the patch is the one a slide
 * travels. Failing even that, the patch's own longest in-plane axis.
 */
function inPlaneAction(normal, patch, partCentre, pullDir) {
  const [pdx, pdy, pdz] = pullDir;
  const flatten = (vx, vy, vz) => {
    const along = vx * pdx + vy * pdy + vz * pdz;
    const x = vx - along * pdx, y = vy - along * pdy, z = vz - along * pdz;
    const len = Math.hypot(x, y, z);
    return len > IN_PLANE_EPS ? [x / len, y / len, z / len, len] : null;
  };

  const fromNormal = flatten(normal[0], normal[1], normal[2]);
  if (fromNormal) return fromNormal;

  const outward = flatten(
    patch.centroid[0] - partCentre[0],
    patch.centroid[1] - partCentre[1],
    patch.centroid[2] - partCentre[2]);
  if (outward) return outward;

  /* Dead centre of the part, normal along pull: fall back to the patch's own
     widest in-plane direction so the stroke is at least the feature's size. */
  const size = [patch.bbMax[0] - patch.bbMin[0], patch.bbMax[1] - patch.bbMin[1], patch.bbMax[2] - patch.bbMin[2]];
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let best = null, bestLen = 0;
  for (let i = 0; i < 3; i++) {
    const f = flatten(axes[i][0], axes[i][1], axes[i][2]);
    if (f && size[i] > bestLen) { best = f; bestLen = size[i]; }
  }
  return best || [1, 0, 0, 1];
}

/*
 * Rejoin patches of the same type whose bounds all but touch.
 *
 * Edge adjacency alone splits one physical undercut wherever a sliver of faces
 * fell just the wrong side of the draft threshold — a fillet at the root of a
 * barb, most often. The tolerance is the cell size the old grid used, so this
 * keeps what that approach got right without inheriting its dependence on how
 * finely the part was tessellated.
 */
function mergeNearbyPatches(patches, tol) {
  if (patches.length < 2) return patches;
  const uf = makeUnionFind(patches.length);
  const gap = (a, b, k) => Math.max(0, Math.max(a.bbMin[k] - b.bbMax[k], b.bbMin[k] - a.bbMax[k]));

  for (let i = 0; i < patches.length; i++) {
    for (let j = i + 1; j < patches.length; j++) {
      if (patches[i].type !== patches[j].type) continue;
      const d = Math.hypot(gap(patches[i], patches[j], 0), gap(patches[i], patches[j], 1), gap(patches[i], patches[j], 2));
      if (d <= tol) uf.union(i, j);
    }
  }

  const merged = new Map();
  for (let i = 0; i < patches.length; i++) {
    const root = uf.find(i);
    const into = merged.get(root);
    if (!into) { merged.set(root, patches[i]); continue; }
    into.area += patches[i].area;
    into.triCount += patches[i].triCount;
    into.tris = into.tris.concat(patches[i].tris);
    for (let k = 0; k < 3; k++) {
      into.nSum[k] += patches[i].nSum[k];
      into.bbMin[k] = Math.min(into.bbMin[k], patches[i].bbMin[k]);
      into.bbMax[k] = Math.max(into.bbMax[k], patches[i].bbMax[k]);
      /* Area-weighted mean of the two centroids. */
      into.centroid[k] = (into.centroid[k] * (into.area - patches[i].area) + patches[i].centroid[k] * patches[i].area) / into.area;
    }
  }
  return [...merged.values()];
}
