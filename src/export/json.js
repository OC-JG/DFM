import { formatPullAxis } from '../analysis/stats.js';

/*
 * JSON export — the machine-readable counterpart to the PDF.
 *
 * Includes the two-shot block, which the original omitted: running an
 * overmould analysis and then exporting produced a file with no trace of it.
 */
export function buildExportJSON({ sessionId, dfm, analysis, twoShot, interface: iface, validation, settings }) {
  const out = {
    tool: 'OnlyCat DFM',
    session: sessionId,
    timestamp: new Date().toISOString(),
    mode: settings.analysisMode,
    score: dfm.result.score,
    grade: dfm.result.grade.label,
    material: dfm.result.material.name,
    input: dfm.input,
    checks: dfm.result.checks.map((c) => ({
      key: c.key,
      name: c.name,
      status: c.status,
      detail: c.detail,
      score_deduction: c.scoreDeduction,
      penalty: c.penalty,
      metrics: c.metrics,
    })),
    mesh_summary: analysis ? meshSummary(analysis) : null,
    /* What the geometry was before any of the above was measured on it. A
       consumer of this record should read the confidence first: a score
       derived from an inch-scaled or open mesh is arithmetic, not a
       manufacturability judgement. */
    mesh_health: validation ? meshHealth(validation) : null,
  };

  if (twoShot) {
    out.two_shot = {
      score: twoShot.score,
      grade: twoShot.grade.label,
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
        penalty: c.penalty, metrics: c.metrics,
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

function meshSummary(a) {
  return {
    tris: a.triCount,
    bbox_mm: a.bbox.size,
    surface_area_mm2: a.area,
    volume_mm3: a.volume,
    pull_direction: a.pullDir,
    pull_axis_label: formatPullAxis(a.pullAxis, a.pullDir),
    mould_type: a.moldType,
    effective_min_draft_deg: a.minDraft,
    sidewall_area_under_min_draft_pct: a.sidePctUnderMin,
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
