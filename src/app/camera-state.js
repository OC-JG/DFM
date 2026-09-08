/*
 * Where the camera is, as arithmetic.
 *
 * The controls used to hold orientation as `theta`, `phi` and `radius` about a
 * target: two degrees of rotational freedom with world-up implied, which is
 * why the viewer has never had roll. That is a perfectly good parameterisation
 * for a mouse, which can only ever supply two numbers at a time. It cannot
 * express what a 3Dconnexion puck sends, which is three translation and three
 * rotation rates at once — and a shim that folded roll into a theta/phi pair
 * would be a lie about what the device did.
 *
 * So the state is an orientation quaternion, a target and a distance, and
 * every input path — mouse, touch, wheel, keyboard, and a device when one
 * arrives — is written against that. This module holds it, and holds it with
 * no reference to three.js and no reference to the DOM.
 *
 * That separation is the point rather than a tidiness preference. The camera
 * was the most hand-tuned code in the repository and had no automated coverage
 * at all: its correctness lived in whether an orbit *felt* right, which is not
 * a thing CI can hold on to. Split this way, every claim about where the
 * camera ends up is a number a test can assert, and what remains in camera.js
 * is event plumbing.
 *
 * ── Conventions ──────────────────────────────────────────────────────────
 *
 * The same ones three.js uses, so the boundary is a copy rather than a
 * conversion: a camera looks down its own −Z, with +Y up and +X right. The eye
 * therefore sits at `target + orientation·(0, 0, distance)`.
 *
 * Quaternions are `[x, y, z, w]`, and multiplication is the usual convention:
 * `mul(a, b)` applies b first, then a. Pre-multiplying rotates about a world
 * axis; post-multiplying rotates about one of the camera's own.
 */

/* Turntable pitch stops this far short of the poles, in radians. Straight down
   the world-up axis is a singularity for a horizon-keeping camera — there is
   no unique "up" there — and the old theta/phi code clamped at the same 0.05
   for the same reason. */
export const PITCH_LIMIT = 0.05;

/* Distance is clamped to this multiple of the part's size at each end, which
   is what stops a wheel-spin ending up inside the part or in deep space. */
export const ZOOM_MIN_FACTOR = 0.05;
export const ZOOM_MAX_FACTOR = 20;

const WORLD_UP = [0, 1, 0];

// ── vectors ────────────────────────────────────────────────────────────────

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vCross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vLen = (a) => Math.hypot(a[0], a[1], a[2]);
export function vUnit(a) {
  const m = vLen(a);
  return m > 0 ? [a[0] / m, a[1] / m, a[2] / m] : [0, 0, 0];
}

// ── quaternions ────────────────────────────────────────────────────────────

/* Rotation of `angle` radians about `axis`, which need not be unit length. */
export function quatAxisAngle(axis, angle) {
  const n = vUnit(axis);
  const h = angle / 2;
  const s = Math.sin(h);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(h)];
}

/* b first, then a. */
export function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/*
 * Renormalise. Composing thousands of small rotations — which is exactly what
 * rate control does, sixty times a second — accumulates enough drift to shear
 * the result; this costs a square root per frame and removes the question.
 */
export function quatNormalise(q) {
  const m = Math.hypot(q[0], q[1], q[2], q[3]);
  return m > 0 ? [q[0] / m, q[1] / m, q[2] / m, q[3] / m] : [0, 0, 0, 1];
}

export function quatApply(q, v) {
  const [x, y, z, w] = q;
  /* t = 2 · (q.xyz × v); result = v + w·t + q.xyz × t */
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + y * tz - z * ty,
    v[1] + w * ty + z * tx - x * tz,
    v[2] + w * tz + x * ty - y * tx,
  ];
}

/*
 * The orientation that looks from `eye` at `target`, keeping world up.
 *
 * Built as a basis rather than by chaining Euler angles, because the basis is
 * the definition: −Z toward the target, X across it and world up, Y whatever
 * completes the frame.
 */
export function quatLookAt(eye, target, up = WORLD_UP) {
  const forward = vUnit(vSub(eye, target));   // camera +Z points back at the eye
  let right = vCross(up, forward);
  if (vLen(right) < 1e-6) {
    /* Looking straight up or down the up axis: any right vector is as good as
       another, so pick one deterministically rather than dividing by zero. */
    right = Math.abs(forward[1]) > 0.9 ? [1, 0, 0] : vCross([0, 1, 0], forward);
  }
  right = vUnit(right);
  const camUp = vCross(forward, right);
  return quatFromBasis(right, camUp, forward);
}

/* Quaternion from an orthonormal basis given as its three column vectors. The
   branch on the trace is the standard one: it picks whichever form keeps the
   divisor away from zero. */
export function quatFromBasis(x, y, z) {
  const m = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  const trace = m[0] + m[4] + m[8];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return quatNormalise([(m[7] - m[5]) * s, (m[2] - m[6]) * s, (m[3] - m[1]) * s, 0.25 / s]);
  }
  if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);
    return quatNormalise([0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s]);
  }
  if (m[4] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);
    return quatNormalise([(m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s, (m[2] - m[6]) / s]);
  }
  const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);
  return quatNormalise([(m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s, (m[3] - m[1]) / s]);
}

/*
 * The orientation the old `setAngles(theta, phi)` produced.
 *
 * Kept exactly, rather than approximated, because four named views and every
 * saved habit of using them go through it: the eye sat at
 * `(sin φ cos θ, cos φ, sin φ sin θ)` scaled by the radius, looking at the
 * target with world up. Converting rather than reimplementing means the views
 * land where they always did.
 */
export function quatFromThetaPhi(theta, phi) {
  const eye = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
  return quatLookAt(eye, [0, 0, 0]);
}

// ── the state ──────────────────────────────────────────────────────────────

/*
 * `partSize` is the largest dimension of whatever is on screen, and only sets
 * the zoom clamps and the pan scale — nothing here knows what a mesh is.
 */
export function createCameraState({ target = v3(), distance = 200, orientation = quatFromThetaPhi(Math.PI / 4, Math.PI / 3), partSize = 100 } = {}) {
  const state = {
    target: target.slice(),
    distance,
    orientation: quatNormalise(orientation),
    partSize: Math.max(partSize, 1e-6),
  };

  const right = () => quatApply(state.orientation, [1, 0, 0]);
  const up = () => quatApply(state.orientation, [0, 1, 0]);
  const back = () => quatApply(state.orientation, [0, 0, 1]);

  const api = {
    /* Read-only views of the state, copied so a caller cannot reach in. */
    get target() { return state.target.slice(); },
    get distance() { return state.distance; },
    get orientation() { return state.orientation.slice(); },
    get partSize() { return state.partSize; },
    /* The eye, which is what a renderer wants. */
    get eye() { return vAdd(state.target, vScale(back(), state.distance)); },
    get right() { return right(); },
    get up() { return up(); },
    get forward() { return vScale(back(), -1); },

    setTarget(t) { state.target = t.slice(); return api; },
    setDistance(d) { state.distance = clampDistance(state, d); return api; },
    setPartSize(s) { state.partSize = Math.max(s, 1e-6); return api; },
    setOrientation(q) { state.orientation = quatNormalise(q); return api; },
    setAngles(theta, phi) { return api.setOrientation(quatFromThetaPhi(theta, phi)); },

    /*
     * Turntable orbit: yaw about world up, pitch about the camera's own right
     * axis, with the horizon kept level.
     *
     * The two multiplications are on opposite sides on purpose. Yaw is about a
     * *world* axis, so it pre-multiplies; pitch is about the camera's own X,
     * so it post-multiplies. Doing both on the same side is the classic way to
     * get a camera that slowly rolls as you circle a part.
     */
    orbit(yaw, pitch) {
      let q = quatMul(quatAxisAngle(WORLD_UP, yaw), state.orientation);
      const pitched = quatMul(q, quatAxisAngle([1, 0, 0], pitch));
      /* Reject a pitch that would take the view over the pole rather than
         clamping to it: clamping there makes the camera stick and then jump. */
      const f = quatApply(pitched, [0, 0, 1]);
      if (Math.abs(vDot(vUnit(f), WORLD_UP)) < Math.cos(PITCH_LIMIT)) q = pitched;
      state.orientation = quatNormalise(q);
      return api;
    },

    /*
     * Free rotation, in the camera's own frame: pitch, yaw and roll together.
     *
     * This is what a 6-DoF device sends and what the theta/phi camera could
     * not represent. No pole constraint, because there is no implied world up
     * to lose — the user is driving every axis themselves, and a device that
     * rolls the part is doing what it was asked.
     */
    rotateLocal(pitch, yaw, roll) {
      const q = quatMul(state.orientation, quatMul(
        quatAxisAngle([0, 1, 0], yaw),
        quatMul(quatAxisAngle([1, 0, 0], pitch), quatAxisAngle([0, 0, 1], roll)),
      ));
      state.orientation = quatNormalise(q);
      return api;
    },

    /* Move the target across the view plane, in world units. */
    pan(dx, dy) {
      state.target = vAdd(state.target, vAdd(vScale(right(), dx), vScale(up(), dy)));
      return api;
    },

    /* And along the view direction, which is what a device's Z push does. */
    dolly(dz) {
      state.distance = clampDistance(state, state.distance - dz);
      return api;
    },

    /* Screen pixels to world units at the target's depth, for the drag paths.
       `fovY` in radians. */
    worldPerPixel(fovY, viewportHeight) {
      return (2 * Math.tan(fovY / 2) * state.distance) / Math.max(1, viewportHeight);
    },

    /* factor < 1 moves closer. */
    zoom(factor) {
      state.distance = clampDistance(state, state.distance * factor);
      return api;
    },

    /*
     * Zoom while holding a world point still on screen.
     *
     * The target slides toward that point by the same fraction the distance
     * shrank, which is what keeps whatever is under the cursor under it.
     */
    zoomToward(factor, worldPoint) {
      const before = state.distance;
      const after = clampDistance(state, before * factor);
      if (worldPoint && before > 0) {
        const t = 1 - after / before;
        state.target = vAdd(state.target, vScale(vSub(worldPoint, state.target), t));
      }
      state.distance = after;
      return api;
    },
  };

  return api;
}

function clampDistance(state, d) {
  return Math.max(state.partSize * ZOOM_MIN_FACTOR, Math.min(state.partSize * ZOOM_MAX_FACTOR, d));
}
