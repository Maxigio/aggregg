'use strict';
/**
 * L'UNICO POSTO DOVE SI DISEGNA UN PDF DI AMR.
 *
 * Prima erano tre: questo file (per il bot), `exportPdf` dentro frontend/app.js e
 * `exportPdfRicambi` sempre nel frontend, piu' `report-pdf-ricambi.js` lato server. Quattro
 * copie dello stesso documento, gia' divergenti fra loro. Adesso il layout e' uno: header con
 * logo, riga dei criteri, tabella con la pastiglia della fonte, piede numerato.
 *
 * Chi chiama porta cio' che questo file non puo' sapere:
 *   - `extra.titolo`        l'intestazione ("AUTO MOTO RADAR", "— Ricambi", …)
 *   - `extra.sottotitolo`   la riga dei criteri, quando non si ricava da `params`
 *   - `extra.contatore`     il numero in alto a destra ("128 annunci", "12 ricambi")
 *   - `extra.colonne/righe` la tabella gia' composta (i prezzi finali li calcola il browser,
 *                           che e' l'unico a conoscere commissione, spese, margine e IVA)
 *   - `extra.fonti`         la fonte di ogni riga, per la pastiglia colorata
 *
 * Il documento NON porta ne' statistiche aggregate, ne' lo stato delle fonti, ne' la legenda
 * dei prezzi: erano tre righe di prosa sopra la tabella, e la tabella dice gia' tutto riga
 * per riga.
 */
const { jsPDF } = require('jspdf');
require('jspdf-autotable');   // patcha doc.autoTable sul prototype (verificato Node v26)
// Come si legge a parole la marcatura di una riga. Il vocabolario che vede l'utente vive nel
// frontend (DICHIARAZIONE in app.js) e arriva qui dentro le righe gia' composte; questa mappa
// serve al percorso che le righe NON le manda — oggi il solo bot WhatsApp, spento.
// ponytail: due mappe, non una, perche' il browser non puo' fare require di un file node.
// Se un giorno servisse davvero condividerla, il posto e' un file servito a entrambi.
const CORRISPONDENZA = {
  'senza-versione': 'versione n.d.',
  'senza-modello': 'da verificare',
  'altro-modello': 'ALTRO MODELLO',
  'versione-non-verificata': 'versione non verificata',
};

// `sources` non c'e' piu' fra i parametri: il documento non stampa piu' lo stato delle fonti,
// e tenere un argomento che nessuno usa avrebbe fatto credere il contrario a chi lo legge.
function renderReportPdf(results, params = {}, extra = null) {
  results = Array.isArray(results) ? results : [];
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const INK = [20, 24, 31], ACCENT = [31, 111, 235], SLATE = [91, 100, 114];
  const LINE = [210, 216, 222], WHITE = [255, 255, 255], ZEBRA = [247, 248, 250];
  const fmtEur = n => '€ ' + n.toLocaleString('it-IT');
  // Le fonti dei due documenti stanno nella stessa mappa: il PDF ricambi passa da qui e
  // deve avere le stesse pastiglie di quello dei veicoli, non un secondo insieme di colori.
  const FONTE_LABEL_PDF = {
    subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it',
    autodoc: 'Autodoc', cmsnl: 'CMSNL', ebay: 'eBay', web: 'Web',
  };
  const FONTE_COLORS = {
    subito:    { fill: [231, 240, 253], text: [19, 87, 196] },
    autoscout: { fill: [250, 240, 213], text: [138, 97, 0] },
    moto:      { fill: [225, 243, 232], text: [17, 122, 55] },
    autodoc:   { fill: [237, 233, 254], text: [91, 33, 182] },
    cmsnl:     { fill: [237, 233, 254], text: [91, 33, 182] },
    ebay:      { fill: [254, 240, 240], text: [185, 28, 28] },
    web:       { fill: [241, 245, 249], text: [71, 85, 105] },
  };

  // ── Header band scura full-width
  doc.setFillColor(...INK); doc.rect(0, 0, pageW, 24, 'F');
  /**
   * IL LOGO, non un quadrato colorato. E' lo stesso radar della barra in alto dell'app
   * (frontend/index.html:32): riquadro blu arrotondato, tre cerchi concentrici e due tacche.
   * jsPDF un SVG non lo sa leggere, ma qui bastano sei primitive vettoriali — e a vettori
   * resta nitido a qualunque ingrandimento, cosa che una PNG incorporata non farebbe.
   */
  const logo = (x, y, lato) => {
    const s = lato / 32;                     // il disegno originale sta in una griglia 32×32
    const cx = x + 16 * s, cy = y + 16 * s;
    doc.setFillColor(31, 111, 235);
    doc.roundedRect(x, y, lato, lato, 6 * s, 6 * s, 'F');
    doc.setDrawColor(191, 219, 254);
    doc.setLineWidth(1.8 * s);
    doc.circle(cx, cy, 10 * s, 'S');
    doc.circle(cx, cy, 5.5 * s, 'S');
    doc.setFillColor(191, 219, 254);
    doc.circle(cx, cy, 1.8 * s, 'F');
    doc.setLineWidth(1.5 * s);
    doc.line(cx, y + 6 * s, cx, y + 3.5 * s);         // tacca in alto
    doc.line(x + 26 * s, cy, x + 28.5 * s, cy);       // tacca a destra
  };
  logo(14, 6.5, 11);
  const titolo = (extra && extra.titolo) || 'AUTO MOTO RADAR';
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...WHITE); doc.text(titolo, 29, 13.5);
  const _p = params || {};
  const crit = (extra && extra.sottotitolo) || [
    [_p.marca, _p.modello].filter(Boolean).join(' '),
    _p.regione ? String(_p.regione).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Tutta Italia',
    (_p.prezzoMin || _p.prezzoMax) ? `prezzo ${_p.prezzoMin || 0}-${_p.prezzoMax || 'max'}` : null,
    (_p.annoMin || _p.annoMax) ? `anni ${_p.annoMin || ''}-${_p.annoMax || ''}` : null,
    (_p.kmMin || _p.kmMax) ? `km ${_p.kmMin || 0}-${_p.kmMax || 'max'}` : null,
  ].filter(Boolean).join('   ·   ');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(170, 185, 210);
  doc.text((crit + '   ·   ' + today).slice(0, 150), 29, 19);
  const quante = (extra && extra.contatore) || (results.length + ' annunci');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...WHITE); doc.text(quante, pageW - 14, 14, { align: 'right' });

  /**
   * NIENTE STRISCIA MIN / MEDIANA / MEDIA / MAX, NIENTE RIGA FONTI, NIENTE LEGENDA.
   *
   * La striscia era calcolata su TUTTE le righe — comprese quelle marcate come di un altro
   * modello — quindi descriveva un mercato che non esiste. Le altre due erano prosa: lo stato
   * delle fonti e l'elenco degli aggiustamenti di prezzo occupavano tre righe sopra la tabella
   * senza aggiungere niente che la tabella non dica gia'.
   *
   * Quello che serviva davvero e' rimasto, ma dentro i dati invece che accanto: la colonna
   * "Corrispondenza" dice riga per riga se quell'annuncio e' il veicolo cercato, e
   * l'intestazione della colonna prezzo dice se il numero e' il prezzo dell'annuncio o quello
   * finale coi tuoi conti applicati. Chi legge non deve fidarsi di un riassunto: legge la riga.
   */
  let tavolaY = 31;

  /**
   * LA TABELLA. Le colonne e le righe possono ARRIVARE GIA' FATTE da chi chiama.
   *
   * Serviva a spegnere due gemelli: questo file e `exportPdf` nel frontend disegnavano lo
   * stesso documento con due implementazioni diverse, e quella del browser aveva in piu' le
   * colonne dei prezzi finali (commissione, spese, margine, passaggio) perche' quei conti
   * dipendono da preferenze che vivono nel browser. Adesso il layout e' uno solo: chi ha i
   * conti li fa e manda le righe, chi non li ha lascia fare a `colonneDefault`.
   */
  const head = (extra && Array.isArray(extra.colonne) && extra.colonne.length)
    ? extra.colonne
    : ['Fonte', 'Veicolo', 'Prezzo', 'Anno', 'Km', 'Carburante', 'Provincia', 'Corrispondenza'];
  const tableBody = (extra && Array.isArray(extra.righe))
    ? extra.righe
    : results.map(r => [FONTE_LABEL_PDF[r.fonte] || r.fonte, r.titolo, r.prezzo != null ? fmtEur(r.prezzo) : '—', r.anno != null ? String(r.anno) : '—', r.km != null ? r.km.toLocaleString('it-IT') + ' km' : '—', r.carburante || '—', r.provincia || '—', CORRISPONDENZA[r.dichiarazione] || 'corrisponde']);
  // La fonte di ogni riga serve al chip disegnato a mano: quando le righe arrivano da fuori,
  // arriva anche l'elenco delle fonti nello stesso ordine.
  const fontiRiga = (extra && Array.isArray(extra.fonti)) ? extra.fonti : results.map(r => r.fonte);
  doc.autoTable({
    startY: tavolaY,
    head: [head],
    body: tableBody,
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: { top: 2.6, right: 3, bottom: 2.6, left: 3 }, valign: 'middle', overflow: 'ellipsize' },
    headStyles: { fillColor: INK, textColor: WHITE, fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: ZEBRA },
    // Le larghezze le puo' dettare chi chiama: la tabella dei ricambi ha altre colonne, e
    // costringerla nella griglia dei veicoli era il motivo per cui esisteva un secondo file.
    columnStyles: (extra && extra.colonneStile)
      || { 0: { halign: 'center', cellWidth: 24 }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 26, fontStyle: 'bold', textColor: ACCENT }, 3: { halign: 'center', cellWidth: 14 }, 4: { halign: 'right', cellWidth: 24 }, 5: { halign: 'center', cellWidth: 24 }, 6: { halign: 'center', cellWidth: 24 } },
    didParseCell(data) { if (data.section === 'body' && data.column.index === 0) data.cell.text = [' ']; },   // chip disegnato a mano
    didDrawCell(data) {
      if (data.section !== 'body' || data.column.index !== 0) return;
      const fonte = fontiRiga[data.row.index]; const colors = FONTE_COLORS[fonte]; if (!colors) return;
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

// `reportStats` (min/mediana/media/max/conPrezzo) e' stata tolta insieme alla striscia. Quei
// numeri erano calcolati su tutte le righe indistintamente, e un aggregato costruito su un
// insieme misto e' peggio di nessun aggregato: sembra una misura del mercato e non lo e'.
/**
 * Le colonne del PDF ricambi, nello stesso layout di quello dei veicoli.
 *
 * Sta qui e non in un file suo perche' il file suo era il quarto gemello: stesso header,
 * stesso piede, stessa tabella, scritti un'altra volta. Cambia solo cosa c'e' nelle colonne.
 */
function tabellaRicambi(articoli) {
  const arts = Array.isArray(articoli) ? articoli : [];
  const eur = n => '€ ' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prezzo = a => (typeof a.prezzo === 'number' && a.prezzo > 0 ? eur(a.prezzo)
    : (a.fonte === 'subito' ? 'trattabile' : '—'));
  return {
    colonne: ['Fonte', 'Ricambio', 'Marca', 'Prezzo', 'Venditore'],
    righe: arts.map(a => [' ', a.nome || '—', a.marca || '—', prezzo(a), a.venditore || (a.fonte === 'autodoc' ? 'Autodoc' : '—')]),
    fonti: arts.map(a => a.fonte),
    colonneStile: { 0: { halign: 'center', cellWidth: 24 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 34 }, 3: { halign: 'right', cellWidth: 30, fontStyle: 'bold', textColor: [31, 111, 235] }, 4: { cellWidth: 44 } },
  };
}

module.exports = { renderReportPdf, tabellaRicambi };

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
