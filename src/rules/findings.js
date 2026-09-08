/*
 * Identifiers a finding can be quoted by.
 *
 * The tool's output does not end here: it goes to a factory, comes back as a
 * DFM report six weeks later, and gets argued about point by point. "We accept
 * point 4, reject point 7" has to mean something when it arrives, and until
 * now it did not — the PDF numbered nothing, so a point was identified by its
 * position in a list whose length depends on which checks ran.
 *
 * Two kinds of finding, and they need different treatment.
 *
 * **One per check.** `wall`, `draft`, `fpc` — a run emits at most one of each,
 * so the check key already identifies it uniquely and permanently. Nothing
 * needed inventing here; what was missing was printing it. A parallel
 * identifier derived from the key would only be a second thing to keep in
 * step with the first, so the key *is* the reference, upper-cased where it is
 * shown so it reads as a code rather than as a field name.
 *
 * **One per feature.** An undercut region, a wall transition — these repeat,
 * and they are what actually gets argued about individually ("the undercut on
 * the left boss is fine, we are not paying for a lifter"). They had no
 * identity at all: they were ordered by area, so adding a rib on the far side
 * of the part could renumber every one of them.
 *
 * ── What a feature id is derived from ────────────────────────────────────
 *
 * Its location, quantised, and its kind. Not its index, which moves; not the
 * geometry as a whole, which is the point — an id that changed with the part
 * would be useless for the job it exists for, which is reconciling a response
 * written against last month's revision.
 *
 * The quantisation grid is what decides when two runs are talking about the
 * same feature, and it is a fixed 2 mm rather than a fraction of the part.
 * Fixed, because a factory's response is about a physical feature at a
 * physical place: a boss that moved 0.3 mm in a revision is the same boss and
 * keeps its id, and one that moved 20 mm is somewhere else and should not. A
 * grid proportional to the part would make the same 0.3 mm move survive on a
 * housing and not on a connector, which is not a distinction anybody asked
 * for.
 *
 * The consequence is stated rather than hidden: **a feature that moves more
 * than the grid gets a new id.** That is intended — it is at a different place
 * — but it means an id is evidence that two findings are the same feature, not
 * proof, and a response reconciled by id still wants eyes on it where a
 * revision moved things.
 *
 * Cylindrical features — bores, bosses, fillets — deliberately get none. They
 * are reported as a summary inside `corner_radii` ("smallest R0.40, bores Ø6.0
 * and Ø3.0") rather than as separate findings, so there is nothing to quote
 * individually yet. When one of them becomes its own finding it should come
 * here for an id.
 */

/* Millimetres. See the note above on why this is fixed rather than relative. */
export const FEATURE_GRID_MM = 2;

/*
 * FNV-1a, 32-bit, rendered base36.
 *
 * A hash rather than the coordinates themselves because the id has to be
 * short enough to write in an email and read back over a phone; the card and
 * the export both print the centroid beside it, so nothing is lost by the id
 * being opaque. FNV-1a rather than anything stronger because this is a
 * label, not a security boundary: it needs to be stable across machines and
 * across JavaScript engines, which arithmetic on integers is and floating
 * point is not.
 */
function hash36(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    /* Multiply by the FNV prime in parts that stay inside 32 bits. */
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(-6).toUpperCase();
}

/* Quantise a coordinate onto the grid. No guard against negative zero is
   needed: `Math.round(-0.4)` is -0, and JavaScript stringifies -0 as "0", so
   it hashes the same as 0. Stated because it looks like it needs one. */
function cell(v) {
  return Math.round(v / FEATURE_GRID_MM);
}

/*
 * A stable reference for a located feature.
 *
 * `kind` is a short prefix, so a reader can tell a slide from a lifter without
 * looking it up — and it is the prefix alone that discriminates them. It is
 * deliberately not mixed into the hash as well: that would make the two
 * differ twice over, which reads as two facts to check when there is one.
 * A slide and a lifter at the same place share a suffix, which is true of
 * them.
 */
export function featureId(kind, centroid) {
  if (!centroid || centroid.length < 3) return `${kind}-?`;
  return `${kind}-${hash36(`${cell(centroid[0])}|${cell(centroid[1])}|${cell(centroid[2])}`)}`;
}

/* How a check is quoted. The key, upper-cased, and nothing derived. */
export function checkRef(key) {
  return String(key).toUpperCase().replace(/_/g, '-');
}

/* The prefix each kind of located feature carries. */
export const FEATURE_KINDS = {
  slide: 'UCS',
  lifter: 'UCL',
  transition: 'WT',
};
