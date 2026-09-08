/*
 * Subresource integrity for the three runtime loads.
 *
 * The default build fetches three things at runtime: three.js up front, and
 * jsPDF and the OpenCascade STEP reader on first use. Without `integrity`
 * attributes, a compromised or mistaken CDN can serve different code to a tool
 * that people use to decide what a mould costs.
 *
 * ── why this file computes nothing on its own ────────────────────────────
 *
 * An `integrity` attribute does not degrade a page, it kills it: a hash that
 * does not match the served bytes means the resource is discarded and the
 * viewer never appears. So the value has to be the hash of *the bytes the CDN
 * actually serves*, and the obvious shortcut — hashing the copies in
 * `node_modules`, which are the same versions — is a bet that the npm tarball
 * and the CDN's build are byte-identical. They usually are. "Usually" is not a
 * property to hang the viewer on, and the failure is total rather than
 * graceful.
 *
 * This file therefore fetches, and reports. It writes nothing: the attributes
 * are printed for someone to paste, having read them, on a machine where the
 * page can be opened afterwards to confirm it still boots. It also says
 * whether each CDN copy matched its `node_modules` copy — which is the piece
 * of evidence nobody has had, and which decides whether the shortcut above was
 * ever safe.
 *
 * Run: node sri.js        (needs network access to the two CDNs)
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/*
 * Every URL the built tool fetches at runtime, and where it comes from.
 *
 * Three files, which is the reason this list exists at all: a version bumped
 * in one place leaves a stale hash in another, and the only thing that would
 * notice is a blank page. `test/unit.mjs` asserts this list and the sources
 * still agree, in both directions.
 */
export const RUNTIME_LOADS = [
  {
    name: 'three.js',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    site: 'src/index.html',
    /* A static <script>, so the attribute goes on the tag — together with
       crossorigin="anonymous", without which a cross-origin response is opaque
       and the integrity check fails no matter what the hash says. */
    how: 'add integrity="…" crossorigin="anonymous" to the <script> tag',
    local: 'node_modules/three/build/three.min.js',
  },
  {
    name: 'jsPDF',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    site: 'src/export/pdf.js',
    /* Loaded on demand by creating a <script> element, so the attribute has to
       be set on that element: script.integrity = '…'; script.crossOrigin =
       'anonymous'. */
    how: 'set .integrity and .crossOrigin on the script element the loader creates',
    local: 'node_modules/jspdf/dist/jspdf.umd.min.js',
  },
  {
    name: 'occt-import-js',
    url: 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.js',
    site: 'src/geometry/step.js',
    /* The same, and with a caveat worth knowing before starting: this loader
       pulls a .wasm of its own afterwards, from a URL this hash does not
       cover. Pinning the loader is worth doing and is not the whole job. */
    how: 'set .integrity and .crossOrigin on the script element; note the .wasm it then fetches is not covered',
    local: 'node_modules/occt-import-js/dist/occt-import-js.js',
  },
];

/*
 * The attribute value for a resource: the algorithm, a hyphen, and the digest
 * base64-encoded — base64 of the raw digest bytes, not of its hex text, which
 * is the mistake that produces a plausible-looking string that never matches.
 */
export function sriHash(bytes, algorithm = 'sha384') {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`;
}

/* ------------------------------------------------------------------- CLI */

async function main() {
  console.log('\n  Subresource integrity — the three runtime loads\n');

  let mismatches = 0;
  let unreachable = 0;

  for (const load of RUNTIME_LOADS) {
    console.log(`  ${load.name}`);
    console.log(`    ${load.url}`);

    let served = null;
    try {
      const res = await fetch(load.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      served = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      unreachable++;
      console.log(`    UNREACHABLE — ${err.message}`);
      console.log('    No hash printed. A guessed integrity attribute takes the page out entirely,');
      console.log('    so this is the one thing here that must not be worked around.\n');
      continue;
    }

    const servedHash = sriHash(served);
    console.log(`    served    ${served.length} bytes   ${servedHash}`);

    const localPath = path.join(HERE, load.local);
    if (existsSync(localPath)) {
      const localHash = sriHash(readFileSync(localPath));
      const same = localHash === servedHash;
      if (!same) mismatches++;
      console.log(`    node_modules copy ${same ? 'matches' : 'DIFFERS'} — ${localHash}`);
    } else {
      console.log('    node_modules copy not present (run npm install to compare)');
    }

    console.log(`    ${load.site}: ${load.how}`);
    console.log(`    integrity="${servedHash}"\n`);
  }

  console.log('  After editing, rebuild and open the file. A wrong attribute is a blank');
  console.log('  viewer rather than a warning, so the check is that the tool still boots —');
  console.log('  and for jsPDF and the STEP reader, that an export and a STEP import still');
  console.log('  work, since those two are only fetched when first used.\n');

  if (unreachable) {
    console.log(`  ${unreachable} of ${RUNTIME_LOADS.length} could not be fetched. Nothing to paste for those.\n`);
    return 1;
  }
  if (mismatches) {
    console.log(`  ${mismatches} CDN copy/copies differ from node_modules. Worth recording: it means`);
    console.log('  hashing the local copies would have produced an attribute that kills the page.\n');
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(await main());
}
