import { runAnalysisJob } from '../worker/analysis-worker.js';
import { nextFrame } from './dom.js';

/*
 * Dispatch an analysis job to a worker, falling back to the main thread.
 *
 * The worker is started from a Blob URL so the built file stays a single
 * self-contained HTML document. Chrome refuses blob-backed workers when the
 * page origin is `file://`, which is exactly how this tool gets opened, so
 * the fallback is a first-class path rather than a safety net: it runs the
 * identical bundled code inline, yielding a frame between phases so the
 * progress bar still moves.
 */

/* Replaced at build time with the bundled worker source. */
const WORKER_SOURCE = /*@WORKER_SRC@*/;

let activeWorker = null;
let workerUnavailable = false;
let nextJobId = 1;

/*
 * Construct the worker, or decide once that we cannot.
 *
 * On a file:// page Chrome throws synchronously from the Worker constructor
 * because the blob inherits an opaque origin, so the try/catch here is the
 * whole detection mechanism — no feature test would tell us.
 */
export function initWorker() {
  if (workerUnavailable) return false;
  if (activeWorker) return true;
  try {
    const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    activeWorker = new Worker(url);
    /* The worker keeps its own reference to the script once constructed. */
    URL.revokeObjectURL(url);
    return true;
  } catch {
    workerUnavailable = true;
    activeWorker = null;
    return false;
  }
}

export function isWorkerActive() {
  return !workerUnavailable && activeWorker != null;
}

/*
 * Geometry is structured-cloned into the worker rather than transferred: the
 * viewer still owns those buffers and a transfer would detach them out from
 * under the render loop. Results come back transferred, since the worker's
 * copies are disposable.
 */
export async function runAnalysis(job, onProgress) {
  if (!initWorker()) return runInline(job, onProgress);
  const worker = activeWorker;

  return new Promise((resolve, reject) => {
    const id = nextJobId++;
    const onMessage = (e) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') {
        if (onProgress) onProgress(msg.pct, msg.label);
      } else if (msg.type === 'done') {
        cleanup();
        resolve(msg.result);
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.message));
      }
    };
    const onError = (err) => {
      cleanup();
      /* A worker that fails at the top level — most often the file:// blob
         restriction, when the browser reports it asynchronously rather than
         throwing — retires the worker path for the rest of the session. */
      workerUnavailable = true;
      activeWorker = null;
      runInline(job, onProgress).then(resolve, reject);
      if (err && err.preventDefault) err.preventDefault();
    };
    function cleanup() {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    }

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ id, job });
  });
}

/*
 * Main-thread path. The phases inside analyseMesh are synchronous, so the
 * yields here are between meshes rather than inside them — enough to get the
 * overlay painted and the label updated, which is more than the original
 * managed.
 */
async function runInline(job, onProgress) {
  await nextFrame();
  const result = runAnalysisJob(job, onProgress);
  await nextFrame();
  return result;
}
