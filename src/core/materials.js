/*
 * MATERIAL DATABASE — typical shrinkage, recommended wall ranges, suggested
 * draft. Values from standard moulder reference data.
 *
 * Field notes:
 *   ltMax     typical spiral-flow L/T ratio (Malloy §2.2.3)
 *   coolK     cooling-time coefficient k in tc = k × s²  (s = half-wall, mm)
 *   stripPct  max strippable undercut as % of part OD, for soft materials
 *   meltC     typical injection melt temperature (°C)
 *   hdtC      heat deflection temperature at 0.45 MPa (°C). Reported by the
 *             two-shot substrate-softening advisory, and deliberately not
 *             scored by it: HDT is a sustained-load deflection test, and a
 *             few seconds of contact with a hot melt against a cold mould is
 *             not that. Vicat softening point (ISO 306) is the property that
 *             would carry a verdict; it is not in this table. Do not restore
 *             a melt-versus-HDT threshold without adding Vicat first.
 *   density   g/cm³
 */

export const MATERIALS = {
  abs:    { name:"ABS",           shrinkLo:0.4, shrinkHi:0.7, wallLo:1.2, wallHi:3.5,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:180, coolK:1.7, stripPct:0, meltC:240, hdtC:98,  density:1.05, crystalline:false, optical:false },
  pp:     { name:"Polypropylene", shrinkLo:1.0, shrinkHi:2.5, wallLo:0.8, wallHi:3.8,  draftMin:1.0, warpRisk:"high",   flow:"high",   ltMax:300, coolK:1.0, stripPct:2, meltC:220, hdtC:60,  density:0.91, crystalline:true,  optical:false },
  pc:     { name:"Polycarbonate", shrinkLo:0.5, shrinkHi:0.7, wallLo:1.0, wallHi:3.8,  draftMin:0.5, warpRisk:"low",    flow:"low",    ltMax:120, coolK:2.2, stripPct:0, meltC:300, hdtC:135, density:1.20, crystalline:false, optical:false },
  pa6:    { name:"Nylon 6",       shrinkLo:0.7, shrinkHi:1.5, wallLo:0.8, wallHi:3.0,  draftMin:0.5, warpRisk:"medium", flow:"high",   ltMax:250, coolK:1.5, stripPct:0, meltC:250, hdtC:65,  density:1.14, crystalline:true,  optical:false },
  pa66gf: { name:"PA66-GF30",     shrinkLo:0.2, shrinkHi:0.8, wallLo:0.8, wallHi:3.5,  draftMin:0.5, warpRisk:"high",   flow:"medium", ltMax:150, coolK:1.5, stripPct:0, meltC:285, hdtC:255, density:1.38, crystalline:true,  optical:false },
  pom:    { name:"Acetal (POM)",  shrinkLo:1.8, shrinkHi:2.5, wallLo:0.8, wallHi:3.0,  draftMin:1.0, warpRisk:"medium", flow:"medium", ltMax:200, coolK:1.4, stripPct:0, meltC:205, hdtC:100, density:1.42, crystalline:true,  optical:false },
  hdpe:   { name:"HDPE",          shrinkLo:1.5, shrinkHi:3.0, wallLo:0.9, wallHi:5.4,  draftMin:1.0, warpRisk:"high",   flow:"high",   ltMax:280, coolK:1.1, stripPct:2, meltC:220, hdtC:50,  density:0.95, crystalline:true,  optical:false },
  pe:     { name:"PE",            shrinkLo:1.5, shrinkHi:3.0, wallLo:0.9, wallHi:5.4,  draftMin:1.0, warpRisk:"high",   flow:"high",   ltMax:280, coolK:1.1, stripPct:5, meltC:200, hdtC:45,  density:0.93, crystalline:true,  optical:false },
  ps:     { name:"Polystyrene",   shrinkLo:0.4, shrinkHi:0.7, wallLo:0.9, wallHi:3.8,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:250, coolK:1.5, stripPct:0, meltC:220, hdtC:75,  density:1.05, crystalline:false, optical:false },
  pbt:    { name:"PBT",           shrinkLo:1.5, shrinkHi:2.5, wallLo:2.03, wallHi:6.35, draftMin:0.5, warpRisk:"medium", flow:"medium", ltMax:180, coolK:1.5, stripPct:0, meltC:250, hdtC:155, density:1.31, crystalline:true,  optical:false },
  petg:   { name:"PETG",          shrinkLo:0.2, shrinkHi:0.5, wallLo:1.0, wallHi:3.5,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:160, coolK:1.7, stripPct:0, meltC:240, hdtC:70,  density:1.27, crystalline:false, optical:false },
  pmma:   { name:"Acrylic",       shrinkLo:0.2, shrinkHi:0.8, wallLo:1.5, wallHi:5.0,  draftMin:1.0, warpRisk:"low",    flow:"low",    ltMax:120, coolK:2.0, stripPct:0, meltC:230, hdtC:95,  density:1.19, crystalline:false, optical:false },
  tpu:    { name:"TPU",           shrinkLo:1.0, shrinkHi:2.0, wallLo:0.64, wallHi:3.18, draftMin:2.0, warpRisk:"medium", flow:"medium", ltMax:140, coolK:1.6, stripPct:8, meltC:200, hdtC:55,  density:1.21, crystalline:false, optical:false },
  asa:    { name:"ASA",           shrinkLo:0.4, shrinkHi:0.7, wallLo:1.2, wallHi:3.5,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:150, coolK:1.8, stripPct:0, meltC:245, hdtC:95,  density:1.07, crystalline:false, optical:false },

  /* Natural / unpigmented ASA — same polymer, diffuse translucent white,
     transparent to both IR and visible. Kept as its own entry because the
     optical flags drive the window checks. */
  asa_n:  { name:"ASA natural",   shrinkLo:0.4, shrinkHi:0.7, wallLo:1.0, wallHi:2.0,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:150, coolK:1.8, stripPct:0, meltC:245, hdtC:95,  density:1.07, crystalline:false, optical:true, irTransparent:true, uvStable:true,
            optNote:"Natural unpigmented ASA. Diffuse translucent white. IR transparent 850-940nm. No TiO2 or carbon black. Same-polymer fusion weld with ASA/PC-ASA." },

  pcasa:  { name:"PC/ASA",        shrinkLo:0.4, shrinkHi:0.7, wallLo:1.0, wallHi:3.5,  draftMin:0.5, warpRisk:"low",    flow:"medium", ltMax:140, coolK:1.9, stripPct:0, meltC:255, hdtC:110, density:1.13, crystalline:false, optical:false },
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
