/*
 * Shot weight, clamp force and machine size.
 *
 * The material table has carried a density per grade since the rebuild and
 * nothing has ever read it. Which is a shame, because volume is already
 * measured and projected area is cheap to measure, and between them they
 * answer the questions someone actually has in front of a quotation: how much
 * material does this part consume, and what size machine does it need. A
 * manufacturability index of 77 does not tell anyone whether to make the part.
 *
 * Everything here is arithmetic on measured geometry and tabulated material
 * data, with one process assumption — cavity pressure — that is stated rather
 * than hidden. Nothing here is a simulation and none of it replaces a
 * moulder's quotation; the point is to be in the right order of magnitude
 * early, when the geometry can still change cheaply.
 */

/*
 * Not here: cooling time, and therefore cycle time.
 *
 * The material table carries a `coolK` per grade, documented as the coefficient
 * in tc = k · s² with s the half-wall. Under that convention a 2 mm ABS wall
 * cools in 1.7 s, which is the theoretical floor — it is roughly what the
 * one-dimensional conduction solution gives for the centreline reaching
 * ejection temperature, and it is not a number any moulder would quote.
 *
 * Read as a full-wall coefficient the same table gives 6.8 s for ABS, 4.0 s for
 * PP and 8.8 s for PC, which sit inside the practical bands and — more telling
 * — reproduce the right ordering. The analytical reading does not: run through
 * the conduction solution with real diffusivities, PC comes out cooling *faster*
 * than ABS, where the table has it 30% slower. So the coefficients look
 * empirical and full-wall, and the comment describing them looks wrong.
 *
 * "Looks wrong" is not enough to ship a cycle time on. The two readings differ
 * by 4×, someone will quote from whichever appears, and the person who curated
 * those coefficients can settle it in one sentence. Until then the field stays
 * unused and this module reports only what it can stand behind.
 */

/*
 * Cavity pressure bands, in MPa, by the material's flow class.
 *
 * Clamp force is melt pressure acting over the projected area of the cavity.
 * The pressure that actually develops depends on the material, the wall, the
 * flow length and how hard the moulder has to pack — so it is a band, not a
 * number, and a stiff material needs more of it to fill the same part.
 *
 * These are the conventional ranges: roughly 2–5 tonnes per square inch of
 * projected area, which is where the old shop-floor rule of thumb comes from.
 */
export const CAVITY_PRESSURE_MPA = {
  high:   { lo: 20, hi: 35 },
  medium: { lo: 30, hi: 45 },
  low:    { lo: 40, hi: 60 },
};

/* Force in newtons per tonne-force. */
const N_PER_TONNE = 9806.65;

/* Machines come in standard clamp sizes; quoting an exact calculated figure
   implies a precision the cavity-pressure band does not support. */
export const MACHINE_TONNAGES = [
  20, 30, 50, 80, 100, 120, 150, 180, 220, 250, 300, 350, 400, 450, 500,
  650, 800, 1000, 1300, 1600, 2000, 2500, 3200,
];

/*
 * Estimate what it takes to mould this part.
 *
 *   volume         mm³, from the mesh. Pass null when the mesh is not a closed
 *                  solid — an enclosed volume is undefined then, and a shot
 *                  weight derived from it would be a fabrication.
 *   projectedArea  mm², the part's shadow along the pull axis.
 *   runnerPct      allowance for sprue and runners, as a percentage of part
 *                  mass. Cold runners typically add 10–30%; a hot runner adds
 *                  nothing. Defaults to 0 so the figure is the part alone
 *                  unless someone says otherwise.
 */
export function estimateShot({ material, volume, projectedArea, runnerPct = 0 }) {
  const out = {
    volumeMm3: volume,
    volumeCm3: volume != null ? volume / 1000 : null,
    massG: null,
    runnerPct,
    shotMassG: null,
    projectedAreaMm2: projectedArea > 0 ? projectedArea : null,
    projectedAreaCm2: projectedArea > 0 ? projectedArea / 100 : null,
    cavityPressureMPa: null,
    clampTonnes: null,
    machineTonnes: null,
    notes: [],
  };

  if (volume != null && volume > 0 && material.density > 0) {
    /* mm³ × g/cm³ ÷ 1000 = g. */
    out.massG = (volume / 1000) * material.density;
    out.shotMassG = out.massG * (1 + runnerPct / 100);
  } else if (volume == null) {
    out.notes.push('Shot weight needs an enclosed volume, which this mesh does not have. Close the surface and re-run.');
  }

  if (out.projectedAreaMm2) {
    const band = CAVITY_PRESSURE_MPA[material.flow] || CAVITY_PRESSURE_MPA.medium;
    out.cavityPressureMPa = { ...band, basis: `${material.flow} flow` };
    out.clampTonnes = {
      lo: (out.projectedAreaMm2 * band.lo) / N_PER_TONNE,
      hi: (out.projectedAreaMm2 * band.hi) / N_PER_TONNE,
    };
    /* Specify against the top of the band, then the usual margin on top. */
    out.machineTonnes = nextMachineSize(out.clampTonnes.hi * 1.15);
    out.notes.push(`Clamp force is the ${band.lo}–${band.hi} MPa cavity pressure typical of a ${material.flow}-flow material acting over ${(out.projectedAreaMm2 / 100).toFixed(1)} cm² of projected area. Specify a machine at least 10–20% above the top of that range.`);
    out.notes.push('Projected area is measured along the current pull axis. Change the pull direction and this changes with it.');
  } else {
    out.notes.push('Clamp force needs a projected area, which needs a loaded mesh and a pull direction.');
  }

  return out;
}

/* Smallest standard clamp size at or above the requirement. */
export function nextMachineSize(tonnes) {
  for (const t of MACHINE_TONNAGES) if (t >= tonnes) return t;
  return null;
}
