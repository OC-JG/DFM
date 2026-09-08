import { castRay } from '../geometry/bvh.js';
import { xformPoint, xformDir } from './register.js';

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
 *
 * `xform`, when supplied, maps shot 2's coordinates into shot 1's — the output
 * of registerShots. It is applied here, per ray, rather than by rewriting shot
 * 2's vertices: shot 2's draft and wall figures were measured in its own frame
 * against its own declared pull direction, and moving the mesh under them
 * would silently invalidate every one. A rigid transform preserves distance,
 * so the thicknesses below stay in millimetres and stay comparable.
 */
export function analyseInterface(geom1, bvh1, shot2, maxDist, xform) {
  const { triCount, triCentroid, triAreas, triFNorm } = shot2;
  const op = [0, 0, 0], od = [0, 0, 0];

  const interfaceTris = new Uint8Array(triCount);
  const thicknesses = new Float32Array(triCount).fill(NaN);
  let minThk = Infinity, thkSum = 0, thkN = 0;
  let coverArea = 0, totalArea = 0;
  const eps = 0.001;

  for (let t = 0; t < triCount; t++) {
    totalArea += triAreas[t];
    let cx = triCentroid[t * 3], cy = triCentroid[t * 3 + 1], cz = triCentroid[t * 3 + 2];
    /* Inward, i.e. toward the substrate. */
    let nx = -triFNorm[t * 3], ny = -triFNorm[t * 3 + 1], nz = -triFNorm[t * 3 + 2];

    if (xform) {
      xformPoint(cx, cy, cz, xform, op);
      xformDir(nx, ny, nz, xform, od);
      cx = op[0]; cy = op[1]; cz = op[2];
      nx = od[0]; ny = od[1]; nz = od[2];
    }
    const dist = castRay(bvh1, geom1,
      cx + nx * eps, cy + ny * eps, cz + nz * eps, nx, ny, nz, eps, -1);

    if (Number.isFinite(dist) && dist < maxDist) {
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
