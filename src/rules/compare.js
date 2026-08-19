/*
 * Compare two runs.
 *
 * A score on its own answers "is this part manufacturable". The question
 * anyone actually asks on the second pass is "is it better than it was", and
 * until now the only way to find out was to remember the last number. The JSON
 * export already carries everything needed — per-check severity, the
 * measurements, the moulding estimates — so this reads two of those records and
 * says what moved.
 *
 * Pure, and deliberately tolerant: it takes exported records rather than live
 * analysis objects, so a comparison can be made against a file from a month ago
 * and an older schema. Anything missing is reported as unavailable rather than
 * assumed to be zero.
 */

const SEVERITY_RANK = { none: 0, minor: 1, major: 2, critical: 3 };

/* Fields whose movement is worth calling out, and which direction is good. */
const TRACKED = [
  { path: ['mesh_summary', 'wall_median_mm'], label: 'Median wall', unit: 'mm', better: null, dp: 2 },
  { path: ['mesh_summary', 'wall_iqr_ratio'], label: 'Wall variation', unit: '×', better: 'lower', dp: 2 },
  { path: ['mesh_summary', 'sidewall_area_under_min_draft_pct'], label: 'Sidewall under draft', unit: '%', better: 'lower', dp: 1 },
  { path: ['mesh_summary', 'sink_severe_area_pct'], label: 'Severe sink area', unit: '%', better: 'lower', dp: 1 },
  { path: ['mesh_summary', 'slide_area_mm2'], label: 'Slide undercut area', unit: 'mm²', better: 'lower', dp: 0 },
  { path: ['mesh_summary', 'lifter_area_mm2'], label: 'Lifter undercut area', unit: 'mm²', better: 'lower', dp: 0 },
  { path: ['mesh_summary', 'volume_mm3'], label: 'Volume', unit: 'mm³', better: null, dp: 0 },
  { path: ['moulding', 'part_mass_g'], label: 'Part mass', unit: 'g', better: 'lower', dp: 1 },
  { path: ['moulding', 'projected_area_cm2'], label: 'Projected area', unit: 'cm²', better: 'lower', dp: 1 },
  { path: ['moulding', 'machine_clamp_tonnes'], label: 'Machine clamp', unit: 't', better: 'lower', dp: 0 },
];

function dig(obj, path) {
  let node = obj;
  for (const key of path) {
    if (node == null || typeof node !== 'object') return null;
    node = node[key];
  }
  return typeof node === 'number' && isFinite(node) ? node : null;
}

export function compareRuns(before, after) {
  if (!before || !after) return null;

  const caveats = [];
  /* A score comparison across a material change, a mode change or a different
     set of enabled checks is not a comparison of the part. Say so rather than
     letting someone read a five-point improvement that came from switching from
     polypropylene to ABS. */
  if (before.material && after.material && before.material !== after.material) {
    caveats.push(`Material changed: ${before.material} → ${after.material}. Much of any score movement is the material, not the geometry.`);
  }
  if (before.mode && after.mode && before.mode !== after.mode) {
    caveats.push(`Analysis mode changed: ${before.mode} → ${after.mode}.`);
  }
  const budgetBefore = before.scoring && before.scoring.budget;
  const budgetAfter = after.scoring && after.scoring.budget;
  if (budgetBefore && budgetAfter && budgetBefore !== budgetAfter) {
    caveats.push(`A different set of checks ran (${budgetBefore}-point budget → ${budgetAfter}). Scores out of different budgets are not directly comparable.`);
  }

  const trisBefore = dig(before, ['mesh_summary', 'tris']);
  const trisAfter = dig(after, ['mesh_summary', 'tris']);
  if (trisBefore && trisAfter && trisBefore === trisAfter) {
    caveats.push(`Both runs have ${trisAfter.toLocaleString()} triangles — this may be the same geometry twice rather than a revision.`);
  }

  // ── checks ──────────────────────────────────────────────────────────────
  const byKey = (list) => new Map((list || []).map((c) => [c.key, c]));
  const b = byKey(before.checks);
  const a = byKey(after.checks);
  const keys = [...new Set([...b.keys(), ...a.keys()])];

  const checks = [];
  for (const key of keys) {
    const was = b.get(key);
    const now = a.get(key);
    const sevWas = was ? (was.severity || 'none') : null;
    const sevNow = now ? (now.severity || 'none') : null;
    const dedWas = was ? (was.score_deduction || 0) : null;
    const dedNow = now ? (now.score_deduction || 0) : null;

    let change;
    if (!was) change = 'added';
    else if (!now) change = 'removed';
    else if (SEVERITY_RANK[sevNow] < SEVERITY_RANK[sevWas]) change = 'improved';
    else if (SEVERITY_RANK[sevNow] > SEVERITY_RANK[sevWas]) change = 'worsened';
    else change = 'unchanged';

    /* Something can get better without changing band — a sink area halving
       while staying a major finding is progress worth showing. */
    if (change === 'unchanged' && dedWas !== null && dedNow !== null && dedWas !== dedNow) {
      change = dedNow < dedWas ? 'improved' : 'worsened';
    }

    checks.push({
      key,
      name: (now && now.name) || (was && was.name) || key,
      change,
      severityBefore: sevWas,
      severityAfter: sevNow,
      deductionBefore: dedWas,
      deductionAfter: dedNow,
      resolved: change === 'improved' && sevNow === 'none',
      appeared: change === 'worsened' && sevWas === 'none',
    });
  }

  const order = { worsened: 0, improved: 1, added: 2, removed: 3, unchanged: 4 };
  checks.sort((x, y) => (order[x.change] - order[y.change]) || x.name.localeCompare(y.name));

  // ── measurements ────────────────────────────────────────────────────────
  const measurements = [];
  for (const field of TRACKED) {
    const was = dig(before, field.path);
    const now = dig(after, field.path);
    if (was === null && now === null) continue;
    const delta = (was !== null && now !== null) ? now - was : null;
    let direction = 'flat';
    if (delta !== null && Math.abs(delta) > Math.max(1e-9, Math.abs(was) * 0.005)) {
      const rose = delta > 0;
      if (field.better === 'lower') direction = rose ? 'worse' : 'better';
      else if (field.better === 'higher') direction = rose ? 'better' : 'worse';
      else direction = 'changed';
    }
    measurements.push({ ...field, before: was, after: now, delta, direction });
  }

  // ── headline ────────────────────────────────────────────────────────────
  const scoreBefore = typeof before.score === 'number' ? before.score : null;
  const scoreAfter = typeof after.score === 'number' ? after.score : null;
  const scoreDelta = (scoreBefore !== null && scoreAfter !== null) ? scoreAfter - scoreBefore : null;

  const resolved = checks.filter((c) => c.resolved).map((c) => c.name);
  const appeared = checks.filter((c) => c.appeared).map((c) => c.name);
  const worsened = checks.filter((c) => c.change === 'worsened' && !c.appeared).map((c) => c.name);

  const parts = [];
  if (scoreDelta === null) parts.push('Scores could not be compared.');
  else if (scoreDelta > 0) parts.push(`Score up ${scoreDelta} to ${scoreAfter}.`);
  else if (scoreDelta < 0) parts.push(`Score down ${-scoreDelta} to ${scoreAfter}.`);
  else parts.push(`Score unchanged at ${scoreAfter}.`);

  if (before.grade && after.grade && before.grade !== after.grade) {
    parts.push(`${before.grade} → ${after.grade}.`);
  }
  if (resolved.length) parts.push(`Resolved: ${resolved.join(', ')}.`);
  if (appeared.length) parts.push(`New: ${appeared.join(', ')}.`);
  if (worsened.length) parts.push(`Worse: ${worsened.join(', ')}.`);
  if (!resolved.length && !appeared.length && !worsened.length) {
    parts.push('No check changed band.');
  }

  return {
    score: { before: scoreBefore, after: scoreAfter, delta: scoreDelta },
    grade: { before: before.grade || null, after: after.grade || null, changed: before.grade !== after.grade },
    checks,
    measurements,
    caveats,
    headline: parts.join(' '),
    labels: {
      before: describeRun(before),
      after: describeRun(after),
    },
  };
}

function describeRun(run) {
  const when = run.timestamp ? String(run.timestamp).slice(0, 16).replace('T', ' ') : 'unknown time';
  const session = run.session ? ` · ${run.session}` : '';
  const material = run.material ? ` · ${run.material}` : '';
  return `${when}${session}${material}`;
}
