/*
 * Vertex welding and normal computation.
 *
 * The unified geometry format used throughout the app:
 *   {
 *     vertices:   Float32Array (N*3)  welded unique vertices
 *     indices:    Uint32Array  (T*3)  triangle vertex indices
 *     normals:    Float32Array (N*3)  vertex normals
 *     triCount:   T
 *     vertCount:  N
 *     faceGroups: [{ first, last, faceId, bodyId }] | null  (STEP B-rep faces)
 *     bodies:     [{ id, name, triStart, triEnd, ... }] | null  (multi-body STEP)
 *     weld:       { tolerance, exactMerges, nearMerges, cellsProbed } | null
 *   }
 */

/*
 * Weld an unindexed triangle soup into an indexed mesh.
 *
 * Tolerance is bbox-diagonal × 1e-5, and it means what it says: two vertices
 * merge when they are within that *Euclidean* distance of one another.
 *
 * Getting that contract right takes a little more than a hash on quantised
 * coordinates. The obvious implementation — round each coordinate to a grid
 * of size tol, then merge anything sharing a cell — is wrong in both
 * directions. It merges points up to tol·√3 apart when they happen to share
 * a cell, and it fails to merge points a nanometre apart when they happen to
 * straddle a cell boundary. The second failure is the damaging one: it leaves
 * a hairline crack along which the mesh is no longer connected.
 *
 * Those cracks are too narrow for a ray to find, so thickness and draft
 * survive them. What does not survive is anything that walks the mesh as a
 * graph. Measured on a 96-segment tube with a true 2 mm wall, given vertex
 * noise well below the weld tolerance:
 *
 *   flow length    98.2 mm → 203.7 mm     (Dijkstra detours around the cracks)
 *   max L/T        42.8   → 102.0         (the short-shot predictor, 2.4× out)
 *   transitions    208    → 44 candidates (edge pairs no longer share an edge)
 *
 * So the grid here is a genuine spatial hash: each cell holds a chain of the
 * vertices inside it, a lookup walks the 3×3×3 neighbourhood, and candidates
 * are accepted on true distance. The common case — a vertex bit-identical to
 * one already seen, which is nearly every vertex in an STL — still costs one
 * cell lookup and stops at the first exact hit.
 */
export function weldGeometry(unindexedPos, triCount, opts = {}) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < unindexedPos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = unindexedPos[i + k];
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
    }
  }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  const tol = opts.tolerance > 0 ? opts.tolerance : Math.max(diag * 1e-5, 1e-6);
  const tol2 = tol * tol;
  const invTol = 1 / tol;

  /* Quantise relative to the bounding box, not the origin. A part exported in
     a global CAD frame can sit millions of millimetres from the origin while
     being 50 mm across, and `coordinate × invTol` would then overflow int32
     and wrap — silently welding unrelated vertices together. Subtracting the
     minimum keeps the grid indices proportional to the part, not its address
     in space. */
  const ox = mn[0], oy = mn[1], oz = mn[2];

  const maxVerts = triCount * 3;
  /* Power-of-two table, ~2× the worst-case vertex count, so load factor stays
     under 0.5 and linear probing stays short. */
  let tableSize = 1;
  while (tableSize < maxVerts * 2) tableSize <<= 1;
  const cellHead = new Int32Array(tableSize).fill(-1);
  const mask = tableSize - 1;

  const qCoords = new Int32Array(maxVerts * 3);
  const vertNext = new Int32Array(maxVerts).fill(-1);
  const vertices = new Float32Array(maxVerts * 3);
  const indices = new Uint32Array(triCount * 3);
  let nextIdx = 0;

  let exactMerges = 0, nearMerges = 0, cellsProbed = 0;

  /* Multiplicative hash on the three quantised components. The constants are
     large primes; the >>> keeps the result a non-negative int32. */
  const hashOf = (qx, qy, qz) =>
    (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) >>> 0;

  /*
   * Slot holding the chain for cell (qx,qy,qz), or the first free slot if the
   * cell is empty. A slot's identity is the quantised position of the vertex
   * at the head of its chain — every vertex in a chain was inserted into that
   * same cell, so the head speaks for all of them.
   */
  function slotFor(qx, qy, qz) {
    let slot = hashOf(qx, qy, qz) & mask;
    while (true) {
      const head = cellHead[slot];
      if (head === -1) return slot;
      if (qCoords[head * 3] === qx && qCoords[head * 3 + 1] === qy && qCoords[head * 3 + 2] === qz) return slot;
      slot = (slot + 1) & mask;
    }
  }

  for (let f = 0; f < triCount; f++) {
    for (let v = 0; v < 3; v++) {
      const ix = f * 9 + v * 3;
      const x = unindexedPos[ix], y = unindexedPos[ix + 1], z = unindexedPos[ix + 2];
      const qx = Math.round((x - ox) * invTol) | 0;
      const qy = Math.round((y - oy) * invTol) | 0;
      const qz = Math.round((z - oz) * invTol) | 0;

      let found = -1;
      let bestD2 = tol2;

      /* Fast path: the vertex's own cell. An exact coordinate match ends the
         search immediately — nothing in a neighbouring cell can be nearer
         than zero, and in a well-behaved STL this is almost every vertex. */
      const homeSlot = slotFor(qx, qy, qz);
      for (let c = cellHead[homeSlot]; c !== -1; c = vertNext[c]) {
        const dx = vertices[c * 3] - x, dy = vertices[c * 3 + 1] - y, dz = vertices[c * 3 + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 === 0) { found = c; bestD2 = 0; break; }
        if (d2 < bestD2) { found = c; bestD2 = d2; }
      }

      if (bestD2 === 0 && found !== -1) {
        exactMerges++;
      } else {
        /* Slow path: sweep the 26 surrounding cells. A cell is exactly one
           tolerance across, so every point within tol of this one lies in
           this neighbourhood and nowhere else. */
        cellsProbed++;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              const slot = slotFor(qx + dx, qy + dy, qz + dz);
              for (let c = cellHead[slot]; c !== -1; c = vertNext[c]) {
                const ex = vertices[c * 3] - x, ey = vertices[c * 3 + 1] - y, ez = vertices[c * 3 + 2] - z;
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 < bestD2) { found = c; bestD2 = d2; }
              }
            }
          }
        }
        if (found !== -1) nearMerges++;
      }

      if (found === -1) {
        found = nextIdx++;
        qCoords[found * 3] = qx; qCoords[found * 3 + 1] = qy; qCoords[found * 3 + 2] = qz;
        vertices[found * 3] = x; vertices[found * 3 + 1] = y; vertices[found * 3 + 2] = z;
        vertNext[found] = cellHead[homeSlot];
        cellHead[homeSlot] = found;
      }
      indices[f * 3 + v] = found;
    }
  }

  const vertsArr = vertices.subarray(0, nextIdx * 3).slice();
  return {
    vertices: vertsArr,
    indices,
    normals: computeVertexNormals(vertsArr, indices),
    triCount,
    vertCount: nextIdx,
    faceGroups: null,
    bodies: null,
    weld: { tolerance: tol, exactMerges, nearMerges, cellsProbed },
  };
}

/* Vertex normals as the area-weighted average of incident face normals. The
   unnormalised cross product is already proportional to area, so accumulating
   it directly gives the weighting for free. */
export function computeVertexNormals(vertices, indices) {
  const normals = new Float32Array(vertices.length);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3, ib = indices[t + 1] * 3, ic = indices[t + 2] * 3;
    const ax = vertices[ia],     ay = vertices[ia + 1], az = vertices[ia + 2];
    const e1x = vertices[ib] - ax, e1y = vertices[ib + 1] - ay, e1z = vertices[ib + 2] - az;
    const e2x = vertices[ic] - ax, e2y = vertices[ic + 1] - ay, e2z = vertices[ic + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    normals[ia]     += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib]     += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic]     += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return normals;
}

/* Axis-aligned bounding box straight from a vertex buffer. */
export function computeBounds(vertices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { min, max, size, diag: Math.hypot(size[0], size[1], size[2]) };
}
