import { MATERIALS } from '../core/materials.js';
import { buildLabel, BUILD_FINGERPRINT } from '../core/build-info.js';
import { createNavigatorLoop, NAVIGATOR_DEFAULTS } from './navigator.js';
import { hidAvailable, requestSpaceMouse, alreadyGrantedSpaceMouse, createHidSource } from './spacemouse.js';
import { effectiveMinDraft, SURFACE_FINISHES } from '../core/finishes.js';
import { parseSTL } from '../geometry/stl.js';
import { parseSTEP } from '../geometry/step.js';
import { openIptViaBridge, driveBridgeParameters, probeBridge, bridgeUrl, setBridgeUrl } from './bridge.js';
import { validateGeometry, rescaleGeometry, flipWinding } from '../geometry/validate.js';
import { suggestPullDirection } from '../analysis/mesh.js';
import { estimateShot } from '../analysis/shot.js';
import { estimateCycle, estimatePartCost, toolingDrivers } from '../analysis/cost.js';
import { computeBounds } from '../geometry/weld.js';
import { runDFM } from '../rules/engine.js';
import { runTwoShotDFM } from '../rules/twoshot.js';
import { compareRuns } from '../rules/compare.js';
import { buildExportJSON, downloadJSON } from '../export/json.js';
import { exportPDF } from '../export/pdf.js';
import { buildFindingsPackage, downloadPackage } from '../export/package.js';
import { runAnalysis, initWorker } from './analysis-runner.js';
import { computeHeatColours, computeInterfaceColours, buildLegend, HEAT_MODES } from './heatmap.js';
import * as viewer from './viewer.js';
import * as panel from './panels-input.js';
import { renderResults, renderShot, renderCost, renderComparison, renderTwoShotResults, hideTwoShotResults, clearResults } from './panels-results.js';
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

function fileExt(file) {
  return file.name.toLowerCase().split('.').pop();
}

/*
 * .ipt has no browser-side reader and will not get one, so it goes out to a
 * local Inventor over the bridge and comes back as STEP — which is a better
 * input than STL anyway, because it carries B-rep face groups. The part stays
 * open in Inventor afterwards, which is what makes `applyParameterChange`
 * below possible.
 */
async function parseGeometryFile(file, onProgress) {
  const ext = fileExt(file);

  if (ext === 'ipt') {
    const { buffer, model } = await openIptViaBridge(file, onProgress);
    onProgress(0.6, 'Tessellating B-rep');
    /* The bytes measured on this path are the STEP Inventor wrote, not the
       .ipt — so that is what the findings package carries, under a name that
       says what it is. A member called part.ipt holding STEP would be worse
       than either. */
    return {
      geom: await parseSTEP(buffer, onProgress),
      format: 'IPT',
      model,
      source: { name: `${file.name.replace(/\.ipt$/i, '')}.step`, bytes: new Uint8Array(buffer) },
    };
  }

  const buffer = await file.arrayBuffer();
  /* Kept so the findings package can carry the file the report was measured
     from. One copy of the bytes, which is the cost of not attaching last
     week's revision by hand. */
  const source = { name: file.name, bytes: new Uint8Array(buffer) };
  if (STEP_EXTS.has(ext)) {
    onProgress(0.02, 'Initialising');
    return { geom: await parseSTEP(buffer, onProgress), format: 'STEP', source };
  }
  onProgress(0.2, 'Parsing STL');
  await nextFrame(); // let the overlay paint before the parse blocks
  return { geom: parseSTL(buffer, onProgress), format: 'STL', source };
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
  /* Positions were searched on the old geometry and mean nothing on this one. */
  runtime.gateSuggestion = null;
  viewer.clearGateMarker();

  runtime.bodies = viewer.loadGeometry(geom);
  renderBodies();
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

/*
 * Change a driving parameter and re-measure.
 *
 * This is the loop the whole tool exists to close. A finding says a wall is too
 * thin; that wall is a named parameter in the part; changing it here rebuilds
 * in Inventor and brings back new geometry, so the next run measures the fix
 * rather than an intention to fix. Everything measured on the old mesh is
 * discarded for the same reason `applyMeshFix` discards it — the numbers
 * describe geometry that no longer exists.
 */
async function applyParameterChange(name, value) {
  if (!runtime.model) {
    toast('Parameters can only be driven on a part opened from .ipt.', 'warn');
    return;
  }
  setStatus('REBUILDING');
  showProgress('Rebuilding in Inventor');
  try {
    const previousScore = runtime.dfm && runtime.dfm.result ? runtime.dfm.result.score : null;
    const { buffer, model } = await driveBridgeParameters(
      runtime.model.document, [{ name, value }], updateProgress,
    );
    const geom = await parseSTEP(buffer, updateProgress);

    runtime.revisions.push({ name, value, scoreBefore: previousScore, at: Date.now() });
    runtime.analysis = null;
    runtime.analysis2 = null;
    runtime.interface = null;
    runtime.dfm = null;
    runtime.twoShot = null;
    runtime.shot = null;
    clearResults();

    runtime.model = model;
    installGeometry(geom, null);
    panel.renderModelTree(model, applyParameterChange);
    panel.renderRevisions(runtime.revisions);
    refreshHeatAvailability();
    setHeatMode('flat');
    toast(`${name} = ${value}. Inventor rebuilt the part — run the analysis again to see what moved.`, 'info', 7000);
    setStatus('PART REBUILT');
  } catch (err) {
    toast(err.message, 'error', 9000);
    setStatus('REBUILD FAILED');
  } finally {
    hideProgress();
  }
}

/*
 * Report whether a local Inventor is reachable, once, at boot.
 *
 * "Up" and "can read .ipt" are separate answers: the server runs perfectly
 * happily against its own simulator, which cannot open an Inventor file.
 * Collapsing the two would send someone hunting a network fault that is really
 * a missing --backend inventor.
 */
async function refreshBridgeStatus() {
  const node = $('bridgeStatus');
  const detail = $('bridgeDetail');
  node.dataset.state = 'checking';
  node.textContent = 'checking…';
  const health = await probeBridge();
  node.dataset.state = health.readsIpt ? 'live' : (health.up ? 'limited' : 'down');
  node.textContent = health.readsIpt ? `Inventor · ${bridgeUrl().replace(/^https?:\/\//, '')}`
    : health.up ? `simulator · no .ipt` : 'not connected';
  detail.textContent = health.note || 'Drop an .ipt and Inventor will open it.';
  $('iptHint').hidden = health.readsIpt;
  return health;
}

const LOAD_STATUS = { ipt: 'OPENING IN INVENTOR', step: 'LOADING STEP', stp: 'LOADING STEP' };

async function handleFile1(file) {
  panel.setFileInfo(1, file, null);
  setStatus(LOAD_STATUS[fileExt(file)] || 'PARSING STL');
  showProgress('Reading file');

  try {
    const { geom, format, model, source } = await parseGeometryFile(file, updateProgress);
    runtime.fileName1 = file.name;
    runtime.sourceFile = source || null;
    runtime.model = model || null;
    if (model) panel.renderModelTree(model, applyParameterChange);
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
  renderBodies();
  viewer.setBodyVisibility(bodies);
}

/*
 * Mark, or unmark, a body as the flex insert.
 *
 * Kept on the body rather than in `settings` because it is a fact about this
 * file: a body index means nothing once a different part is loaded, and
 * settings persist to localStorage.
 *
 * The designation changes what the FPC check measures, so the results on
 * screen were computed against the old one. Rather than silently re-scoring or
 * silently going stale, it says a re-run is needed — the same treatment a
 * changed material gets.
 */
function toggleBodyFpc(i) {
  const bodies = runtime.bodies;
  if (!bodies || !bodies[i]) return;
  bodies[i].isFpc = !bodies[i].isFpc;
  renderBodies();
  if (runtime.dfm) {
    toast(bodies[i].isFpc
      ? `${bodies[i].name} marked as the flex — run the analysis again to measure the cover over it`
      : `${bodies[i].name} unmarked — run the analysis again`);
  }
}

function renderBodies() {
  panel.renderBodiesList(runtime.bodies, toggleBody, toggleBodyFpc);
}

function setAllBodies(state) {
  const bodies = runtime.bodies;
  if (!bodies) return;
  bodies.forEach((b) => { b.visible = state; });
  if (!bodies.some((b) => b.visible)) bodies[0].visible = true;
  renderBodies();
  viewer.setBodyVisibility(bodies);
}

function invertBodies() {
  const bodies = runtime.bodies;
  if (!bodies) return;
  bodies.forEach((b) => { b.visible = !b.visible; });
  if (!bodies.some((b) => b.visible)) bodies[0].visible = true;
  renderBodies();
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
  /* Scored against the draft this part actually has to hold and the mould type
     selected, so the recommendation is judged by the same rules the report is. */
  const material = MATERIALS[settings.material];
  const sugg = suggestPullDirection(runtime.geom1, {
    minDraft: effectiveMinDraft(material, settings.surfaceFinish),
    moldType: settings.moldType,
  });
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
    refreshGateSuggestion();
  }
  viewer.setPickMode(null);
  refreshPickButtons();
}

function clearGate() {
  runtime.gateLocation = null;
  viewer.clearGateMarker();
  $('gateInfo').innerHTML =
    'Click <b>Pick gate</b>, then click any point on the 3D part. A red dot will mark the gate. Required for flow length (L/T) check.';
  refreshGateSuggestion();
}

/*
 * Offer the searched-for gate position, if there is one.
 *
 * The search only runs when no gate was set, so the button is live exactly
 * when it is useful: after an analysis that had nothing to compute flow from.
 */
function refreshGateSuggestion() {
  const btn = $('suggestGateBtn');
  if (!btn) return;
  const suggestion = runtime.gateSuggestion;
  const available = !!(suggestion && suggestion.best && !runtime.gateLocation);
  btn.disabled = !available;
  btn.title = available
    ? `Place the gate at the best of ${suggestion.considered} positions tried (worst-case L/T ${suggestion.best.maxLT.toFixed(0)})`
    : 'Run an analysis without a gate to search for the best position';
}

function useSuggestedGate() {
  const suggestion = runtime.gateSuggestion;
  if (!suggestion || !suggestion.best) return;
  const local = suggestion.best.point;
  runtime.gateLocation = local;
  const world = viewer.localToWorld(local);
  if (world) viewer.setGateMarker(world, computeBounds(runtime.geom1.vertices).diag);
  $('gateInfo').innerHTML =
    `Gate placed at the best of ${suggestion.considered} searched positions: <b>(${local.map((v) => v.toFixed(1)).join(', ')})</b>, `
    + `worst-case L/T <b>${suggestion.best.maxLT.toFixed(0)}</b>. Re-run analysis to score it.`;
  refreshGateSuggestion();
  setStatus('GATE PLACED');
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
    fpcRegion: null,
  };
}

/*
 * Triangle ranges of the bodies marked as the flex insert.
 *
 * Empty unless the FPC check is on and something is marked, which is what
 * keeps the located and the part-wide versions of that check from both
 * claiming to be in force.
 */
function fpcRegionRanges() {
  if (!settings.fpcEnabled || !settings.checks.fpc || !runtime.bodies) return null;
  const marked = runtime.bodies.filter((b) => b.isFpc);
  if (!marked.length) return null;
  return marked.map((b) => ({ triStart: b.triStart, triEnd: b.triEnd }));
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
        /* Triangle ranges of the bodies marked as the flex, if any. Sent as
           ranges rather than body objects: the worker needs the geometry, not
           the visibility state or the colour. */
        fpcRegion: fpcRegionRanges(),
        fpcCover: settings.fpcCover,
      };
      const { shot1, shot2, iface, registration, fpcRegion } = await runAnalysis(job, updateProgress);
      runtime.analysis = shot1;
      runtime.analysis2 = shot2;
      runtime.interface = iface;
      runtime.registration = registration;
      runtime.fpcRegion = fpcRegion;
      input.mesh = shot1;
      input.fpcRegion = fpcRegion;
    } else {
      runtime.analysis = null;
      runtime.analysis2 = null;
      runtime.interface = null;
      runtime.registration = null;
      runtime.fpcRegion = null;
    }

    updateProgress(1, 'Scoring');
    const result = runDFM(input);
    runtime.dfm = { input, result };

    renderResults(result, runtime.analysis);
    selectResultsTab('findings');

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

    refreshCostEstimates();

    /* The comparison on screen was against the previous run's numbers, which
       these have just replaced. */
    runtime.comparison = null;
    renderComparison(null);

    panel.setFromMeshBadge(!!runtime.analysis);
    panel.updatePartSummary();

    if (twoShotReady && runtime.analysis2) {
      runtime.twoShot = runTwoShotDFM({
        mat1: settings.material,
        mat2: settings.material2,
        interface: runtime.interface,
        registration: runtime.registration,
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

    /* The search only runs when there was no gate to compute flow from, so keep
       the last one it produced: it stays valid for as long as the geometry does,
       and clearing a gate should re-offer it rather than demand another run. */
    if (runtime.analysis && runtime.analysis.gateSuggestion) {
      runtime.gateSuggestion = runtime.analysis.gateSuggestion;
    }
    refreshGateSuggestion();

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

/* ══ results tabs ════════════════════════════════════════════════════════ */

/*
 * Purely presentational. Every results container stays in the document and
 * keeps rendering whether its tab is showing or not — a panel the user has not
 * clicked on must still be complete when they do, and must still be in the DOM
 * for the PDF and JSON exports, which read from the same nodes.
 */
function selectResultsTab(name) {
  for (const tab of $$('.tab')) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  for (const panelNode of $$('.tab-panel')) {
    panelNode.hidden = panelNode.dataset.panel !== name;
  }
}

/* ══ exports ═════════════════════════════════════════════════════════════ */

function currentRecord() {
  if (!runtime.dfm) return null;
  return buildExportJSON({
    sessionId: runtime.sessionId,
    dfm: runtime.dfm,
    analysis: runtime.analysis,
    twoShot: runtime.twoShot,
    interface: runtime.interface,
    registration: runtime.registration,
    fpcRegion: runtime.fpcRegion,
    validation: runtime.validation,
    shot: runtime.shot,
    cycle: runtime.cycle,
    cost: runtime.cost,
    tooling: runtime.tooling,
    settings,
  });
}

function doExportJSON() {
  const data = currentRecord();
  if (!data) return;
  downloadJSON(data, `dfm_${runtime.sessionId}_${Date.now()}.json`);
}

/*
 * The findings package: the report, the record and the measured file, zipped.
 *
 * The three of them together rather than three downloads, because assembling
 * them by hand is where the wrong revision gets attached — and once they are
 * apart nobody can tell which report describes which file.
 */
async function doExportPackage() {
  if (!runtime.dfm) return;
  const btn = $('packageBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Packaging…';
  try {
    const json = currentRecord();
    /* The same report the PDF button produces, handed over as bytes instead
       of saved — one layout, not two. */
    const pdf = await exportPDF({
      sessionId: runtime.sessionId,
      dfm: runtime.dfm,
      analysis: runtime.analysis,
      twoShot: runtime.twoShot,
      validation: runtime.validation,
      shot: runtime.shot,
      cycle: runtime.cycle,
      cost: runtime.cost,
      tooling: runtime.tooling,
      settings,
      deliver: 'bytes',
    });
    const pkg = await buildFindingsPackage({
      sessionId: runtime.sessionId,
      partName: runtime.fileName1,
      source: runtime.sourceFile,
      pdfBytes: pdf.bytes,
      json,
      result: runtime.dfm.result,
      twoShot: runtime.twoShot,
    });
    downloadPackage(pkg);
    toast(runtime.sourceFile
      ? `Packaged ${pkg.entries.length} files — report, record and the geometry it was measured from.`
      : `Packaged ${pkg.entries.length} files. No geometry: this part arrived without bytes to keep, and the manifest says so.`,
    runtime.sourceFile ? 'info' : 'warn', 8000);
  } catch (err) {
    console.error(err);
    toast(`Could not build the package: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/*
 * Compare this run against a previously exported JSON.
 *
 * Reading a file rather than keeping history in the page: a revision comparison
 * is usually against something from last week, on someone else's machine, and
 * the export already carries everything the diff needs.
 */
async function doCompare(file) {
  const current = currentRecord();
  if (!current) { toast('Run an analysis first, then compare it against a previous export.', 'warn'); return; }
  try {
    const text = await file.text();
    const previous = JSON.parse(text);
    if (!previous || typeof previous.score !== 'number' || !Array.isArray(previous.checks)) {
      throw new Error('that file does not look like a DFM JSON export');
    }
    runtime.comparison = compareRuns(previous, current);
    renderComparison(runtime.comparison);
    toast(runtime.comparison.headline, 'info', 8000);
    setStatus('COMPARED');
  } catch (err) {
    console.error(err);
    toast(`Could not compare: ${err.message}`, 'error');
  }
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
      cycle: runtime.cycle,
      cost: runtime.cost,
      tooling: runtime.tooling,
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
  panel.renderModelTree(null);
  panel.renderRevisions([]);
  selectResultsTab('findings');
  panel.populateSelects();
  panel.syncFormFromSettings();
  panel.clearFileInfo();
  panel.renderBodiesList(null, toggleBody, toggleBodyFpc);
  panel.setFromMeshBadge(false);
  panel.updatePartSummary();
  panel.updateOnboarding();
  refreshEverything();
  refreshPickButtons();
  clearGate();
  refreshGateSuggestion();
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

/*
 * Cycle time, cost and tooling drivers.
 *
 * Kept out of the analysis run so a changed rate re-costs the part
 * immediately: none of this needs the geometry re-measured, and making
 * someone re-run an analysis to try a different resin price would be an
 * invitation to not bother trying one.
 */
function refreshCostEstimates() {
  if (!runtime.analysis) {
    runtime.cycle = null;
    runtime.cost = null;
    runtime.tooling = null;
    renderCost(null, null, null);
    return;
  }

  /* Judged on the same wall the checks are judged on — the sphere-fit
     nominal, the conservative of the two thickness measures — so a cycle time
     cannot come out shorter than the wall the part was passed or failed on. */
  const wallMm = runtime.analysis.nominalWall
    || (runtime.analysis.wallStats && runtime.analysis.wallStats.median)
    || null;

  runtime.cycle = estimateCycle({
    material: MATERIALS[settings.material],
    wallMm,
    cavities: settings.cavities,
  });
  runtime.cost = estimatePartCost({
    shotMassG: runtime.shot ? runtime.shot.shotMassG : null,
    cycleS: runtime.cycle.cycleS,
    cavities: settings.cavities,
    resinPerKg: settings.resinPerKg,
    machinePerHour: settings.machinePerHour,
    scrapPct: settings.scrapPct,
  });
  runtime.tooling = toolingDrivers({
    analysis: runtime.analysis,
    material: MATERIALS[settings.material],
    finishName: SURFACE_FINISHES[settings.surfaceFinish] ? SURFACE_FINISHES[settings.surfaceFinish].name : null,
    cavities: settings.cavities,
    bboxMm: runtime.analysis.bbox ? runtime.analysis.bbox.size : null,
  });
  renderCost(runtime.cycle, runtime.cost, runtime.tooling);
}

const COST_KEYS = new Set(['cavities', 'resinPerKg', 'machinePerHour', 'scrapPct']);

function onFieldChange(key) {
  if (COST_KEYS.has(key) || key === 'material' || key === 'surfaceFinish') refreshCostEstimates();
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
  /* The FPC column in the body list appears and disappears with the check that
     reads it, so switching either of them re-renders the list. Without this
     the designation is offered only to whoever had the checkbox on before they
     opened the file. */
  if (key === 'fpcEnabled' || key === 'check:fpc') renderBodies();
  if (key === 'material') panel.updateOnboarding();
}

/* ══ 6-DoF device ════════════════════════════════════════════════════════ */

/*
 * A 3Dconnexion puck, if the browser has one and the user wants it connected.
 *
 * Chromium-only, so the whole thing degrades to silence: the button is hidden
 * where `navigator.hid` does not exist, and nothing anywhere else in the page
 * mentions the feature. A user without a device sees no change at all, which
 * is the requirement.
 */
let spaceMouse = null;      // { source, loop }

/*
 * Rates, damped for a reduced-motion preference.
 *
 * The setting is about motion the page inflicts on someone. This is motion the
 * user is producing themselves, one frame at a time, with their hand on the
 * control — so refusing to move at all would be useless rather than kind. Half
 * rate is the deliberate answer: the device still works, and it works more
 * slowly for someone who asked for less movement.
 */
function navigatorSettings() {
  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduced) return NAVIGATOR_DEFAULTS;
  return {
    ...NAVIGATOR_DEFAULTS,
    rotateRate: NAVIGATOR_DEFAULTS.rotateRate / 2,
    panRate: NAVIGATOR_DEFAULTS.panRate / 2,
    dollyRate: NAVIGATOR_DEFAULTS.dollyRate / 2,
  };
}

function attachSpaceMouse(device) {
  const controls = viewer.getControls();
  if (!device || !controls) return false;
  if (spaceMouse) { spaceMouse.loop.stop(); spaceMouse.source.close(); }
  const source = createHidSource(device);
  const loop = createNavigatorLoop({ source, controls, settings: navigatorSettings() });
  loop.start();
  spaceMouse = { source, loop };

  const btn = $('spaceMouseBtn');
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
  btn.title = `${device.productName || '6-DoF device'} connected — ${source.axisCount} of 6 axes declared`;
  /* Unplugging is the ordinary way this ends. */
  if (navigator.hid && navigator.hid.addEventListener) {
    navigator.hid.addEventListener('disconnect', (e) => {
      if (e.device !== device || !spaceMouse) return;
      spaceMouse.loop.stop();
      spaceMouse = null;
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
      btn.title = 'Connect a 3Dconnexion SpaceMouse';
    });
  }
  return true;
}

async function initSpaceMouse() {
  if (!hidAvailable()) return;
  const btn = $('spaceMouseBtn');
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    try {
      /* requestDevice needs the user gesture this handler is running inside,
         so it cannot be moved off the click. */
      const device = await requestSpaceMouse();
      if (!device) return;                    // the chooser was dismissed
      if (attachSpaceMouse(device)) toast(`${device.productName || 'Device'} connected.`, 'info');
    } catch (err) {
      console.error(err);
      toast(`Could not open the device: ${err.message}`, 'error');
    }
  });

  /* Permission persists per origin, so someone who granted it once should not
     have to click again. Silent either way. */
  try {
    const known = await alreadyGrantedSpaceMouse();
    if (known) attachSpaceMouse(known);
  } catch { /* nothing to say about a device that is not there */ }
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
  /* Which build this is, where someone can read it off the screen and quote
     it — the same string the PDF footer and the JSON export carry. */
  $('buildLabel').textContent = buildLabel();
  $('buildLabel').title = BUILD_FINGERPRINT === 'source'
    ? 'Running from source, not from a build'
    : `Source fingerprint ${BUILD_FINGERPRINT}`;
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

  refreshBridgeStatus();
  $('bridgeRetryBtn').addEventListener('click', refreshBridgeStatus);
  $('bridgeUrlInput').value = bridgeUrl();
  $('bridgeUrlInput').addEventListener('change', (e) => {
    setBridgeUrl(e.target.value);
    e.target.value = bridgeUrl();
    refreshBridgeStatus();
  });

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
  $('suggestGateBtn').addEventListener('click', useSuggestedGate);
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

  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => selectResultsTab(tab.dataset.tab));
  }

  $('runBtn').addEventListener('click', doRunAnalysis);
  $('resetBtn').addEventListener('click', startOver);
  $('jsonBtn').addEventListener('click', doExportJSON);
  $('compareBtn').addEventListener('click', () => $('compareInput').click());
  $('compareInput').addEventListener('change', (e) => {
    if (e.target.files.length) doCompare(e.target.files[0]);
    e.target.value = ''; // allow re-selecting the same file
  });
  initSpaceMouse();
  $('pdfBtn').addEventListener('click', doExportPDF);
  $('packageBtn').addEventListener('click', doExportPackage);

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
