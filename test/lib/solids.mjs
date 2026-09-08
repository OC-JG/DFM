/*
 * Polyhedral solids for the STEP fixtures, defined as vertices plus
 * counter-clockwise face loops.
 *
 * These are the B-rep counterpart to shapes.mjs: same discipline — every
 * shape carries a closed-form answer for whatever it is used to test — but
 * expressed as faces rather than as triangle soup, because a face is the
 * thing the STEP path is supposed to preserve and the STL path throws away.
 *
 * Every loop is listed counter-clockwise seen from outside the solid, so the
 * face normal follows the winding and step-write.mjs does not have to be told
 * which way is out.
 */

/* The eight corners of an axis-aligned box, indexed so that 0-3 are the
   bottom face (z = z0) and 4-7 the top, each counter-clockwise seen from
   +z. Callers build loops from these indices. */
function boxCorners([x0, y0, z0], [x1, y1, z1]) {
  return [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
}

/* Loops for a box given the index of its first corner. Bottom is wound
   clockwise seen from +z so that its normal points down, out of the solid. */
function boxLoops(o = 0) {
  return [
    [o + 0, o + 3, o + 2, o + 1],   // −z
    [o + 4, o + 5, o + 6, o + 7],   // +z
    [o + 0, o + 1, o + 5, o + 4],   // −y
    [o + 1, o + 2, o + 6, o + 5],   // +x
    [o + 2, o + 3, o + 7, o + 6],   // +y
    [o + 3, o + 0, o + 4, o + 7],   // −x
  ];
}

/*
 * A plain box. Six faces, all planar, all at right angles.
 *
 * Answers: bbox is exactly `size`; volume is the product of its sides; every
 * side wall has 0° draft, which is what makes it useful — a box is the part
 * the draft check must fail, and per-face draft should report 0.000° on four
 * faces rather than an area distribution over hundreds of triangles.
 */
export function stepBox(size = [40, 30, 20]) {
  return {
    name: 'Box',
    vertices: boxCorners([0, 0, 0], size),
    faces: boxLoops(0),
    expect: {
      faceCount: 6,
      bbox: size,
      volume: size[0] * size[1] * size[2],
      sideDraftDeg: 0,
    },
  };
}

/*
 * A tapered box: a rectangular frustum whose four side faces each lean out
 * by exactly `draftDeg` from the pull axis (+z).
 *
 * This is the per-face draft fixture. Each side is a single planar face with
 * one exact angle, so a per-face reading has a right answer to hit —
 * tan(draft) = horizontal run over vertical rise, by construction.
 */
export function stepTaperedBox(base = [40, 30], height = 20, draftDeg = 3) {
  const run = height * Math.tan((draftDeg * Math.PI) / 180);
  const [bx, by] = base;
  return {
    name: 'TaperedBox',
    vertices: [
      ...boxCorners([0, 0, 0], [bx, by, 0]).slice(0, 4),
      ...boxCorners([run, run, height], [bx - run, by - run, height]).slice(4, 8),
    ],
    faces: boxLoops(0),
    expect: {
      faceCount: 6,
      draftDeg,
      /* The top is smaller than the base by the run on both sides. */
      topSize: [bx - 2 * run, by - 2 * run],
      height,
    },
  };
}

/*
 * An open-topped cup: a box shelled to a uniform wall, open at the top.
 *
 * Modelled as one closed shell rather than as a solid with a void, so every
 * face stays a simple loop — the rim is four quads rather than one annulus
 * with an inner bound. A real moulded part looks like this anyway.
 *
 * Answer: the wall is `wall` everywhere on the four sides and the floor, so
 * the sphere-fit and ray readings should both land on it.
 */
export function stepCup(size = [40, 30, 20], wall = 2) {
  const [sx, sy, sz] = size;
  const outer = boxCorners([0, 0, 0], [sx, sy, sz]);
  const inner = boxCorners([wall, wall, wall], [sx - wall, sy - wall, sz]);

  /* 0-7 outer, 8-15 inner. The inner shell is wound inward — its faces bound
     the cavity, so from the material's point of view they face the other way
     from the outer ones. */
  const vertices = [...outer, ...inner];
  const faces = [
    [0, 3, 2, 1],                       // outer floor, facing −z
    [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],  // outer sides
    [8 + 0, 8 + 1, 8 + 2, 8 + 3],       // cavity floor, facing +z into the cavity
    [8 + 0, 8 + 4, 8 + 5, 8 + 1], [8 + 1, 8 + 5, 8 + 6, 8 + 2],
    [8 + 2, 8 + 6, 8 + 7, 8 + 3], [8 + 3, 8 + 7, 8 + 4, 8 + 0],  // cavity sides
    /* The rim, as four quads between the outer and inner top edges. */
    [4, 5, 8 + 5, 8 + 4],
    [5, 6, 8 + 6, 8 + 5],
    [6, 7, 8 + 7, 8 + 6],
    [7, 4, 8 + 4, 8 + 7],
  ];

  return {
    name: 'Cup',
    vertices,
    faces,
    expect: {
      faceCount: 14,
      wall,
      bbox: size,
      /* Outer box less the cavity, which is open at the top. */
      volume: sx * sy * sz - (sx - 2 * wall) * (sy - 2 * wall) * (sz - wall),
    },
  };
}

/* Two separate solids for one file, to exercise the multi-body path: the
   body ranges, and the selector that only earns its place above one body. */
export function stepTwoBodies() {
  const a = { name: 'Left', vertices: boxCorners([0, 0, 0], [10, 10, 10]), faces: boxLoops(0) };
  const b = { name: 'Right', vertices: boxCorners([20, 0, 0], [30, 10, 10]), faces: boxLoops(0) };
  return {
    solids: [a, b],
    expect: { bodyCount: 2, faceCountEach: 6, bbox: [30, 10, 10] },
  };
}

/*
 * A flex insert buried in a polymer slab: the two-body assembly the FPC
 * designation exists for.
 *
 * Answers: cover over the insert's two large faces is (slabZ − flex) / 2, the
 * same everywhere, and its four edges sit `inset` from the slab's own so they
 * are covered too rather than coincident with the outside — coincident
 * surfaces are the one configuration a ray cast cannot resolve, and a fixture
 * should not lean on the answer to that.
 */
export function stepSlabWithInsert(slab = [40, 30, 4], flex = 0.2, inset = 1) {
  const [w, h, d] = slab;
  const iw = 20, ih = 10;
  const x0 = (w - iw) / 2, y0 = (h - ih) / 2;
  const zLo = d / 2 - flex / 2, zHi = d / 2 + flex / 2;
  return {
    solids: [
      { name: 'Housing', vertices: boxCorners([0, 0, 0], [w, h, d]), faces: boxLoops(0) },
      { name: 'Flex', vertices: boxCorners([x0, y0, zLo], [x0 + iw, y0 + ih, zHi]), faces: boxLoops(0) },
    ],
    expect: {
      bodyCount: 2,
      cover: (d - flex) / 2,
      insertEdgeCover: Math.min(x0, y0),
      inset,
    },
  };
}

/*
 * ── Cylindrical fixtures ───────────────────────────────────────────────────
 *
 * These exist because a radius cannot be read from the file — the reader
 * returns a triangle range per face and nothing else — so it has to be fitted,
 * and a fitted number is only worth anything against one that was authored.
 *
 * `revolve` is emitted by step-write.mjs as a whole solid: the lateral face,
 * the end caps, and on a partial sweep the two flat walls left by cutting it
 * short. A partial sweep is what produces a corner blend rather than a hole.
 */

/* A solid cylinder: one convex face all the way round. */
export function stepRod(radius = 8, height = 20) {
  return {
    solid: { name: 'Rod', vertices: [], faces: [{ revolve: { origin: [0, 0, 0], axis: [0, 0, 1], rOuter: radius, zLo: 0, zHi: height } }] },
    expect: { faceCount: 3, radius, kind: 'boss', extentDeg: 360, volume: Math.PI * radius * radius * height },
  };
}

/* A tube: convex outside, concave bore. The bore is the fixture that proves
   concavity is detected rather than assumed — it is the same shape as the rod,
   inside out. */
export function stepTube(rOuter = 10, rInner = 6, height = 20) {
  return {
    solid: { name: 'Tube', vertices: [], faces: [{ revolve: { origin: [0, 0, 0], axis: [0, 0, 1], rOuter, rInner, zLo: 0, zHi: height } }] },
    expect: {
      faceCount: 4, rOuter, rInner, extentDeg: 360,
      volume: Math.PI * (rOuter * rOuter - rInner * rInner) * height,
    },
  };
}

/* Half a tube: a partial sweep, so the same two surfaces become corner blends
   rather than a boss and a bore — an external round outside, an internal
   fillet inside. Both partial branches in one fixture. */
export function stepHalfTube(rOuter = 10, rInner = 6, height = 20) {
  return {
    solid: {
      name: 'HalfTube', vertices: [],
      faces: [{ revolve: { origin: [0, 0, 0], axis: [0, 0, 1], rOuter, rInner, zLo: 0, zHi: height, fromDeg: 0, toDeg: 180 } }],
    },
    expect: {
      faceCount: 6, rOuter, rInner, extentDeg: 180,
      volume: Math.PI * (rOuter * rOuter - rInner * rInner) * height / 2,
    },
  };
}

/* A quarter rod: the shape of a fillet on an outside edge, and a volume with
   an exact closed form to check the tessellation against. */
export function stepQuarterRod(radius = 4, height = 12) {
  return {
    solid: {
      name: 'QuarterRod', vertices: [],
      faces: [{ revolve: { origin: [0, 0, 0], axis: [0, 0, 1], rOuter: radius, zLo: 0, zHi: height, fromDeg: 0, toDeg: 90 } }],
    },
    expect: { faceCount: 5, radius, kind: 'round', extentDeg: 90, volume: Math.PI * radius * radius * height / 4 },
  };
}

/* The same rod down a diagonal. Nothing in the fit may depend on the cylinder
   being aligned to an axis, and this is what says so. */
export function stepTiltedRod(radius = 7, height = 25) {
  const k = 1 / Math.sqrt(3);
  return {
    solid: { name: 'TiltedRod', vertices: [], faces: [{ revolve: { origin: [0, 0, 0], axis: [k, k, k], rOuter: radius, zLo: 0, zHi: height } }] },
    expect: { radius, axis: [k, k, k], volume: Math.PI * radius * radius * height },
  };
}

/* A tube whose bore is a hair across: a real internal corner modelled far
   too sharp, which the radius check must condemn rather than merely note. */
export function stepSharpFillet(rInner = 0.2) {
  return {
    solid: {
      name: 'SharpFillet', vertices: [],
      faces: [{ revolve: { origin: [0, 0, 0], axis: [0, 0, 1], rOuter: 10, rInner, zLo: 0, zHi: 20, fromDeg: 0, toDeg: 180 } }],
    },
    expect: { rInner },
  };
}
