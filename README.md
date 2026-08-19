# OnlyCat DFM — Injection Moulding Analyser

A browser tool that loads an STL or STEP part, measures it, and scores how
manufacturable it is by injection moulding: wall thickness and uniformity,
draft, ribs and bosses, undercuts and the tooling they imply, sink risk,
shrinkage and warpage, flow length from a chosen gate, FPC overmoulding, and
two-shot interface compatibility. Exports a PDF report and a JSON record.

`dfm-tool.html` is the whole application — one self-contained file you can
double-click. Everything under `src/` builds into it.

---

## Using it

Open `dfm-tool.html` in a browser. Drop a part, pick a material, run.

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
npm test               # build + unit tests + fixtures + browser smoke test

npm run test:unit      # just the unit tests: no browser, no network, sub-second
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

The smoke test drives a real Chromium through the whole pipeline — load,
analyse, heatmaps, gate picking, two-shot, both exports, persistence, reset,
and the main-thread fallback — and serves three.js and jsPDF from
`node_modules` so it never depends on the network.

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
  export/              PDF and JSON
test/                  fixture generator, unit tests, browser smoke test
  lib/shapes.mjs       analytic fixtures with known answers
  lib/reference.mjs    slow, independent reference implementations
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

The wall is measured by casting a ray into the solid along the inward face
normal. That is exact when the opposite face is parallel and overstates the wall
when it is not — a wedge, a tapered boss, a rib meeting a wall at an angle — and
overstating is the optimistic direction, which is the dangerous one for a sink
or short-shot call.

So a second estimate runs alongside it: the diameter of the largest sphere that
fits inside the solid and touches the surface at that point, which is what a
moulder means by "wall". Both medians are reported. They agree exactly on
parallel walls; where they diverge by more than 15% the wall check says so,
because that divergence is itself the finding.

The ray figure still drives the rules. Switching the thresholds onto the sphere
figure would change the meaning of every historical score and is a decision for
whoever owns the calibration.

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

Cycle time is not included. The material table carries a cooling coefficient per
grade, but its documented convention gives the theoretical cooling floor rather
than a practical cooling time — the two readings differ by about 4× — and a
cycle time is exactly the kind of number that gets quoted from. See
`src/analysis/shot.js` for the detail.

## Known constraints

- **three.js is pinned to r128**, the last version shipping a UMD build usable
  from a plain `<script>` tag. Moving to a modern release means either an
  import map or a real bundler for the vendor code, which would cost the
  single-file property. Not worth it for what the viewer does here.
- **Corner radii cannot be detected**, only advised on. That needs B-rep face
  topology; STL does not carry it, and the STEP path does not yet plumb
  through the face groups the parser already extracts. Those groups are
  preserved in the geometry format, so this is the natural next step.
- **Wall transitions remain advisory on STL.** Thickness sampling is genuinely
  unreliable at corners and rim edges; the check is off by default and says so.
- **Two-shot alignment is assumed.** The interface pass expects both meshes to
  be exported in a shared coordinate system; there is no registration step.
