/*
 * The gates a release has to pass, and the notes it ships with.
 *
 * A release of this tool is a single HTML file that leaves the repository and
 * gets handed to people. Once it has left, the only things a recipient can use
 * to find out what they are holding are the version in the banner and the
 * release notes — so the two have to agree with each other and with the
 * changelog, and the cheapest place to guarantee that is a check that refuses
 * to publish when they do not.
 *
 * Three things must line up before a tag becomes a release:
 *
 *   1. the tag is `v` followed by a version
 *   2. package.json says that same version
 *   3. CHANGELOG.md has a section for it, with something in it
 *
 * Each of the three fails silently in its own way if unchecked. A tag ahead of
 * package.json ships a file whose banner reads the old number. A tag behind it
 * ships one that claims to be newer than it is. A missing changelog section
 * ships a release whose notes are empty, which is where `compare.js` sends
 * anyone asking whether a score moved because of the rules — so an empty one
 * is not a cosmetic gap.
 *
 * This file is pure functions plus a CLI. The functions are what the unit
 * tests exercise; the CLI is what the workflow calls.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/*
 * The version a tag names, or null.
 *
 * Deliberately strict. `2.1.0` without the `v`, `v2.1` with a part missing and
 * `release-2.1.0` are all rejected rather than interpreted, because a tag is
 * typed by hand once and then is permanent — guessing at what someone meant is
 * how a repository ends up with `v2.1.0` and `2.1.0` pointing at different
 * commits.
 *
 * A pre-release suffix is allowed (`v2.1.0-rc.1`) and marks the release as a
 * pre-release; build metadata (`+something`) is not, because it does not
 * survive being a filename or a release title intact.
 */
export function tagVersion(tag) {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag || '').trim());
  return m ? m[1] : null;
}

/* Whether a version carries a pre-release suffix, which is what decides
   GitHub's pre-release flag. */
export function isPrerelease(version) {
  return String(version || '').includes('-');
}

/*
 * The body of one `## ` section of a markdown document.
 *
 * Matched on the heading text after `## `, up to the next heading of the same
 * or a higher level — so the `### Added` subsections inside a release come with
 * it and the next release does not. Returns null when there is no such
 * heading, and an empty string when the heading exists with nothing under it:
 * the caller wants to tell those apart, since one is a forgotten section and
 * the other a forgotten entry.
 *
 * A heading may carry a date after the version (`## v2.1.0 — 2026-09-08`), so
 * the match is on the first token rather than the whole line.
 */
export function section(markdown, heading) {
  const lines = String(markdown).split('\n');
  const want = String(heading).trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    /* `v2.1.0 — 2026-09-08` matches `v2.1.0`; `v2.1.0-rc.1` does not match
       `v2.1.0`, which is the point of comparing the whole first token. */
    const first = m[1].split(/\s+/)[0].toLowerCase();
    if (first === want || m[1].trim().toLowerCase() === want) { start = i + 1; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) { end = i; break; }
  }
  /* A horizontal rule is how the sections in CHANGELOG.md are separated, and
     it belongs to neither of them. */
  return lines.slice(start, end).join('\n').replace(/\n*^-{3,}\s*$/m, '').trim();
}

/*
 * Everything wrong with a proposed release, as a list of sentences.
 *
 * All of them at once rather than the first: a botched release is usually
 * botched in two places — the version bumped and the changelog not, or the
 * other way round — and finding out about the second one after fixing the
 * first costs another tag.
 */
export function releaseProblems(tag, { version, changelog }) {
  const problems = [];
  const wanted = tagVersion(tag);
  if (!wanted) {
    problems.push(`Tag "${tag}" is not a release tag. A release tag is v followed by a version, e.g. v2.1.0 or v2.1.0-rc.1.`);
    return problems;
  }
  if (wanted !== version) {
    problems.push(`Tag ${tag} names version ${wanted} but package.json says ${version}. Bump package.json and rebuild before tagging, or delete the tag and use v${version}.`);
  }
  const notes = section(changelog, `v${wanted}`);
  if (notes === null) {
    problems.push(`CHANGELOG.md has no "## v${wanted}" section. Move the Unreleased entries under it, with the date, and leave a fresh Unreleased heading behind.`);
  } else if (!notes) {
    problems.push(`CHANGELOG.md has a "## v${wanted}" section with nothing in it. Release notes are where compare.js sends anyone asking whether a score moved because of the rules; an empty section answers nobody.`);
  }
  return problems;
}

/* The notes for a release, or null if it has no section. Separate from the
   check above so the workflow reads the file once and gets both. */
export function releaseNotes(changelog, version) {
  return section(changelog, `v${version}`);
}

/* ------------------------------------------------------------------- CLI */

/*
 * `node release.js <tag>` — exits non-zero with every problem listed, or
 * prints the release notes to stdout. The workflow captures stdout as the
 * release body, so nothing else may be written there.
 */
function main(argv) {
  const tag = argv[0];
  if (!tag) {
    console.error('usage: node release.js <tag>        e.g. node release.js v2.1.0');
    return 2;
  }
  const version = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
  const changelog = readFileSync(path.join(HERE, 'CHANGELOG.md'), 'utf8');

  const problems = releaseProblems(tag, { version, changelog });
  if (problems.length) {
    console.error(`\n  ${tag} is not ready to release:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    return 1;
  }

  process.stdout.write(`${releaseNotes(changelog, tagVersion(tag))}\n`);
  return 0;
}

/* Importable without running: the unit tests import the functions above, and a
   module that acts on import cannot be tested. */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
