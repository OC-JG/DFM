import { MATERIALS } from '../core/materials.js';
import { effectiveMinDraft } from '../core/finishes.js';
import { parseSTL } from '../geometry/stl.js';
import { parseSTEP } from '../geometry/step.js';
import { validateGeometry, rescaleGeometry, flipWinding } from '../geometry/validate.js';
import { suggestPullDirection } from '../analysis/mesh.js';
import { estimateShot } from '../analysis/shot.js';
import { computeBounds } from '../geometry/weld.js';
import { runDFM } from '../rules/engine.js';
import { runTwoShotDFM } from '../rules/twoshot.js';
import { buildExportJSON, downloadJSON } from '../export/json.js';
import { exportPDF } from '../export/pdf.js';
import { runAnalysis, initWorker } from './analysis-runner.js';
import { computeHeatColours, computeInterfaceColours, buildLegend, HEAT_MODES } from './heatmap.js';
import * as viewer from './viewer.js';
import * as panel from './panels-input.js';
import { renderResults, renderShot, renderTwoShotResults, hideTwoShotResults, clearResults } from './panels-results.js';
import { settings, runtime, loadSettings, resetSettings, resetRuntime, isTwoShot } from './state.js';
import { $, $$, el, toast, nextFrame } from './dom.js';

/* ══ status & progress ═══════════════════════════════════════════════════ */

function setStatus(text) { $('statusPill').textContent = text; }

function showProgress(label) {
  $('progressLabel').textContent = label;
  $('progressBar').style.width = '0%';
  $('progressOverlay').classList.add('show');
}
function updateProgress(pct, label) {
  $('progressBar').style.width = `${(pct * 100).toFixed(0)}%`;
  if (label) $('progressLabel').textContent = label;
}
function hideProgress(delay = 250) {
  setTimeout(() => $('progressOverlay').classList.remove('show'), delay);
}

/* ══ file loading ════════════════════════════════════════════════════════ */

const STEP_EXTS = new Set(['step', 'stp']);

async function parseGeometryFile(file, onProgress) {
  const ext = file.name.toLowerCase().split('.').pop();
  const buffer = await file.arrayBuffer();
  if (STEP_EXTS.has(ext)) {
    onProgress(0.02, 'Initialising');
    return { geom: await parseSTEP(buffer, onProgress), format: 'STEP' };
  }
  onProgress(0.2, 'Parsing STL');
  await nextFrame(); // let the overlay paint before the parse blocks
  return { geom: parseSTL(buffer, onProgress), format: 'STL' };
}

/*
 * Install a freshly loaded or freshly corrected part.
 *
 * Validation runs here rather than inside the analysis, because the things it
 * catches — wrong units, an open surface, inside-out normals — are properties
 * of the file, and the moment to raise them is when the file arrives, not
 * buried in a check three panels down after a score has already been shown.
 */
function installGeometry(geom, file) {
  runtime.geom1 = geom;
  runtime.validation = validateGeometry(geom);
  runtime.gateLocation = null;
  viewer.clearGateMarker();

  runtime.bodies = viewer.loadGeometry(geom);
  panel.renderBodiesList(runtime.bodies, toggleBody);
  if (file) panel.setFileInfo(1, file, geom);
  panel.renderMeshHealth(runtime.validation, applyMeshFix);
  panel.updatePartSummary();
  panel.updateOnboarding();

  $('viewerEmpty').style.display = 'none';
  $('gateInfo').innerHTML = 'No gate set. Flow length (L/T) check needs a gate.';

  autoSuggestPull();
  return runtime.validation;
}

/*
 * Apply one of the corrections the health panel offered. Both of them move the
 * geometry under everything downstream of it, so the analysis and the picked
 * gate are discarded rather than left describing the old mesh.
 */
function applyMeshFix(fix) {
  if (!runtime.geom1 || !fix || !fix.action) return;
  let next = null;
  let note = '';
  if (fix.action === 'scale' && fix.factor > 0) {
    next = rescaleGeometry(runtime.geom1, fix.factor);
    note = `Rescaled by ×${fix.factor}. Largest dimension is now ${Math.max(...validateGeometry(next).bbox.size).toFixed(1)} mm.`;
  } else if (fix.action === 'flip') {
    next = flipWinding(runtime.geom1);
    note = 'Normals flipped. Draft and undercuts will now be measured from the outside.';
  }
  if (!next) return;

  runtime.analysis = null;
  runtime.analysis2 = null;
  runtime.interface = null;
  runtime.dfm = null;
  runtime.twoShot = null;
  clearResults();
  installGeometry(next, null);
  refreshHeatAvailability();
  setHeatMode('flat');
  toast(`${note} Re-run the analysis.`, 'info', 6000);
  setStatus('GEOMETRY CORRECTED');
}

async function handleFile1(file) {
  panel.setFileInfo(1, file, null);
  setStatus(STEP_EXTS.has(file.name.toLowerCase().split('.').pop()) ? 'LOADING STEP' : 'PARSING STL');
  showProgress('Reading file');

  try {
    const { geom, format } = await parseGeometryFile(file, updateProgress);
    runtime.fileName1 = file.name;
    const report = installGeometry(geom, file);
    if (report.confidence === 'unusable') {
      toast(`${file.name} loaded, but the mesh needs attention before the numbers mean anything — see the panel under the drop zone.`, 'error', 9000);
    } else if (report.confidence === 'reduced') {
      toast(`${file.name} loaded with caveats — see the mesh panel under the drop zone.`, 'warn', 7000);
    }
    setStatus(`${format} LOADED`);
  } catch (err) {
    console.error(err);
    panel.setFileError(1, err.message);
    toast(`Could not load ${file.name}: ${err.message}`, 'error');
    setStatus('PARSE ERROR');
  } finally {
    hideProgress(0);
  }
}

async function handleFile2(file) {
  panel.setFileInfo(2, file, null);
  showProgress('Reading overmould');
  try {
    /* The original called isBinarySTL/parseSTLBinary/parseSTLAscii here —
       none of which existed — so dropping an STL as shot 2 always threw
       "isBinarySTL is not defined". Shot 2 now goes through exactly the same
       parser as shot 1. */
    const { geom } = await parseGeometryFile(file, updateProgress);
    runtime.geom2 = geom;
    runtime.fileName2 = file.name;
    runtime.validation2 = validateGeometry(geom);
    viewer.loadGeometry2(geom);
    panel.setFileInfo(2, file, geom);
    /* The overmould gets the same scrutiny, but reported as a toast rather
       than a second panel: the interface pass measures shot 2 against shot 1,
       so a bad shot-2 mesh corrupts the two-shot result just as thoroughly. */
    if (runtime.validation2.confidence !== 'high') {
      const worst = runtime.validation2.issues.find((i) => i.level === 'error')
        || runtime.validation2.issues.find((i) => i.level === 'warn');
      if (worst) toast(`Overmould mesh: ${worst.title.toLowerCase()}. ${worst.detail}`, runtime.validation2.confidence === 'unusable' ? 'error' : 'warn', 8000);
    }
  } catch (err) {
    console.error(err);
    panel.setFileError(2, err.message);
    toast(`Could not load ${file.name}: ${err.message}`, 'error');
  } finally {
    hideProgress(0);
  }
}

function wireDropZone(zoneId, inputId, handler) {
  const zone = $(zoneId);
  const input = $(inputId);
  const open = () => input.click();

  zone.addEventListener('click', open);
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handler(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', (e) => {
    if (e.target.files.length) handler(e.target.files[0]);
    input.value = ''; // allow re-selecting the same file
  });
}

/* ══ multi-body visibility ═══════════════════════════════════════════════ */

function toggleBody(i) {
  const bodies = runtime.bodies;
  if (!bodies || !bodies[i]) return;
  /* Hiding the last visible body would leave an empty viewport with no
     obvious way back. */
  if (bodies[i].visible && bodies.filter((b) => b.visible).length === 1) return;
  bodies[i].visible = !bodies[i].visible;
  panel.renderBodiesList(bodies, toggleBody);
  viewer.setBodyVisibility(bodies);
}

function setAllBodies(state) {
  const bodies = runtime.bodies;
  if (!bodies) return;
  bodies.forEach((b) => { b.visible = state; });
  if (!bodies.some((b) => b.visible)) bodies[0].visible = true;
  panel.renderBodiesList(bodies, toggleBody);
  viewer.setBodyVisibility(bodies);
}

function invertBodies() {
  const bodies = runtime.bodies;
  if (!bodies) return;
  bodies.forEach((b) => { b.visible = !b.visible; });
  if (!bodies.some((b) => b.visible)) bodies[0].visible = true;
  panel.renderBodiesList(bodies, toggleBody);
  viewer.setBodyVisibility(bodies);
}

/* ══ pull direction ══════════════════════════════════════════════════════ */

const AXIS_VECTORS = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
};

function setPullDir(mode, value, vec, note) {
  runtime.pullDir = { mode, value, vec };
  panel.setAxisButtons(mode === 'axis' ? value : null);
  panel.updatePullDirInfo(note);
  viewer.drawPullArrow(vec);
}

function autoSuggestPull() {
  if (!runtime.geom1) return;
  const sugg = suggestPullDirection(runtime.geom1);
  const named = Object.keys(AXIS_VECTORS).find((k) => {
    const v = AXIS_VECTORS[k];
    return v[0] === sugg.dir[0] && v[1] === sugg.dir[1] && v[2] === sugg.dir[2];
  });
  if (named) setPullDir('axis', named, sugg.dir, sugg.reason);
  else setPullDir('custom', null, sugg.dir, sugg.reason);
}

/* ══ picking ═════════════════════════════════════════════════════════════ */

function setPickButton(id, active, activeLabel, idleLabel) {
  const btn = $(id);
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', String(active));
  btn.textContent = active ? activeLabel : idleLabel;
}

function refreshPickButtons() {
  const mode = viewer.getPickMode();
  setPickButton('pickFaceBtn', mode === 'face', '× Cancel pick', '⊕ Pick face');
  setPickButton('pickGateBtn', mode === 'gate', '× Cancel pick', '⊕ Pick gate');
}

function togglePick(which) {
  if (!runtime.geom1) { toast('Load a part first.', 'warn'); return; }
  viewer.setPickMode(viewer.getPickMode() === which ? null : which);
  refreshPickButtons();
  if (viewer.getPickMode() === 'gate') {
    $('gateInfo').innerHTML = '<b class="accent-text">Click anywhere on the part to place the gate.</b>';
  }
}

function onViewerPick(kind, data) {
  if (kind === 'face') {
    setPullDir('custom', null, data.normal);
  } else if (kind === 'gate') {
    runtime.gateLocation = data.local;
    const diag = computeBounds(runtime.geom1.vertices).diag;
    viewer.setGateMarker(data.world, diag);
    const [x, y, z] = data.local;
    $('gateInfo').innerHTML =
      `Gate set at <b>(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})</b>. Re-run analysis to compute flow length.`;
  }
  viewer.setPickMode(null);
  refreshPickButtons();
}

function clearGate() {
  runtime.gateLocation = null;
  viewer.clearGateMarker();
  $('gateInfo').innerHTML =
    'Click <b>Pick gate</b>, then click any point on the 3D part. A red dot will mark the gate. Required for flow length (L/T) check.';
}

/* ══ heat modes ══════════════════════════════════════════════════════════ */

function buildHeatControl() {
  const host = $('heatModes');
  host.replaceChildren(...HEAT_MODES.map((m) => el('button', {
    type: 'button',
    class: 'view-btn heat-btn',
    dataset: { heat: m.id },
    title: m.title,
    text: m.label,
    'aria-pressed': String(m.id === 'flat'),
    onclick: () => setHeatMode(m.id),
  })));
}

/*
 * The heat modes are a segmented control rather than the original's single
 * button that cycled blindly through six states. Cycling meant the only way
 * to reach UNDERCUT was to press five times and read the label each time,
 * with no indication of what else was available.
 */
function setHeatMode(mode) {
  const analysis = runtime.analysis;
  if (!analysis && mode !== 'flat') {
    toast('Run an analysis first to see heatmaps.', 'warn');
    return;
  }
  if (mode === 'flow' && analysis && !analysis.flowAnalysis) {
    toast('Pick a gate and re-run to see flow length.', 'warn');
    return;
  }

  runtime.heatMode = mode;
  for (const btn of $$('.heat-btn')) {
    const on = btn.dataset.heat === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  const legend = $('viewerLegend');
  if (mode === 'flat') {
    viewer.applyFlatColour();
    legend.style.display = 'none';
    legend.replaceChildren();
    return;
  }

  viewer.applyTriangleColours(computeHeatColours(analysis, mode));
  const legendNode = buildLegend(mode, analysis);
  legend.replaceChildren(legendNode || document.createTextNode(''));
  legend.style.display = legendNode ? '' : 'none';
}

function refreshHeatAvailability() {
  const analysis = runtime.analysis;
  for (const btn of $$('.heat-btn')) {
    const id = btn.dataset.heat;
    const unavailable = (id !== 'flat' && !analysis)
      || (id === 'flow' && analysis && !analysis.flowAnalysis);
    btn.classList.toggle('unavailable', !!unavailable);
  }
}

/* ══ analysis run ════════════════════════════════════════════════════════ */

function buildRuleInput() {
  return {
    wallThk: settings.wallThk,
    wallMin: settings.wallMin,
    wallMax: settings.wallMax,
    draftAngle: settings.draftAngle,
    ribThk: settings.ribThk,
    ribH: settings.ribH,
    ribRadius: settings.ribRadius,
    bossOD: settings.bossOD,
    bossWall: settings.bossWall,
    hasUndercut: settings.hasUndercut,
    material: settings.material,
    surfaceFinish: settings.surfaceFinish,
    moldType: settings.moldType,
    fpc: {
      enabled: settings.fpcEnabled,
      thickness: settings.fpcThickness,
      cover: settings.fpcCover,
      anchors: settings.fpcAnchors,
    },
    runChecks: { ...settings.checks },
    mesh: null,
  };
}

/* Options for analyseMesh, with each shot getting its own material. The
   original analysed shot 2 with shot 1's material because it read the
   material straight from the DOM. */
function meshOptionsFor(materialKey) {
  const material = MATERIALS[materialKey];
  return {
    material,
    finishKey: settings.surfaceFinish,
    moldType: settings.moldType,
    minDraft: effectiveMinDraft(material, settings.surfaceFinish),
    manualWall: settings.wallThk,
    pullDir: runtime.pullDir.vec,
    pullAxis: runtime.pullDir.mode === 'axis' ? runtime.pullDir.value : '+z',
  };
}

async function doRunAnalysis() {
  const runBtn = $('runBtn');
  runBtn.disabled = true;
  setStatus('ANALYSING');
  $('resultStatus').textContent = 'running';
  showProgress('Preparing');

  try {
    const input = buildRuleInput();
    const twoShotReady = isTwoShot() && runtime.geom2;

    if (runtime.geom1) {
      const job = {
        geom1: runtime.geom1,
        opts1: { ...meshOptionsFor(settings.material), gateLocation: runtime.gateLocation },
        geom2: twoShotReady ? runtime.geom2 : null,
        opts2: twoShotReady ? meshOptionsFor(settings.material2) : null,
        /* 20 mm search distance is generous enough to catch even thick
           overmould layers without wandering across the part. */
        interfaceMaxDist: 20,
      };
      const { shot1, shot2, iface } = await runAnalysis(job, updateProgress);
      runtime.analysis = shot1;
      runtime.analysis2 = shot2;
      runtime.interface = iface;
      input.mesh = shot1;
    } else {
      runtime.analysis = null;
      runtime.analysis2 = null;
      runtime.interface = null;
    }

    updateProgress(1, 'Scoring');
    const result = runDFM(input);
    runtime.dfm = { input, result };

    renderResults(result, runtime.analysis);

    /* Shot weight and clamp force. Volume is only passed through when the
       validator judged the surface closed — an enclosed volume is undefined
       otherwise, and a shot weight derived from one would be invented. */
    runtime.shot = runtime.analysis
      ? estimateShot({
        material: MATERIALS[settings.material],
        volume: (runtime.validation && runtime.validation.volume != null)
          ? runtime.validation.volume
          : null,
        projectedArea: runtime.analysis.projectedArea,
      })
      : null;
    renderShot(runtime.shot);

    panel.setFromMeshBadge(!!runtime.analysis);
    panel.updatePartSummary();

    if (twoShotReady && runtime.analysis2) {
      runtime.twoShot = runTwoShotDFM({
        mat1: settings.material,
        mat2: settings.material2,
        interface: runtime.interface,
        opticalWindow: settings.windowType,
      });
      renderTwoShotResults(runtime.twoShot);
      viewer.applyOvermouldColours(
        runtime.geom2,
        computeInterfaceColours(runtime.analysis2, runtime.interface, MATERIALS[settings.material2]),
      );
    } else {
      runtime.twoShot = null;
      hideTwoShotResults();
    }

    /* Keep the current heat mode meaningful across re-runs. */
    refreshHeatAvailability();
    if (runtime.heatMode !== 'flat' && runtime.analysis) setHeatMode(runtime.heatMode);

    runtime.runCount++;
    $('runCount').textContent = String(runtime.runCount).padStart(3, '0');
    $('footerTick').textContent =
      '●'.repeat(Math.min(5, runtime.runCount)) + '○'.repeat(Math.max(0, 5 - runtime.runCount));
    setStatus('COMPLETE');
    $('resultStatus').textContent = 'complete';
  } catch (err) {
    console.error(err);
    toast(`Analysis failed: ${err.message}`, 'error');
    setStatus('ANALYSIS ERROR');
    $('resultStatus').textContent = 'error';
  } finally {
    runBtn.disabled = false;
    hideProgress();
  }
}

/* ══ exports ═════════════════════════════════════════════════════════════ */

function doExportJSON() {
  if (!runtime.dfm) return;
  const data = buildExportJSON({
    sessionId: runtime.sessionId,
    dfm: runtime.dfm,
    analysis: runtime.analysis,
    twoShot: runtime.twoShot,
    interface: runtime.interface,
    validation: runtime.validation,
    shot: runtime.shot,
    settings,
  });
  downloadJSON(data, `dfm_${runtime.sessionId}_${Date.now()}.json`);
}

async function doExportPDF() {
  if (!runtime.dfm) return;
  const btn = $('pdfBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Building PDF…';
  try {
    await exportPDF({
      sessionId: runtime.sessionId,
      dfm: runtime.dfm,
      analysis: runtime.analysis,
      twoShot: runtime.twoShot,
      validation: runtime.validation,
      shot: runtime.shot,
      settings,
    });
  } catch (err) {
    console.error(err);
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ══ reset ═══════════════════════════════════════════════════════════════ */

function startOver() {
  resetRuntime();
  resetSettings();
  viewer.clearGeometry();
  viewer.setPickMode(null);
  clearResults();
  panel.populateSelects();
  panel.syncFormFromSettings();
  panel.clearFileInfo();
  panel.renderBodiesList(null, toggleBody);
  panel.setFromMeshBadge(false);
  panel.updatePartSummary();
  panel.updateOnboarding();
  refreshEverything();
  refreshPickButtons();
  clearGate();
  setHeatMode('flat');
  refreshHeatAvailability();
  $('viewerEmpty').style.display = '';
  const hint = $('viewerHint');
  if (hint) hint.style.display = '';
  $('runCount').textContent = '000';
  $('footerTick').textContent = '○○○○○';
  $('resultStatus').textContent = 'idle';
  setStatus('AWAITING INPUT');
  toast('Reset to defaults.', 'info', 3000);
}

/* ══ cross-cutting refresh ═══════════════════════════════════════════════ */

function refreshEverything() {
  panel.updateTwoShotUI();
  panel.updateMaterialInfo();
  panel.updateFpcInfo();
  panel.updateOnboarding();
  panel.updatePullDirInfo();
}

function onFieldChange(key) {
  if (key === 'analysisMode') panel.updateTwoShotUI();
  if (key === 'material' || key === 'material2' || key === 'surfaceFinish') {
    panel.updateMaterialInfo();
    panel.updateCompatBadge();
    panel.updateOpticalNote();
  }
  if (key === 'windowType' || key === 'material2') panel.updateOpticalNote();
  if (key.startsWith('fpc') || key === 'material') {
    panel.updateFpcInfo();
    panel.updateMaterialInfo();
  }
  if (key === 'material') panel.updateOnboarding();
}

/* ══ boot ════════════════════════════════════════════════════════════════ */

function checkDependencies() {
  if (typeof THREE !== 'undefined') return true;
  /* Without three.js there is no viewer and no point pretending otherwise.
     The original left a blank white panel and no explanation. */
  document.body.classList.add('deps-failed');
  const wrap = $('viewer');
  if (wrap) {
    wrap.replaceChildren(el('div', { class: 'dep-error' }, [
      el('h2', { text: '3D library unavailable' }),
      el('p', { text: 'This tool loads three.js from a CDN and could not reach it. Check your connection, then reload.' }),
      el('p', { class: 'muted', text: 'Material data and the manual-specification checks still work — you can run an analysis without a mesh.' }),
    ]));
  }
  return false;
}

function startClock() {
  const tick = () => {
    $('timestamp').textContent = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  };
  tick();
  setInterval(tick, 1000);
}

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const controls = viewer.getControls();
    if (!controls) return;

    if (e.key === 'f' || e.key === 'F') controls.frame();
    else if (e.key === '+' || e.key === '=') controls.zoomIn();
    else if (e.key === '-' || e.key === '_') controls.zoomOut();
    else if (e.key === 'r' || e.key === 'R') viewer.setView('iso');
    else if (e.key === 'Escape' && viewer.getPickMode()) { viewer.setPickMode(null); refreshPickButtons(); }
  });
}

function boot() {
  loadSettings();
  panel.populateSelects();
  panel.syncFormFromSettings();
  panel.bindForm(onFieldChange);

  $('sessionId').textContent = runtime.sessionId;
  startClock();

  const hasThree = checkDependencies();
  if (hasThree) {
    viewer.initViewer(onViewerPick);
    viewer.drawPullArrow(runtime.pullDir.vec);
  }

  buildHeatControl();
  refreshHeatAvailability();
  refreshEverything();

  wireDropZone('dropZone', 'fileInput', handleFile1);
  wireDropZone('dropZone2', 'fileInput2', handleFile2);

  $('bodiesAllBtn').addEventListener('click', () => setAllBodies(true));
  $('bodiesNoneBtn').addEventListener('click', () => setAllBodies(false));
  $('bodiesInvertBtn').addEventListener('click', invertBodies);

  for (const btn of $$('.axis-btn')) {
    btn.addEventListener('click', () => {
      const axis = btn.dataset.axis;
      setPullDir('axis', axis, AXIS_VECTORS[axis]);
    });
  }
  $('pickFaceBtn').addEventListener('click', () => togglePick('face'));
  $('pickGateBtn').addEventListener('click', () => togglePick('gate'));
  $('clearGateBtn').addEventListener('click', clearGate);
  $('autoPullBtn').addEventListener('click', () => {
    if (!runtime.geom1) { toast('Load a part first.', 'warn'); return; }
    autoSuggestPull();
  });

  for (const btn of $$('.view-btn[data-view]')) {
    btn.addEventListener('click', () => viewer.setView(btn.dataset.view));
  }
  $('frameBtn').addEventListener('click', () => {
    const c = viewer.getControls();
    if (c) c.frame();
  });

  const toolingToggle = $('toolingToggle');
  toolingToggle.addEventListener('click', () => {
    const open = toolingToggle.getAttribute('aria-expanded') !== 'true';
    toolingToggle.setAttribute('aria-expanded', String(open));
    $('toolingActions').style.display = open ? '' : 'none';
    $('toolingArrow').classList.toggle('open', open);
  });

  $('runBtn').addEventListener('click', doRunAnalysis);
  $('resetBtn').addEventListener('click', startOver);
  $('jsonBtn').addEventListener('click', doExportJSON);
  $('pdfBtn').addEventListener('click', doExportPDF);

  wireKeyboard();

  /* Surface the execution mode once, quietly, so a slow single-threaded run
     on file:// is explainable rather than mysterious. */
  if (initWorker()) {
    $('threadNote').textContent = 'worker';
    $('threadNote').title = 'Analysis runs on a background thread — the page stays responsive during a run.';
  } else {
    $('threadNote').textContent = 'single-thread';
    $('threadNote').title = 'Background workers are unavailable on file:// in this browser, so analysis runs on the main thread and the page pauses during a run. Serving this file over http:// enables the worker.';
  }

  setStatus('AWAITING INPUT');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
