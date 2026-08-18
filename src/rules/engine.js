import { MATERIALS, fpcCompatibility } from '../core/materials.js';
import { SURFACE_FINISHES, finishMaterialCheck } from '../core/finishes.js';
import { formatPullAxis } from '../analysis/stats.js';
import { scoreChecks, PART_GRADES } from './scoring.js';

/*
 * DFM rule engine. Combines manually specified values with mesh-derived ones
 * and returns a list of checks, each with a status, an explanation, supporting
 * metrics and a score deduction.
 *
 * Pure: every input arrives through `input`. The original reached into the
 * DOM from inside two of these checks, which meant the rules could not be
 * exercised without a live page.
 */
export function runDFM(input) {
  const m = MATERIALS[input.material];
  const mesh = input.mesh;
  const checks = [];

  // ══ WALL THICKNESS ══════════════════════════════════════════════════════
  if (input.runChecks.wall) {
    let nominal = input.wallThk;
    let wMin = input.wallMin, wMax = input.wallMax;
    let p25 = wMin, p75 = wMax;
    let cv = null;

    if (mesh && mesh.wallStats.n > 10) {
      nominal = mesh.wallStats.median;
      wMin = mesh.wallStats.p5;
      wMax = mesh.wallStats.p95;
      p25 = mesh.wallStats.p25;
      p75 = mesh.wallStats.p75;
      cv = mesh.wallStats.cvRobust;
    }

    const matLo = m.wallLo, matHi = m.wallHi;

    /* An FPC insert raises the effective floor: the overmould has to contain
       the flex plus cover on both faces. We cannot yet locate the FPC region
       on the mesh, so the stricter floor is applied to the part as a whole. */
    let effectiveMinWall = matLo;
    let fpcFloor = null;
    if (input.fpc && input.fpc.enabled) {
      fpcFloor = input.fpc.thickness + 2 * input.fpc.cover;
      if (fpcFloor > matLo) effectiveMinWall = fpcFloor;
    }

    const TOL = 0.01; // display precision: don't call 2.00 "below" 2.00
    let status = 'ok', detail = '', penalty = 0;

    if (nominal < effectiveMinWall - TOL) {
      status = 'fail';
      penalty = 25;
      detail = (fpcFloor !== null && effectiveMinWall === fpcFloor)
        ? `Nominal wall ${nominal.toFixed(2)} mm is below the FPC-overmould floor of ${fpcFloor.toFixed(2)} mm (= ${input.fpc.thickness.toFixed(2)} FPC + 2×${input.fpc.cover.toFixed(2)} cover). The FPC will sit too close to the surface — risk of FPC bleed-through, weak overmould, or trace damage.`
        : `Nominal wall ${nominal.toFixed(2)} mm is below ${m.name} minimum (${matLo} mm). Risk of short shots & high pressure drop.`;
    } else if (nominal > matHi + TOL) {
      status = 'fail';
      penalty = 22;
      detail = `Nominal wall ${nominal.toFixed(2)} mm exceeds ${m.name} max (${matHi} mm). Sink, voids and long cycle inevitable. Core out thick sections.`;
    } else if (nominal < effectiveMinWall) {
      status = 'warn';
      penalty = 4;
      const limitLabel = (fpcFloor !== null && effectiveMinWall === fpcFloor) ? 'FPC-overmould floor' : `${m.name} minimum`;
      detail = `Nominal wall ${nominal.toFixed(2)} mm is at the ${limitLabel} (${effectiveMinWall.toFixed(2)} mm). No margin for variation — verify locally above FPC region.`;
    } else {
      detail = fpcFloor !== null
        ? `Nominal wall sits above both ${m.name} (${matLo}–${matHi} mm) and FPC floor (${fpcFloor.toFixed(2)} mm).`
        : `Nominal wall sits in safe band for ${m.name} (${matLo}–${matHi} mm).`;
    }

    /* Bulk uniformity via the IQR ratio, which is robust to corner artefacts.
       Xometry puts the wall-variation limit at 15% of nominal — the primary
       warpage driver — so a p75/p25 ratio of 1.15 is the target ceiling. */
    const iqrRatio = p75 / Math.max(0.01, p25);
    if (iqrRatio > 1.15 * 2) {
      if (status !== 'fail') status = 'warn';
      detail += ` Wall variation (bulk p25–p75) of ${iqrRatio.toFixed(2)}× exceeds the 15% uniformity guideline — differential cooling will cause warp. Aim for <1.15×.`;
    } else if (iqrRatio > 1.15) {
      if (status === 'ok') detail += ` Bulk wall varies ${iqrRatio.toFixed(2)}× — approaching the 15% variation limit (Xometry). Monitor for warp.`;
    }
    if (cv !== null && cv > 0.40 && iqrRatio > 1.3) {
      detail += ` Wall CV (robust) = ${(cv * 100).toFixed(0)}% confirms non-uniform distribution.`;
    }

    const wallMetrics = [
      ['Nominal (median)', `${nominal.toFixed(2)} mm`],
      ['Bulk range (p25–p75)', `${p25.toFixed(2)}–${p75.toFixed(2)} mm`],
      ['Full range (p5–p95)', `${wMin.toFixed(2)}–${wMax.toFixed(2)} mm`],
      ['Material band', `${matLo}–${matHi} mm`],
      ['Bulk ratio', `${iqrRatio.toFixed(2)}×`],
    ];
    if (fpcFloor !== null) wallMetrics.splice(4, 0, ['FPC floor', `${fpcFloor.toFixed(2)} mm`]);

    /* How well pinned down the nominal is, and whether the two independent
       thickness methods agree about it. Both are reported, neither moves the
       score: the deduction still follows the ray-derived nominal, so that the
       verdict on a given part does not change meaning underneath anyone. */
    if (mesh && mesh.wallStats.n > 10) {
      const ws = mesh.wallStats;
      wallMetrics.push(['Samples', `${ws.n}`]);
      wallMetrics.push(['Median 95% CI', `${ws.medLo.toFixed(2)}–${ws.medHi.toFixed(2)} mm`]);
      if (ws.medUncertainty > 0.05) {
        detail += ` The nominal is pinned only to ±${(ws.medUncertainty * 100).toFixed(0)}% at 95% confidence (${ws.medLo.toFixed(2)}–${ws.medHi.toFixed(2)} mm): the wall varies enough across this part that one figure is a weak summary of it. Read the WALL heatmap rather than this number.`;
      }
      const wm = mesh.wallMethod;
      if (wm) {
        wallMetrics.push(['Ray / sphere', `${wm.rayMedian.toFixed(2)} / ${wm.sphereMedian.toFixed(2)} mm`]);
        if (wm.ratio < 0.85) {
          detail += ` Inscribed-sphere thickness (${wm.sphereMedian.toFixed(2)} mm) runs ${((1 - wm.ratio) * 100).toFixed(0)}% below the ray-cast thickness (${wm.rayMedian.toFixed(2)} mm), so the walls are markedly non-parallel — taper, angled ribs, or mass piling up at corners. The checks above use the ray figure, which is the optimistic one; confirm the thin sections locally before cutting steel.`;
        }
      }
    }

    checks.push({ key: 'wall', name: 'Wall thickness', status, detail, penalty, metrics: wallMetrics });
  }

  // ══ DRAFT ═══════════════════════════════════════════════════════════════
  if (input.runChecks.draft) {
    const manualDraft = input.draftAngle;
    const pctUnderMin = mesh ? mesh.sidePctUnderMin : null;
    const required = m.draftMin;
    const EPS = 1e-6;
    let status = 'ok', detail = '', penalty = 0;

    if (manualDraft < required - EPS) {
      status = 'fail';
      penalty = 20;
      detail = `Stated draft ${manualDraft}° is below recommended ${required}° for ${m.name}. Ejection scuffing & tool drag likely.`;
    } else if (manualDraft < required + 0.5 - EPS) {
      status = 'warn';
      penalty = 6;
      detail = `Stated draft ${manualDraft}° meets minimum but offers no margin. Aim for ${required + 1}° on textured surfaces.`;
    } else {
      detail = `Stated draft ${manualDraft}° comfortably exceeds ${m.name} minimum (${required}°).`;
    }

    if (pctUnderMin !== null) {
      const moldTypeStr = input.moldType === 'single-pull' ? 'single-pull' : 'two-piece';
      const draftPhrase = input.moldType === 'single-pull' ? 'with proper draft direction' : '(either mould half)';
      if (pctUnderMin > 25) {
        status = 'fail';
        penalty = Math.max(penalty, 25);
        detail += ` Mesh shows ${pctUnderMin.toFixed(0)}% of side-wall area below ${required}° draft ${draftPhrase} — major rework needed.`;
      } else if (pctUnderMin > 8) {
        status = status === 'fail' ? 'fail' : 'warn';
        penalty = Math.max(penalty, 12);
        detail += ` Mesh shows ${pctUnderMin.toFixed(0)}% of side-wall area below ${required}° draft ${draftPhrase} — check vertical features.`;
      } else {
        detail += ` Mesh confirms ${(100 - pctUnderMin).toFixed(0)}% of side-wall area has adequate draft assuming ${moldTypeStr} mould.`;
      }
    }

    checks.push({
      key: 'draft', name: 'Draft angles', status, detail, penalty,
      metrics: [
        ['Manual draft', `${manualDraft}°`],
        ['Material min', `${required}°`],
        pctUnderMin !== null ? [`Area <${required}°`, `${pctUnderMin.toFixed(1)}%`] : null,
        pctUnderMin !== null ? [`Area <${(required / 2).toFixed(2)}°`, `${mesh.sidePctUnderHalf.toFixed(1)}%`] : null,
      ].filter(Boolean),
    });
  }

  // ══ RIBS & BOSSES ═══════════════════════════════════════════════════════
  if (input.runChecks.ribs) {
    const ratio = input.ribThk / input.wallThk;
    const hRatio = input.ribH / input.ribThk;
    const bossRatio = input.bossWall / input.wallThk;
    const radiusRatio = input.ribRadius / input.wallThk;
    let status = 'ok', detail = '', penalty = 0;

    /* Rib t/wall, Malloy §2.4.2: typically 40–80% of nominal wall.
       ≤0.5 cosmetic-safe, 0.5–0.6 functional with Class-A risk,
       0.6–0.8 structural acceptance, >0.8 guaranteed sink. */
    if (ratio > 0.8) {
      status = 'fail'; penalty = 20;
      detail = `Rib t/wall = ${ratio.toFixed(2)} exceeds the 0.8× ceiling — heavy sink and slower cycle guaranteed.`;
    } else if (ratio > 0.6) {
      status = 'warn'; penalty = 10;
      detail = `Rib t/wall = ${ratio.toFixed(2)} is in the structural-only band (0.6–0.8). Sink visible on Class-A surfaces; specify texturing or relief.`;
    } else if (ratio > 0.5) {
      status = 'warn'; penalty = 5;
      detail = `Rib t/wall = ${ratio.toFixed(2)} is acceptable but sink possible on cosmetic surfaces. Target ≤0.5× for Class-A.`;
    } else if (ratio < 0.4) {
      status = 'warn'; penalty = 6;
      detail = `Rib t/wall = ${ratio.toFixed(2)} is below 0.4× — rib will be hard to fill and may short-shot. Increase to ≥0.4× or reroute flow.`;
    } else {
      detail = `Rib t/wall ratio ${ratio.toFixed(2)} is in the recommended 0.4–0.5× band (Malloy §2.4.2).`;
    }

    /* Rib height/thickness — Fictiv caps at 2.5×, Rutland at 3×. */
    if (hRatio > 3.0) {
      status = status === 'fail' ? 'fail' : 'warn';
      detail += ` Rib h/t = ${hRatio.toFixed(1)}× exceeds 3× — severe fill and ejection risk. Use multiple shorter ribs.`;
    } else if (hRatio > 2.5) {
      if (status === 'ok') status = 'warn';
      detail += ` Rib h/t = ${hRatio.toFixed(1)}× is between 2.5–3× — at the upper limit. Prefer multiple shorter ribs if height is flexible.`;
    }

    /* Rib base radius — Malloy §2.4.2: 25–40% of wall. Too small is a stress
       riser, too large piles up mass and worsens sink. */
    if (radiusRatio < 0.10) {
      status = status === 'fail' ? 'fail' : 'warn';
      penalty = Math.max(penalty, 6);
      detail += ` Rib base radius ${input.ribRadius}mm = ${radiusRatio.toFixed(2)}× wall — stress concentration at rib root.`;
    } else if (radiusRatio < 0.25) {
      penalty = Math.max(penalty, 3);
      detail += ` Rib base radius ${input.ribRadius}mm = ${radiusRatio.toFixed(2)}× wall — below 0.25× target; consider larger fillet to reduce stress.`;
    } else if (radiusRatio > 0.50) {
      status = status === 'fail' ? 'fail' : 'warn';
      penalty = Math.max(penalty, 8);
      detail += ` Rib base radius ${input.ribRadius}mm = ${radiusRatio.toFixed(2)}× wall exceeds 0.4× — mass pile-up at base will worsen sink.`;
    } else if (radiusRatio > 0.40) {
      detail += ` Rib base radius ${radiusRatio.toFixed(2)}× wall — at the top of recommended 0.25–0.4× range; watch for sink.`;
    }

    /* Boss wall — too thick sinks, too thin cracks around inserts. */
    if (bossRatio > 0.7) {
      if (status !== 'fail') status = 'warn';
      detail += ` Boss wall ${input.bossWall} mm = ${bossRatio.toFixed(2)}× nominal wall exceeds 0.7× — sink marks likely at boss base.`;
    } else if (bossRatio > 0.6) {
      if (status === 'ok') status = 'warn';
      detail += ` Boss wall ${bossRatio.toFixed(2)}× is marginal — sink possible on Class-A surfaces.`;
    } else if (bossRatio < 0.5) {
      if (status !== 'fail') status = 'warn';
      detail += ` Boss wall ${input.bossWall} mm = ${bossRatio.toFixed(2)}× nominal wall is below 0.5× — may crack around inserts under torsion. Attach boss to side wall with a support rib.`;
    }

    checks.push({
      key: 'ribs', name: 'Ribs & bosses', status, detail, penalty,
      metrics: [
        ['Rib t / wall', `${ratio.toFixed(2)}×`],
        ['Rib h / t', `${hRatio.toFixed(2)}×`],
        ['Base R / wall', `${radiusRatio.toFixed(2)}×`],
        ['Boss wall / wall', `${bossRatio.toFixed(2)}×`],
      ],
    });
  }

  // ══ UNDERCUTS ═══════════════════════════════════════════════════════════
  if (input.runChecks.undercut) {
    let status, detail, penalty;
    const meshRegions = mesh ? mesh.undercutRegions : null;

    if (meshRegions && meshRegions.length) {
      /* Micro-regions below 1 mm² are tessellation noise, not features. */
      const sigSlide = meshRegions.filter((r) => r.type === 1 && r.area > 1);
      const sigLifter = meshRegions.filter((r) => r.type === 2 && r.area > 1);

      if (sigSlide.length === 0 && sigLifter.length === 0) {
        status = 'ok'; penalty = 0;
        detail = `Mesh check on pull axis ${formatPullAxis(mesh.pullAxis, mesh.pullDir)}: no significant undercut features detected. Straight-pull tool feasible — lowest tooling cost.`;
      } else if (sigLifter.length === 0) {
        status = 'warn';
        penalty = 8 + Math.min(8, sigSlide.length * 2);
        /* Redesign hierarchy (Xometry/Fictiv): move the parting line, then
           shut-off cores, then bump-off for flexible materials, then a slide.
           Try the cheap options before committing to moving tooling. */
        const bumpOffNote = m.stripPct > 0
          ? ` Material ${m.name} has ${m.stripPct}% strip tolerance — small undercuts (< ${(m.stripPct / 100 * 20).toFixed(1)} mm on 20 mm OD) may be ejector-strippable without a slide.`
          : '';
        detail = `${sigSlide.length} external undercut region${sigSlide.length > 1 ? 's' : ''} detected. Before adding slides, consider: (1) repositioning parting line, (2) shut-off cores, (3) pass-through holes.${bumpOffNote} If slides are necessary: tool cost +15–30%.`;
      } else {
        status = 'fail';
        penalty = 12 + Math.min(10, sigLifter.length * 3) + Math.min(6, sigSlide.length * 1.5);
        detail = `${sigLifter.length} internal undercut${sigLifter.length > 1 ? 's' : ''} require lifter${sigLifter.length > 1 ? 's' : ''}`
          + (sigSlide.length ? `; ${sigSlide.length} external undercut${sigSlide.length > 1 ? 's' : ''} require slides.` : '.')
          + ' Consider redesigning to eliminate via shut-offs or parting line relocation before committing to moving tooling.';
      }
    } else if (input.hasUndercut === '0') {
      status = 'ok'; penalty = 0;
      detail = 'No undercuts declared. Straight-pull tool feasible — lowest tooling cost.';
    } else if (input.hasUndercut === '1') {
      status = 'warn'; penalty = 10;
      detail = 'Side-action slide declared. Adds tool cost (~15–30%) and parting-line constraints.';
    } else {
      status = 'fail'; penalty = 18;
      detail = 'Lifter declared for internal undercut. Significant tool cost and cycle-time impact.';
    }

    const metrics = [];
    if (meshRegions) {
      metrics.push(['Slide area', `${(mesh.slideArea || 0).toFixed(1)} mm²`]);
      metrics.push(['Lifter area', `${(mesh.lifterArea || 0).toFixed(1)} mm²`]);
      metrics.push(['Regions', `${meshRegions.length}`]);
    }
    checks.push({ key: 'undercut', name: 'Undercuts / parting line', status, detail, penalty, metrics });
  }

  // ══ SINK-MARK RISK ══════════════════════════════════════════════════════
  if (input.runChecks.sink !== false && mesh) {
    const sevPct = mesh.sinkPctSevere;
    const modPct = mesh.sinkPctModerate;
    let status = 'ok', detail = '', penalty = 0;

    if (sevPct > 5) {
      status = 'fail'; penalty = 18;
      detail = `${sevPct.toFixed(1)}% of surface area shows severe sink risk (local mass > 3× nominal wall). Core out thick sections or relocate gating.`;
    } else if (sevPct > 1 || modPct > 8) {
      status = 'warn'; penalty = 9;
      detail = `${modPct.toFixed(1)}% of surface area shows moderate sink risk (local mass > 1.6× nominal wall). Likely at rib bases and boss roots — increase rib t/wall ratio or add cosmetic relief.`;
    } else {
      detail = `Sink risk is low — ${(100 - modPct).toFixed(1)}% of surface area has local thickness within safe ratio of nominal wall.`;
    }

    const metrics = [
      ['Nominal wall', `${mesh.nominalWall.toFixed(2)} mm`],
      ['Moderate risk area', `${modPct.toFixed(1)}%`],
      ['Severe risk area', `${sevPct.toFixed(1)}%`],
    ];
    if (mesh.thicknessCoverage < 1) {
      metrics.push(['Sampled', `${(mesh.thicknessCoverage * 100).toFixed(0)}% of faces`]);
    }
    checks.push({ key: 'sink', name: 'Sink-mark risk', status, detail, penalty, metrics });
  }

  // ══ WALL TRANSITIONS (Malloy §2.4.2) ════════════════════════════════════
  // Abrupt thickness steps cause shrinkage stress and flow imbalance; the
  // recommended taper is 3× the delta. Mesh-based and therefore advisory:
  // thickness samples are unreliable at corners and rim edges.
  if (input.runChecks.transitions && mesh && mesh.wallTransitions) {
    const transitions = mesh.wallTransitions;
    let status = 'ok', detail = '', penalty = 0;

    if (transitions.length === 0) {
      detail = 'No abrupt wall thickness transitions detected. Walls appear uniform or tapered.';
    } else {
      const worst = transitions[0];
      if (worst.delta > 2.0 && transitions.length > 30) {
        status = 'warn'; penalty = 8;
        detail = `${transitions.length} candidate transitions detected (advisory — mesh-based, may include corner artefacts). Worst candidate: ${worst.thicknessLow.toFixed(2)}→${worst.thicknessHigh.toFixed(2)}mm step over ${worst.currentLength.toFixed(1)}mm at (${worst.centroid.map((v) => v.toFixed(1)).join(', ')}) — needs ≥${worst.recommendedLength.toFixed(1)}mm taper if real. Visually verify in DRAFT or WALL heatmap.`;
      } else if (worst.delta > 1.0 || transitions.length > 10) {
        status = 'warn'; penalty = 4;
        detail = `${transitions.length} candidate transitions detected (advisory). Worst: ${worst.thicknessLow.toFixed(2)}→${worst.thicknessHigh.toFixed(2)}mm step. Verify visually before acting.`;
      } else {
        detail = `${transitions.length} minor transition${transitions.length === 1 ? '' : 's'} detected. Worst delta ${worst.delta.toFixed(2)}mm — review if cosmetic.`;
      }
    }

    checks.push({
      key: 'transitions', name: 'Wall transitions', status, detail, penalty,
      metrics: [
        ['Candidates', String(transitions.length)],
        ['Worst Δ', transitions.length ? `${transitions[0].delta.toFixed(2)} mm` : '0'],
        ['Worst step', transitions.length ? `${transitions[0].thicknessLow.toFixed(2)}→${transitions[0].thicknessHigh.toFixed(2)}mm` : '—'],
      ],
    });
  }

  // ══ FLOW LENGTH / MOULDABILITY (Malloy §2.2.3, spiral flow L/T) ═════════
  if (input.runChecks.flow) {
    const fa = mesh && mesh.flowAnalysis;

    if (!fa) {
      checks.push({
        key: 'flow', name: 'Flow length (L/T)', status: 'warn', penalty: 0,
        detail: 'No gate location set. Click "Pick gate on part" to enable flow-length analysis (predicts short-shot risk).',
        metrics: [['L/T limit', `${m.ltMax}`], ['Max L/T', '—'], ['Area over limit', '—']],
      });
    } else {
      /* Overmoulding an FPC forces lower injection pressure and velocity so
         the insert is not displaced, which cuts the practical L/T budget to
         roughly 65% of the published spiral-flow limit. */
      const fpcOn = input.fpc && input.fpc.enabled;
      const ltLimit = fpcOn ? Math.round(fa.ltMax * 0.65) : fa.ltMax;
      const limitLabel = fpcOn ? `${ltLimit} (FPC-derated from ${fa.ltMax})` : `${ltLimit}`;
      const maxLT = fa.maxLT;
      const pct = fa.pctOverLT;
      let status = 'ok', detail = '', penalty = 0;

      if (maxLT > ltLimit * 1.5) {
        status = 'fail'; penalty = 20;
        detail = `Max L/T = ${maxLT.toFixed(0)} far exceeds ${limitLabel} for ${m.name}. Short shots expected — increase wall thickness, raise melt/mould temperature, or add a second gate.`;
      } else if (maxLT > ltLimit) {
        status = 'warn'; penalty = 10;
        detail = `Max L/T = ${maxLT.toFixed(0)} exceeds limit (${limitLabel}). ${pct.toFixed(1)}% of part beyond limit — pack pressure may not reach extremities, weld lines weak.`;
      } else if (maxLT > ltLimit * 0.8) {
        status = 'warn'; penalty = 4;
        detail = `Max L/T = ${maxLT.toFixed(0)} approaching limit (${limitLabel}). Process window narrow — verify with mould-fill simulation.`;
      } else {
        detail = `Max L/T = ${maxLT.toFixed(0)} well within limit (${limitLabel}). Part fills comfortably from this gate.`;
        if (fa.weldCandidates && fa.weldCandidates.length) {
          if (m.optical) {
            detail += ` ⚠ OPTICAL MATERIAL: weld lines in ${m.name} are cosmetically visible and cause IR/visible transmission variation. Gate placement must keep all weld lines outside the active optical aperture.`;
          } else {
            const pts = fa.weldCandidates.map((p) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)})`).join('; ');
            detail += ` Likely last-fill / weld-line zones near: ${pts}. Gate placement and hole/boss features affect final weld positions — validate with mould-fill simulation for critical parts.`;
          }
        }
      }

      const w = fa.worstLocation;
      const worstStr = w ? ` Worst at (${w[0].toFixed(1)}, ${w[1].toFixed(1)}, ${w[2].toFixed(1)}).` : '';

      /* Thick-to-thin fill advisory: a component should fill from its thickest
         section outward, or the gate freezes off before packing completes. */
      let gateStr = '';
      if (mesh && mesh.wallStats.n > 10 && fa.gateLocalThickness) {
        const medWall = mesh.wallStats.median;
        if (fa.gateLocalThickness < medWall * 0.8) {
          gateStr = ` Gate appears to be in a thin region (${fa.gateLocalThickness.toFixed(1)} mm < median ${medWall.toFixed(1)} mm) — fill should run from the thickest section to avoid premature freeze-off. Consider moving gate.`;
        }
      }

      /* Gate size from wall thickness (Table 4.3). */
      const wallForGate = (mesh && mesh.wallStats.n > 10) ? mesh.wallStats.median : (input.wallThk || 2.0);
      let gateSizeRec;
      if (wallForGate < 1.2)      gateSizeRec = '0.7–1.0 mm Ø, 0.8–1.0 mm L';
      else if (wallForGate < 3.0) gateSizeRec = '0.8–2.0 mm Ø, 0.8–1.0 mm L';
      else if (wallForGate < 5.0) gateSizeRec = '1.5–3.5 mm Ø, 0.9–1.0 mm L';
      else                        gateSizeRec = '3.5–6.0 mm Ø, 0.8–1.0 mm L (wall >5 mm should be cored)';
      const gateNote = ` Recommended gate size for ${wallForGate.toFixed(1)} mm wall: ${gateSizeRec} (Table 4.3).`;

      checks.push({
        key: 'flow', name: 'Flow length (L/T)', status,
        detail: detail + worstStr + gateStr + gateNote, penalty,
        metrics: [
          ['L/T limit', limitLabel],
          ['Max L/T', `${maxLT.toFixed(0)}`],
          ['Gate size rec.', gateSizeRec],
          ['Weld zones', fa.weldCandidates ? `${fa.weldCandidates.length} estimated` : '—'],
          ['Max flow', `${fa.maxFlow.toFixed(1)} mm`],
          ['Area over limit', `${pct.toFixed(1)}%`],
        ],
      });
    }
  }

  // ══ WARPAGE / SHRINKAGE ═════════════════════════════════════════════════
  if (input.runChecks.warp) {
    const shrinkMid = (m.shrinkLo + m.shrinkHi) / 2;
    /* Semi-crystalline materials shrink anisotropically — more along the flow
       direction — which is the primary warp driver, so they are worse than
       amorphous grades at the same nominal shrink percentage. */
    const crystNote = m.crystalline
      ? ' Semi-crystalline: shrinkage is anisotropic (higher along flow direction) — warpage risk is structurally higher than amorphous materials with similar shrink range.'
      : ' Amorphous: shrinkage is more isotropic, lower inherent warp risk than semi-crystalline.';

    let status = 'ok', detail = '', penalty = 0;
    if (m.warpRisk === 'high') {
      status = 'warn'; penalty = 12;
      detail = `${m.name} has high warp tendency (shrink ${m.shrinkLo}–${m.shrinkHi}%).${crystNote} Use uniform walls, balanced gating, mould cooling within ±3°C. Wall variation >15% of nominal will compound this significantly.`;
    } else if (m.warpRisk === 'medium') {
      penalty = 4;
      detail = `${m.name} has moderate warp tendency (shrink ${m.shrinkLo}–${m.shrinkHi}%).${crystNote} Standard precautions apply.`;
    } else {
      detail = `${m.name} is dimensionally stable (shrink ${m.shrinkLo}–${m.shrinkHi}%). Low warpage risk under normal conditions.`;
    }

    if (mesh) {
      const longest = Math.max(...mesh.bbox.size);
      if (longest > 150 && m.warpRisk !== 'low') {
        status = 'fail';
        penalty = Math.max(penalty, 18);
        detail += ` Longest dim ${longest.toFixed(0)} mm — large parts in this material need DOE on packing & cooling.`;
      }
    }

    checks.push({
      key: 'warp', name: 'Shrinkage & warpage', status, detail, penalty,
      metrics: [
        ['Shrink range', `${m.shrinkLo}–${m.shrinkHi}%`],
        ['Typical', `${shrinkMid.toFixed(2)}%`],
        ['Warp risk', m.warpRisk.toUpperCase()],
        ['Type', m.crystalline ? 'Semi-crystalline' : 'Amorphous'],
        ['Flow', m.flow.toUpperCase()],
      ],
    });
  }

  // ══ CORNER RADII (advisory) ═════════════════════════════════════════════
  // Cannot be auto-detected: corner radii need B-rep topology, which STL does
  // not carry. Fires off the declared wall thickness as a reminder.
  if (input.runChecks.wall) {
    const wallT = input.wallThk || (mesh && mesh.wallStats.median) || 2.0;
    const internalMinR = (wallT * 0.5).toFixed(2);
    const externalMinR = (wallT * 1.5).toFixed(2);
    checks.push({
      key: 'corners', name: 'Corner radii (advisory)', status: 'ok', penalty: 0,
      detail: `Literature guidelines: internal corners ≥ ${internalMinR} mm (0.5× wall), external corners ≥ ${externalMinR} mm (1.5× wall). Sharp internal corners concentrate stress and require EDM tooling. Sharp external corners impede flow. Verify in CAD before tooling.`,
      metrics: [
        ['Wall', `${wallT.toFixed(2)} mm`],
        ['Min internal R', `${internalMinR} mm`],
        ['Min external R', `${externalMinR} mm`],
      ],
    });
  }

  // ══ SURFACE FINISH × MATERIAL ═══════════════════════════════════════════
  {
    const finishKey = input.surfaceFinish || 'spi-a2';
    const compat = finishMaterialCheck(finishKey, input.material);
    const finishName = SURFACE_FINISHES[finishKey] ? SURFACE_FINISHES[finishKey].name : finishKey;
    if (compat === 'no') {
      checks.push({
        key: 'finish_compat', name: 'Surface finish compatibility', status: 'fail', penalty: 0,
        detail: `${finishName} is not achievable with ${m.name}. Semi-crystalline and elastomeric materials (PP, PE, TPU, PA) cannot be polished to A-grade mirror finishes. Select B or C grade, or switch material.`,
        metrics: [['Finish', finishName], ['Material', m.name], ['Result', 'NOT ACHIEVABLE']],
      });
    } else if (compat === 'caution') {
      checks.push({
        key: 'finish_compat', name: 'Surface finish compatibility', status: 'warn', penalty: 0,
        detail: `${finishName} is marginal with ${m.name} — achievable but requires careful processing. Confirm with your moulder and request sample approval.`,
        metrics: [['Finish', finishName], ['Material', m.name], ['Result', 'MARGINAL']],
      });
    }
    /* An achievable finish needs no entry — silence is the pass condition. */
  }

  // ══ FPC OVERMOULDING ════════════════════════════════════════════════════
  // Aggregates material compatibility, wall cover and process advisories so
  // the FPC-specific risks can be scanned in one place.
  if (input.runChecks.fpc && input.fpc && input.fpc.enabled) {
    const fpc = input.fpc;
    const compat = fpcCompatibility(m);
    const fpcFloor = fpc.thickness + 2 * fpc.cover;
    let status = 'ok', penalty = 0;
    const notes = [];

    // 1. Melt temperature
    if (compat === 'unsafe') {
      status = 'fail'; penalty += 30;
      notes.push(`${m.name} melts at ${m.meltC}°C, above the 270°C ceiling for FPC overmoulding. Standard Kapton/adhesive ratings will not survive the cycle. Switch to a lower-melt material — TPU, PE, PP, or low-temp PA grades.`);
    } else if (compat === 'risk') {
      status = 'fail'; penalty += 20;
      notes.push(`${m.name} melts at ${m.meltC}°C — high risk for FPC delamination. Specialist tooling (low-pressure overmoulding, short contact time, pre-heated insert) required. Consider switching to a softer material.`);
    } else if (compat === 'caution') {
      status = 'warn'; penalty += 8;
      notes.push(`${m.name} melts at ${m.meltC}°C — borderline for FPC. Run barrel at the low end of the process window, verify FPC adhesive is rated ≥240°C, and keep contact time short.`);
    } else {
      notes.push(`${m.name} at ${m.meltC}°C is FPC-safe.`);
    }

    // 2. Wall vs FPC floor
    let nominalWall = input.wallThk;
    if (mesh && mesh.wallStats.n > 10) nominalWall = mesh.wallStats.median;
    if (nominalWall < fpcFloor) {
      status = 'fail'; penalty += 18;
      notes.push(`Nominal wall ${nominalWall.toFixed(2)} mm < required ${fpcFloor.toFixed(2)} mm (FPC ${fpc.thickness.toFixed(2)} + 2×${fpc.cover.toFixed(2)} cover) — FPC will sit at or above the part surface in overmoulded regions.`);
    } else if (nominalWall < fpcFloor + 0.4) {
      if (status === 'ok') status = 'warn';
      penalty += 4;
      notes.push(`Nominal wall ${nominalWall.toFixed(2)} mm has only ${(nominalWall - fpcFloor).toFixed(2)} mm margin above FPC floor — verify shrinkage doesn't bring polymer below FPC plane.`);
    } else {
      notes.push(`Wall margin above FPC: ${(nominalWall - fpcFloor).toFixed(2)} mm.`);
    }

    // 3. Anchor strategy
    if (fpc.anchors === 'none') {
      if (status === 'ok') status = 'warn';
      penalty += 6;
      notes.push('No mechanical anchors specified — pull-out strength relies entirely on polymer-FPC adhesion. Best to add through-holes (Ø ≥ 1 mm, on 5–10 mm pitch) or perimeter tabs to the FPC layout.');
    } else if (fpc.anchors === 'holes') {
      notes.push('Through-holes/cutouts in FPC give mechanical key — confirm hole diameter ≥1 mm so polymer flows through cleanly.');
    } else if (fpc.anchors === 'tabs') {
      notes.push('Tab/protrusion anchors specified — works best when tabs extend ≥1× wall thickness into the polymer body.');
    } else if (fpc.anchors === 'both') {
      notes.push('Both holes and tabs — best mechanical retention. No additional anchor concerns.');
    }

    // 4. Shrinkage differential against the (essentially static) polyimide
    if (m.warpRisk === 'high' || (m.shrinkHi - m.shrinkLo) > 1.5) {
      if (status === 'ok') status = 'warn';
      penalty += 5;
      notes.push(`${m.name} shrinks ${m.shrinkLo}–${m.shrinkHi}%, much more than the FPC (Kapton ≈ 0.02%). Differential shrinkage will warp the part around the insert. Specify uniform cooling and consider symmetric FPC placement.`);
    } else {
      notes.push(`Shrinkage differential acceptable for FPC retention (${m.name} ${m.shrinkLo}–${m.shrinkHi}%).`);
    }

    // 5. Gate proximity (advisory — the FPC region is not yet located on the mesh)
    notes.push(mesh && mesh.flowAnalysis
      ? 'Verify gate is at least one wall thickness away from the FPC region — direct gate impingement can displace or wrinkle the insert. Re-pick gate if it sits over the FPC area.'
      : 'Pick a gate location and re-run to evaluate flow-front impingement on the FPC region.');

    checks.push({
      key: 'fpc', name: 'FPC overmoulding', status, detail: notes.join(' '), penalty,
      metrics: [
        ['Compatibility', compat.toUpperCase()],
        ['Material melt', `${m.meltC}°C`],
        ['FPC thickness', `${fpc.thickness.toFixed(2)} mm`],
        ['Cover each side', `${fpc.cover.toFixed(2)} mm`],
        ['Effective wall floor', `${fpcFloor.toFixed(2)} mm`],
        ['Anchors', fpc.anchors.toUpperCase()],
      ],
    });
  }

  const { score, grade, totalDeduction } = scoreChecks(checks, PART_GRADES);
  return { checks, score, grade, totalDeduction, material: m };
}
