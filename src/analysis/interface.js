import { castRay } from '../geometry/bvh.js';

/*
 * Two-shot interface analysis.
 *
 * For every triangle of the shot-2 mesh, cast a ray inward along its normal
 * toward the shot-1 substrate. A hit within `maxDist` means this face sits on
 * the interface, and the hit distance is the local overmould thickness.
 *
 * `shot2` is the analysis result for the overmould (it supplies triCentroid,
 * triAreas and triFNorm); `geom1`/`bvh1` describe the substrate. The original
 * named these parameters `geom1, geom2` while actually being passed an
 * analysis object for the second, which made the call site hard to read.
 */
export function analyseInterface(geom1, bvh1, shot2, maxDist) {
  const { triCount, triCentroid, triAreas, triFNorm } = shot2;

  const interfaceTris = new Uint8Array(triCount);
  const thicknesses = new Float32Array(triCount).fill(NaN);
  let minThk = Infinity, thkSum = 0, thkN = 0;
  let coverArea = 0, totalArea = 0;
  const eps = 0.001;

  for (let t = 0; t < triCount; t++) {
    totalArea += triAreas[t];
    const cx = triCentroid[t * 3], cy = triCentroid[t * 3 + 1], cz = triCentroid[t * 3 + 2];
    /* Inward, i.e. toward the substrate. */
    const nx = -triFNorm[t * 3], ny = -triFNorm[t * 3 + 1], nz = -triFNorm[t * 3 + 2];
    const dist = castRay(bvh1, geom1,
      cx + nx * eps, cy + ny * eps, cz + nz * eps, nx, ny, nz, eps, -1);

    if (isFinite(dist) && dist < maxDist) {
      interfaceTris[t] = 1;
      thicknesses[t] = dist;
      coverArea += triAreas[t];
      thkSum += dist;
      thkN++;
      if (dist < minThk) minThk = dist;
    }
  }

  return {
    interfaceTris,
    thicknesses,
    minThk: thkN > 0 ? minThk : 0,
    avgThk: thkN > 0 ? thkSum / thkN : 0,
    coverArea,
    totalArea2: totalArea,
    coverPct: totalArea > 0 ? (coverArea / totalArea) * 100 : 0,
  };
}
