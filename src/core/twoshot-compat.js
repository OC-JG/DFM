/*
 * Material adhesion compatibility matrix for overmoulding.
 *
 *   chemical      bonds without surface treatment (weld-line strength
 *                 typically 50–80% of the base material)
 *   mechanical    requires surface texture / undercuts for retention
 *   primer        can bond, but needs an adhesion primer or plasma treatment
 *   incompatible  will not bond; delamination likely
 *
 * Keyed 'shot1:shot2'; getTwoShotCompat looks up both orderings.
 * Source: typical overmoulding practice, Dow / BASF / Covestro data sheets.
 */
export const TWO_SHOT_COMPAT = {
  // ── ABS substrate ──────────────────────────────────────────────────────
  'abs:tpu':   { adhesion:'chemical',     notes:'Excellent. Classic over-mould pair. TPU melts at 200°C, well below ABS HDT of 98°C.' },
  'abs:pc':    { adhesion:'chemical',     notes:'Good. PC/ABS alloys confirm compatibility. PC melt (300°C) is above ABS HDT — keep barrels at low end and minimise contact time.' },
  'abs:petg':  { adhesion:'chemical',     notes:'Good. Similar styrenic chemistry gives strong interface bond.' },
  'abs:pmma':  { adhesion:'mechanical',   notes:'Marginal chemical bond. Add undercut features to substrate for mechanical retention.' },
  'abs:ps':    { adhesion:'chemical',     notes:'Good bond — both styrenic.' },
  'abs:asa':   { adhesion:'chemical',     notes:'Excellent. Near-identical chemistry, commonly used for colour-over-colour two-shot.' },
  'abs:pp':    { adhesion:'incompatible', notes:'PP will not bond to ABS. Requires full mechanical encapsulation with through-holes and aggressive undercuts, or tie-layer adhesive.' },
  'abs:pe':    { adhesion:'incompatible', notes:'No adhesion. Mechanical retention only.' },
  'abs:tpe':   { adhesion:'chemical',     notes:'Good — most TPE grades bond well to ABS.' },

  // ── PC substrate ───────────────────────────────────────────────────────
  'pc:tpu':    { adhesion:'chemical',     notes:'Good. TPU bonds to PC. TPU melt (200°C) safely below PC HDT (135°C).' },
  'pc:abs':    { adhesion:'chemical',     notes:'Good. PC/ABS alloy chemistry.' },
  'pc:petg':   { adhesion:'chemical',     notes:'Good chemical affinity.' },
  'pc:pmma':   { adhesion:'mechanical',   notes:'Marginal. Use mechanical anchors.' },
  'pc:pp':     { adhesion:'incompatible', notes:'No adhesion. Avoid.' },

  // ── PP substrate ───────────────────────────────────────────────────────
  'pp:tpu':    { adhesion:'primer',       notes:'TPU can bond to PP with adhesion primer or surface plasma treatment. Without treatment, mechanical retention only.' },
  'pp:pe':     { adhesion:'chemical',     notes:'Good. Both polyolefins — weld-line bond typically 40–60% of PP strength.' },
  'pp:hdpe':   { adhesion:'chemical',     notes:'Good polyolefin compatibility.' },

  // ── TPU substrate (uncommon but valid) ─────────────────────────────────
  'tpu:abs':   { adhesion:'chemical',     notes:'Good. ABS melt (240°C) is above TPU HDT — substrate will soften. Minimise cycle time and use low injection speed.' },
  'tpu:pp':    { adhesion:'primer',       notes:'Primer or treatment required.' },

  // ── PA substrate ───────────────────────────────────────────────────────
  'pa6:tpu':   { adhesion:'chemical',     notes:'Good chemical bond — polyurethane to polyamide is a known-good pair.' },
  'pa6:pp':    { adhesion:'incompatible', notes:'No adhesion.' },
  'pa66gf:tpu':{ adhesion:'chemical',     notes:'Good. Common in automotive sealing applications.' },

  // ── POM substrate ──────────────────────────────────────────────────────
  'pom:tpu':   { adhesion:'mechanical',   notes:'POM has very low surface energy — almost nothing bonds to it chemically. Design mechanical interlocks.' },
  'pom:pp':    { adhesion:'incompatible', notes:'No adhesion.' },

  // ── PC/ASA substrate — amorphous PC/styrenic blend, mirrors PC/ABS ──────
  'pcasa:tpu':  { adhesion:'chemical',     notes:'Good. TPU bonds well to PC/ASA, same mechanism as PC/ABS. TPU melt (200°C) is above PC/ASA HDT (110°C) — use fast injection and short cycle.' },
  'pcasa:abs':  { adhesion:'chemical',     notes:'Good. Styrenic/PC chemistry.' },
  'pcasa:asa':  { adhesion:'chemical',     notes:'Excellent. ASA phase in the substrate bonds directly to ASA overmould. Common in UV-stable colour-over-colour applications.' },
  'pcasa:pcasa':{ adhesion:'chemical',     notes:'Same material — ideal bond. Good for two-tone structural parts.' },
  'pcasa:petg': { adhesion:'chemical',     notes:'Good chemical affinity via the styrenic phase.' },
  'pcasa:pmma': { adhesion:'mechanical',   notes:'Marginal bond. Add mechanical retention features.' },
  'pcasa:ps':   { adhesion:'chemical',     notes:'Good — styrenic compatibility.' },
  'pcasa:pp':   { adhesion:'incompatible', notes:'No adhesion between PC/ASA and polyolefins.' },
  'pcasa:pe':   { adhesion:'incompatible', notes:'No adhesion. Mechanical retention only.' },

  // ── ASA natural — same polymer as ASA, so a fusion weld ────────────────
  'asa_n:asa':   { adhesion:'chemical',     notes:'Same-polymer fusion weld. Natural ASA window bonded to standard ASA substrate — the strongest possible bond, effectively no interface.' },
  'asa_n:pcasa': { adhesion:'chemical',     notes:'Excellent. ASA natural bonds to PC/ASA via the ASA phase. Same-polymer fusion at the ASA-to-ASA interface. Standard combination for UV-stable IR/visible sensor windows.' },
  'asa_n:abs':   { adhesion:'chemical',     notes:'Good. Styrenic chemistry match.' },
  'asa_n:asa_n': { adhesion:'chemical',     notes:'Same material — fusion weld. Use for natural/natural two-tone or window-in-window geometry.' },
  'asa_n:tpu':   { adhesion:'chemical',     notes:'Good. TPU bonds to natural ASA as with standard ASA.' },
  'asa_n:pp':    { adhesion:'incompatible', notes:'No adhesion. Polyolefin incompatible with ASA.' },
  'asa_n:pe':    { adhesion:'incompatible', notes:'No adhesion.' },

  // ── ASA substrate — styrene-acrylate vs ABS's styrene-butadiene, so its
  //    overmould compatibility closely mirrors ABS, plus UV stability. ─────
  'asa:tpu':   { adhesion:'chemical',     notes:'Excellent. TPU bonds well to ASA, as with ABS. TPU melt (200°C) is above ASA HDT (95°C) — short contact time in two-shot makes this acceptable; minimise cycle time.' },
  'asa:pc':    { adhesion:'chemical',     notes:'Good. Shares the PC/ABS-style alloy compatibility. PC melt (300°C) far exceeds ASA HDT — run barrels low and minimise contact.' },
  'asa:petg':  { adhesion:'chemical',     notes:'Good. Styrenic chemistry gives a strong interface bond.' },
  'asa:pmma':  { adhesion:'mechanical',   notes:'Marginal chemical bond. Add undercut features for mechanical retention.' },
  'asa:ps':    { adhesion:'chemical',     notes:'Good bond — both styrenic.' },
  'asa:asa':   { adhesion:'chemical',     notes:'Excellent. Same material — ideal for colour-over-colour two-shot with full UV stability.' },
  'asa:pp':    { adhesion:'incompatible', notes:'PP will not bond to ASA. Requires full mechanical encapsulation or a tie-layer adhesive.' },
  'asa:pe':    { adhesion:'incompatible', notes:'No adhesion. Mechanical retention only.' },
  'asa:tpe':   { adhesion:'chemical',     notes:'Good — most TPE grades bond well to ASA.' },
};

export const ADHESION_LABELS = {
  chemical:     'Chemical bond',
  mechanical:   'Mechanical only',
  primer:       'Primer/treatment needed',
  incompatible: 'Incompatible',
  unknown:      'Unknown',
};

export function getTwoShotCompat(mat1key, mat2key) {
  return TWO_SHOT_COMPAT[`${mat1key}:${mat2key}`]
      || TWO_SHOT_COMPAT[`${mat2key}:${mat1key}`]
      || { adhesion:'unknown', notes:'No compatibility data for this pair. Consult material supplier data sheets and run adhesion peel tests.' };
}
