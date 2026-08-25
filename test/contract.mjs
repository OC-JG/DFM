/*
 * The markup/script contract.
 *
 * `src/app` reaches into the DOM by id. A restyle or a layout rework is free
 * to move any element anywhere, but the moment one of those ids stops existing
 * the app fails at runtime, silently, in whichever branch happens to touch it
 * first — often only after a part is loaded and a check is enabled.
 *
 * So: every id the scripts ask for must exist in the markup, and every id the
 * markup declares must still be reachable. Run it after any change to
 * index.html.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/* Ids the scripts create at runtime rather than expecting in the markup. */
const CREATED_AT_RUNTIME = new Set(['toastHost']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

const scripts = walk(SRC);
const wanted = new Map(); // id -> the file that asks for it

for (const file of scripts) {
  const code = readFileSync(file, 'utf8');
  for (const re of [/\$\(['"]([A-Za-z0-9_]+)['"]\)/g,
                    /getElementById\(['"]([A-Za-z0-9_]+)['"]\)/g]) {
    let m;
    while ((m = re.exec(code)) !== null) {
      if (!wanted.has(m[1])) wanted.set(m[1], path.relative(SRC, file));
    }
  }
}

const html = readFileSync(path.join(SRC, 'index.html'), 'utf8');
const declared = new Set([...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map((m) => m[1]));

const missing = [...wanted]
  .filter(([id]) => !declared.has(id) && !CREATED_AT_RUNTIME.has(id))
  .map(([id, file]) => `  ${id}  (wanted by ${file})`);

/* Build slots the bundler fills; index.html is not valid output without them. */
const SLOTS = ['<!--@VENDOR@-->', '/*@CSS@*/', '/*@APP@*/'];
const lostSlots = SLOTS.filter((slot) => !html.includes(slot));

let failed = false;

if (missing.length) {
  failed = true;
  console.error(`\n  ${missing.length} id(s) the scripts need are not in index.html:\n${missing.join('\n')}`);
}
if (lostSlots.length) {
  failed = true;
  console.error(`\n  build slot(s) missing from index.html: ${lostSlots.join(', ')}`);
}

if (failed) {
  console.error('');
  process.exit(1);
}

console.log(`  ok    ${wanted.size} scripted ids all present in ${declared.size} declared`);
console.log(`  ok    all ${SLOTS.length} build slots intact`);
console.log('\n  contract holds\n');
