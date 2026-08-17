/*
 * Wall thickness transition detection (Malloy §2.4.2).
 *
 * Variable walls should taper over a length of at least 3× the thickness
 * delta, otherwise shrinkage stress and flow imbalance follow. We look for
 * edge-adjacent triangle pairs whose local thickness differs sharply with no
 * taper between them.
 *
 * On a tessellated mesh this is inherently approximate, so three guards keep
 * the false-positive rate tolerable:
 *   1. Both thickness readings must sit inside the central 80% (p10–p90) of
 *      the distribution, which discards corner artefacts and raycast
 *      bleed-through.
 *   2. The two triangles must share a full edge, not merely a vertex.
 *   3. Surviving pairs are spatially clustered so one physical step reports
 *      once instead of once per triangle along it.
 */
export function detectWallTransitions(geom, triThickness, triCentroid, triCount, medianWall, diag) {
  const { indices } = geom;
  const transitions = [];
  if (!triThickness || triCount <= 4 || !(medianWall > 0)) return transitions;

  const valid = [];
  for (let t = 0; t < triCount; t++) {
    const th = triThickness[t];
    if (!isNaN(th) && th > 0.05) valid.push(th);
  }
  if (valid.length < 10) return transitions;

  valid.sort((a, b) => a - b);
  const lowerBound = valid[Math.floor(valid.length * 0.10)];
  const upperBound = valid[Math.floor(valid.length * 0.90)];

  /* Edge → incident triangles. Keys pack the two vertex indices of an edge
     into one number so the map holds no strings. Vertex counts stay well
     under 2^26 for any mesh this tool can hold in memory. */
  const edgeMap = new Map();
  const addEdge = (va, vb, t) => {
    const lo = va < vb ? va : vb;
    const hi = va < vb ? vb : va;
    const key = lo * 67108864 + hi; // 2^26
    const existing = edgeMap.get(key);
    if (existing === undefined) edgeMap.set(key, t);
    else if (typeof existing === 'number') edgeMap.set(key, [existing, t]);
    else existing.push(t);
  };
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    addEdge(a, b, t); addEdge(b, c, t); addEdge(c, a, t);
  }

  const rawSteps = [];
  for (const entry of edgeMap.values()) {
    if (!Array.isArray(entry) || entry.length !== 2) continue; // boundary or non-manifold edge
    const [t1, t2] = entry;
    const th1 = triThickness[t1], th2 = triThickness[t2];
    if (isNaN(th1) || isNaN(th2)) continue;
    if (th1 < lowerBound || th1 > upperBound) continue;
    if (th2 < lowerBound || th2 > upperBound) continue;

    const delta = Math.abs(th1 - th2);
    /* Only a genuinely significant step counts: over 0.5 mm in absolute
       terms and over half the median wall in relative terms. */
    if (delta < 0.5) continue;
    if (delta / medianWall < 0.5) continue;

    const dx = triCentroid[t1 * 3] - triCentroid[t2 * 3];
    const dy = triCentroid[t1 * 3 + 1] - triCentroid[t2 * 3 + 1];
    const dz = triCentroid[t1 * 3 + 2] - triCentroid[t2 * 3 + 2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const recommendedLength = 3 * delta;
    if (dist >= recommendedLength * 0.3) continue; // already tapering acceptably

    rawSteps.push({
      cx: (triCentroid[t1 * 3] + triCentroid[t2 * 3]) / 2,
      cy: (triCentroid[t1 * 3 + 1] + triCentroid[t2 * 3 + 1]) / 2,
      cz: (triCentroid[t1 * 3 + 2] + triCentroid[t2 * 3 + 2]) / 2,
      thicknessLow: Math.min(th1, th2),
      thicknessHigh: Math.max(th1, th2),
      delta,
      currentLength: dist,
      recommendedLength,
    });
  }

  /* Keep the worst step per spatial cell. */
  const cellSize = Math.max(3.0, diag * 0.025);
  const inv = 1 / cellSize;
  const grid = new Map();
  for (const s of rawSteps) {
    const key = `${Math.floor(s.cx * inv)},${Math.floor(s.cy * inv)},${Math.floor(s.cz * inv)}`;
    const existing = grid.get(key);
    if (!existing || s.delta > existing.delta) grid.set(key, s);
  }

  for (const s of grid.values()) {
    transitions.push({
      centroid: [s.cx, s.cy, s.cz],
      thicknessLow: s.thicknessLow,
      thicknessHigh: s.thicknessHigh,
      delta: s.delta,
      currentLength: s.currentLength,
      recommendedLength: s.recommendedLength,
    });
  }
  transitions.sort((a, b) => b.delta - a.delta);
  return transitions;
}
