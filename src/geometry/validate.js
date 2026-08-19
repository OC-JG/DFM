import { computeBounds, computeVertexNormals } from './weld.js';

/*
 * Mesh validation.
 *
 * Everything downstream of here assumes a closed, consistently wound,
 * millimetre-scale solid. Nothing until now checked that any of it was true.
 * An STL carries no units at all, and an open or inside-out mesh still
 * produces a fully formed report with a two-decimal score on the front of it
 * — which is the worst failure mode this product has, because a confident
 * wrong answer is acted on and a refused one is not.
 *
 * This module answers three questions before any analysis runs:
 *
 *   Is it the size it claims?   An inch-authored part reads 25.4× small, and
 *                               every threshold in the rule engine is in mm.
 *   Is it a solid?              Volume, wall thickness and the inside/outside
 *                               classification all assume a closed surface.
 *                               Ray casting through a hole reads the far side
 *                               of the part as the near wall.
 *   Is it wound consistently?   Normals decide draft sign, which decides
 *                               undercuts. An inside-out mesh inverts both.
 *
 * The answers are advisory where they can be and blocking where they must be.
 * Deciding a part is inch-authored is a guess and is offered as a question;
 * deciding a mesh has no enclosed volume is not a guess and stops the run.
 */

/* Edge keys pack two vertex indices into one number. Exact in a float64 as
   long as vertex indices stay under 2^26, which is 67 million — well past
   what fits in memory. */
const EDGE_SHIFT = 67108864; // 2^26
const MAX_PACKABLE_VERT = EDGE_SHIFT;

/* Plausible envelope for an injection-moulded part, in millimetres. Below the
   floor the file is almost certainly not in mm; above the ceiling it is worth
   a second look but is not by itself wrong. */
const PLAUSIBLE_MIN_MM = 2;
const AMBIGUOUS_MAX_MM = 15;
const PLAUSIBLE_MAX_MM = 1200;

export function validateGeometry(geom) {
  const { vertices, indices, triCount, vertCount } = geom;
  const bbox = computeBounds(vertices);
  const maxDim = Math.max(bbox.size[0], bbox.size[1], bbox.size[2]);
  const issues = [];

  // ── Triangles: degeneracy and signed volume ─────────────────────────────
  const areaEps = Math.max(bbox.diag * 1e-5, 1e-6) ** 2;
  let degenerate = 0;
  let signedVolume = 0;
  let area = 0;

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    /* After welding, a collapsed triangle shows up as a repeated index. */
    if (i0 === i1 || i1 === i2 || i0 === i2) { degenerate++; continue; }

    const a = i0 * 3, b = i1 * 3, c = i2 * 3;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
    const cx = vertices[c], cy = vertices[c + 1], cz = vertices[c + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const twiceArea = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (twiceArea * 0.5 < areaEps) { degenerate++; continue; }
    area += twiceArea * 0.5;
    signedVolume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }

  // ── Edges: closure, manifoldness, winding ───────────────────────────────
  const edges = analyseEdges(indices, triCount, vertCount);

  const closed = edges.boundary === 0 && edges.nonManifold === 0;
  const windingConsistent = edges.inconsistent === 0;
  /* Volume only means anything on a closed surface, and its sign only means
     anything when the winding agrees with itself. */
  const volumeTrustworthy = closed && windingConsistent;
  const inverted = volumeTrustworthy && signedVolume < 0;

  // ── Scale ───────────────────────────────────────────────────────────────
  const scale = assessScale(maxDim);

  // ── Issues, in the order someone would want to act on them ──────────────
  if (triCount < 4) {
    issues.push({
      level: 'error', code: 'no-solid', title: 'Not a solid',
      detail: `${triCount} triangle${triCount === 1 ? '' : 's'} cannot enclose a volume. This file does not describe a part.`,
    });
  }

  if (scale.suspect) {
    issues.push({
      level: scale.level, code: 'scale', title: 'Check the units',
      detail: scale.detail,
      fixes: scale.fixes,
    });
  }

  if (edges.overflowed) {
    issues.push({
      level: 'warn', code: 'too-many-verts', title: 'Topology not checked',
      detail: `This mesh has ${vertCount.toLocaleString()} vertices, past the ${MAX_PACKABLE_VERT.toLocaleString()} limit of the edge index used for the topology checks. Closure and winding were not verified.`,
    });
  } else {
    if (edges.boundary > 0) {
      const pct = edges.total > 0 ? (edges.boundary / edges.total) * 100 : 0;
      const severe = pct > 5;
      issues.push({
        level: severe ? 'error' : 'warn', code: 'open-mesh', title: 'Mesh is not closed',
        detail: `${edges.boundary.toLocaleString()} edge${edges.boundary === 1 ? '' : 's'} border only one triangle (${pct.toFixed(1)}% of all edges), so the surface has holes in it. Wall thickness is measured by casting a ray into the solid and taking the first hit on the far side; a ray that leaves through a hole reads the far wall of the part, or nothing at all. Volume and the inside/outside classification are unreliable too.`,
        fixes: [{ label: 'Repair the mesh in CAD and re-export', action: null }],
      });
    }
    if (edges.nonManifold > 0) {
      issues.push({
        level: 'warn', code: 'non-manifold', title: 'Non-manifold edges',
        detail: `${edges.nonManifold.toLocaleString()} edge${edges.nonManifold === 1 ? ' is' : 's are'} shared by three or more triangles, so the surface branches. Usually two bodies exported as one shell, or an internal face left in. Thickness readings across such an edge are meaningless.`,
      });
    }
    if (!windingConsistent) {
      issues.push({
        level: 'warn', code: 'winding', title: 'Inconsistent winding',
        detail: `${edges.inconsistent.toLocaleString()} shared edge${edges.inconsistent === 1 ? ' is' : 's are'} traversed the same way by both of their triangles, which means those two faces disagree about which side is outside. Draft sign and undercut detection both follow the face normal, so affected regions will be classified backwards.`,
      });
    }
    if (inverted) {
      issues.push({
        level: 'warn', code: 'inverted', title: 'Normals point inward',
        detail: 'The surface is closed and consistently wound, but wound the wrong way round: the enclosed volume comes out negative, so every face normal points into the part rather than out of it. Draft angles will read with the wrong sign and undercuts will be found on the wrong faces.',
        fixes: [{ label: 'Flip normals', action: 'flip' }],
      });
    }
  }

  if (degenerate > 0) {
    const pct = triCount > 0 ? (degenerate / triCount) * 100 : 0;
    issues.push({
      level: pct > 1 ? 'warn' : 'info', code: 'degenerate', title: 'Degenerate triangles',
      detail: `${degenerate.toLocaleString()} triangle${degenerate === 1 ? ' has' : 's have'} no area (${pct.toFixed(2)}% of the mesh). They carry no surface and contribute nothing to the area-weighted statistics, but they are a sign the export or the tessellation is not clean.`,
    });
  }

  if (volumeTrustworthy && Math.abs(signedVolume) < areaEps * bbox.diag) {
    issues.push({
      level: 'error', code: 'zero-volume', title: 'No enclosed volume',
      detail: 'The surface encloses essentially nothing. This is a sheet or a surface model, not a solid, and none of the thickness-based checks can run on it.',
    });
  }

  const confidence = worstConfidence(issues);
  /* Confidence and analysability are different questions. An inch-authored or
     leaky mesh still analyses — the numbers just need reading with the caveat
     attached, and refusing to run would be presumptuous about a part that
     might genuinely be 1.5 mm across. A surface with no interior does not
     analyse at all, because there is nothing for a ray to travel through. */
  const analysable = !issues.some((i) => i.code === 'no-solid' || i.code === 'zero-volume');

  return {
    analysable,
    triCount, vertCount,
    bbox, maxDim, area,
    degenerate,
    edges,
    closed, windingConsistent, inverted,
    signedVolume,
    volume: volumeTrustworthy ? Math.abs(signedVolume) : null,
    scale,
    weld: geom.weld || null,
    issues,
    confidence,
  };
}

/*
 * Edge census in one pass.
 *
 * Each undirected edge records how many triangles traverse it in each
 * direction. A closed, consistently wound manifold gives exactly one of each
 * for every edge; the three ways that can fail are the three counts returned.
 */
function analyseEdges(indices, triCount, vertCount) {
  if (vertCount >= MAX_PACKABLE_VERT) {
    return { total: 0, boundary: 0, nonManifold: 0, inconsistent: 0, overflowed: true };
  }
  /* Forward and reverse traversals are counted in the low and high halves of
     one integer, so the map holds a number per edge rather than an object. */
  const seen = new Map();
  for (let t = 0; t < triCount; t++) {
    const v0 = indices[t * 3], v1 = indices[t * 3 + 1], v2 = indices[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const a = k === 0 ? v0 : k === 1 ? v1 : v2;
      const b = k === 0 ? v1 : k === 1 ? v2 : v0;
      if (a === b) continue; // degenerate edge, already counted as a bad triangle
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * EDGE_SHIFT + hi;
      const bump = a < b ? 1 : 4096;   // forward in the low bits, reverse above
      seen.set(key, (seen.get(key) || 0) + bump);
    }
  }

  let boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const packed of seen.values()) {
    const fwd = packed & 4095;
    const rev = packed >> 12;
    const total = fwd + rev;
    if (total === 1) boundary++;
    else if (total > 2) nonManifold++;
    else if (fwd !== 1 || rev !== 1) inconsistent++;
  }
  return { total: seen.size, boundary, nonManifold, inconsistent, overflowed: false };
}

/*
 * Is this file in millimetres?
 *
 * There is no way to know — STL does not say, and STEP files routinely lie.
 * All we have is the size of the result, judged against what an injection
 * moulded part can actually be. So this never asserts; it asks, and it offers
 * the conversion that would make the number sensible.
 */
function assessScale(maxDim) {
  const base = { maxDim, suspect: null, level: 'info', detail: '', fixes: [] };

  if (!(maxDim > 0)) return { ...base, suspect: 'empty', level: 'error', detail: 'The part has no extent in any direction.' };

  if (maxDim < PLAUSIBLE_MIN_MM) {
    const asInch = maxDim * 25.4;
    const asMetre = maxDim * 1000;
    const fixes = [];
    if (asInch >= PLAUSIBLE_MIN_MM && asInch <= PLAUSIBLE_MAX_MM) fixes.push({ label: `Inches → mm (×25.4, gives ${asInch.toFixed(1)} mm)`, action: 'scale', factor: 25.4 });
    if (asMetre >= PLAUSIBLE_MIN_MM && asMetre <= PLAUSIBLE_MAX_MM) fixes.push({ label: `Metres → mm (×1000, gives ${asMetre.toFixed(1)} mm)`, action: 'scale', factor: 1000 });
    return {
      ...base, suspect: 'too-small', level: 'error',
      detail: `The largest dimension is ${fmt(maxDim)} mm. No injection-moulded part is that small, so this file is almost certainly not in millimetres — and every threshold in this tool is. Analysing it as-is will fail the wall check on a part that is fine.`,
      fixes,
    };
  }

  if (maxDim < AMBIGUOUS_MAX_MM) {
    const asInch = maxDim * 25.4;
    return {
      ...base, suspect: 'maybe-inches', level: 'warn',
      detail: `The largest dimension is ${fmt(maxDim)} mm. That is a plausible size for a small clip or connector, so it may well be right — but it is also exactly what a ${asInch.toFixed(0)} mm part looks like when the file was authored in inches. Worth confirming before you read anything else on this page.`,
      fixes: [{ label: `Inches → mm (×25.4, gives ${asInch.toFixed(1)} mm)`, action: 'scale', factor: 25.4 }],
    };
  }

  if (maxDim > PLAUSIBLE_MAX_MM) {
    return {
      ...base, suspect: 'very-large', level: 'warn',
      detail: `The largest dimension is ${fmt(maxDim)} mm, past what all but the largest moulding machines take. Check the units, and check this is one part rather than an assembly.`,
      fixes: [{ label: `mm → this is right, keep it`, action: null }],
    };
  }

  return base;
}

function fmt(v) {
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}

function worstConfidence(issues) {
  if (issues.some((i) => i.level === 'error')) return 'unusable';
  if (issues.some((i) => i.level === 'warn')) return 'reduced';
  return 'high';
}

/*
 * Uniform rescale. Vertex normals are invariant under a positive uniform
 * scale, so only the positions move — but the weld tolerance was derived from
 * the old bounding box, so the record of it is dropped rather than left
 * describing a size the mesh no longer has.
 */
export function rescaleGeometry(geom, factor) {
  const vertices = new Float32Array(geom.vertices.length);
  for (let i = 0; i < vertices.length; i++) vertices[i] = geom.vertices[i] * factor;
  return {
    ...geom,
    vertices,
    normals: geom.normals ? geom.normals.slice() : computeVertexNormals(vertices, geom.indices),
    weld: geom.weld ? { ...geom.weld, tolerance: geom.weld.tolerance * factor } : null,
    scaledBy: (geom.scaledBy || 1) * factor,
  };
}

/* Reverse every triangle, turning the surface inside out. */
export function flipWinding(geom) {
  const indices = geom.indices.slice();
  for (let t = 0; t < geom.triCount; t++) {
    const b = indices[t * 3 + 1];
    indices[t * 3 + 1] = indices[t * 3 + 2];
    indices[t * 3 + 2] = b;
  }
  return {
    ...geom,
    indices,
    normals: computeVertexNormals(geom.vertices, indices),
    flipped: !geom.flipped,
  };
}
