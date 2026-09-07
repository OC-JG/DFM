/*
 * A stand-in for InventorMCP.
 *
 * The Inventor loop is the feature this tool exists for — open an .ipt, change
 * the dimension that caused a finding, measure again without touching a file —
 * and until now it had no test at all: `grep -i bridge test/*.mjs` returned
 * nothing. It was verified by hand, against a live Inventor, on someone's
 * Windows machine.
 *
 * This is a fixture, not a mock of the network layer. It is a real HTTP server
 * speaking the real protocol, so `bridge.js` runs its actual fetch calls
 * against it and the test exercises everything a live server would: the
 * routes, the headers, the two-request STEP fetch, the error convention.
 *
 * The important part is that it *rebuilds*. A parameter change regenerates the
 * STEP from the analytic solid with the new value, so the loop can be proved
 * by measurement rather than by wiring: set `wall = 3` and the tool must come
 * back reading a 3 mm wall. A server that returned a canned payload would pass
 * a test that proves nothing.
 *
 * Payloads were shaped against the routes src/app/bridge.js calls as of
 * 2026-09-07. If InventorMCP changes its protocol, the contract test in
 * test/bridge.mjs is what should fail first.
 */

import { createServer } from 'node:http';
import { writeStepSolids } from './step-write.mjs';
import { stepCup } from './solids.mjs';

/* The document the fake Inventor is holding open, and the parameters that
   drive it. `wall` is the one that changes the geometry, which is what makes
   the round trip measurable. */
const DEFAULT_PARAMETERS = [
  { name: 'wall', expression: '2 mm', value: 2, unit: 'mm', kind: 'user', comment: 'Nominal wall' },
  { name: 'height', expression: '20 mm', value: 20, unit: 'mm', kind: 'user', comment: 'Overall height' },
  { name: 'g_internal', expression: '1 mm', value: 1, unit: 'mm', kind: 'model', comment: 'Not user-driven' },
];

const FEATURES = [
  { kind: 'ExtrudeFeature', name: 'Body', suppressed: false },
  { kind: 'ShellFeature', name: 'Shell1', suppressed: false },
  { kind: 'FilletFeature', name: 'EdgeFillet', suppressed: true },
];

/*
 * opts.backend      'inventor' (reads .ipt) or 'simulator' (does not)
 * opts.fault        one of:
 *   'modal'         Inventor is sitting on a dialog and will not open a part
 *   'reject-edit'   the rebuild refuses the new parameter value
 *   'step-missing'  the model is returned but its STEP body 404s
 *   'scale-drift'   the rebuild comes back in inches — the silent one
 *   'hang'          the request never gets a reply
 */
export async function startFakeBridge(opts = {}) {
  const backend = opts.backend || 'inventor';
  const fault = opts.fault || null;

  const params = DEFAULT_PARAMETERS.map((p) => ({ ...p }));
  const calls = [];
  let rebuilds = 0;

  const paramValue = (name) => {
    const p = params.find((q) => q.name === name);
    return p ? p.value : null;
  };

  /* The geometry the fake Inventor would export, built from the parameters it
     is currently holding — so a changed wall really does come back changed. */
  const stepFor = (scale = 1) => {
    const wall = paramValue('wall'), height = paramValue('height');
    const cup = stepCup([40 * scale, 30 * scale, height * scale], wall * scale);
    return writeStepSolids([cup], 'BridgePart');
  };

  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  /* The server's own error shape: an ok:false body carrying a message and a
     hint, which bridge.js turns into the text a user sees. */
  const refuse = (res, message, hint) => json(res, 200, { ok: false, message, hint });

  const model = (scale = 1) => ({
    ok: true,
    document: 'doc-1',
    name: 'BridgePart.ipt',
    step_url: `/bridge/step/doc-1?r=${rebuilds}&s=${scale}`,
    parameters: params.map((p) => ({ ...p })),
    features: FEATURES,
    units: scale === 1 ? 'mm' : 'in',
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    /* The page and the bridge are always different origins — the tool is
       opened from a file or a static server, the bridge listens on its own
       port — so the real server allows localhost and file:// origins, and so
       must this one or the browser never delivers the request. */
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-filename');
    if (req.method === 'OPTIONS') {
      /* Deliberately not recorded: a preflight is transport, not protocol, and
         the contract test is about the calls the bridge chose to make. */
      res.writeHead(204);
      return res.end();
    }

    calls.push({ method: req.method, path: url.pathname, headers: req.headers });

    if (fault === 'hang') return;   // no reply, ever

    // ── health ───────────────────────────────────────────────────────────
    if (url.pathname === '/bridge/health') {
      return json(res, 200, {
        ok: true,
        backend,
        reads_ipt: backend === 'inventor',
        note: backend === 'inventor' ? null : 'Running the built-in simulator; .ipt files need --backend inventor.',
        documents: ['BridgePart.ipt'],
      });
    }

    // ── open a part ──────────────────────────────────────────────────────
    if (url.pathname === '/bridge/part' && req.method === 'POST') {
      if (fault === 'modal') {
        return refuse(res, 'Inventor is waiting on a dialog and cannot open a part.',
          'Switch to Inventor, dismiss the dialog, and try again.');
      }
      /* Drain the upload: the bridge sends the .ipt bytes, and a server that
         does not read them leaves the socket half-closed. */
      for await (const _chunk of req) { void _chunk; }
      return json(res, 200, model());
    }

    // ── drive a parameter and rebuild ────────────────────────────────────
    if (url.pathname.startsWith('/bridge/part/') && req.method === 'PATCH') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const patch = JSON.parse(body || '{}');

      if (fault === 'reject-edit') {
        return refuse(res, 'Inventor rejected the value: the part failed to rebuild.',
          'The sketch it drives became unsolvable. Undo in Inventor, or try a smaller change.');
      }

      for (const { name, value } of patch.parameters || []) {
        const p = params.find((q) => q.name === name);
        if (!p) return refuse(res, `No parameter named ${name} on this document.`);
        const numeric = typeof value === 'number' ? value : parseFloat(String(value));
        if (!Number.isFinite(numeric)) {
          return refuse(res, `Inventor could not evaluate "${value}" for ${name}.`);
        }
        p.value = numeric;
        p.expression = `${numeric} ${p.unit}`;
      }
      rebuilds++;
      return json(res, 200, model(fault === 'scale-drift' ? 1 / 25.4 : 1));
    }

    // ── the STEP body, fetched separately from the model JSON ────────────
    if (url.pathname.startsWith('/bridge/step/')) {
      if (fault === 'step-missing') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('gone');
      }
      const text = stepFor(Number(url.searchParams.get('s')) || 1);
      res.writeHead(200, { 'content-type': 'application/step', 'content-length': Buffer.byteLength(text) });
      return res.end(text);
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such route');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /* Every request the bridge actually made, in order — the raw material for
       the protocol contract. */
    calls,
    parameters: () => params.map((p) => ({ ...p })),
    rebuildCount: () => rebuilds,
    close: () => new Promise((r) => server.close(r)),
  };
}
