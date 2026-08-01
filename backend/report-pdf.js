'use strict';
// Report PDF server-side — porting 1:1 di exportPdf() (frontend/app.js:1636).
// Stesso layout che l'utente già conosce dal frontend: header scuro + criteri,
// striscia metriche (min/mediana/media/max/con-prezzo), tabella con chip fonte,
// footer per pagina. Usato dal bot WhatsApp per rispondere con il PDF.
//
// Unico refactor vs il frontend: window.jspdf → require, i due global
// (lastSearchParams, results) diventano argomenti, doc.save() → Buffer.
const { jsPDF } = require('jspdf');
require('jspdf-autotable');   // patcha doc.autoTable sul prototype (verificato Node v26)

// results: [{ fonte, titolo, prezzo, anno, km, carburante, provincia }]
// params:  { marca, modello, regione, prezzoMin, prezzoMax, annoMin, annoMax, kmMin, kmMax }
// → Buffer (PDF A4 landscape)
function renderReportPdf(results, params = {}, sources = null) {
  results = Array.isArray(results) ? results : [];
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const INK = [20, 24, 31], ACCENT = [31, 111, 235], SLATE = [91, 100, 114];
  const LINE = [210, 216, 222], WHITE = [255, 255, 255], ZEBRA = [247, 248, 250];
  const fmtEur = n => '€ ' + n.toLocaleString('it-IT');
  const FONTE_LABEL_PDF = { subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it' };
  const FONTE_COLORS = { subito: { fill: [231, 240, 253], text: [19, 87, 196] }, autoscout: { fill: [250, 240, 213], text: [138, 97, 0] }, moto: { fill: [225, 243, 232], text: [17, 122, 55] } };

  // ── Header band scura full-width
  doc.setFillColor(...INK); doc.rect(0, 0, pageW, 24, 'F');
  doc.setFillColor(...ACCENT); doc.rect(14, 8, 7, 7, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...WHITE); doc.text('AUTO MOTO RADAR', 25, 13.5);
  const _p = params || {};
  const crit = [
    [_p.marca, _p.modello].filter(Boolean).join(' '),
    _p.regione ? String(_p.regione).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Tutta Italia',
    (_p.prezzoMin || _p.prezzoMax) ? `prezzo ${_p.prezzoMin || 0}-${_p.prezzoMax || 'max'}` : null,
    (_p.annoMin || _p.annoMax) ? `anni ${_p.annoMin || ''}-${_p.annoMax || ''}` : null,
    (_p.kmMin || _p.kmMax) ? `km ${_p.kmMin || 0}-${_p.kmMax || 'max'}` : null,
  ].filter(Boolean).join('   ·   ');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(170, 185, 210);
  doc.text((crit + '   ·   ' + today).slice(0, 150), 25, 19);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...WHITE); doc.text(results.length + ' annunci', pageW - 14, 14, { align: 'right' });

  // ── Striscia metriche inline
  const prices = results.map(r => r.prezzo).filter(p => p != null && p > 0).sort((a, b) => a - b);
  const mid = prices.length / 2;
  const metrics = [
    ['MIN', prices.length ? fmtEur(prices[0]) : '—'],
    ['MEDIANA', prices.length ? fmtEur(prices.length % 2 === 0 ? Math.round((prices[mid - 1] + prices[mid]) / 2) : prices[Math.floor(mid)]) : '—'],
    ['MEDIA', prices.length ? fmtEur(Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)) : '—'],
    ['MAX', prices.length ? fmtEur(prices[prices.length - 1]) : '—'],
    ['CON PREZZO', `${prices.length}/${results.length}`],
  ];
  const stripY = 31, colW = (pageW - 28) / metrics.length;
  metrics.forEach(([label, val], i) => {
    const x = 14 + i * colW;
    if (i > 0) { doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(x, stripY - 1, x, stripY + 7); }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...SLATE); doc.text(label, x + 4, stripY + 1.5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK); doc.text(String(val), x + 4, stripY + 7);
  });

  /**
   * LO STATO DELLE FONTI, che e' l'unica cosa che permette di fidarsi dei numeri qui sopra.
   * Il PDF e' l'artefatto che resta in mano, e finora era proprio quello che non lo diceva:
   * una fonte bloccata e una fonte che davvero non ha quel modello uscivano identiche, cioe'
   * non uscivano affatto, e MIN/MEDIANA/MEDIA/MAX venivano calcolati su un mercato monco
   * presentato come intero.
   */
  const STATO_LABEL = {
    empty: 'nessun annuncio', blocked: 'bloccata', error: 'errore', timeout: 'non ha risposto in tempo',
    skipped: 'non interrogata', needs_bootstrap: 'sessione da rifare',
  };
  let tavolaY = stripY + 12;
  if (sources && typeof sources === 'object' && Object.keys(sources).length) {
    const voci = Object.entries(sources).map(([f, s]) => {
      const nome = FONTE_LABEL_PDF[f] || f;
      const st = s && s.status;
      if (!st || st === 'ok') return `${nome} ${(s && s.count != null) ? s.count : '—'}`;
      return `${nome}: ${STATO_LABEL[st] || st}`;
    });
    const rotte = Object.values(sources).filter(s => s && s.status && !['ok', 'empty'].includes(s.status));
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...SLATE);
    doc.text('Fonti:   ' + voci.join('   ·   '), 14, tavolaY);
    tavolaY += 4.5;
    if (rotte.length) {
      doc.setFont('helvetica', 'bold'); doc.setTextColor(176, 60, 30);
      doc.text('I numeri qui sopra sono calcolati su un mercato PARZIALE: ' + rotte.length
        + (rotte.length === 1 ? ' fonte non ha risposto.' : ' fonti non hanno risposto.'), 14, tavolaY);
      tavolaY += 4.5;
    }
    tavolaY += 2;
  }

  // ── Tabella pulita + chip fonte
  const tableBody = results.map(r => [FONTE_LABEL_PDF[r.fonte] || r.fonte, r.titolo, r.prezzo != null ? fmtEur(r.prezzo) : '—', r.anno != null ? String(r.anno) : '—', r.km != null ? r.km.toLocaleString('it-IT') + ' km' : '—', r.carburante || '—', r.provincia || '—']);
  doc.autoTable({
    startY: tavolaY,
    head: [['Fonte', 'Veicolo', 'Prezzo', 'Anno', 'Km', 'Carburante', 'Provincia']],
    body: tableBody,
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: { top: 2.6, right: 3, bottom: 2.6, left: 3 }, valign: 'middle', overflow: 'ellipsize' },
    headStyles: { fillColor: INK, textColor: WHITE, fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: { 0: { halign: 'center', cellWidth: 24 }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 26, fontStyle: 'bold', textColor: ACCENT }, 3: { halign: 'center', cellWidth: 14 }, 4: { halign: 'right', cellWidth: 24 }, 5: { halign: 'center', cellWidth: 24 }, 6: { halign: 'center', cellWidth: 24 } },
    didParseCell(data) { if (data.section === 'body' && data.column.index === 0) data.cell.text = [' ']; },   // chip disegnato a mano
    didDrawCell(data) {
      if (data.section !== 'body' || data.column.index !== 0) return;
      const fonte = results[data.row.index]?.fonte; const colors = FONTE_COLORS[fonte]; if (!colors) return;
      const cw = data.cell.width - 4, ch = 5, cx = data.cell.x + 2, cy = data.cell.y + (data.cell.height - ch) / 2;
      doc.setFillColor(...colors.fill); doc.roundedRect(cx, cy, cw, ch, 1, 1, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(...colors.text);
      doc.text(FONTE_LABEL_PDF[fonte] || fonte, cx + cw / 2, cy + ch / 2 + 0.3, { align: 'center', baseline: 'middle' });
    },
    margin: { left: 14, right: 14 },
  });

  // ── Footer per pagina
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(14, pageH - 10, pageW - 14, pageH - 10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...SLATE);
    doc.text('Auto Moto Radar — uso personale', 14, pageH - 5.5);
    doc.text(`Pagina ${i} di ${pageCount}`, pageW - 14, pageH - 5.5, { align: 'right' });
  }
  return Buffer.from(doc.output('arraybuffer'));
}

// Statistiche testuali (min/mediana/media/max) — stesse formule della striscia PDF.
// Usate dal bot per la caption del documento senza ridisegnare il PDF.
function reportStats(results) {
  results = Array.isArray(results) ? results : [];
  const prices = results.map(r => r.prezzo).filter(p => p != null && p > 0).sort((a, b) => a - b);
  if (!prices.length) return { totale: results.length, conPrezzo: 0, min: null, mediana: null, media: null, max: null };
  const mid = prices.length / 2;
  const mediana = prices.length % 2 === 0 ? Math.round((prices[mid - 1] + prices[mid]) / 2) : prices[Math.floor(mid)];
  return {
    totale: results.length,
    conPrezzo: prices.length,
    min: prices[0],
    mediana,
    media: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    max: prices[prices.length - 1],
  };
}

module.exports = { renderReportPdf, reportStats };

// ── self-check (ponytail): `node backend/report-pdf.js` genera un PDF finto e verifica.
if (require.main === module) {
  const assert = require('node:assert');
  const fake = [
    { fonte: 'subito', titolo: 'Audi A3 Sportback', prezzo: 15900, anno: 2018, km: 90000, carburante: 'Diesel', provincia: 'MI' },
    { fonte: 'autoscout', titolo: 'Audi A3 1.6 TDI', prezzo: 17500, anno: 2019, km: 70000, carburante: 'Diesel', provincia: 'RM' },
    { fonte: 'moto', titolo: 'Audi A3 (senza prezzo)', prezzo: null, anno: 2017, km: 120000, carburante: 'Benzina', provincia: 'TO' },
  ];
  const buf = renderReportPdf(fake, { marca: 'Audi', modello: 'A3', annoMin: 2017, annoMax: 2019 });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0, 'buffer vuoto');
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-', 'non è un PDF');
  const s = reportStats(fake);
  assert.strictEqual(s.min, 15900); assert.strictEqual(s.max, 17500);
  assert.strictEqual(s.mediana, 16700); assert.strictEqual(s.conPrezzo, 2); assert.strictEqual(s.totale, 3);
  console.log(`OK — PDF ${buf.length} byte, stats`, s);
}
