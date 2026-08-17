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

  return {
    n, mean, median, sd,
    min: sorted[0],
    max: sorted[n - 1],
    p5: at(0.05), p25: at(0.25), p75: at(0.75), p95: at(0.95),
    cv: mean > 0 ? sd / mean : 0,
    cvRobust: median > 0.01 ? tSd / median : 0,
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
