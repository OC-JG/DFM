/*
 * MATERIAL DATABASE — typical shrinkage, recommended wall ranges, suggested
 * draft. Values from standard moulder reference data.
 *
 * Field notes:
 *   ltMax     typical spiral-flow L/T ratio (Malloy §2.2.3)
 *   coolK     cooling-time coefficient k in tc = k × s², where s is the
 *             FULL wall in mm — not the half-wall, which is the same physics
 *             written with a factor of four in it. This said half-wall and was
 *             wrong; it blocked cycle time for as long as nobody could say
 *             which was meant. Re-derived rather than asked: rearranged, each
 *             coefficient implies a thermal diffusivity, and the full-wall
 *             reading puts all sixteen inside the measured range for a
 *             thermoplastic while the half-wall reading puts every one of them
 *             three to seven times below any polymer that exists. Working, and
 *             what it does *not* settle, in docs/coolk.md; asserted in
 *             test/unit.mjs so it cannot drift back.
 *   stripPct  max strippable undercut as % of part OD, for soft materials
 *   meltC     typical injection melt temperature (°C)
 *   hdtC      heat deflection temperature at 0.45 MPa (°C). Reported by the
 *             two-shot substrate-softening check for context, and still not
 *             what that check scores on: HDT is a sustained-load deflection
 *             test, and a few seconds of contact with a hot melt against a
 *             cold mould is not that. Treat this column as indicative only —
 *             the published figures it was built from are not consistent
 *             about which load they were measured at, and two entries look
 *             like HDT/A (1.8 MPa) rather than the 0.45 MPa this claims.
 *             Nothing scores on it, which is why that has not been chased.
 *   vicatC    Vicat softening temperature, VST/B/50 (ISO 306): a 50 N needle,
 *             50 K/h, 1 mm penetration. This is what `ts_thermal` scores on,
 *             and the reason it can score at all — HDT could not answer the
 *             question being asked of it, and Vicat is nearer to what a hot
 *             melt front does to a cold substrate surface.
 *
 *             Provenance, stated plainly because the check's credibility
 *             rests on it: these are class-typical values from standard
 *             reference data, at the conservative (low) end of each class's
 *             published range. They are NOT taken from any specific grade's
 *             datasheet, and they cannot be — a row called "ABS" covers
 *             hundreds of grades whose VST spreads over tens of degrees.
 *             That is a deliberate decision about what this tool is for:
 *             in-house DFM screening to avoid an external DFM loop, not a
 *             contractual gate. Every other column here — shrinkage, wall
 *             range, draft, ltMax, coolK — is class-typical on the same
 *             footing, so this is the table's existing standard rather than a
 *             relaxation of it.
 *
 *             What that provenance buys, and what it does not: the check is
 *             built so that no band boundary is an invented margin. Each one
 *             compares two tabulated properties directly — melt against this
 *             softening point, and melt against the substrate's own melt — so
 *             a value being class-typical shifts which side of a boundary a
 *             pair lands on, and never invents the boundary. The earlier
 *             melt-versus-HDT rule failed the other way round: it added a
 *             120 °C fudge margin to a property that could not answer the
 *             question. If a specific grade matters, put its own VST in and
 *             the check follows it.
 *
 *             `ts_thermal`'s weight is locked to this column's presence in
 *             both directions by a test, so the data and the scoring cannot
 *             drift apart: remove these values and the scored check fails,
 *             unscore the check and the values fail.
 *   density   g/cm³
 */

export const MATERIALS = {
  abs:    { name:"ABS",           shrinkLo:0.4, shrinkHi:0.7, wallLo:1.2, wallHi:3.5,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:180, coolK:1.7, stripPct:0, meltC:240, hdtC:98,  vicatC:95,  density:1.05, crystalline:false, optical:false },
  pp:     { name:"Polypropylene", shrinkLo:1.0, shrinkHi:2.5, wallLo:0.8, wallHi:3.8,  draftMin:1.0, warpRisk:"high",   flow:"high",   ltMax:300, coolK:1.0, stripPct:2, meltC:220, hdtC:60,  vicatC:85,  density:0.91, crystalline:true,  optical:false },
  pc:     { name:"Polycarbonate", shrinkLo:0.5, shrinkHi:0.7, wallLo:1.0, wallHi:3.8,  draftMin:0.5, warpRisk:"low",    flow:"low",    ltMax:120, coolK:2.2, stripPct:0, meltC:300, hdtC:135, vicatC:140, density:1.20, crystalline:false, optical:false },
  pa6:    { name:"Nylon 6",       shrinkLo:0.7, shrinkHi:1.5, wallLo:0.8, wallHi:3.0,  draftMin:0.5, warpRisk:"medium", flow:"high",   ltMax:250, coolK:1.5, stripPct:0, meltC:250, hdtC:65,  vicatC:180, density:1.14, crystalline:true,  optical:false },
  pa66gf: { name:"PA66-GF30",     shrinkLo:0.2, shrinkHi:0.8, wallLo:0.8, wallHi:3.5,  draftMin:0.5, warpRisk:"high",   flow:"medium", ltMax:150, coolK:1.5, stripPct:0, meltC:285, hdtC:255, vicatC:240, density:1.38, crystalline:true,  optical:false },
  pom:    { name:"Acetal (POM)",  shrinkLo:1.8, shrinkHi:2.5, wallLo:0.8, wallHi:3.0,  draftMin:1.0, warpRisk:"medium", flow:"medium", ltMax:200, coolK:1.4, stripPct:0, meltC:205, hdtC:100, vicatC:150, density:1.42, crystalline:true,  optical:false },
  hdpe:   { name:"HDPE",          shrinkLo:1.5, shrinkHi:3.0, wallLo:0.9, wallHi:5.4,  draftMin:1.0, warpRisk:"high",   flow:"high",   ltMax:280, coolK:1.1, stripPct:2, meltC:220, hdtC:50,  vicatC:70,  density:0.95, crystalline:true,  optical:false },
  pe:     { name:"PE",            shrinkLo:1.5, shrinkHi:3.0, wallLo:0.9, wallHi:5.4,  draftMin:1.0, warpRisk:"high",   flow:"high",   ltMax:280, coolK:1.1, stripPct:5, meltC:200, hdtC:45,  vicatC:45,  density:0.93, crystalline:true,  optical:false },
  ps:     { name:"Polystyrene",   shrinkLo:0.4, shrinkHi:0.7, wallLo:0.9, wallHi:3.8,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:250, coolK:1.5, stripPct:0, meltC:220, hdtC:75,  vicatC:90,  density:1.05, crystalline:false, optical:false },
  pbt:    { name:"PBT",           shrinkLo:1.5, shrinkHi:2.5, wallLo:2.03, wallHi:6.35, draftMin:0.5, warpRisk:"medium", flow:"medium", ltMax:180, coolK:1.5, stripPct:0, meltC:250, hdtC:155, vicatC:170, density:1.31, crystalline:true,  optical:false },
  petg:   { name:"PETG",          shrinkLo:0.2, shrinkHi:0.5, wallLo:1.0, wallHi:3.5,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:160, coolK:1.7, stripPct:0, meltC:240, hdtC:70,  vicatC:75,  density:1.27, crystalline:false, optical:false },
  pmma:   { name:"Acrylic",       shrinkLo:0.2, shrinkHi:0.8, wallLo:1.5, wallHi:5.0,  draftMin:1.0, warpRisk:"low",    flow:"low",    ltMax:120, coolK:2.0, stripPct:0, meltC:230, hdtC:95,  vicatC:100, density:1.19, crystalline:false, optical:false },
  tpu:    { name:"TPU",           shrinkLo:1.0, shrinkHi:2.0, wallLo:0.64, wallHi:3.18, draftMin:2.0, warpRisk:"medium", flow:"medium", ltMax:140, coolK:1.6, stripPct:8, meltC:200, hdtC:55,  vicatC:60,  density:1.21, crystalline:false, optical:false },
  asa:    { name:"ASA",           shrinkLo:0.4, shrinkHi:0.7, wallLo:1.2, wallHi:3.5,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:150, coolK:1.8, stripPct:0, meltC:245, hdtC:95,  vicatC:95,  density:1.07, crystalline:false, optical:false },

  /* Natural / unpigmented ASA — same polymer, diffuse translucent white,
     transparent to both IR and visible. Kept as its own entry because the
     optical flags drive the window checks. */
  asa_n:  { name:"ASA natural",   shrinkLo:0.4, shrinkHi:0.7, wallLo:1.0, wallHi:2.0,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:150, coolK:1.8, stripPct:0, meltC:245, hdtC:95,  vicatC:95,  density:1.07, crystalline:false, optical:true, irTransparent:true, uvStable:true,
            optNote:"Natural unpigmented ASA. Diffuse translucent white. IR transparent 850-940nm. No TiO2 or carbon black. Same-polymer fusion weld with ASA/PC-ASA." },

  pcasa:  { name:"PC/ASA",        shrinkLo:0.4, shrinkHi:0.7, wallLo:1.0, wallHi:3.5,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:140, coolK:1.9, stripPct:0, meltC:255, hdtC:110, vicatC:110, density:1.13, crystalline:false, optical:false },
};

/* Display order for the material dropdowns. */
export const MATERIAL_ORDER = [
  'abs', 'pp', 'pc', 'pa6', 'pa66gf', 'pom', 'hdpe', 'pe',
  'ps', 'pbt', 'petg', 'pmma', 'tpu', 'asa', 'asa_n', 'pcasa',
];

/* Rigidity ranking, used by the two-shot shot-order check. Rigid materials
   are conventionally shot first as the substrate. */
export const MATERIAL_RIGIDITY = {
  pc:5, pa66gf:5, pbt:4, pom:4, pa6:4, pcasa:4,
  abs:3, asa:3, asa_n:3, pmma:3, petg:3, ps:3,
  hdpe:2, pp:2, pe:2, tpu:1,
};

/*
 * Classify a material's compatibility with FPC overmoulding by melt
 * temperature. Above ~270 °C, standard Kapton/adhesive ratings stop being
 * survivable for the contact time involved.
 */
export function fpcCompatibility(material) {
  const t = material.meltC;
  if (t <= 220) return 'safe';
  if (t <= 250) return 'caution';
  if (t <= 270) return 'risk';
  return 'unsafe';
}
