/*
 * Which build produced this.
 *
 * Every artifact the tool emits — the JSON export, the PDF, the comparison
 * between two runs — is a claim about a part made by a particular set of
 * rules. Thresholds move: `ts_thermal` lost 25 points, `corner_radii` gained
 * 8, the FPC floor stopped applying part-wide. Two exports of the same
 * geometry that disagree are only interpretable if each says what produced it,
 * and until now neither did. `dfm-tool.html` carried a licence and no version
 * at all.
 *
 * ── Why the fingerprint is not a commit SHA ──────────────────────────────
 *
 * The roadmap asked for `tool_version` and the source commit. The version is
 * straightforward. The commit cannot be done, and the reason is structural
 * rather than awkward: `dfm-tool.html` is a committed deliverable, and
 * `verify:build` rebuilds it and fails if the result differs from the
 * committed copy. A build that stamped `git rev-parse HEAD` would write the
 * *parent* commit's SHA into the file being committed — no commit can contain
 * its own hash — so the next rebuild would produce a different file and the
 * check would fail on every commit, for ever.
 *
 * So identity is taken from the inputs instead: a hash over the exact sources
 * the build read. That is reproducible by construction, which is what keeps
 * `verify:build` meaningful, and it answers the question a commit SHA was
 * standing in for — "were these two exports produced by the same rules?" —
 * more directly, since two commits that touch only the README share a
 * fingerprint and should.
 *
 * A release build can add the tag it was cut from: `build.js --stamp v2.0.1`
 * writes it here. It is left empty by default, so nothing about the committed
 * artifact depends on where it was built.
 *
 * The fingerprint covers the sources and nothing else — not the release tag,
 * not whether the libraries were vendored. That follows from the question it
 * answers: vendoring inlines a viewer and a PDF renderer, neither of which can
 * move a threshold, so two builds of one source tree scored a part by the same
 * rules whatever options produced them. Which of those artifacts someone is
 * holding is what the banner in the file is for.
 */

/*
 * Substituted by build.js. The literals are what a source tree reports when
 * nothing has substituted them — a Node test, or `src/index.html` opened
 * directly — and they say so rather than claiming a version they are not.
 */
export const TOOL_VERSION = /*@VERSION@*/'dev';
export const BUILD_FINGERPRINT = /*@FINGERPRINT@*/'source';
export const BUILD_STAMP = /*@STAMP@*/'';

/* One short string for a banner or a footer. */
export function buildLabel() {
  const stamp = BUILD_STAMP ? ` ${BUILD_STAMP}` : '';
  return `v${TOOL_VERSION}${stamp} (${BUILD_FINGERPRINT})`;
}

/*
 * The block every export carries. Kept in one place so the PDF, the JSON and
 * the comparison cannot describe the build three different ways.
 */
export function buildIdentity() {
  return {
    tool_version: TOOL_VERSION,
    /* Hash of the sources the build read, not of the output: the output
       contains this value, so hashing it would be circular. */
    source_fingerprint: BUILD_FINGERPRINT,
    release: BUILD_STAMP || null,
    /* Whether these numbers describe a build at all. An export made from an
       unbuilt source tree is a legitimate thing to have — the tests make
       hundreds of them — and it should not be mistaken for a release. */
    built: BUILD_FINGERPRINT !== 'source',
  };
}
