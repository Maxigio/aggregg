'use strict';
/**
 * L'UNICO POSTO DOVE SI DISEGNA UN PDF DI AMR.
 *
 * Il layout condiviso col frontend ha header con
 * logo, riga dei criteri, tabella con la pastiglia della fonte, piede numerato.
 *
 * Chi chiama porta cio' che questo file non puo' sapere:
 *   - `extra.titolo`        l'intestazione
 *   - `extra.sottotitolo`   la riga dei criteri, quando non si ricava da `params`
 *   - `extra.contatore`     il numero in alto a destra
 *   - `extra.colonne/righe` la tabella gia' composta (i prezzi finali li calcola il browser,
 *                           che e' l'unico a conoscere commissione, spese, margine e IVA)
 *   - `extra.fonti`         la fonte di ogni riga, per la pastiglia colorata
 *   - `extra.avvisi`        limiti di lettura/copertura da stampare per intero
 *
 * Il documento non porta statistiche di mercato o una legenda prezzi. Gli avvisi
 * di copertura hanno invece uno spazio dedicato: il sottotitolo si limita a due righe.
 */
const { jsPDF } = require('jspdf');
const { autoTable } = require('jspdf-autotable');
// Come si legge a parole la marcatura di una riga. Il vocabolario che vede l'utente vive nel
// frontend (DICHIARAZIONE in app.js) e arriva qui dentro le righe gia' composte; questa mappa
// serve al percorso che le righe NON le manda — oggi il solo bot WhatsApp, spento.
// ponytail: due mappe, non una, perche' il browser non puo' fare require di un file node.
// Se un giorno servisse davvero condividerla, il posto e' un file servito a entrambi.
const CORRISPONDENZA = {
  'senza-versione': 'versione n.d.',
  'senza-modello': 'modello non dichiarato',
  'altro-modello': 'ALTRO MODELLO',
  'versione-non-verificata': 'versione non verificata',
};

// `sources` non c'e' piu' fra i parametri: il documento non stampa piu' lo stato delle fonti,
// e tenere un argomento che nessuno usa avrebbe fatto credere il contrario a chi lo legge.
function renderReportPdf(results, params = {}, extra = null) {
  results = Array.isArray(results) ? results : [];
  extra = extra || {};
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const now = new Date();
  const data = now.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const ora = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const NAVY = [15, 27, 46], BLUE = [31, 111, 235], INK = [25, 35, 52];
  const SLATE = [94, 108, 130], LINE = [219, 226, 235], PALE = [245, 248, 252];
  const WHITE = [255, 255, 255], ZEBRA = [248, 250, 253], AMBER = [157, 92, 0];
  const fmtEur = n => '€ ' + n.toLocaleString('it-IT');
  const FONTE_LABEL_PDF = {
    subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it',
  };
  const FONTE_COLORS = {
    subito:    { fill: [231, 240, 253], text: [19, 87, 196] },
    autoscout: { fill: [250, 240, 213], text: [138, 97, 0] },
    moto:      { fill: [225, 243, 232], text: [17, 122, 55] },
  };

  const titoloDato = String(extra.titolo || '').trim();
  const titolo = titoloDato || 'Report annunci';
  const nRighe = Array.isArray(extra.righe) ? extra.righe.length : results.length;
  const quante = extra.contatore || `${nRighe} ${nRighe === 1 ? 'annuncio' : 'annunci'}`;
  const p = params || {};
  const ricerca = [p.marca, p.modello].filter(Boolean).join(' ') || 'Ricerca veicolo';
  const criteri = extra.sottotitolo || [
    p.regione ? String(p.regione).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Tutta Italia',
    (p.prezzoMin || p.prezzoMax) ? `Prezzo ${p.prezzoMin || 0}-${p.prezzoMax || 'max'}` : null,
    (p.annoMin || p.annoMax) ? `Anni ${p.annoMin || ''}-${p.annoMax || ''}` : null,
    (p.kmMin || p.kmMax) ? `Km ${p.kmMin || 0}-${p.kmMax || 'max'}` : null,
  ].filter(Boolean).join(' | ');

  const head = Array.isArray(extra.colonne) && extra.colonne.length
    ? extra.colonne
    : ['Fonte', 'Veicolo', 'Prezzo', 'Anno', 'Km', 'Carburante', 'Provincia', 'Corrispondenza'];
  const tableBody = Array.isArray(extra.righe)
    ? extra.righe
    : results.map(r => [FONTE_LABEL_PDF[r.fonte] || r.fonte, r.titolo, r.prezzo != null ? fmtEur(r.prezzo) : '-', r.anno != null ? String(r.anno) : '-', r.km != null ? r.km.toLocaleString('it-IT') + ' km' : '-', r.carburante || '-', r.provincia || '-', CORRISPONDENZA[r.dichiarazione] || 'corrisponde']);
  const fontiRiga = Array.isArray(extra.fonti) ? extra.fonti : results.map(r => r.fonte);
  const conteggi = fontiRiga.reduce((m, f) => { if (f) m[f] = (m[f] || 0) + 1; return m; }, {});
  const colCorr = head.findIndex(h => /corrispondenza/i.test(String(h)));

  const logo = (x, y, lato) => {
    const s = lato / 32, cx = x + 16 * s, cy = y + 16 * s;
    doc.setFillColor(...BLUE); doc.roundedRect(x, y, lato, lato, 6 * s, 6 * s, 'F');
    doc.setDrawColor(191, 219, 254); doc.setLineWidth(1.8 * s);
    doc.circle(cx, cy, 10 * s, 'S'); doc.circle(cx, cy, 5.5 * s, 'S');
    doc.setFillColor(191, 219, 254); doc.circle(cx, cy, 1.8 * s, 'F');
    doc.setLineWidth(1.5 * s); doc.line(cx, y + 6 * s, cx, y + 3.5 * s); doc.line(x + 26 * s, cy, x + 28.5 * s, cy);
  };

  const drawFirstPage = () => {
    doc.setFillColor(...NAVY); doc.rect(0, 0, pageW, 29, 'F');
    logo(14, 7, 11);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(151, 173, 207);
    doc.text('AUTO MOTO RADAR', 29, 11.5);
    doc.setFontSize(16); doc.setTextColor(...WHITE); doc.text(titolo, 29, 21);
    doc.setFontSize(15); doc.text(quante, pageW - 14, 15, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(176, 193, 218);
    doc.text(`${data} | ${ora}`, pageW - 14, 21, { align: 'right' });

    doc.setFillColor(...PALE); doc.roundedRect(14, 35, pageW - 28, 20, 2, 2, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...BLUE); doc.text('RICERCA', 19, 41);
    doc.setFontSize(12); doc.setTextColor(...INK); doc.text(ricerca, 19, 48);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...SLATE);
    const righeCriteri = doc.splitTextToSize(criteri || 'Nessun filtro aggiuntivo', pageW - 135);
    doc.text(righeCriteri.slice(0, 2), 91, 43.5);

    let x = 14;
    for (const [fonte, n] of Object.entries(conteggi)) {
      const et = `${FONTE_LABEL_PDF[fonte] || fonte}  ${n}`;
      const colori = FONTE_COLORS[fonte] || { fill: [238, 242, 247], text: SLATE };
      const w = Math.max(24, doc.getTextWidth(et) + 9);
      doc.setFillColor(...colori.fill); doc.roundedRect(x, 60, w, 6, 1.4, 1.4, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.8); doc.setTextColor(...colori.text);
      doc.text(et, x + w / 2, 63.8, { align: 'center' });
      x += w + 3;
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...SLATE);
    const nota = 'Esportazione istantanea: gli annunci non vengono archiviati nell\'app.';
    doc.text(nota, pageW - 14, 63.8, { align: 'right' });
  };

  const drawContinuation = () => {
    doc.setFillColor(...NAVY); doc.rect(0, 0, pageW, 17, 'F');
    logo(14, 4.5, 8);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...WHITE);
    doc.text(`AUTO MOTO RADAR  |  ${titolo}`, 26, 9.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(176, 193, 218);
    doc.text(`${ricerca}  |  ${quante}`, 26, 13.5);
    doc.text(data, pageW - 14, 10.5, { align: 'right' });
  };

  const intestazione = () => {
    if (doc.getCurrentPageInfo().pageNumber === 1) drawFirstPage(); else drawContinuation();
  };
  const avvisi = Array.isArray(extra.avvisi) ? extra.avvisi.filter(a => typeof a === 'string' && a.trim()) : [];
  if (avvisi.length) autoTable(doc, {
    startY: 70, body: avvisi.map(a => [a]), theme: 'plain', rowPageBreak: 'avoid',
    styles: { font: 'helvetica', fontSize: 8, textColor: AMBER, fillColor: PALE,
      cellPadding: 2, overflow: 'linebreak' },
    margin: { top: 25, left: 14, right: 14, bottom: 17 },
    willDrawPage: intestazione,
  });
  autoTable(doc, {
    startY: avvisi.length ? doc.lastAutoTable.finalY + 4 : 70,
    head: [head],
    body: tableBody,
    theme: 'plain',
    showHead: 'everyPage',
    styles: { font: 'helvetica', fontSize: 7.4, textColor: INK, cellPadding: { top: 2, right: 2.7, bottom: 2, left: 2.7 }, valign: 'middle', overflow: 'ellipsize', lineColor: LINE, lineWidth: { bottom: 0.08 } },
    headStyles: { fillColor: [25, 58, 105], textColor: WHITE, fontStyle: 'bold', fontSize: 7.2, cellPadding: { top: 2.5, right: 2.7, bottom: 2.5, left: 2.7 } },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: extra.colonneStile
      || { 0: { halign: 'center', cellWidth: 24 }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 26, fontStyle: 'bold', textColor: BLUE }, 3: { halign: 'center', cellWidth: 14 }, 4: { halign: 'right', cellWidth: 24 }, 5: { halign: 'center', cellWidth: 24 }, 6: { halign: 'center', cellWidth: 24 } },
    margin: { top: 25, left: 14, right: 14, bottom: 17 },
    willDrawPage: intestazione,
    didParseCell(cell) {
      if (cell.section !== 'body') return;
      if (cell.column.index === 0 && FONTE_COLORS[fontiRiga[cell.row.index]]) cell.cell.text = [' '];
      if (cell.column.index === colCorr && !/^corrisponde$/i.test(String(cell.cell.raw || ''))) {
        cell.cell.styles.fontStyle = 'bold'; cell.cell.styles.textColor = AMBER;
      }
    },
    didDrawCell(cell) {
      if (cell.section !== 'body' || cell.column.index !== 0) return;
      const fonte = fontiRiga[cell.row.index], colori = FONTE_COLORS[fonte]; if (!colori) return;
      const w = cell.cell.width - 5, h = 5.2, x = cell.cell.x + 2.5, y = cell.cell.y + (cell.cell.height - h) / 2;
      doc.setFillColor(...colori.fill); doc.roundedRect(x, y, w, h, 1.3, 1.3, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.3); doc.setTextColor(...colori.text);
      doc.text(FONTE_LABEL_PDF[fonte] || fonte, x + w / 2, y + h / 2 + 0.2, { align: 'center', baseline: 'middle' });
    },
  });

  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(14, pageH - 10, pageW - 14, pageH - 10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8); doc.setTextColor(...SLATE);
    doc.text('Auto Moto Radar | Report generato su richiesta', 14, pageH - 5.5);
    doc.text(`Pagina ${i} di ${pageCount}`, pageW - 14, pageH - 5.5, { align: 'right' });
  }
  return Buffer.from(doc.output('arraybuffer'));
}

// `reportStats` (min/mediana/media/max/conPrezzo) e' stata tolta insieme alla striscia. Quei
// numeri erano calcolati su tutte le righe indistintamente, e un aggregato costruito su un
// insieme misto e' peggio di nessun aggregato: sembra una misura del mercato e non lo e'.
module.exports = { renderReportPdf };

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
  // Righe e colonne fornite da fuori: e' la strada che usa il frontend.
  const conRighe = renderReportPdf([], { marca: 'Audi' }, {
    colonne: ['Fonte', 'Veicolo', 'Prezzo finale'],
    righe: [[' ', 'Audi A3', '€ 16.000']],
    fonti: ['subito'],
  });
  assert.strictEqual(conRighe.slice(0, 5).toString(), '%PDF-');
  console.log(`OK — PDF ${buf.length} byte`);
}
