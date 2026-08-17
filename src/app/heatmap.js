import { formatPullAxis } from '../analysis/stats.js';
import { el } from './dom.js';

/*
 * DFM heatmap palette — one source of truth for every heat mode.
 *
 * A single severity ramp (NEUTRAL → OK → CAUTION → WARN → BAD → CRITICAL)
 * runs across all continuous modes, so a colour means the same thing whether
 * you are looking at draft, wall or flow. The categorical entries below it
 * sit outside that ramp on purpose: a slide is not "worse" than a lifter, it
 * is a different kind of thing, so they get distinct hues instead of ramp
 * positions.
 */
export const DFM_PALETTE = {
  NEUTRAL:  { hex: '#b8b3a3', rgb: [0.72, 0.70, 0.64] }, // grey-beige — not applicable
  OK:       { hex: '#2e7d4f', rgb: [0.18, 0.49, 0.31] }, // green — in spec
  CAUTION:  { hex: '#e6c244', rgb: [0.90, 0.76, 0.27] }, // yellow — borderline
  WARN:     { hex: '#e8821a', rgb: [0.91, 0.51, 0.10] }, // orange — moderate
  BAD:      { hex: '#d43824', rgb: [0.83, 0.22, 0.14] }, // red — major
  CRITICAL: { hex: '#8b1818', rgb: [0.55, 0.09, 0.09] }, // dark red — severe

  SLIDE:    { hex: '#1e6fb8', rgb: [0.12, 0.44, 0.72] }, // blue — slide region
  LIFTER:   { hex: '#7b1f8b', rgb: [0.48, 0.12, 0.55] }, // purple — lifter region
  THIN:     { hex: '#0d4a8c', rgb: [0.05, 0.29, 0.55] }, // deep blue — under-minimum wall
};

export const HEAT_MODES = [
  { id: 'flat',      label: 'FLAT',     title: 'No colouring' },
  { id: 'draft',     label: 'DRAFT',    title: 'Draft angle vs material minimum' },
  { id: 'thickness', label: 'WALL',     title: 'Local wall thickness' },
  { id: 'sink',      label: 'SINK',     title: 'Sink-mark risk' },
  { id: 'undercut',  label: 'UNDERCUT', title: 'Slide and lifter regions' },
  { id: 'flow',      label: 'FLOW',     title: 'Flow length L/T — needs a gate' },
];

/* Build a per-triangle RGB buffer for the requested mode. */
export function computeHeatColours(analysis, mode) {
  const { triCount, triDraft, triThickness, triSinkRisk, triUndercut, triPullDot, minDraft, material, moldType } = analysis;
  const triRGB = new Float32Array(triCount * 3);
  const P = DFM_PALETTE;
  const paint = (t, c) => { triRGB[t * 3] = c[0]; triRGB[t * 3 + 1] = c[1]; triRGB[t * 3 + 2] = c[2]; };

  if (mode === 'draft') {
    /* Faces perpendicular to pull are not draft surfaces at all. For a
       two-piece mould a sidewall releases from whichever half suits it, so
       the magnitude of draft is what matters; for single-pull the sign does
       too, and a negative value is a genuine undercut. */
    const isTwoPiece = moldType !== 'single-pull';
    for (let t = 0; t < triCount; t++) {
      if (Math.abs(triPullDot[t]) > 0.85) { paint(t, P.NEUTRAL.rgb); continue; }
      const raw = triDraft[t];
      const d = isTwoPiece ? Math.abs(raw) : raw;
      if (!isTwoPiece && raw < -0.1)  paint(t, P.CRITICAL.rgb);
      else if (d < minDraft * 0.5)    paint(t, P.BAD.rgb);
      else if (d < minDraft)          paint(t, P.WARN.rgb);
      else if (d < minDraft + 0.5)    paint(t, P.CAUTION.rgb);
      else                            paint(t, P.OK.rgb);
    }
  } else if (mode === 'thickness') {
    const lo = material.wallLo, hi = material.wallHi;
    for (let t = 0; t < triCount; t++) {
      const th = triThickness[t];
      if (isNaN(th))           { paint(t, P.NEUTRAL.rgb); continue; }
      if (th < lo * 0.5)        paint(t, P.THIN.rgb);
      else if (th < lo)         paint(t, P.CAUTION.rgb);
      else if (th <= hi)        paint(t, P.OK.rgb);
      else if (th <= hi * 1.5)  paint(t, P.WARN.rgb);
      else if (th <= hi * 2.0)  paint(t, P.BAD.rgb);
      else                      paint(t, P.CRITICAL.rgb);
    }
  } else if (mode === 'sink') {
    for (let t = 0; t < triCount; t++) {
      const s = triSinkRisk[t];
      if (s <= 0)       paint(t, P.NEUTRAL.rgb);
      else if (s < 0.2) paint(t, P.CAUTION.rgb);
      else if (s < 0.5) paint(t, P.WARN.rgb);
      else if (s < 0.8) paint(t, P.BAD.rgb);
      else              paint(t, P.CRITICAL.rgb);
    }
  } else if (mode === 'undercut') {
    for (let t = 0; t < triCount; t++) {
      const u = triUndercut[t];
      if (u === 0)      paint(t, P.NEUTRAL.rgb);
      else if (u === 1) paint(t, P.SLIDE.rgb);
      else              paint(t, P.LIFTER.rgb);
    }
  } else if (mode === 'flow') {
    const fa = analysis.flowAnalysis;
    for (let t = 0; t < triCount; t++) {
      if (!fa) { paint(t, P.NEUTRAL.rgb); continue; }
      const lt = fa.triLT[t];
      if (isNaN(lt))               paint(t, P.NEUTRAL.rgb);
      else if (lt < fa.ltMax * 0.5) paint(t, P.OK.rgb);
      else if (lt < fa.ltMax * 0.8) paint(t, P.CAUTION.rgb);
      else if (lt < fa.ltMax)       paint(t, P.WARN.rgb);
      else if (lt < fa.ltMax * 1.5) paint(t, P.BAD.rgb);
      else                          paint(t, P.CRITICAL.rgb);
    }
  }
  return triRGB;
}

/* Interface thickness colouring for the shot-2 mesh. */
export function computeInterfaceColours(shot2, iface, mat2) {
  const P = DFM_PALETTE;
  const triRGB = new Float32Array(shot2.triCount * 3);
  const paint = (t, c) => { triRGB[t * 3] = c[0]; triRGB[t * 3 + 1] = c[1]; triRGB[t * 3 + 2] = c[2]; };
  for (let t = 0; t < shot2.triCount; t++) {
    if (!iface.interfaceTris[t]) { paint(t, P.NEUTRAL.rgb); continue; }
    const th = iface.thicknesses[t];
    if (isNaN(th))                  paint(t, P.NEUTRAL.rgb);
    else if (th < mat2.wallLo * 0.5) paint(t, P.BAD.rgb);
    else if (th < mat2.wallLo)       paint(t, P.WARN.rgb);
    else if (th < mat2.wallLo * 1.5) paint(t, P.CAUTION.rgb);
    else                             paint(t, P.OK.rgb);
  }
  return triRGB;
}

/* Legend rows describing what the current mode's colours mean. */
export function buildLegend(mode, analysis) {
  const P = DFM_PALETTE;
  const A = analysis || {};
  const rows = [];
  const add = (entry, label, value) => rows.push([entry, label, value || '']);
  let title = '';

  if (mode === 'draft') {
    const d = A.minDraft != null ? A.minDraft : 1.0;
    title = 'Draft angle';
    add(P.OK, 'Ample margin', `> ${(d + 1).toFixed(1)}°`);
    add(P.CAUTION, 'Low margin', `${d.toFixed(1)}–${(d + 1).toFixed(1)}°`);
    add(P.WARN, 'At minimum', `≈ ${d.toFixed(1)}°`);
    add(P.BAD, 'Under minimum', `0–${d.toFixed(1)}°`);
    add(P.CRITICAL, 'Undercut', '< 0°');
    add(P.NEUTRAL, 'Top / bottom', '⊥ pull');
  } else if (mode === 'thickness') {
    const lo = A.material ? A.material.wallLo : 1.0;
    const hi = A.material ? A.material.wallHi : 4.0;
    title = 'Wall thickness';
    add(P.THIN, 'Very thin', `< ${(lo * 0.5).toFixed(1)}`);
    add(P.CAUTION, 'Thin', `${(lo * 0.5).toFixed(1)}–${lo.toFixed(1)}`);
    add(P.OK, 'In spec', `${lo.toFixed(1)}–${hi.toFixed(1)} mm`);
    add(P.WARN, 'Thick', `${hi.toFixed(1)}–${(hi * 1.5).toFixed(1)}`);
    add(P.BAD, 'Very thick', `> ${(hi * 1.5).toFixed(1)}`);
    add(P.CRITICAL, 'Severely thick', `> ${(hi * 2).toFixed(1)} mm`);
  } else if (mode === 'sink') {
    title = `Sink risk (nom. ${A.nominalWall ? A.nominalWall.toFixed(1) : '—'} mm)`;
    add(P.NEUTRAL, 'No risk', '< 1.6× wall');
    add(P.CAUTION, 'Slight', '1.6–2.0×');
    add(P.WARN, 'Moderate', '2.0–2.5×');
    add(P.BAD, 'Severe', '2.5–3.0×');
    add(P.CRITICAL, 'Critical', '> 3.0× wall');
  } else if (mode === 'undercut') {
    title = `Undercuts (pull ${formatPullAxis(A.pullAxis, A.pullDir)})`;
    add(P.NEUTRAL, 'Pulls straight', '');
    add(P.SLIDE, 'Slide region', 'external');
    add(P.LIFTER, 'Lifter region', 'internal');
  } else if (mode === 'flow') {
    title = `Flow length (L/T max ${A.material ? A.material.ltMax : 0})`;
    add(P.OK, 'Comfortable', '< 50%');
    add(P.CAUTION, 'Moderate', '50–80%');
    add(P.WARN, 'Near limit', '80–100%');
    add(P.BAD, 'Over limit', '> 100%');
    add(P.CRITICAL, 'Far over', '> 150%');
  } else {
    return null;
  }

  return el('div', {}, [
    el('div', { class: 'legend-title', text: title }),
    ...rows.map(([entry, label, value]) => el('div', { class: 'legend-row' }, [
      el('span', { class: 'legend-swatch', style: `background:${entry.hex}` }),
      el('span', { class: 'legend-val', text: value }),
      el('span', { text: label }),
    ])),
  ]);
}
