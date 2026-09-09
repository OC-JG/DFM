import { MATERIALS, MATERIAL_RIGIDITY } from '../core/materials.js';
import { getTwoShotCompat, ADHESION_LABELS } from '../core/twoshot-compat.js';
import { INTERFACE_GRADES, TWO_SHOT_RISK_PROFILES, scoreChecks, escalate } from './scoring.js';

/*
 * Two-shot / overmoulding checks.
 *
 * Scored through the same weight-and-severity mechanism as the single-part
 * checks, against its own weight table. It used to sum raw penalties instead,
 * to a maximum of 105 — which meant an interface score of 70 and a part score
 * of 70 were not the same statement about how much was wrong.
 */
/*
 * Substrate softening, as a function a test can drive.
 *
 * Split out of `runTwoShotDFM` for one reason: it forks on `compat.fusion`,
 * and one arm of that fork is unreachable from the material table — every
 * fusion pair there is the same polymer, whose melt necessarily exceeds its
 * own softening point. Taking the pair and the compatibility record as
 * arguments rather than looking them up makes that arm exercisable with a
 * synthetic pair instead of leaving it as the only untested branch here.
 */
export function substrateSoftening(m1, m2, compat) {
    /*
   * This check held 25 points, lost them, and has them back — but it is not
   * the check it was. What changed is the property underneath and the shape
   * of the verdict, so the history is worth stating.
   *
   * It used to compare shot 2's melt temperature against shot 1's HDT and
   * add a 120 °C margin. HDT (ISO 75) holds a bar under a constant 0.45 MPa
   * bending load and raises the temperature until it deflects 0.25 mm, which
   * is not what two-shot injection does to a substrate: seconds of contact
   * with a hot melt, under injection pressure rather than a fixed bending
   * stress, against a cold mould wall pulling heat out of the other face.
   * The consequence was not subtle. Shot 2's melt exceeds shot 1's HDT in
   * essentially every genuine overmould, so the rule fired on the
   * industry-standard pairs and the fudge margin condemned polypropylene as
   * a substrate outright — PP + TPU scored 49, NOT COMPATIBLE, on this check
   * alone.
   *
   * Vicat (VST/B/50, ISO 306) is the property that answers it: a loaded
   * needle penetrating 1 mm is nearer to what a melt front does to a cold
   * substrate skin than a sustained bending load is. `materials.js` now
   * carries it, and states its provenance — class-typical, conservative end
   * of the range, which is the same footing as every other column there.
   *
   * ── Why there is no margin in here anywhere ──────────────────────────
   *
   * The old rule's real defect was not HDT alone; it was the 120 °C. So
   * every boundary below is a comparison between two tabulated properties,
   * and there is no tolerance, factor or fudge to tune:
   *
   *   shot 2 melt  vs  shot 1 Vicat  — does the substrate skin soften?
   *   shot 2 melt  vs  shot 1 melt   — can the substrate be remelted?
   *
   * ── And why the verdict forks on bond type ───────────────────────────
   *
   * Because softening means opposite things either side of that fork, and
   * collapsing them is how the old rule condemned the pairs this material
   * table exists for. For a fusion weld, remelting the substrate skin IS
   * the bond: heat at the interface is the mechanism, not the hazard, and a
   * melt hotter than the substrate's own melt point is ordinary — PC/ASA at
   * 255 °C onto ASA at 245 °C is the standard OnlyCat window pair. The only
   * thermal defect available to a fusion pair is the opposite one: a melt
   * too cool to reach the substrate's softening point at all, which leaves
   * the weld undeveloped. For an interface bond, softening buys no adhesion
   * whatsoever, so any of it is pure cost — dimensional accuracy and
   * surface finish on geometry that is already to size.
   *
   * The dimensional risk a fusion pair does carry is a process variable
   * (cycle time, mould temperature, dwell) rather than a material one, and
   * nothing in the geometry or the table can size it. It is reported, and
   * left to the trial, which is where the old advisory was right.
   */
  const soften = m2.meltC - m1.vicatC;
  const remelt = m2.meltC - m1.meltC;

  let status = 'ok', severity = 'none', verdict = '', detail = '';

  if (compat.fusion) {
    if (soften < 0) {
      /*
       * No pair in the current table reaches this, and that is structural
       * rather than luck: `fusion` marks the same polymer on both sides, so
       * shot 2's melt is shot 1's melt, which is necessarily above shot 1's
       * softening point. It is kept because the flag is also set on
       * cross-polymer pairs that weld through a shared phase — PC/ASA to
       * ASA — where a cool enough shot 2 could reach it, and because the
       * alternative is that such a pair silently reads "heat is the
       * mechanism" when the heat never arrives. Exercised synthetically in
       * the unit tests for the same reason.
       */
      status = 'warn'; severity = 'minor'; verdict = 'Weld may not develop';
      detail = `Shot 2 (${m2.name}) melts at ${m2.meltC}°C, which is ${-soften}°C <b>below</b> shot 1's softening point (${m1.name}, VST ${m1.vicatC}°C). These are fusion-welding grades, so remelting the substrate skin is how the bond forms — and a melt this cool may never reach it. Expect an interface bond rather than a weld, and confirm bond strength on a trial before relying on the fusion figures. Raising shot 2's melt or the mould temperature is the usual answer.`;
    } else {
      verdict = 'Heat is the mechanism';
      detail = `Shot 2 (${m2.name}) melts at ${m2.meltC}°C, ${soften}°C above shot 1's softening point (${m1.name}, VST ${m1.vicatC}°C). These are fusion-welding grades, so that is what forms the bond — the substrate skin is meant to remelt, and this pair reaches it. No thermal deduction. The risk that remains is dimensional rather than adhesive: heat soaking out of the interface into the shot 1 geometry, which is a cycle-time and mould-temperature question no geometry can settle. Run fast fill, cold mould, short cycle, and measure the shot 1 geometry after overmoulding.`;
    }
  } else if (soften <= 0) {
    verdict = 'Substrate stays below softening';
    detail = `Shot 2 (${m2.name}) melts at ${m2.meltC}°C, at or below shot 1's softening point (${m1.name}, VST ${m1.vicatC}°C), so the substrate skin should not soften. The bond here is an interface bond rather than a fusion weld, which means softening would have bought no adhesion anyway — so this is the good case: full adhesion behaviour from the adhesion check, and no thermal cost against the shot 1 geometry.`;
  } else if (remelt <= 0) {
    /*
     * Reported and not deducted, and this is the boundary the whole check
     * turns on. Most substrates worth overmoulding are amorphous with a
     * softening point between 95 and 140 °C, and every melt in the table is
     * 200 °C or hotter — so "the skin softens" is true of very nearly every
     * interface-bond overmould ever moulded, the classic ABS-with-a-TPU-grip
     * included. A band that is almost always true carries no information,
     * and deducting on it would be the old rule's defect in a milder form:
     * a standing penalty on ordinary practice. What makes it survivable is
     * process — cold mould, fast fill, short dwell — not design, and nothing
     * in the geometry or the table can tell whether that process is in
     * place. So it is said, with the mitigation, and costs nothing.
     */
    verdict = 'Skin softens — process matter';
    detail = `Shot 2 (${m2.name}) melts at ${m2.meltC}°C, ${soften}°C above shot 1's softening point (${m1.name}, VST ${m1.vicatC}°C) but below its melt point (${m1.meltC}°C). The substrate skin will soften briefly, and because this is an interface bond rather than a fusion weld it buys no adhesion. <b>Not deducted:</b> this is true of almost every overmould — most substrates soften below 140°C and every melt is above 200°C — and what keeps the shot 1 geometry to size is process rather than material choice. Run fast fill, cold mould, short cycle, and measure the shot 1 geometry after overmoulding. Thin walls and fine detail on the substrate are where it would show first.`;
  } else {
    status = 'warn'; severity = 'major'; verdict = 'Above the substrate melt';
    detail = `Shot 2 (${m2.name}) melts at ${m2.meltC}°C, above shot 1's own melt point (${m1.name}, ${m1.meltC}°C) — not merely above its ${m1.vicatC}°C softening point. The substrate can be remelted rather than softened, and because this is an interface bond rather than a fusion weld, none of that heat buys adhesion. Expect distortion of the shot 1 geometry at the interface. Reversing the shot order, or moving to a higher-temperature substrate, addresses the cause; process tuning only limits the damage.`;
  }

  return {
    key: 'ts_thermal', name: 'Substrate softening', status, severity,
    detail,
    metrics: [
      ['Shot 1 softening (VST/B)', `${m1.vicatC}°C`],
      ['Shot 1 melt', `${m1.meltC}°C`],
      ['Shot 2 melt', `${m2.meltC}°C`],
      ['Above softening', `${soften > 0 ? '+' : ''}${soften}°C`],
      ['Bond type', compat.fusion ? 'Fusion weld' : 'Interface bond'],
      ['Verdict', verdict],
    ],
  };
}

export function runTwoShotDFM(input) {
  const m1 = MATERIALS[input.mat1];
  const m2 = MATERIALS[input.mat2];
  const compat = getTwoShotCompat(input.mat1, input.mat2);
  const iface = input.interface;
  const checks = [];

  // ── 1. Substrate softening ───────────────────────────────────────────────
  checks.push(substrateSoftening(m1, m2, compat));

  // ── 2. Adhesion compatibility ───────────────────────────────────────────
  {
    let status = 'ok', severity = 'none';
    if (compat.adhesion === 'incompatible') { status = 'fail'; severity = 'critical'; }
    else if (compat.adhesion === 'primer') { status = 'warn'; severity = 'major'; }
    else if (compat.adhesion === 'mechanical') { status = 'warn'; severity = 'minor'; }
    const label = ADHESION_LABELS[compat.adhesion] || compat.adhesion;

    checks.push({
      key: 'ts_adhesion', name: 'Material adhesion', status, severity,
      detail: `${m1.name} + ${m2.name}: ${label}. ${compat.notes}`,
      metrics: [['Bond type', label.toUpperCase()]],
    });
  }

  // ── 3. Shrinkage differential ───────────────────────────────────────────
  {
    const shrinkMid1 = (m1.shrinkLo + m1.shrinkHi) / 2;
    const shrinkMid2 = (m2.shrinkLo + m2.shrinkHi) / 2;
    const diff = Math.abs(shrinkMid1 - shrinkMid2);
    let status = 'ok', detail = '', severity = 'none';

    if (diff > 1.5) {
      status = 'fail'; severity = 'critical';
      detail = `Shrinkage differential ${diff.toFixed(2)}% (${m1.name} ~${shrinkMid1.toFixed(1)}% vs ${m2.name} ~${shrinkMid2.toFixed(1)}%) is very high. Interface stress will cause warpage or delamination on cooling. Consider reformulating or adding retention features.`;
    } else if (diff > 0.8) {
      /* The branch calls this "moderate" and prescribes balanced cooling and
         retention features, which is a minor finding by this file's own
         definitions. Severity bands throughout were assigned by reading what
         each branch actually says about the consequence — that is the whole
         point of tying the deduction to the rule. */
      status = 'warn'; severity = 'minor';
      detail = `Shrinkage differential ${diff.toFixed(2)}% is moderate. Mould cooling should be balanced to minimise differential shrink rate. Retention features recommended.`;
    } else {
      detail = `Shrinkage differential ${diff.toFixed(2)}% is acceptable. Similar shrink rates reduce interface stress.`;
    }

    checks.push({
      key: 'ts_shrinkage', name: 'Shrinkage differential', status, detail, severity,
      metrics: [
        ['Shot 1 shrink', `${m1.shrinkLo}–${m1.shrinkHi}%`],
        ['Shot 2 shrink', `${m2.shrinkLo}–${m2.shrinkHi}%`],
        ['Differential', `${diff.toFixed(2)}%`],
      ],
    });
  }

  // ── 4. Registration ─────────────────────────────────────────────────────
  /*
   * Reported before coverage, because every interface figure below is measured
   * in whichever frame this check settled on and a reader needs to know which.
   *
   * The fork this check exists to name: two meshes that do not touch look
   * identical whether one was exported in the wrong coordinate system or the
   * overmould genuinely misses the substrate. Geometry cannot tell them apart
   * — the same rigid transform explains both — so the tool does not choose.
   * It measures the transform, reports it, and says what each reading would
   * mean. That is also why it carries no weight: a file error is nothing and a
   * design error is fatal, and averaging the two into a deduction would be a
   * number with no meaning behind it.
   */
  const reg = input.registration;
  if (reg && reg.applied) {
    const shift = reg.offsetMm >= 0.05 ? `${reg.offsetMm.toFixed(1)} mm` : 'under 0.1 mm';
    const spin = reg.rotationDeg >= 0.5 ? ` and turned ${reg.rotationDeg.toFixed(1)}°` : '';
    checks.push({
      key: 'ts_registration', name: 'Shot alignment', status: 'warn', severity: 'major',
      detail: `Shot 2's mating surface sat ${reg.residualBefore.toFixed(2)} mm off shot 1 as the two files arrived — outside the ${reg.engageTol.toFixed(2)} mm this part's size allows. Shot 2 has been moved ${shift}${spin} onto shot 1, which brings the mating surface to ${reg.residualRms.toFixed(3)} mm RMS (95th percentile ${reg.residualP95.toFixed(3)} mm) over ${reg.inlierCount} of ${reg.samples} sampled points, from a ${reg.coarse} start. <b>Every interface figure below is measured after that move.</b> <b>Which of two things this is, geometry cannot say.</b> If the two files were exported in one coordinate system then that ${shift} is real: the overmould does not reach the substrate, and no process will close it. If shot 2 was exported in its own frame — a part saved outside its assembly, which is the ordinary way this happens — then the move is the correction and the figures below are the right ones. Re-export both from the same assembly to settle it. Not scored, because the two readings are worth nothing and everything respectively.`,
      metrics: [
        ['Offset applied', `${reg.offsetMm.toFixed(2)} mm`],
        ['Rotation applied', `${reg.rotationDeg.toFixed(2)}°`],
        ['Interface gap, as loaded', `${reg.residualBefore.toFixed(2)} mm`],
        ['Residual after (RMS)', `${reg.residualRms.toFixed(3)} mm`],
        ['Residual after (p95)', `${reg.residualP95.toFixed(3)} mm`],
        ['Mating tolerance', `${reg.engageTol.toFixed(2)} mm`],
        ['Coarse start', reg.coarse],
      ],
    });
  } else if (reg && reg.attempted) {
    checks.push({
      key: 'ts_registration', name: 'Shot alignment', status: 'info', severity: 'none',
      detail: `Shot 2's mating surface sat ${reg.residualBefore.toFixed(2)} mm off shot 1, so an alignment was attempted: ${reg.candidatesTried} starting poses, refined by ICP over the surfaces that face each other. The best of them reached ${reg.residualRms.toFixed(2)} mm, still outside the ${reg.engageTol.toFixed(2)} mm mating tolerance, so <b>no transform was applied and the figures below are measured as loaded</b>. Two shapes that no rigid move brings into contact are not a coordinate-system problem: check that shot 2 is the overmould for this substrate, and that both were exported in millimetres — a part exported in inches is out by a factor of 25.4, which this will not correct and should not.`,
      metrics: [
        ['Poses tried', String(reg.candidatesTried)],
        ['Interface gap, as loaded', `${reg.residualBefore.toFixed(2)} mm`],
        ['Best achievable', `${reg.residualRms.toFixed(2)} mm`],
        ['Mating tolerance', `${reg.engageTol.toFixed(2)} mm`],
        ['Result', 'NOT APPLIED'],
      ],
    });
  } else if (reg && reg.reason === 'already-mated') {
    /* Reported rather than left silent: otherwise there is no way to tell a
       pair that arrived in one coordinate system from one nobody looked at. */
    checks.push({
      key: 'ts_registration', name: 'Shot alignment', status: 'ok', severity: 'none',
      detail: `The two meshes arrived in one coordinate system — shot 2's mating surface sits ${reg.residualBefore.toFixed(3)} mm off shot 1, inside the ${reg.engageTol.toFixed(2)} mm this part's size allows — so nothing was moved and the figures below are measured as loaded.`,
      metrics: [
        ['Interface gap, as loaded', `${reg.residualBefore.toFixed(3)} mm`],
        ['Mating tolerance', `${reg.engageTol.toFixed(2)} mm`],
        ['Result', 'AS LOADED'],
      ],
    });
  }

  // ── 5. Interface coverage and overmould thickness ───────────────────────
  if (iface) {
    {
      let status = 'ok', detail = '', severity = 'none';
      const frame = (reg && reg.applied) ? ' This is measured after the alignment above.' : '';
      if (iface.coverPct < 10) {
        status = 'warn'; severity = 'major';
        const tried = reg && reg.attempted && !reg.applied
          ? ' Alignment was tried and did not help, so this is the geometry rather than the export — see Shot alignment above.'
          : ' Check that both meshes are correctly aligned and overlapping.';
        detail = `Only ${iface.coverPct.toFixed(0)}% of shot 2 surface area contacts the shot 1 substrate within the search distance.${tried}`;
      } else {
        detail = `${iface.coverPct.toFixed(0)}% of shot 2 surface area detected as overmoulded layer. Interface area ${iface.coverArea.toFixed(0)} mm².${frame}`;
      }
      checks.push({
        key: 'ts_coverage', name: 'Interface coverage', status, detail, severity,
        metrics: [['Interface area', `${iface.coverArea.toFixed(0)} mm²`], ['Coverage', `${iface.coverPct.toFixed(0)}%`]],
      });
    }

    {
      /* Target thickness bands differ by purpose:
           IR window          0.8–1.5 mm  (near-IR attenuation grows past 1.5)
           Indicator/visible  1.0–2.0 mm  (diffusion wants depth, >2 wastes material)
           Structural bond    1.5–3.0 mm  (Xometry) */
      const isOptWin = input.opticalWindow === 'optical' || input.opticalWindow === 'ir';
      const isIRWin = input.opticalWindow === 'ir';
      const optLo = isIRWin ? 0.8 : isOptWin ? 1.0 : 1.5;
      const optHi = isIRWin ? 1.5 : isOptWin ? 2.0 : 3.0;
      const bandLabel = isIRWin ? '0.8–1.5 mm (IR window)'
        : isOptWin ? '1.0–2.0 mm (optical window)'
        : '1.5–3.0 mm (structural bond)';

      let status = 'ok', detail = '', severity = 'none';
      if (iface.minThk < m2.wallLo * 0.5) {
        status = 'fail'; severity = 'critical';
        detail = `Minimum overmould thickness ${iface.minThk.toFixed(2)} mm critically thin — short-shot and adhesion failure likely.`;
      } else if (iface.minThk < optLo) {
        status = 'warn'; severity = 'major';
        detail = `Minimum thickness ${iface.minThk.toFixed(2)} mm is below the ${bandLabel} target. ${isIRWin ? 'Thin IR windows risk short-shot and variable IR transmission.' : 'Thin sections risk short-shot.'}`;
      } else if (iface.avgThk > optHi) {
        status = 'warn'; severity = isIRWin ? 'major' : 'minor';
        detail = `Average overmould thickness ${iface.avgThk.toFixed(2)} mm exceeds ${bandLabel}. ${isIRWin ? 'Thicker sections attenuate near-IR (850–940 nm) significantly — keep ≤ 1.5 mm for reliable detection.' : isOptWin ? 'Core out excess material to reduce shrinkage.' : 'Core out thick TPE/TPU sections.'}`;
      } else {
        detail = `Overmould layer OK — min ${iface.minThk.toFixed(2)} mm, avg ${iface.avgThk.toFixed(2)} mm within ${bandLabel}.`;
      }

      if (isIRWin) {
        if (!m2.irTransparent) {
          status = 'fail';
          severity = escalate(severity, 'critical');
          detail += ` CRITICAL: ${m2.name} is not flagged as IR-transparent. Standard black pigments (carbon black) completely block 850–940 nm. Specify natural/unpigmented grade — ASA natural recommended.`;
        } else {
          detail += ` ${m2.name} is IR-transparent. Confirm BOM specifies no TiO₂ and no carbon black.`;
        }
      }
      if (isOptWin && !isIRWin && !m2.optical) {
        if (status === 'ok') status = 'warn';
        severity = escalate(severity, 'minor');
        detail += ` Note: ${m2.name} standard grade is opaque. For visible indicator light, specify natural/unpigmented grade or switch to ASA natural.`;
      }

      checks.push({
        key: 'ts_thickness', name: 'Overmould layer thickness', status, detail, severity,
        metrics: [
          ['Min thickness', `${iface.minThk.toFixed(2)} mm`],
          ['Avg thickness', `${iface.avgThk.toFixed(2)} mm`],
          ['Target band', bandLabel],
          ['Window type', isIRWin ? 'IR 850-940nm' : isOptWin ? 'Optical/visible' : 'Structural'],
        ],
      });
    }
  }

  // ── 6. Shot order ───────────────────────────────────────────────────────
  {
    /* Convention is rigid first, soft second. */
    const r1 = MATERIAL_RIGIDITY[input.mat1] || 3;
    const r2 = MATERIAL_RIGIDITY[input.mat2] || 3;
    let status = 'ok', detail = '', severity = 'none';

    if (r2 > r1 + 1) {
      status = 'warn'; severity = 'major';
      detail = `Shot order may be sub-optimal: ${m1.name} (rigid score ${r1}) is shot 1 and ${m2.name} (score ${r2}) is shot 2. Stiffer materials are typically shot first (substrate), softer/functional materials second (overmould). Consider reversing if process permits.`;
    } else {
      detail = `Shot order is conventional: ${m1.name} as structural substrate, ${m2.name} as overmould.`;
    }

    checks.push({
      key: 'ts_order', name: 'Shot order', status, detail, severity,
      metrics: [['Shot 1', m1.name], ['Shot 2', m2.name]],
    });
  }

  const { score, grade, totalDeduction, budget, criticalCount } =
    scoreChecks(checks, INTERFACE_GRADES, TWO_SHOT_RISK_PROFILES);

  return {
    checks, score, grade, totalDeduction, budget, criticalCount,
    mat1: m1, mat2: m2, compat, iface,
    /* Carried on the result so a report can label the interface figures with
       the frame they were measured in without being handed the registration
       separately. */
    registration: reg || null,
  };
}
