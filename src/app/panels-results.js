import { $, el, replaceChildren } from './dom.js';
import { formatPullAxis } from '../analysis/stats.js';

/*
 * Results panel rendering.
 *
 * Two changes worth naming:
 *
 *  - Nodes are built with the DOM API into a fragment, not accumulated with
 *    `innerHTML +=` in a loop. The old approach reparsed the whole list on
 *    every iteration and discarded any listeners already attached to it.
 *
 *  - Each check is a real <details>/<summary>, so it opens with Enter or
 *    Space, lands in the tab order, and announces its state — none of which
 *    a <div> with a click handler does.
 */

const STATUS_DOT = { fail: '●', warn: '◐', ok: '○', info: '◇' };

function normaliseStatus(status) {
  return (status === 'fail' || status === 'warn' || status === 'ok') ? status : 'info';
}

function deductionOf(check) {
  return check.scoreDeduction || 0;
}

/* An advisory carries no verdict about the part, so it gets its own row style
   rather than borrowing the one that means "passed". */
function stripClass(check) {
  if (check.status === 'fail') return 'fail';
  if (check.status === 'warn') return 'warn';
  if (check.status === 'info') return 'info';
  return 'ok';
}

const SEVERITY_LABEL = {
  minor: 'minor', major: 'major', critical: 'critical',
};

/* Compact status strip inside the score block. */
function scoreStrip(check) {
  const st = stripClass(check);
  const deduct = deductionOf(check);
  const sev = SEVERITY_LABEL[check.severity];
  return el('div', {
    class: `score-strip ${st}`,
    title: deduct > 0
      ? `${sev} finding: ${deduct.toFixed(1)} of this check's ${check.weight} point budget`
      : (check.status === 'info' ? 'Advisory — carries no score' : 'No deduction'),
  }, [
    el('span', { class: 's-dot', text: STATUS_DOT[st], 'aria-hidden': 'true' }),
    el('span', { class: 's-name', text: check.name }),
    el('span', { class: 's-pts', text: deduct > 0 ? `−${deduct.toFixed(1)}` : '0' }),
  ]);
}

/* Expandable check card. Fails and warnings start open so problems are
   visible without a click; passes start closed to keep the list scannable. */
function checkCard(check) {
  const st = normaliseStatus(check.status);
  const deduct = deductionOf(check);

  const metrics = check.metrics && check.metrics.length
    ? el('div', { class: 'check-metric' }, check.metrics.map(([k, v]) =>
      el('span', {}, [document.createTextNode(k), el('b', { text: String(v) })])))
    : null;

  return el('details', { class: `check ${st}`, open: st === 'fail' || st === 'warn' }, [
    el('summary', { class: 'check-header' }, [
      el('span', { class: `check-dot ${st}`, text: STATUS_DOT[st], 'aria-hidden': 'true' }),
      el('span', { class: 'check-name', text: check.name }),
      el('span', {
        class: `check-deduct ${deduct > 0 ? st : 'zero'}`,
        text: deduct > 0 ? `−${deduct.toFixed(1)}` : '0',
        title: deduct > 0 ? `${deduct.toFixed(1)} points deducted from the score` : 'No deduction',
      }),
      el('span', { class: 'check-caret', 'aria-hidden': 'true', text: '▴' }),
    ]),
    el('div', { class: 'check-body' }, [
      /* Detail text is authored in this codebase and carries deliberate
         inline markup, so it is inserted as HTML by design. */
      el('div', { class: 'check-detail', html: check.detail }),
      metrics,
    ]),
  ]);
}

function blockerText(checks) {
  const fails = checks.filter((c) => c.status === 'fail').map((c) => c.name);
  const warns = checks.filter((c) => c.status === 'warn').map((c) => c.name);
  const total = checks.reduce((s, c) => s + deductionOf(c), 0);
  const basis = total > 0 ? ` (−${total.toFixed(1)} pts)` : '';
  if (fails.length) return `Blocking: ${fails.join(', ')}${basis}`;
  if (warns.length) return `Warnings: ${warns.slice(0, 2).join(', ')}${warns.length > 2 ? ` +${warns.length - 2} more` : ''}${basis}`;
  return total > 0 ? `Minor deductions: ${total.toFixed(1)} pts` : '';
}

export function renderResults(result, analysis) {
  $('resultsEmpty').style.display = 'none';
  $('resultsContent').style.display = '';
  const hint = $('viewerHint');
  if (hint) hint.style.display = 'none';

  $('scoreValue').textContent = result.score;
  $('scoreValue').title = result.budget
    ? `${result.totalDeduction.toFixed(1)} points deducted from a ${result.budget}-point budget across the checks that ran. `
      + 'Each check spends a share of its own weight — a quarter for a minor finding, half for a major, all of it for a critical.'
    : 'No checks were enabled.';

  replaceChildren($('scoreGrade'), [
    el('span', { class: 'dot', style: `background:${result.grade.color}` }),
    document.createTextNode(result.grade.label),
  ]);
  $('scoreBlocker').textContent = blockerText(result.checks);

  replaceChildren($('scoreBars'), result.checks.map(scoreStrip));
  replaceChildren($('checksList'), result.checks.map(checkCard));

  renderToolingActions(analysis);
}

export function renderTwoShotResults(result) {
  const panel = $('twoShotResults');
  panel.style.display = '';
  $('tsScore').textContent = result.score;
  replaceChildren($('tsGrade'), [
    el('span', { class: 'dot', style: `background:${result.grade.color}` }),
    document.createTextNode(result.grade.label),
  ]);
  $('tsBlocker').textContent = blockerText(result.checks);
  replaceChildren($('tsBars'), result.checks.map(scoreStrip));
  replaceChildren($('tsChecksList'), result.checks.map(checkCard));
}

export function hideTwoShotResults() {
  const panel = $('twoShotResults');
  if (panel) panel.style.display = 'none';
}

// ── tooling actions ────────────────────────────────────────────────────────

function toolingRegionCard(region, index) {
  const isSlide = region.type === 1;
  const c = region.centroid;
  const advice = isSlide
    ? `External undercut. Slide retracts perpendicular to pull along ${formatPullAxis(null, region.action)}, min stroke ≈ ${region.perpStroke.toFixed(1)} mm (add ~3–5 mm clearance). Drive via angle pin (typical 15–22°) or hydraulic cylinder. Verify cooling channel routing through the slide body.`
    : `Internal undercut. Lifter angled <b>${region.lifterAngleDeg.toFixed(1)}°</b> from pull axis, travels ≈ <b>${region.pullTravel.toFixed(1)} mm</b> along pull while sweeping ${region.perpStroke.toFixed(1)} mm perpendicular. Hardened face (≥50 HRC) and grease groove recommended.`;

  return el('div', { class: `tooling-region ${isSlide ? 'slide' : 'lifter'}` }, [
    el('div', { class: 'tooling-region-head' }, [
      el('span', { class: 'tooling-pin', text: String(index + 1) }),
      el('span', { class: 'tooling-type', text: isSlide ? 'SLIDE' : 'LIFTER' }),
      el('span', { class: 'tooling-area', text: `${region.area.toFixed(1)} mm²` }),
    ]),
    el('div', { class: 'tooling-region-coords', text: `@ (${c[0].toFixed(1)}, ${c[1].toFixed(1)}, ${c[2].toFixed(1)})` }),
    el('div', { class: 'tooling-region-advice', html: advice }),
  ]);
}

function renderToolingActions(analysis) {
  const section = $('toolingSection');
  const panel = $('toolingActions');
  if (!analysis || !analysis.undercutRegions) {
    section.style.display = 'none';
    return;
  }

  /* Sub-1 mm² regions are tessellation noise rather than features. */
  const regions = analysis.undercutRegions.filter((r) => r.area > 1);
  section.style.display = '';

  if (!regions.length) {
    replaceChildren(panel, el('div', { class: 'tooling-empty' }, [
      el('span', { class: 'check-status ok', text: 'straight pull' }),
      el('div', {
        class: 'tooling-empty-note',
        text: `No significant undercut regions on pull axis ${formatPullAxis(analysis.pullAxis, analysis.pullDir)}. Two-plate tool feasible.`,
      }),
    ]));
    $('toolingToggleLabel').textContent = 'Tooling actions — straight pull';
    return;
  }

  const slides = regions.filter((r) => r.type === 1).length;
  const lifters = regions.filter((r) => r.type === 2).length;

  const nodes = [
    el('div', { class: 'tooling-summary' }, [
      el('span', { class: 'tooling-count slide', text: `${slides} slide${slides === 1 ? '' : 's'}` }),
      el('span', { class: 'tooling-count lifter', text: `${lifters} lifter${lifters === 1 ? '' : 's'}` }),
    ]),
    ...regions.slice(0, 8).map(toolingRegionCard),
  ];
  if (regions.length > 8) {
    nodes.push(el('div', {
      class: 'tooling-more',
      text: `+ ${regions.length - 8} more region${regions.length - 8 === 1 ? '' : 's'} suppressed (see JSON export for full list)`,
    }));
  }
  replaceChildren(panel, nodes);

  const parts = [];
  if (slides) parts.push(`${slides} slide${slides > 1 ? 's' : ''}`);
  if (lifters) parts.push(`${lifters} lifter${lifters > 1 ? 's' : ''}`);
  $('toolingToggleLabel').textContent = `Tooling actions — ${parts.join(' · ')}`;
}

export function clearResults() {
  $('resultsEmpty').style.display = '';
  $('resultsContent').style.display = 'none';
  hideTwoShotResults();
  replaceChildren($('checksList'), []);
  replaceChildren($('scoreBars'), []);
}
