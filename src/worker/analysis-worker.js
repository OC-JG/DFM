import { analyseMesh } from '../analysis/mesh.js';
import { analyseInterface } from '../analysis/interface.js';

/*
 * Analysis worker.
 *
 * Mesh analysis is several seconds of tight ray-casting on a large part. Run
 * on the main thread — as the original did — it blocks every repaint, so the
 * progress bar it dutifully updated could never actually draw and the tab
 * simply froze. Here the work happens off-thread and progress messages arrive
 * while it runs.
 *
 * This module is bundled twice: once as the worker body (embedded as a string
 * and started from a Blob URL) and once into the app bundle, because Chrome
 * refuses blob-backed workers on file:// origins and the app then falls back
 * to running the same code inline. See runAnalysisJob in app/analysis-runner.js.
 */

export function runAnalysisJob(job, onProgress) {
  const report = (pct, label) => { if (onProgress) onProgress(pct, label); };

  report(0.05, 'Analysing part');
  const shot1 = analyseMesh(job.geom1, {
    ...job.opts1,
    onProgress: (p, label) => report(0.05 + p * (job.geom2 ? 0.6 : 0.9), label),
  });

  let shot2 = null;
  let iface = null;
  if (job.geom2) {
    report(0.7, 'Analysing overmould');
    shot2 = analyseMesh(job.geom2, {
      ...job.opts2,
      onProgress: (p, label) => report(0.7 + p * 0.2, label),
    });
    report(0.92, 'Measuring interface');
    iface = analyseInterface(job.geom1, shot1.bvh, shot2, job.interfaceMaxDist);
  }

  report(1, 'Done');
  return { shot1, shot2, iface };
}

/*
 * Strip everything that cannot cross a structured clone, or that the main
 * thread has no use for. The BVH is by far the biggest object in the result
 * and its only consumer is the interface pass, which has already run.
 */
export function stripForTransfer(result) {
  if (result.shot1) delete result.shot1.bvh;
  if (result.shot2) delete result.shot2.bvh;
  return result;
}

/* Collect every ArrayBuffer in the result so it can be moved rather than
   copied back to the main thread. */
export function collectTransferables(value, out = [], seen = new Set()) {
  if (!value || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (ArrayBuffer.isView(value)) {
    if (!out.includes(value.buffer)) out.push(value.buffer);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectTransferables(v, out, seen);
    return out;
  }
  for (const key of Object.keys(value)) collectTransferables(value[key], out, seen);
  return out;
}

/* Only wire up the message handler when actually running as a worker — the
   same bundle is loaded on the main thread for the fallback path. */
if (typeof self !== 'undefined' && typeof importScripts === 'function' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    const { id, job } = e.data;
    try {
      const result = runAnalysisJob(job, (pct, label) => {
        self.postMessage({ id, type: 'progress', pct, label });
      });
      stripForTransfer(result);
      self.postMessage({ id, type: 'done', result }, collectTransferables(result));
    } catch (err) {
      self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
    }
  };
}
