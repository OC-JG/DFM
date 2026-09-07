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

Version numbers are targets for the `version` field in `package.json`, which is
at `2.0.0` and has never been tagged. Effort is calendar days of focused work,
in the same units the delivered phases in `docs/ASSESSMENT.md` were estimated
in — those ran roughly to estimate, which is the only reason to trust these.

| | Milestone | Effort | Blocks / blocked by |
|---|---|---|---|
| R2.1 | Trust the STEP path | ~~3–5 d~~ done | Unblocked R2.2, R2.3 |
| R2.2 | Features, not triangles | ~~1–2 wk~~ done | unblocked nothing further |
| R2.3 | The Inventor loop under test | 4–6 d | Needs R2.1 |
| R2.4 | Numbers that get quoted | 1 wk + a decision | Needs a moulding engineer |
| R2.5 | Two-shot and FPC earn their weights | 1–2 wk | Needs R2.2 for the FPC region |
| R2.6 | Findings that survive leaving the tool | 4–6 d | Independent |
| R2.7 | Navigation for people who navigate for a living | 1–2 wk | Independent |
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

### R2.3 — The Inventor loop under test

**Why now.** It is the differentiator (gap 3), it is unverified, and it has an
external dependency that will change underneath it.

**What ships.**

- A fake InventorMCP server in `test/`: a small Node HTTP server speaking the
  same routes `src/app/bridge.js` calls, returning a recorded STEP payload and a
  parameter table. This is a fixture, not a mock of the network layer — it lets
  the smoke test drive connect, export, parameter edit, rebuild and the History
  entry as one flow.
- Coverage of the three chip states the README promises — connected to Inventor,
  connected to the simulator, nothing listening — plus the failure modes that
  are not currently handled anywhere visible: a request that never returns, an
  Inventor sitting on a modal dialog, a parameter edit rejected by the rebuild,
  and a rebuild that succeeds but returns geometry at a different scale.
- A recorded contract for the bridge protocol, so an InventorMCP release that
  renames a route fails a test here rather than in front of a user. The bridge
  talks to a separate repository on a separate release cycle; nothing currently
  detects a drift between them.
- Findings linked back to the feature that caused them. The feature tree already
  arrives and is rendered (`src/app/panels-input.js:501-509`) but is
  display-only. Once R2.2 gives findings a face, and the bridge gives faces a
  feature, a finding can name the Inventor feature and the driving parameter
  responsible — which is the difference between "fix this dimension" and "here
  is a heatmap".

**Exit criteria.** `npm test` covers the bridge with no Inventor installed. Each
failure mode above produces a specific message rather than a generic one. The
protocol contract fails on a renamed route.

**Risk.** A fixture server can drift from the real InventorMCP and give false
confidence. Mitigate by recording the fixture payloads from a real session and
dating them in the file.

### R2.4 — Numbers that get quoted

**Why now.** Because cycle time and cost are what someone asks for first, and
because the tool is deliberately silent on both — correctly, until one question
is answered.

**The decision that gates it.** `coolK` in `src/core/materials.js` is documented
as `tc = k × s²` with `s = half-wall` (materials.js:7). If that convention is
wrong — if the tabulated values were written for full wall — every cycle time
the tool could print is out by a factor of four. This has been the single open
question since Phase 3 and it needs a moulding engineer, or a re-derivation from
a source that states its convention explicitly, or calibration against a part
with a known measured cycle. Two of those three are available without waiting
for anybody.

**What ships, once that is settled.**

- Cycle time, with the convention it assumes printed beside it, in the same
  style as the cavity-pressure assumption already printed next to clamp force
  (`src/analysis/shot.js`).
- Piece-part cost: material mass at a price per kg, machine rate against the
  machine size `nextMachineSize` already selects, cycle time and a cavity count.
  Every input user-editable and every input shown, because a cost figure whose
  assumptions are hidden is worse than no cost figure.
- A tooling-cost band — not a number. Tooling depends on the undercut and slide
  count the tool already computes, cavity count and finish, and a point estimate
  would be false precision. A band, with the drivers listed, is defensible.
- Cost in the JSON export and the PDF, clearly separated from the score. These
  are not manufacturability verdicts and must not move the number.

**Exit criteria.** No unqualified cycle time appears anywhere until `coolK` is
settled and the resolution is written down in `src/core/materials.js` next to
the field. Cost figures state every assumption on the same page they appear on.

**Risk.** This is the milestone most likely to be quoted from and least likely to
be checked. It is also the one where being wrong is most expensive, which is why
it sits behind an explicit decision rather than an estimate.

### R2.5 — Two-shot and FPC earn their weights

**Why now.** Both paths matter to OnlyCat's own parts — the material table
carries a natural ASA entry with IR transmission notes and adhesion data for a
reason — and both have rules that currently cannot do their job.

**What ships.**

- **Mesh registration for two-shot.** The interface pass assumes both shots were
  exported in a shared coordinate system, with no registration step (README,
  "Known constraints"). When they were not, `ts_coverage` fires — and its own
  weight comment concedes it is "usually a mesh alignment problem"
  (`src/rules/scoring.js:98`). A coarse alignment (principal axes, then an ICP
  refinement on the overlapping region) plus a reported registration residual
  turns a false finding into either a real one or a stated non-problem.
- **A located FPC region.** `src/rules/engine.js:75` and `:737` both note the FPC
  region cannot be located on the mesh, which leaves the coverage and
  gate-proximity rules advisory inside a check carrying `weight: 12`. Given
  R2.2, the most economical answer is a designated body or face selection — a
  multi-body STEP already carries `bodies` (`step.js:120`), and the UI already
  lists them with visibility toggles (`src/app/main.js:291-298`) — rather than
  painting a region on the mesh.
- **Vicat data, and `ts_thermal` switched on.** The check sits at `weight: 0`
  with an explicit instruction not to restore a melt-versus-HDT threshold
  without adding Vicat first (`src/core/materials.js:10-16`,
  `src/rules/scoring.js:109`). Adding a `vicatC` column for the sixteen grades
  in the table is data entry against datasheets, not modelling, and it closes a
  check the previous work deliberately left dark.

**Exit criteria.** Two deliberately mis-aligned exports of the same pair
register, and report a residual rather than a coverage finding. The FPC coverage
rule scores. `ts_thermal` carries a weight, and the sixteen `vicatC` values each
cite the datasheet they came from.

### R2.6 — Findings that survive leaving the tool

**Why now.** The tool's output is not the end of the process — it goes to a
factory, comes back as a DFM report, and gets argued about. Everything in gap 4
is cheap to fix and compounds with every export that already exists.

**What ships.**

- **Stable finding identifiers.** A finding gets an id derived from its check key
  and the geometry it concerns, stable across runs of the same part. That makes
  "we accept point 4, reject point 7" mean something months later, and it is
  what lets a supplier's DFM response be reconciled against the tool's own
  findings rather than re-read by hand.
- **Build identity in every artifact.** `tool_version` and the source commit in
  the JSON export, and the same in `dfm-tool.html`'s banner, which currently
  carries a licence and no version at all. `build.js` already writes that banner
  and can read `package.json` and `git rev-parse`.
- **A rules-version caveat in `compare.js`.** Once exports carry a version, add
  the caveat the comparison is currently missing: the rules changed between these
  two runs, so some of this movement is the tool, not the part. It belongs
  alongside the three caveats at `compare.js:51-59`.
- **A findings package export.** One archive: the PDF, the JSON, and the STEP
  that was measured. This is what actually gets emailed to a factory, and
  assembling it by hand is where the wrong revision gets attached.

**Exit criteria.** Two runs of the same part produce the same finding ids. A JSON
export names the build that produced it. Comparing across a rules change says so.

### R2.7 — Navigation for people who navigate for a living

**Why now.** The people this tool is for spend their day in Inventor with a
SpaceMouse under their left hand, and then arrive here and have to orbit a part
with a mouse drag. It is the one part of the tool that feels less capable than
the CAD package it sits beside, and the fix is bounded.

**What ships.**

- **6-DoF input from a 3Dconnexion device.** Two routes, and the choice should
  be made by testing rather than argument. WebHID (`navigator.hid`) reads the
  device directly, needs a user gesture to grant access, and is Chromium-only —
  and whether it is available at all from a `file://` origin, which is how this
  tool is opened, is the first thing to establish, not assume. The alternative
  is 3Dconnexion's own local service, which their web samples talk to over a
  localhost socket. That second route is the same shape as the Inventor bridge
  this repo already has (`src/app/bridge.js`) — a local service, a localhost
  origin, an availability chip in the header — and a SpaceMouse user is very
  likely to be the same person already running InventorMCP on that machine.
- **A camera that can express what the device sends.** This is the actual work,
  and it is worth being clear that it is not a shim. `src/app/camera.js` holds
  orientation as `theta`, `phi` and `radius` around a target — 2 DoF of
  rotation with world-up implied, which is why there is no roll. A puck sends
  three translation and three rotation rates at once. Taking them properly means
  the camera state becoming a quaternion plus a target plus a distance, with the
  existing mouse, touch and keyboard paths rewritten onto it. Doing that first,
  and shipping it with no device attached, de-risks the rest: if the orbit still
  feels right afterwards, the hard part is done.
- **Rate control, not position control, with a dead zone.** A SpaceMouse
  displaces a few millimetres and springs back; the axis value is a velocity, so
  it integrates per animation frame with a dead zone around centre and a
  configurable sensitivity per axis. Getting this wrong is what makes 6-DoF
  navigation feel seasick, and it is tuning, not architecture.
- **The device's buttons on the actions that already exist.** Fit, top, front,
  right and iso are already implemented behind `setView` and the `F`/`R` keys
  (`src/app/camera.js:1-16`); the buttons should reach the same functions rather
  than grow their own.
- **An input source the tests can drive.** Nothing about a physical puck is
  testable in CI, so the device layer should sit behind a small interface that
  the smoke test can feed synthetic axis samples through — the same trick as the
  bridge fixture in R2.3. That is what stops this becoming a permanently
  unverified corner of the viewer.
- **A reduced-motion answer.** The tool respects `prefers-reduced-motion`
  elsewhere. Continuous 6-DoF drift is exactly the kind of motion that setting
  is about, so decide deliberately: damp it, or leave the device to override it
  on the grounds that the user is driving every frame themselves.

**Exit criteria.** The camera refactor lands and passes the existing smoke test
with no device present. Synthetic axis samples produce the expected camera pose
in a test. With a real device, a part can be inspected without touching the
mouse, and a user with no device notices no change at all.

**Risk.** Chromium-only, whichever route is chosen, so this is an enhancement
that must degrade to silence — no error, no chip, nothing — on a browser or
machine without the device. And the camera refactor touches the most
hand-tuned code in the repo; the mouse and touch feel is the regression to watch
for, and it has no automated coverage today.

### Release discipline

**Do this first — it is two or three days and everything else benefits.**

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
- **Tag and release.** `package.json` says `2.0.0`; there are no tags and no
  releases. CI already uploads `dfm-tool.html` as an artifact on every run
  (`.github/workflows/ci.yml`); attaching it to a tagged release instead gives
  the file a citable home. The deliverable is designed to be handed to people,
  and right now nobody holding it can say which one they have.
- **A CHANGELOG.** For a tool whose output is a scored report, a threshold change
  is a user-visible change, and there is currently no record of when a score
  moved for reasons other than the part.
- **A linter and a formatter.** Neither is configured. The codebase has a clear,
  consistent house style and no mechanical enforcement of it, which makes review
  of an outside patch a style conversation. Whatever the choice, it should run in
  CI next to the contract test.
- **A performance budget.** `docs/ASSESSMENT.md` records a run going from 1,469 ms
  to 2,531 ms and names the two levers that control it, but nothing measures it,
  so the next regression will be found by feel. A benchmark script over a fixed
  fixture with a budget CI can fail on is a day's work.
- **`.gitattributes` for the built file.** 579 kB of generated HTML is committed
  and must stay committed. Marking it `linguist-generated` and `-diff` keeps it
  out of diffs and reviews without changing what ships.
- **The webfonts.** `test/offline.mjs:106` explicitly tolerates blocked requests
  to `fonts.` — so the `--vendor` build, whose whole purpose is needing no
  network, still reaches for Google Fonts and silently falls back to system
  faces. A report handed to a supplier renders in a different typeface depending
  on their connection. Either vendor the two families or drop them for a system
  stack; either is better than a difference nobody notices until it is in a PDF.
- **The CDN question.** SRI hashes were considered and deliberately not added
  blind — a wrong `integrity` attribute kills the page and the hashes must come
  from the bytes the CDN actually serves. Whoever has network access should
  compute them and confirm the tool still boots. Worth weighing against the
  alternative: making `--vendor` the committed default removes two of the three
  runtime loads and the SRI question with them, at 1.4 MB instead of 500 kB. The
  STEP reader stays lazy and remote either way, so the exposure narrows rather
  than closing.

---

## Sequencing, and why this order

Release discipline first, because it is cheap and because a tagged build is what
makes every later change traceable.

R2.1 and R2.2 are done. R2.3 is the last of the three that R2.1 unblocked, and
nothing now blocks anything: R2.3, R2.4 (behind its one question), R2.5, R2.6
and R2.7 are independent of each other and can be taken in any order.

R2.7 depends on nothing and competes with nothing — it is viewer code, and the
only file it shares with any other milestone is `src/app/camera.js`, which none
of them touch. Slot it wherever there is appetite for it.

R2.4's engineering is a week; its blocking decision could take five minutes or a
fortnight, so raise the `coolK` question at the *start* of R2.1, not when R2.4
comes up. R2.5 sits last because its most valuable piece, the located FPC region,
is much cheaper once R2.2 has made faces and bodies first-class.

## Decisions that need a human

1. **`coolK`: half-wall or full wall?** Factor-of-four consequence. Gates cycle
   time and everything costed from it.
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
- **Scoring melt against HDT.** Removed on purpose. HDT cannot answer the
  question that was being asked of it. Vicat can, and that is R2.5.

## Keeping this document honest

Two rules, both learned from the assessment that preceded it. Anything delivered
moves out of its milestone and into a delivered section with what actually
shipped, including what turned out to be wrong — the "Found while doing the work"
sections in `docs/ASSESSMENT.md` are the most useful part of that document.
And no milestone is called done on the strength of the code existing: each has
exit criteria above, and every one of them is a test.
