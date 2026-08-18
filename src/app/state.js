/*
 * Application state.
 *
 * Two halves, deliberately separated:
 *
 *   settings — everything the user configures. Serialisable, persisted to
 *              localStorage, and restored on the next visit. The original
 *              kept all of this in the DOM and threw it away on reload, so
 *              "Start over" was a full page refresh and an accidental one
 *              cost you every input.
 *
 *   runtime  — geometry, analyses and view state. Large, non-serialisable,
 *              and meaningless between sessions.
 */

const STORAGE_KEY = 'onlycat-dfm/settings/v2';

export const DEFAULT_SETTINGS = {
  analysisMode: 'single',      // 'single' | 'twoshot'
  material: 'pp',
  material2: 'tpu',
  windowType: 'none',          // 'none' | 'optical' | 'ir'
  surfaceFinish: 'spi-a2',
  moldType: 'two-piece',       // 'two-piece' | 'single-pull'

  wallThk: 2.0,
  wallMin: 1.2,
  wallMax: 3.5,
  draftAngle: 1.0,
  ribThk: 1.2,
  ribH: 5.0,
  ribRadius: 0.5,
  bossOD: 6.0,
  bossWall: 1.0,
  hasUndercut: '0',

  fpcEnabled: false,
  fpcThickness: 0.20,
  fpcCover: 0.50,
  fpcAnchors: 'holes',

  checks: {
    wall: true,
    draft: true,
    ribs: true,
    undercut: true,
    sink: true,
    warp: true,
    transitions: false,        // STEP-reliable only; off by default
    flow: true,
    fpc: true,
  },
};

export const settings = structuredClone(DEFAULT_SETTINGS);

export const runtime = {
  sessionId: Math.random().toString(36).slice(2, 7).toUpperCase(),
  runCount: 0,

  geom1: null,
  geom2: null,
  bodies: null,                // per-body visibility for multi-body STEP
  fileName1: null,
  fileName2: null,

  validation: null,            // shot 1 mesh health report
  validation2: null,           // shot 2 mesh health report
  analysis: null,              // shot 1 mesh analysis
  analysis2: null,             // shot 2 mesh analysis
  interface: null,             // two-shot interface measurement
  dfm: null,                   // { input, result }
  twoShot: null,               // two-shot check result

  gateLocation: null,          // [x, y, z] in mesh-local coordinates
  pullDir: { mode: 'axis', value: '+z', vec: [0, 0, 1] },
  heatMode: 'flat',
  materialChosen: false,       // drives the onboarding stepper
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason) {
  for (const fn of listeners) fn(reason);
}

/* Assign a patch onto settings, persist, and notify. Nested objects merge one
   level deep, which covers `checks` — the only nested group there is. */
export function updateSettings(patch, reason = 'settings') {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && settings[k] && typeof settings[k] === 'object') {
      Object.assign(settings[k], v);
    } else {
      settings[k] = v;
    }
  }
  saveSettings();
  emit(reason);
}

export function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Private browsing, disabled storage, or a quota limit. Persistence is a
       convenience here, never a requirement — carry on without it. */
  }
}

export function loadSettings() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== 'object') return false;

  /* Merge key by key against the defaults so a stored file from an older
     version cannot introduce unknown keys or drop new ones. */
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in stored)) continue;
    const def = DEFAULT_SETTINGS[key];
    const val = stored[key];
    if (def && typeof def === 'object' && !Array.isArray(def)) {
      if (val && typeof val === 'object') {
        for (const sub of Object.keys(def)) {
          if (sub in val && typeof val[sub] === typeof def[sub]) settings[key][sub] = val[sub];
        }
      }
    } else if (typeof val === typeof def) {
      settings[key] = val;
    }
  }
  return true;
}

export function resetSettings() {
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  saveSettings();
}

export function resetRuntime() {
  runtime.geom1 = null;
  runtime.geom2 = null;
  runtime.bodies = null;
  runtime.fileName1 = null;
  runtime.fileName2 = null;
  runtime.validation = null;
  runtime.validation2 = null;
  runtime.analysis = null;
  runtime.analysis2 = null;
  runtime.interface = null;
  runtime.dfm = null;
  runtime.twoShot = null;
  runtime.gateLocation = null;
  runtime.pullDir = { mode: 'axis', value: '+z', vec: [0, 0, 1] };
  runtime.heatMode = 'flat';
  runtime.materialChosen = false;
  runtime.runCount = 0;
}

export const isTwoShot = () => settings.analysisMode === 'twoshot';
