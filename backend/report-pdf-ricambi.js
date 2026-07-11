'use strict';
// Report PDF ricambi server-side — fork di report-pdf.js per la pipeline parti.
// Colonne parti (Fonte/Ricambio/Marca/Prezzo/Venditore), niente metriche anno/km.
// Usato dal bot WhatsApp per rispondere a un codice OE/OEM/OEN con un PDF multi-fonte.
const { jsPDF } = require('jspdf');
require('jspdf-autotable');

const FONTE_LABEL = { autodoc: 'Autodoc', web: 'Web', subito: 'Subito' };
const FONTE_COLORS = {
  autodoc: { fill: [224, 236, 255], text: [31, 111, 235] },
  web: { fill: [225, 243, 232], text: [17, 122, 55] },
  subito: { fill: [231, 240, 253], text: [19, 87, 196] },
};

const priceNum = a => (typeof a.prezzo === 'number' ? a.prezzo : null);

// articoli: [{ fonte, nome, marca, prezzo(num|null), venditore, ... }]
// meta: { oen, tipoPezzo, veicoli }  → Buffer (PDF A4 landscape)
function renderRicambiPdf(articoli, meta = {}) {
  articoli = Array.isArray(articoli) ? articoli : [];
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const INK = [20, 24, 31], ACCENT = [31, 111, 235], SLATE = [91, 100, 114];
  const LINE = [210, 216, 222], WHITE = [255, 255, 255], ZEBRA = [247, 248, 250];
  const fmtEur = n => '€ ' + n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Header band
  doc.setFillColor(...INK); doc.rect(0, 0, pageW, 24, 'F');
  doc.setFillColor(...ACCENT); doc.rect(14, 8, 7, 7, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...WHITE); doc.text('AUTO MOTO RADAR — Ricambi', 25, 13.5);
  const crit = [[meta.tipoPezzo, meta.veicoli].filter(Boolean).join(' · '), meta.oen ? 'OE/OEM ' + meta.oen : null].filter(Boolean).join('   ·   ');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(170, 185, 210);
  doc.text((crit + '   ·   ' + today).slice(0, 150), 25, 19);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...WHITE); doc.text(articoli.length + ' ricambi', pageW - 14, 14, { align: 'right' });

  // ── Striscia metriche prezzo
  const prices = articoli.map(priceNum).filter(p => p != null && p > 0).sort((a, b) => a - b);
  const mid = prices.length / 2;
  const metrics = [
    ['MIN', prices.length ? fmtEur(prices[0]) : '—'],
    ['MEDIANA', prices.length ? fmtEur(prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[Math.floor(mid)]) : '—'],
    ['MAX', prices.length ? fmtEur(prices[prices.length - 1]) : '—'],
    ['CON PREZZO', `${prices.length}/${articoli.length}`],
  ];
  const stripY = 31, colW = (pageW - 28) / metrics.length;
  metrics.forEach(([label, val], i) => {
    const x = 14 + i * colW;
    if (i > 0) { doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(x, stripY - 1, x, stripY + 7); }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...SLATE); doc.text(label, x + 4, stripY + 1.5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK); doc.text(String(val), x + 4, stripY + 7);
  });

  // ── Tabella
  const body = articoli.map(a => [FONTE_LABEL[a.fonte] || a.fonte, a.nome || '—', a.marca || '—', priceNum(a) != null ? fmtEur(a.prezzo) : (a.fonte === 'subito' ? 'trattabile' : '—'), a.venditore || (a.fonte === 'autodoc' ? 'Autodoc' : '—')]);
  doc.autoTable({
    startY: stripY + 12,
    head: [['Fonte', 'Ricambio', 'Marca', 'Prezzo', 'Venditore']],
    body,
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: { top: 2.6, right: 3, bottom: 2.6, left: 3 }, valign: 'middle', overflow: 'ellipsize' },
    headStyles: { fillColor: INK, textColor: WHITE, fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: { 0: { halign: 'center', cellWidth: 24 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 34 }, 3: { halign: 'right', cellWidth: 30, fontStyle: 'bold', textColor: ACCENT }, 4: { cellWidth: 44 } },
    didParseCell(data) { if (data.section === 'body' && data.column.index === 0) data.cell.text = [' ']; },
    didDrawCell(data) {
      if (data.section !== 'body' || data.column.index !== 0) return;
      const fonte = articoli[data.row.index] && articoli[data.row.index].fonte; const colors = FONTE_COLORS[fonte]; if (!colors) return;
      const cw = data.cell.width - 4, ch = 5, cx = data.cell.x + 2, cy = data.cell.y + (data.cell.height - ch) / 2;
      doc.setFillColor(...colors.fill); doc.roundedRect(cx, cy, cw, ch, 1, 1, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(...colors.text);
      doc.text(FONTE_LABEL[fonte] || fonte, cx + cw / 2, cy + ch / 2 + 0.3, { align: 'center', baseline: 'middle' });
    },
    margin: { left: 14, right: 14 },
  });

  // ── Footer
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(14, pageH - 10, pageW - 14, pageH - 10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...SLATE);
    doc.text('Auto Moto Radar — Ricambi · uso personale', 14, pageH - 5.5);
    doc.text(`Pagina ${i} di ${pageCount}`, pageW - 14, pageH - 5.5, { align: 'right' });
  }
  return Buffer.from(doc.output('arraybuffer'));
}

// stats prezzo per la caption del bot
function ricambiStats(articoli) {
  articoli = Array.isArray(articoli) ? articoli : [];
  const prices = articoli.map(priceNum).filter(p => p != null && p > 0).sort((a, b) => a - b);
  if (!prices.length) return { totale: articoli.length, conPrezzo: 0, min: null, mediana: null, max: null };
  const mid = prices.length / 2;
  const mediana = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[Math.floor(mid)];
  return { totale: articoli.length, conPrezzo: prices.length, min: prices[0], mediana, max: prices[prices.length - 1] };
}

module.exports = { renderRicambiPdf, ricambiStats };

// self-check: `node backend/report-pdf-ricambi.js`
if (require.main === module) {
  const assert = require('node:assert');
  const fake = [
    { fonte: 'autodoc', nome: 'Bloccasterzo TOPRAN', marca: 'TOPRAN', prezzo: 30.99, venditore: 'Autodoc' },
    { fonte: 'subito', nome: 'Serratura Golf usata', marca: null, prezzo: 25, venditore: 'privato' },
    { fonte: 'web', nome: 'Ricambio OE 1K0905851B', marca: null, prezzo: null, venditore: 'ricambi.it' },
  ];
  const buf = renderRicambiPdf(fake, { oen: '1K0905851B', tipoPezzo: 'Bloccasterzo', veicoli: 'VW Golf' });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0, 'buffer vuoto');
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-', 'non è un PDF');
  const s = ricambiStats(fake);
  assert.strictEqual(s.min, 25); assert.strictEqual(s.max, 30.99); assert.strictEqual(s.conPrezzo, 2);
  console.log(`OK — PDF ricambi ${buf.length} byte, stats`, s);
}
