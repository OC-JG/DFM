/*
 * End-to-end smoke test for the built dfm-tool.html.
 *
 * Serves the built file over http (so the analysis worker is permitted),
 * drives it with the STL fixtures, and asserts the pipeline produces a score,
 * checks, heatmaps and both exports.
 *
 * The CDN requests for three.js and jsPDF are intercepted and answered from
 * node_modules, so the test never touches the network and cannot go red
 * because a CDN had a bad afternoon.
 *
 * Run: npm install && node test/make-fixtures.mjs && node test/smoke.mjs
 * Playwright is resolved from the global install; set NODE_PATH if needed.
 * Set DFM_CHROMIUM to an existing Chromium binary to use that instead of the
 * one Playwright downloads — handy on a machine that already has one but at a
 * different build number than the installed Playwright expects.
 */
import { createServer } from 'node:http';
import { startFakeBridge } from './lib/fake-bridge.mjs';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/* The version the built file should be claiming, read from the same place
   build.js reads it, so the check cannot pass by agreeing with itself. */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const BUILT = join(ROOT, 'dfm-tool.html');
const FIXTURES = join(HERE, 'fixtures');

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = !!condition;
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  if (!existsSync(BUILT)) throw new Error('dfm-tool.html not found — run `node build.js` first');
  if (!existsSync(join(FIXTURES, 'part.stl'))) throw new Error('fixtures missing — run `node test/make-fixtures.mjs` first');

  const { chromium } = require('playwright');

  const html = readFileSync(BUILT);

  /* The deliverable travels on its own, so it has to say what it is and what
     may be done with it. Checked before the browser starts, since this is a
     property of the file rather than of the running page. */
  const source = html.toString('utf8');
  check('built file carries the MIT notice',
    /Released under the MIT License/.test(source));
  check('licence banner follows the doctype, not preceding it',
    /^\s*<!DOCTYPE html>\s*<!--/i.test(source),
    'a comment before the doctype puts browsers into quirks mode');
  check('built file names the runtime dependencies it does not contain',
    /fetched from a CDN/.test(source) && /NOTICE/.test(source));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch(
    process.env.DFM_CHROMIUM ? { executablePath: process.env.DFM_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  /* Answer the app's CDN requests from node_modules. Also asserts, implicitly,
     that the app asks for exactly the versions package.json pins. */
  const vendored = {
    'three.min.js': join(ROOT, 'node_modules/three/build/three.min.js'),
    'jspdf.umd.min.js': join(ROOT, 'node_modules/jspdf/dist/jspdf.umd.min.js'),
    /* The OpenCascade reader, so a STEP file can be driven through the real
       browser path. Both halves are needed: the loader script, and the wasm
       it then fetches beside itself — and the wasm has to arrive as
       application/wasm or instantiateStreaming refuses it. */
    'occt-import-js.js': join(ROOT, 'node_modules/occt-import-js/dist/occt-import-js.js'),
    'occt-import-js.wasm': join(ROOT, 'node_modules/occt-import-js/dist/occt-import-js.wasm'),
  };

  /* One handler, used by every page the test opens, so a new vendored file
     does not have to be remembered in three places. */
  const serveVendored = (route) => {
    const hit = Object.keys(vendored).find((name) => route.request().url().endsWith(name));
    if (!hit || !existsSync(vendored[hit])) return route.abort();
    return route.fulfill({
      status: 200,
      contentType: hit.endsWith('.wasm') ? 'application/wasm' : 'application/javascript',
      body: readFileSync(vendored[hit]),
    });
  };
  await page.route(/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//, serveVendored);
  /* Fonts are decoration. Answer them with an empty stylesheet rather than
     aborting, so a blocked request does not masquerade as an app error. */
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  /* No Inventor is running here — there is none on a CI runner — so the
     bridge health probe is refused, and Chromium logs the refused request as
     a console error that no catch inside the page can suppress. "Nothing
     listening" is a state the tool is built to report, so one such error per
     refused probe is expected rather than a failure. Everything else still
     counts, and the allowance is keyed on the request URL rather than on the
     console text, so a refused connection to anything else is not excused. */
  const failedRequests = [];
  page.on('requestfailed', (r) => failedRequests.push(r.url()));

  const unexpectedErrors = () => {
    let allowance = failedRequests.filter((u) => u.includes('/bridge/health')).length;
    return consoleErrors.filter((t) => {
      if (allowance > 0 && /Failed to load resource/.test(t)) { allowance--; return false; }
      return true;
    });
  };

  try {
    await page.goto(url, { waitUntil: 'networkidle' });

    // ── boot ──────────────────────────────────────────────────────────────
    check('page boots without errors', unexpectedErrors().length === 0, unexpectedErrors().join(' | '));
    check('three.js loaded', await page.evaluate(() => typeof THREE !== 'undefined'));
    check('status pill ready', (await page.textContent('#statusPill')).includes('AWAITING'));
    check('worker active over http', (await page.textContent('#threadNote')) === 'worker');
    check('material list populated', (await page.locator('#material option').count()) === 16);
    check('finish list populated', (await page.locator('#surfaceFinish option').count()) === 16);
    check('heat mode buttons built', (await page.locator('.heat-btn').count()) === 6);

    // ── load the part ─────────────────────────────────────────────────────
    await page.setInputFiles('#fileInput', join(FIXTURES, 'part.stl'));
    await page.waitForFunction(() => document.getElementById('statusPill').textContent.includes('LOADED'), null, { timeout: 30000 });
    check('STL parsed and loaded', (await page.textContent('#statusPill')).includes('STL LOADED'));
    check('file info shows triangle count', (await page.textContent('#fileInfo')).includes('24 tris'));
    check('part summary strip visible', await page.locator('#partSummary.show').count() === 1);
    check('bounding box reported', (await page.textContent('#partSummary')).includes('40.0×30.0×22.0')
      || (await page.textContent('#partSummary')).includes('40.0×30.0×20.0'));

    // ── run the analysis ──────────────────────────────────────────────────
    await page.selectOption('#material', 'abs');
    await page.click('#runBtn');
    await page.waitForFunction(() => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 60000 });

    const score = Number(await page.textContent('#scoreValue'));
    check('score is a number in range', Number.isFinite(score) && score >= 0 && score <= 100, `score=${score}`);
    check('grade rendered', (await page.textContent('#scoreGrade')).trim().length > 0);
    check('checks rendered', (await page.locator('#checksList .check').count()) >= 6,
      `count=${await page.locator('#checksList .check').count()}`);
    /* Build identity and finding references, on the page. Both are only
       useful if a person can read them off the screen and quote them, which
       is the one thing a unit test cannot check. */
    check('the header names the build rather than a hardcoded version',
      (await page.textContent('#buildLabel')).trim().length > 0
      && (await page.textContent('#buildLabel')).includes(pkg.version),
      await page.textContent('#buildLabel'));

    const firstRef = await page.locator('#checksList .check .check-ref').first().textContent();
    check('every finding shows the reference a DFM response is written against',
      (await page.locator('#checksList .check .check-ref').count())
        === (await page.locator('#checksList .check').count())
      && /^[A-Z0-9-]+$/.test(firstRef.trim()),
      `first=${firstRef}, refs=${await page.locator('#checksList .check .check-ref').count()}`);

    check('score strips match checks',
      (await page.locator('#scoreBars .score-strip').count()) === (await page.locator('#checksList .check').count()));
    check('run counter incremented', (await page.textContent('#runCount')) === '001');

    /* The shelled fixture has 2 mm walls, so the median wall estimate should
       land near 2 — this is the whole thickness pipeline in one assertion. */
    const medianWall = await page.evaluate(() => window.__dfmDebug?.wallMedian ?? null);
    const wallText = await page.locator('#checksList .check').first().textContent();
    check('wall check reports a plausible nominal', /2\.\d\d mm/.test(wallText), wallText.slice(0, 120));
    void medianWall;

    // ── moulding estimates ────────────────────────────────────────────────
    // Not scored checks: what it costs to make the part rather than whether it
    // can be made. The fixture is a 40×30×20 shell with 2 mm walls.
    // The estimates live behind their own results tab, so open it the way a
    // user does before asking whether they are on screen.
    await page.click('.tab[data-tab="estimates"]');
    check('moulding estimates shown', await page.locator('#shotSection').isVisible());
    const shotText = await page.textContent('#shotSection');
    check('part mass reported', /\d+\.\d\s*g/.test(shotText), shotText.slice(0, 160));
    check('projected area reported', /12\.0\s*cm²/.test(shotText), shotText.slice(0, 200));
    check('machine size reported', /Machine size\s*\d+\s*t/.test(shotText), shotText.slice(0, 220));

    // ── cycle time and cost ───────────────────────────────────────────────
    // Not scored, so this checks the figures appear, that they carry their
    // assumptions, and that a rate typed in re-costs the part without anyone
    // having to run the analysis again.
    await page.click('.tab[data-tab="estimates"]');
    check('cycle time is shown', (await page.textContent('#costBody')).includes('Cooling floor'),
      (await page.textContent('#costBody')).slice(0, 120));
    check('the cooling floor is labelled a lower bound',
      /derived lower bound|no tool beats|lower bound/i.test(await page.locator('#costSection').innerHTML()),
      '');
    check('the cycle assumptions are printed with it',
      /full-wall/.test(await page.textContent('#costBody'))
      && /50–80%/.test(await page.textContent('#costBody')),
      (await page.textContent('#costBody')).slice(-160));

    const beforeRates = await page.textContent('#costBody');
    check('no cost until a rate is given', /No cost until there is/.test(beforeRates),
      beforeRates.slice(-120));

    await page.fill('#resinPerKg', '2.20');
    await page.fill('#machinePerHour', '45');
    await page.waitForFunction(
      () => /Material \+ machine/.test(document.getElementById('costBody').textContent),
      null, { timeout: 15000 });
    check('typing a rate costs the part without re-running the analysis',
      /Material \+ machine/.test(await page.textContent('#costBody')),
      (await page.textContent('#costBody')).slice(0, 140));
    check('the cost says it is not a piece price',
      /labour|margin|overhead/i.test(await page.textContent('#costBody')), '');

    await page.fill('#cavities', '4');
    await page.waitForFunction(
      () => /4 cavities/.test(document.getElementById('costBody').textContent),
      null, { timeout: 15000 });
    check('cavities re-cost the part too',
      /4 cavities/.test(await page.textContent('#costBody')), '');

    check('what drives the tool is listed', /What drives the tool/.test(await page.textContent('#costSection')),
      '');

    /* Put the inputs back so the rest of the run is unaffected. */
    await page.fill('#cavities', '1');
    await page.fill('#resinPerKg', '');
    await page.fill('#machinePerHour', '');
    await page.click('.tab[data-tab="findings"]');

    // ── gate suggestion ───────────────────────────────────────────────────
    // With no gate set the flow check has nothing to compute, so it searches
    // for where the gate should go instead of only asking for one.
    const flowInfo = await page.locator('#checksList .check', { hasText: 'Flow length' }).first().textContent();
    check('flow check reports a searched gate position', /candidate positions tried/.test(flowInfo), flowInfo.slice(0, 200));
    check('best-candidate L/T reported', /Best candidate L\/T/.test(flowInfo), flowInfo.slice(0, 260));
    check('use-best button enabled', !(await page.locator('#suggestGateBtn').isDisabled()));

    await page.click('#suggestGateBtn');
    check('suggested gate placed', (await page.textContent('#gateInfo')).includes('best of'),
      await page.textContent('#gateInfo'));
    check('use-best button retires once a gate is set', await page.locator('#suggestGateBtn').isDisabled());

    await page.click('#runBtn');
    await page.waitForFunction(() => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 60000 });
    const suggestedFlow = await page.locator('#checksList .check', { hasText: 'Flow length' }).first().textContent();
    check('the suggested gate produces a real L/T', /Max L\/T = \d+/.test(suggestedFlow), suggestedFlow.slice(0, 160));

    await page.click('#clearGateBtn');
    check('clearing the gate re-offers the suggestion', !(await page.locator('#suggestGateBtn').isDisabled()));

    // ── heat modes ────────────────────────────────────────────────────────
    for (const mode of ['draft', 'thickness', 'sink', 'undercut']) {
      await page.click(`.heat-btn[data-heat="${mode}"]`);
      const active = await page.getAttribute(`.heat-btn[data-heat="${mode}"]`, 'aria-pressed');
      const legendVisible = await page.locator('#viewerLegend .legend-title').count();
      check(`heat mode ${mode} applies with legend`, active === 'true' && legendVisible === 1);
    }
    await page.click('.heat-btn[data-heat="flat"]');

    // ── gate picking drives the flow check ────────────────────────────────
    await page.click('#pickGateBtn');
    const box = await page.locator('#viewer').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    check('gate captured', (await page.textContent('#gateInfo')).includes('Gate set at'));

    await page.click('#runBtn');
    await page.waitForFunction(() => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 60000 });
    const flowText = await page.locator('#checksList .check', { hasText: 'Flow length' }).first().textContent();
    check('flow check computed L/T', /Max L\/T = \d+/.test(flowText), flowText.slice(0, 140));
    await page.click('.heat-btn[data-heat="flow"]');
    check('flow heatmap available after gate',
      (await page.getAttribute('.heat-btn[data-heat="flow"]', 'aria-pressed')) === 'true');

    // ── two-shot ──────────────────────────────────────────────────────────
    await page.selectOption('#analysisMode', 'twoshot');
    check('shot 2 drop zone revealed', await page.locator('#shot2Zone').isVisible());
    check('adhesion badge shown', await page.locator('#compatBadge').isVisible());

    /* Regression: shot 2 STL loading called three functions that did not
       exist, so this always failed with "isBinarySTL is not defined". */
    await page.setInputFiles('#fileInput2', join(FIXTURES, 'overmould.stl'));
    await page.waitForFunction(() => document.getElementById('fileInfo2').textContent.includes('tris'), null, { timeout: 30000 });
    check('shot 2 STL parsed', (await page.textContent('#fileInfo2')).includes('12 tris'),
      await page.textContent('#fileInfo2'));

    await page.click('#runBtn');
    await page.waitForFunction(() => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 60000 });
    check('two-shot panel shown', await page.locator('#twoShotResults').isVisible());
    const tsScore = Number(await page.textContent('#tsScore'));
    check('interface score in range', Number.isFinite(tsScore) && tsScore >= 0 && tsScore <= 100, `tsScore=${tsScore}`);
    check('two-shot checks rendered', (await page.locator('#tsChecksList .check').count()) >= 5);

    // ── exports ───────────────────────────────────────────────────────────
    const jsonDownload = page.waitForEvent('download', { timeout: 20000 });
    await page.click('#jsonBtn');
    const jsonFile = await jsonDownload;
    const jsonPath = await jsonFile.path();
    const exported = JSON.parse(readFileSync(jsonPath, 'utf8'));
    check('JSON export has score', typeof exported.score === 'number');
    check('JSON export has mesh summary', exported.mesh_summary && exported.mesh_summary.tris === 24);
    /* Regression: the original never wrote the two-shot result to the export. */
    check('JSON export includes two-shot block', !!exported.two_shot && Array.isArray(exported.two_shot.checks));
    check('JSON export includes flow data', !!exported.mesh_summary.flow);
    check('JSON export includes moulding estimates',
      !!exported.moulding && typeof exported.moulding.part_mass_g === 'number'
      && typeof exported.moulding.machine_clamp_tonnes === 'number',
      JSON.stringify(exported.moulding).slice(0, 160));

    const pdfDownload = page.waitForEvent('download', { timeout: 40000 });
    await page.click('#pdfBtn');
    const pdfFile = await pdfDownload;
    const pdfBytes = readFileSync(await pdfFile.path());
    check('PDF export produced a real PDF', pdfBytes.subarray(0, 5).toString() === '%PDF-', `${pdfBytes.length} bytes`);

    // ── revision comparison ───────────────────────────────────────────────
    // Fed the export from this same run, so every check should read unchanged
    // and the panel should notice it is looking at one geometry twice.
    await page.setInputFiles('#compareInput', jsonPath);
    await page.waitForFunction(
      () => document.getElementById('compareSection').style.display !== 'none', null, { timeout: 15000 });
    const cmpText = await page.textContent('#compareSection');
    /* Same tab as the estimates, and the run above may have left another one
       selected, so select it again rather than assuming. */
    await page.click('.tab[data-tab="estimates"]');
    check('comparison panel shown', await page.locator('#compareSection').isVisible());
    check('comparing a run with itself moves nothing', /No check changed band/.test(cmpText), cmpText.slice(0, 200));
    check('comparison warns it is the same geometry', /same geometry twice/.test(cmpText), cmpText.slice(0, 300));

    // ── persistence ───────────────────────────────────────────────────────
    await page.reload({ waitUntil: 'networkidle' });
    check('material persisted across reload', (await page.inputValue('#material')) === 'abs');
    check('mode persisted across reload', (await page.inputValue('#analysisMode')) === 'twoshot');

    // ── reset ─────────────────────────────────────────────────────────────
    await page.click('#resetBtn');
    check('reset restores default material', (await page.inputValue('#material')) === 'pp');
    check('reset clears results', !(await page.locator('#resultsContent').isVisible()));

    check('no console errors during run', unexpectedErrors().length === 0, unexpectedErrors().slice(0, 3).join(' | '));

    // ── mesh health gate ──────────────────────────────────────────────────
    // The panel that has to be read before the score is. Driven on a fresh
    // page so it cannot be confused with the state the run above left behind.
    const healthPage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await healthPage.route(/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//, serveVendored);
    await healthPage.route(/^https:\/\/fonts\./, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await healthPage.goto(url, { waitUntil: 'networkidle' });

    const loadInto = async (name) => {
      await healthPage.setInputFiles('#fileInput', join(FIXTURES, name));
      await healthPage.waitForFunction(
        () => !document.getElementById('meshHealth').hidden, null, { timeout: 30000 });
    };

    await loadInto('part.stl');
    check('mesh health: sound part reports no issues',
      (await healthPage.locator('#meshHealth .mh-head.high').count()) === 1
      && (await healthPage.locator('#meshHealth .mh-issue.error, #meshHealth .mh-issue.warn').count()) === 0,
      await healthPage.textContent('#meshHealth'));

    /* Regression: an inch-authored STL is a valid file describing a 1.57 mm
       part. Before this gate existed it analysed silently and failed the wall
       check on a part that is fine. */
    await healthPage.reload({ waitUntil: 'networkidle' });
    await loadInto('part-inches.stl');
    check('mesh health: inch-authored part is caught',
      (await healthPage.locator('#meshHealth .mh-head.unusable').count()) === 1
      && (await healthPage.textContent('#meshHealth')).includes('not in millimetres'),
      (await healthPage.textContent('#meshHealth')).slice(0, 140));
    check('mesh health: offers the inch conversion',
      (await healthPage.locator('#meshHealth .mh-fix-btn').count()) >= 1,
      await healthPage.textContent('#meshHealth'));

    await healthPage.locator('#meshHealth .mh-fix-btn').first().click();
    await healthPage.waitForFunction(
      () => document.querySelector('#meshHealth .mh-head.high') !== null, null, { timeout: 15000 });
    check('mesh health: rescaling fixes it',
      (await healthPage.textContent('#meshHealth')).includes('40.0 × 30.0 × 20.0'),
      await healthPage.textContent('#meshHealth'));

    await healthPage.click('#runBtn');
    await healthPage.waitForFunction(() => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 60000 });
    const rescaledWall = await healthPage.locator('#checksList .check', { hasText: 'Wall thickness' }).first().textContent();
    check('mesh health: rescaled part measures its true 2 mm wall',
      /2\.\d\d mm/.test(rescaledWall), rescaledWall.slice(0, 120));

    await healthPage.reload({ waitUntil: 'networkidle' });
    await loadInto('part-open.stl');
    check('mesh health: open mesh is reported',
      (await healthPage.textContent('#meshHealth')).includes('not closed'),
      (await healthPage.textContent('#meshHealth')).slice(0, 140));
    await healthPage.close();

    // ── main-thread fallback ──────────────────────────────────────────────
    // Opened from a Downloads folder the page runs on file://, where Chrome
    // refuses blob-backed workers. That fallback is the common case, not an
    // edge case, so it gets asserted: same inputs, same score.
    const fallbackPage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await fallbackPage.route(/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//, serveVendored);
    await fallbackPage.route(/^https:\/\/fonts\./, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await fallbackPage.addInitScript(() => {
      window.Worker = function () { throw new Error('workers blocked (simulating file:// origin)'); };
    });
    await fallbackPage.goto(url, { waitUntil: 'networkidle' });

    check('fallback reports single-thread', (await fallbackPage.textContent('#threadNote')) === 'single-thread');
    await fallbackPage.selectOption('#material', 'abs');
    await fallbackPage.setInputFiles('#fileInput', join(FIXTURES, 'part.stl'));
    await fallbackPage.waitForFunction(() => document.getElementById('statusPill').textContent.includes('LOADED'), null, { timeout: 30000 });
    await fallbackPage.click('#runBtn');
    await fallbackPage.waitForFunction(() => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 60000 });
    const fallbackScore = Number(await fallbackPage.textContent('#scoreValue'));
    check('fallback produces the same score', fallbackScore === score, `worker=${score} inline=${fallbackScore}`);
    await fallbackPage.close();

    // ── the Inventor loop, in a real browser ──────────────────────────────
    // The feature the tool exists for, driven the way a user drives it: open
    // an .ipt, change the dimension that caused a finding, measure again. The
    // bridge here is test/lib/fake-bridge.mjs — a real server on its own
    // origin, speaking the real protocol and genuinely rebuilding, so the
    // wall the page reports afterwards is the wall that was asked for.
    const bridge = await startFakeBridge({});
    const iptPath = join(FIXTURES, 'BridgePart.ipt');
    writeFileSync(iptPath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));   // an OLE header, as an .ipt has

    const bridgePage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await bridgePage.route(/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//, serveVendored);
    await bridgePage.route(/^https:\/\/fonts\./, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    /* Point the page at this server before any of its scripts run — the same
       setting a user would type under the drop zone. */
    await bridgePage.addInitScript((url) => {
      try { localStorage.setItem('dfm.bridgeUrl', url); } catch { /* ignore */ }
    }, bridge.url);
    await bridgePage.goto(url, { waitUntil: 'networkidle' });

    await bridgePage.waitForFunction(
      () => document.getElementById('bridgeStatus').dataset.state === 'live', null, { timeout: 30000 });
    check('bridge chip reports a live Inventor',
      /Inventor/.test(await bridgePage.textContent('#bridgeStatus')),
      await bridgePage.textContent('#bridgeStatus'));

    await bridgePage.setInputFiles('#fileInput', iptPath);
    await bridgePage.waitForFunction(
      () => document.getElementById('statusPill').textContent.includes('LOADED'), null, { timeout: 90000 });
    check('an .ipt opens through the bridge',
      (await bridgePage.textContent('#fileInfo')).includes('BridgePart'),
      (await bridgePage.textContent('#fileInfo')).slice(0, 100));

    const paramCount = await bridgePage.locator('#paramsList .param-expr').count();
    check('the driving parameters are listed', paramCount === 2, `rows=${paramCount}`);

    await bridgePage.click('#runBtn');
    await bridgePage.waitForFunction(
      () => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 90000 });
    const wallBefore = await bridgePage.locator('#checksList .check', { hasText: 'Wall thickness' }).first().textContent();
    check('the part as opened measures its 2 mm wall',
      /Nominal \(median\)2\.0\d mm/.test(wallBefore), wallBefore.slice(0, 110));

    /* Drive the dimension that caused the finding, exactly as a user would:
       type into the parameter and press Enter. */
    const wallInput = bridgePage.locator('#paramsList .param-expr').first();
    await wallInput.fill('3');
    await wallInput.press('Enter');
    await bridgePage.waitForFunction(
      () => document.getElementById('statusPill').textContent.includes('REBUILT'), null, { timeout: 90000 });
    check('Inventor rebuilds on a parameter change', true,
      await bridgePage.textContent('#statusPill'));

    /* The edit log: one entry, naming the parameter and carrying the score it
       replaced, and the section actually on screen rather than merely present
       in the markup. */
    check('the change is recorded under History',
      (await bridgePage.locator('#revisionsSection').getAttribute('hidden')) === null
      && /1 change\b/.test(await bridgePage.textContent('#revisionCount'))
      && /wall/.test(await bridgePage.textContent('#revisionsSection')),
      `${await bridgePage.textContent('#revisionCount')} — ${(await bridgePage.textContent('#revisionsSection')).slice(0, 90)}`);

    await bridgePage.click('#runBtn');
    await bridgePage.waitForFunction(
      () => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 90000 });
    const wallAfter = await bridgePage.locator('#checksList .check', { hasText: 'Wall thickness' }).first().textContent();
    check('the rebuilt part measures the wall that was asked for',
      /Nominal \(median\)3\.0\d mm/.test(wallAfter), wallAfter.slice(0, 110));

    await bridgePage.close();
    await bridge.close();

    // ── the STEP path, in a real browser ──────────────────────────────────
    // An .ipt reaches parseSTEP by the same road a dropped .step does, so
    // this is the tool's primary input and it had never been driven here.
    // Node covers the parsing in test/step.mjs; what only a browser can show
    // is that the reader loads lazily over the wire, tessellates, and lands
    // in the viewer with its bodies and its measurements intact.
    const stepPage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await stepPage.route(/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//, serveVendored);
    await stepPage.route(/^https:\/\/fonts\./, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await stepPage.goto(url, { waitUntil: 'networkidle' });

    await stepPage.setInputFiles('#fileInput', join(FIXTURES, 'part.step'));
    await stepPage.waitForFunction(
      () => document.getElementById('statusPill').textContent.includes('LOADED'), null, { timeout: 90000 });
    check('STEP file loads in the browser',
      (await stepPage.textContent('#fileInfo')).includes('part.step'),
      (await stepPage.textContent('#fileInfo')).slice(0, 120));

    await stepPage.click('#runBtn');
    await stepPage.waitForFunction(
      () => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 90000 });

    const stepScore = Number(await stepPage.textContent('#scoreValue'));
    check('STEP analysis produces a score', Number.isFinite(stepScore) && stepScore >= 0 && stepScore <= 100, `score=${stepScore}`);

    /* The fixture is the same 40x30x20 shelled box as part.stl, authored as a
       B-rep instead of as triangles, so the wall it reports has a right
       answer and it is the same one the STL gives. */
    const stepWall = await stepPage.locator('#checksList .check', { hasText: 'Wall thickness' }).first().textContent();
    check('STEP part measures its 2 mm wall', /2\.0\d mm/.test(stepWall), stepWall.slice(0, 140));

    await stepPage.setInputFiles('#fileInput', join(FIXTURES, 'part-twobody.step'));
    await stepPage.waitForFunction(
      () => document.getElementById('statusPill').textContent.includes('LOADED'), null, { timeout: 90000 });
    check('a two-solid STEP file offers the body selector',
      await stepPage.locator('#bodiesSection').count() > 0
      && (await stepPage.locator('#bodiesList .body-row, #bodiesList > *').count()) >= 2,
      `rows=${await stepPage.locator('#bodiesList > *').count()}`);

    /*
     * The FPC designation, end to end. Everything about it is unit-tested
     * except the part that matters here: that a click in the body list
     * reaches the analysis at all. The fixture is a 4 mm housing with a
     * 0.2 mm flex on its mid-plane, so the cover the check must report is
     * 1.90 mm — a number that cannot come from anywhere else on the page.
     */
    await stepPage.setInputFiles('#fileInput', join(FIXTURES, 'part-fpc.step'));
    await stepPage.waitForFunction(
      () => document.getElementById('statusPill').textContent.includes('LOADED'), null, { timeout: 90000 });

    check('the FPC column is absent until the check is switched on',
      (await stepPage.locator('#bodiesList .body-fpc').count()) === 0
      && await stepPage.locator('#bodiesFpcHint').isHidden(),
      `buttons=${await stepPage.locator('#bodiesList .body-fpc').count()}`);

    /* The control lives in a collapsed section, so open it the way a user
       would rather than reaching past the fact that it is closed. */
    await stepPage.locator('summary', { hasText: 'Overmoulded inserts' }).click();
    await stepPage.check('#fpcEnabled');
    await stepPage.fill('#fpcCover', '0.5');
    await stepPage.locator('#fpcCover').blur();
    check('switching on FPC overmoulding offers the designation',
      (await stepPage.locator('#bodiesList .body-fpc').count()) === 2
      && await stepPage.locator('#bodiesFpcHint').isVisible(),
      `buttons=${await stepPage.locator('#bodiesList .body-fpc').count()}`);

    await stepPage.click('#runBtn');
    await stepPage.waitForFunction(
      () => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 90000 });
    const beforeMark = await stepPage.locator('#checksList .check', { hasText: 'FPC overmoulding' }).first().textContent();
    check('with nothing marked the FPC check says it is judging part-wide',
      /Not located/.test(beforeMark), beforeMark.slice(0, 160));

    /* The second body is the flex. */
    await stepPage.locator('#bodiesList .body-row').nth(1).locator('.body-fpc').click();
    check('the marked body is shown as marked',
      await stepPage.locator('#bodiesList .body-row').nth(1).locator('.body-fpc').getAttribute('aria-pressed') === 'true'
      && (await stepPage.textContent('#bodiesCount')).includes('marked FPC'),
      await stepPage.textContent('#bodiesCount'));

    await stepPage.click('#runBtn');
    await stepPage.waitForFunction(
      () => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 90000 });
    const afterMark = await stepPage.locator('#checksList .check', { hasText: 'FPC overmoulding' }).first().textContent();
    check('marking the flex makes the check measure the cover over it',
      /Located/.test(afterMark) && /1\.90 mm/.test(afterMark), afterMark.slice(0, 200));

    await stepPage.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${results.join('\n')}\n`);
  console.log(failures === 0
    ? `  ${results.length} checks passed\n`
    : `  ${failures} of ${results.length} checks FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
