/*
 * Cluster undercut triangles into connected tooling regions and derive the
 * slide or lifter action each one implies.
 *
 * Triangle centroids are dropped into a uniform grid of cell size diag/40;
 * occupied cells of the same undercut type that touch in the 26-neighbourhood
 * are unioned together. Each resulting region reports its area, bounds,
 * action direction and stroke.
 */

/* Union-find over grid cells, with path halving and union by size. */
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

export function clusterUndercuts(triCentroid, triAreas, triFNorm, triUndercut, triCount, diag, pullDir, geom) {
  const cellSize = diag / 40 || 1;
  const inv = 1 / cellSize;

  /* Occupied cells, with their coordinates kept in parallel arrays so the
     neighbour sweep never has to parse a key back apart. */
  const cellIndex = new Map();   // "cx,cy,cz,type" -> ordinal
  const cellTris = [];           // ordinal -> triangle list
  const cellCoord = [];          // ordinal -> [cx, cy, cz, type]

  for (let t = 0; t < triCount; t++) {
    const type = triUndercut[t];
    if (type === 0) continue;
    const cx = Math.floor(triCentroid[t * 3] * inv);
    const cy = Math.floor(triCentroid[t * 3 + 1] * inv);
    const cz = Math.floor(triCentroid[t * 3 + 2] * inv);
    const key = `${cx},${cy},${cz},${type}`;
    let ord = cellIndex.get(key);
    if (ord === undefined) {
      ord = cellTris.length;
      cellIndex.set(key, ord);
      cellTris.push([]);
      cellCoord.push([cx, cy, cz, type]);
    }
    cellTris[ord].push(t);
  }
  if (!cellTris.length) return [];

  const uf = makeUnionFind(cellTris.length);
  for (let ord = 0; ord < cellCoord.length; ord++) {
    const [cx, cy, cz, type] = cellCoord[ord];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const n = cellIndex.get(`${cx + dx},${cy + dy},${cz + dz},${type}`);
          if (n !== undefined) uf.union(ord, n);
        }
      }
    }
  }

  const groups = new Map();
  for (let ord = 0; ord < cellTris.length; ord++) {
    const root = uf.find(ord);
    let g = groups.get(root);
    if (!g) { g = []; groups.set(root, g); }
    g.push(ord);
  }

  const [pdx, pdy, pdz] = pullDir;
  const regions = [];

  for (const ords of groups.values()) {
    const type = cellCoord[ords[0]][3];
    let triCt = 0, regArea = 0, areaSum = 0;
    let nxSum = 0, nySum = 0, nzSum = 0;
    let cxSum = 0, cySum = 0, czSum = 0;
    const bbMin = [Infinity, Infinity, Infinity];
    const bbMax = [-Infinity, -Infinity, -Infinity];

    for (const ord of ords) {
      for (const t of cellTris[ord]) {
        const a = triAreas[t];
        triCt++;
        regArea += a;
        areaSum += a;
        nxSum += triFNorm[t * 3] * a;
        nySum += triFNorm[t * 3 + 1] * a;
        nzSum += triFNorm[t * 3 + 2] * a;
        cxSum += triCentroid[t * 3] * a;
        cySum += triCentroid[t * 3 + 1] * a;
        czSum += triCentroid[t * 3 + 2] * a;
        /* Bounds take in the triangle's three vertices, not just its
           centroid — otherwise small face regions report almost no extent
           and the derived stroke is meaningless. */
        for (let v = 0; v < 3; v++) {
          const vi = geom.indices[t * 3 + v] * 3;
          for (let p = 0; p < 3; p++) {
            const c = geom.vertices[vi + p];
            if (c < bbMin[p]) bbMin[p] = c;
            if (c > bbMax[p]) bbMax[p] = c;
          }
        }
      }
    }
    if (triCt < 1) continue;

    const nLen = Math.hypot(nxSum, nySum, nzSum) || 1;
    const normal = [nxSum / nLen, nySum / nLen, nzSum / nLen];

    /* A slide retracts along the direction its faces point — outward from the
       undercut. Project the mean normal onto the parting plane (perpendicular
       to pull) to get that in-plane action axis. */
    const alongPull = normal[0] * pdx + normal[1] * pdy + normal[2] * pdz;
    let perpX = normal[0] - alongPull * pdx;
    let perpY = normal[1] - alongPull * pdy;
    let perpZ = normal[2] - alongPull * pdz;
    const perpLen = Math.hypot(perpX, perpY, perpZ) || 1;
    perpX /= perpLen; perpY /= perpLen; perpZ /= perpLen;
    const slideAction = [perpX, perpY, perpZ];

    /* Extent of the region projected onto each axis of interest, taken over
       the eight bounding-box corners. */
    const projectExtent = (ax, ay, az) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < 8; i++) {
        const bx = (i & 1) ? bbMax[0] : bbMin[0];
        const by = (i & 2) ? bbMax[1] : bbMin[1];
        const bz = (i & 4) ? bbMax[2] : bbMin[2];
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
      type,
      triCount: triCt,
      area: regArea,
      bbox: { min: bbMin, max: bbMax, size: [bbMax[0] - bbMin[0], bbMax[1] - bbMin[1], bbMax[2] - bbMin[2]] },
      centroid: [cxSum / areaSum, cySum / areaSum, czSum / areaSum],
      normal,
      action: type === 1 ? slideAction : lifterAction,
      stroke: type === 1 ? slideStroke : lifterPullTravel,
      perpAxis: slideAction,
      perpStroke: slideStroke,
      pullTravel: lifterPullTravel,
      lifterAngleDeg: lifterAngleRad * 180 / Math.PI,
    });
  }

  regions.sort((a, b) => b.area - a.area);
  return regions;
}
