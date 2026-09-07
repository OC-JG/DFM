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
 * Planar faces only, which is all the fixtures need: a box, a tapered box
 * with a known draft on its sides, a shelled box with a known wall, and two
 * solids in one file. Curved surfaces would mean cylindrical_surface and a
 * seam, and nothing in the tests wants one yet.
 *
 * Topology is built properly rather than approximately: every edge is a
 * single EDGE_CURVE shared by exactly two faces, oriented .T. in one and .F.
 * in the other. OpenCascade will happily read a sloppier file and quietly
 * produce a shell with cracks in it, which is exactly the kind of fixture
 * that makes a test pass for the wrong reason.
 */

const f = (n) => {
  /* STEP reals must carry a decimal point. Fifteen significant digits keeps
     a 3° taper's coordinates exact enough that the draft measured off the
     tessellation is limited by the tessellation, not by the fixture. */
  const s = Number(n).toPrecision(15).replace(/0+$/, '').replace(/\.$/, '.0');
  return s.includes('.') || s.includes('E') ? s : `${s}.`;
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
 * Each face is a closed loop of vertex indices, listed counter-clockwise as
 * seen from outside the solid — the same convention shapes.mjs uses, so a
 * face list can be shared between a mesh fixture and a STEP one.
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

    const faceIds = faces.map((loop) => {
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
      return put(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
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
