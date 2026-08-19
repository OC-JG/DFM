/*
 * Flow-length analysis — geodesic distance from the gate across the mesh
 * surface, and the resulting L/T ratio per triangle.
 *
 * Two rewrites versus the original, both about scale:
 *
 *  1. Adjacency is built as CSR (compressed sparse row) over deduplicated
 *     neighbours. The original pushed six entries per triangle into an array
 *     of arrays, so every vertex appeared once per incident triangle and each
 *     duplicate was relaxed again.
 *
 *  2. Dijkstra uses a binary heap. The original scanned the whole frontier
 *     linearly for the minimum, which is O(V²) — its own comment conceded
 *     this was "adequate up to ~10k verts", and a tessellated STEP part is
 *     routinely five times that.
 */

/* Minimal binary min-heap over (vertex, distance) pairs, backed by typed
   arrays so there is no per-node object churn. */
class MinHeap {
  constructor(capacity) {
    this.nodes = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.size = 0;
    this.capacity = capacity;
  }

  push(node, key) {
    if (this.size === this.capacity) {
      this.capacity = Math.ceil(this.capacity * 1.6);
      const n = new Int32Array(this.capacity); n.set(this.nodes); this.nodes = n;
      const k = new Float64Array(this.capacity); k.set(this.keys); this.keys = k;
    }
    let i = this.size++;
    this.nodes[i] = node;
    this.keys[i] = key;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this._swap(i, parent);
      i = parent;
    }
  }

  pop() {
    const topNode = this.nodes[0];
    const topKey = this.keys[0];
    this.size--;
    if (this.size > 0) {
      this.nodes[0] = this.nodes[this.size];
      this.keys[0] = this.keys[this.size];
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = l + 1;
        let smallest = i;
        if (l < this.size && this.keys[l] < this.keys[smallest]) smallest = l;
        if (r < this.size && this.keys[r] < this.keys[smallest]) smallest = r;
        if (smallest === i) break;
        this._swap(i, smallest);
        i = smallest;
      }
    }
    return { node: topNode, key: topKey };
  }

  _swap(a, b) {
    const n = this.nodes[a]; this.nodes[a] = this.nodes[b]; this.nodes[b] = n;
    const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k;
  }
}

/* Build deduplicated vertex adjacency in CSR form: neighbours of vertex v
   live in adj[offsets[v] .. offsets[v+1]).

   Exported because the gate search runs one Dijkstra per candidate position
   over the same graph, and rebuilding it each time would dominate the cost. */
export function buildAdjacency(indices, triCount, vertCount) {
  const degree = new Uint32Array(vertCount + 1);
  for (let t = 0; t < triCount; t++) {
    degree[indices[t * 3]] += 2;
    degree[indices[t * 3 + 1]] += 2;
    degree[indices[t * 3 + 2]] += 2;
  }
  const offsets = new Uint32Array(vertCount + 1);
  let acc = 0;
  for (let v = 0; v < vertCount; v++) { offsets[v] = acc; acc += degree[v]; }
  offsets[vertCount] = acc;

  const cursor = Uint32Array.from(offsets.subarray(0, vertCount));
  const raw = new Uint32Array(acc);
  const add = (a, b) => { raw[cursor[a]++] = b; };
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    add(a, b); add(a, c);
    add(b, a); add(b, c);
    add(c, a); add(c, b);
  }

  /* Compact each vertex's neighbour run in place, dropping duplicates. */
  const outOffsets = new Uint32Array(vertCount + 1);
  let w = 0;
  for (let v = 0; v < vertCount; v++) {
    const start = offsets[v], end = offsets[v + 1];
    outOffsets[v] = w;
    const run = raw.subarray(start, end);
    run.sort();
    let prev = -1;
    for (let i = 0; i < run.length; i++) {
      if (run[i] !== prev) { raw[w++] = run[i]; prev = run[i]; }
    }
  }
  outOffsets[vertCount] = w;
  return { offsets: outOffsets, adj: raw.subarray(0, w) };
}

export function computeFlowLengths(geom, gateLoc, triCentroid, triThickness, triCount, ltMax, triAreas, adjacency) {
  const { vertices, indices, vertCount } = geom;

  // 1. Nearest vertex and nearest triangle to the picked gate point.
  let nearestV = 0, nearestD2 = Infinity;
  for (let v = 0; v < vertCount; v++) {
    const dx = vertices[v * 3] - gateLoc[0];
    const dy = vertices[v * 3 + 1] - gateLoc[1];
    const dz = vertices[v * 3 + 2] - gateLoc[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < nearestD2) { nearestD2 = d2; nearestV = v; }
  }
  let nearestTri = -1, nearestTriD2 = Infinity;
  for (let t = 0; t < triCount; t++) {
    const dx = triCentroid[t * 3] - gateLoc[0];
    const dy = triCentroid[t * 3 + 1] - gateLoc[1];
    const dz = triCentroid[t * 3 + 2] - gateLoc[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < nearestTriD2) { nearestTriD2 = d2; nearestTri = t; }
  }
  const gateLocalThickness = (nearestTri >= 0 && triThickness && !isNaN(triThickness[nearestTri]))
    ? triThickness[nearestTri] : null;

  // 2. Dijkstra over the vertex graph, edges weighted by Euclidean length.
  const graph = adjacency || buildAdjacency(indices, triCount, vertCount);
  const dist = geodesicFrom(vertices, vertCount, graph, nearestV);

  // 3. Per-triangle flow length (mean of its vertices) and L/T ratio.
  const triFlow = new Float32Array(triCount);
  const triLT = new Float32Array(triCount);
  let maxFlow = 0, maxLT = 0, tMaxLT = -1;
  let areaOverLT = 0, areaTotal = 0;

  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    const fl = (dist[a] + dist[b] + dist[c]) / 3;
    triFlow[t] = isFinite(fl) ? fl : NaN;
    if (isFinite(fl) && fl > maxFlow) maxFlow = fl;

    const th = triThickness[t];
    if (!isNaN(th) && isFinite(fl) && th > 0.01) {
      const lt = fl / th;
      triLT[t] = lt;
      if (lt > maxLT) { maxLT = lt; tMaxLT = t; }
      const area = triAreas ? triAreas[t] : 1;
      areaTotal += area;
      if (lt > ltMax) areaOverLT += area;
    } else {
      triLT[t] = NaN;
    }
  }

  const worstLocation = tMaxLT >= 0
    ? [triCentroid[tMaxLT * 3], triCentroid[tMaxLT * 3 + 1], triCentroid[tMaxLT * 3 + 2]]
    : null;

  // 4. Weld-line approximation: the furthest-fill triangles, spread apart.
  //    These are where the last-arriving flow fronts meet.
  const candidates = [];
  const order = [];
  for (let t = 0; t < triCount; t++) {
    if (isFinite(triFlow[t]) && !isNaN(triThickness[t])) order.push(t);
  }
  order.sort((a, b) => triFlow[b] - triFlow[a]);
  const minSep = maxFlow * 0.1;
  for (const t of order) {
    const cx = triCentroid[t * 3], cy = triCentroid[t * 3 + 1], cz = triCentroid[t * 3 + 2];
    let tooClose = false;
    for (const w of candidates) {
      const dx = w[0] - cx, dy = w[1] - cy, dz = w[2] - cz;
      if (dx * dx + dy * dy + dz * dz < minSep * minSep) { tooClose = true; break; }
    }
    if (!tooClose) candidates.push([cx, cy, cz]);
    if (candidates.length >= 3) break;
  }

  return {
    gate: gateLoc,
    nearestVertex: [vertices[nearestV * 3], vertices[nearestV * 3 + 1], vertices[nearestV * 3 + 2]],
    triFlow, triLT,
    maxFlow, maxLT,
    pctOverLT: areaTotal > 0 ? (areaOverLT / areaTotal) * 100 : 0,
    ltMax,
    worstLocation,
    gateLocalThickness,
    weldCandidates: candidates,
  };
}


/*
 * Geodesic distance from one vertex to every other, across the mesh surface.
 *
 * Split out of computeFlowLengths so the gate search can run it many times
 * against one prebuilt graph. Nothing else changed: still a binary heap over
 * typed arrays, still O(E log V).
 */
export function geodesicFrom(vertices, vertCount, graph, sourceVertex) {
  const { offsets, adj } = graph;
  const dist = new Float64Array(vertCount).fill(Infinity);
  const visited = new Uint8Array(vertCount);
  dist[sourceVertex] = 0;

  const heap = new MinHeap(Math.max(64, vertCount >> 2));
  heap.push(sourceVertex, 0);
  while (heap.size > 0) {
    const { node: u, key: du } = heap.pop();
    if (visited[u]) continue;      // stale entry from a since-improved key
    visited[u] = 1;
    const ux = vertices[u * 3], uy = vertices[u * 3 + 1], uz = vertices[u * 3 + 2];
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      const w = adj[e];
      if (visited[w]) continue;
      const dx = vertices[w * 3] - ux;
      const dy = vertices[w * 3 + 1] - uy;
      const dz = vertices[w * 3 + 2] - uz;
      const nd = du + Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (nd < dist[w]) { dist[w] = nd; heap.push(w, nd); }
    }
  }
  return dist;
}

/*
 * Where should the gate go?
 *
 * The flow check is only as good as the gate it was given, and until now the
 * gate came from wherever the user happened to click. Two clicks a centimetre
 * apart on a long part can be the difference between "fills comfortably" and a
 * short-shot warning, and nothing in the tool suggested which was which — so
 * the single most consequential input was also the least informed one.
 *
 * This tries a spread of candidate positions and ranks them by the same
 * measure the check itself uses: the worst flow-length-to-thickness ratio
 * anywhere on the part, then how much of the part sits over the limit.
 *
 * Candidates are drawn from outward-facing triangles only. A gate has to be
 * reachable by a sprue, and the inward faces of a cavity are not — which is
 * what triFaceSide already knows, another thing the analysis computes and
 * nothing read. They are spread by farthest-point sampling rather than taken at
 * random, because a random dozen points on a long part will cluster and miss
 * the ends, and the ends are where gating decisions are made.
 */
export function searchGateCandidates({
  geom, triCentroid, triThickness, triAreas, triFaceSide, triCount, ltMax,
  candidateCount = 12, adjacency,
}) {
  const { vertices, indices, vertCount } = geom;
  if (!(candidateCount > 0) || triCount < 4) return null;

  /* Eligible: outward-facing, with a thickness reading to divide by. */
  let eligible = [];
  for (let t = 0; t < triCount; t++) {
    if (triFaceSide && triFaceSide[t] === 1) continue;
    if (isNaN(triThickness[t])) continue;
    eligible.push(t);
  }
  if (eligible.length < 2) return null;

  /* Drop the below-median-area faces. Farthest-point sampling knows nothing
     about how big a triangle is, so on a long thin part half the candidates
     landed on the 2 mm sliver down the edge rather than on the broad faces a
     sprue would actually meet. Anything at or above the median is a face worth
     gating on. */
  if (eligible.length > candidateCount * 4) {
    const areas = eligible.map((t) => triAreas[t]).sort((a, b) => a - b);
    const medianArea = areas[areas.length >> 1];
    const substantial = eligible.filter((t) => triAreas[t] >= medianArea);
    if (substantial.length >= candidateCount) eligible = substantial;
  }

  const picks = farthestPointSample(eligible, triCentroid, triAreas, Math.min(candidateCount, eligible.length));
  const graph = adjacency || buildAdjacency(indices, triCount, vertCount);

  const candidates = [];
  for (const t of picks) {
    const point = [triCentroid[t * 3], triCentroid[t * 3 + 1], triCentroid[t * 3 + 2]];
    const result = computeFlowLengths(geom, point, triCentroid, triThickness, triCount, ltMax, triAreas, graph);
    candidates.push({
      point,
      triangle: t,
      rayThicknessAtGate: triThickness[t],
      maxLT: result.maxLT,
      maxFlow: result.maxFlow,
      pctOverLT: result.pctOverLT,
    });
  }

  /* Lower worst-case L/T first, then less of the part beyond the limit, then
     the shorter longest-flow-path.

     Not ranked on the thickness at the gate, tempting though it is — a part
     should fill from its thickest section outward or the gate freezes off
     before packing completes, but the ray reading at an arbitrary face is not
     that thickness. On the side face of a 2 mm bar it reads the 20 mm width.
     The figure is still reported, as the ray measurement it is. */
  candidates.sort((a, b) =>
    (a.maxLT - b.maxLT)
    || (a.pctOverLT - b.pctOverLT)
    || (a.maxFlow - b.maxFlow));

  return {
    candidates,
    best: candidates[0],
    worst: candidates[candidates.length - 1],
    considered: candidates.length,
    eligible: eligible.length,
  };
}

/*
 * Spread `count` triangles across the surface, greedily.
 *
 * Seeded at the largest eligible face, then each further pick is whichever
 * candidate lies farthest from everything chosen so far. Deterministic, and it
 * covers the extremities that a random sample tends to miss — which matters
 * because the ends of a part are exactly where gating decisions get made.
 */
function farthestPointSample(eligible, triCentroid, triAreas, count) {
  let seed = eligible[0];
  for (const t of eligible) if (triAreas[t] > triAreas[seed]) seed = t;

  const chosen = [seed];
  /* Distance from each candidate to the nearest chosen point so far. */
  const nearest = new Float64Array(eligible.length).fill(Infinity);
  const updateFrom = (pick) => {
    const px = triCentroid[pick * 3], py = triCentroid[pick * 3 + 1], pz = triCentroid[pick * 3 + 2];
    for (let i = 0; i < eligible.length; i++) {
      const t = eligible[i];
      const dx = triCentroid[t * 3] - px;
      const dy = triCentroid[t * 3 + 1] - py;
      const dz = triCentroid[t * 3 + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < nearest[i]) nearest[i] = d2;
    }
  };
  updateFrom(seed);

  while (chosen.length < count) {
    let bestI = -1, bestD = -1;
    for (let i = 0; i < eligible.length; i++) {
      if (nearest[i] > bestD) { bestD = nearest[i]; bestI = i; }
    }
    if (bestI < 0 || bestD <= 0) break;
    const pick = eligible[bestI];
    chosen.push(pick);
    updateFrom(pick);
  }
  return chosen;
}
