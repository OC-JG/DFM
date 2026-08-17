/*
 * FMEA-based scoring.
 *
 * Each check carries a risk profile drawn from injection moulding literature
 * and FMEA practice:
 *
 *   Severity   1–5   1 = cosmetic, 3 = scrap/rework, 5 = tool damage/safety
 *   Likelihood 1–5   probability the issue causes a real problem at that severity
 *   Detection  1–5   how hard it is to catch before production (5 = very hard)
 *
 * The S/L/D triple is what justifies each check's `weight` — its share of the
 * 100-point score. The weights sum to 100, so a part with no findings scores
 * 100. Deduction is the full weight for a fail and half for a warn.
 *
 * Note the S/L/D values are documentation of how the weights were derived,
 * not runtime multipliers. Multiplying an RPN into the per-run deduction was
 * tried and rejected: it made even a critical fail move the score by a couple
 * of points, which is worse than useless for triage.
 */
export const CHECK_RISK_PROFILES = {
  wall:          { S: 5, L: 4, D: 2, weight: 20 }, // short shot or gross sink = scrap; caught early by an analyst
  draft:         { S: 4, L: 3, D: 3, weight: 15 }, // scuffing, tool wear, damage; partly visible in CAD review
  ribs:          { S: 3, L: 3, D: 2, weight: 10 }, // visible sink, fill issues; usually caught in DFM review
  undercut:      { S: 3, L: 2, D: 1, weight: 10 }, // tooling cost; very visible in a 3D review
  sink:          { S: 3, L: 3, D: 4, weight: 12 }, // cosmetic defect; not obvious until first shots
  warp:          { S: 3, L: 3, D: 4, weight: 10 }, // dimensional failure; hard to predict without simulation
  transitions:   { S: 2, L: 2, D: 4, weight: 5  }, // stress/shrink; advisory — unreliable on STL
  flow:          { S: 4, L: 3, D: 3, weight: 9  }, // short shot; L/T is calculable but gate location is uncertain
  fpc:           { S: 4, L: 3, D: 3, weight: 5  }, // substrate damage or delamination
  corners:       { S: 3, L: 2, D: 2, weight: 3  }, // advisory — stress concentration and tooling cost
  finish_compat: { S: 2, L: 5, D: 1, weight: 1  }, // always detectable in pre-production review
};

export function computeCheckScore(key, status) {
  const p = CHECK_RISK_PROFILES[key];
  if (!p) return 0;
  if (status === 'fail') return p.weight;
  if (status === 'warn') return p.weight * 0.5;
  return 0;
}

/*
 * Grade thresholds. One critical fail costs 12–15 points, landing at 85–88;
 * two put the part in the 70s; three or more drop it below 65.
 */
export const PART_GRADES = [
  { min: 85, label: 'PRODUCTION READY',  color: '#2e7d4f' },
  { min: 70, label: 'MINOR REWORK',      color: '#e6c244' },
  { min: 50, label: 'MAJOR REWORK',      color: '#e8821a' },
  { min: -1, label: 'NOT MANUFACTURABLE', color: '#d43824' },
];

export const INTERFACE_GRADES = [
  { min: 85, label: 'INTERFACE OK',   color: '#2e7d4f' },
  { min: 70, label: 'MINOR REWORK',   color: '#e6c244' },
  { min: 50, label: 'MAJOR REWORK',   color: '#e8821a' },
  { min: -1, label: 'NOT COMPATIBLE', color: '#d43824' },
];

export function gradeFor(score, table) {
  return table.find((g) => score >= g.min);
}

/* Apply FMEA deductions across a check list and return score + grade. */
export function scoreChecks(checks, gradeTable) {
  let totalDeduction = 0;
  for (const c of checks) {
    const deduct = computeCheckScore(c.key, c.status);
    c.scoreDeduction = Math.round(deduct * 10) / 10; // kept for transparency in the UI
    totalDeduction += deduct;
  }
  const score = Math.max(0, Math.round(100 - totalDeduction));
  return { score, grade: gradeFor(score, gradeTable), totalDeduction };
}
