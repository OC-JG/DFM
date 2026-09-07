import { formatPullAxis } from '../analysis/stats.js';

/*
 * JSON export — the machine-readable counterpart to the PDF.
 *
 * Includes the two-shot block, which the original omitted: running an
 * overmould analysis and then exporting produced a file with no trace of it.
 */
export function buildExportJSON({ sessionId, dfm, analysis, twoShot, interface: iface, validation, shot, settings }) {
  const out = {
    tool: 'OnlyCat DFM',
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
        coverage_pct: iface.coverPct,
        interface_area_mm2: iface.coverArea,
        min_thickness_mm: iface.minThk,
        avg_thickness_mm: iface.avgThk,
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
