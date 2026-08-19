# OnlyCat DFM — repository assessment and improvement plan

Assessed at commit `67a9655`. Everything below was verified by running the code,
not by reading it.

> **Status — Phases 0, 1 and 2 are done, and Phase 3 has started.** The findings below are kept as
> written, as the record of what was wrong and the evidence for it. What changed
> since is summarised in [Delivered](#delivered) at the end, along with two
> further defects the work uncovered and one calibration question that needs a
> moulding engineer rather than a programmer.

---

## Verdict

This is a good codebase with a scoring layer that has drifted away from the
engineering layer.

The rebuild did what it claimed. The build is clean and reproducible, the module
boundaries are real, the analysis is genuinely DOM-free and genuinely runs in a
worker, and the browser smoke test passes 42 of 42 checks including the
worker/main-thread equivalence assertion. The measurement code is accurate where
it can be checked: on an analytically-known hollow cylinder with a 2.000 mm wall,
the thickness pipeline returns 1.9992 mm.

The problem is one level up. The FMEA rewrite in `src/rules/scoring.js` replaced
per-branch penalties with fixed per-check weights but left the old `penalty`
values in place, unused. The result is that **the number the tool reports is not
the number the rules were written to produce**, and both numbers are written to
the JSON export. On the project's own test fixture:

```
SCORE 76  (MINOR REWORK)  deduction 24.5
  ok   wall           engine-penalty=   0  actual-deduction=0
  fail draft          engine-penalty=  25  actual-deduction=15   ← intended 25
  warn ribs           engine-penalty=   5  actual-deduction=5
  ok   undercut       engine-penalty=   0  actual-deduction=0
  ok   sink           engine-penalty=   0  actual-deduction=0
  warn flow           engine-penalty=   0  actual-deduction=4.5  ← intended 0
  ok   warp           engine-penalty=   0  actual-deduction=0
  ok   corners        engine-penalty=   0  actual-deduction=0
```

For a tool whose output informs tooling spend, the score being untraceable to
the rules is the highest-value thing to fix, and it is also the cheapest. That
is Phase 0 below.

Second in line: nothing validates the incoming mesh. STL carries no units and no
guarantee of closure, and the tool will accept an inch-authored or open mesh and
return a confident two-significant-figure verdict from it.

---

## What is genuinely good, and should not be disturbed

- **The module graph.** `core` and `geometry` are leaves, `analysis` builds on
  `geometry`, `rules` consumes analysis output, only `app` touches the DOM. This
  is not decoration — it is why the pure modules can be imported straight into
  Node and exercised with no harness at all, which the whole test plan below
  depends on.
- **The bundler.** 150 lines, zero dependencies, and it fails loudly on anything
  outside the conventions it supports rather than mis-bundling it. The committed
  `dfm-tool.html` is byte-identical to a fresh `node build.js`, so the artifact
  in git is trustworthy.
- **The numerics.** Binary-heap Dijkstra over CSR adjacency, iterative BVH build
  with mid-point/quickselect partitioning, open-addressed vertex welding,
  preallocated ray stack. These are the right choices and the comments explaining
  why are accurate.
- **The material and rule content.** The thresholds, the citations, and the
  wording of the findings are the part with real engineering behind them. Every
  recommendation below preserves them.
- **The worker/inline duality.** Treating the `file://` fallback as a first-class
  path rather than a safety net is correct — that *is* how this tool gets opened —
  and asserting both paths produce the same score is exactly the right test.

---

## Findings

Ordered by consequence. Severity is about what a wrong answer costs, given that
this tool's output feeds tooling decisions.

### A. The score does not mean what the rules say it means

**A1 — `penalty` is dead code, and it is exported anyway.** *(high)*

Every check in `src/rules/engine.js` computes a branch-specific `penalty`.
`scoreChecks` (`src/rules/scoring.js:65`) ignores it entirely and derives the
deduction from `CHECK_RISK_PROFILES[key].weight` via `computeCheckScore`
(`scoring.js:34`): full weight on a fail, half on a warn, nothing otherwise.

Two consequences:

- All within-check severity gradation is lost. A wall 0.1 mm under the material
  minimum and a wall 3 mm over the maximum both deduct exactly 20. The engine
  distinguishes them (25 vs 22) and that distinction is discarded.
- `src/export/json.js:25` and `:48` write **both** `score_deduction` and
  `penalty` into the export. Any downstream consumer sees two disagreeing
  numbers for the same check with no indication which is authoritative.

**A2 — Not picking a gate is scored as a manufacturing defect.** *(high)*

`engine.js:338` emits `status: 'warn', penalty: 0` with the detail text
`'No gate location set. Click "Pick gate on part" to enable flow-length
analysis'`. The `penalty: 0` is ignored, `'warn'` costs half of flow's weight 9,
and so **every part loses 4.5 points until the user clicks a button in the UI.**
A prompt is being scored as a defect.

This is worth calling out separately from A1 because the fix is already built.
The renderer's `normaliseStatus` handles `'info'`, `STATUS_DOT.info` exists, and
`app.css:806` and `:822` already style `.check.info` and `.check-dot.info` — but
**no check anywhere ever emits `'info'`**. The status was designed for exactly
this case and then never used. `computeCheckScore` already returns 0 for it.

**A3 — Advisory checks hold weight they can never spend.** *(medium)*

`corners` (`engine.js:460`) is hardcoded `status: 'ok'` and carries weight 3, so
3 points of the 100-point budget are permanently unreachable. `finish_compat`
carries weight 1 and deducts it on a fail despite `penalty: 0` (`engine.js:477`).
The weights sum to 100 and the docstring says a clean part scores 100 — true, but
the ceiling and the floor are both wrong: the effective maximum deduction for a
typical part (no FPC, transitions off, corners unreachable) is 87, not 100. The
grade bands in `PART_GRADES` were calibrated against an assumption that no longer
holds.

Also: `corners` is gated on `runChecks.wall`, so unticking "wall thickness"
silently removes the corner-radius advisory too.

**A4 — Textured parts get a false pass on draft.** *(high)*

`effectiveMinDraft` (`src/core/finishes.js`) correctly adds the texture allowance
at 1.5° per 0.025 mm of texture depth. `main.js:331` passes it into `analyseMesh`,
which uses it for the per-triangle statistic and the heatmap, and `json.js:65`
exports it as `effective_min_draft_deg`. The rule that produces the verdict does
not use it: `engine.js:102` reads `const required = m.draftMin`.

Measured, on the project's own fixture:

```
finish       effMinDraft   what the panel tells the user
spi-a2       0.50°         Material min=0.5°   Area <0.5°=100.0%
tex-med      3.50°         Material min=0.5°   Area <0.5°=100.0%
edm-heavy    6.50°         Material min=0.5°   Area <0.5°=100.0%
```

Two distinct faults. The mesh percentage is computed against 6.5° but labelled
"Area <0.5°" — the label is wrong. And the manual-draft branch compares the
stated draft against 0.5°, so a part specified at 1° draft with a heavy-EDM
finish is told its draft *"comfortably exceeds ABS minimum (0.5°)"* when the
textured cavity needs 6.5°. That is a pass on a part that will scuff on ejection.

### B. Nothing validates the incoming mesh

**B1 — No unit check.** *(high)*

STL has no units. The tool assumes millimetres everywhere. An inch-authored file
has every dimension off by 25.4× and a metre-authored file by 1000×, and in both
cases the tool produces a fully-formed report with no hint that the input scale
was implausible. A bounding-box sanity gate at load ("this part is 1.6 mm across
— was it authored in inches?") with a one-click rescale is cheap and removes an
entire class of silently-wrong reports.

**B2 — No mesh-health check.** *(high)*

`analyseMesh` computes volume as a signed-tetrahedron sum, which is only the
enclosed volume for a closed, consistently-wound mesh. There is no closure test,
no non-manifold-edge test, no consistent-winding test, and no degenerate-triangle
test. On an open mesh the volume is meaningless, the inner/outer face
classification degrades (rays leak out through the hole), and thickness readings
go with it — all reported to two decimal places. `detectWallTransitions` is the
only code that even notices non-manifold edges, and it just skips them.

**B3 — Vertex welding can leave seams.** *(medium)*

`weld.js:56` quantises each coordinate to a `diag × 1e-5` grid and looks up only
the exact quantised key. Two vertices closer than the tolerance but straddling a
cell boundary land in different cells and are never merged, leaving a hairline
crack in an otherwise closed mesh.

Measured, on a 96-segment tube with a true 2 mm wall given vertex noise well
below the weld tolerance — physically the same part:

```
vertices        384 → 984          (2.6× inflation from unmerged seams)
boundary edges    0 → 1782         (the mesh is no longer closed)
flow length    98.2 → 203.7 mm     (Dijkstra detours around the cracks)
max L/T        42.8 → 102.0        (the short-shot predictor, 2.4× out)
transitions     208 → 44 candidates (edge pairs no longer share an edge)
wall median   1.9982 → 1.9982 mm   (unaffected)
```

Note where the damage lands. Ray casting is *not* affected — the cracks are
sub-micron and a ray essentially never finds one, so thickness, draft and sink
come through clean. What breaks is everything that treats the mesh as a graph:
flow length walks vertex adjacency and has to detour around every crack, and
transition detection needs both triangles of an edge pair and no longer finds
them. On a PC part (L/T limit 120) that 42.8 → 102.0 shift is the difference
between "fills comfortably" and a warning.

Probing the 26 neighbouring cells, and accepting candidates on true Euclidean
distance rather than cell identity, closes this.

**B4 — Wall thickness is non-deterministic.** *(medium)*

`mesh.js:345` uses `Math.random()` to jitter the stratified sample. Measured on a
12,000-triangle part whose wall genuinely sweeps 1.0–4.0 mm, eight consecutive
runs on the same file:

```
median = 2.5807  2.5852  2.5954  2.5870  2.5870  2.6017  2.5789  2.5539
spread = 0.048 mm
```

The score held at 54 across all eight runs here, so this is not currently
producing visible flapping — but every threshold in the rule engine is a hard
cutoff on this stochastic estimate. A part whose nominal wall sits near a material
limit, or whose IQR ratio sits near 1.15, will flip verdict between runs on an
unchanged file. For a report you hand to a moulder, "run it twice, get two
answers" is not acceptable, and a seeded PRNG costs nothing.

Note this is invisible on uniform-wall parts and on parts under 3,000 triangles
(where every stratum contains exactly one triangle regardless of the jitter),
which is why the existing fixtures do not catch it.

### C. The tests prove the wiring, not the mathematics

**C1 — `npm test` fails on a clean install.** *(high)*

`test/smoke.mjs:40` does `require('playwright')`, and playwright is not in
`devDependencies` — only `jspdf` and `three` are. The README documents
`npm install && npm test`; that sequence fails with `Cannot find module
'playwright'`. The file's own comment says "Playwright is resolved from the global
install; set NODE_PATH if needed", so this is deliberate, but the documented
happy path does not work and CI cannot be added until it does.

**C2 — No test asserts a numerical result.** *(high)*

The smoke test is a good integration test and a poor accuracy test. It asserts a
score *exists* and is in `[0,100]`, that checks *render*, that a PDF *starts with
`%PDF-`*. The one numerical assertion is a regex for `/2\.\d\d mm/` in the wall
check text. Nothing asserts that a 3° drafted cone reports 3°, that a known
snap-hook barb produces exactly one slide region, or that a 60 mm × 2 mm plate
gated at one end reports L/T = 30. Every threshold in `rules/` and every
geometric routine in `analysis/` is currently unverified.

The fixtures make this worse: `part.stl` is 24 triangles and `overmould.stl` is
12. No fixture has a curved surface, an undercut, a wall transition, a
non-manifold edge, or enough triangles to exercise the `heatStride` path above
200k. No STEP fixture exists at all, so the entire STEP path — including the
`faceGroups` extraction — is untested.

The good news is that this is easy to fix. The pure modules import directly into
Node with no harness:

```js
import { parseSTL }    from './src/geometry/stl.js';
import { analyseMesh } from './src/analysis/mesh.js';
import { runDFM }      from './src/rules/engine.js';
```

That is how every number in this document was produced.

**C3 — No CI.** *(medium)*

No `.github/` directory. Nothing enforces that `dfm-tool.html` stays in sync with
`src/` — it happens to be in sync now, but a source-only commit would ship a
stale artifact silently, and the artifact is the deliverable.

### D. Data and inputs that exist but do nothing

**D1 — `coolK` and `density` are completely unused.** *(product opportunity)*

`src/core/materials.js` documents `coolK` as "cooling-time coefficient k in
tc = k × s²" and `density` as "g/cm³". Neither appears anywhere else in `src/`.
The data needed for cycle-time, shot-weight and cost estimates is already
gathered and curated per material, and nothing consumes it. See Phase 3.

**D2 — `bossOD` is collected, displayed, and never evaluated.** *(low)*

It has a form field (`index.html:202`), it is persisted in settings, it is passed
into `runDFM`, and it is printed in the PDF (`pdf.js:197`). No rule reads it.
Either add the boss geometry rules (OD vs hole ID, OD vs wall) or remove the
field — a form field that has no effect on the result trains users to distrust
the others.

**D3 — STEP `faceGroups` are extracted and discarded.** *(product opportunity)*

`step.js` carefully preserves B-rep face groups through the mesh merge. Nothing
reads them. The README correctly identifies this as the enabler for real corner-
radius detection and calls it "the natural next step". It is.

**D4 — `suggestPullDirection` uses a different undercut definition than the
undercut check.** *(medium)*

It scores the six cardinal axes with a hardcoded 1° threshold and a normal-sign
proxy (`mesh.js`, `sinMin` from a literal `1`), ignoring both the selected
material's `draftMin` and the `moldType` setting, and never using the BVH
inside/outside classification that the real undercut pass relies on. So the axis
the tool recommends can be one the tool then reports undercuts on, and the
percentage in the tooltip ("`+Z — 3.1% undercut area (lowest)`") is not the same
quantity the undercut check measures. Either reuse the real classifier or relabel
the output as the rough heuristic it is.

### E. Hygiene

- **No LICENSE.** For a tool that may be shared with moulders or suppliers, this
  needs deciding.
- **CDN scripts have no SRI hashes** (`index.html:14` and the occt loader in
  `step.js`). Three third-party scripts execute with access to the user's CAD
  geometry. `integrity` attributes are a two-line fix; see also Phase 4 on
  vendoring.
- **`legacy/dfm-tool-v1.html`** (5,756 lines) is carried in the repo for
  reference. Fine for now — but once the unit tests in Phase 2 pin the current
  behaviour, it stops earning its place and should go.

---

## The plan

Four phases. Phase 0 and Phase 2 are the ones that change whether the output can
be trusted; Phase 3 is the one that changes what the tool is worth. Estimates
assume one developer familiar with the codebase.

### Phase 0 — Make the score traceable (1–2 days)

The goal is that every point deducted can be pointed at a rule, and that no point
is deducted for anything other than a property of the part.

1. **Pick one source of truth for deductions and delete the other.** Recommended:
   keep the FMEA weights as the per-check budget, and have each check return a
   severity band rather than a raw penalty — `none | minor | major | critical`
   mapping to `0 | 0.25 | 0.5 | 1.0 × weight`. This preserves both the FMEA
   rationale (which is well argued in the scoring docstring) and the within-check
   gradation the engine already encodes. Remove `penalty` from the check objects
   and from both JSON export sites.
2. **Emit `'info'` for advisory and not-yet-computable checks.** The status is
   already plumbed end to end and already styled; it just needs using. Applies to
   the no-gate flow branch, the corner-radii advisory, and the FPC gate-proximity
   note. Extend `scoreStrip` to render `.info` distinctly (it currently collapses
   it to `.ok`).
3. **Rebalance the weight table over checks that can actually deduct**, and
   re-derive the `PART_GRADES` thresholds from the new maximum. Document the
   effective range for the common configuration.
4. **Make the draft check use `effectiveMinDraft`** for the verdict, the metric
   labels, and the prose — and show both the base and effective figures so the
   texture allowance is visible rather than implicit.
5. **Add a regression test that asserts the specific deduction of each check**,
   so this cannot drift again. This is the test that would have caught all of A1–A4.

### Phase 1 — Trust the input (3–5 days)

6. **Load-time validation gate.** Before any analysis: bounding-box plausibility
   (with one-click inch→mm and m→mm rescale), closure test, non-manifold edge
   count, winding consistency, degenerate-triangle count. Present it as a mesh
   health panel with a clear distinction between *fixed automatically*,
   *analysis proceeds with reduced confidence*, and *cannot analyse this*.
7. **Seeded PRNG for thickness sampling**, so a given file always yields a given
   number. Report the sample count and the sampling confidence interval alongside
   the median rather than only the point estimate.
8. **Neighbour-cell probing in `weldGeometry`** to eliminate quantisation seams.
9. **Add a sphere-fit thickness estimate alongside the ray cast.** The ray method
   is directional and overreads on faces that are not parallel to their opposite
   wall; a moulder's "wall thickness" is closer to the largest inscribed sphere.
   Report both and flag disagreement — that disagreement is itself a useful
   signal about geometry the ray method cannot see correctly.

### Phase 2 — Tests that assert numbers (3–4 days)

10. **Analytic unit-test suite** over the pure modules, using generated fixtures
    whose correct answer is known in closed form: hollow cylinder → exact wall;
    drafted cone at n° → `sidePctUnderMin` = 0 at n, 100 at n+ε; single barb →
    exactly one slide region with a known area; flat plate gated at one end →
    known L/T. Assert values with tolerances, not existence. Node-only, no
    browser, sub-second.
11. **Fix `npm test`.** Add playwright to `devDependencies`, add a
    `postinstall`-or-documented `npx playwright install chromium` step, and make
    the README's documented sequence actually work.
12. **Richer fixtures**, including a curved part, an undercut part, a
    non-manifold part, a >200k-triangle part for the stride path, and a small
    STEP file for the OCCT path and `faceGroups`.
13. **GitHub Actions CI**: build, unit tests, smoke test, and a
    `node build.js && git diff --exit-code dfm-tool.html` step so the committed
    artifact can never go stale.

### Phase 3 — Make the output worth more (1–2 weeks)

This is where the tool stops being a scorer and starts being a decision aid.
Everything here builds on data or code that already exists.

14. **Cycle time, shot weight and cost proxy.** `coolK` and `density` are already
    curated per material and unused (D1). With the volume and projected area the
    analysis already computes: shot mass = volume × density, cooling time
    ≈ k·s², clamp tonnage from projected area, and a rough £/part. A report that
    says *"76, minor rework, 18 s cycle, 31 g shot, ~40 t clamp"* answers the
    question the user actually has. This is the single highest-value addition and
    it needs no new geometry work.
15. **Gate placement optimiser.** The flow solver already exists and already runs
    fast. Run it from N candidate surface points, rank by max L/T and by whether
    predicted weld lines land in cosmetic or optical regions, and present the
    best few. This removes the largest arbitrary input in the tool — right now
    the flow verdict depends entirely on where the user happened to click.
16. **Corner radii from STEP B-rep faces** (D3). Consume `faceGroups`, fit
    cylinders to fillet faces, and turn the advisory into a real measured check
    against the 0.5× / 1.5× wall guidelines.
17. **Revision comparison.** Persist runs and diff two JSON records: *"score
    76 → 91; draft resolved; sink unchanged; new undercut at (12, 4, 30)."* This
    is what turns the tool from a one-shot verdict into part of a design loop,
    and the JSON export format is already rich enough to support it.
18. **Resolve `bossOD`** (D2) — implement the rules or remove the field.
19. **Reconcile `suggestPullDirection` with the real undercut classifier** (D4),
    and extend the search beyond the six cardinal axes.

### Phase 4 — Resilience and housekeeping (2–3 days)

20. **Offline build option.** The tool's core promise is a file you double-click,
    and three CDN fetches undercut it. Add a `--vendor` build flag that inlines
    three.js and jsPDF (the occt WASM is too large and can stay lazy, with STEP
    documented as network-dependent). Add SRI hashes to the CDN path in the
    meantime.
21. **LICENSE**, and a short CONTRIBUTING note documenting the bundler's
    conventions — the constraints in `build.js` are load-bearing and currently
    only discoverable by triggering a build error.
22. **Retire `legacy/`** once Phase 2's tests pin current behaviour.

---

## Reproducing the evidence

```sh
node build.js && node test/make-fixtures.mjs

# Browser smoke test. Playwright is not in devDependencies (finding C1);
# on a machine with a preinstalled browser, point launch() at it.
npm install --no-save playwright && node test/smoke.mjs
```

The scoring, draft-threshold and determinism figures in this document were
produced by importing the pure modules directly into Node, as described in C2.
Those probe scripts are throwaway; the durable versions are Phase 2 item 10.

---

## Delivered

Two phases are complete. `npm test` runs 59 unit assertions and 48 browser
checks; the committed `dfm-tool.html` is in sync with `src/`.

### Phase 0 — the score is traceable to the rules

`penalty` is gone. Each rule now returns a **severity band** — `minor`,
`major`, `critical` — and the deduction is that fraction of the check's weight
(a quarter, a half, all of it). One number, derived one way, and the JSON export
carries `severity`, `weight` and `score_deduction` per check plus a `scoring`
block giving the deduction and the budget it came out of.

The bands were assigned by reading what each branch already said about the
consequence. Where a rule described a finding as "moderate" and prescribed a
mitigation, it became `minor`; where it said the part would not work, `critical`.

- **A1 fixed.** No check carries a `penalty` field, and the export writes one
  deduction per check instead of two disagreeing ones.
- **A2 fixed.** The no-gate flow prompt and the corner-radii advisory emit
  `'info'` — the status that was already plumbed through the renderer and
  already styled in the CSS, and that no check had ever emitted. Neither costs
  anything. **A part with nothing wrong with it now scores exactly 100; it
  scored 96 before, because a gate the user had not yet picked cost 4.5 points.**
- **A3 fixed.** `corners` holds zero budget. The eight checks that run by
  default sum to exactly 100, and the score is normalised over the checks that
  actually ran, so enabling the FPC or transition checks widens the exposure
  instead of making 0 unreachable. `finish_compat` now reports when it passes
  rather than staying silent, so the denominator does not depend on whether it
  had anything to say.
- **A4 fixed.** The draft check judges against `effectiveMinDraft` — material
  minimum plus texture allowance — and labels every figure with the threshold it
  was measured against. The measured effect, on one part with 8° walls and a
  stated 3° draft:

  ```
  polished (SPI A-2)   before: 96 PRODUCTION READY   after:  100 PRODUCTION READY
  heavy EDM texture    before: 96 PRODUCTION READY   after:   82 MINOR REWORK
  ```

  Before: *"Stated draft 3° comfortably exceeds ABS minimum (0.5°)."*
  After: *"Stated draft 3° is below the 6.50° this part needs (0.5° for ABS plus
  6.00° for EDM heavy). Ejection scuffing & tool drag likely."*

Two further changes fall out of the same principle:

- **The grade can no longer outrun the findings.** A single critical finding on
  a light check leaves a score of 90, which the old bands called PRODUCTION
  READY. The band is now the worse of what the score says and what the worst
  finding allows.
- **Two-shot scores through the same mechanism.** It previously summed raw
  penalties to a maximum of 105, so an interface score of 70 and a part score of
  70 were not the same statement.

### Phase 1 — the geometry is checked before it is measured

- **B1, B2 fixed.** `src/geometry/validate.js` runs at load: unit plausibility,
  closure, manifoldness, winding consistency, inverted normals via signed
  volume, degenerate triangles. It reports a confidence verdict and offers
  one-click rescale and flip, and it is carried into both exports — in the PDF
  ahead of the analysis it qualifies. Units are asked about rather than
  asserted: under 2 mm across is called almost certainly mis-scaled, 2–15 mm
  gets a question, because an 8 mm clip is a real thing. Only a surface with no
  interior is refused outright.
- **B3 fixed**, and the mechanism was not what this document originally guessed
  — see the corrected B3 above. Ray casting was never affected; flow length and
  transition detection were, badly.
- **B4 fixed.** Seeded PRNG, so the same file gives the same answer. `stats()`
  also returns a distribution-free 95% confidence interval for the median, and
  the wall check says so when the nominal it is judging on is not pinned down.
- **Item 9 done.** An inscribed-sphere thickness estimate runs alongside the ray
  cast and is reported next to it; a disagreement over 15% is called out as
  evidence of non-parallel walls, where the ray figure is the optimistic one.
  Validated against a 2561-ray brute-force reference: median error under 1%.
- **C2 partly addressed.** `test/unit.mjs` asserts numbers against analytic
  fixtures and against independent reference implementations in
  `test/lib/reference.mjs` — the edge census, signed volume and sphere thickness
  are each written twice, from the definition, so the two can disagree. Wall
  thickness is pinned to 1% against known geometry, draft to 0.01° against a
  frustum. `npm test` runs it first.

### Found while doing the work

**F1 — every fusion weld was graded a critical thermal failure.** *(fixed)*

The thermal check compares shot 2's melt against shot 1's HDT. Two grades of the
same polymer necessarily have melt far above HDT, so the check condemned every
same-polymer pair in the compatibility table — while the adhesion check on the
same page called them the strongest bond available. ASA-natural on PC/ASA, which
is the reason those grades are in the table at all and is the IR-window
construction, came out **66, MAJOR REWORK**. Pairs that weld to themselves now
carry `fusion: true` in `TWO_SHOT_COMPAT`, and the thermal check reads the heat
as the bonding mechanism it is, with a minor process caveat about substrate
dwell. That pairing now scores **92, INTERFACE OK**. ABS+PP is still 26 and NOT
COMPATIBLE.

**F2 — a wrong sentence in the material data.** *(fixed)*

The `abs:tpu` note read *"TPU melts at 200°C, well below ABS HDT of 98°C."*
200 °C is not below 98 °C. Reworded to say what is actually true and why the
pair works anyway.

**F3 — the 120 °C HDT margin condemns low-HDT substrates.** *(open — needs a
moulding engineer, not a programmer)*

`ts_thermal` calls it critical when shot 2's melt exceeds shot 1's HDT by more
than 120 °C. Polypropylene's HDT at 0.45 MPa is 60 °C, so PP + TPU — a common
overmould — scores 49, NOT COMPATIBLE, on the thermal check alone. The code's
own comment concedes the metric is wrong: *"HDT is a sustained-load test; Vicat
softening point is closer to what two-shot injection actually does to the
substrate."* The fix is to carry Vicat figures in the material table and compare
against those, but which margin is right is a question about OnlyCat's process
window, and it should not be guessed at. Affected pairs, all currently critical
on thermal: `pp+tpu`, `abs+pc`, `abs+pp`, `pp+pe`, `pom+pp`, `pa6+pp`.

### Phase 2 — tests that assert numbers, and CI

- **C1 fixed.** `playwright` is pinned in `devDependencies`, `npm run browser`
  fetches the Chromium binary that `npm install` does not, and `DFM_CHROMIUM`
  points the smoke test at a browser you already have. The README's documented
  sequence now works from a clean clone.
- **C3 fixed.** `.github/workflows/ci.yml` runs the unit tests first (no browser,
  no network, fails fast), then asserts the committed `dfm-tool.html` matches a
  fresh build, then installs Chromium and runs the browser suite. A source-only
  commit can no longer ship a stale deliverable.
- **Item 12 partly done.** Fixtures now cover a curved part, a drafted shell, an
  overhang with a known undercut answer, a non-manifold mesh, a mesh with one
  face wound backwards, an inch-authored file and an open one, plus a
  subdivision helper for asserting tessellation independence. Still no STEP
  fixture: the STEP path needs the OpenCascade WASM module, which is fetched
  from a CDN, and vendoring 6 MB into the repository to test it is not obviously
  the right trade. The STEP parser and its `faceGroups` extraction remain
  untested.

67 unit assertions, 48 browser checks.

### Found while doing Phase 2

Both of these were found by the first test ever written against undercut
detection, on a fixture with a closed-form answer: a 14 mm overhang across a
30 mm extrusion, so 420 mm² of undercut needing one slide that travels 14 mm.

**F4 — the subsampled thickness pass aliased against tessellation.** *(fixed)*

Above 200,000 triangles the per-triangle thickness pass samples a subset. It
took every *n*th triangle in index order — and triangles come off a tessellator
in a repeating per-segment order, so a stride sharing a factor with that period
samples the same face role on every segment and never the others. On a tube
whose wall steps from 2 mm to 6 mm:

```
coverage   severe sink area reported     true value 8.9%
100%       8.86%
50%        9.77%
33%        3.33%
17%        0.00%     ← the entire 6 mm band never sampled
8%         0.00%
```

A part over 200k triangles — which any STEP file tessellated at fine deflection
is — could report no sink risk at all on a part full of it. The failure is
silent and in the optimistic direction. The subset is now drawn from the seeded
generator instead of index order, which decorrelates it from the ordering while
staying reproducible: the same fixture now reports 8.7–9.1% at every coverage
level down to 8%.

This is the same defect as B4 in a different place. Worth remembering that
"take every nth" is never a safe way to sample a mesh.

**F5 — undercut regions were counted by tessellation, and slides had no
direction.** *(fixed)*

Regions were formed by dropping triangle centroids into a grid of `diag/40` and
unioning occupied neighbours. On the overhang fixture the same physical feature
came out as **2, 8, 27 and 7 regions** at successive subdivision levels. The rule
engine reads that count — one slide is a minor finding, two or more a major one —
so the same part graded differently depending on how finely it had been
exported. Regions are now formed by walking shared edges between undercut
triangles, with a proximity pass to rejoin patches separated by a sliver of
faces that fell just under the threshold. The fixture reports one region at
every subdivision level.

Separately, the slide's retraction direction was the patch's mean normal
projected into the parting plane. For an underbelly — the flat underside of a
lip or a snap-hook barb, which is the most common undercut there is — that normal
points straight along the pull axis and the projection is the zero vector. The
tooling panel read:

```
before:  Slide retracts perpendicular to pull along (0.00, 0.00, 0.00),
         min stroke ≈ 0.0 mm (add ~3–5 mm clearance).
after:   Slide retracts perpendicular to pull along +X,
         min stroke ≈ 14.0 mm (add ~3–5 mm clearance).
```

Where the normal carries no in-plane information, the direction the feature is
reachable from does: outward from the part's centre towards the region.

**F6 — lifters cannot be detected in the default mould mode.** *(open — needs a
moulding engineer)*

In `analyseMesh`, a two-piece mould only admits candidates with
`pd < -0.7` — faces pointing against the pull — and every such candidate is then
classified slide-or-nothing. The lifter branch requires `|pd| < 0.7`, which is
unreachable. So with the default `two-piece` setting the tool can never report a
lifter, while the rule engine has a whole branch for them (`sigLifter.length` →
critical) and the tooling panel renders lifter cards that never appear.

That may be deliberate: the code argues that a sidewall leaning toward the
parting plane "simply belongs to the other half" in a two-piece tool, which is
right. But an internal ledge inside a housing genuinely needs a lifter in a
two-piece mould, and worse, such a ledge is currently classified as a *slide*,
because a ray cast outward from it escapes through the part's opening. Deciding
what should be reported here is a tooling question, not a coding one.

### Phase 3 — shot weight and clamp force

**Item 14, in part.** `density` is read at last. Volume is already measured, and
the part's projected area along the pull axis is now measured too, so the report
carries what a quotation actually needs:

```
Part volume  9.02 cm³    Cavity pressure  30–45 MPa
Part mass    9.5 g       Clamp force      4–6 t
Projected    12.0 cm²    Machine size     20 t
```

Projected area is measured by casting a grid of rays down the pull axis and
counting hits, not by summing ½·Σ|n̂·p̂|·A over the triangles. That sum is exact
only for a convex part and overstates everything else, and — more importantly —
ray casting gets holes right: a bore running along the pull axis is formed by a
core pin shutting off against the opposite half, so no melt bears on it and it
must not count towards clamp force. On a 2 mm-wall tube the sum gives the full
1257 mm² disc; the answer is the 239 mm² annulus, which is what this reports, to
within 0.2%.

Cavity pressure is the one process assumption, and it is stated on the page
rather than buried: a band by the material's flow class, which is another field
that had been sitting in the table unread. Mass is withheld entirely when the
validator judged the surface open, because an enclosed volume is undefined then
and a shot weight derived from one would be invented.

**Cycle time is deliberately not shipped.** `coolK` is documented as the
coefficient in tc = k·s² with s the half-wall, and under that reading a 2 mm ABS
wall cools in 1.7 s — the theoretical floor, roughly what the one-dimensional
conduction solution gives for the centreline reaching ejection temperature, and
not a number any moulder would quote. Read as a full-wall coefficient the same
table gives 6.8 s for ABS, 4.0 s for PP and 8.8 s for PC, which sit inside the
practical bands and reproduce the right ordering — where the analytical reading
does not, since with real diffusivities PC comes out cooling *faster* than ABS
while the table has it 30% slower. So the coefficients look empirical and
full-wall, and the comment describing them looks wrong.

The two readings differ by 4×, and whichever number appeared would be quoted
from. **This is the one question worth waking up to:** are those `coolK` values
full-wall or half-wall? One sentence unlocks cycle time, and with it the cost
model that makes the rest of Phase 3 worth building.

### Costs

Everything above costs 30% of a run: 1103 ms to 1438 ms on a 96k-triangle part,
measured against the original. Welding is ~20% slower on the common path, once,
at load. The sphere-fit thickness pass, the projected-area raster and the
randomised heat sampling account for the rest. All of it is inside the worker,
and none of it touches the page's responsiveness.

### Still open, in priority order

**Three questions for a moulding engineer**, all recorded above: F3 (the 120 °C
HDT margin, which condemns polypropylene as a substrate), F6 (whether lifters
should be detectable in a two-piece tool, and the misclassification of internal
ledges as slides), and whether the wall thresholds should move onto the
sphere-fit figure rather than the ray one. None is a coding decision.

**The rest of Phase 3**: the gate optimiser (the flow solver already exists and
already runs fast, so ranking N candidate gate points by max L/T and by where
the weld lines land is mostly wiring — and it removes the largest arbitrary
input in the tool, since the flow verdict currently depends on where the user
happened to click), corner radii from the STEP `faceGroups` the parser already
extracts and discards, and revision comparison. Cycle time as soon as the
`coolK` question is answered.

Also outstanding and small: `bossOD` is still collected, persisted and printed
in the PDF without any rule reading it, and `suggestPullDirection` still scores
axes with a hardcoded 1° threshold and a normal-sign proxy rather than the
classifier the undercut check actually uses, so the axis it recommends can be
one the tool then reports undercuts on.

**A STEP fixture**, which needs a decision about vendoring the OpenCascade WASM
module. The whole STEP path is currently untested.
