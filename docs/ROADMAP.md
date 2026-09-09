# OnlyCat DFM — roadmap

`docs/ASSESSMENT.md` was a review of a tool that had just been rebuilt: what was
wrong with it, and a five-phase plan to fix it. Those phases are delivered, and
its closing "Still open" list is the honest residue of that work rather than a
plan in its own right. This document replaces that list. It is forward-looking:
what the tool cannot yet do, why each gap matters, in what order the gaps should
close, and what would have to be true before each is called done.

Every claim below is anchored to a file and, where it helps, a line. Nothing
here is aspirational architecture — each item is either a gap something concrete
depends on, or a decision someone has to make.

---

## Where the tool stands

What the tool does well is measurement it can defend. Wall thickness is taken
two ways and judged on the pessimistic one (`src/analysis/mesh.js`), every score
traces to the rule and weight that produced it (`src/rules/scoring.js`), the
geometry is validated before it is measured (`src/geometry/validate.js`), the
gate is searched for rather than guessed at (`src/analysis/flow.js`), and the
unit tests assert numbers against analytic answers and an independent reference
implementation rather than against the code under test (`test/unit.mjs`,
`test/lib/reference.mjs`). The heavy work runs off the main thread with an
inline fallback for `file://`, and CI proves the committed artifact matches
source, that the offline build works with every off-origin request refused, and
that no id `src/app` reaches for has gone missing from the markup.

That is a solid base. The gaps are all of one kind: the tool measures a
*triangle soup* and reports on it, and everything it cannot yet say is
downstream of that — or downstream of a number nobody has signed off on.

Four things are holding it back, and they are the spine of this roadmap.

**1. The primary input path is the only untested one.** `.ipt` is now the
headline input, and `.ipt` arrives as STEP: `src/app/main.js:61` routes an
Inventor part through `parseSTEP`, the same function a dropped `.step` uses at
`main.js:67`. There is no STEP fixture anywhere in `test/`, so
`src/geometry/step.js` — 122 lines that merge multi-body meshes, remap indices
and carry B-rep face groups — has no automated coverage at all. Both the unit
suite and the browser smoke test drive STL. The path a user is most likely to
take is the path a regression is most likely to survive on.

**2. B-rep faces are extracted and then thrown away.** `src/geometry/step.js:96`
builds a `faceGroups` array mapping triangle ranges to B-rep faces, and
`step.js:119` returns it. Nothing consumes it. Not `src/analysis/mesh.js`, which
documents itself as "per-triangle draft" at line 9; not `src/rules/engine.js`.
Two consequences follow. The `corners` check carries `weight: 0` with the
comment "cannot be measured without B-rep" (`src/rules/scoring.js:82`) — a real
moulding defect the tool can only advise about. And the README and
`src/app/bridge.js:9-11` both tell the user that routing through STEP is what
"lets draft be measured per face rather than per triangle", which is a promise
about a capability the code does not have yet. The data is already in memory;
what is missing is the consumer.

**3. The Inventor loop, the flagship feature, has no test.** `grep -i bridge
test/*.mjs` returns nothing. `src/app/bridge.js` — connect, detect simulator
versus real Inventor, export STEP, list driving parameters, push a parameter
edit, pull the rebuilt geometry back — is exercised only by hand against a live
Inventor. That is the loop the tool exists to close, and it is the part that can
break silently between sessions.

**4. What leaves the tool cannot be identified later.** The JSON export
(`src/export/json.js:11-13`) records the tool name, session id and timestamp,
but not the build it came from. `src/rules/compare.js` raises caveats when the
material, the mode or the set of checks changed between two runs
(`compare.js:51`, `:54`, `:59`) — but not when the *rules* changed, because it
has no way to know. A threshold edit in `src/rules/engine.js` moves every score
in the archive, and a comparison across that edit reports the movement as a
change in the part. Findings likewise have no stable identifiers: nothing in
`engine.js` emits an id, so "finding 3" in a PDF sent to a factory is a position
in a list, not a handle. The built file (`dfm-tool.html`) carries a licence
banner and no version, so a recipient holding the file has no way to say which
build they were sent.

---

## Milestones

Version numbers are targets for the `version` field in `package.json`, which
reads `2.1.0` — prepared for the first tag, and the reason `2.0.0` was retired
unreleased is in `CHANGELOG.md`. Effort is calendar days of focused work,
in the same units the delivered phases in `docs/ASSESSMENT.md` were estimated
in — those ran roughly to estimate, which is the only reason to trust these.

| | Milestone | Effort | Blocks / blocked by |
|---|---|---|---|
| R2.1 | Trust the STEP path | ~~3–5 d~~ done | Unblocked R2.2, R2.3 |
| R2.2 | Features, not triangles | ~~1–2 wk~~ done | unblocked nothing further |
| R2.3 | The Inventor loop under test | ~~4–6 d~~ done | one part blocked upstream |
| R2.4 | Numbers that get quoted | ~~1 wk~~ done | — |
| R2.5 | Two-shot and FPC earn their weights | ~~1–2 wk~~ two of three done | third part blocked on datasheets |
| R2.6 | Findings that survive leaving the tool | ~~4–6 d~~ done | — |
| R2.7 | Navigation for people who navigate for a living | ~~1–2 wk~~ done, untested on hardware | — |
| — | Release discipline | 2–3 d | Independent, do first |

### R2.1 — Trust the STEP path *(done)*

**What shipped.** `test/step.mjs` — 23 assertions over the path an `.ipt`
actually takes — plus the two pieces that make it possible and four checks in
the browser suite. `npm run test:step`, and CI runs it after the unit tests and
before the Chromium download.

- **The reader is a pinned devDependency, not a vendored blob.** The plan here
  said to copy the ~6 MB OpenCascade module into `test/vendor/`. It did not need
  copying: the module the tool fetches from a CDN *is* an npm package, so
  `occt-import-js` is pinned at `0.0.23` — the same version the artifact
  requests — and the existing `npm ci` covers it. Nothing was added to git, and
  the shipped artifact's lazy CDN load is untouched.
- **The fixtures are authored, not exported**, and this turned out to be the
  interesting part. `occt-import-js` is a reader: it cannot write STEP, so a
  fixture could not simply be exported from the kernel under test. So
  `test/lib/step-write.mjs` emits a real AP214 file — proper shared topology,
  every edge one `EDGE_CURVE` used `.T.` in one face and `.F.` in the other,
  because OpenCascade will read a sloppier file and quietly hand back a shell
  with cracks in it. `test/lib/solids.mjs` defines the solids analytically, the
  way `shapes.mjs` does for meshes. A 3° taper is 3° because it was written as
  `tan(3°)`, not because a kernel wrote it out and read it back and agreed with
  itself.
- **A test seam in `parseSTEP`.** `loadOcct` needs a DOM to inject its script
  tag, so the function takes an optional module argument that nothing in the app
  supplies. Eleven lines, and the reason it exists is written above it.
- **Four fixtures**: a box (six faces, 0° draft — the part the draft check must
  fail), a tapered box (four sides at exactly 3°), a shelled box with a 2 mm
  wall, and two solids in one file.
- **In the browser too.** The smoke suite now serves the OpenCascade reader and
  its wasm from `node_modules` and drives `part.step` through load, analysis and
  the wall reading, then a two-solid file through the body selector. Node proves
  the parsing; only a browser shows the reader loading lazily over the wire and
  landing in the viewer.

**Exit criteria, met.** The face ranges partition every triangle exactly once;
every triangle in a face group is coplanar with its face to 1e-6 — the property
R2.2 rests on, and the difference between a label and a real mapping; a 3° taper
reads 3.000° per face; the same solid measured as a B-rep and as triangulated
soup agrees on volume, surface area and wall to 0.1%.

And the criterion that mattered most — that a deliberate off-by-one fails —
was checked by making three of them rather than by assuming. A wrong vertex
offset in the merge fails six assertions, a face-group range off by one fails
three, and a body range off by one fails one. The body fixture puts its two
boxes 20 mm apart along x specifically so a wrong offset lands a triangle in
the neighbouring solid and cannot be mistaken for rounding.

**Still open from this milestone.** `BREP_WITH_VOIDS` — the shelled fixture is
an open-topped cup, one closed shell, which is what a moulded part looks like
anyway. Curved surfaces were the other omission and R2.2 closed it: the writer
now emits `CYLINDRICAL_SURFACE` faces, full turns with a seam and partial
sweeps with arc-bounded caps.

### R2.2 — Features, not triangles *(done)*

**Why now.** This is the largest single capability unlock in the repo, the data
is already being computed and discarded (gap 2), the documentation already
claims part of it — and R2.1 has now put a fixture under it, so there is
something trustworthy to assert a per-face measurement against.

**What ships.**

- **`faceGroups` survives into analysis.** *(done)* `analyseMesh` takes
  `geom.faceGroups` when the source carried it and aggregates the per-triangle
  results by face. Nothing is re-measured: draft per triangle, the inner/outer
  ray classification and the two-piece rule all run as before, and a test
  asserts the per-face verdict and the area statistic agree to 1e-6 — they are
  one measurement grouped two ways, and if that ever stops being true the test
  says so. `src/geometry/weld.js` still nulls `faceGroups`, which is correct
  (welding merges vertices across face boundaries and destroys the mapping) and
  now carries a comment saying to route the mapping through the merge rather
  than delete the line.
- **Draft per face.** *(done)* The check names them: *4 of 4 side faces are
  under 0.50° — face 2 0.00° (29% of side area, outer)*. A face is given a
  single angle only where it has one; a face whose triangle normals fan out
  reports the range it spans instead, because one number for a curved face
  would be a fiction. This makes the README's existing claim true.
- **Provenance, stated.** *(done)* `measured_from` is `brep` or `mesh`, in the
  check's own metrics and in the JSON export. The same part through the two
  doors produces different records — not contradictory ones — and a consumer
  comparing two exports needs to know which it holds.
- **Corner radii, measured.** *(done — and the plan for it was wrong.)* This
  section said cylindrical and toroidal faces in the STEP data give radii
  directly. They do not: `occt-import-js` returns `{first, last, color}` per
  face and nothing else — no surface type, no radius, no axis. So a radius is
  **fitted** rather than read. A cylinder's outward normals all lie square to
  its axis, so they span a plane and the axis is the direction they never point
  in — the eigenvector of their covariance with the smallest eigenvalue. A
  circle fitted to the face's vertices projected onto that plane gives the
  radius; which way the normals lean gives convex against concave; how far the
  face sweeps separates a whole feature from a corner blend.

  This turned out better than reading a field would have been. It works on any
  B-rep source rather than on one reader's metadata, it fails honestly — a face
  that fits nothing is reported unmeasured rather than as a number — and it is
  orientation-free: a rod down the (1,1,1) diagonal fits its axis to 1e-3, and
  a test says so.

  The fit declines far more often than it succeeds, which took as much care as
  making it succeed. A flat face is left flat; so is a face whose radius comes
  out at five metres, which is a plane with rounding on it rather than a
  fillet. That guard was the one a mutation test caught unprotected — removing
  it broke nothing, because the fixtures never reached it — and it now has a
  test built from the numerical edge it defends rather than from a shape.
- **Holes and bosses as features.** *(done)* The same fit, read differently: a
  full sweep is a bore or a boss rather than a blend. Reported, never judged —
  a hole is not a corner — because "three Ø8 bores and a Ø12 boss" is what
  someone wants before quoting a tool.
- **`corners` off `weight: 0`.** *(done, and this is the decision the milestone
  had to make.)* Neither of the two answers the roadmap offered was taken.
  Rather than moving weight between the eight checks that sum to 100, or
  widening the default budget for every part, the scored check is a **separate
  key** — `corner_radii` — that is pushed only when there were faces to fit. An
  STL keeps the advisory, the old budget and the old score, so no existing
  export moves; a B-rep gains 8 points of exposure, exactly as the FPC and
  wall-transition checks do. Eight rather than eleven for a reason worth
  repeating: the check can only judge the radii that *exist*, and a corner
  modelled dead sharp has no face to fit, so a check that cannot see the worst
  version of its own defect should not carry the weight of one that can.

**Exit criteria, all met.** A 3° taper reads 3.000° on each of its four side
faces and a box reads 0.00° on each of its. A rod fits R8.000, a bore R6.000, a
half-tube gives an external round and an internal fillet from one fixture, and a
quarter rod reads 90°. Radii are measured rather than advised on, and
`corner_radii` carries a weight — asserted as a budget of 108 on a part that can
be measured and 100 on one that cannot, so the decision is in a test rather than
only in a comment.

**Risk.** Scope — and the mitigation held. "Feature recognition" can absorb a
quarter with nothing shipped, so the deliverables were taken in the order given
and the first shipped on its own. Taking them in that order is also what
surfaced the radius problem early, while it was still a re-plan rather than a
half-built feature.

### R2.3 — The Inventor loop under test *(done)*

**Why now.** It is the differentiator (gap 3), it is unverified, and it has an
external dependency that will change underneath it.

**What ships.**

- **A fake InventorMCP server.** *(done)* `test/lib/fake-bridge.mjs` — a real
  HTTP server on its own origin speaking the real protocol, so `bridge.js` runs
  its actual fetch calls against it. The part that matters is that it
  **rebuilds**: a parameter change regenerates the STEP from the analytic solid
  with the new value, so the loop is proved by measurement rather than by
  wiring. Drive `wall` to 3 and the tool has to come back reading a 3 mm wall.
  A server returning a canned payload would pass a test that proved nothing.
- **The three chip states, and the failure modes.** *(done)* Connected to
  Inventor, connected to the simulator, nothing listening — and then the ones
  that were handled nowhere visible: a modal dialog in Inventor, a rebuild the
  part refuses, a value Inventor cannot evaluate, a model whose STEP body 404s,
  a request that never answers, and the quiet one — a rebuild that comes back
  in inches, which errors nowhere and is caught by the unit check instead.
- **A recorded contract for the protocol.** *(done)* The routes, methods and
  headers the bridge actually calls, asserted as a sequence. InventorMCP is a
  separate repository on its own release cycle and nothing would have noticed a
  renamed route until a user did; renaming one now fails three assertions here.
- **The loop in a browser too.** *(done)* The smoke suite drives it the way a
  user does: the chip goes live, an `.ipt` opens through the bridge, the
  driving parameters are listed, the analysis reads 2 mm, the parameter is
  typed and committed with Enter, Inventor rebuilds, History records the
  change, and the re-run reads 3 mm.
- **Findings linked back to the feature that caused them.** *Still open, and
  not this repository's to close.* This assumed the bridge "gives faces a
  feature". It does not: what arrives is a flat list of `{kind, name,
  suppressed}` with nothing tying a face to the feature that made it. R2.2 gave
  findings a face, so the remaining half is a mapping only InventorMCP can
  supply — a protocol change there, not work here. Worth asking for: with it, a
  finding could name the feature and the driving parameter responsible, which
  is the difference between "fix this dimension" and "here is a heatmap".

**Exit criteria, met.** `npm test` covers the bridge with no Inventor installed
and no browser — 17 assertions in Node, 7 more in the browser suite. Each
failure mode produces a specific message carrying its own fix rather than a
status code, asserted on the text. The protocol contract fails on a renamed
route: four mutations were checked, and renaming `/bridge/health` fails three
assertions, dropping the `x-filename` header fails one, ignoring the server's
`ok: false` convention fails three, and returning stale geometry from a rebuild
fails one.

**Risk, and it is real.** A fixture server can drift from the real InventorMCP
and give false confidence. The payloads are dated in the file against the routes
`bridge.js` called on 2026-09-07, and the contract test is what should fail
first if either side moves — but nothing here can detect the real server
changing shape while the fake one stays still. Recording the fixture payloads
from a live session, rather than shaping them from the client code as these
were, would close that gap.

### R2.4 — Numbers that get quoted *(done)*

**Why now.** Because cycle time and cost are what someone asks for first, and
because the tool is deliberately silent on both — correctly, until one question
is answered.

**The decision that gated it is made.** *(answered — see `docs/coolk.md`.)*
`coolK` is written for the **full wall**, not the half-wall its comment claimed.
Re-derived rather than asked, which was one of the three routes open and the one
that needed nobody: rearranged through the plate-cooling solution, each
coefficient implies a thermal diffusivity, and diffusivity is a measured
property with a known range. The full-wall reading puts all sixteen materials
inside 0.088–0.168 mm²/s; the half-wall reading puts every one of them three to
seven times below any polymer that exists. For ABS to be half-wall *and*
physical, the part would have to eject at 155 °C — 57 °C above its own HDT,
still soft. The comment is corrected and `test/unit.mjs` asserts the convention,
so it cannot drift back.

Two things the answer does **not** settle, and the first is the one that still
needs a judgement before a number goes on screen:

- The formula gives the **theoretical cooling floor** — centre plane first
  reaching ejection temperature, mould wall held fixed, heat leaving in one
  dimension. A real cycle runs longer; practice is commonly 1.5–2×. On a 2 mm
  ABS wall that is 6.8 s against nearer 10–14 s. Whichever is printed has to say
  which it is.
- The polyolefins imply the *highest* diffusivities in the table (PP 0.160,
  HDPE 0.166, PE 0.168) where a semi-crystalline's effective value should sit
  lowest, because latent heat of crystallisation has to come out before the part
  is rigid. Both readings share this, so it does not affect the convention — but
  it does suggest `coolK` for the polyolefins is optimistic, and they would be
  the first numbers argued with. Worth a datasheet check before any of this
  reaches a quotation.

**What shipped.**

- **Cycle time, in three steps rather than one multiplier.** *(done)* The
  cooling floor `k·s²` on the measured nominal wall — derived, and labelled a
  lower bound; practical cooling at 1.3× it, because the floor assumes a mould
  wall held at a fixed temperature and one-dimensional heat flow and a tool is
  neither; and the cycle, practical cooling over cooling's 50–80% share. Both
  factors are printed with the answer and exported with it, so a reader can
  disagree with a step instead of with the number. Judged on the sphere-fit
  nominal wall — the same conservative measure the checks are judged on — so a
  cycle time cannot come out shorter than the wall the part was passed on.
- **Piece-part cost, and silence without rates.** *(done)* Material at the
  resin price entered plus machine time at the rate entered, shared across the
  cavities. **No default prices**, which was the important decision: a
  plausible-looking default is indistinguishable on screen from a real
  quotation and travels further than it should. A missing rate produces no
  cost and a sentence naming which rate is missing. What it produces is
  labelled material-and-machine, not a piece price — no labour, packaging,
  overhead, secondary operations or margin.
- **Tooling as drivers, not a band.** *(done, and narrower than planned.)* The
  roadmap wanted a currency band with the drivers listed. On reflection a band
  is still currency, and what a tool costs depends on the toolmaker, the steel,
  the country and the lead time — none of which is in this repository. So it
  ships as the drivers alone: side actions, lifters, cavitation, abrasive
  material, finish, envelope, each with what it does to the tool. The
  moving-tooling counts read the same fields and the same 1 mm² threshold the
  undercut check uses, so the two can never disagree about one part, and they
  inherit its flat-parting-line caveat, which is printed with them.
- **In both exports, and not in the score.** *(done)* The JSON and the PDF
  carry the figures with every assumption attached. Nothing here is scored:
  cycle time and cost are not pass-or-fail properties of a part, so they carry
  no weight, appear as no check and cannot move the number. A test asserts a
  part scores the same whether or not anyone has entered a resin price.

**The judgement the derivation left open, made.** `docs/coolk.md` settled the
convention but not whether a printed figure should be the floor or a practical
time. Both are printed, labelled, and the factor between them is shown — which
is the answer that does not require anyone to trust a single number.

**Exit criteria, met.** `coolK` settled and written down next to the field. No
unqualified cycle time appears anywhere — the floor is labelled a floor, the
cycle is labelled an estimate, and both factors between them are on screen. Cost
figures state every assumption on the same page they appear on, in the panel, in
the PDF and in the JSON.

**Risk.** This is the milestone most likely to be quoted from and least likely to
be checked. It is also the one where being wrong is most expensive, which is why
it sits behind an explicit decision rather than an estimate.

### R2.5 — Two-shot and FPC earn their weights *(two of three done)*

**Why it was needed.** Both paths matter to OnlyCat's own parts — the material
table carries a natural ASA entry with IR transmission notes and adhesion data
for a reason — and both had rules that could not do their job.

**What shipped.**

- **Registration for two-shot.** `src/analysis/register.js`. A rigid transform
  is searched for from four kinds of starting pose, refined by ICP, and applied
  only when it demonstrably mates the two shots; the offset, the rotation and
  the residual left at the mating surface are all reported, and every interface
  figure is labelled with the frame it was measured in.

- **A located FPC insert.** `src/analysis/fpc.js`. Marking the flex in the body
  selector turns two advisories into measurements: the polymer over the insert,
  and the distance from the gate to it. Where nothing is marked the part-wide
  comparison still runs and now says that it over-reports.

**What did not at the time, and how it was settled since.** `ts_thermal` stayed
dark because the check needs a Vicat softening point per material, and every
datasheet host — CAMPUS, UL Prospector, MatWeb, the resin makers' own sites —
is refused by this environment's network policy. The reasoning was that
entering sixteen numbers from search-engine summaries of datasheets nobody
opened would recreate what the previous work removed: a threshold resting on a
property nobody had read.

That framing turned out to contain a false premise, and the owner named it:
the check does not need graded materials. This is an in-house DFM screen whose
job is to save an external DFM loop, not a contractual gate — and a row called
"ABS" could never have had a single grade's datasheet behind it anyway, because
it covers hundreds of grades whose VST spreads over tens of degrees. Every
other column in that table (shrinkage, wall range, draft, `ltMax`, `coolK`) is
class-typical reference data on exactly the same footing. So the standard was
never "a datasheet per row"; it was consistency with the rest of the table,
which is achievable without network access.

**Delivered.** Sixteen class-typical VST/B/50 values at the conservative end of
each class's range, and the check scoring again — but not the check that lost
the points. The old rule's defect was not HDT alone, it was the 120 °C margin
bolted onto it, so the replacement has no tunable number anywhere: every band
boundary compares two tabulated properties, melt against the substrate's
softening point and melt against the substrate's own melt. It forks on whether
the pair fusion-welds, because remelting the skin is the bond on one side of
that fork and pure cost on the other — collapsing those two is what condemned
the ASA-natural window this material table exists for.

**Found while doing the work.**

- *The obvious band was almost always true.* "Interface bond, and the skin
  softens" looks like the finding, and it fires on very nearly every overmould
  ever moulded — most substrates soften below 140 °C and every melt in the
  table is above 200 °C. Deducting on it would have been the old rule's defect
  in a milder form: a standing penalty on ordinary practice, the classic
  ABS-with-a-TPU-grip included. It is reported and costs nothing, and only the
  two rare conditions score.

- *Restoring the old weight was wrong, and the reason generalises.* The 25
  points looked like a clean reversal of a documented redistribution. But a
  check that is silent by design still contributes its weight to the
  denominator, because normalisation counts the budget that ran rather than the
  budget that fired — so 25 credited every pair a quarter of the interface
  score for free and diluted the findings that did fire by the same quarter.
  ABS + PP, which will not bond at all, went from NOT COMPATIBLE to MAJOR
  REWORK. Weight has to follow how often a check can speak, not what it used
  to hold.

- *One arm of the fork cannot fire, structurally.* A fusion pair whose melt is
  too cool to reach the substrate's softening point is unreachable from this
  table: `fusion` means the same polymer both sides, so shot 2's melt is shot
  1's melt and is necessarily above its softening point. Kept, because the flag
  is also set on cross-polymer pairs that weld through a shared phase, and
  tested with a synthetic pair rather than left as the one untested branch.

- *The `hdtC` column is not what it says it is.* Noticed while working
  alongside it: the published figures it was built from are inconsistent about
  load, and two entries look like HDT/A at 1.8 MPa rather than the 0.45 MPa the
  field documents. Nothing scores on it, which is why it has not been chased —
  but it is now labelled indicative rather than left to be trusted.

**Not fixed, and named in the changelog.** Making room for the new weight trimmed
`ts_adhesion` from 34 to 31, so two unbondable pairs cross out of NOT
COMPATIBLE into MAJOR REWORK (PP + POM at 51, PA6 + PP at 55). Both still carry
the critical adhesion finding. The cause is that a single critical finding's
interface grade is decided by arithmetic — `gradeFloorIndex` floors one
critical at MINOR REWORK — and the fix is an interface-specific floor, which is
a change to grading rather than to this check.

**Found while doing the work.**

- *Principal axes are not a coarse alignment stage.* They align two instances of
  the same shape, and a substrate and its overmould are different shapes —
  their inertia frames have no reason to coincide even when the pair is
  perfectly placed. An axis alignment is one candidate pose among four, and the
  residual picks between them.

- *Coverage cannot referee alignment.* This was the obvious criterion and it is
  wrong. On the box fixture the misaligned pair scored **higher** coverage than
  the mated one — 42% against 37% — while reporting overmould thickness from
  0.05 mm to 9 mm where the truth is 2 mm everywhere. Coverage counts faces with
  the substrate somewhere beneath them, which a shell shoved sideways still has.
  The decision is the residual at the mating surface instead.

- *Trimming to the closest fraction of correspondences does not isolate the
  mating surface.* The right fraction is the mating area, which is unknown; on
  the box fixture a 60% trim leaves a perfectly mated pair reading a 1 mm
  residual purely from the outer-surface points it had to include. What
  separates the two surfaces without a magic number is direction.

- *Geometry cannot say why two shots are apart.* A part exported in its own
  frame and an overmould that genuinely misses its substrate produce the
  identical gap, and the same transform explains both. The finding names both
  readings and carries no weight — a file error is worth nothing and a design
  error is fatal, so any deduction would average nothing with everything.

- *Cover is the material along the ray, not the nearest surface.* An assembly
  that models a clearance pocket around the insert puts a surface a few
  hundredths in front of the insert's own, so a first-hit measurement reports
  the clearance as the cover.

- *A crossing count can hide its own truncation.* Duplicate hits — a ray down a
  facet edge or diagonal is reported by every incident triangle — are merged
  after collection, so four raw hits come back as two, which looks exactly like
  a ray that crossed twice. Truncation is now its own answer rather than a
  number to be second-guessed.

**Exit criteria.** Two deliberately mis-aligned exports of the same pair
register and report a residual rather than a coverage finding — met, with the
transform recovered to within 0.01 mm of the inverse of the one applied. The
FPC coverage rule scores on a measured cover — met, end to end in a browser
against a STEP fixture whose answer is 1.90 mm by construction. `ts_thermal`
carries a weight and sixteen `vicatC` values — met, on the terms above: the
values are class-typical rather than per-grade, which is the standard every
other column in that table already meets and the one an in-house screen needs.
The weight is 10 rather than the 25 it held, because the replacement check is
silent on ordinary practice and a silent check still fills the denominator.

### R2.6 — Findings that survive leaving the tool *(done)*

**Why it was needed.** The tool's output is not the end of the process — it
goes to a factory, comes back as a DFM report, and gets argued about. None of
it could survive that trip.

**What shipped.**

- **Build identity**, from the sources rather than from the commit. `tool_version`
  and a fingerprint in the JSON export, the PDF footer, the header on screen
  and the banner in the file. `--stamp v2.0.1` adds a release name for a
  tagged build.
- **Finding references.** A check is quoted by its key, upper-cased, printed
  on the card and in the PDF. Located features — undercut regions, wall
  transitions — carry a reference derived from where they are, on a 2 mm grid.
- **The rules-version caveat in `compare.js`**, in three states: a version
  change, a source change at the same version, and a record from before builds
  were named.
- **The findings package.** `src/export/zip.js` and `src/export/package.js`:
  the report, the record and the measured file in one archive, with a manifest
  naming the build and a CRC32 per member. Read back by `unzip` in the tests,
  not by its own reader.

**Found while doing the work.**

- *The source commit cannot go in the artifact.* `dfm-tool.html` is committed
  and `verify:build` fails if a rebuild differs from it, so a build stamping
  `git rev-parse HEAD` would write the *parent* commit's hash into the file
  being committed — no commit contains its own hash — and the check would fail
  on every commit for ever. A hash of the sources is reproducible, and answers
  the question a commit SHA was standing in for more directly: two commits that
  touch only the README share a fingerprint, and should.

- *A stable id for a whole-part check would be a second identifier for
  something already identified.* A run emits at most one finding per key. What
  was missing was printing the key, not deriving something from it. The work
  was entirely in the *located* findings, which had no identity at all.

- *Assembling the manifest needs the archive built twice.* The manifest quotes
  each member's size and checksum, and cannot quote its own — so the members
  are zipped once to measure them, and again with the manifest in front. Cheap,
  and the alternative is a manifest that describes something else.

- *A hostile filename is dropped, not escaped.* A member called
  `../../etc/passwd` mangles to a safe but absurd `_.._etc_passwd`; the file's
  name is `passwd`, and that is what belongs in the archive.

- *The unit suite is 17 seconds, and the two and a half minutes I measured was
  a bug.* Eight of the package tests were `async` under a synchronous `it`, so
  they reported themselves as passes before running and their work carried on
  after the summary was printed — which held the process open long enough for
  CI to shoot the runner, and which I first mistook for the suite being slow.
  The harness now awaits, `test/contract.mjs` checks statically that every call
  site does too, and one of those tests turned out to allocate four gigabytes
  in the course of refusing four gigabytes. Duplicated fixture analyses are
  memoised as well, which is worth having but was not the problem.

**Exit criteria.** Two runs of the same part produce the same finding ids —
met, and asserted across a run that adds a feature, which is what used to
renumber them. A JSON export names the build that produced it — met, from one
place, with the PDF and the on-screen header reading the same value. Comparing
across a rules change says so — met, in three states.

### R2.7 — Navigation for people who navigate for a living *(done, untested on hardware)*

**Why it was needed.** The people this tool is for spend their day in Inventor
with a SpaceMouse under their left hand, and then arrive here and orbit a part
with a mouse drag.

**What shipped.**

- **A camera that can express six degrees of freedom.** `src/app/camera-state.js`
  — an orientation quaternion, a target and a distance, with no reference to
  three.js and none to the DOM. Every input path is rewritten onto it, and the
  eye positions match the old theta/phi formula to one part in 10¹³.
- **Rate control with a dead zone.** `src/app/navigator.js`. A sample is
  integrated over the frame it arrived in, quadratically shaped, rescaled from
  the edge of the dead zone, and capped so a backgrounded tab cannot fling the
  camera on its first frame back.
- **The device, read from its own report descriptor.** `src/app/spacemouse.js`.
  WebHID, with the axis layout taken from the descriptor rather than a table of
  byte offsets per model.
- **A source a test can drive.** `read()` returning a sample or null is the
  whole interface, so everything above the transport is exercised in CI with a
  synthetic source and a synthetic clock — the same trick as the bridge fixture
  in R2.3.
- **Coverage for the camera, which had none.** The pose arithmetic is
  unit-tested against the arithmetic it replaced; the browser test drives a
  drag, a wheel, the named views and `F`, and compares rendered frames.

**Found while doing the work.**

- *WebHID is available on `file://`.* This was the open question the roadmap
  said to settle before choosing a transport, and the expectation was that it
  would not be — which would have forced the 3Dconnexion local-service route.
  Chromium treats a file URL as a potentially trustworthy origin, so
  `isSecureContext` is true and `navigator.hid` is present. Measured in the
  browser test rather than remembered, because a Chrome release could change
  it.

- *A quaternion camera rolls unless it is told not to.* Yaw about a world axis
  pre-multiplies and pitch about the camera's own axis post-multiplies; doing
  both on one side gives a camera that slowly tilts as you circle a part, and
  after a hundred drags it is visibly crooked. The theta/phi pair gave that
  property away for free, which is the one thing it was better at.

- *The navigator loop threw away its first sample.* The first frame has no
  elapsed time, so it integrated a sample over zero seconds and discarded it.
  Harmless for a device reporting its current deflection and wrong for anything
  that queues, and either way it made the loop's behaviour depend on which it
  was. The first frame now only starts the clock.

- *Three of my own tests were wrong before the code was.* A pole test with the
  pitch sign inverted, a pan test with the eye equation backwards, and a rate
  test asking for a whole second in one step — which is exactly what `maxStep`
  exists to refuse. Each looked right and asserted something else.

**What is not verified.** No 3Dconnexion device was attached to any of this.
Everything from the report descriptor onwards is tested against synthetic
descriptors; what is untested is whether a real puck's descriptor matches the
shape WebHID documents, and whether the rates feel right in the hand. Both need
a device and half an hour. The tuning constants are all exported and
commented for that session.

**Narrowed by a cross-check, without hardware.** The assumptions above were
checked against implementations that have run on real pucks —
pyspacenavigator's per-model byte layouts for eight devices, and spacenavd —
read as protocol documentation rather than copied. It confirmed two things and
found two. Confirmed: the two-vendor device filter covers every known device,
and the merge-latest-per-axis design handles both report layouts in the wild.
Found: the axis-range fallback was wrong in both directions, and it was
reachable rather than theoretical — a descriptor declaring no bounds
normalised a full ±350 swing to 0.011, inside the navigator's 0.08 dead zone,
so the puck connected, reported, and never moved the camera; bounds declared
as 0/0 collapsed the divisor to 1, so one count saturated the axis. Both are
fixed and locked by tests, and the single-report six-axis layout — the layout
of every current device, and the one the fixtures did not cover — is now a
fixture too.

So the hardware session is smaller than it was: not "does any of this work"
but two specific questions. Whether the axis directions need flipping, where
the reference predicts four of six (Y, Z, pitch, roll) and the correction
belongs in `navigator.js` rather than in the reader; and whether a real
descriptor declares a range far wider than it swings, whose symptom is a puck
that feels dead and whose answer is a per-device override rather than
second-guessing every descriptor.

**Exit criteria.** The camera refactor lands and passes the existing browser
test with no device present — met, and the browser test now covers the camera
itself. Synthetic axis samples produce the expected camera pose in a test —
met, including through the loop. A part can be inspected without touching the
mouse — **unverified**, for want of hardware.

### Release discipline

**Done, last rather than first.** It was estimated at two or three days and it
was cheap, but "cheap" turned out to be the wrong word: five of its seven items
turned up a defect, two of those were defects in checks that were reporting
green, and three of its stated premises did not survive contact — `-diff` on
the built file would have hidden the diff that diagnosed the build, the PDF was
never affected by the webfonts, and CI cannot fail on a benchmark at all. Each
item below records what shipped and what it found.

- **A deterministic build, and the two suites its failure was hiding.**
  *(done — #6)* `verify:build` had been red on `main` since 2026-08-25, and not
  because anything was stale: the committed `dfm-tool.html` was built on Windows
  and CI rebuilds on Linux, so 33 lines differed by nothing but a path separator
  — `path.relative` returns the host OS's separator and it went straight into
  the section banner — while the embedded worker string differed by escaped
  `\r\n` from a CRLF checkout. Forward slashes always, and CRLF normalised on
  read, makes the output independent of the platform and of how the source was
  checked out.

  The reason this belongs in a roadmap rather than only in a commit is what was
  behind it. Because that check fails third in the job, the browser suite and
  the offline suite had not run in CI for two weeks, and both had rotted: two
  smoke checks asserted `isVisible()` on panels the dashboard rework had moved
  into a tab that carries `hidden`, and three more could not pass anywhere an
  Inventor is not running, because the refused bridge probe is logged as a
  console error the page cannot suppress. None of that was visible while the
  step in front of it was permanently red. A guard rail everyone has learned to
  ignore is worse than not having one — and the cost is not the guard rail
  itself, it is everything downstream of it that quietly stops being checked.
- **Tag and release.** *(done — the mechanism; the first tag is a decision, not
  a commit)* `.github/workflows/release.yml` fires on a `v*` tag, re-runs the
  whole suite, and attaches both builds stamped with the tag — the CDN-loading
  one and the `--vendor` one, because which a recipient wants depends on the
  machine they open it on.

  Three gates run first, in `release.js`, and they run *before* the browser
  download rather than after it: the tag must name a version, `package.json`
  must say that same version, and `CHANGELOG.md` must have a non-empty section
  for it. Each of the three fails silently in its own way if unchecked — a tag
  ahead of `package.json` ships a file whose banner reads the old number, one
  behind it ships a file claiming to be newer than it is, and a missing
  changelog section ships a release whose notes are empty. `npm run
  release:check v2.1.0` runs the same gates locally, which is the point: a tag
  is permanent and correcting one means deleting it from the remote.

  It also refuses to publish from a commit that is not an ancestor of `main`.
  A release cut from an unmerged branch leaves no trace once the tag exists.

  **The version is chosen and the release is prepared; the tag is not pushed.**
  The number was the one part of this that a build step could not decide — it
  is a promise about what the tool is — and it is now `2.1.0`, with the reason
  for leaving `2.0.0` behind recorded in the changelog entry rather than only
  in a commit. `package.json`, `CHANGELOG.md` and the committed
  `dfm-tool.html` all agree, and `node release.js v2.1.0` passes. What remains
  is `git tag v2.1.0 && git push origin v2.1.0`, from a commit that is an
  ancestor of `main` — which is the workflow's own check, and the reason the
  tag is the owner's to push rather than a branch's to carry.
- **A CHANGELOG.** *(done)* `CHANGELOG.md`, with the history reconstructed from
  the 48 commits behind it. The structure follows from what the file is for: a
  **Scores and thresholds** table first, with the measured effect of every
  change that can move a number for a reason other than the part — sink
  under-reported 10× on large meshes, a check that meant to cost 25 costing 15,
  `ts_thermal` going 25 → 0 and PP + TPU stopping being condemned at 49, a
  1200 mm² pair of slides becoming two lifters. Then the ordinary groups.

  This is the file `compare.js` already points at. It tells anyone comparing
  two runs from different builds to "check the release notes before reading a
  score change as progress", and until now there were none. Worth noting what
  the reconstruction turned up: two of the biggest score movements in the
  tool's history — the weight/severity separation and the thermal check
  standing down — happened under the same version number, which is precisely
  the situation the fingerprint in the export exists to catch and the
  changelog exists to explain.
- **A linter and a formatter.** *(the linter, done. The formatter, measured and
  refused.)* Biome, one devDependency and a platform binary, `biome.jsonc`,
  running first in CI and first in `npm test` because it finishes before you
  have finished reading its name.

  **`--error-on-warnings` is the whole thing.** `biome lint` exits 0 while
  reporting warnings, and almost every rule worth having here — unused
  variables, unused imports, the `isNaN` coercions — reports as a warning. A CI
  step without that flag is green while finding things, which is the same shape
  as the failure two items above: a check that is green for reasons unrelated
  to what it guards. `test/contract.mjs` now fails if the flag goes missing.

  What it found on its first run, none of which was known:

  - **`row-gap: 4px` followed by `gap: 14px`** on the viewer's nav hint. The
    shorthand resets the longhand, so the tight gap between wrapped rows —
    the only reason the `row-gap` was written — had never applied. A visual
    defect, found by a linter, in a file nobody would have re-read.
  - **`const WORKER_SOURCE = /*@WORKER_SRC@*\/;`** — not valid JavaScript until
    the build substitutes it, which made `src/app/analysis-runner.js` the one
    file in the repository no tool could parse. The other three build slots
    already use a token-beside-a-literal precisely so the source stays valid;
    this one did not. Now it does, and the unbuilt fallback is an empty worker
    source rather than a syntax error.
  - **19 uses of the global `isNaN`/`isFinite`**, which coerce. Every one is
    now `Number.isFinite`, which is not the mechanical conversion: `isNaN(x)`
    became `!Number.isFinite(x)` rather than `!Number.isNaN(x)`, because these
    are all "is this a real measurement" tests over arrays where NaN is the
    not-measured sentinel — and `Number.isNaN(undefined)` is `false` where
    `isNaN(undefined)` was `true`, so the mechanical conversion would have
    turned an out-of-range read from *skipped* into *used*. The auto-fix would
    have made it worse quietly.
  - **A `window.Worker` stub written as an arrow function**, which cannot be
    constructed. The fallback test means to simulate `file://` refusing a
    blob-backed worker, which is a constructor throwing; an arrow fails one
    step earlier, in a way no browser does. Now a class.
  - Four unused imports and one unused destructure, three `let`s that never
    move, and two `forEach` callbacks returning a value.

  **The formatter was measured and refused.** Over this codebase, with settings
  matched to its own style, it rewrites 57 files: **+8,052 / −2,930**. Two of
  its effects are the argument: `src/core/materials.js` goes from 22 lines to
  324, because the 16-grade table is written as aligned columns so that ABS's
  `coolK` and PC's can be compared by eye — which is how the full-wall reading
  was settled — and one property per line ends that; and `git blame` and
  `git log -S` stop reaching past the reformat, on a repository whose commit
  messages are the design record. `biome.jsonc` carries the numbers and the
  honest way in if it is ever wanted: an `overrides` block excluding the
  tables, in a commit that does nothing else.

  Four rules are off, each with its reason in the config rather than in
  someone's memory. One of them is an accessibility rule and deserves saying
  out loud: `useSemanticElements` fires four times, twice wrongly (it wants a
  `<fieldset>` for a button group that is not in a form, replacing correct ARIA
  with a form control) and **twice rightly** — both drop zones are
  `<div role="button" tabindex="0">` and should be `<button>`. That is a UI
  change with layout consequences and a keyboard path to re-test, so it is
  recorded here rather than made inside a lint pass. It is the one finding from
  this item left undone on purpose.
- **A performance budget.** *(done, and not the one this item described)*
  `test/perf.mjs`, running in CI after the unit tests.

  The item said "a benchmark script over a fixed fixture with a budget CI can
  fail on", and the first thing the work found is that CI cannot fail on a
  benchmark. Six runs of the same analysis over the same geometry in the same
  process, on an idle machine, spread **274 ms to 497 ms** — and two separate
  invocations disagreed about the *minimum* by 9%. A shared runner is worse. A
  threshold loose enough to survive that cannot see a doubling; one tight
  enough to see a doubling fails on Tuesdays. Either way it becomes a check
  people learn to ignore, and the item three above this one is the record of
  what that costs.

  So what is budgeted is the *work*, not the time: rays cast, BVH nodes
  visited, triangles tested, counted in `src/geometry/bvh.js`. Those are the
  same integers on every run and on every machine — asserted, not assumed —
  and they are directly downstream of both levers the assessment named
  (`SPHERE_SAMPLE_BUDGET` *is* a ray count; `CONE_RINGS_DEG` ×
  `CONE_AZIMUTHS` is 33 rays per sampled point). Wall clock is reported beside
  them with an 8× backstop, which is there to catch a synchronous network call
  or an accidental O(n²) and is honest about catching nothing else.

  Two fixtures: a drafted shell subdivided to 24,576 triangles (224,216 rays,
  12.3M node visits) and the internal-ledge cup at 1,536 triangles (123,424
  rays, 4.7M node visits). The cup earns its place by being small and expensive
  — ray count is driven by the sample budgets, not by the mesh — and by being
  the undercut case, where rays go in the parting plane rather than along a
  face normal.

  Two design points worth keeping. A budget is a **ceiling, not a snapshot**:
  work going down never fails, because an optimisation should not have to edit
  a test to land. And work dropping far *below* the recorded figure does fail,
  asking to be recorded — a budget nobody ratchets down lets the next change
  give the whole saving back unnoticed.

  Verified by mutation, and one of them is a better demonstration than
  anything I would have designed: dropping `LEAF_THRESH` from 8 to 3 moves
  node visits **+17%** and triangle tests **−65%**, and the budget reports
  both, because the trade a BVH leaf size makes is exactly what a single
  number would have hidden. Raising `SPHERE_SAMPLE_BUDGET` by 30% moves rays
  8.6%, which is what set the tolerance: at the 10% I first wrote, that change
  passed.
- **`.gitattributes` for the built file.** *(done, with one of its two halves
  refused)* `dfm-tool.html` — 820 kB now, not the 579 kB above — is marked
  `linguist-generated=true`, which collapses it in GitHub diffs and keeps it
  out of the repository's language statistics. Also `-merge`, since the only
  correct resolution of a conflict in generated output is to rebuild it, and a
  line-merge of two bundles produces something that parses and is wrong.

  `-diff` was **not** added, and this item asked for it. Marking the file
  binary makes `git diff` print "Binary files differ" and nothing else — and
  the line-by-line diff is exactly what diagnosed the build's platform
  dependence one item above: *33 lines differing by nothing but a path
  separator* is a finding, "the files differ" is not. The check that reads that
  diff is `verify:build`, which is the whole reason the file is committed.

  `* text=auto eol=lf` is there too, for the same episode's other half: a CRLF
  checkout put escaped `\r\n` into the embedded worker string. The build
  normalises on read now, so this is belt to that braces — nothing in the index
  currently has a CR in it, and this keeps a machine with `core.autocrlf` set
  from reopening the question.
- **The webfonts.** *(done — vendored, in every build)* Archivo and JetBrains
  Mono as woff2 data URIs, embedded by `build.js` rather than fetched.

  One correction to this item first: **the PDF was never affected.** `pdf.js`
  draws in jsPDF's built-in Helvetica, so a report handed to a supplier
  rendered identically either way. What differed was the tool on screen —
  which still matters, and for a reason the item understated: the difference
  was *invisible*. A machine with no connection got the fallback stack with
  nothing to say it had, so the typography looked like a choice rather than a
  failure.

  Vendored rather than dropped, and the numbers made that easy. Both families
  are variable fonts, so the latin subset is **one file each** covering every
  weight the stylesheet asks for — 34.9 kB and 40.4 kB, about 100 kB of the
  output once base64'd, on a file that was already 825 kB. Latin only: the
  interface is English and latin-ext, Cyrillic, Greek and Vietnamese would
  triple that for glyphs nothing here renders. The CSS keeps a real fallback
  stack, so a character outside the subset still draws.

  In **every** build, not behind `--vendor`. The flag is for the two libraries,
  which are a megabyte; a font that changes how the tool looks depending on the
  network is not a size trade-off, it is a defect in both builds.

  The obligation that came with it is discharged rather than noted. Both are
  OFL-1.1, which requires the copyright notice and the licence to accompany
  any copy of the font software — and this artifact *contains* the font
  software. So the banner carries both notices and the licence text, next to
  the MIT notice for the tool's own code; the body is byte-identical between
  the two upstream files, which `build.js` asserts, so it appears once with
  both notices above it. Neither family declares a Reserved Font Name, so a
  subset keeping the family name is within the licence.

  Three things now hold it in place. `test/offline.mjs`'s tolerance for
  `fonts.` is **gone**, and its absence is what keeps the fonts embedded. The
  smoke test's font route is a **tripwire** rather than a stub — it used to
  answer the request with an empty stylesheet, which is precisely how the
  silent fallback survived — and any request landing there fails the suite. And
  the faces are asserted to have actually loaded, read off `document.fonts`
  rather than asked with `document.fonts.check`, which was the first thing
  tried and is vacuous: `check` answers "can this be rendered without
  waiting", and with no `@font-face` at all the fallback renders immediately,
  so it returned true for a build that embedded nothing. Caught by removing
  the fonts from the build and watching the test pass.

  One thing fell out: `--vendor`'s preconnect strip is gone, because there are
  no preconnects left to strip. It was the line whose existence once let a
  length-based check pass while leaving the three.js tag in place.
- **The CDN question.** *(the tooling and the weighing, done. The hashes,
  still blocked — and now with the evidence rather than the assumption.)*

  **Measured: `cdnjs.cloudflare.com` and `cdn.jsdelivr.net` both answer 403 to
  CONNECT at this environment's proxy.** So the hashes cannot be computed here,
  and hashing the `node_modules` copies would be exactly the guess this item
  warned against — a bet that the npm tarball and the CDN's build are
  byte-identical, staked on the viewer appearing at all.

  `npm run sri` is the missing half made executable. It fetches all three,
  prints the `sha384` attribute for each and **where each one goes** — which is
  the part that was not written down anywhere: three URLs in three files, one a
  static `<script>` that also needs `crossorigin="anonymous"` (without which a
  cross-origin response is opaque and the check fails whatever the hash says),
  and two set on script elements a loader creates. It also reports whether the
  served bytes matched the `node_modules` copy, which is the piece of evidence
  nobody has had and which settles whether the shortcut was ever safe. It
  writes nothing, deliberately: nothing lands that has not been read and then
  confirmed by opening the file.

  One caveat the item did not have: the OpenCascade loader fetches a `.wasm` of
  its own afterwards, from a URL an `integrity` on the loader does not cover.
  Pinning the loader is worth doing and is not the whole job.

  Four assertions hold it together, and two of them matter more than they look.
  The attribute is base64 of the *digest bytes*, checked against FIPS 180-4's
  own SHA-384 example converted independently — base64 of the hex text is 96
  characters of plausible nonsense no browser will match and nothing but a
  test can tell apart. And the list of URLs is held against `src/` in both
  directions, because a version bumped in one of three files leaves a stale
  hash in another and the only thing that notices is a blank page.

  **The alternative, re-measured.** Making `--vendor` the committed default
  removes two of the three runtime loads and the SRI question with them. The
  cost is no longer the "1.4 MB instead of 500 kB" above: it is now
  **1,918,750 bytes against 950,663** — 1.87 MB against 928 kB, a factor of
  2.02. The comparison also changed shape while this milestone ran, in a way
  that argues *for* the vendored default: with the fonts embedded, those three
  CDN loads are the only thing the default build reaches for at all, so
  vendoring would take a file with three remote dependencies down to one
  (the STEP reader, which is 6 MB and stays lazy and remote either way).

  Not switched, because the deliverable is a file people email and 1.87 MB is
  a different kind of attachment from 928 kB — and that is a judgement about
  how the tool is handed around rather than a technical one, so it belongs to
  whoever hands it around. Both routes are now one command away: `npm run sri`
  for the hashes, or `--vendor` in the build script for the other.

---

## Sequencing, and why this order

Release discipline was meant to come first, "because it is cheap and because a
tagged build is what makes every later change traceable". It came last, and the
prediction was half right: it *was* cheap, and it would have been worth more
earlier — the changelog it produced had to reconstruct 48 commits of score
movements from their commit messages, which is work that would have been free
if the file had existed while they landed. The half that was wrong is "cheap":
five of its seven items turned up a defect, and two of those were defects in
the checks themselves.

R2.1 to R2.7 and release discipline are all done, bar two things that need
something a keyboard cannot supply — the third turned out to need a decision
rather than a datasheet:

- ~~R2.5's sixteen Vicat softening points need datasheet access.~~ *Settled: the
  premise was wrong. An in-house screen does not need graded materials, and no
  row in that table could have had one grade's datasheet behind it anyway.
  Sixteen class-typical values, on the same footing as every other column
  there, and the check scores again.*
- R2.7's device layer needs a SpaceMouse plugged in for half an hour — now
  for two named questions rather than a general shakedown, the rest having
  been settled against implementations that have run on real hardware.
- The SRI hashes need a machine that can reach cdnjs and jsdelivr, which both
  answer 403 here. `npm run sri` does the rest of that job.

The fourth was a judgement rather than a task, and it has been made: the first
tag is `v2.1.0`, prepared and gated but not pushed, because a tag has to be cut
from a commit already on `main`.

Each is recorded at its own milestone with what is missing and what to run.

The sequencing held up, and two of its predictions are worth keeping for the
next roadmap.

R2.7 was called independent — viewer code, sharing only `src/app/camera.js`
with nothing else — and it was, but the estimate was for the wrong reason. The
work was not the device; it was that the camera had no automated coverage at
all, so the refactor had to bring its own before it could be trusted. Reckon
on that wherever a milestone touches code whose correctness lives in how it
feels.

R2.5 sat last because its most valuable piece, the located FPC region, is much
cheaper once R2.2 has made faces and bodies first-class. That held — and it is
also why the piece of R2.5 still outstanding is the one that needs no code at
all. A milestone gated on data rather than on engineering should be sequenced
by when the data can be got, not by what depends on it, which is the lesson
R2.4's `coolK` question was supposed to have taught: raise it at the *start*.

## Decisions that need a human

1. ~~**`coolK`: half-wall or full wall?**~~ *Answered: the full wall. Derived,
   not asked — `docs/coolk.md`. What remains is a judgement rather than a fact:
   whether a printed cycle time is the theoretical floor or a practical time,
   and saying which on screen.*
2. ~~**The OpenCascade module: vendor it for tests, or not?**~~ *Settled in
   R2.1: neither. It is an npm package, so it is a pinned devDependency and
   nothing was committed to git.*
3. **`--vendor` as the committed default?** Trades 900 kB of file size for two
   fewer third-party runtime loads and the SRI question.
4. ~~**Does `corners`, once measurable, take weight from the other checks or
   widen the budget?**~~ *Settled in R2.2: neither. The scored check is a
   separate key that appears only where there are faces to fit, so an STL keeps
   the budget and the score it always had.*

## Deliberately not on this roadmap

These are decided, and the reasons are in the code and in
`docs/ASSESSMENT.md`. They are listed so they do not get re-proposed as
oversights.

- **A computed parting line.** Decided against, not deferred. Nothing in the
  geometry says where a toolmaker would split the mould, and a computed line
  would be a confident guess someone then has to argue with. The flat-line
  assumption over-reports, which is the safe direction, and it says so in the
  check's own output.
- **Real flow simulation.** L/T from a geodesic search is a screening tool and is
  honest about being one. Warpage and fill prediction are Moldflow's job.
- **Authentication on the bridge.** It binds to localhost and accepts only
  `file://` and localhost origins. The answer to exposure is not to expose it.
- **Upgrading three.js past r128.** r128 is the last release with a UMD build
  usable from a plain `<script>` tag; moving costs the single-file property for
  no gain in what the viewer does.
- **Scoring melt against HDT.** Removed on purpose, and not restored. HDT
  cannot answer the question that was being asked of it; Vicat can, and
  `ts_thermal` now scores on Vicat with no margin in it — see R2.5. The
  `hdtC` column stays for context, labelled indicative, and nothing scores on
  it. What is deliberately not coming back is the shape of the old rule: a
  property that cannot answer the question, plus a margin to make it fit.

## Keeping this document honest

Two rules, both learned from the assessment that preceded it. Anything delivered
moves out of its milestone and into a delivered section with what actually
shipped, including what turned out to be wrong — the "Found while doing the work"
sections in `docs/ASSESSMENT.md` are the most useful part of that document.
And no milestone is called done on the strength of the code existing: each has
exit criteria above, and every one of them is a test.
