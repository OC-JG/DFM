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
node build.js          # writes dfm-tool.html
```

No dependencies, no install step. The bundler is ~150 lines in `build.js`.

```sh
npm install            # only needed for the test
npm test               # build + fixtures + browser smoke test
```

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
  geometry/            STL + STEP parsing, vertex welding, BVH
  analysis/            mesh measurement, flow, undercuts, transitions
  rules/               DFM rule engine, two-shot rules, FMEA scoring
  worker/              off-thread analysis entry point
  app/                 viewer, camera, panels, state, wiring
  export/              PDF and JSON
test/                  fixture generator + smoke test
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
