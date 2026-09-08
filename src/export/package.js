import { createZip } from './zip.js';
import { buildIdentity, buildLabel } from '../core/build-info.js';
import { checkRef } from '../rules/findings.js';

/*
 * The findings package: one archive holding the report, the record, and the
 * file that was measured.
 *
 * This is what actually gets emailed to a factory, and assembling it by hand
 * is where the wrong revision gets attached — three files pulled from three
 * places, one of them last week's export, and nobody finds out until the tool
 * arrives cut to a drawing nobody scored. The three cannot disagree if they
 * leave together.
 *
 * ── The manifest ─────────────────────────────────────────────────────────
 *
 * A plain-text file at the top of the archive, and the part that earns its
 * place rather than duplicating the JSON. It answers what a recipient asks
 * before opening anything: which part is this, what did it score, which build
 * scored it, and — the reason the package exists — is the CAD file in here
 * the one the report describes. That last one is a CRC32 per member, which
 * the ZIP has already computed, so the check costs nothing and a recipient
 * can verify it with any unzip.
 *
 * A CRC is a checksum, not a signature: it catches a truncated or swapped
 * attachment, which is the failure this is guarding against, and proves
 * nothing about who produced the file. The manifest says so, because a
 * hexadecimal number next to a filename invites being read as more than it
 * is.
 */

/* ISO 8601 to the second. The archive's own timestamps are MS-DOS format and
   carry no zone; this one does. */
function stamp(date) {
  return date.toISOString().replace(/\.\d+Z$/, 'Z');
}

function manifestText({ partName, sourceName, result, twoShot, entries, now }) {
  const id = buildIdentity();
  const lines = [
    'OnlyCat DFM — findings package',
    '===============================================================',
    '',
    `Part                ${partName || '(unnamed)'}`,
    `Generated           ${stamp(now)}`,
    `Tool                OnlyCat DFM ${buildLabel()}`,
    /* Spelled out rather than left to the version string: an export made from
       an unbuilt source tree is a legitimate thing to have and must not be
       mistaken for a release. */
    `Build               ${id.built ? `release-quality build, sources ${id.source_fingerprint}` : 'RUNNING FROM SOURCE — not a released build'}`,
    '',
  ];

  if (result) {
    lines.push(
      `Score               ${result.score} / 100 — ${result.grade.label}`,
      `Basis               ${result.totalDeduction.toFixed(1)} points deducted from a ${result.budget}-point budget`,
      `Critical findings   ${result.criticalCount}`,
      '');
  }
  if (twoShot) {
    lines.push(
      `Interface score     ${twoShot.score} / 100 — ${twoShot.grade.label}`,
      `Shots               ${twoShot.mat1.name} + ${twoShot.mat2.name}`,
      '');
  }

  lines.push(
    'Contents',
    '---------------------------------------------------------------');
  for (const e of entries) {
    lines.push(`  ${e.name.padEnd(28)} ${String(e.bytes).padStart(9)} bytes   crc32 ${e.crc32}`);
  }
  lines.push(
    '',
    'The CRC32 above is the checksum of each file as extracted. It is here',
    'to catch a truncated download or the wrong file having been swapped in;',
    'it is not a signature and says nothing about who produced the file.',
    '');

  if (sourceName) {
    lines.push(
      `The geometry in this archive — ${sourceName} — is the file the report`,
      'was measured from, not a copy fetched separately. That is the whole',
      'reason the three travel together.',
      '');
  } else {
    lines.push(
      'NO GEOMETRY IS INCLUDED. The part was loaded before this build could',
      'retain the source bytes, or arrived by a route that has none. The',
      'report and the record describe a file that is not in here — attach it',
      'yourself, and check it is the revision named above.',
      '');
  }

  if (result) {
    lines.push(
      'Findings, by the reference to quote when responding',
      '---------------------------------------------------------------');
    for (const c of result.checks) {
      const deduct = c.scoreDeduction > 0 ? `−${c.scoreDeduction.toFixed(1)}` : '  0 ';
      lines.push(`  ${checkRef(c.key).padEnd(16)} ${c.status.toUpperCase().padEnd(5)} ${deduct.padStart(6)}  ${c.name}`);
    }
    lines.push('');
  }

  lines.push(
    'Guideline-based DFM analysis. Validate critical dimensions with your',
    'moulder before cutting steel.',
    '');
  return lines.join('\n');
}

/*
 * Assemble the archive.
 *
 * `pdfBytes` and `json` are produced by the callers that already know how —
 * this does not lay out a report or build a record, it packages them. `source`
 * is `{ name, bytes }` for the geometry as it arrived, or null: a part loaded
 * from somewhere that kept no bytes still gets a package, and the manifest
 * says loudly that the CAD file is missing rather than quietly omitting it.
 */
export async function buildFindingsPackage({
  sessionId, partName, source, pdfBytes, json, result, twoShot, now = new Date(),
}) {
  const encoder = new TextEncoder();
  const entries = [];

  if (pdfBytes) entries.push({ name: 'report.pdf', bytes: pdfBytes });
  entries.push({ name: 'findings.json', bytes: encoder.encode(JSON.stringify(json, null, 2)) });
  if (source && source.bytes) {
    /* Under its own name, so the recipient recognises it and the revision in
       the filename travels with the bytes. */
    entries.push({ name: `geometry/${safeName(source.name)}`, bytes: source.bytes });
  }

  /* Sizes and CRCs first, so the manifest can quote them — including its own
     absence from that list, which is correct: a file cannot state its own
     checksum. */
  const measured = await createZip(entries, now);
  const manifest = manifestText({
    partName, sourceName: source && source.bytes ? safeName(source.name) : null,
    result, twoShot, entries: measured.entries, now,
  });

  /* Manifest at the top, where an unzip lists it first. */
  const final = await createZip(
    [{ name: 'MANIFEST.txt', bytes: encoder.encode(manifest) }, ...entries],
    now,
  );

  const base = (partName || 'part').replace(/\.[^.]+$/, '');
  return {
    blob: final.blob,
    filename: `dfm_findings_${safeName(base)}_${sessionId}.zip`,
    manifest,
    entries: final.entries,
  };
}

/*
 * A filename an archive and a filesystem will both accept.
 *
 * The directory part is dropped rather than escaped. A member called
 * "../../etc/passwd" is the classic archive escape and mangling it to
 * "_.._etc_passwd" is safe but absurd; the file's name is "passwd" and that is
 * what belongs in the archive. Same for a Windows path arriving in a name,
 * which some browsers still hand over — the last segment is the file. What is
 * left has anything but plain name characters replaced, and leading dots
 * stripped so nothing becomes a dotfile or a relative reference.
 */
export function safeName(name) {
  const segments = String(name == null ? '' : name).split(/[/\\]+/).filter(Boolean);
  const base = segments.length ? segments[segments.length - 1] : '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 80) || 'part';
}

/* Hand the archive to the browser. Separate from assembling it so a test can
   check the bytes without a DOM. */
export function downloadPackage(pkg) {
  const url = URL.createObjectURL(pkg.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = pkg.filename;
  a.click();
  /* Revoking synchronously can race the download in Firefox — same reason as
     downloadJSON in json.js. */
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
