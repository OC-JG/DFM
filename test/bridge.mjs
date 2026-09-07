/*
 * Tests for the Inventor loop.
 *
 * This is the feature the tool exists for — open an .ipt, change the dimension
 * that caused a finding, measure again, without touching a file — and it had
 * no test at all. It was verified by hand, against a live Inventor, on
 * someone's Windows machine, which is exactly the arrangement under which a
 * thing quietly stops working between sessions.
 *
 * lib/fake-bridge.mjs is a real HTTP server speaking the real protocol, so
 * src/app/bridge.js runs its actual fetch calls here. It rebuilds rather than
 * returning a canned payload, which is what lets the loop be proved by
 * measurement: drive `wall` to 3 and the tool has to come back reading 3 mm.
 *
 * Needs no Inventor, no browser and no network beyond localhost.
 * Run: node test/bridge.mjs
 */

import { createRequire } from 'node:module';
import { startFakeBridge } from './lib/fake-bridge.mjs';
import { probeBridge, openIptViaBridge, driveBridgeParameters, setBridgeUrl, bridgeUrl } from '../src/app/bridge.js';
import { parseSTEP } from '../src/geometry/step.js';
import { analyseMesh } from '../src/analysis/mesh.js';
import { validateGeometry } from '../src/geometry/validate.js';
import { MATERIALS } from '../src/core/materials.js';

const require = createRequire(import.meta.url);
const occt = await (require('occt-import-js'))();

let passed = 0;
const failures = [];
let group = '';

function describe(name) { group = name; console.log(`\n${name}`); }
async function it(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(`${group} › ${name}: ${err.message}`);
    console.log(`  FAIL  ${name}\n          ${err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg = '') {
  if (actual !== expected) throw new Error(`${msg} expected ${expected}, got ${actual}`);
}
function close(actual, expected, tol, msg = '') {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg} expected ${expected} ±${tol}, got ${actual}`);
}

process.on('unhandledRejection', (err) => {
  console.log(`\n  UNHANDLED REJECTION — a test body escaped its harness\n          ${err && err.message}\n`);
  process.exit(1);
});

/* The bridge takes a File-like object: a name and a promise of bytes. */
const fakeIpt = (name = 'BridgePart.ipt') => ({
  name,
  arrayBuffer: async () => new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer,  // an OLE header, as an .ipt has
});

const measure = async (buffer) => {
  const geom = await parseSTEP(buffer, null, occt);
  return { geom, mesh: analyseMesh(geom, { material: MATERIALS.abs, minDraft: 0.5, pullAxis: '+z' }) };
};

/* Each test gets its own server, so a fault in one cannot leak into the next. */
async function withBridge(opts, fn) {
  const server = await startFakeBridge(opts);
  const previous = bridgeUrl();
  setBridgeUrl(server.url);
  try {
    return await fn(server);
  } finally {
    setBridgeUrl(previous);
    await server.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════

describe('bridge — the three states the header chip reports');
{
  await it('a real Inventor reads .ipt and says so', async () => {
    await withBridge({ backend: 'inventor' }, async () => {
      const health = await probeBridge();
      assert(health.up, 'server reported down');
      eq(health.readsIpt, true, 'readsIpt:');
      eq(health.backend, 'inventor', 'backend:');
    });
  });

  await it('the simulator is up but cannot open a part, and does not pretend otherwise', async () => {
    /* The distinction that exists so a user is not sent hunting for a network
       fault that is really a missing --backend inventor. */
    await withBridge({ backend: 'simulator' }, async () => {
      const health = await probeBridge();
      eq(health.up, true, 'up:');
      eq(health.readsIpt, false, 'readsIpt:');
      assert(/--backend inventor/.test(health.note || ''), `note did not name the fix: ${health.note}`);
    });
  });

  await it('nothing listening reports the command that starts it', async () => {
    /* Pointed at a port that was open and is now closed, so the connection is
       refused rather than hanging. */
    const server = await startFakeBridge();
    const dead = server.url;
    await server.close();
    const previous = bridgeUrl();
    setBridgeUrl(dead);
    try {
      const health = await probeBridge();
      eq(health.up, false, 'up:');
      eq(health.readsIpt, false, 'readsIpt:');
      assert(/inventor-mcp --backend inventor/.test(health.note),
        `note did not carry the command: ${health.note}`);
    } finally {
      setBridgeUrl(previous);
    }
  });
}

describe('bridge — opening a part');
{
  await it('an .ipt comes back as measurable geometry and a parameter table', async () => {
    await withBridge({}, async () => {
      const { buffer, model } = await openIptViaBridge(fakeIpt(), () => {});
      const { mesh } = await measure(buffer);

      eq(model.document, 'doc-1', 'document id:');
      close(mesh.wallStats.median, 2, 0.05, 'wall as opened:');
      const driving = model.parameters.filter((p) => p.kind !== 'model');
      eq(driving.length, 2, 'driving parameters:');
      assert(driving.some((p) => p.name === 'wall'), 'no wall parameter');
      eq(model.features.length, 3, 'features:');
    });
  });

  await it('progress is reported while Inventor works', async () => {
    /* The rebuild takes seconds against a real Inventor. A caller that cannot
       show progress leaves the user looking at a frozen page. */
    await withBridge({}, async () => {
      const seen = [];
      await openIptViaBridge(fakeIpt(), (pct, label) => seen.push([pct, label]));
      assert(seen.length >= 2, `expected several progress reports, got ${seen.length}`);
      assert(seen.every(([p]) => p >= 0 && p <= 1), 'a progress fraction was out of range');
      assert(seen.some(([, l]) => /Inventor/.test(l)), 'no progress label mentioned Inventor');
    });
  });
}

describe('bridge — the loop: change the dimension, measure again');
{
  await it('driving a parameter changes the geometry that comes back', async () => {
    /* The whole feature, asserted end to end. Not "the request was made" — the
       wall the tool measures afterwards is the wall that was asked for. */
    await withBridge({}, async (server) => {
      const opened = await openIptViaBridge(fakeIpt(), () => {});
      const before = await measure(opened.buffer);
      close(before.mesh.wallStats.median, 2, 0.05, 'wall before:');

      const rebuilt = await driveBridgeParameters(opened.model.document, [{ name: 'wall', value: 3 }], () => {});
      const after = await measure(rebuilt.buffer);
      close(after.mesh.wallStats.median, 3, 0.05, 'wall after:');

      eq(server.rebuildCount(), 1, 'rebuilds:');
      const wall = rebuilt.model.parameters.find((p) => p.name === 'wall');
      eq(wall.value, 3, 'reported parameter value:');
    });
  });

  await it('the rebuilt part is still a B-rep, with its faces intact', async () => {
    /* The rebuild must not quietly come back as a mesh: everything R2.2 added
       — draft per face, fitted radii — depends on the faces surviving the
       round trip. */
    await withBridge({}, async () => {
      const opened = await openIptViaBridge(fakeIpt(), () => {});
      const rebuilt = await driveBridgeParameters(opened.model.document, [{ name: 'wall', value: 2.5 }], () => {});
      const { geom, mesh } = await measure(rebuilt.buffer);
      assert(geom.faceGroups && geom.faceGroups.length, 'the rebuilt geometry carried no faces');
      eq(mesh.measuredFrom, 'brep', 'provenance after a rebuild:');
    });
  });

  await it('two changes in a row both land', async () => {
    await withBridge({}, async (server) => {
      const opened = await openIptViaBridge(fakeIpt(), () => {});
      await driveBridgeParameters(opened.model.document, [{ name: 'wall', value: 3 }], () => {});
      const second = await driveBridgeParameters(opened.model.document, [{ name: 'height', value: 30 }], () => {});
      const { geom } = await measure(second.buffer);

      eq(server.rebuildCount(), 2, 'rebuilds:');
      let maxZ = -Infinity;
      for (let i = 2; i < geom.vertices.length; i += 3) maxZ = Math.max(maxZ, geom.vertices[i]);
      close(maxZ, 30, 0.05, 'height after the second change:');
      close((await measure(second.buffer)).mesh.wallStats.median, 3, 0.05, 'the first change survived the second:');
    });
  });
}

describe('bridge — the ways it goes wrong');
{
  await it('a modal dialog in Inventor is reported as a modal dialog', async () => {
    /* A real failure mode with a specific fix, and the message has to carry
       the fix rather than a status code. */
    await withBridge({ fault: 'modal' }, async () => {
      let threw = null;
      try { await openIptViaBridge(fakeIpt(), () => {}); } catch (err) { threw = err; }
      assert(threw, 'a modal dialog was not reported at all');
      assert(/waiting on a dialog/.test(threw.message), `message did not name the cause: ${threw.message}`);
      assert(/dismiss the dialog/i.test(threw.message), `message did not carry the fix: ${threw.message}`);
    });
  });

  await it('a rejected parameter change explains itself', async () => {
    await withBridge({ fault: 'reject-edit' }, async () => {
      const opened = await openIptViaBridge(fakeIpt(), () => {});
      let threw = null;
      try {
        await driveBridgeParameters(opened.model.document, [{ name: 'wall', value: 999 }], () => {});
      } catch (err) { threw = err; }
      assert(threw, 'a refused rebuild was not reported');
      assert(/failed to rebuild/.test(threw.message), `message did not name the cause: ${threw.message}`);
      assert(/unsolvable|Undo/.test(threw.message), `message did not carry the hint: ${threw.message}`);
    });
  });

  await it('a value Inventor cannot evaluate is refused by name', async () => {
    await withBridge({}, async () => {
      const opened = await openIptViaBridge(fakeIpt(), () => {});
      let threw = null;
      try {
        await driveBridgeParameters(opened.model.document, [{ name: 'wall', value: 'not a number' }], () => {});
      } catch (err) { threw = err; }
      assert(threw, 'an unevaluable expression was accepted');
      assert(/wall/.test(threw.message), `message did not name the parameter: ${threw.message}`);
    });
  });

  await it('a model whose STEP body is missing does not pass for success', async () => {
    /* The model JSON arrives, so the request "worked" — and there is no
       geometry behind it. Reported as an export failure, not as an empty part. */
    await withBridge({ fault: 'step-missing' }, async () => {
      let threw = null;
      try { await openIptViaBridge(fakeIpt(), () => {}); } catch (err) { threw = err; }
      assert(threw, 'a missing STEP body was not reported');
      assert(/STEP/.test(threw.message), `message did not name what failed: ${threw.message}`);
    });
  });

  await it('a request that never answers can be given up on', async () => {
    /* Inventor can sit on a rebuild indefinitely. The bridge takes an abort
       signal on the probe so a caller is not stuck for ever; this asserts the
       signal is honoured rather than ignored. */
    await withBridge({ fault: 'hang' }, async () => {
      const control = new AbortController();
      const timer = setTimeout(() => control.abort(), 250);
      const health = await probeBridge(control.signal);
      clearTimeout(timer);
      eq(health.up, false, 'a hung server reported as up:');
      assert(health.note, 'a hung server produced no explanation');
    });
  });

  await it('a rebuild that comes back in inches is caught by mesh health, not silently measured', async () => {
    /* The quiet one. Nothing errors: the geometry is valid, it is just 25.4×
       too small, and every threshold in this tool is in millimetres. The unit
       check is what stands between that and a confident wrong score. */
    await withBridge({ fault: 'scale-drift' }, async () => {
      const opened = await openIptViaBridge(fakeIpt(), () => {});
      const rebuilt = await driveBridgeParameters(opened.model.document, [{ name: 'wall', value: 2 }], () => {});
      const geom = await parseSTEP(rebuilt.buffer, null, occt);
      const report = validateGeometry(geom);
      assert(report.issues.some((i) => /unit|scale|mm|small/i.test(`${i.title} ${i.detail}`)),
        `an inch-scaled rebuild raised no unit issue: ${report.issues.map((i) => i.title).join(', ') || 'none'}`);
    });
  });
}

describe('bridge — the protocol contract');
{
  await it('the bridge calls the routes InventorMCP publishes, and no others', async () => {
    /* InventorMCP is a separate repository on its own release cycle. Nothing
       today would notice a renamed route until a user did, so the calls are
       recorded here: if this test fails, either the bridge changed or the
       server it talks to did, and both are worth a deliberate look. */
    await withBridge({}, async (server) => {
      const opened = await openIptViaBridge(fakeIpt(), () => {});
      await driveBridgeParameters(opened.model.document, [{ name: 'wall', value: 3 }], () => {});
      await probeBridge();

      const seen = server.calls.map((c) => `${c.method} ${c.path}`);
      const expected = [
        'POST /bridge/part',
        'GET /bridge/step/doc-1',
        'PATCH /bridge/part/doc-1',
        'GET /bridge/step/doc-1',
        'GET /bridge/health',
      ];
      eq(seen.join(' | '), expected.join(' | '), 'route sequence:');
    });
  });

  await it('the upload carries the file name Inventor needs to open it', async () => {
    await withBridge({}, async (server) => {
      await openIptViaBridge(fakeIpt('Bracket R3.ipt'), () => {});
      const post = server.calls.find((c) => c.method === 'POST');
      eq(post.headers['x-filename'], 'Bracket R3.ipt', 'x-filename header:');
      eq(post.headers['content-type'], 'application/octet-stream', 'content-type:');
    });
  });

  await it('a parameter change is a PATCH on the document, carrying JSON', async () => {
    await withBridge({}, async (server) => {
      const opened = await openIptViaBridge(fakeIpt(), () => {});
      await driveBridgeParameters(opened.model.document, [{ name: 'wall', value: 3 }], () => {});
      const patch = server.calls.find((c) => c.method === 'PATCH');
      eq(patch.path, '/bridge/part/doc-1', 'patch path:');
      eq(patch.headers['content-type'], 'application/json', 'content-type:');
    });
  });
}

// ── report ─────────────────────────────────────────────────────────────────

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} of ${passed + failures.length} assertions FAILED\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`  ${passed} bridge assertions passed\n`);
