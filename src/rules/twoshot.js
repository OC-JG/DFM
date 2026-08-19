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

  // ── 1. Melt temperature vs substrate HDT ────────────────────────────────
  {
    /* HDT is a sustained-load test; Vicat softening point is closer to what
       two-shot injection actually does to the substrate, given the short
       contact time. The 120 °C warn margin is a conservative heuristic that
       stands in for that difference. */
    const safetyMargin = 20;  // °C below HDT counts as safe
    const warnMargin = 120;   // °C above HDT before it is a serious risk
    const maxSafeShot2Melt = m1.hdtC - safetyMargin;
    let status = 'ok', detail = '', severity = 'none';

    if (compat.fusion && m2.meltC > m1.hdtC) {
      /* A fusion weld is supposed to remelt the interface, so shot 2's melt
         being far above shot 1's HDT is the mechanism rather than the failure.
         Two grades of the same polymer necessarily sit in this band, which
         meant every fusion pair in the table — the ASA-natural window on a
         PC/ASA body among them — came out a critical thermal failure while the
         adhesion check on the same page called it the strongest bond
         available. The heat is still real: it distorts the substrate if the
         cycle is slow, which is a process concern, not a redesign. */
      status = 'warn'; severity = 'minor';
      detail = `Shot 2 (${m2.name}, melt ${m2.meltC}°C) is above shot 1's HDT (${m1.name}, ${m1.hdtC}°C), which is expected for a fusion weld — remelting the interface is what produces the bond. Control the substrate's dwell at temperature: fast fill, cold mould, short cycle. Check first-article dimensions on the shot 1 geometry rather than the interface.`;
    } else if (m2.meltC > m1.hdtC + warnMargin) {
      status = 'fail'; severity = 'critical';
      detail = `Shot 2 (${m2.name}, melt ${m2.meltC}°C) is ${m2.meltC - m1.hdtC}°C above shot 1 substrate HDT (${m1.name}, HDT ${m1.hdtC}°C). Substrate will deform during injection. Choose a lower-melt shot 2 material or switch shot order.`;
    } else if (m2.meltC > m1.hdtC) {
      /* Minor, not major. Almost every real overmould lands in this band —
         ABS with a TPU grip is the textbook pair and sits here, because a
         200 °C melt is above ABS's 98 °C HDT — and the branch's own advice is
         that it is acceptable with a fast fill. Scoring it as a major finding
         put the industry-standard combination 25 points down and contradicted
         the adhesion check, which calls the same pair excellent. */
      status = 'warn'; severity = 'minor';
      detail = `Shot 2 melt (${m2.meltC}°C) exceeds shot 1 HDT (${m1.hdtC}°C) by ${m2.meltC - m1.hdtC}°C. Acceptable in practice if injection is fast (short contact time), but validate with process trials. Run high injection speed, cold mould, and short cycle.`;
    } else if (m2.meltC > maxSafeShot2Melt) {
      status = 'warn'; severity = 'minor';
      detail = `Shot 2 melt (${m2.meltC}°C) is within ${m2.meltC - maxSafeShot2Melt}°C of the safe threshold (HDT ${m1.hdtC}°C − ${safetyMargin}°C margin). Run shot 2 barrel at the low end of the process window.`;
    } else {
      detail = `Shot 2 melt (${m2.meltC}°C) is safely below shot 1 HDT (${m1.hdtC}°C). No substrate deformation expected.`;
    }

    checks.push({
      key: 'ts_thermal', name: 'Thermal compatibility', status, detail, severity,
      metrics: [
        ['Shot 1 HDT (0.45MPa)', `${m1.hdtC}°C`],
        ['Shot 2 melt', `${m2.meltC}°C`],
        ['Bond type', compat.fusion ? 'Fusion weld' : 'Interface bond'],
        ['Warn threshold', `${m1.hdtC + warnMargin}°C`],
        ['Safe limit', `${maxSafeShot2Melt}°C`],
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

  // ── 4. Interface coverage and overmould thickness ───────────────────────
  if (iface) {
    {
      let status = 'ok', detail = '', severity = 'none';
      if (iface.coverPct < 10) {
        status = 'warn'; severity = 'major';
        detail = `Only ${iface.coverPct.toFixed(0)}% of shot 2 surface area contacts the shot 1 substrate within the search distance. Check that both meshes are correctly aligned and overlapping.`;
      } else {
        detail = `${iface.coverPct.toFixed(0)}% of shot 2 surface area detected as overmoulded layer. Interface area ${iface.coverArea.toFixed(0)} mm².`;
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

  // ── 5. Shot order ───────────────────────────────────────────────────────
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
  };
}
