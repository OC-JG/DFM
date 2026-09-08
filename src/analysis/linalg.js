/*
 * The small amount of linear algebra two analyses need.
 *
 * `jacobiEigen` began life inside faces.js, fixed at 3×3, for the cylinder
 * axis fit. Registration needs the same routine at 4×4 — the rotation that
 * best matches two point sets is the largest eigenvector of a symmetric 4×4
 * built from their correlation (Horn 1987) — so it moved here and took a
 * dimension parameter. The algorithm is unchanged, and faces.js still calls
 * it with a 3×3.
 */

/*
 * Eigen-decomposition of a symmetric n×n by cyclic Jacobi rotations. Written
 * out rather than pulled in because it is thirty lines and the alternative is
 * a dependency in files that have none. Converges in a handful of sweeps at
 * the sizes used here.
 *
 * Returns `{ value, vector }` ascending by value, so the smallest eigenvector
 * is first and the largest last. Both callers depend on that order.
 */
export function jacobiEigen(m) {
  const n = m.length;
  const a = m.map((row) => row.slice());
  const v = m.map((_, i) => m.map((__, j) => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const vector = [];
    for (let k = 0; k < n; k++) vector.push(v[k][i]);
    out.push({ value: a[i][i], vector });
  }
  out.sort((x, y) => x.value - y.value);
  return out;
}
