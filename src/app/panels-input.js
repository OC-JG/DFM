import { MATERIALS, MATERIAL_ORDER, fpcCompatibility } from '../core/materials.js';
import { SURFACE_FINISHES, FINISH_GROUPS, finishMaterialCheck, effectiveMinDraft } from '../core/finishes.js';
import { getTwoShotCompat } from '../core/twoshot-compat.js';
import { computeBounds } from '../geometry/weld.js';
import { settings, runtime, updateSettings, isTwoShot } from './state.js';
import { $, $$, el, esc, replaceChildren, formatBytes } from './dom.js';

/*
 * Input panel: form binding, live material feedback, body visibility and the
 * onboarding stepper.
 *
 * Collapsible sections are native <details> elements. The original animated
 * `max-height` in JS and needed a `refreshSection()` call after any content
 * change to re-measure — which was easy to forget, and did forget, leaving
 * sections clipped once the material grid grew. <details> costs nothing, is
 * keyboard operable, and cannot get out of sync with its own contents.
 */

/* id → [settings key, coercion]. Drives both directions of the binding. */
const FIELD_BINDINGS = [
  ['analysisMode', 'analysisMode', String],
  ['material', 'material', String],
  ['material2', 'material2', String],
  ['windowType', 'windowType', String],
  ['surfaceFinish', 'surfaceFinish', String],
  ['moldType', 'moldType', String],
  ['wallThk', 'wallThk', Number],
  ['wallMin', 'wallMin', Number],
  ['wallMax', 'wallMax', Number],
  ['draftAngle', 'draftAngle', Number],
  ['ribThk', 'ribThk', Number],
  ['ribH', 'ribH', Number],
  ['ribRadius', 'ribRadius', Number],
  ['bossOD', 'bossOD', Number],
  ['bossWall', 'bossWall', Number],
  ['hasUndercut', 'hasUndercut', String],
  ['fpcEnabled', 'fpcEnabled', Boolean],
  ['fpcThickness', 'fpcThickness', Number],
  ['fpcCover', 'fpcCover', Number],
  ['fpcAnchors', 'fpcAnchors', String],
];

const CHECK_IDS = ['wall', 'draft', 'ribs', 'undercut', 'sink', 'warp', 'transitions', 'flow', 'fpc'];

// ── option population ──────────────────────────────────────────────────────

export function populateSelects() {
  for (const id of ['material', 'material2']) {
    const sel = $(id);
    replaceChildren(sel, MATERIAL_ORDER.map((key) =>
      el('option', { value: key, text: MATERIALS[key].name })));
  }
  replaceChildren($('surfaceFinish'), FINISH_GROUPS.map((group) =>
    el('optgroup', { label: group.label }, group.keys.map((key, i) =>
      el('option', { value: key, text: group.labels[i] })))));
}

// ── form binding ───────────────────────────────────────────────────────────

export function syncFormFromSettings() {
  for (const [id, key, coerce] of FIELD_BINDINGS) {
    const node = $(id);
    if (!node) continue;
    if (coerce === Boolean) node.checked = !!settings[key];
    else node.value = settings[key];
  }
  for (const id of CHECK_IDS) {
    const node = $(`chk_${id}`);
    if (node) node.checked = !!settings.checks[id];
  }
  setAxisButtons(runtime.pullDir.mode === 'axis' ? runtime.pullDir.value : null);
}

export function bindForm(onChange) {
  for (const [id, key, coerce] of FIELD_BINDINGS) {
    const node = $(id);
    if (!node) continue;
    const event = node.tagName === 'SELECT' || node.type === 'checkbox' ? 'change' : 'input';
    node.addEventListener(event, () => {
      const raw = coerce === Boolean ? node.checked : node.value;
      let value = coerce === Number ? Number(raw) : raw;
      /* An emptied numeric field should not silently become zero and start
         producing divide-by-zero ratios in the rules. */
      if (coerce === Number && !Number.isFinite(value)) return;
      updateSettings({ [key]: value }, `field:${key}`);
      if (key === 'material') runtime.materialChosen = true;
      onChange(key);
    });
  }

  for (const id of CHECK_IDS) {
    const node = $(`chk_${id}`);
    if (!node) continue;
    node.addEventListener('change', () => {
      updateSettings({ checks: { [id]: node.checked } }, `check:${id}`);
      onChange(`check:${id}`);
    });
  }
}

// ── live material feedback ─────────────────────────────────────────────────

export function updateMaterialInfo() {
  const m = MATERIALS[settings.material];
  const finishKey = settings.surfaceFinish;
  const eff = effectiveMinDraft(m, finishKey);
  const effStr = eff > m.draftMin ? `${m.draftMin}°→${eff.toFixed(1)}°` : `${m.draftMin}°`;

  const cell = (label, value, cls = '', span = false) => el('div', {
    class: 'mat-cell', style: span ? 'grid-column:span 3;' : null,
  }, [
    el('span', { class: 'mat-label', text: label }),
    el('br'),
    el('span', { class: `mat-value ${cls}`.trim(), text: value }),
  ]);

  const cells = [
    cell('Shrinkage', `${m.shrinkLo}–${m.shrinkHi}%`),
    cell('Wall range', `${m.wallLo}–${m.wallHi}mm`),
    cell('Draft min', effStr),
    cell('Melt', `${m.meltC}°C`, 'accent'),
    cell('Warp', m.warpRisk.toUpperCase(), m.warpRisk === 'high' ? 'warn' : m.warpRisk === 'low' ? 'ok' : ''),
    cell('Structure', m.crystalline ? 'Semi-cryst.' : 'Amorphous', m.crystalline ? 'warn' : 'ok'),
    cell('L/T max', String(m.ltMax)),
  ];

  if (settings.fpcEnabled) {
    const compat = fpcCompatibility(m);
    const cls = compat === 'safe' ? 'ok' : compat === 'caution' ? 'warn' : 'fail';
    const label = compat === 'safe' ? '✓ FPC safe' : compat === 'caution' ? '⚠ FPC caution' : '✗ FPC unsafe';
    cells.push(cell('Overmould', label, cls, true));
  }

  const finishCompat = finishMaterialCheck(finishKey, settings.material);
  const finishName = SURFACE_FINISHES[finishKey] ? SURFACE_FINISHES[finishKey].name : finishKey;
  if (finishCompat === 'no') {
    cells.push(cell('Finish warning', `✗ ${finishName} not achievable with ${m.name}`, 'fail', true));
  } else if (finishCompat === 'caution') {
    cells.push(cell('Finish warning', `⚠ ${finishName} marginal with ${m.name} — confirm with moulder`, 'warn', true));
  }

  if (m.optical) {
    cells.push(el('div', { class: 'mat-cell', style: 'grid-column:span 3;' }, [
      el('span', { class: 'mat-label', text: 'Optical' }), el('br'),
      el('span', { class: 'mat-value ok', text: '✓ IR + visible transparent' }), el('br'),
      el('span', { class: 'mat-note', text: m.optNote || '' }),
    ]));
  }

  replaceChildren($('materialInfo'), cells);
}

export function updateCompatBadge() {
  const badge = $('compatBadge');
  if (!isTwoShot()) { badge.hidden = true; return; }

  const c = getTwoShotCompat(settings.material, settings.material2);
  const colour = {
    chemical: 'var(--ok)',
    mechanical: '#d97706',
    primer: '#e8821a',
    incompatible: 'var(--fail)',
  }[c.adhesion] || 'var(--accent)';
  const label = {
    chemical: '✓ Chemical bond',
    mechanical: '⚠ Mechanical only',
    primer: '⚠ Primer needed',
    incompatible: '✗ Incompatible',
    unknown: '? Unknown pair',
  }[c.adhesion] || '?';

  badge.hidden = false;
  badge.style.borderLeftColor = colour;
  replaceChildren(badge, [
    el('span', { style: `color:${colour};font-weight:700;`, text: label }),
    el('br'),
    el('span', { class: 'muted', text: `${c.notes.split('.')[0]}.` }),
  ]);
}

export function updateOpticalNote() {
  const note = $('opticalNote');
  const val = settings.windowType;
  if (!isTwoShot() || val === 'none') { note.hidden = true; return; }

  const m2 = MATERIALS[settings.material2];
  const lines = [];

  if (val === 'ir') {
    lines.push('<b>IR window (850–940 nm)</b> — overmould wall target: <b>0.8–1.5 mm</b> (thicker sections attenuate near-IR significantly).');
    lines.push(m2.irTransparent
      ? `<span class="ok-text">✓ ${esc(m2.name)} natural grade is IR transparent. Specify no TiO₂, no carbon black on BOM.</span>`
      : '<span class="fail-text">⚠ Standard pigmented grades block near-IR. Specify: no carbon black, no TiO₂. Use natural/unpigmented grade — <b>ASA natural</b> recommended.</span>');
    lines.push('Weld lines within the IR field will cause localised attenuation — gate outside the active aperture. Tool finish on IR face: <b>SPI B-1 minimum</b>.');
  } else {
    lines.push('<b>Optical / indicator window</b> — visible LED + diffuse IR. Target wall: <b>1.0–2.0 mm</b>.');
    lines.push(m2.optical
      ? `<span class="ok-text">✓ ${esc(m2.name)} is suitable for an optical window.</span>`
      : '<span class="warn-text">⚠ Standard opaque grade selected. For visible light transmission use: ASA natural, clear/natural TPU, or PMMA. Avoid TiO₂ white pigment (IR-blocking).</span>');
    lines.push('Inner mould face: <b>VDI 18</b> or <b>SPI C-1</b> for diffusion. Outer cosmetic face: <b>SPI B-1</b>. Gate at window perimeter — keep weld lines outside the lit area.');
    if (m2.uvStable === false) {
      lines.push(`<span class="warn-text">⚠ Check UV stability of ${esc(m2.name)} if window faces exterior. Specify UV-stabilised grade.</span>`);
    }
  }

  note.innerHTML = lines.join('<br>');
  note.hidden = false;
}

export function updateFpcInfo() {
  const enabled = settings.fpcEnabled;
  $('fpcOptions').hidden = !enabled;
  if (!enabled) return;

  const m = MATERIALS[settings.material];
  const compat = fpcCompatibility(m);
  const effectiveMinWall = settings.fpcThickness + 2 * settings.fpcCover;

  const msg = {
    safe: `${m.name} at ${m.meltC}°C is below the 220°C threshold — safe for direct FPC overmoulding.`,
    caution: `${m.name} melts at ${m.meltC}°C. Marginal for FPC: keep barrel temperature at the low end of the process window and verify FPC adhesive rating ≥240°C.`,
    risk: `${m.name} melts at ${m.meltC}°C — high risk for FPC delamination. Specialist tooling (low-pressure overmoulding, short contact time) needed.`,
    unsafe: `${m.name} melts at ${m.meltC}°C, above the 270°C ceiling. Standard FPC adhesives & Kapton ratings will not survive. Switch to a lower-melt material (TPU, LDPE, PP, low-temp PA).`,
  }[compat];

  $('fpcInfo').innerHTML =
    `${esc(msg)} Effective min wall over FPC: <b>${effectiveMinWall.toFixed(2)} mm</b> (${settings.fpcThickness.toFixed(2)} FPC + 2×${settings.fpcCover.toFixed(2)} cover).`;
}

export function updateTwoShotUI() {
  const ts = isTwoShot();
  /* These carry the `hidden` attribute in the markup, and the stylesheet
     enforces it with !important so a hidden .field cannot leak back as a
     grid. Toggling `hidden` is therefore the only thing that works —
     assigning style.display loses to the !important rule. */
  $('shot2Zone').hidden = !ts;
  $('mat2Field').hidden = !ts;
  $('opticalWindowField').hidden = !ts;
  $('shot1Label').textContent = ts ? 'Shot 1 (substrate)' : 'Part';
  $('mat1Label').textContent = ts ? 'Shot 1 material' : 'Polymer';
  $('modeHint').hidden = ts;
  updateCompatBadge();
  updateOpticalNote();
}

// ── pull-axis buttons ──────────────────────────────────────────────────────

export function setAxisButtons(activeAxis) {
  for (const btn of $$('.axis-btn')) {
    const on = btn.dataset.axis === activeAxis;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

export function updatePullDirInfo(extraNote) {
  const v = runtime.pullDir.vec;
  const label = runtime.pullDir.mode === 'axis' ? runtime.pullDir.value.toUpperCase() : 'custom';
  const parts = [
    `Pull <b>${esc(label)}</b> <span class="muted">(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})</span>`,
  ];
  if (extraNote) parts.push(`<span class="accent-text">Auto: ${esc(extraNote)}</span>`);
  $('pullDirInfo').innerHTML = parts.join('<br>');
}

// ── file info ──────────────────────────────────────────────────────────────

export function setFileInfo(which, file, geom) {
  const node = $(which === 1 ? 'fileInfo' : 'fileInfo2');
  node.classList.add('show');
  node.innerHTML = geom
    ? `<b>${esc(file.name)}</b><br>${formatBytes(file.size)} · ${geom.triCount.toLocaleString()} tris · ${geom.vertCount.toLocaleString()} verts`
    : `Loading <b>${esc(file.name)}</b>…`;
}

export function setFileError(which, message) {
  const node = $(which === 1 ? 'fileInfo' : 'fileInfo2');
  node.classList.add('show');
  node.innerHTML = `<span class="fail-text">${esc(message)}</span>`;
}

/*
 * Mesh health panel.
 *
 * Deliberately placed directly under the drop zone rather than with the
 * results: it describes the input, and it has to be read before the score is,
 * not after. Fixes that can be applied here are offered as buttons — the
 * alternative is telling someone their file is in inches and leaving them to
 * go and do something about it in CAD.
 */
export function renderMeshHealth(report, onFix) {
  const node = $('meshHealth');
  if (!report) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }
  node.hidden = false;

  const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
  const issues = [...report.issues].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

  const CONF_LABEL = {
    high: 'Mesh looks sound',
    reduced: 'Analysable, with caveats',
    unusable: 'Fix this before trusting the result',
  };

  const nodes = [
    el('div', { class: `mh-head ${report.confidence}` }, [
      el('span', { class: 'mh-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'mh-title', text: CONF_LABEL[report.confidence] || report.confidence }),
      el('span', {
        class: 'mh-dims',
        text: `${report.bbox.size.map((v) => v.toFixed(1)).join(' × ')} mm`,
      }),
    ]),
  ];

  for (const issue of issues) {
    const body = [
      el('div', { class: 'mh-issue-title', text: issue.title }),
      el('div', { class: 'mh-issue-detail', text: issue.detail }),
    ];
    const actionable = (issue.fixes || []).filter((f) => f.action);
    if (actionable.length) {
      body.push(el('div', { class: 'mh-fixes' }, actionable.map((f) => el('button', {
        type: 'button',
        class: 'btn secondary mh-fix-btn',
        text: f.label,
        onclick: () => onFix(f),
      }))));
    }
    nodes.push(el('div', { class: `mh-issue ${issue.level}` }, body));
  }

  if (!issues.length) {
    nodes.push(el('div', { class: 'mh-issue info' }, [
      el('div', {
        class: 'mh-issue-detail',
        text: `Closed, consistently wound, ${report.triCount.toLocaleString()} triangles, ${report.volume != null ? `${(report.volume / 1000).toFixed(1)} cm³` : 'volume unavailable'}.`,
      }),
    ]));
  }

  replaceChildren(node, nodes);
}

export function clearFileInfo() {
  for (const id of ['fileInfo', 'fileInfo2']) {
    const node = $(id);
    node.classList.remove('show');
    node.textContent = '';
  }
  renderMeshHealth(null, null);
}

// ── multi-body STEP selector ───────────────────────────────────────────────

export function renderBodiesList(bodies, onToggle) {
  const section = $('bodiesSection');
  if (!bodies || bodies.length < 2) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const rows = bodies.map((b, i) => {
    const swatch = b.color
      ? `rgb(${Math.round(b.color[0] * 255)},${Math.round(b.color[1] * 255)},${Math.round(b.color[2] * 255)})`
      : '#8a8f9a';
    return el('button', {
      type: 'button',
      class: `body-row${b.visible ? '' : ' hidden'}`,
      'aria-pressed': String(b.visible),
      title: b.name,
      onclick: () => onToggle(i),
    }, [
      el('span', { class: 'body-eye', 'aria-hidden': 'true', text: b.visible ? '●' : '○' }),
      el('span', { class: 'body-swatch', style: `background:${swatch}` }),
      el('span', { class: 'body-name', text: b.name }),
      el('span', { class: 'body-tris', text: b.triCount.toLocaleString() }),
    ]);
  });

  replaceChildren($('bodiesList'), rows);
  $('bodiesCount').textContent = `${bodies.filter((b) => b.visible).length} of ${bodies.length} visible`;
}

// ── part summary + onboarding ──────────────────────────────────────────────

export function updatePartSummary() {
  const strip = $('partSummary');
  const geom = runtime.geom1;
  if (!geom) { strip.classList.remove('show'); return; }

  const { size } = computeBounds(geom.vertices);
  const analysis = runtime.analysis;

  let volStr = '—';
  let meshNote = '';
  if (analysis && analysis.volume) {
    volStr = `${(analysis.volume / 1000).toFixed(1)}cm³`;
    /* A closed solid fills a few percent to about 40% of its bounding box.
       Near-zero means the surface did not close and the signed-volume sum
       cancelled out — worth flagging, since thickness rays rely on a solid. */
    const bb = analysis.bbox;
    const bbVol = (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]) * (bb.max[2] - bb.min[2]);
    if (bbVol > 0 && analysis.volume / bbVol < 0.001) meshNote = ' ⚠ mesh may be non-manifold';
  }
  const areaStr = analysis && analysis.area ? `${analysis.area.toFixed(0)}mm²` : '—';

  strip.innerHTML = `
    <b>${size.map((v) => v.toFixed(1)).join('×')} mm</b><span class="part-summary-sep">|</span>
    <span><b>${geom.triCount.toLocaleString()}</b> tris</span><span class="part-summary-sep">|</span>
    <span>Vol <b>${volStr}</b>${meshNote}</span><span class="part-summary-sep">|</span>
    <span>Area <b>${areaStr}</b></span>`;
  strip.classList.add('show');
}

export function updateOnboarding() {
  const steps = [$('onboardStep1'), $('onboardStep2'), $('onboardStep3')];
  if (steps.some((s) => !s)) return;
  for (const s of steps) s.classList.remove('active', 'done');

  if (!runtime.geom1) {
    steps[0].classList.add('active');
  } else if (!runtime.materialChosen) {
    steps[0].classList.add('done');
    steps[1].classList.add('active');
  } else {
    steps[0].classList.add('done');
    steps[1].classList.add('done');
    steps[2].classList.add('active');
  }
}

export function setFromMeshBadge(hasMesh) {
  $('fromMeshBadge').classList.toggle('show', hasMesh);
}
