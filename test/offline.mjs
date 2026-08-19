/*
 * Proves the vendored build needs no network.
 *
 * `node build.js --vendor` inlines three.js and jsPDF so the output is a file
 * you can double-click on a machine with no internet — which is how this tool
 * is actually used, and the reason the claim is worth testing rather than
 * asserting. Every outbound request is refused here, not intercepted: if
 * anything still reaches for a CDN, the viewer or the PDF export fails and this
 * test says so.
 *
 * Run: node build.js --vendor && node test/offline.mjs
 * Rebuild without --vendor afterwards; the committed deliverable is the
 * CDN-loading one.
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
  if (!existsSync(BUILT)) throw new Error('dfm-tool.html not found — run `node build.js --vendor` first');
  const html = readFileSync(BUILT, 'utf8');
  if (!/vendored: three/.test(html)) {
    throw new Error('dfm-tool.html was not built with --vendor; run `node build.js --vendor` first');
  }
  check('no CDN script tags remain', !/<script src="https:/i.test(html));
  check('no preconnect hints remain', !/rel="preconnect"/i.test(html));
  check('jsPDF is marked as built in', /const VENDORED = true;/.test(html));

  if (!existsSync(join(FIXTURES, 'part.stl'))) throw new Error('fixtures missing — run `node test/make-fixtures.mjs`');

  const { chromium } = require('playwright');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch(
    process.env.DFM_CHROMIUM ? { executablePath: process.env.DFM_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  /* Everything off-origin is refused. Not answered from node_modules as the
     smoke test does — refused, so a surviving dependency cannot hide. */
  const blocked = [];
  await page.route('**/*', (route) => {
    const target = route.request().url();
    if (target.startsWith(url)) return route.continue();
    blocked.push(target);
    return route.abort();
  });

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  try {
    await page.goto(url, { waitUntil: 'load' });
    check('page has no script errors', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('three.js is present without a network', await page.evaluate(() => typeof THREE !== 'undefined'));
    check('jsPDF is present without a network', await page.evaluate(() => !!(window.jspdf && window.jspdf.jsPDF)));

    await page.setInputFiles('#fileInput', join(FIXTURES, 'part.stl'));
    await page.waitForFunction(() => document.getElementById('statusPill').textContent.includes('LOADED'), null, { timeout: 30000 });
    check('STL loads offline', (await page.textContent('#statusPill')).includes('STL LOADED'));

    await page.click('#runBtn');
    await page.waitForFunction(() => document.getElementById('resultStatus').textContent === 'complete', null, { timeout: 60000 });
    const score = Number(await page.textContent('#scoreValue'));
    check('analysis runs offline', Number.isFinite(score) && score >= 0 && score <= 100, `score=${score}`);

    const download = page.waitForEvent('download', { timeout: 40000 });
    await page.click('#pdfBtn');
    const bytes = readFileSync(await (await download).path());
    check('PDF exports offline', bytes.subarray(0, 5).toString() === '%PDF-', `${bytes.length} bytes`);

    /* The one thing that legitimately still needs a connection. */
    check('only the STEP reader was ever requested off-origin',
      blocked.every((u) => /occt|fonts\./.test(u)),
      blocked.filter((u) => !/occt|fonts\./.test(u)).join(', ') || 'none');
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${results.join('\n')}\n`);
  console.log(failures === 0
    ? `  ${results.length} offline checks passed\n`
    : `  ${failures} of ${results.length} offline checks FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
