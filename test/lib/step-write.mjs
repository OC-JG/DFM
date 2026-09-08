/*
 * A minimal STEP (AP214) writer for polyhedral solids.
 *
 * The STEP path had no fixture, and occt-import-js is a reader — it cannot
 * write a STEP file — so a fixture has to be authored rather than exported
 * from a kernel. That is the point, not a workaround: a file written from an
 * analytic definition here has the same standing as the meshes in shapes.mjs,
 * where the expected answer comes from the geometry rather than from a
 * previous run of the code under test. A file exported by OpenCascade and
 * then read back by OpenCascade could agree with itself and still be wrong.
 *
 * Planar faces, and cylindrical ones. The cylinders arrived when radius
 * measurement did: a fillet, a hole and a boss are all cylindrical faces, and
 * a fixture with a known radius is the only way to prove a fitted one. A full
 * cylinder needs a seam — two circular edges joined by a straight edge walked
 * once in each direction — which is the fiddliest part of this file and the
 * part OpenCascade is least forgiving about.
 *
 * Topology is built properly rather than approximately: every edge is a
 * single EDGE_CURVE shared by exactly two faces, oriented .T. in one and .F.
 * in the other. OpenCascade will happily read a sloppier file and quietly
 * produce a shell with cracks in it, which is exactly the kind of fixture
 * that makes a test pass for the wrong reason.
 */

/*
 * A STEP real. Three things this has to get right, all of which bit:
 *
 *   - it must carry a decimal point, or it is an integer to the parser;
 *   - an exponent must be a capital E — a lowercase one is a syntax error,
 *     which is how the first partial sweep produced a file OpenCascade
 *     complained about and then read anyway, wrongly;
 *   - trailing zeros may only be trimmed after a decimal point, or 1000
 *     serialises as 1.
 *
 * Values a hair off zero are snapped to it. cos(90°) comes back as 6.1e-17,
 * which is not a coordinate, it is arithmetic dust — and keeping it costs an
 * exponent in the file for no accuracy at all. Fifteen significant digits
 * keeps a 3° taper exact enough that the draft measured off the tessellation
 * is limited by the tessellation rather than by the fixture.
 */
const f = (n) => {
  let v = Number(n);
  if (!Number.isFinite(v)) throw new Error(`step-write: ${n} is not a finite coordinate`);
  if (Math.abs(v) < 1e-12) v = 0;
  let out = v.toPrecision(15);
  if (out.includes('e')) {
    const [mantissa, exp] = out.split('e');
    out = `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${exp}`;
    return out;
  }
  if (out.includes('.')) out = out.replace(/0+$/, '');
  if (out.endsWith('.')) out += '0';
  return out.includes('.') ? out : `${out}.`;
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (v) => {
  const m = Math.hypot(v[0], v[1], v[2]);
  if (m === 0) throw new Error('step-write: degenerate direction — a face loop has repeated or collinear points');
  return [v[0] / m, v[1] / m, v[2] / m];
};

/*
 * solids: [{ vertices: [[x,y,z], …], faces: [[i, j, k, …], …] }]
 *
 * Each face is either a closed loop of vertex indices, listed counter-clockwise
 * as seen from outside the solid — the same convention shapes.mjs uses, so a
 * face list can be shared between a mesh fixture and a STEP one — or, for a
 * curved face, an object:
 *
 *   { cylinder: { origin, axis, radius, zLo, zHi, outward } }
 *
 * which emits the lateral face of a full cylinder between two planes normal to
 * `axis`. `outward` false makes it a bore: the material is outside and the
 * face normal points at the axis.
 */
export function writeStepSolids(solids, name = 'fixture') {
  const lines = [];
  let next = 1;
  const put = (body) => { const id = next++; lines.push(`#${id}=${body};`); return id; };

  /* ── unit and context boilerplate ──────────────────────────────────────
     Millimetres, declared explicitly: the tool's every threshold is in mm,
     and a STEP file that fails to say so is how an inch-authored part gets
     measured as if it were metric. */
  const appContext = put("APPLICATION_CONTEXT('automotive design')");
  put(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appContext})`);
  const lenUnit = put('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angUnit = put('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solUnit = put('(NAMED_UNIT(*)SOLID_ANGLE_UNIT()SI_UNIT($,.STERADIAN.))');
  const tol = put(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${lenUnit},'distance_accuracy_value','')`);
  const geoContext = put(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${tol}))`
    + `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnit},#${angUnit},#${solUnit}))REPRESENTATION_CONTEXT('',''))`);

  const origin = put("CARTESIAN_POINT('',(0.,0.,0.))");
  const dirZ = put("DIRECTION('',(0.,0.,1.))");
  const dirX = put("DIRECTION('',(1.,0.,0.))");
  const placement = put(`AXIS2_PLACEMENT_3D('',#${origin},#${dirZ},#${dirX})`);

  const brepIds = [];

  for (const [si, solid] of solids.entries()) {
    const { vertices, faces } = solid;

    /* One VERTEX_POINT per vertex, shared by every face that touches it. */
    const vertexIds = vertices.map((v) => {
      const p = put(`CARTESIAN_POINT('',(${f(v[0])},${f(v[1])},${f(v[2])}))`);
      return put(`VERTEX_POINT('',#${p})`);
    });

    /* One EDGE_CURVE per undirected pair, keyed low→high so the two faces
       sharing it find the same entity and disagree only in orientation. */
    const edges = new Map();
    const edgeFor = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let rec = edges.get(key);
      if (!rec) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const p = put(`CARTESIAN_POINT('',(${f(vertices[lo][0])},${f(vertices[lo][1])},${f(vertices[lo][2])}))`);
        const d = norm(sub(vertices[hi], vertices[lo]));
        const dir = put(`DIRECTION('',(${f(d[0])},${f(d[1])},${f(d[2])}))`);
        const vec = put(`VECTOR('',#${dir},1.)`);
        const line = put(`LINE('',#${p},#${vec})`);
        const id = put(`EDGE_CURVE('',#${vertexIds[lo]},#${vertexIds[hi]},#${line},.T.)`);
        rec = { id, lo };
        edges.set(key, rec);
      }
      return rec;
    };

    /*
     * A rod or a tube, emitted whole.
     *
     * The lateral face and the end faces have to *share* their circular edges
     * or the shell is not closed, and an unclosed shell quietly breaks
     * everything downstream — ray casts escape, the volume is undefined. So
     * this emits the whole solid rather than offering a lone cylindrical face
     * that a caller would have to stitch by hand.
     *
     * A 360° face cannot be bounded by its circles alone: the loop runs up a
     * seam, round the top, back down the same seam and round the bottom, so
     * the seam edge appears twice in one loop, once .T. and once .F. That is
     * what a periodic surface's boundary looks like, and OpenCascade rejects
     * the face without it.
     */
    const revolveFaces = ({ origin, axis, rOuter, rInner = null, zLo, zHi, fromDeg = 0, toDeg = 360 }) => {
      const a = norm(axis);
      let refRaw = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const proj = refRaw[0] * a[0] + refRaw[1] * a[1] + refRaw[2] * a[2];
      const ref = norm([refRaw[0] - proj * a[0], refRaw[1] - proj * a[1], refRaw[2] - proj * a[2]]);
      /* ref × axis completes a right-handed frame, so angles measured from ref
         increase counter-clockwise about the axis — the same direction STEP
         parameterises a CIRCLE in, which is what makes an arc's two vertices
         unambiguous. */
      const tan = [
        a[1] * ref[2] - a[2] * ref[1],
        a[2] * ref[0] - a[0] * ref[2],
        a[0] * ref[1] - a[1] * ref[0],
      ];

      const full = (toDeg - fromDeg) >= 360 - 1e-9;
      const rad = (deg) => (deg * Math.PI) / 180;
      const pt = (v) => put(`CARTESIAN_POINT('',(${f(v[0])},${f(v[1])},${f(v[2])}))`);
      const dir = (v) => put(`DIRECTION('',(${f(v[0])},${f(v[1])},${f(v[2])}))`);
      const at = (z) => [origin[0] + a[0] * z, origin[1] + a[1] * z, origin[2] + a[2] * z];
      const on = (z, r, deg) => {
        const c = at(z), t = rad(deg);
        const cs = Math.cos(t), sn = Math.sin(t);
        return [
          c[0] + (ref[0] * cs + tan[0] * sn) * r,
          c[1] + (ref[1] * cs + tan[1] * sn) * r,
          c[2] + (ref[2] * cs + tan[2] * sn) * r,
        ];
      };

      const vert = new Map();
      const vertAt = (z, r, deg) => {
        const key = `${z}:${r}:${deg}`;
        if (!vert.has(key)) vert.set(key, put(`VERTEX_POINT('',#${pt(on(z, r, deg))})`));
        return vert.get(key);
      };

      /* An arc — or, when the sweep is the whole turn, a closed circular edge
         that begins and ends at the same vertex. */
      const arc = new Map();
      const arcAt = (z, r) => {
        const key = `${z}:${r}`;
        if (!arc.has(key)) {
          const ax = put(`AXIS2_PLACEMENT_3D('',#${pt(at(z))},#${dir(a)},#${dir(ref)})`);
          const c = put(`CIRCLE('',#${ax},${f(r)})`);
          const v0 = vertAt(z, r, fromDeg);
          const v1 = full ? v0 : vertAt(z, r, toDeg);
          arc.set(key, put(`EDGE_CURVE('',#${v0},#${v1},#${c},.T.)`));
        }
        return arc.get(key);
      };

      /* A straight edge between two of the corner vertices. */
      const line = new Map();
      const lineAt = (p0, p1) => {
        const key = `${p0.join()}|${p1.join()}`;
        if (!line.has(key)) {
          const a0 = on(...p0), a1 = on(...p1);
          const d = norm([a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]]);
          const l = put(`LINE('',#${pt(a0)},#${put(`VECTOR('',#${dir(d)},1.)`)})`);
          line.set(key, put(`EDGE_CURVE('',#${vertAt(...p0)},#${vertAt(...p1)},#${l},.T.)`));
        }
        return line.get(key);
      };

      const oe = (edge, sense) => put(`ORIENTED_EDGE('',*,*,#${edge},.${sense ? 'T' : 'F'}.)`);
      const loopOf = (entries) => put(`EDGE_LOOP('',(${entries.map((i) => `#${i}`).join(',')}))`);
      const outerBound = (loopId) => put(`FACE_OUTER_BOUND('',#${loopId},.T.)`);

      const lateral = (r, outward) => {
        let entries;
        if (full) {
          /* A periodic face cannot close on its circles alone: the loop runs
             up a seam, round the top, back down the same seam and round the
             bottom, so the seam appears twice — once .T. and once .F. That is
             what a full cylinder's boundary looks like, and OpenCascade
             rejects the face without it. */
          const seam = lineAt([zLo, r, fromDeg], [zHi, r, fromDeg]);
          entries = [oe(arcAt(zLo, r), true), oe(seam, true), oe(arcAt(zHi, r), false), oe(seam, false)];
        } else {
          entries = [
            oe(arcAt(zLo, r), true),
            oe(lineAt([zLo, r, toDeg], [zHi, r, toDeg]), true),
            oe(arcAt(zHi, r), false),
            oe(lineAt([zLo, r, fromDeg], [zHi, r, fromDeg]), false),
          ];
        }
        const bound = outerBound(loopOf(entries));
        const surfAx = put(`AXIS2_PLACEMENT_3D('',#${pt(at(0))},#${dir(a)},#${dir(ref)})`);
        const surf = put(`CYLINDRICAL_SURFACE('',#${surfAx},${f(r)})`);
        /* same_sense .F. turns the surface normal inward: the difference
           between a boss and a bore. */
        return put(`ADVANCED_FACE('',(#${bound}),#${surf},.${outward ? 'T' : 'F'}.)`);
      };

      /* An end face: a disc, an annulus, or a sector of either. */
      const cap = (z, up) => {
        const n = up ? a : [-a[0], -a[1], -a[2]];
        const ax = put(`AXIS2_PLACEMENT_3D('',#${pt(at(z))},#${dir(n)},#${dir(ref)})`);
        const plane = put(`PLANE('',#${ax})`);
        let bounds;
        if (full) {
          bounds = [outerBound(loopOf([oe(arcAt(z, rOuter), true)]))];
          if (rInner != null) {
            bounds.push(put(`FACE_BOUND('',#${loopOf([oe(arcAt(z, rInner), true)])},.T.)`));
          }
        } else if (rInner != null) {
          bounds = [outerBound(loopOf([
            oe(arcAt(z, rOuter), true),
            oe(lineAt([z, rInner, toDeg], [z, rOuter, toDeg]), false),
            oe(arcAt(z, rInner), false),
            oe(lineAt([z, rInner, fromDeg], [z, rOuter, fromDeg]), true),
          ]))];
        } else {
          bounds = [outerBound(loopOf([
            oe(arcAt(z, rOuter), true),
            oe(lineAt([z, 0, toDeg], [z, rOuter, toDeg]), false),
            oe(lineAt([z, 0, fromDeg], [z, rOuter, fromDeg]), true),
          ]))];
        }
        return put(`ADVANCED_FACE('',(${bounds.map((i) => `#${i}`).join(',')}),#${plane},.T.)`);
      };

      /* The flat wall left by cutting the sweep short, at one end of the arc. */
      const cut = (deg, outwardTangent) => {
        const rLo = rInner != null ? rInner : 0;
        const entries = [
          oe(lineAt([zLo, rLo, deg], [zLo, rOuter, deg]), true),
          oe(lineAt([zLo, rOuter, deg], [zHi, rOuter, deg]), true),
          oe(lineAt([zHi, rLo, deg], [zHi, rOuter, deg]), false),
          oe(lineAt([zLo, rLo, deg], [zHi, rLo, deg]), false),
        ];
        const bound = outerBound(loopOf(entries));
        const t = rad(deg), cs = Math.cos(t), sn = Math.sin(t);
        const tangent = norm([
          -ref[0] * sn + tan[0] * cs,
          -ref[1] * sn + tan[1] * cs,
          -ref[2] * sn + tan[2] * cs,
        ]);
        const n = outwardTangent ? tangent : [-tangent[0], -tangent[1], -tangent[2]];
        const ax = put(`AXIS2_PLACEMENT_3D('',#${pt(on(zLo, rLo, deg))},#${dir(n)},#${dir(a)})`);
        const plane = put(`PLANE('',#${ax})`);
        return put(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
      };

      const ids = [lateral(rOuter, true), cap(zHi, true), cap(zLo, false)];
      if (rInner != null) ids.push(lateral(rInner, false));
      if (!full) ids.push(cut(fromDeg, false), cut(toDeg, true));
      return ids;
    };

    const faceIds = faces.flatMap((spec) => {
      if (spec && spec.revolve) return revolveFaces(spec.revolve);
      const loop = spec;
      if (loop.length < 3) throw new Error('step-write: a face needs at least three vertices');

      const orientedIds = loop.map((a, k) => {
        const b = loop[(k + 1) % loop.length];
        const rec = edgeFor(a, b);
        /* .T. when this face traverses the shared edge in the direction the
           EDGE_CURVE was authored in, .F. when it runs the other way. */
        return put(`ORIENTED_EDGE('',*,*,#${rec.id},.${rec.lo === a ? 'T' : 'F'}.)`);
      });

      const loopId = put(`EDGE_LOOP('',(${orientedIds.map((i) => `#${i}`).join(',')}))`);
      const bound = put(`FACE_OUTER_BOUND('',#${loopId},.T.)`);

      /* The plane's normal is the loop's own normal, so same_sense is .T.
         and the face's outward direction follows the winding rather than
         being asserted separately. */
      const p0 = vertices[loop[0]];
      const n = norm(cross(sub(vertices[loop[1]], p0), sub(vertices[loop[2]], p0)));
      const ref = norm(sub(vertices[loop[1]], p0));
      const pt = put(`CARTESIAN_POINT('',(${f(p0[0])},${f(p0[1])},${f(p0[2])}))`);
      const nd = put(`DIRECTION('',(${f(n[0])},${f(n[1])},${f(n[2])}))`);
      const rd = put(`DIRECTION('',(${f(ref[0])},${f(ref[1])},${f(ref[2])}))`);
      const ax = put(`AXIS2_PLACEMENT_3D('',#${pt},#${nd},#${rd})`);
      const plane = put(`PLANE('',#${ax})`);
      return [put(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`)];
    });

    const shell = put(`CLOSED_SHELL('',(${faceIds.map((i) => `#${i}`).join(',')}))`);
    brepIds.push(put(`MANIFOLD_SOLID_BREP('${solid.name || `Body ${si + 1}`}',#${shell})`));
  }

  const shapeRep = put(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('${name}',(#${placement},${brepIds.map((i) => `#${i}`).join(',')}),#${geoContext})`);

  const product = put(`PRODUCT('${name}','${name}','',(#${put(`PRODUCT_CONTEXT('',#${appContext},'mechanical')`)}))`);
  const formation = put(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  const defContext = put(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appContext},'design')`);
  const definition = put(`PRODUCT_DEFINITION('','',#${formation},#${defContext})`);
  const defShape = put(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);
  put(`SHAPE_DEFINITION_REPRESENTATION(#${defShape},#${shapeRep})`);

  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('OnlyCat DFM test fixture'),'2;1');",
    `FILE_NAME('${name}','1970-01-01T00:00:00',('OnlyCat DFM tests'),(''),'test/lib/step-write.mjs','',''); `.trim(),
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 -1 1 5 4 }'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
