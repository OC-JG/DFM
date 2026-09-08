/*
 * Turning a 6-DoF sample into camera motion.
 *
 * A 3Dconnexion puck is a spring-centred displacement sensor: you push it a
 * couple of millimetres and it pushes back, and what it reports is not where
 * the camera should be but how fast it should be going. So a sample is
 * integrated over the frame it arrived in, rather than applied as a position —
 * and getting that wrong is what makes 6-DoF navigation feel seasick.
 *
 * ── What a sample is ─────────────────────────────────────────────────────
 *
 * Six numbers, each already normalised to −1…1 by whatever produced them:
 *
 *   tx, ty, tz   push the puck left/right, up/down, in/out
 *   rx, ry, rz   tilt it, spin it, twist it
 *
 * Normalising is the transport's job, not this file's, and deliberately: a
 * SpaceMouse Compact reports a different full-scale value from a SpacePilot,
 * and putting that knowledge here would mean this file needing to know which
 * device is attached. It does not, which is also what lets a test drive it.
 *
 * ── The dead zone ────────────────────────────────────────────────────────
 *
 * A puck at rest does not read zero. It reads a small wandering value, and
 * integrated at sixty frames a second that is a camera that drifts on its own
 * while nobody is touching anything. Anything inside the dead zone is zero;
 * outside it, the response is rescaled from the edge of the zone rather than
 * stepping — so the first perceptible push is a slow one, not a jump.
 *
 * The curve past that is quadratic (`|v|·v`), which is the usual choice for
 * spring-centred controls: fine positioning near centre where a part is being
 * lined up, and speed at the extremes where it is being flung round.
 */

export const NAVIGATOR_DEFAULTS = {
  /* Fraction of full scale ignored around centre. */
  deadZone: 0.08,
  /* Radians per second at full deflection. */
  rotateRate: 1.8,
  /* Screen-heights per second at full deflection; scaled by the part's size,
     so panning across a 10 mm part and a 400 mm one both take the same push. */
  panRate: 0.9,
  /* Fraction of the current distance per second at full deflection. Relative
     rather than absolute for the same reason: zooming is scale-free. */
  dollyRate: 1.2,
  /* Whether the puck may roll the view. Off keeps the horizon level, which is
     what the mouse path does and what a turntable user expects; on is what a
     6-DoF device is for. */
  roll: true,
  /* Longest frame that will be integrated, in seconds. A tab that was
     backgrounded for a minute comes back with a vast dt, and integrating it
     would fling the camera to somewhere unrecoverable before the first frame
     is drawn. */
  maxStep: 0.1,
};

/*
 * Dead zone, rescale, and the response curve. Returns −1…1.
 */
export function shape(value, deadZone) {
  const v = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  const m = Math.abs(v);
  if (m <= deadZone) return 0;
  /* Rescaled from the edge of the dead zone, so the response starts at zero
     rather than at whatever the zone's width happened to be. */
  const t = (m - deadZone) / (1 - deadZone);
  return Math.sign(v) * t * t;
}

/* True when every axis of a sample is inside the dead zone — the ordinary
   state of a puck nobody is touching. */
export function isIdle(sample, deadZone = NAVIGATOR_DEFAULTS.deadZone) {
  if (!sample) return true;
  for (const axis of ['tx', 'ty', 'tz', 'rx', 'ry', 'rz']) {
    if (shape(sample[axis] || 0, deadZone) !== 0) return false;
  }
  return true;
}

/*
 * Integrate one sample into a camera state.
 *
 * Returns whether anything moved, so a caller can skip a redraw on the frames
 * — most of them — where the puck is sitting still.
 *
 * `state` is a camera-state object; nothing here touches three.js or the DOM.
 */
export function applyRates(state, sample, dt, settings = NAVIGATOR_DEFAULTS) {
  const s = { ...NAVIGATOR_DEFAULTS, ...settings };
  if (!sample || !(dt > 0)) return false;
  const step = Math.min(dt, s.maxStep);

  const tx = shape(sample.tx || 0, s.deadZone);
  const ty = shape(sample.ty || 0, s.deadZone);
  const tz = shape(sample.tz || 0, s.deadZone);
  const rx = shape(sample.rx || 0, s.deadZone);
  const ry = shape(sample.ry || 0, s.deadZone);
  const rz = s.roll ? shape(sample.rz || 0, s.deadZone) : 0;

  if (!tx && !ty && !tz && !rx && !ry && !rz) return false;

  /* Pan in world units: a full push crosses `panRate` part-sizes a second. */
  if (tx || ty) {
    const perSecond = s.panRate * state.partSize;
    state.pan(tx * perSecond * step, ty * perSecond * step);
  }
  /* Push in and out. Proportional to the current distance, so the last
     millimetre of approach is as controllable as the first metre. */
  if (tz) state.dolly(tz * s.dollyRate * state.distance * step);

  if (rx || ry || rz) {
    state.rotateLocal(rx * s.rotateRate * step, ry * s.rotateRate * step, rz * s.rotateRate * step);
  }
  return true;
}

/*
 * Drive a camera from a source of samples.
 *
 * `source` is anything with `read()` returning a sample or null, which is the
 * whole interface a device transport has to satisfy — and the reason there is
 * an interface at all: a physical puck cannot be exercised in CI, so the part
 * that can be is kept on this side of a line that a test can also stand on.
 *
 * The loop is only running while samples are arriving. A source that reads
 * null, or a puck sitting inside its dead zone, costs one function call per
 * frame and no redraw.
 */
export function createNavigatorLoop({ source, controls, settings, now = () => performance.now(), schedule = requestAnimationFrame }) {
  let running = false;
  let last = 0;

  function tick() {
    if (!running) return;
    const t = now();
    const dt = last ? (t - last) / 1000 : 0;
    last = t;
    /*
     * The first frame only starts the clock. Reading the source there would
     * consume a sample and integrate it over zero seconds — the sample is
     * thrown away, which is harmless for a device reporting its current
     * deflection and wrong for anything that queues them, and either way it
     * makes the loop's behaviour depend on which it is.
     */
    if (dt > 0) {
      const sample = source.read();
      if (sample) controls.applyRates(sample, dt, settings);
    }
    schedule(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = 0;
      schedule(tick);
    },
    stop() { running = false; },
    get running() { return running; },
  };
}
