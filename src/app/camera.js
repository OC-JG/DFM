import { createCameraState, quatFromThetaPhi } from './camera-state.js';
import { applyRates, NAVIGATOR_DEFAULTS } from './navigator.js';

/*
 * CAD-style camera controls.
 *
 *   left-drag        orbit
 *   shift+drag       pan (also middle-drag, also right-drag)
 *   wheel            zoom toward the cursor, exponential, device-normalised
 *   1-finger drag    orbit
 *   2-finger drag    pan
 *   pinch            zoom
 *   double-click     recentre the target on the clicked point
 *   F                frame to fit
 *   +/-              zoom from centre
 *   R                reset to iso
 *
 * Written against the global THREE from the CDN build.
 *
 * The pose itself lives in camera-state.js, which knows nothing about three.js
 * or the DOM: an orientation quaternion, a target and a distance, replacing the
 * theta/phi/radius pair this file used to carry. What is left here is event
 * plumbing — reading pixels off events, unprojecting a cursor, and copying the
 * result onto a THREE camera.
 *
 * The move was made for the 6-DoF device work, which needs a camera that can
 * express roll, but it pays for itself immediately: the pose arithmetic now has
 * tests, where before its correctness lived entirely in whether an orbit felt
 * right. Every constant below is the one that was here before, and the eye
 * positions the new state produces match the old formula to one part in 10¹³.
 */

/* Radians of orbit per pixel dragged. Unchanged, and the feel depends on it. */
const ORBIT_PER_PX = 0.008;

export function createCameraControls(viewerEl, camera, getMesh, onViewChange) {
  const state = createCameraState({
    orientation: quatFromThetaPhi(Math.PI / 4, Math.PI / 3),
    distance: 200,
    partSize: 100,
  });

  function update() {
    const eye = state.eye;
    camera.position.set(eye[0], eye[1], eye[2]);
    /*
     * The orientation is copied rather than recovered with `lookAt`. lookAt
     * rebuilds it from the camera's `up`, which silently discards any roll —
     * fine while only a mouse could drive this, and wrong the moment a device
     * can.
     */
    const q = state.orientation;
    camera.quaternion.set(q[0], q[1], q[2], q[3]);
  }

  let mode = null;              // 'orbit' | 'pan' | 'pinch' | null
  let lastX = 0, lastY = 0;
  let dragDist = 0;
  let touch1 = null, touch2 = null;
  let pinchStartDist = 0, pinchStartRadius = 0;

  /* Convert screen pixels to world units at the target's depth. */
  function panBy(dxScreen, dyScreen) {
    const worldPerPx = state.worldPerPixel(camera.fov * Math.PI / 180, viewerEl.clientHeight);
    state.pan(-dxScreen * worldPerPx, dyScreen * worldPerPx);
  }

  /*
   * The world point under a screen position, at the target's depth.
   *
   * Where the cursor ray crosses the plane through the target square to the
   * view direction — which is the depth a zoom should hold still, since it is
   * the depth the part is at.
   */
  function planePointAt(anchorPx) {
    const rect = viewerEl.getBoundingClientRect();
    const ndc = new THREE.Vector3(
      ((anchorPx.x - rect.left) / rect.width) * 2 - 1,
      -((anchorPx.y - rect.top) / rect.height) * 2 + 1,
      0.5,
    );
    ndc.unproject(camera);
    const rayDir = ndc.sub(camera.position).normalize();
    const viewDir = new THREE.Vector3();
    camera.getWorldDirection(viewDir);
    const t = state.target;
    const camToTarget = new THREE.Vector3(t[0], t[1], t[2]).sub(camera.position);
    const denom = rayDir.dot(viewDir);
    if (Math.abs(denom) <= 1e-6) return null;
    const tDist = camToTarget.dot(viewDir) / denom;
    const p = camera.position.clone().addScaledVector(rayDir, tDist);
    return [p.x, p.y, p.z];
  }

  /* factor < 1 zooms in. anchorPx keeps the point under the cursor roughly
     fixed by sliding the target along the cursor ray. */
  function zoomBy(factor, anchorPx) {
    state.zoomToward(factor, anchorPx ? planePointAt(anchorPx) : null);
  }

  function pickPointAt(px, py) {
    const mesh = getMesh();
    if (!mesh) return null;
    const rect = viewerEl.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((px - rect.left) / rect.width) * 2 - 1,
      -((py - rect.top) / rect.height) * 2 + 1,
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, camera);
    const hits = rc.intersectObject(mesh);
    return hits.length ? hits[0].point.clone() : null;
  }

  function frameToFit() {
    const mesh = getMesh();
    if (!mesh) return;
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    g.boundingBox.getCenter(center);
    g.boundingBox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    state.setPartSize(Math.max(maxDim, 1));
    state.setTarget([center.x, center.y, center.z]);
    state.setDistance(maxDim * 2.2);
    update();
  }

  // ── mouse ────────────────────────────────────────────────────────────────
  viewerEl.addEventListener('mousedown', (e) => {
    dragDist = 0; // reset every press, so a pick-mode click is never blocked by an earlier drag
    if (e.button === 0 && e.shiftKey) mode = 'pan';
    else if (e.button === 0) mode = 'orbit';
    else if (e.button === 1 || e.button === 2) mode = 'pan';
    else mode = null;
    if (mode) {
      e.preventDefault();
      lastX = e.clientX; lastY = e.clientY;
    }
  });
  viewerEl.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('mouseup', () => { mode = null; });
  window.addEventListener('mousemove', (e) => {
    if (!mode) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    dragDist += Math.abs(dx) + Math.abs(dy);
    lastX = e.clientX; lastY = e.clientY;
    if (mode === 'orbit') {
      state.orbit(dx * ORBIT_PER_PX, -dy * ORBIT_PER_PX);
      if (onViewChange) onViewChange('free');
    } else if (mode === 'pan') {
      panBy(dx, dy);
    }
    update();
  });

  // ── wheel: exponential and normalised across pointing devices ────────────
  viewerEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16;   // lines → px
    if (e.deltaMode === 2) d *= 400;  // pages → px
    /* exp(d/250) is scale-invariant, so a trackpad's tiny deltas and a
       wheel's big ones both feel right without a device sniff. */
    zoomBy(Math.exp(d / 250), { x: e.clientX, y: e.clientY });
    update();
  }, { passive: false });

  viewerEl.addEventListener('dblclick', (e) => {
    const p = pickPointAt(e.clientX, e.clientY);
    if (p) { state.setTarget([p.x, p.y, p.z]); update(); } else { frameToFit(); }
  });

  // ── touch ────────────────────────────────────────────────────────────────
  viewerEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      touch1 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      mode = 'orbit';
      lastX = touch1.x; lastY = touch1.y; dragDist = 0;
    } else if (e.touches.length === 2) {
      touch1 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      touch2 = { x: e.touches[1].clientX, y: e.touches[1].clientY };
      pinchStartDist = Math.hypot(touch2.x - touch1.x, touch2.y - touch1.y);
      pinchStartRadius = state.distance;
      mode = 'pinch';
    }
  }, { passive: true });

  viewerEl.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (mode === 'orbit' && e.touches.length === 1) {
      const x = e.touches[0].clientX, y = e.touches[0].clientY;
      const dx = x - lastX, dy = y - lastY;
      dragDist += Math.abs(dx) + Math.abs(dy);
      state.orbit(dx * ORBIT_PER_PX, -dy * ORBIT_PER_PX);
      lastX = x; lastY = y;
      update();
    } else if (mode === 'pinch' && e.touches.length === 2) {
      const ax = e.touches[0].clientX, ay = e.touches[0].clientY;
      const bx = e.touches[1].clientX, by = e.touches[1].clientY;
      const dist = Math.hypot(bx - ax, by - ay);
      state.setDistance(pinchStartRadius * (pinchStartDist / Math.max(dist, 0.001)));
      panBy((ax + bx) / 2 - (touch1.x + touch2.x) / 2, (ay + by) / 2 - (touch1.y + touch2.y) / 2);
      touch1 = { x: ax, y: ay }; touch2 = { x: bx, y: by };
      update();
    }
  }, { passive: false });

  viewerEl.addEventListener('touchend', () => { mode = null; touch1 = null; touch2 = null; });

  update();

  return {
    setTarget(t, r) {
      state.setTarget([t.x, t.y, t.z]);
      /* partSize first: the distance is clamped against it, and setting them
         the other way round clamps the new distance to the old part's scale.
         `r` is ~2.2 × maxDim by every caller, so this recovers the size. */
      state.setPartSize(r * 0.45);
      state.setDistance(r);
      update();
    },
    setAngles(theta_, phi_) { state.setAngles(theta_, phi_); update(); },
    frame: frameToFit,
    zoomIn() { zoomBy(0.8, null); update(); },
    zoomOut() { zoomBy(1.25, null); update(); },
    dragDistance: () => dragDist,
    pickPointAt,

    /*
     * A 6-DoF sample, integrated over `dt` seconds.
     *
     * The seam the device work plugs into, and the seam a test drives: nothing
     * about a physical puck is testable in CI, so the transport stays outside
     * and what arrives here is six numbers. See navigator.js for what happens
     * to them.
     */
    applyRates(sample, dt, settings = NAVIGATOR_DEFAULTS) {
      const moved = applyRates(state, sample, dt, settings);
      if (moved) {
        if (onViewChange) onViewChange('free');
        update();
      }
      return moved;
    },

    /* For tests and for anything that needs to read the pose without going
       through three.js. */
    state,
  };
}
