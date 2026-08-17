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
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
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
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  /* Answer the app's CDN requests from node_modules. Also asserts, implicitly,
     that the app asks for exactly the versions package.json pins. */
  const vendored = {
    'three.min.js': join(ROOT, 'node_modules/three/build/three.min.js'),
    'jspdf.umd.min.js': join(ROOT, 'node_modules/jspdf/dist/jspdf.umd.min.js'),
  };
  await page.route(/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//, (route) => {
    const url = route.request().url();
    const hit = Object.keys(vendored).find((name) => url.endsWith(name));
    if (!hit) return route.abort();
    if (!existsSync(vendored[hit])) return route.abort();
    return route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: readFileSync(vendored[hit]),
    });
  });
  /* Fonts are decoration. Answer them with an empty stylesheet rather than
     aborting, so a blocked request does not masquerade as an app error. */
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  try {
    await page.goto(url, { waitUntil: 'networkidle' });

    // ── boot ──────────────────────────────────────────────────────────────
    check('page boots without errors', consoleErrors.length === 0, consoleErrors.join(' | '));
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
    check('score strips match checks',
      (await page.locator('#scoreBars .score-strip').count()) === (await page.locator('#checksList .check').count()));
    check('run counter incremented', (await page.textContent('#runCount')) === '001');

    /* The shelled fixture has 2 mm walls, so the median wall estimate should
       land near 2 — this is the whole thickness pipeline in one assertion. */
    const medianWall = await page.evaluate(() => window.__dfmDebug?.wallMedian ?? null);
    const wallText = await page.locator('#checksList .check').first().textContent();
    check('wall check reports a plausible nominal', /2\.\d\d mm/.test(wallText), wallText.slice(0, 120));
    void medianWall;

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

    const pdfDownload = page.waitForEvent('download', { timeout: 40000 });
    await page.click('#pdfBtn');
    const pdfFile = await pdfDownload;
    const pdfBytes = readFileSync(await pdfFile.path());
    check('PDF export produced a real PDF', pdfBytes.subarray(0, 5).toString() === '%PDF-', `${pdfBytes.length} bytes`);

    // ── persistence ───────────────────────────────────────────────────────
    await page.reload({ waitUntil: 'networkidle' });
    check('material persisted across reload', (await page.inputValue('#material')) === 'abs');
    check('mode persisted across reload', (await page.inputValue('#analysisMode')) === 'twoshot');

    // ── reset ─────────────────────────────────────────────────────────────
    await page.click('#resetBtn');
    check('reset restores default material', (await page.inputValue('#material')) === 'pp');
    check('reset clears results', !(await page.locator('#resultsContent').isVisible()));

    check('no console errors during run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    // ── main-thread fallback ──────────────────────────────────────────────
    // Opened from a Downloads folder the page runs on file://, where Chrome
    // refuses blob-backed workers. That fallback is the common case, not an
    // edge case, so it gets asserted: same inputs, same score.
    const fallbackPage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await fallbackPage.route(/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//, (route) => {
      const hit = Object.keys(vendored).find((name) => route.request().url().endsWith(name));
      return hit
        ? route.fulfill({ status: 200, contentType: 'application/javascript', body: readFileSync(vendored[hit]) })
        : route.abort();
    });
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
