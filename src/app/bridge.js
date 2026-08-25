/*
 * The Inventor bridge.
 *
 * .ipt is a closed binary format with no browser-side reader, and there is not
 * going to be one. Inventor itself is the reader, so the file goes to a local
 * InventorMCP server, which opens it, exports STEP, and hands back the
 * geometry along with the part's parameter table and feature tree.
 *
 * Going out through STEP rather than STL is not a compromise. STEP carries the
 * B-rep face groups the STL path cannot, which is what lets draft be measured
 * per face rather than per triangle.
 *
 * What the bridge adds over a converter is the return path: the document stays
 * open in Inventor, so a driving parameter can be changed from here and the
 * part re-exported without anyone touching a file. That is the loop the tool
 * exists to close — measure, adjust the dimension that caused the finding,
 * measure again.
 */

const BRIDGE_DEFAULT_URL = 'http://127.0.0.1:8000';

/* Session-scoped, so a user on a non-default port sets it once. */
let bridgeBase = (() => {
  try {
    return localStorage.getItem('dfm.bridgeUrl') || BRIDGE_DEFAULT_URL;
  } catch {
    return BRIDGE_DEFAULT_URL; // private mode, file:// with storage blocked
  }
})();

export function bridgeUrl() {
  return bridgeBase;
}

export function setBridgeUrl(url) {
  bridgeBase = String(url || '').replace(/\/+$/, '') || BRIDGE_DEFAULT_URL;
  try {
    localStorage.setItem('dfm.bridgeUrl', bridgeBase);
  } catch { /* not fatal — the value just will not persist */ }
  return bridgeBase;
}

function bridgeError(message, hint) {
  const error = new Error(hint ? `${message} ${hint}` : message);
  error.bridge = true;
  return error;
}

async function bridgeJson(response) {
  let body = null;
  try {
    body = await response.json();
  } catch { /* a non-JSON body is handled below */ }
  if (body && body.ok === false) {
    throw bridgeError(body.message || 'The bridge refused the request.', body.hint);
  }
  if (!response.ok) {
    throw bridgeError(`The bridge returned ${response.status}.`);
  }
  return body;
}

/*
 * Is anything listening, and can it actually read an .ipt?
 *
 * Answered separately from "is it up", because the server happily runs against
 * its own simulator, which cannot open Inventor files. Reporting that as
 * "connected" would send a user hunting for a network fault that is really a
 * missing --backend inventor.
 */
export async function probeBridge(signal) {
  try {
    const response = await fetch(`${bridgeBase}/bridge/health`, { signal });
    const body = await bridgeJson(response);
    return {
      up: true,
      backend: body.backend,
      readsIpt: !!body.reads_ipt,
      note: body.note || null,
      documents: body.documents || [],
    };
  } catch (err) {
    return {
      up: false,
      backend: null,
      readsIpt: false,
      note: err.bridge
        ? err.message
        : `No InventorMCP server at ${bridgeBase}. Start it with: inventor-mcp --backend inventor --transport streamable-http`,
      documents: [],
    };
  }
}

/*
 * Upload an .ipt and get back the STEP bytes plus everything Inventor knows
 * about the part. The STEP body is fetched as a second request rather than
 * base64 inside the JSON — a few megabytes of geometry does not want to be a
 * string.
 */
export async function openIptViaBridge(file, onProgress) {
  if (onProgress) onProgress(0.05, 'Sending to Inventor');
  const response = await fetch(`${bridgeBase}/bridge/part`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-filename': file.name },
    body: await file.arrayBuffer(),
  }).catch(() => {
    throw bridgeError(
      `Could not reach the InventorMCP server at ${bridgeBase}.`,
      'Start it with: inventor-mcp --backend inventor --transport streamable-http',
    );
  });

  if (onProgress) onProgress(0.3, 'Inventor is opening the part');
  const model = await bridgeJson(response);

  if (onProgress) onProgress(0.5, 'Fetching STEP geometry');
  const step = await fetch(`${bridgeBase}${model.step_url}`);
  if (!step.ok) throw bridgeError('Inventor exported the part but the STEP file could not be fetched.');
  return { buffer: await step.arrayBuffer(), model };
}

/*
 * Change driving parameters on the open document, rebuild, and re-export.
 *
 * `parameters` is `[{ name, value }]`, where value may be a number or an
 * expression such as "wall * 2" — the server evaluates it in Inventor, so
 * whatever the parameter table understands works here.
 */
export async function driveBridgeParameters(docId, parameters, onProgress) {
  if (onProgress) onProgress(0.1, 'Applying parameter change');
  const response = await fetch(`${bridgeBase}/bridge/part/${encodeURIComponent(docId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parameters }),
  }).catch(() => {
    throw bridgeError(`Lost the connection to ${bridgeBase} mid-change.`);
  });

  if (onProgress) onProgress(0.45, 'Inventor is rebuilding');
  const model = await bridgeJson(response);

  if (onProgress) onProgress(0.7, 'Fetching rebuilt geometry');
  const step = await fetch(`${bridgeBase}${model.step_url}`);
  if (!step.ok) throw bridgeError('The rebuild succeeded but the STEP export could not be fetched.');
  return { buffer: await step.arrayBuffer(), model };
}
