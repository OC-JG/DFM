import { computeVertexNormals } from './weld.js';

/*
 * STEP parsing via occt-import-js (OpenCascade compiled to WASM).
 *
 * The module is ~6 MB, so it is loaded lazily on the first STEP file rather
 * than on page load. Sub-meshes are merged into one buffer while preserving
 * both B-rep face groups and per-solid-body ranges — the former gives
 * face-aware draft analysis, the latter drives the body visibility selector.
 */

const OCCT_CDN = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.js';

let occtPromise = null;

export function loadOcct() {
  if (occtPromise) return occtPromise;
  occtPromise = new Promise((resolve, reject) => {
    if (typeof occtimportjs !== 'undefined') {
      occtimportjs().then(resolve, reject);
      return;
    }
    const s = document.createElement('script');
    s.src = OCCT_CDN;
    s.onload = () => {
      if (typeof occtimportjs === 'undefined') {
        reject(new Error('OpenCascade module loaded but did not register'));
        return;
      }
      occtimportjs().then(resolve, reject);
    };
    s.onerror = () => reject(new Error('Could not load the OpenCascade module. STEP import needs an internet connection; STL files work offline.'));
    document.head.appendChild(s);
  });
  /* Do not cache a rejection — a retry after the network comes back should
     be allowed to succeed. */
  occtPromise.catch(() => { occtPromise = null; });
  return occtPromise;
}

export async function parseSTEP(buffer, onProgress) {
  if (onProgress) onProgress(0.05, 'Loading OpenCascade');
  const occt = await loadOcct();

  if (onProgress) onProgress(0.3, 'Tessellating B-rep');
  const result = occt.ReadStepFile(new Uint8Array(buffer), {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.5,
  });
  if (!result || !result.success) throw new Error('STEP import failed — the file may be malformed or use an unsupported schema');
  if (!result.meshes || !result.meshes.length) throw new Error('STEP file contains no solid geometry');

  if (onProgress) onProgress(0.7, 'Merging meshes');

  let totalVerts = 0, totalTris = 0;
  for (const m of result.meshes) {
    totalVerts += m.attributes.position.array.length / 3;
    totalTris += m.index.array.length / 3;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalTris * 3);
  const faceGroups = [];
  const bodies = [];
  let vOff = 0, iOff = 0, tOff = 0;

  for (let bi = 0; bi < result.meshes.length; bi++) {
    const m = result.meshes[bi];
    const mp = m.attributes.position.array;
    const mn = m.attributes.normal ? m.attributes.normal.array : null;
    const mi = m.index.array;
    const meshVertCount = mp.length / 3;
    const meshTriCount = mi.length / 3;

    positions.set(mp, vOff * 3);
    if (mn) normals.set(mn, vOff * 3);
    for (let k = 0; k < mi.length; k++) indices[iOff + k] = mi[k] + vOff;

    bodies.push({
      id: bi,
      name: (m.name && m.name.trim()) ? m.name.trim() : `Body ${bi + 1}`,
      triStart: tOff,
      triEnd: tOff + meshTriCount,   // exclusive
      vertStart: vOff,
      vertEnd: vOff + meshVertCount, // exclusive
      triCount: meshTriCount,
      visible: true,
      color: (m.color && m.color.length === 3) ? Array.from(m.color) : null,
    });

    if (m.brep_faces && m.brep_faces.length) {
      for (const bf of m.brep_faces) {
        faceGroups.push({ first: tOff + bf.first, last: tOff + bf.last, faceId: faceGroups.length, bodyId: bi });
      }
    }

    vOff += meshVertCount;
    iOff += mi.length;
    tOff += meshTriCount;
  }

  /* occt supplies normals for most files but not all. */
  let hasOcctNormals = false;
  for (let i = 0; i < normals.length; i++) {
    if (normals[i] !== 0) { hasOcctNormals = true; break; }
  }

  if (onProgress) onProgress(0.95, 'Finalising');

  return {
    vertices: positions,
    indices,
    normals: hasOcctNormals ? normals : computeVertexNormals(positions, indices),
    triCount: totalTris,
    vertCount: totalVerts,
    faceGroups: faceGroups.length ? faceGroups : null,
    bodies: bodies.length > 1 ? bodies : null, // selector only earns its place for multi-body files
  };
}
