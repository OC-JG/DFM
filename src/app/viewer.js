import { createCameraControls } from './camera.js';
import { $ } from './dom.js';

/*
 * Three.js scene: the part, the overmould, the pull-direction arrow, the gate
 * marker, and the picking that feeds the last two.
 *
 * Colour is carried per-vertex on a single mesh rather than per-material, so
 * switching heat modes is one buffer update and no re-upload of geometry.
 */

let scene = null;
let camera = null;
let renderer = null;
let mesh = null;              // shot 1
let mesh2 = null;             // shot 2 / overmould
let gateMarker = null;
let pullArrow = null;
let controls = null;
let viewerEl = null;
let rafHandle = 0;
let currentGeom = null;       // full geometry, kept for colouring while bodies are hidden
let bodies = null;

let pickMode = null;          // 'face' | 'gate' | null
let onPick = null;

export const FLAT_GREY = 0.55;

/*
 * Every entry point below returns early when the scene was never created.
 *
 * three.js comes from a CDN, so an offline or blocked load leaves the app
 * running without a viewer. That path has to stay usable: mesh analysis, the
 * rules engine and both exports need no rendering at all, so a part still
 * loads and still scores — it just has no preview. The original threw
 * "THREE is not defined" on the first file drop and stopped dead.
 */
export function isViewerReady() { return !!renderer; }
export function getControls() { return controls; }
export function getMesh() { return mesh; }

export function initViewer(onPickCallback) {
  viewerEl = $('viewer');
  onPick = onPickCallback;

  const w = viewerEl.clientWidth || 600;
  const h = Math.max(viewerEl.clientHeight || 400, 1);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 5000);
  camera.position.set(80, 60, 100);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  viewerEl.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(1, 1.5, 1);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x0084ff, 0.18);
  fill.position.set(-1, -1, -1);
  scene.add(fill);

  const grid = new THREE.GridHelper(400, 40, 0x0a0e0c, 0x0a0e0c);
  grid.material.opacity = 0.08;
  grid.material.transparent = true;
  scene.add(grid);

  controls = createCameraControls(viewerEl, camera, getMesh, (view) => {
    if (view === 'free') markViewFree();
  });

  viewerEl.addEventListener('click', handleViewerClick);

  /* Observe the element rather than the window: this also catches sidebar
     collapse, panel resize and browser zoom, none of which fire a resize. */
  new ResizeObserver(onResize).observe(viewerEl);
  window.addEventListener('resize', onResize);

  const loop = () => {
    rafHandle = requestAnimationFrame(loop);
    renderer.render(scene, camera);
  };
  loop();
}

export function disposeViewer() {
  if (rafHandle) cancelAnimationFrame(rafHandle);
}

function onResize() {
  if (!renderer) return;
  const w = viewerEl.clientWidth;
  const h = viewerEl.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function markViewFree() {
  document.querySelectorAll('.view-btn[data-view]').forEach((b) => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
  const label = $('viewMode');
  if (label) label.textContent = 'free';
}

// ── geometry ───────────────────────────────────────────────────────────────

function disposeMesh(m) {
  if (!m) return;
  scene.remove(m);
  m.geometry.dispose();
  m.material.dispose();
}

export function loadGeometry(geom) {
  if (!scene) return geom.bodies ? geom.bodies.map((b) => ({ ...b, visible: true })) : null;

  disposeMesh(mesh);
  currentGeom = geom;
  bodies = geom.bodies ? geom.bodies.map((b) => ({ ...b, visible: true })) : null;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geom.vertices, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(geom.normals, 3));
  g.setIndex(new THREE.BufferAttribute(geom.indices, 1));

  const cols = new Float32Array(geom.vertices.length).fill(FLAT_GREY);
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));

  mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: false,
    side: THREE.DoubleSide,
  }));
  scene.add(mesh);

  g.computeBoundingBox();
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  g.boundingBox.getCenter(center);
  g.boundingBox.getSize(size);
  controls.setTarget(center, Math.max(size.x, size.y, size.z) * 2.2);
  setView('iso');

  clearGateMarker();
  return bodies;
}

export function loadGeometry2(geom) {
  if (!scene) return;

  disposeMesh(mesh2);
  mesh2 = null;
  if (!geom) return;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geom.vertices, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(geom.normals, 3));
  g.setIndex(new THREE.BufferAttribute(geom.indices, 1));
  mesh2 = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
    color: 0x0084ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
  }));
  scene.add(mesh2);
}

export function clearGeometry() {
  if (!scene) return;

  disposeMesh(mesh); mesh = null;
  disposeMesh(mesh2); mesh2 = null;
  clearGateMarker();
  clearPullArrow();
  currentGeom = null;
  bodies = null;
}

/* Rebuild the render index to hold only visible bodies. The full geometry is
   untouched — analysis always covers every body — so this is display only. */
export function setBodyVisibility(nextBodies) {
  bodies = nextBodies;
  if (!scene || !mesh || !currentGeom || !bodies) return;
  let visTriCount = 0;
  for (const b of bodies) if (b.visible) visTriCount += b.triEnd - b.triStart;

  const filtered = new Uint32Array(visTriCount * 3);
  let w = 0;
  for (const b of bodies) {
    if (!b.visible) continue;
    for (let k = b.triStart * 3; k < b.triEnd * 3; k++) filtered[w++] = currentGeom.indices[k];
  }
  mesh.geometry.setIndex(new THREE.BufferAttribute(filtered, 1));
  mesh.geometry.index.needsUpdate = true;
}

// ── colouring ──────────────────────────────────────────────────────────────

/*
 * Spread per-triangle colours onto shared vertices by averaging every
 * incident triangle's contribution.
 *
 * The full geometry index is used rather than the render index: triRGB is
 * addressed by absolute triangle number, and vertex colours are shared
 * whether or not a body is currently hidden.
 */
export function applyTriangleColours(triRGB) {
  if (!mesh) return;
  const idx = currentGeom ? currentGeom.indices : mesh.geometry.index.array;
  const cols = mesh.geometry.attributes.color.array;
  const acc = new Float32Array(cols.length);
  const cnt = new Uint32Array(cols.length / 3);

  const triTotal = idx.length / 3;
  for (let t = 0; t < triTotal; t++) {
    const r = triRGB[t * 3], g = triRGB[t * 3 + 1], b = triRGB[t * 3 + 2];
    for (let v = 0; v < 3; v++) {
      const vi = idx[t * 3 + v];
      acc[vi * 3] += r; acc[vi * 3 + 1] += g; acc[vi * 3 + 2] += b;
      cnt[vi]++;
    }
  }
  for (let i = 0; i < cnt.length; i++) {
    const c = cnt[i] || 1;
    cols[i * 3] = acc[i * 3] / c;
    cols[i * 3 + 1] = acc[i * 3 + 1] / c;
    cols[i * 3 + 2] = acc[i * 3 + 2] / c;
  }
  mesh.geometry.attributes.color.needsUpdate = true;
}

export function applyFlatColour() {
  if (!mesh) return;
  mesh.geometry.attributes.color.array.fill(FLAT_GREY);
  mesh.geometry.attributes.color.needsUpdate = true;
}

/* Colour the overmould by interface thickness. Unlike shot 1 these are hard
   per-triangle bands, so vertices take the last triangle's colour rather than
   an average — banding is the point here. */
export function applyOvermouldColours(geom2, triRGB) {
  if (!mesh2) return;
  const g = mesh2.geometry;
  if (!g.attributes.color) {
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geom2.vertices.length), 3));
    mesh2.material.vertexColors = true;
    mesh2.material.needsUpdate = true;
  }
  const cols = g.attributes.color.array;
  for (let t = 0; t < geom2.triCount; t++) {
    for (let v = 0; v < 3; v++) {
      const vi = geom2.indices[t * 3 + v] * 3;
      cols[vi] = triRGB[t * 3];
      cols[vi + 1] = triRGB[t * 3 + 1];
      cols[vi + 2] = triRGB[t * 3 + 2];
    }
  }
  g.attributes.color.needsUpdate = true;
  mesh2.material.color.set(0xffffff); // let the vertex colours through
  mesh2.material.opacity = 0.75;
  mesh2.material.transparent = true;
}

// ── views ──────────────────────────────────────────────────────────────────

const VIEW_ANGLES = {
  iso:   [Math.PI / 4, Math.PI / 3],
  top:   [0, 0.01],
  front: [Math.PI / 2, Math.PI / 2],
  right: [0, Math.PI / 2],
};

export function setView(view) {
  if (!controls) return;

  document.querySelectorAll('.view-btn[data-view]').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const label = $('viewMode');
  if (label) label.textContent = view;
  const angles = VIEW_ANGLES[view];
  if (angles) controls.setAngles(angles[0], angles[1]);
}

// ── markers ────────────────────────────────────────────────────────────────

/* Mesh-vertex coordinates to world space. The analysis works in vertex
   coordinates; the scene has the part centred and scaled, so a point that came
   out of the analyser needs converting before it can be drawn. */
export function localToWorld(localPoint) {
  if (!mesh) return null;
  const v = new THREE.Vector3(localPoint[0], localPoint[1], localPoint[2]);
  mesh.updateMatrixWorld();
  return mesh.localToWorld(v);
}

export function clearGateMarker() {
  if (!scene) return;

  if (!gateMarker) return;
  scene.remove(gateMarker);
  gateMarker.geometry.dispose();
  gateMarker.material.dispose();
  gateMarker = null;
}

export function setGateMarker(worldPoint, partDiag) {
  if (!scene) return;

  clearGateMarker();
  const r = Math.max(0.5, partDiag * 0.012);
  gateMarker = new THREE.Mesh(
    new THREE.SphereGeometry(r, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xd43824 }),
  );
  gateMarker.position.copy(worldPoint);
  scene.add(gateMarker);
}

function clearPullArrow() {
  if (!pullArrow) return;
  scene.remove(pullArrow);
  pullArrow.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  pullArrow = null;
}

/* Orange arrow showing the current pull direction, parked just outside the
   part's bounding sphere. */
export function drawPullArrow(vec) {
  if (!scene) return;

  clearPullArrow();
  if (!mesh) return;
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();

  const bb = mesh.geometry.boundingBox;
  const span = bb.max.clone().sub(bb.min).length();
  const len = span * 0.35 || 50;

  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xff5722 });

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(len * 0.015, len * 0.015, len * 0.7, 12), mat);
  shaft.position.y = len * 0.35;
  group.add(shaft);

  const head = new THREE.Mesh(new THREE.CylinderGeometry(0, len * 0.05, len * 0.15, 16), mat);
  head.position.y = len * 0.775;
  group.add(head);

  group.add(new THREE.Mesh(new THREE.SphereGeometry(len * 0.025, 16, 16), mat));

  const dir = new THREE.Vector3(vec[0], vec[1], vec[2]).normalize();
  group.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));

  const center = new THREE.Vector3();
  bb.getCenter(center);
  group.position.copy(center).add(dir.clone().multiplyScalar(span * 0.6));

  scene.add(group);
  pullArrow = group;
}

// ── picking ────────────────────────────────────────────────────────────────

export function setPickMode(modeName) {
  if (!viewerEl) return;

  pickMode = modeName;
  viewerEl.style.cursor = modeName ? 'crosshair' : '';
}

export function getPickMode() { return pickMode; }

function handleViewerClick(e) {
  if (!pickMode || !mesh) return;
  /* Ignore the click that ends an orbit drag. */
  if (controls.dragDistance() > 5) return;

  const rect = viewerEl.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const rc = new THREE.Raycaster();
  rc.setFromCamera(ndc, camera);
  const hits = rc.intersectObject(mesh);
  if (!hits.length) return;

  const hit = hits[0];
  if (pickMode === 'face') {
    const n = hit.face.normal.clone();
    n.transformDirection(mesh.matrixWorld);
    onPick('face', { normal: [n.x, n.y, n.z] });
  } else if (pickMode === 'gate') {
    /* Keep world space for the marker and mesh-local space for the analyser,
       which works in vertex coordinates. */
    const world = hit.point.clone();
    const local = hit.point.clone();
    mesh.worldToLocal(local);
    onPick('gate', { world, local: [local.x, local.y, local.z] });
  }
}
