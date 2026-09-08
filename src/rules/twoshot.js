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
export function runTwoShotDFM(input) {
  const m1 = MATERIALS[input.mat1];
  const m2 = MATERIALS[input.mat2];
  const compat = getTwoShotCompat(input.mat1, input.mat2);
  const iface = input.interface;
  const checks = [];

  // ── 1. Substrate softening (advisory, unscored) ──────────────────────────
  {
    /*
     * This check used to carry 25 of the interface's 100 points and decide the
     * grade on melt-vs-HDT alone. It no longer scores anything, because HDT is
     * not the property the question needs.
     *
     * HDT (ISO 75 / ASTM D648) is measured by holding a bar under a constant
     * 0.45 MPa bending load and raising the temperature until it deflects
     * 0.25 mm. Two-shot injection does something different to the substrate:
     * a few seconds of contact with a hot melt, under injection pressure
     * rather than a fixed bending stress, against a cold mould wall drawing
     * heat out of the other face. The substrate's bulk never reaches the
     * melt's temperature, and whether the interface skin softens depends on
     * contact time, wall thickness and mould temperature — none of which are
     * in HDT.
     *
     * Vicat softening point (ISO 306) is the closer stand-in: it measures the
     * temperature at which a loaded needle penetrates 1 mm, which is nearer to
     * what a hot melt front does to a cold substrate surface. The material
     * table does not carry Vicat, so this check cannot reach a verdict, and
     * the previous 120 °C fudge margin over HDT was a guess dressed as a
     * threshold. Its consequences were real: shot 2 melt exceeds shot 1 HDT in
     * essentially every genuine overmould (TPU's 200 °C melt is above ABS's
     * 98 °C HDT), so the rule fired on the industry-standard pairs, and the
     * 120 °C margin condemned polypropylene as a substrate outright.
     *
     * So: report the numbers, name what they do and do not tell you, and let
     * the moulder decide. An advisory that says "we cannot judge this" is
     * worth more than a graded verdict computed from the wrong property.
     */
    const delta = m2.meltC - m1.hdtC;
    const heading = delta > 0
      ? `Shot 2 (${m2.name}) melts at ${m2.meltC}°C, which is ${delta}°C above shot 1's HDT (${m1.name}, ${m1.hdtC}°C at 0.45 MPa).`
      : `Shot 2 (${m2.name}) melts at ${m2.meltC}°C, below shot 1's HDT (${m1.name}, ${m1.hdtC}°C at 0.45 MPa).`;

    /* The one thing that can be said with confidence, and it differs by bond
       type: for a fusion weld the heat is the mechanism, not the hazard. */
    const mechanism = compat.fusion
      ? `These are fusion-welding grades, so remelting the substrate skin is how the bond forms — heat at the interface is the mechanism, not the failure. The risk it carries is dimensional: a slow cycle lets that heat soak into the shot 1 geometry.`
      : `The bond here is an interface bond rather than a fusion weld, so substrate softening buys no adhesion. What it can cost is dimensional accuracy and surface finish on the shot 1 geometry.`;

    checks.push({
      key: 'ts_thermal', name: 'Substrate softening', status: 'info', severity: 'none',
      detail: `${heading} ${mechanism} <b>This is not scored, and the comparison above cannot settle it.</b> HDT is a sustained-load deflection test; two-shot injection gives the substrate seconds of contact against a cold mould, so its bulk never reaches the melt temperature. Vicat softening point (ISO 306) is the property that would answer this, and it is not in the material table. Ask the moulder to confirm on a short-shot trial: measure the shot 1 geometry after overmoulding, and run fast fill, cold mould, short cycle to keep dwell at temperature down.`,
      metrics: [
        ['Shot 1 HDT (0.45MPa)', `${m1.hdtC}°C`],
        ['Shot 2 melt', `${m2.meltC}°C`],
        ['Difference', `${delta > 0 ? '+' : ''}${delta}°C`],
        ['Bond type', compat.fusion ? 'Fusion weld' : 'Interface bond'],
        ['Verdict', 'Advisory — needs a process trial'],
      ],
    });
  }

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
