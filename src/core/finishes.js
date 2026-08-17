/*
 * Surface finish standards (SPI) + texture depth, and which finishes each
 * material can actually hold.
 */

/* Per Malloy §2.6.3, textured cavities need extra draft in proportion to
   texture depth — see effectiveMinDraft below. */
export const SURFACE_FINISHES = {
  'spi-a1':     { name:'SPI A-1 (mirror #3 diamond)',       textureDepth:0     },
  'spi-a2':     { name:'SPI A-2 (high polish #6 diamond)',  textureDepth:0     },
  'spi-a3':     { name:'SPI A-3 (polish #15 diamond)',      textureDepth:0.002 },
  'spi-b1':     { name:'SPI B-1 (600-grit paper)',          textureDepth:0.003 },
  'spi-b':      { name:'SPI B-2 (400-grit paper)',          textureDepth:0.005 },
  'spi-b3':     { name:'SPI B-3 (320-grit paper)',          textureDepth:0.007 },
  'spi-c1':     { name:'SPI C-1 (600-grit stone)',          textureDepth:0.010 },
  'spi-c':      { name:'SPI C-2 (400-grit stone)',          textureDepth:0.012 },
  'spi-c3':     { name:'SPI C-3 (320-grit stone)',          textureDepth:0.015 },
  'spi-d':      { name:'SPI D-1 (dry blast glass bead)',    textureDepth:0.020 },
  'spi-d2':     { name:'SPI D-2 (dry blast #240 oxide)',    textureDepth:0.025 },
  'spi-d3':     { name:'SPI D-3 (dry blast #24 oxide)',     textureDepth:0.040 },
  'tex-fine':   { name:'Texture fine (VDI 18)',             textureDepth:0.025 },
  'tex-med':    { name:'Texture medium (VDI 27)',           textureDepth:0.050 },
  'tex-coarse': { name:'Texture coarse (VDI 36)',           textureDepth:0.075 },
  'edm-heavy':  { name:'EDM heavy',                         textureDepth:0.100 },
};

/* Grouped for the <optgroup> layout of the finish dropdown. */
export const FINISH_GROUPS = [
  { label:'A — Diamond Polish', keys:['spi-a1','spi-a2','spi-a3'],
    labels:['A-1 Mirror (#3 diamond)','A-2 High polish (#6)','A-3 Polish (#15 diamond)'] },
  { label:'B — Paper Polish',   keys:['spi-b1','spi-b','spi-b3'],
    labels:['B-1 600-grit paper','B-2 400-grit paper','B-3 320-grit paper'] },
  { label:'C — Stone Polish',   keys:['spi-c1','spi-c','spi-c3'],
    labels:['C-1 600-grit stone','C-2 400-grit stone','C-3 320-grit stone'] },
  { label:'D — Blast / Matte',  keys:['spi-d','spi-d2','spi-d3'],
    labels:['D-1 Glass bead blast','D-2 #240 oxide blast','D-3 #24 oxide blast'] },
  { label:'Texture / EDM',      keys:['tex-fine','tex-med','tex-coarse','edm-heavy'],
    labels:['Texture fine (VDI 18)','Texture medium (VDI 27)','Texture coarse (VDI 36)','EDM heavy'] },
];

/*
 * Surface finish achievability by material. Notably TPU/PP/PE cannot reach
 * A-grade mirror finishes, being semi-crystalline or elastomeric.
 * Source: Xometry design guide + industry practice.
 *
 * C, D and texture grades are achievable on every material, so they are
 * absent here and finishMaterialCheck returns 'ok' for them by default.
 */
export const FINISH_MATERIAL_COMPAT = {
  'spi-a1': { ok:['pc','pmma'],                                caution:['abs','ps','petg','asa','pcasa'], no:['pp','pe','hdpe','pa6','pa66gf','pom','tpu','pbt','asa_n'] },
  'spi-a2': { ok:['pc','pmma','abs','pcasa'],                  caution:['ps','petg','asa','pbt'],         no:['pp','pe','hdpe','pa6','pa66gf','pom','tpu','asa_n'] },
  'spi-a3': { ok:['pc','pmma','abs','ps','petg','asa','pcasa','asa_n'], caution:['pbt','pa6'],            no:['pp','pe','hdpe','pa66gf','pom','tpu'] },
  'spi-b1': { ok:['pc','pmma','abs','ps','petg','asa','pcasa','asa_n','pa6','pbt'], caution:['pp','hdpe','pa66gf'], no:['pe','pom','tpu'] },
  'spi-b':  { ok:['pc','pmma','abs','ps','petg','asa','pcasa','asa_n','pa6','pbt','pp','hdpe'], caution:['pa66gf','pom'], no:['pe','tpu'] },
  'spi-b3': { ok:['pc','pmma','abs','ps','petg','asa','pcasa','asa_n','pa6','pbt','pp','hdpe','pa66gf','pom'], caution:['tpu'], no:['pe'] },
};

export function finishMaterialCheck(finishKey, matKey) {
  const entry = FINISH_MATERIAL_COMPAT[finishKey];
  if (!entry) return 'ok';
  if (entry.no && entry.no.includes(matKey)) return 'no';
  if (entry.caution && entry.caution.includes(matKey)) return 'caution';
  return 'ok';
}

/*
 * Minimum draft including the texture allowance.
 * Malloy gives 1°/0.025 mm for SPI/VDI textures; Mold-Tech recommends
 * 1.5°/0.025 mm. We take the conservative 1.5° across all texture finishes.
 */
export function effectiveMinDraft(material, finishKey) {
  const f = SURFACE_FINISHES[finishKey] || SURFACE_FINISHES['spi-a2'];
  return material.draftMin + f.textureDepth * (1.5 / 0.025);
}
