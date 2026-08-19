/*
 * Scoring.
 *
 * One number comes out of this file, and the point of the file is that the
 * number can be traced back to the rule that produced it.
 *
 * Two quantities decide a deduction, and they answer different questions:
 *
 *   weight    how much this *kind* of problem is worth, at worst. A budget,
 *             fixed per check, argued from the S/L/D triple below.
 *   severity  how bad *this* instance is, decided by the rule that found it.
 *             A fraction of the budget, not a number of points.
 *
 * Keeping them apart is what the previous arrangement got wrong. Each rule
 * assigned itself an absolute point value, the scorer ignored those entirely
 * and deducted a flat share of the weight instead, and both numbers were
 * written to the JSON export — so a check that meant to cost 25 cost 15, a
 * check that meant to cost nothing cost 4.5, and there was no way to tell
 * from the output which figure was real.
 *
 * The S/L/D triple documents how each weight was chosen:
 *
 *   Severity   1–5   1 = cosmetic, 3 = scrap/rework, 5 = tool damage/safety
 *   Likelihood 1–5   probability the issue causes a real problem at that severity
 *   Detection  1–5   how hard it is to catch before production (5 = very hard)
 *
 * These inform the weights; they do not compute them. Multiplying the RPN
 * into the deduction was tried and rejected — it moved a critical fail by a
 * couple of points, which is worse than useless for triage — and deriving the
 * weights from RPN alone puts undercuts at 2.8 points because a slide is easy
 * to spot in a 3D review, which understates what one costs to tool. The
 * numbers below are judgement, informed by the triple and stated openly as
 * such.
 */

/* A severity band is a fraction of the check's weight. Four bands rather than
   a continuous scale: the underlying rules are threshold tests, and a
   precision the inputs cannot support would be false comfort. */
export const SEVERITY_FACTOR = {
  none: 0,
  minor: 0.25,     // real but tolerable; worth saying, not worth blocking on
  major: 0.5,      // needs a decision before tooling
  critical: 1,     // the part does not work as drawn
};

export const SEVERITY_ORDER = ['none', 'minor', 'major', 'critical'];

/* Raise a severity to at least `next`, for checks that accumulate findings. */
export function escalate(current, next) {
  return SEVERITY_ORDER.indexOf(next) > SEVERITY_ORDER.indexOf(current || 'none') ? next : (current || 'none');
}

/*
 * Per-check budgets.
 *
 * The eight checks that run by default sum to 100, so an unmodified run
 * scores out of a full 100 and a part that fails everything reaches 0. The
 * three conditional entries sit outside that hundred and are folded in by
 * normalisation when they run — see scoreChecks.
 *
 * `corners` carries no budget on purpose. It cannot fail: it has no way to
 * measure a radius, so it emits advice off the declared wall thickness and
 * nothing else. Holding 3 points it could never spend made the reachable
 * maximum deduction 87 while the grade bands were calibrated for 100.
 */
export const CHECK_RISK_PROFILES = {
  // ── the default eight, summing to 100 ──────────────────────────────────
  wall:          { S: 5, L: 4, D: 2, weight: 22 }, // short shot or gross sink = scrap
  draft:         { S: 4, L: 3, D: 3, weight: 18 }, // scuffing, tool wear, tool damage
  sink:          { S: 3, L: 3, D: 4, weight: 13 }, // cosmetic; invisible until first shots
  flow:          { S: 4, L: 3, D: 3, weight: 12 }, // short shot; L/T is calculable
  ribs:          { S: 3, L: 3, D: 2, weight: 11 }, // visible sink, fill trouble
  warp:          { S: 3, L: 3, D: 4, weight: 11 }, // dimensional failure, hard to predict
  undercut:      { S: 3, L: 2, D: 1, weight: 10 }, // tooling cost; obvious in review
  finish_compat: { S: 2, L: 5, D: 1, weight: 3  }, // forces a finish or material respec

  // ── conditional: only present when the user turns them on ──────────────
  fpc:           { S: 4, L: 3, D: 3, weight: 12 }, // substrate damage or delamination
  transitions:   { S: 2, L: 2, D: 4, weight: 5  }, // stress and shrink; advisory on STL

  // ── advisory: present, never deducts ───────────────────────────────────
  corners:       { S: 3, L: 2, D: 2, weight: 0  }, // cannot be measured without B-rep
};

/*
 * Two-shot checks score through the same mechanism rather than a parallel one
 * of their own. They previously summed raw penalties to a maximum of 105,
 * which meant a two-shot 70 and a single-part 70 were not the same claim.
 */
export const TWO_SHOT_RISK_PROFILES = {
  ts_thermal:   { S: 5, L: 3, D: 2, weight: 25 }, // substrate deforms during shot 2
  ts_adhesion:  { S: 5, L: 3, D: 3, weight: 25 }, // delamination in service
  ts_thickness: { S: 4, L: 3, D: 3, weight: 20 }, // short shot, or a window that will not transmit
  ts_shrinkage: { S: 3, L: 3, D: 4, weight: 18 }, // interface stress on cooling
  ts_coverage:  { S: 2, L: 2, D: 2, weight: 6  }, // usually a mesh alignment problem
  ts_order:     { S: 2, L: 2, D: 2, weight: 6  }, // convention, not physics
};

/* Severity a check carries, falling back to its display status for any rule
   that has not been given an explicit band. */
export function severityOf(check) {
  if (check.severity) return check.severity;
  if (check.status === 'fail') return 'critical';
  if (check.status === 'warn') return 'major';
  return 'none';
}

export function computeCheckScore(key, check, profiles = CHECK_RISK_PROFILES) {
  const p = profiles[key];
  if (!p) return 0;
  return p.weight * SEVERITY_FACTOR[severityOf(check)];
}

/*
 * Grade thresholds.
 *
 * The score alone is not allowed to decide this. A single critical finding on
 * a light check — an internal undercut, say, at 10 points — leaves a score of
 * 90, and calling that part production-ready because of where the arithmetic
 * landed would be exactly the kind of untraceable verdict this file exists to
 * prevent. So the band is the worse of what the score says and what the worst
 * finding allows.
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

/* Best grade a part with this many critical findings may hold, as an index
   into the grade table: one critical is not production ready, two are not
   minor rework, three or more are not manufacturable as drawn. */
function gradeFloorIndex(criticalCount) {
  if (criticalCount >= 3) return 3;
  if (criticalCount === 2) return 2;
  if (criticalCount === 1) return 1;
  return 0;
}

/*
 * Score a list of checks.
 *
 * Normalised by the budget that actually ran, not by a fixed 100. Turning on
 * the FPC checks adds 12 points of exposure; without normalising, a part that
 * passes them would score the same as one where they never ran, and a part
 * that fails them could not reach 0. The denominator is returned so a report
 * can say what the score was out of.
 */
export function scoreChecks(checks, gradeTable, profiles = CHECK_RISK_PROFILES) {
  let totalDeduction = 0;
  let budget = 0;
  let criticalCount = 0;

  for (const c of checks) {
    const profile = profiles[c.key];
    const deduct = computeCheckScore(c.key, c, profiles);
    if (profile) budget += profile.weight;

    /* A check that costs points cannot present itself as a pass. Several rules
       raise severity for a secondary finding — an undersized rib fillet, a
       boss wall outside its window — without touching the status, which left
       the panel showing a green "ok" next to a deduction. Enforced here once
       rather than trusted to every branch. */
    if (c.status === 'ok' && deduct > 0) c.status = 'warn';
    /* Kept on the check so the panel and the exports can show where each
       point went, rather than only the total. */
    c.scoreDeduction = Math.round(deduct * 10) / 10;
    c.severity = severityOf(c);
    c.weight = profile ? profile.weight : 0;
    totalDeduction += deduct;
    if (c.severity === 'critical' && profile && profile.weight > 0) criticalCount++;
  }

  const score = budget > 0
    ? Math.max(0, Math.round(100 * (1 - totalDeduction / budget)))
    : 100;

  const byScore = gradeTable.indexOf(gradeFor(score, gradeTable));
  const grade = gradeTable[Math.max(byScore, gradeFloorIndex(criticalCount))];

  return { score, grade, totalDeduction, budget, criticalCount };
}
