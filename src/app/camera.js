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
 */
export function createCameraControls(viewerEl, camera, getMesh, onViewChange) {
  let theta = Math.PI / 4;
  let phi = Math.PI / 3;
  let radius = 200;
  let partDiag = 100;
  const target = new THREE.Vector3();

  function update() {
    camera.position.x = target.x + radius * Math.sin(phi) * Math.cos(theta);
    camera.position.y = target.y + radius * Math.cos(phi);
    camera.position.z = target.z + radius * Math.sin(phi) * Math.sin(theta);
    camera.lookAt(target);
  }

  let mode = null;              // 'orbit' | 'pan' | 'pinch' | null
  let lastX = 0, lastY = 0;
  let dragDist = 0;
  let touch1 = null, touch2 = null;
  let pinchStartDist = 0, pinchStartRadius = 0;

  /* Convert screen pixels to world units at the target's depth. */
  function panBy(dxScreen, dyScreen) {
    const fov = camera.fov * Math.PI / 180;
    const worldPerPx = (2 * Math.tan(fov / 2) * radius) / Math.max(1, viewerEl.clientHeight);
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    const camUp = new THREE.Vector3().crossVectors(right, forward).normalize();
    target.addScaledVector(right, -dxScreen * worldPerPx);
    target.addScaledVector(camUp, dyScreen * worldPerPx);
  }

  /* factor < 1 zooms in. anchorPx keeps the point under the cursor roughly
     fixed by sliding the target along the cursor ray. */
  function zoomBy(factor, anchorPx) {
    const newRadius = Math.max(partDiag * 0.05, Math.min(partDiag * 20, radius * factor));
    if (anchorPx) {
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
      const camToTarget = new THREE.Vector3().subVectors(target, camera.position);
      const denom = rayDir.dot(viewDir);
      if (Math.abs(denom) > 1e-6) {
        const tDist = camToTarget.dot(viewDir) / denom;
        const cursorWorld = camera.position.clone().addScaledVector(rayDir, tDist);
        target.lerp(cursorWorld, 1 - newRadius / radius);
      }
    }
    radius = newRadius;
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
    target.copy(center);
    radius = maxDim * 2.2;
    partDiag = Math.max(maxDim, 1);
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
      theta -= dx * 0.008;
      phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi - dy * 0.008));
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
    if (p) { target.copy(p); update(); } else { frameToFit(); }
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
      pinchStartRadius = radius;
      mode = 'pinch';
    }
  }, { passive: true });

  viewerEl.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (mode === 'orbit' && e.touches.length === 1) {
      const x = e.touches[0].clientX, y = e.touches[0].clientY;
      const dx = x - lastX, dy = y - lastY;
      dragDist += Math.abs(dx) + Math.abs(dy);
      theta -= dx * 0.008;
      phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi - dy * 0.008));
      lastX = x; lastY = y;
      update();
    } else if (mode === 'pinch' && e.touches.length === 2) {
      const ax = e.touches[0].clientX, ay = e.touches[0].clientY;
      const bx = e.touches[1].clientX, by = e.touches[1].clientY;
      const dist = Math.hypot(bx - ax, by - ay);
      radius = Math.max(partDiag * 0.05, Math.min(partDiag * 20, pinchStartRadius * (pinchStartDist / Math.max(dist, 0.001))));
      panBy((ax + bx) / 2 - (touch1.x + touch2.x) / 2, (ay + by) / 2 - (touch1.y + touch2.y) / 2);
      touch1 = { x: ax, y: ay }; touch2 = { x: bx, y: by };
      update();
    }
  }, { passive: false });

  viewerEl.addEventListener('touchend', () => { mode = null; touch1 = null; touch2 = null; });

  update();

  return {
    setTarget(t, r) {
      target.copy(t);
      radius = r;
      /* radius is set to ~2.2 × maxDim by callers, so this recovers a usable
         scale reference for the zoom clamps. */
      partDiag = r * 0.45;
      update();
    },
    setAngles(theta_, phi_) { theta = theta_; phi = phi_; update(); },
    frame: frameToFit,
    zoomIn() { zoomBy(0.8, null); update(); },
    zoomOut() { zoomBy(1.25, null); update(); },
    dragDistance: () => dragDist,
    pickPointAt,
  };
}
