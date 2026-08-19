import { formatPullAxis } from '../analysis/stats.js';

/*
 * PDF report.
 *
 * jsPDF is fetched on first export rather than on page load — it is ~350 kB
 * that most sessions never touch, and loading it eagerly delayed the first
 * paint of a tool whose primary job is to show a 3D part quickly.
 *
 * Layout is driven by a small cursor helper. The original repeated
 * `if (y > 260) { doc.addPage(); y = 18; }` at every section, with a
 * different threshold each time, so long content could overrun the footer.
 */

const JSPDF_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

const PAGE_W = 210;
const MARGIN = 14;
const FOOTER_Y = 290;
const CONTENT_BOTTOM = 275;

let jsPdfPromise = null;

function loadJsPDF() {
  if (jsPdfPromise) return jsPdfPromise;
  jsPdfPromise = new Promise((resolve, reject) => {
    if (window.jspdf && window.jspdf.jsPDF) { resolve(window.jspdf.jsPDF); return; }
    const s = document.createElement('script');
    s.src = JSPDF_CDN;
    s.onload = () => {
      if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
      else reject(new Error('PDF library loaded but did not register'));
    };
    s.onerror = () => reject(new Error('Could not load the PDF library. Check your connection, or use JSON export which works offline.'));
    document.head.appendChild(s);
  });
  jsPdfPromise.catch(() => { jsPdfPromise = null; });
  return jsPdfPromise;
}

/* Cursor over the document: tracks y, breaks pages, and keeps the caller
   from having to think about either. */
function makeCursor(doc) {
  let y = 18;
  return {
    get y() { return y; },
    set y(v) { y = v; },
    /* Ensure `needed` mm of room remains, starting a page if not. */
    space(needed) {
      if (y + needed > CONTENT_BOTTOM) { doc.addPage(); y = 18; return true; }
      return false;
    },
    advance(mm) { y += mm; },
    heading(text) {
      this.space(14);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(10, 14, 12);
      doc.text(text, MARGIN, y);
      y += 5;
      doc.setLineWidth(0.2);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y);
      y += 4;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
    },
    /* A wrapped run of body text, broken across pages a line at a time so a
       long paragraph never overflows the footer. */
    paragraph(text, size = 8.5) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(size);
      doc.setTextColor(10, 14, 12);
      const lines = doc.splitTextToSize(stripMarkup(text), PAGE_W - 2 * MARGIN);
      for (const line of lines) {
        this.space(6);
        doc.text(line, MARGIN, y);
        y += 4;
      }
      y += 2;
    },
    /* Two-column label/value rows. */
    pairs(rows, labelWidth = 46) {
      doc.setFontSize(9);
      for (let i = 0; i < rows.length; i += 2) {
        this.space(6);
        for (let col = 0; col < 2 && i + col < rows.length; col++) {
          const [label, value] = rows[i + col];
          const x = MARGIN + col * 95;
          doc.setFont('helvetica', 'normal');
          doc.text(`${label}:`, x, y);
          doc.setFont('helvetica', 'bold');
          doc.text(String(value), x + labelWidth, y);
        }
        y += 6;
      }
      doc.setFont('helvetica', 'normal');
      y += 2;
    },
  };
}

const STATUS_COLOUR = {
  fail: [185, 28, 28],
  warn: [217, 119, 6],
  ok: [31, 111, 67],
};

function writeChecks(doc, cur, checks) {
  for (const c of checks) {
    cur.space(20);
    const col = STATUS_COLOUR[c.status] || STATUS_COLOUR.ok;

    doc.setFillColor(col[0], col[1], col[2]);
    doc.rect(MARGIN, cur.y - 3, 3, 14, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(10, 14, 12);
    doc.text(c.name, MARGIN + 7, cur.y + 2);

    doc.setFontSize(8);
    doc.setTextColor(col[0], col[1], col[2]);
    doc.text(c.status.toUpperCase(), PAGE_W - MARGIN, cur.y + 2, { align: 'right' });
    cur.advance(6);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(10, 14, 12);
    const lines = doc.splitTextToSize(stripMarkup(c.detail), PAGE_W - 2 * MARGIN - 7);
    for (const line of lines) {
      cur.space(5);
      doc.text(line, MARGIN + 7, cur.y);
      cur.advance(4);
    }

    if (c.metrics && c.metrics.length) {
      doc.setFontSize(7.5);
      doc.setTextColor(80, 80, 80);
      const metricLines = doc.splitTextToSize(
        c.metrics.map(([k, v]) => `${k}: ${v}`).join('   ·   '),
        PAGE_W - 2 * MARGIN - 7,
      );
      for (const line of metricLines) {
        cur.space(5);
        doc.text(line, MARGIN + 7, cur.y);
        cur.advance(3.5);
      }
    }
    cur.advance(4);
  }
}

/* Check details carry a little inline HTML for the on-screen panel. */
function stripMarkup(text) {
  return String(text).replace(/<[^>]+>/g, '');
}

export async function exportPDF({ sessionId, dfm, analysis, twoShot, validation, shot, settings }) {
  const jsPDF = await loadJsPDF();
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const r = dfm.result;
  const inp = dfm.input;
  const m = r.material;

  // ── header band ──────────────────────────────────────────────────────────
  doc.setFillColor(10, 14, 12);
  doc.rect(0, 0, PAGE_W, 28, 'F');
  doc.setTextColor(239, 236, 228);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text('OnlyCat DFM', MARGIN, 16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('INJECTION MOULDING DFM REPORT', MARGIN, 22);
  doc.text(
    `SESSION ${sessionId}   ·   ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    PAGE_W - MARGIN, 16, { align: 'right' },
  );

  const cur = makeCursor(doc);
  cur.y = 38;

  // ── score block ──────────────────────────────────────────────────────────
  doc.setFillColor(239, 236, 228);
  doc.setDrawColor(10, 14, 12);
  doc.setLineWidth(0.5);
  doc.rect(MARGIN, cur.y, PAGE_W - 2 * MARGIN, 36, 'FD');
  doc.setTextColor(10, 14, 12);
  doc.setFontSize(8);
  doc.text('MANUFACTURABILITY INDEX', 20, cur.y + 8);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(42);
  doc.text(String(r.score), 20, cur.y + 30);
  doc.setFontSize(11);
  doc.text(r.grade.label, 70, cur.y + 18);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Material: ${m.name}`, 70, cur.y + 25);
  doc.text(`Shrinkage: ${m.shrinkLo}–${m.shrinkHi}%   ·   Warp risk: ${m.warpRisk.toUpperCase()}`, 70, cur.y + 30);
  cur.y += 40;

  /* State the arithmetic on the report itself. A bare index invites the reader
     to treat it as a measurement; saying what it was out of, and how many
     findings were critical, makes it a summary of the findings below. */
  doc.setFontSize(7.5);
  doc.setTextColor(90, 94, 92);
  const criticals = r.criticalCount === 1 ? '1 critical finding' : `${r.criticalCount} critical findings`;
  doc.text(
    `${r.totalDeduction.toFixed(1)} points deducted from a ${r.budget}-point budget across ${r.checks.length} checks · `
    + `${r.criticalCount ? criticals : 'no critical findings'} · a check spends a quarter of its weight on a minor `
    + 'finding, half on a major, all of it on a critical',
    MARGIN, cur.y);
  doc.setTextColor(10, 14, 12);
  cur.y += 8;

  // ── inputs ───────────────────────────────────────────────────────────────
  cur.heading('PART INPUTS');
  cur.pairs([
    ['Nominal wall', `${inp.wallThk} mm`],
    ['Min wall', `${inp.wallMin} mm`],
    ['Max wall', `${inp.wallMax} mm`],
    ['Draft angle', `${inp.draftAngle}°`],
    ['Rib t × h', `${inp.ribThk} × ${inp.ribH} mm`],
    ['Rib base R', `${inp.ribRadius} mm`],
    ['Boss OD × wall', `${inp.bossOD} × ${inp.bossWall} mm`],
    ['Undercuts', inp.hasUndercut === '0' ? 'None' : (inp.hasUndercut === '1' ? 'Slide' : 'Lifter')],
    ['Material', m.name],
    ['Mould type', inp.moldType],
    ['Surface finish', inp.surfaceFinish],
    ['FPC overmould', inp.fpc && inp.fpc.enabled ? `Yes (${inp.fpc.thickness} mm, ${inp.fpc.anchors})` : 'No'],
  ]);

  // ── mesh health ──────────────────────────────────────────────────────────
  // Ahead of the mesh analysis on purpose. Everything in that section is
  // measured on this geometry, so whether the geometry can carry it is the
  // first thing a reader needs, not a footnote after the numbers.
  if (validation) {
    cur.heading('MESH HEALTH');
    const CONF = { high: 'SOUND', reduced: 'ANALYSABLE WITH CAVEATS', unusable: 'NEEDS ATTENTION' };
    cur.pairs([
      ['Verdict', CONF[validation.confidence] || validation.confidence],
      ['Largest dimension', `${validation.maxDim.toFixed(1)} mm`],
      ['Closed surface', validation.closed ? 'Yes' : `No — ${validation.edges.boundary.toLocaleString()} open edges`],
      ['Winding', validation.windingConsistent
        ? (validation.inverted ? 'Consistent but inverted' : 'Consistent')
        : `${validation.edges.inconsistent.toLocaleString()} inconsistent edges`],
      ['Non-manifold edges', validation.edges.nonManifold.toLocaleString()],
      ['Degenerate triangles', validation.degenerate.toLocaleString()],
    ], 50);
    if (validation.issues.length) {
      doc.setFontSize(8.5);
      for (const issue of validation.issues) {
        cur.paragraph(`${issue.level.toUpperCase()} — ${issue.title}: ${issue.detail}`);
      }
    }
  }

  // ── mesh summary ─────────────────────────────────────────────────────────
  if (analysis) {
    cur.heading('MESH ANALYSIS');
    cur.pairs([
      ['Triangles', analysis.triCount.toLocaleString()],
      ['Bounding box', `${analysis.bbox.size.map((v) => v.toFixed(1)).join(' × ')} mm`],
      ['Surface area', `${(analysis.area / 100).toFixed(1)} cm²`],
      ['Volume', `${(analysis.volume / 1000).toFixed(2)} cm³`],
      ['Pull direction', formatPullAxis(analysis.pullAxis, analysis.pullDir)],
      ['Effective min draft', `${analysis.minDraft.toFixed(2)}°`],
      ['Median wall (est)', `${analysis.wallStats.median?.toFixed(2) ?? '—'} mm`],
      ['Bulk wall (p25–p75)', `${analysis.wallStats.p25?.toFixed(2) ?? '—'}–${analysis.wallStats.p75?.toFixed(2) ?? '—'} mm`],
      ['Wall CV (robust)', `${((analysis.wallStats.cvRobust || 0) * 100).toFixed(0)}%`],
      ['Median 95% CI', analysis.wallStats.medLo != null
        ? `${analysis.wallStats.medLo.toFixed(2)}–${analysis.wallStats.medHi.toFixed(2)} mm (n=${analysis.wallStats.n})`
        : '—'],
      ['Sphere-fit wall', analysis.wallMethod
        ? `${analysis.wallMethod.sphereMedian.toFixed(2)} mm (${(analysis.wallMethod.ratio * 100).toFixed(0)}% of ray)`
        : '—'],
      ['Sidewall <min draft', `${analysis.sidePctUnderMin.toFixed(1)}%`],
      ['Sink moderate area', `${analysis.sinkPctModerate.toFixed(1)}%`],
      ['Sink severe area', `${analysis.sinkPctSevere.toFixed(1)}%`],
      ['Slide undercut area', `${analysis.slideArea.toFixed(1)} mm²`],
      ['Lifter undercut area', `${analysis.lifterArea.toFixed(1)} mm²`],
    ], 50);
  }

  // ── moulding estimates ───────────────────────────────────────────────────
  if (shot) {
    cur.heading('MOULDING ESTIMATES');
    cur.pairs([
      ['Part volume', shot.volumeCm3 != null ? `${shot.volumeCm3.toFixed(2)} cm³` : '—'],
      ['Part mass', shot.massG != null ? `${shot.massG.toFixed(1)} g` : '—'],
      ['Projected area', shot.projectedAreaCm2 != null ? `${shot.projectedAreaCm2.toFixed(1)} cm²` : '—'],
      ['Cavity pressure', shot.cavityPressureMPa ? `${shot.cavityPressureMPa.lo}–${shot.cavityPressureMPa.hi} MPa` : '—'],
      ['Clamp force', shot.clampTonnes ? `${shot.clampTonnes.lo.toFixed(0)}–${shot.clampTonnes.hi.toFixed(0)} tonnes` : '—'],
      ['Machine clamp', shot.machineTonnes ? `${shot.machineTonnes} tonnes` : '—'],
    ], 50);
    for (const note of shot.notes) cur.paragraph(note);
  }

  // ── tooling actions ──────────────────────────────────────────────────────
  const sigRegions = analysis && analysis.undercutRegions
    ? analysis.undercutRegions.filter((rr) => rr.area > 1)
    : [];
  if (sigRegions.length) {
    cur.heading('TOOLING ACTIONS');
    doc.setFontSize(8.5);
    for (let idx = 0; idx < Math.min(sigRegions.length, 10); idx++) {
      const rr = sigRegions[idx];
      cur.space(12);
      const isSlide = rr.type === 1;
      const col = isSlide ? [14, 90, 140] : [107, 22, 104];

      doc.setFillColor(col[0], col[1], col[2]);
      doc.rect(MARGIN, cur.y - 3, 3, 10, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(col[0], col[1], col[2]);
      doc.text(`#${idx + 1}  ${isSlide ? 'SLIDE' : 'LIFTER'}`, MARGIN + 7, cur.y + 2);

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(10, 14, 12);
      doc.text(isSlide
        ? `${rr.area.toFixed(1)} mm² · perp stroke ${rr.perpStroke.toFixed(1)} mm · direction ${formatPullAxis(null, rr.action)}`
        : `${rr.area.toFixed(1)} mm² · angle ${rr.lifterAngleDeg.toFixed(1)}° · pull travel ${rr.pullTravel.toFixed(1)} mm`,
      MARGIN + 36, cur.y + 2);
      cur.advance(5);

      doc.setFontSize(7.5);
      doc.setTextColor(80, 80, 80);
      const c = rr.centroid;
      doc.text(`centroid (${c[0].toFixed(1)}, ${c[1].toFixed(1)}, ${c[2].toFixed(1)})`, MARGIN + 7, cur.y);
      cur.advance(5);
      doc.setFontSize(8.5);
    }
    if (sigRegions.length > 10) {
      cur.space(6);
      doc.setFontSize(7.5);
      doc.setTextColor(120, 120, 120);
      doc.text(`+ ${sigRegions.length - 10} further regions — see the JSON export for the full list.`, MARGIN + 7, cur.y);
      cur.advance(6);
    }
    doc.setTextColor(10, 14, 12);
    cur.advance(2);
  }

  // ── checks ───────────────────────────────────────────────────────────────
  cur.heading('DETAILED CHECKS');
  writeChecks(doc, cur, r.checks);

  // ── two-shot ─────────────────────────────────────────────────────────────
  if (twoShot) {
    doc.addPage();
    cur.y = 18;
    cur.heading('TWO-SHOT INTERFACE');
    cur.pairs([
      ['Interface score', `${twoShot.score} — ${twoShot.grade.label}`],
      ['Interface basis', `−${twoShot.totalDeduction.toFixed(1)} of ${twoShot.budget} pts`],
      ['Shot 1 (substrate)', twoShot.mat1.name],
      ['Shot 2 (overmould)', twoShot.mat2.name],
      ['Window type', settings.windowType],
      ['Adhesion', twoShot.compat.adhesion.toUpperCase()],
      ['Interface coverage', twoShot.iface ? `${twoShot.iface.coverPct.toFixed(0)}%` : '—'],
      ['Min overmould', twoShot.iface ? `${twoShot.iface.minThk.toFixed(2)} mm` : '—'],
      ['Avg overmould', twoShot.iface ? `${twoShot.iface.avgThk.toFixed(2)} mm` : '—'],
    ], 50);
    writeChecks(doc, cur, twoShot.checks);
  }

  // ── footer on every page ─────────────────────────────────────────────────
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(120, 120, 120);
    doc.text('OnlyCat DFM — guideline-based DFM analysis. Validate critical dimensions with your moulder.', MARGIN, FOOTER_Y);
    doc.text(`Page ${i} / ${pages}`, PAGE_W - MARGIN, FOOTER_Y, { align: 'right' });
  }

  doc.save(`dfm_report_${sessionId}_${Date.now()}.pdf`);
}
