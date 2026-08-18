/*
 * Descriptive statistics over a set of thickness samples.
 *
 * cvRobust is the coefficient of variation computed over the central 90% of
 * the distribution and divided by the median rather than the mean. That is
 * what people actually mean by "wall uniformity": outlier slivers from
 * tessellation artefacts (fillet centres, raycast grazes) should not
 * dominate the number.
 */
export function stats(arr) {
  const n = arr.length;
  if (!n) return { n: 0 };

  const sorted = Float64Array.from(arr).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const mean = sum / n;

  let varSum = 0;
  for (let i = 0; i < n; i++) { const d = sorted[i] - mean; varSum += d * d; }
  const sd = Math.sqrt(varSum / n);

  const at = (q) => sorted[Math.min(n - 1, Math.floor(n * q))];
  const median = at(0.5);

  const trimLo = Math.floor(n * 0.05);
  const trimHi = Math.max(trimLo + 1, Math.ceil(n * 0.95));
  let tSum = 0, tN = 0;
  for (let i = trimLo; i < trimHi; i++) { tSum += sorted[i]; tN++; }
  const tMean = tSum / tN;
  let tVar = 0;
  for (let i = trimLo; i < trimHi; i++) { const d = sorted[i] - tMean; tVar += d * d; }
  const tSd = Math.sqrt(tVar / tN);

  const [medLo, medHi] = medianCI95(sorted);

  return {
    n, mean, median, sd,
    min: sorted[0],
    max: sorted[n - 1],
    p5: at(0.05), p25: at(0.25), p75: at(0.75), p95: at(0.95),
    cv: mean > 0 ? sd / mean : 0,
    cvRobust: median > 0.01 ? tSd / median : 0,
    medLo, medHi,
    /* Half-width of the median's confidence interval as a fraction of the
       median. The wall check uses it to say when the nominal it is about to
       judge the part on is not pinned down well enough to judge on. */
    medUncertainty: median > 0.01 ? (medHi - medLo) / (2 * median) : 0,
  };
}

/*
 * Distribution-free 95% confidence interval for the median, from the order
 * statistics.
 *
 * The rank of the median in a sample of n is Binomial(n, ½), so its rank has
 * mean n/2 and standard deviation √n/2; the normal approximation puts the
 * 95% interval at ranks n/2 ± 1.96·√n/2, and the sample values at those ranks
 * bound the population median. No assumption about the shape of the
 * distribution, which matters here — wall thickness is nowhere near normal on
 * a part with ribs.
 *
 * This is conservative for our purposes. The samples are drawn stratified
 * across the area CDF rather than independently, so the true interval is
 * somewhat tighter than this reports; treating it as an upper bound on the
 * uncertainty is the safe direction for a manufacturability call.
 */
export function medianCI95(sortedValues) {
  const n = sortedValues.length;
  if (n < 2) return n === 1 ? [sortedValues[0], sortedValues[0]] : [0, 0];
  const halfRank = 1.96 * Math.sqrt(n) / 2;
  const lo = Math.max(0, Math.floor(n / 2 - halfRank) - 1);
  const hi = Math.min(n - 1, Math.ceil(n / 2 + halfRank) - 1);
  return [sortedValues[lo], sortedValues[hi]];
}

/*
 * mulberry32 — a small, fast, deterministic PRNG.
 *
 * The thickness sampler used Math.random() to jitter its stratified sample,
 * which meant the same file produced different percentiles on every run: a
 * measured spread of 0.048 mm in the median of a 12k-triangle part with a
 * varying wall. Every threshold in the rule engine is a hard cutoff on that
 * estimate, so a part sitting near a material limit could change verdict
 * between two runs on an unchanged file. A report you hand to a moulder has
 * to be reproducible.
 *
 * A fixed seed rather than a regular grid: regular stratification would also
 * be deterministic, but it aliases badly against structured tessellation —
 * on a mesh whose triangles are laid out in a repeating pattern, a constant
 * stride can sample only the outer skin and never the bore. Jitter breaks
 * that correlation while staying reproducible.
 */
export function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Format a pull axis for display. Accepts a "+z"-style string, a vec3, or both. */
export function formatPullAxis(axisStr, dirVec) {
  if (dirVec && Array.isArray(dirVec)) {
    const names = ['+X', '−X', '+Y', '−Y', '+Z', '−Z'];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(Math.abs(dirVec[i]) - 1) < 0.01
        && Math.abs(dirVec[(i + 1) % 3]) < 0.05
        && Math.abs(dirVec[(i + 2) % 3]) < 0.05) {
        return names[i * 2 + (dirVec[i] < 0 ? 1 : 0)];
      }
    }
    return `(${dirVec[0].toFixed(2)}, ${dirVec[1].toFixed(2)}, ${dirVec[2].toFixed(2)})`;
  }
  return axisStr || '+Z';
}

/* Resolve a pull direction from either an explicit vector or an axis string. */
export function resolvePullDir(pullDir, pullAxis) {
  if (pullDir && Array.isArray(pullDir)) {
    const len = Math.hypot(pullDir[0], pullDir[1], pullDir[2]) || 1;
    return [pullDir[0] / len, pullDir[1] / len, pullDir[2] / len];
  }
  const ax = pullAxis || '+z';
  const sign = ax.startsWith('-') ? -1 : 1;
  const axis = ax.replace(/^[+-]/, '').toLowerCase();
  if (axis === 'x') return [sign, 0, 0];
  if (axis === 'y') return [0, sign, 0];
  return [0, 0, sign];
}
