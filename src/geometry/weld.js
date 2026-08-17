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
 *   }
 */

/*
 * Weld an unindexed triangle soup into an indexed mesh.
 *
 * Tolerance is bbox-diagonal × 1e-5. Vertices are quantised to that grid and
 * matched through an open-addressed hash table keyed on the quantised
 * coordinates. The original code used a Map with `${qx},${qy},${qz}` string
 * keys, which allocated three-plus strings per vertex — on a 500k-triangle
 * STL that is 1.5M short-lived strings and a very unhappy garbage collector.
 */
export function weldGeometry(unindexedPos, triCount) {
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
  const tol = Math.max(diag * 1e-5, 1e-6);
  const invTol = 1 / tol;

  const maxVerts = triCount * 3;
  /* Power-of-two table, ~2× the worst-case vertex count, so load factor stays
     under 0.5 and linear probing stays short. */
  let tableSize = 1;
  while (tableSize < maxVerts * 2) tableSize <<= 1;
  const table = new Int32Array(tableSize).fill(-1);
  const mask = tableSize - 1;

  const qCoords = new Int32Array(maxVerts * 3);
  const vertices = new Float32Array(maxVerts * 3);
  const indices = new Uint32Array(triCount * 3);
  let nextIdx = 0;

  for (let f = 0; f < triCount; f++) {
    for (let v = 0; v < 3; v++) {
      const ix = f * 9 + v * 3;
      const x = unindexedPos[ix], y = unindexedPos[ix + 1], z = unindexedPos[ix + 2];
      const qx = Math.round(x * invTol) | 0;
      const qy = Math.round(y * invTol) | 0;
      const qz = Math.round(z * invTol) | 0;

      /* Multiplicative hash on the three quantised components. The constants
         are large primes; the >>> keeps the result a non-negative int32. */
      let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) >>> 0;
      let slot = h & mask;
      let found = -1;
      while (true) {
        const cand = table[slot];
        if (cand === -1) break;
        if (qCoords[cand * 3] === qx && qCoords[cand * 3 + 1] === qy && qCoords[cand * 3 + 2] === qz) {
          found = cand;
          break;
        }
        slot = (slot + 1) & mask;
      }

      if (found === -1) {
        found = nextIdx++;
        table[slot] = found;
        qCoords[found * 3] = qx; qCoords[found * 3 + 1] = qy; qCoords[found * 3 + 2] = qz;
        vertices[found * 3] = x; vertices[found * 3 + 1] = y; vertices[found * 3 + 2] = z;
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
