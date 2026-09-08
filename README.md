# OnlyCat DFM — Injection Moulding Analyser

A browser tool that loads an Inventor `.ipt`, STEP or STL part, measures it, and scores how
manufacturable it is by injection moulding: wall thickness and uniformity,
draft, ribs and bosses, undercuts and the tooling they imply, sink risk,
shrinkage and warpage, flow length from a chosen gate, FPC overmoulding, and
two-shot interface compatibility. Exports a PDF report and a JSON record.

`dfm-tool.html` is the whole application — one self-contained file you can
double-click. Everything under `src/` builds into it.

---

## Using it

Open `dfm-tool.html` in a browser. Drop a part, pick a material, run.

### Inventor parts

`.ipt` is a closed binary format with no browser-side reader, so the file goes
out to a local [InventorMCP](https://github.com/OC-JG/InventorMCP) server, which
opens it in Inventor and exports STEP:

```sh
inventor-mcp --backend inventor --transport streamable-http
```

The chip in the header says which of three situations you are in — connected to
Inventor, connected but running the simulator (which cannot open an `.ipt`), or
nothing listening — and the drop zone explains what to do about the last two.
The default address is `http://127.0.0.1:8000`; change it under the drop zone if
you run the server elsewhere.

Routing through STEP is not a downgrade from viewing the `.ipt` directly. STEP
carries the B-rep face groups an STL throws away, which is what lets draft be
measured per face rather than per triangle.

What the bridge adds over a converter is the return path. The document stays
open in Inventor, so the **Parameters** panel lists the part's driving
dimensions and editing one rebuilds the part and brings the new geometry
straight back — measure, change the dimension that caused the finding, measure
again, without touching a file. Each change is recorded under **History** with
the score it replaced.

Three things load from a CDN at runtime and therefore need a connection:
three.js (the 3D viewer), the OpenCascade WASM reader (STEP files only), and
jsPDF (PDF export only). Only three.js loads up front; the other two are
fetched the first time you actually need them. If a load fails the tool says
so and keeps working with what remains — STL parsing, all the analysis, and
JSON export are entirely local.

## Building

```sh
node build.js            # writes dfm-tool.html
node build.js --vendor   # ... with three.js and jsPDF built in, so it needs no network
```

No dependencies, no install step. The bundler is ~150 lines in `build.js`.

The committed `dfm-tool.html` is the CDN-loading one. `--vendor` inlines three.js
and jsPDF instead — about 1.4 MB rather than 500 kB, and nothing to fetch, which
is what you want if the file is going to a machine with no internet. `npm run
test:offline` proves that build works with every off-origin request refused, then
puts the normal one back. STEP import is not covered: the OpenCascade reader is
6 MB, it is already loaded lazily, and it stays network-dependent.

```sh
npm install            # only needed for the tests
npm run browser        # once: fetches the Chromium the smoke test drives
npm test               # build + lint + unit tests + fixtures + browser smoke test

npm run lint           # Biome, linter only — see biome.jsonc for why the formatter is off
npm run test:unit      # just the unit tests: no browser, no network, sub-second
npm run test:step      # the STEP path, which is also the .ipt path
npm run test:bridge    # the Inventor loop, against a fake InventorMCP
npm run test:offline   # proves the --vendor build runs with no network at all
npm run verify:build   # asserts the committed dfm-tool.html matches src/
```

`npm install` brings in the Playwright library but not a browser binary, which
is what `npm run browser` is for. If you already have a Chromium — a different
Playwright install, a system one — point `DFM_CHROMIUM` at it and skip that
step.

`test/unit.mjs` asserts numbers. Every fixture it uses has a known answer —
analytic where the geometry gives one (a 2 mm hollow cylinder measures 2 mm, a
3° frustum reads 3.000°), and otherwise checked against an independent
brute-force implementation in `test/lib/reference.mjs` written from the
definition rather than from the code under test. It imports the pure modules
straight into Node, which is what the one-way dependency direction below buys.

`test/bridge.mjs` covers the Inventor loop without an Inventor.
`test/lib/fake-bridge.mjs` is a real HTTP server on its own origin speaking the
real protocol, and it genuinely **rebuilds**: a parameter change regenerates the
STEP from the analytic solid with the new value. So the loop is proved by
measurement rather than by wiring — drive `wall` to 3 and the tool has to come
back reading a 3 mm wall. A server returning a canned payload would pass a test
that proved nothing. The three chip states are covered, so are the ways it goes
wrong (a modal dialog in Inventor, a rebuild the part refuses, a model whose
STEP body 404s, a request that never answers, and a rebuild that silently
returns inches), and so is the route contract — InventorMCP is a separate
repository on its own release cycle, and nothing else would notice a renamed
route until a user did.

`test/step.mjs` covers the STEP path, and therefore the `.ipt` path — an
Inventor part is routed through the same `parseSTEP` a dropped `.step` uses, so
this is the input most users take. Its fixtures are **authored rather than
exported**: `test/lib/solids.mjs` defines a solid analytically and
`test/lib/step-write.mjs` emits a real AP214 file from it, which is why a 3°
taper reads 3.000° per face by construction. A file exported by OpenCascade and
then read back by OpenCascade could agree with itself and still be wrong. It
needs the same OpenCascade reader the tool fetches at runtime, pinned to the
same version, which is why it is a separate target from `test:unit` — that one
stays runnable with nothing installed.

The smoke test drives a real Chromium through the whole pipeline — load,
analyse, heatmaps, gate picking, two-shot, both exports, persistence, reset,
and the main-thread fallback — and serves three.js and jsPDF from
`node_modules` so it never depends on the network.

## Releasing

`dfm-tool.html` is a file people are handed, and once it has left the
repository the only thing that says what it is is the banner inside it. So a
release is a tag, and the tag has to agree with everything else:

```sh
# 1. bump the version and move the changelog entries under it
npm version 2.1.0 --no-git-tag-version
$EDITOR CHANGELOG.md          # "## Unreleased" -> "## v2.1.0 — 2026-09-09"

# 2. rebuild, because the version is compiled into the artifact
node build.js && git commit -am "Release 2.1.0" && git push

# 3. check the three things a release can get wrong, before the tag exists
npm run release:check v2.1.0

# 4. tag it
git tag v2.1.0 && git push origin v2.1.0
```

Step 3 is worth the ten seconds: a tag is permanent, and correcting one means
deleting it from the remote. It checks that the tag names a version, that
`package.json` says that same version, and that `CHANGELOG.md` has a section
for it with something in it — and prints the notes it would publish. The same
gate runs first in `.github/workflows/release.yml`, before the browser suite,
so a mismatch costs a second rather than four minutes.

The tag then runs the full suite again, refuses to publish from a commit that
is not an ancestor of `main`, and attaches two builds stamped with the tag: the
CDN-loading one and the `--vendor` one. Which of those a recipient wants
depends on the machine they will open it on, so they get both.

`CHANGELOG.md` calls out separately any change that can move a score for a
reason other than the part. That is not housekeeping: `compare.js` tells anyone
comparing two runs from different builds to *"check the release notes before
reading a score change as progress"*, and that file is where it sends them.

## Layout

```
dfm-tool.html          built output — the deliverable
build.js               the bundler
src/
  index.html           markup, with slots the build fills
  styles/app.css
  core/                material, finish and adhesion data
  geometry/            STL + STEP parsing, vertex welding, validation, BVH
  analysis/            mesh measurement, flow, undercuts, transitions
  rules/               DFM rule engine, two-shot rules, FMEA scoring
  worker/              off-thread analysis entry point
  app/                 viewer, camera, panels, state, wiring
  app/bridge.js        talks to a local Inventor via InventorMCP (.ipt)
  export/              PDF and JSON
test/                  fixture generator, unit tests, browser smoke test
  lib/shapes.mjs       analytic fixtures with known answers
  lib/reference.mjs    slow, independent reference implementations
  lib/solids.mjs       the same discipline as shapes.mjs, but as B-rep faces
  lib/step-write.mjs   emits a real AP214 file from one of those solids
  lib/fake-bridge.mjs  a stand-in InventorMCP that really rebuilds
  step.mjs             the STEP path: face groups, bodies, draft per face
  bridge.mjs           the Inventor loop, its failure modes, its route contract
  contract.mjs         asserts every id src/app reaches for exists in markup
.github/workflows/     CI: unit tests, artifact-sync check, browser suite
legacy/                the original single-file v1, kept for reference
```

The dependency direction is one way: `core` and `geometry` know nothing about
anything else, `analysis` builds on `geometry`, `rules` consumes analysis
output, and only `app` touches the DOM. That is what lets the analysis run in
a worker at all.

---

## What changed in the rebuild

Functionally this is the same tool. The material data, every threshold, and
the wording of every finding were carried across deliberately — that content
is the part with real engineering behind it. What changed is everything
around it.

### Bugs fixed

**Shot 2 STL files could never load.** `loadFile2` called `isBinarySTL`,
`parseSTLBinary` and `parseSTLAscii`. None of those functions existed
anywhere in the file — the real ones were named `parseSTL`, `parseBinarySTL`
and `parseAsciiSTL`. Any STL dropped as an overmould failed with
`isBinarySTL is not defined`. Two-shot analysis only ever worked with STEP
files. Both shots now go through one parser.

**Sink coverage was under-reported on any mesh over 20k triangles.**
Per-triangle thickness was sampled with a stride (`triCount / 20000`), but the
resulting areas were divided by the *total* surface area. On a 200k-triangle
part the stride is 10, so every sink percentage came out roughly ten times too
low — a part with 30% severe sink risk reported 3% and passed. Thickness is
now measured on every triangle up to 200k, and when a stride is still needed
the percentages are measured against the area actually sampled. The check
reports its sampling coverage when it is below 100%.

**Wall-transition detection silently stopped working on large meshes**, for
the same reason: it needs both triangles of an edge pair to carry a reading,
and with a stride of 10 they almost never both did. It now runs only over a
full-coverage pass, rather than quietly finding nothing.

**Volume and surface area never appeared in the part summary.** It read
`window.lastAnalysis`, but `lastAnalysis` was declared with `let`, so it was
never a property of `window`. Both fields showed `—` permanently.

**Shot 2 was analysed with shot 1's material.** `analyseMesh` read the
material directly out of `document.getElementById('material')` from inside the
maths, so the overmould's own material selection was ignored.

**A file name containing HTML executed as HTML.** File names were
interpolated straight into `innerHTML`. They are escaped now.

**The progress bar could not move.** All analysis ran synchronously on the
main thread, so nothing repainted between the first `onProgress` call and the
last. The bar jumped from 0 to gone.

### Architecture

The 5,756-line single file is now ~30 focused modules that build back into one
file. The split is not cosmetic — it is what makes the rest possible.

**Analysis is pure and runs in a worker.** `analyseMesh` and the rule engine
no longer read the DOM; every input arrives as an argument. That let the heavy
ray-casting move to a background thread, so the page stays responsive and the
progress bar reflects real work. Chrome refuses blob-backed workers on
`file://` — which is exactly how this tool gets opened — so the same bundled
code runs inline as a fallback. The header shows which mode is active, and the
test asserts both produce the same score.

**State lives in one place and persists.** Settings were previously scattered
across DOM element values and lost on every reload; "Start over" was
`location.reload()`. There is now a single settings object, saved to
localStorage and restored on the next visit, with reset as a real operation.

### Performance

- **Dijkstra now uses a binary heap.** The flow-length search scanned the
  entire frontier linearly for each minimum — O(V²), which its own comment
  conceded was "adequate up to ~10k verts". A tessellated STEP part is
  routinely five times that. Vertex adjacency is also deduplicated into CSR
  form; previously each vertex appeared once per incident triangle and every
  duplicate was relaxed again.
- **BVH construction no longer sorts at every node.** It allocated a fresh JS
  array and sorted it per node — O(n log²n) with a great deal of garbage.
  Splitting is now a mid-point partition with a quickselect fallback: O(n) per
  level, no allocation. The build is also iterative, so a large mesh with an
  unlucky distribution cannot overflow the call stack.
- **Vertex welding uses an open-addressed hash table** instead of a `Map`
  keyed on `` `${qx},${qy},${qz}` `` strings. A 500k-triangle STL was minting
  1.5M short-lived strings.
- **Ray traversal reuses a preallocated stack** rather than allocating an
  array per cast, and there are millions of casts per run.
- **jsPDF is no longer loaded on every page view**, only on export.

### Interface

- **Heat modes are a segmented control**, not one button cycling blindly
  through six states. Reaching UNDERCUT previously meant pressing five times
  and reading the label each time; modes that do not apply yet are visible but
  dimmed rather than skipped.
- **Collapsible sections are native `<details>`.** The old ones animated
  `max-height` in JS and needed a `refreshSection()` call after any content
  change, which was easy to forget — and did get forgotten, leaving sections
  clipped once their contents grew.
- **Check cards are `<details>` too**, so they open from the keyboard and
  announce their state. Results render through the DOM API into a fragment
  rather than `innerHTML +=` in a loop, which reparsed the whole list on every
  iteration.
- **Errors appear as dismissible toasts**, not `alert()`.
- Buttons carry `aria-pressed`, the drop zones are keyboard operable, there is
  a skip link, and `prefers-reduced-motion` is respected.

### Reporting

The PDF and JSON exports now include the two-shot results. Previously you
could run a full overmould analysis and export a report with no trace of it.
The JSON also carries flow data, wall transitions and the effective draft
minimum. PDF pagination is driven by a cursor that breaks pages based on the
space each block needs, replacing a repeated `if (y > 260)` with a different
threshold at each call site.

---

## How the score works

Each check owns a **weight** — how much that kind of problem is worth at worst —
and each rule returns a **severity**: `minor`, `major` or `critical`, spending a
quarter, a half or all of that weight. Nothing else moves the number. The eight
checks that run by default sum to 100, so a part with no findings scores exactly
100, and the score is normalised over the checks that actually ran, so enabling
the FPC or wall-transition checks widens the exposure rather than making 0
unreachable.

Two things the score deliberately will not do:

- **Advisories cost nothing.** Not having picked a gate yet is not a defect in
  the part. Neither is the corner-radius reminder, which has no way to measure a
  radius from an STL. Both report as `info` and deduct zero.
- **The grade cannot outrun the findings.** A single critical finding on a light
  check leaves a score in the high eighties, and no part with a critical finding
  is called PRODUCTION READY on the strength of where the arithmetic landed. The
  band is the worse of what the score says and what the worst finding allows.

The JSON export carries the severity, the weight and the deduction for every
check, plus the total and the budget it came out of, so any figure on the page
can be traced back to the rule that produced it.

## Mesh health

Everything downstream assumes a closed, consistently wound, millimetre-scale
solid, so that gets checked when the file lands rather than assumed. An STL
carries no units at all — an inch-authored part reads 25.4× small, and every
threshold in this tool is in millimetres — and an open or inside-out mesh
otherwise produces a full report with a confident number on the front of it.

The panel under the drop zone reports unit plausibility, closure, manifold and
winding consistency, inverted normals and degenerate triangles, and offers
one-click rescale and normal-flip where those are the fix. Units are asked about
rather than asserted: a part under 2 mm across is almost certainly mis-scaled,
but one between 2 and 15 mm gets a question, because an 8 mm clip is a real
thing. Only a surface with no interior is refused outright.

Both exports carry the report, and the PDF puts it ahead of the measurements it
qualifies.

## Wall thickness, measured twice

The wall is measured two ways. A ray cast into the solid along the inward face
normal is exact when the opposite face is parallel and overstates the wall when
it is not — a wedge, a tapered boss, a rib meeting a wall at an angle. The other
is the diameter of the largest sphere that fits inside the solid touching that
point, which is what a moulder means by "wall".

**The checks are judged on the sphere figure**, because overstating a wall is the
optimistic direction, and optimism is what lets a section that will sink or
short-shot read as comfortably in band. On a 45° wedge the reported nominal is
20 mm rather than the ray's 30 mm. Both are printed, and where they diverge by
more than 15% the check says so — that divergence is itself a finding about the
geometry.

Two comparisons deliberately stay on the ray figure at both ends, because mixing
measurements there would invent findings: the sink check, which holds a
per-triangle local thickness against the nominal, and the thin-gate advisory,
which holds a single reading at the gate against the median.

## Draft, measured per face

An STL is a bag of triangles, so every measurement over one is a statistic: "42%
of side-wall area is under the minimum" is the most a heap of triangles can say,
and it leaves someone hunting for which wall. A STEP file — and therefore an
`.ipt` — carries the faces the part was modelled with, and a face is the thing a
designer can go and change. So where the geometry carries them, the draft check
names them: *4 of 4 side faces are under 0.50° — face 2 0.00° (29% of side area,
outer)*.

Nothing is measured twice to do this. Draft per triangle, the inner/outer
classification and the two-piece rule all run as before, and the per-face figure
is those results grouped by face — which is what stops a face's angle and the
area percentage from ever disagreeing. A test asserts they agree exactly.

A face is only given a single angle when it really has one. Where a face's
triangle normals fan out it is not a plane, and one number for it would be a
fiction, so a curved face reports the range it spans instead.

Both exports carry it, and both say **which** they measured: `measured_from` is
`brep` or `mesh`. The same part through the two doors produces different records
— not contradictory ones — and anyone comparing two exports needs to know which
they are holding.

## Corner radii, fitted

Radii are not in the file. The STEP reader hands back a triangle range per face
and nothing else — no surface type, no radius, no axis — so a radius has to be
**fitted** to the face's own triangles rather than read off it.

A cylinder's outward normals all lie square to its axis, so they span a plane
and the axis is the direction they never point in. Fit a circle to the face's
vertices projected onto that plane and the radius falls out. Which way the
normals lean tells convex from concave, and how far the face sweeps tells a
whole feature from a corner blend:

|            | sweeps the full turn | sweeps part of it |
|------------|----------------------|-------------------|
| **convex** | a boss               | an external round |
| **concave**| a bore               | an internal fillet|

Internal blends are judged against 0.5× wall and external ones against 1.5×
wall, and the check names the face and the radius that fell short. Bores and
bosses are not corners, so they are reported rather than judged — "three Ø8
bores" is what someone wants before quoting a tool.

**The check always states what it cannot see, including when it passes.** A
corner modelled dead sharp has no cylindrical face to fit, so it cannot appear
in the report at all. A clean result means every radius that exists is
adequate; it never means every corner has one.

The fit declines far more often than it succeeds, which is the point. A flat
face is left flat, and so is a face whose "radius" comes out at five metres —
that is a plane with rounding on it, not a fillet, and reporting it as one
would fill the fillet list with fiction.

Scored only where it can measure. On an STL there are no faces, so the check
stays the advisory it always was and the score is unchanged; on a B-rep it adds
8 points of exposure to the budget, the same way the FPC and wall-transition
checks do. No existing export's score moves.

## Where to put the gate

Flow length, and therefore the short-shot prediction, depends entirely on where
the gate is. On a 200 × 20 × 2 mm bar two plausible gate positions differ by
1.87× in worst-case L/T — the difference between "fills comfortably" and a
warning — so leaving that to wherever someone happened to click made the most
consequential input the least informed one.

Run an analysis without a gate and the tool searches instead of asking. It tries
a spread of positions across the part's outer surface — the inner faces of a
cavity are not somewhere a sprue can reach — and ranks them by worst-case L/T,
then by how much of the part sits over the limit. The flow check reports the best
position and how much the choice matters, and **Use best** places it.

Placing the suggestion reproduces the L/T the search promised; the tests assert
that. The search only runs when there is no gate, so it costs nothing once one is
set, and it tries fewer positions on very large meshes to keep the cost bounded.

## Moulding estimates

Alongside the manufacturability checks the report carries what it takes to make
the part: volume, mass, projected area, the clamp force that implies and the
smallest standard machine that covers it. These are not scored — they are not
pass-or-fail properties of the part — but they are usually the numbers someone
wants first.

Projected area is measured by casting a grid of rays along the pull axis rather
than by summing the triangles' contributions, which matters for holes: a bore
running along the pull axis is formed by a core pin shutting off against the
opposite half, so no melt bears on it and it must not count towards clamp force.
On a 2 mm-wall tube the triangle sum gives the full disc; this gives the annulus.

Cavity pressure is the one assumption in the chain, and it is printed next to the
result. Mass is withheld when the mesh is not a closed solid rather than
estimated from the bounding box.

## Cycle time, and what a part costs to run

Cycle time exists now that the coefficient behind it is settled — it is written
for the **full wall**, established by re-deriving it rather than by asking
(`docs/coolk.md`, asserted in `test/unit.mjs`). It is reported in three steps
rather than as one opaque figure, because only the first is derived:

- the **cooling floor**, `k · s²` on the measured nominal wall — the moment the
  centre of the wall first reaches ejection temperature, with the mould held at
  a fixed temperature and heat leaving in one dimension. A lower bound no tool
  beats, and labelled as one;
- **practical cooling**, taken as 1.3× that floor, because neither of those two
  conditions is true of a real tool;
- the **cycle**, practical cooling divided by cooling's share of it, taken as
  50–80%. The rest is fill, pack, mould motion and ejection.

Both factors are printed next to the answer. A reader who disagrees can
disagree with the step rather than with the number.

**Cost is material plus machine time, and only when the rates are given.** There
are no default resin prices and no default machine rates, deliberately: a
plausible-looking default is indistinguishable on screen from a real quotation
and travels further than it should. Enter a price per kg and a rate per hour and
the part is costed; leave either blank and the tool says which is missing rather
than costing the part at nothing per kilo. The figure that results is material
and machine only — no labour, packaging, overhead, secondary operations or
margin — and it says so wherever it appears.

**Tooling is a list of drivers, never a price.** What a tool costs depends on
the toolmaker, the steel, the country and the lead time, none of which this tool
knows. What it *can* say is what makes the tool expensive: every side action is
a moving assembly, every cavity repeats everything, glass fill means hardened
steel, a mirror finish is polishing hours. The moving-tooling counts come from
the undercut check and inherit its flat-parting-line assumption, which is stated
alongside them.

None of this is scored. Cycle time and cost are not pass-or-fail properties of a
part, so they carry no weight, appear as no check, and cannot move the score — a
part scores the same whether or not anyone has entered a resin price. A test
asserts it.

## Comparing revisions

**Compare with JSON** reads a previous export and says what moved: the score, the
grade, which checks changed band, and which measurements shifted and in which
direction. Comparisons work against files from weeks ago and older schema
versions — a field the old record does not have is reported as unavailable rather
than treated as zero.

It also declines to mislead. Changing material, changing mode or running a
different set of checks all make score movement something other than a change in
the part, and each raises a caveat above the diff.

## Roadmap

`docs/ROADMAP.md` is what happens next and why, in order — and what has already
happened, with the premises the work turned out to have wrong. R2.1 to R2.7 are
done: the STEP path under test, the B-rep face groups consumed, the Inventor
loop under test, the `coolK` convention settled by re-derivation, cycle time and
cost, two-shot registration, the FPC insert, build identity, the findings
package and 6-DoF navigation. Two things wait on something a keyboard cannot
supply — sixteen Vicat softening points, which need datasheets, and half an
hour with a SpaceMouse plugged in.

It also records what has been decided *against*, so it does not get
re-proposed: a computed parting line, flow simulation, and authentication on a
localhost-only bridge.

`docs/ASSESSMENT.md` is the review that preceded the rebuild and the record of
what the five delivered phases actually changed.

## Licence

MIT — see `LICENSE`. The built `dfm-tool.html` carries the notice in a comment at
the top of the file, because the file gets handed to people on its own and a
recipient should be able to find out what they may do with it by opening it.

three.js, jsPDF and the OpenCascade STEP reader are all MIT too. The default
build fetches them at runtime, so they are not part of the file; `--vendor`
embeds three.js and jsPDF, and their own copyright headers are embedded verbatim
with them, which is what MIT asks of a redistribution. `NOTICE` records all of
this in one place and `npm run test:offline` asserts the notices survive the
build.

## Known constraints

- **three.js is pinned to r128**, the last version shipping a UMD build usable
  from a plain `<script>` tag. Moving to a modern release means either an
  import map or a real bundler for the vendor code, which would cost the
  single-file property. Not worth it for what the viewer does here.
- **Undercut candidacy assumes a flat parting line** at the pull minimum, and
  this one is an accepted simplification rather than a gap to be closed. Nothing
  in an STL says where a toolmaker would split the mould, and deciding it
  properly is a search for a curve on the surface that depends on cosmetic
  requirements, gate position and flash tolerance the tool is never given — so
  a computed parting line would be a confident guess a toolmaker then has to
  argue with. The consequence is asymmetric and mostly benign: the assumed line
  sits as low as a parting line can go, so the error is over-reporting. A
  stepped or contoured split can release an overhang with no moving tooling, and
  the undercut check says so in its own output for that reason — read the region
  count as features needing a decision, not as a slide count. It can
  under-report in one narrow window: faces inside the bottom 8% of the pull
  extent are taken as cavity-formed and not tested, so on a part whose real
  split runs well above its base, check that band by eye. Whether a face that
  *is* an undercut needs a slide or a lifter is decided properly, by whether a
  side-action core could physically reach it.
- **Corner radii can only be measured where a radius exists.** On a B-rep they
  are fitted per face and judged (see above). On an STL there are no faces, so
  the check stays advisory. And on either, a corner modelled with no radius at
  all is invisible — there is nothing to fit — so a clean radius report is
  never a statement that every corner is filleted.
- **A finding cannot yet name the Inventor feature that caused it.** The
  **Parameters** panel drives the part and the **History** panel records what
  changed, but the feature tree is display-only: what the bridge returns is a
  flat list of feature names, with nothing tying a face to the feature that
  made it. Now that a finding can name a face, linking that face to a feature
  and to the parameter behind it is the obvious next step — and it needs
  InventorMCP to supply the mapping, so it is not work this repository can do
  on its own.
- **The bridge trusts its caller.** Its routes are unauthenticated and they open
  uploaded files in a local Inventor session, so the server binds to localhost
  and only accepts requests from `file://` and localhost origins. Do not expose
  it on a network interface.
- **The FPC insert has to be pointed at.** Where a multi-body import carries
  the flex as its own solid, marking it in the Solid bodies list turns two
  advisories into measurements: the polymer over the insert, sampled along the
  outward normal at two thousand points, and the distance from the gate to it.
  Where nothing is marked — an STL, a single-body export, or an assembly the
  flex was never modelled in — the check falls back to comparing the part's
  nominal wall against thickness plus twice cover, applied part-wide, which
  over-reports because most of a part is nowhere near the insert. Both versions
  say which one they are.

- **6-DoF navigation is Chromium-only, and silent elsewhere.** A 3Dconnexion
  puck is read through WebHID — which, contrary to the expectation that shaped
  the plan, *is* available on a `file://` page, because Chromium treats a file
  URL as potentially trustworthy. That is checked in the browser test rather
  than assumed, since a Chrome release could take it away. Where the API is
  absent there is no button, no error and no mention of the feature. The axis
  layout is read from the device's own report descriptor rather than a table of
  offsets per model, so a Compact and a SpacePilot both work without either
  being the one that was tested; what no test here can cover is whether a real
  puck's descriptor matches the shape WebHID documents.

- **The findings package is assembled, not collected.** The report, the JSON
  record and the file that was measured leave in one archive, with a manifest
  naming the build that scored it and a CRC32 per member. That last part is the
  point: three files pulled from three places is where the wrong revision gets
  attached, and nobody finds out until the tool is cut. A part loaded by a
  route that kept no bytes still packages, and the manifest says in capitals
  that the geometry is missing rather than quietly shipping two files that
  describe a third.

- **Wall transitions remain advisory on STL.** Thickness sampling is genuinely
  unreliable at corners and rim edges; the check is off by default and says so.
- **Two-shot alignment is corrected, not diagnosed.** Where shot 2's mating
  surface sits more than 1% of the part's size off shot 1, the tool searches
  for the rigid transform that puts them together, applies it if it finds one,
  and reports how far it moved shot 2 and what residual is left. What it cannot
  do is say *why* they were apart: a part exported in its own coordinate system
  and an overmould that genuinely misses its substrate produce the identical
  gap. The finding names both readings and leaves the choice with the reader,
  which is also why it carries no score. Scale is not fitted — a pair 25.4×
  apart is a units mistake and correcting it silently would hide one.
