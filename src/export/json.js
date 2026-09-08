import { formatPullAxis } from '../analysis/stats.js';
import { buildIdentity } from '../core/build-info.js';
import { checkRef } from '../rules/findings.js';

/*
 * JSON export — the machine-readable counterpart to the PDF.
 *
 * Includes the two-shot block, which the original omitted: running an
 * overmould analysis and then exporting produced a file with no trace of it.
 */
export function buildExportJSON({ sessionId, dfm, analysis, twoShot, interface: iface, registration, fpcRegion, validation, shot, cycle, cost, tooling, settings }) {
  const out = {
    tool: 'OnlyCat DFM',
    /* Which build made this claim. Thresholds move between versions, so two
       exports of the same geometry that disagree are only interpretable if
       each says what produced it — and compare.js reads this to caveat a
       comparison that spans a rules change. */
    build: buildIdentity(),
    session: sessionId,
    timestamp: new Date().toISOString(),
    mode: settings.analysisMode,
    score: dfm.result.score,
    grade: dfm.result.grade.label,
    /* How the score was arrived at. deduction/budget is the whole calculation:
       each check spends a fraction of its weight according to how bad the
       finding was, and the score is what is left of the budget that ran. */
    scoring: {
      deduction: Math.round(dfm.result.totalDeduction * 10) / 10,
      budget: dfm.result.budget,
      critical_findings: dfm.result.criticalCount,
    },
    material: dfm.result.material.name,
    input: dfm.input,
    checks: dfm.result.checks.map((c) => ({
      key: c.key,
      /* The same key, upper-cased: how the finding is printed on screen and in
         the PDF, so a response quoting "WALL" can be matched back to a record
         without knowing that the field is called `key`. */
      ref: checkRef(c.key),
      name: c.name,
      status: c.status,
      detail: c.detail,
      severity: c.severity,
      weight: c.weight,
      score_deduction: c.scoreDeduction,
      metrics: c.metrics,
    })),
    mesh_summary: analysis ? meshSummary(analysis) : null,
    /* What the geometry was before any of the above was measured on it. A
       consumer of this record should read the confidence first: a score
       derived from an inch-scaled or open mesh is arithmetic, not a
       manufacturability judgement. */
    mesh_health: validation ? meshHealth(validation) : null,

    /* The insert, when a body was designated as one. Carried in full because
       the FPC check reads differently depending on whether it exists: with it,
       the cover is measured over the flex; without it, the same check is
       judging the part's nominal wall against a floor, which over-reports. A
       record that omitted this would not say which. */
    fpc_insert: fpcRegion && fpcRegion.located ? {
      located: true,
      insert_area_mm2: fpcRegion.regionArea,
      part_area_mm2: fpcRegion.partArea,
      sample_points: fpcRegion.samples,
      required_cover_mm: fpcRegion.requiredCover,
      cover_min_mm: fpcRegion.coverStats ? fpcRegion.coverStats.min : null,
      cover_median_mm: fpcRegion.coverStats ? fpcRegion.coverStats.median : null,
      cover_max_mm: fpcRegion.coverStats ? fpcRegion.coverStats.max : null,
      /* Three different states, and collapsing any two of them would lose the
         distinction the check is built on: covered but thin, not covered at
         all, and not measurable. */
      area_below_required_pct: fpcRegion.belowRequiredPct,
      area_uncovered_pct: fpcRegion.uncoveredPct,
      area_indeterminate_pct: fpcRegion.indeterminatePct,
      gate_to_insert_mm: fpcRegion.gateDistance,
    } : { located: false },
    /* What it takes to mould the part, as distinct from whether it can be:
       arithmetic on measured geometry and tabulated material data, with the
       one process assumption stated. */
    moulding: shot ? {
      part_volume_cm3: shot.volumeCm3,
      part_mass_g: shot.massG,
      runner_allowance_pct: shot.runnerPct,
      shot_mass_g: shot.shotMassG,
      projected_area_cm2: shot.projectedAreaCm2,
      cavity_pressure_mpa: shot.cavityPressureMPa,
      clamp_force_tonnes: shot.clampTonnes,
      machine_clamp_tonnes: shot.machineTonnes,
      assumptions: shot.notes,
    } : null,

    /* Cycle time and cost travel with every assumption behind them, because
       these are the figures most likely to be lifted out of a record and put
       into a quotation. A consumer that reads the numbers and drops the
       assumptions has taken a planning estimate for a price. */
    cycle: cycle ? {
      wall_mm: cycle.wallMm,
      /* Derived, and a genuine lower bound: no tool beats it. */
      cooling_floor_s: cycle.coolingFloorS,
      practical_cooling_s: cycle.practicalCoolingS,
      cycle_s: cycle.cycleS,
      cavities: cycle.cavities,
      parts_per_hour: cycle.partsPerHour,
      assumptions: cycle.assumptions,
      caveats: cycle.notes,
    } : null,

    cost: cost ? {
      /* Currency-free on purpose: the rates were the user's, in whatever
         currency they were thinking in, and this file has no business
         guessing which. */
      material_per_part: cost.materialCost,
      machine_per_part: cost.machineCost,
      material_plus_machine_per_part: cost.totalCost,
      cavities: cost.cavities,
      scrap_pct: cost.scrapPct,
      missing_inputs: cost.missing,
      assumptions: cost.assumptions,
      caveats: cost.notes,
    } : null,

    tooling_drivers: tooling ? {
      slides: tooling.slides,
      lifters: tooling.lifters,
      cavities: tooling.cavities,
      drivers: tooling.drivers,
      note: tooling.note,
      parting_line_caveat: tooling.partingCaveat,
    } : null,
  };

  if (twoShot) {
    out.two_shot = {
      score: twoShot.score,
      grade: twoShot.grade.label,
      scoring: {
        deduction: Math.round(twoShot.totalDeduction * 10) / 10,
        budget: twoShot.budget,
        critical_findings: twoShot.criticalCount,
      },
      shot1_material: twoShot.mat1.name,
      shot2_material: twoShot.mat2.name,
      window_type: settings.windowType,
      adhesion: twoShot.compat.adhesion,
      adhesion_notes: twoShot.compat.notes,
      interface: iface ? {
        /* Which frame these were measured in, alongside the numbers rather
           than only in the finding text: an export travels, and a coverage
           figure means something different depending on whether shot 2 was
           moved to produce it. */
        measured_in: (registration && registration.applied) ? 'registered' : 'as_loaded',
        coverage_pct: iface.coverPct,
        interface_area_mm2: iface.coverArea,
        min_thickness_mm: iface.minThk,
        avg_thickness_mm: iface.avgThk,
      } : null,
      registration: registration ? {
        applied: registration.applied,
        reason: registration.reason,
        interface_gap_as_loaded_mm: registration.residualBefore,
        mating_tolerance_mm: registration.engageTol,
        residual_rms_mm: registration.residualRms,
        residual_p95_mm: registration.residualP95,
        offset_applied_mm: registration.applied ? registration.offsetMm : null,
        rotation_applied_deg: registration.applied ? registration.rotationDeg : null,
        /* The transform itself, so a reader can reproduce the pose the
           figures above were measured in rather than take them on trust. */
        transform: registration.transform
          ? { rotation_row_major: Array.from(registration.transform.r), translation_mm: Array.from(registration.transform.t) }
          : null,
        coarse_start: registration.coarse || null,
        poses_tried: registration.candidatesTried || null,
        sample_points: registration.samples,
      } : null,
      checks: twoShot.checks.map((c) => ({
        key: c.key, name: c.name, status: c.status, detail: c.detail,
        severity: c.severity, weight: c.weight, score_deduction: c.scoreDeduction,
        metrics: c.metrics,
      })),
    };
  }

  return out;
}

function meshHealth(v) {
  return {
    confidence: v.confidence,
    analysable: v.analysable,
    bbox_mm: v.bbox.size,
    largest_dimension_mm: v.maxDim,
    closed: v.closed,
    winding_consistent: v.windingConsistent,
    normals_inverted: v.inverted,
    enclosed_volume_mm3: v.volume,
    edges: {
      total: v.edges.total,
      boundary: v.edges.boundary,
      non_manifold: v.edges.nonManifold,
      inconsistent_winding: v.edges.inconsistent,
    },
    degenerate_triangles: v.degenerate,
    scale_suspicion: v.scale.suspect,
    weld: v.weld,
    issues: v.issues.map((i) => ({ level: i.level, code: i.code, title: i.title, detail: i.detail })),
  };
}

/* One cylindrical feature, as it appears in the record. */
function featureRow(c) {
  return {
    face_id: c.faceId,
    body_id: c.bodyId,
    radius_mm: c.radius,
    diameter_mm: c.diameter,
    sweep_deg: c.extentDeg,
    axis: c.axis,
  };
}

function meshSummary(a) {
  return {
    tris: a.triCount,
    bbox_mm: a.bbox.size,
    surface_area_mm2: a.area,
    volume_mm3: a.volume,
    projected_area_mm2: a.projectedArea,
    pull_direction: a.pullDir,
    pull_axis_label: formatPullAxis(a.pullAxis, a.pullDir),
    mould_type: a.moldType,
    effective_min_draft_deg: a.minDraft,
    sidewall_area_under_min_draft_pct: a.sidePctUnderMin,
    /* Where the measurement came from. A B-rep source is measured per face
       and a mesh source can only be measured statistically, so the same part
       through the two doors produces different — not contradictory — records,
       and a consumer comparing two exports needs to know which it has. */
    measured_from: a.measuredFrom || 'mesh',
    /* The named faces, present only on a B-rep source. Deliberately the
       summary and the worst offenders rather than every face: a real part has
       thousands, and a JSON record that lists them all is one nobody opens. */
    draft_by_face: a.faceDraft ? {
      face_count: a.faceDraft.faceCount,
      side_face_count: a.faceDraft.sideFaceCount,
      under_min_count: a.faceDraft.underMinCount,
      under_min_area_pct: a.faceDraft.underMinAreaPct,
      curved_side_count: a.faceDraft.curvedSideCount,
      worst: a.faceDraft.worst.map((f) => ({
        face_id: f.faceId,
        body_id: f.bodyId,
        /* null on a curved face, where one angle would be a fiction; the
           range is always given. */
        draft_deg: f.draftDeg,
        draft_range_deg: [f.draftMinDeg, f.draftMaxDeg],
        planar: f.planar,
        side: f.side,
        side_area_pct: f.areaPct,
      })),
    } : null,
    /* The cylindrical features, where there were faces to fit them to. Radii
       are fitted rather than read — the reader carries no surface type — so a
       corner modelled dead sharp has no face and cannot appear. An empty
       fillet list does not mean "no sharp corners". */
    features: a.features ? {
      fillets: a.features.fillets.map(featureRow),
      rounds: a.features.rounds.map(featureRow),
      bores: a.features.bores.map(featureRow),
      bosses: a.features.bosses.map(featureRow),
      cylinder_count: a.features.cylinderCount,
      unfitted_face_count: a.features.unfittedCount,
    } : null,
    wall_median_mm: a.wallStats.median,
    wall_p25_mm: a.wallStats.p25,
    wall_p75_mm: a.wallStats.p75,
    wall_iqr_ratio: a.wallStats.p75 / Math.max(0.01, a.wallStats.p25),
    wall_cv_raw: a.wallStats.cv,
    wall_cv_robust: a.wallStats.cvRobust,
    wall_samples: a.wallStats.n,
    wall_median_ci95_mm: (a.wallStats.medLo != null) ? [a.wallStats.medLo, a.wallStats.medHi] : null,
    /* Second, independent thickness estimate: the largest sphere that fits
       inside the solid at each sampled point. Equal to the ray figure on
       parallel walls, lower wherever they are not. */
    wall_sphere_median_mm: a.sphereStats ? a.sphereStats.median : null,
    wall_sphere_over_ray: a.wallMethod ? a.wallMethod.ratio : null,
    weld: a.weld || null,
    thickness_sample_coverage: a.thicknessCoverage,
    sink_moderate_area_pct: a.sinkPctModerate,
    sink_severe_area_pct: a.sinkPctSevere,
    slide_area_mm2: a.slideArea,
    lifter_area_mm2: a.lifterArea,
    flow: a.flowAnalysis ? {
      gate: a.flowAnalysis.gate,
      max_flow_mm: a.flowAnalysis.maxFlow,
      max_lt: a.flowAnalysis.maxLT,
      lt_limit: a.flowAnalysis.ltMax,
      area_over_limit_pct: a.flowAnalysis.pctOverLT,
      weld_line_candidates: a.flowAnalysis.weldCandidates,
    } : null,
    /* Where the gate should go, when none was picked. The flow figures above
       are hostage to gate position, so a record without this is missing the
       most consequential input to them. */
    gate_search: a.gateSuggestion ? {
      positions_tried: a.gateSuggestion.considered,
      eligible_faces: a.gateSuggestion.eligible,
      best: {
        point: a.gateSuggestion.best.point,
        max_lt: a.gateSuggestion.best.maxLT,
        max_flow_mm: a.gateSuggestion.best.maxFlow,
        area_over_limit_pct: a.gateSuggestion.best.pctOverLT,
      },
      candidates: a.gateSuggestion.candidates.map((c) => ({
        point: c.point,
        max_lt: c.maxLT,
        max_flow_mm: c.maxFlow,
        area_over_limit_pct: c.pctOverLT,
      })),
    } : null,
    wall_transitions: (a.wallTransitions || []).slice(0, 50),
    undercut_regions: (a.undercutRegions || []).filter((r) => r.area > 1).map((r) => ({
      /* The reference a DFM response can be written against. Derived from
         where the feature is, not from its position in this list — see
         src/rules/findings.js. */
      id: r.id,
      type: r.type === 1 ? 'slide' : 'lifter',
      area_mm2: r.area,
      tri_count: r.triCount,
      bbox: r.bbox,
      centroid: r.centroid,
      action_direction: r.action,
      stroke_mm: r.stroke,
      perp_axis: r.perpAxis,
      perp_stroke_mm: r.perpStroke,
      pull_travel_mm: r.pullTravel,
      lifter_angle_deg: r.lifterAngleDeg,
    })),
  };
}

export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  /* Revoking synchronously can race the download in Firefox. */
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
