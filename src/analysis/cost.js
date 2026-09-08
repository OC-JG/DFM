/*
 * Cycle time, piece-part cost and what drives the tool.
 *
 * These are the numbers someone actually wants in front of a quotation, and
 * they are also the numbers most likely to be quoted *from* — which is why
 * cycle time stayed out of this tool until the coefficient behind it was
 * settled (docs/coolk.md) and why nothing here produces a currency figure out
 * of thin air.
 *
 * The rule this module follows: **arithmetic on measured geometry and stated
 * inputs, never on invented data.** Resin price and machine rate are the user's
 * to supply, because a plausible-looking default would be indistinguishable
 * on screen from a real quotation and would travel further than it should. If
 * a rate is missing the cost is null and the reason says which rate is missing.
 */

/*
 * ── Cycle time ────────────────────────────────────────────────────────────
 *
 * Three steps, each a named assumption rather than one opaque multiplier, so a
 * reader can disagree with the step rather than with the answer.
 *
 * 1. The **cooling floor**, from the plate-cooling solution the material
 *    table's coolK encodes: tc = k · s², s the full wall in mm. This is the
 *    moment the centre plane first reaches ejection temperature with the mould
 *    wall held fixed and heat leaving in one dimension. It is a lower bound and
 *    is labelled as one.
 *
 * 2. **Practical cooling** runs above that floor: the mould wall is not held
 *    at a constant temperature, the wall is not uniform, and a moulder leaves
 *    margin so the part does not distort on the pins.
 *
 * 3. **The cycle** is longer again, because cooling is only part of it —
 *    conventionally 50–80% for a thermoplastic part, the rest being fill,
 *    pack, mould motion and ejection. A band, because that share genuinely
 *    varies with the part and the machine.
 *
 * Both factors are exported so a caller can print them next to the result, and
 * so a reader can see the estimate is two multiplications on a derived floor
 * rather than a simulation.
 */

/* Practical cooling against the theoretical floor. */
export const PRACTICAL_COOLING_FACTOR = 1.3;

/* Cooling's share of a whole cycle: the conventional band. */
export const COOLING_SHARE = { lo: 0.5, hi: 0.8 };

export function estimateCycle({ material, wallMm, cavities = 1 }) {
  const out = {
    wallMm: wallMm != null && wallMm > 0 ? wallMm : null,
    coolingFloorS: null,
    practicalCoolingS: null,
    cycleS: null,
    cavities,
    partsPerHour: null,
    assumptions: [],
    notes: [],
  };

  if (!out.wallMm) {
    out.notes.push('Cycle time needs a wall thickness, which needs a measured part.');
    return out;
  }
  if (!(material.coolK > 0)) {
    out.notes.push(`No cooling coefficient for ${material.name}, so no cycle time.`);
    return out;
  }

  out.coolingFloorS = material.coolK * out.wallMm * out.wallMm;
  out.practicalCoolingS = out.coolingFloorS * PRACTICAL_COOLING_FACTOR;
  out.cycleS = {
    lo: out.practicalCoolingS / COOLING_SHARE.hi,
    hi: out.practicalCoolingS / COOLING_SHARE.lo,
  };
  out.partsPerHour = {
    lo: (3600 / out.cycleS.hi) * cavities,
    hi: (3600 / out.cycleS.lo) * cavities,
  };

  out.assumptions.push(
    `Cooling floor is k·s² with k = ${material.coolK} for ${material.name} and s = ${out.wallMm.toFixed(2)} mm, the measured nominal wall. k is the full-wall coefficient — see docs/coolk.md.`,
    `Practical cooling is taken as ${PRACTICAL_COOLING_FACTOR}× that floor: the floor assumes a mould wall held at a fixed temperature and heat leaving in one dimension, and neither is true of a tool.`,
    `The cycle is practical cooling divided by cooling's share of it, taken as ${COOLING_SHARE.lo * 100}–${COOLING_SHARE.hi * 100}% — the rest is fill, pack, mould motion and ejection.`,
  );
  out.notes.push('A planning estimate, not a quotation. The floor is the only figure here that is derived rather than assumed, and it is a lower bound no tool will beat.');

  return out;
}

/*
 * ── Piece-part cost ───────────────────────────────────────────────────────
 *
 * Material plus machine time, which is the part of a piece price this tool can
 * compute from what it has measured. It is deliberately *not* a price: no
 * labour, no packaging, no overhead recovery, no margin, no secondary
 * operations. Those are the moulder's, and a figure that quietly implied
 * otherwise would be worse than no figure.
 *
 *   shotMassG    part plus its share of the runner, from estimateShot
 *   resinPerKg   the user's number. No default: an invented resin price is
 *                indistinguishable on screen from a real one.
 *   machinePerHour  likewise, for the machine estimateShot sized
 *   cavities     how many of this part per shot
 *   scrapPct     start-up and reject allowance on material
 */
export function estimatePartCost({
  shotMassG, cycleS, cavities = 1, resinPerKg = null, machinePerHour = null, scrapPct = 0,
}) {
  const out = {
    materialCost: null,
    machineCost: null,
    totalCost: null,
    cavities,
    scrapPct,
    missing: [],
    assumptions: [],
    notes: [],
  };

  if (!(shotMassG > 0)) out.missing.push('a shot weight (needs a closed mesh)');
  if (!(resinPerKg > 0)) out.missing.push('a resin price per kg');
  if (!cycleS) out.missing.push('a cycle time');
  if (!(machinePerHour > 0)) out.missing.push('a machine rate per hour');

  if (shotMassG > 0 && resinPerKg > 0) {
    out.materialCost = (shotMassG / 1000) * resinPerKg * (1 + scrapPct / 100);
    out.assumptions.push(
      `Material is ${shotMassG.toFixed(1)} g — the part plus its share of the runner — at ${resinPerKg}/kg`
      + (scrapPct ? `, plus ${scrapPct}% for scrap and start-up.` : '.'));
  }

  if (cycleS && machinePerHour > 0) {
    /* The machine is paid for by the hour and produces `cavities` parts per
       cycle, so the cost of a part is its share of the shot. */
    out.machineCost = {
      lo: (cycleS.lo / 3600) * machinePerHour / cavities,
      hi: (cycleS.hi / 3600) * machinePerHour / cavities,
    };
    out.assumptions.push(
      `Machine time is ${cycleS.lo.toFixed(1)}–${cycleS.hi.toFixed(1)} s at ${machinePerHour}/hour, shared across ${cavities} cavit${cavities === 1 ? 'y' : 'ies'}.`);
  }

  if (out.materialCost != null && out.machineCost) {
    out.totalCost = {
      lo: out.materialCost + out.machineCost.lo,
      hi: out.materialCost + out.machineCost.hi,
    };
    out.notes.push('Material and machine time only. No labour, packaging, overhead, secondary operations or margin — a moulder’s price includes all of those and will be higher.');
  } else if (out.missing.length) {
    out.notes.push(`No cost until there is ${out.missing.join(', and ')}.`);
  }

  return out;
}

/*
 * ── What drives the tool ──────────────────────────────────────────────────
 *
 * Deliberately not a currency figure. Tooling price depends on the toolmaker,
 * the steel, the country and the lead time, none of which this tool knows —
 * and a number carrying that much unknown would be quoted from anyway.
 *
 * What *is* knowable from the geometry is what makes the tool expensive, and
 * that is worth saying plainly: every slide is a moving assembly, every cavity
 * is another set of everything, a glass-filled material means hardened steel,
 * and a mirror finish is polishing hours. A list of drivers lets a moulder's
 * quotation be read against the part rather than accepted whole.
 */
export function toolingDrivers({ analysis, material, finishName, cavities = 1, bboxMm = null }) {
  const drivers = [];

  /* type 1 is a slide, type 2 a lifter, and regions under 1 mm² are
     tessellation noise rather than features — the same fields and the same
     threshold the undercut check uses, so the two counts cannot disagree with
     each other on the same part. */
  const regions = (analysis && analysis.undercutRegions) || [];
  const significant = regions.filter((r) => r.area > 1);
  const slides = significant.filter((r) => r.type === 1).length;
  const lifters = significant.filter((r) => r.type === 2).length;

  if (slides) {
    drivers.push({
      driver: `${slides} side action${slides === 1 ? '' : 's'}`,
      effect: 'Each is a moving assembly in the tool — cam or hydraulic, with its own wear surfaces and its own way of going wrong. The most expensive thing on this list, and the one most often removed by a geometry change.',
    });
  }
  if (lifters) {
    drivers.push({
      driver: `${lifters} lifter${lifters === 1 ? '' : 's'}`,
      effect: 'Cheaper than a slide and mechanically simpler, but still a moving core that has to clear on ejection.',
    });
  }
  if (!slides && !lifters) {
    drivers.push({
      driver: 'No moving tooling needed',
      effect: 'Everything releases on the main pull, which is the cheapest tool this part can have.',
    });
  }

  drivers.push({
    driver: `${cavities} cavit${cavities === 1 ? 'y' : 'ies'}`,
    effect: cavities === 1
      ? 'A single cavity is the cheapest tool and the slowest output. The trade against piece price is the main tooling decision on this part.'
      : `Every cavity repeats the cavity, core, cooling and ejection, so tool cost climbs with cavitation while piece price falls. ${cavities} cavities also need a balanced runner, or they will not fill alike.`,
  });

  if (/GF|glass/i.test(material.name)) {
    drivers.push({
      driver: `${material.name} is abrasive`,
      effect: 'Glass fibre wears tool steel. Expect hardened cavity and core, and treat gate inserts as consumable — this is a tool-life question, not just a tool-price one.',
    });
  }
  if (finishName && /A[123]|mirror|polish/i.test(finishName)) {
    drivers.push({
      driver: `${finishName} finish`,
      effect: 'Polishing is hours of skilled hand work, and it has to be redone after any weld repair to the cavity.',
    });
  }
  if (bboxMm) {
    const longest = Math.max(...bboxMm);
    drivers.push({
      driver: `${bboxMm.map((v) => v.toFixed(0)).join(' × ')} mm envelope`,
      effect: `The tool has to be bigger than the part in every direction; a ${longest.toFixed(0)} mm part sets the bolster size, and bolster size sets the steel bill before anything is cut.`,
    });
  }

  return {
    drivers,
    slides,
    lifters,
    cavities,
    note: 'Drivers, not a price. What a tool costs depends on the toolmaker, the steel, the country and the lead time — none of which is in this file. Read a quotation against this list rather than instead of it.',
    partingCaveat: 'The moving-tooling counts come from the undercut check and inherit its assumption of a flat parting line at the pull minimum. A stepped or contoured split may release some of these with no moving tooling at all, so they are features needing a decision rather than a confirmed slide count.',
  };
}
