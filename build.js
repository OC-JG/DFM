#!/usr/bin/env node
/*
 * build.js — bundles src/ into a single self-contained dfm-tool.html
 *
 * Zero dependencies. Deliberately so: the output is a file you double-click
 * from a Downloads folder, and the build that produces it should not need
 * an npm install to run three years from now.
 *
 * The bundler is a minimal ES-module concatenator, not a general one. It
 * assumes the conventions this codebase actually follows:
 *   - named `export` only (no default, no `export *`, no re-export)
 *   - static relative imports only (no dynamic import of local modules)
 *   - no top-level name collisions across modules (checked, and fatal)
 * Anything outside that is rejected loudly rather than mis-bundled.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dfm-tool.html');

/* ---------------------------------------------------------------- helpers */

const read = (p) => fs.readFileSync(p, 'utf8');

function fail(msg) {
  console.error(`\n  build error: ${msg}\n`);
  process.exit(1);
}

/* --------------------------------------------------------------- bundling */

const IMPORT_RE = /^\s*import\s+(?:{[^}]*}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;
const BARE_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/gm;
/* Namespace imports need a synthesised object — concatenation alone would
   leave `viewer.setView(...)` pointing at nothing. Captured separately. */
const NS_IMPORT_RE = /^\s*import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;

/* Names a module exports. */
function exportedNames(code) {
  const names = [];
  const re = /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code)) !== null) names.push(m[1]);
  return names;
}

/* All top-level declarations, used for collision detection. */
function topLevelNames(code) {
  const names = exportedNames(code);
  const re2 = /^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re2.exec(code)) !== null) names.push(m[1]);
  const re3 = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = re3.exec(code)) !== null) names.push(m[1]);
  return names;
}

function collectDeps(entry) {
  const order = [];
  const seen = new Map(); // abs path -> 'visiting' | 'done'

  function visit(abs, importedBy) {
    const state = seen.get(abs);
    if (state === 'done') return;
    if (state === 'visiting') {
      fail(`circular import reaching ${path.relative(SRC, abs)} (via ${path.relative(SRC, importedBy)})`);
    }
    if (!fs.existsSync(abs)) {
      fail(`missing module ${path.relative(SRC, abs)} imported by ${path.relative(SRC, importedBy || abs)}`);
    }
    seen.set(abs, 'visiting');

    const code = read(abs);
    if (/^\s*export\s+default/m.test(code)) fail(`default export in ${path.relative(SRC, abs)} — use named exports`);
    if (/^\s*export\s+\*/m.test(code)) fail(`re-export in ${path.relative(SRC, abs)} — not supported`);

    for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code)) !== null) {
        const spec = m[1];
        if (!spec.startsWith('.')) fail(`bare import "${spec}" in ${path.relative(SRC, abs)} — only relative paths are bundled`);
        visit(path.resolve(path.dirname(abs), spec), abs);
      }
    }

    seen.set(abs, 'done');
    order.push(abs);
  }

  visit(path.resolve(entry), null);
  return order;
}

function bundle(entry, label) {
  const files = collectDeps(entry);
  const declared = new Map(); // name -> file
  const parts = [];
  let namespaceCount = 0;

  for (const abs of files) {
    const rel = path.relative(SRC, abs);
    let code = read(abs);

    for (const name of topLevelNames(code)) {
      if (declared.has(name) && declared.get(name) !== rel) {
        fail(`"${name}" declared in both ${declared.get(name)} and ${rel} — top-level names must be unique across the bundle`);
      }
      declared.set(name, rel);
    }

    /* Rebuild `import * as NS` as a plain object literal over the target
       module's exports. Dependency order guarantees those declarations are
       already in scope by the time this line is reached. */
    const namespaces = [];
    NS_IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = NS_IMPORT_RE.exec(code)) !== null) {
      const [, alias, spec] = m;
      const targetAbs = path.resolve(path.dirname(abs), spec);
      const names = exportedNames(read(targetAbs));
      if (!names.length) fail(`${rel} imports * as ${alias} from ${spec}, which exports nothing`);
      if (declared.has(alias) && declared.get(alias) !== rel) {
        fail(`namespace alias "${alias}" in ${rel} collides with a declaration in ${declared.get(alias)}`);
      }
      declared.set(alias, rel);
      namespaces.push(`const ${alias} = { ${names.join(', ')} };`);
      namespaceCount++;
    }

    code = code.replace(IMPORT_RE, '').replace(BARE_IMPORT_RE, '');
    code = code.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, '');
    if (/^\s*export[\s{]/m.test(code)) {
      fail(`unhandled export syntax in ${rel} — only "export <decl>" is supported`);
    }
    if (namespaces.length) code = `${namespaces.join('\n')}\n\n${code.trim()}`;

    parts.push(`/* ==== ${rel} ${'='.repeat(Math.max(0, 62 - rel.length))} */\n${code.trim()}\n`);
  }

  console.log(`  ${label}: ${files.length} modules, ${declared.size} top-level names${namespaceCount ? `, ${namespaceCount} namespace imports` : ''}`);
  return parts.join('\n');
}

/* ------------------------------------------------------------------ build */

console.log('\n  OnlyCat DFM — build\n');

const css = read(path.join(SRC, 'styles/app.css'));
const logo = read(path.join(SRC, 'assets/logo.png.b64')).trim();

/* The worker is bundled separately and embedded as a string. It is started
   from a Blob URL so the single-file output stays single-file. Browsers that
   refuse blob workers on file:// (Chrome) fall back to main-thread analysis,
   which is why the worker's module graph is also part of the main bundle. */
const workerCode = bundle(path.join(SRC, 'worker/analysis-worker.js'), 'worker');
const appCode = bundle(path.join(SRC, 'app/main.js'), 'app');

let html = read(path.join(SRC, 'index.html'));

const slots = {
  '/*@CSS@*/': css,
  '/*@APP@*/': appCode,
  '@LOGO@': logo,
};
for (const [token, value] of Object.entries(slots)) {
  if (!html.includes(token)) fail(`slot ${token} not found in src/index.html`);
  html = html.replace(token, () => value);
}

/* Worker source is injected into the app bundle rather than the HTML so it
   sits next to the code that consumes it. JSON.stringify handles escaping. */
if (!html.includes('/*@WORKER_SRC@*/')) fail('slot /*@WORKER_SRC@*/ not found');
html = html.replace('/*@WORKER_SRC@*/', () => JSON.stringify(workerCode));

fs.writeFileSync(OUT, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`\n  wrote dfm-tool.html  (${kb} kB)\n`);
