# Changelog

What changed, and — the part that earns this file its place — **when a score
moved for a reason other than the part**.

This tool's output is a number someone spends tooling money against. If a
threshold shifts, or a check changes what it measures, then the same STEP file
scores differently on Tuesday than it did on Monday, and without a record
there is no way to tell that apart from a design improvement. `compare.js`
already refuses to guess: hand it two exports from different builds and it
says *"check the release notes before reading a score change as progress."*
This is the file it means.

So every entry that can move a score is called out under **Scores and
thresholds**, with the measured effect where one was measured. Everything else
is grouped the usual way.

Versions are the `version` field in `package.json`, tagged `vX.Y.Z`. A release
carries the built `dfm-tool.html`; see `.github/workflows/release.yml`.

---

## Unreleased

**Nothing has been released yet.** `package.json` has read `2.0.0` since the
first modular commit on 2026-08-17 and has never been tagged, so one version
number has stood for every state of the tool across 48 commits — which is the
gap this file and the release workflow close. The entries below are
reconstructed from that history rather than written as the work landed; the
dates are the dates it reached `main`.

### Scores and thresholds

The same part, scored by the build before and the build after, does not
necessarily get the same number across any of these.

| Landed | What moved | Measured effect |
|---|---|---|
| 2026-08-17 | Sink coverage was divided by total surface area while being sampled with a stride, on any mesh over 20k triangles | A 200k-triangle part reported about **10× too little** sink risk. Sink findings get worse on large parts, correctly. |
| 2026-08-19 | Weight and severity separated; each rule's self-assigned `penalty` removed from the engine, the two-shot rules and both export sites | Every score changes. A check that meant to cost 25 was costing **15**; a check that meant to cost nothing was costing **4.5**. A deduction is now the check's weight spent by severity — a quarter, a half or all of it. |
| 2026-08-19 | The gate is searched for rather than taken from wherever the user clicked | On a 200 × 20 × 2 mm bar, two plausible clicks differ by **1.87×** in worst-case L/T — the difference between "fills comfortably" and a short-shot warning. |
| 2026-08-19 | The suggested pull direction now uses the same classifier as the undercut check, instead of a hardcoded 1° sidewall-lean test | The overhang fixture went from being told `+Z — 0.0% undercut area (lowest)`, on an axis that then reported 420 mm² of slide undercut, to `−Z — no undercuts`. The axis changes, and so does every check downstream of it. |
| 2026-08-19 | Internal undercuts are lifters, not slides — decided by whether a side-action core could physically reach, with rays cast in the parting plane | On a revolved cup with an internal annular ledge, **1200 mm² across two SLIDE regions** became **214 mm² LIFTER** for the ledge and **1018 mm² LIFTER** for the cavity ceiling. External features are untouched. Tooling actions and their cost move with it. |
| 2026-08-19 | `ts_thermal` (melt against HDT) stopped scoring: weight **25 → 0** | HDT is a 0.45 MPa / 0.25 mm deflection test and the substrate's bulk never reaches melt temperature, so the check condemned the textbook overmoulds. **PP + TPU scored 49, NOT COMPATIBLE, on this check alone.** Two-shot interface scores rise. |
| 2026-09-07 | Corner radii are fitted from the B-rep rather than read from it (nothing in a STEP file reports a radius) | The `corner_radii` check can now fire at all on a STEP or `.ipt` part. A new deduction becomes possible where there was none. |
| 2026-09-08 | The two shots are registered before their interface is measured | An overmould pair that is not already mated was previously measured where the two files happened to sit. Interface findings change on any such pair; a mated pair is left alone. |
| 2026-09-08 | The FPC floor stands down when the insert region is actually located, and cover is measured over it | The warn floor fired on every part with an FPC declared. It now fires where cover is measurably short — and reports the shortfall. |

Not score-moving, and worth saying so because they look as though they should
be: the Phase 1 geometry work (weld tolerance, seams, normals) changed nothing
— the fixture still scored 76 across it — and the `coolK` half-wall/full-wall
resolution moved no score either, because the field was deliberately unused
until it was settled.

### Added

- **Inventor `.ipt` input, and the loop back.** The file goes out to a local
  [InventorMCP](https://github.com/OC-JG/InventorMCP) server, which opens it in
  Inventor and exports STEP — carrying the B-rep faces an STL throws away. The
  document stays open, so the **Parameters** panel lists the part's driving
  dimensions, and editing one rebuilds the part and brings the new geometry
  straight back. Each change is recorded under **History** with the score it
  replaced.
- **Cycle time and cost**, in three steps rather than one multiplier, with
  every assumption printed beside the number. Unblocked by the `coolK`
  derivation below.
- **Two-shot registration.** A trimmed rigid fit (Horn, 1987) aligns shot 2 to
  shot 1 before the interface is measured, with correspondences filtered by
  normal agreement rather than by residual quantile. Reported as a fork rather
  than a finding: the tool says whether it moved the part and by how much.
- **The FPC insert region**, designated on the part and measured — cover over
  the insert, the shortfall where there is one, and the gate-to-insert
  distance.
- **Per-face draft.** An STL can only say "42% of side-wall area is under the
  minimum"; a STEP file knows which face. The check now names them, and a face
  gets a single angle only where it has one — where the normals fan out it
  reports the range it spans.
- **Corner radii, bosses, bores and fillets**, fitted from face normals and
  vertices: convex or concave by which way the normals lean, whole feature or
  corner blend by how far the face sweeps.
- **Compare against a previous run.** Reads a JSON export and reports what
  moved — score, grade, which checks crossed a severity band, which
  measurements shifted and in which direction — and now also whether the
  *rules* moved between the two, in three states.
- **Build identity in every export.** Tool version, a fingerprint of the
  sources that built it, and the release name if it was a release build.
- **Stable references for findings.** Located features carry an id derived from
  where the feature is, on a fixed 2 mm grid, so a factory quoting "UCS-4F2A1B"
  is quoting something that survives another rib being added on the far side of
  the part.
- **The findings package.** One ZIP holding the PDF, the JSON and the file that
  was measured, plus a manifest with a CRC32 per member — because three files
  pulled from three places is where the wrong revision gets attached.
- **6-DoF navigation.** A quaternion camera, and a WebHID transport that reads
  a 3Dconnexion device's axis layout from its own report descriptor rather than
  from a table of offsets per model.
- **The webfonts are embedded**, in every build rather than only the offline
  one. Archivo and JetBrains Mono as woff2 data URIs — the latin subset, one
  variable file per family, about 100 kB — so the tool renders in the
  typography it was designed in whether or not the machine has a connection.
  Both are OFL-1.1 and the artifact carries their notices and the licence.
- **An offline build.** `node build.js --vendor` inlines three.js and jsPDF —
  about 1.4 MB instead of 500 kB, and nothing to fetch.
- **A release name in the build.** `node build.js --stamp v2.0.1`.
- **MIT licence**, declared in `package.json`, in `LICENSE`, and in a comment
  in the built artifact — which is the only one of the three a recipient
  holding the file on its own will ever see.

### Changed

- **The tool was rebuilt as ~30 modules** that build back into one
  self-contained `dfm-tool.html`, from a 5,756-line single file. Same material
  data, same thresholds, same findings wording: that content is the part with
  real engineering behind it and was carried across deliberately.
- **Both panels reworked.** The input rail is numbered — Part, Material,
  Tooling, Checks, Overrides, Inserts — with pull direction and gate merged,
  because they are one decision about how the mould opens. Results are three
  tabs answering three questions: what is wrong, what will it cost, what have I
  already changed.
- **`coolK` is a full-wall coefficient.** The comment saying half-wall was
  wrong, and the two readings differ by a factor of four. Settled by
  re-deriving rather than by asking: each coefficient implies a thermal
  diffusivity, and under the full-wall reading **16 of 16 materials** land
  inside the measured range for unfilled thermoplastics (0.088–0.168 mm²/s)
  where under the half-wall reading **none** do.

### Fixed

- **Shot 2 STL files could never load.** `loadFile2` called `isBinarySTL`,
  `parseSTLBinary` and `parseSTLAscii`; none of the three existed. Two-shot
  analysis had only ever worked with STEP files.
- **Weld tolerance now means Euclidean distance.** The grid quantisation both
  over-merged points up to `tol·√3` apart and failed to merge points a
  nanometre apart across a cell boundary.
- **The build produces the same bytes on Windows and Linux.** `verify:build`
  had been red on `main` since 2026-08-25, and not because anything was stale:
  33 lines differed by nothing but a path separator in a section banner, and
  the embedded worker string differed by escaped `\r\n` from a CRLF checkout.
  Two weeks of the browser and offline suites not running were hiding behind
  it.
- **A refused Inventor probe is the tool working, not an error.** It was being
  logged as a console error the page cannot suppress, which failed three smoke
  checks anywhere an Inventor is not running.
- **The async tests were never running.** `it` in `test/unit.mjs` was
  synchronous, so eight `async` tests reported themselves as passes before
  running an assertion, and their work carried on after the summary — holding
  the process open until CI shot the runner twice. Awaited, one of them found a
  real defect immediately: the test asserting an over-large ZIP member is
  refused *without* allocating four gigabytes was itself allocating four
  gigabytes, because the size was checked after the bytes were materialised.
- The navigator loop threw away its first sample, integrating it over zero
  elapsed time.
- **The viewer's navigation hint never had its tight row gap.** `row-gap: 4px`
  was followed by `gap: 14px`, and the shorthand resets the longhand, so
  wrapped rows sat 14px apart. Found by the linter.
- Every use of the global `isNaN`/`isFinite` is now `Number.isFinite`. These
  are "is this a real measurement" tests over arrays where NaN means
  not-measured, so an out-of-range read is skipped rather than used — which is
  what the global versions did by accident and the obvious replacement,
  `Number.isNaN`, would have stopped doing.

### Testing and infrastructure

- **The Node suite**: unit, the STEP path, the Inventor bridge against a real
  HTTP server speaking the real protocol, and the markup/script id contract —
  plus a browser smoke suite and an offline suite that refuses every off-origin
  request rather than answering it from `node_modules`.
- **The markup/script contract** asserts that every DOM id `src/app` reaches
  for still exists in the markup, that the build slots survive, and — since the
  hang above — that no async test's result is dropped.
- **`verify:build`** rebuilds `dfm-tool.html` and fails if it differs from the
  committed copy, so a source-only commit cannot ship a stale deliverable.
- **`npm run sri`**, which prints the subresource-integrity attribute for each
  of the three runtime CDN loads and says where each one goes. The attributes
  are not in the source yet: they have to come from the bytes the CDN actually
  serves, and a wrong one is a blank viewer rather than a warning.
- **A performance budget** (`test/perf.mjs`). It budgets the work the analysis
  asks for — rays cast, BVH nodes visited, triangles tested, which are the same
  integers on every machine — rather than the time it takes, which on an idle
  machine varies by 1.8× between runs of the same analysis. Wall clock is
  reported beside it with a deliberately loose backstop.
- **A linter**: Biome, linter only, running first in CI with
  `--error-on-warnings` — without which it exits 0 on the warnings that are
  most of what it finds. The formatter is deliberately off; `biome.jsonc` has
  the measurement that decided it.
- **CI** runs the cheap checks first: a broken thickness calculation should not
  wait on a Chromium download to report itself.

---

## Before this file

There is one earlier artifact, `legacy/dfm-tool-v1.html`, kept for reference.
It predates the modular source, the tests and every threshold correction above,
and nothing in it should be read as current.
