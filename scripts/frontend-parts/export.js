// ─── Export CSV ───────────────────────────────────────────────────────────────
function exportCsv(results) {
  const cell = csvCell;
  const cfg = priceCfgV;
  const conPass = results.some(r => passDi(r) != null);
  // "Corrispondenza": senza, un CSV aperto in foglio di calcolo mette sulla stessa riga un
  // annuncio del modello cercato e uno di un altro modello, e chi ci costruisce sopra un
  // conto non ha modo di accorgersene. Qui non c'e' ingombro: e' una colonna in fondo.
  const cols = ['Fonte', 'Titolo', 'Prezzo (€)', 'Anno', 'KM', 'Carburante', 'Provincia', ...priceExtraHeaders(cfg, conPass), 'Corrispondenza', 'URL'];
  const rows = results.map(r => {
    const pr = vPricing(r.prezzo, passDi(r), r);
    const corr = corrispondenzaDi(r).et;
    return [r.fonte, r.titolo, pr ? Math.round(pr.finale) : '', r.anno != null ? r.anno : '', r.km != null ? r.km : '', r.carburante || '', r.provincia || '', ...priceExtraValues(pr, cfg, conPass), corr, r.url].map(cell).join(',');
  });
  const csv = [cols.join(','), ...rows].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `automotoradar-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ─── Export PDF ───────────────────────────────────────────────────────────────
function exportPdf(results) {
  /**
   * IL DISEGNO LO FA IL SERVER, non questa funzione.
   *
   * Qui c'erano centoventi righe che ridisegnavano lo stesso documento di
   * `backend/report-pdf.js`: due implementazioni dello stesso PDF, gia' divergenti (questa
   * aveva le colonne dei prezzi finali e una striscia di metriche calcolata su valori
   * diversi). Restava solo da aspettare che una correzione toccasse una sola delle due.
   *
   * Quello che il server NON puo' sapere sono i prezzi finali — commissione, spese, margine,
   * passaggio e IVA vivono nelle preferenze del browser — quindi le righe si compongono qui e
   * si spediscono gia' fatte. La marcatura di corrispondenza viaggia con loro: e' il motivo
   * per cui prima nel PDF una riga "altro modello" e una giusta erano identiche.
   */
  const cfg = priceCfgV;
  const conPass = results.some(r => passDi(r) != null);
  const extraH = priceExtraHeaders(cfg, conPass);
  const fmtEur = n => '\u20ac ' + n.toLocaleString('it-IT');
  // Il prezzo lo dice l'INTESTAZIONE, non una riga di legenda sopra la tabella: se i tuoi
  // conti (commissione, spese, margine, IVA) sono attivi, quella colonna non e' il prezzo
  // dell'annuncio ed e' giusto che il nome della colonna lo dica.
  const conConti = extraH.length > 0 || cfg.comm || cfg.spese || cfg.iva;
  const colonne = ['Fonte', 'Veicolo', conConti ? 'Prezzo finale' : 'Prezzo', 'Anno', 'Km', 'Carburante', 'Provincia', ...extraH, 'Corrispondenza'];
  const righe = results.map(r => {
    const pr = vPricing(r.prezzo, passDi(r), r);
    return [
      ' ',                                   // la cella della fonte la disegna il server (chip)
      r.titolo,
      pr ? fmtEur(Math.round(pr.finale)) : '-',
      r.anno != null ? String(r.anno) : '-',
      r.km != null ? r.km.toLocaleString('it-IT') + ' km' : '-',
      r.carburante || '-',
      r.provincia || '-',
      ...priceExtraValues(pr, cfg, conPass).map(x => x === '' ? '-' : fmtEur(x)),
      // Come nel CSV: il PDF viaggia da solo, e una smentita non puo' uscire \u00abcorrisponde\u00bb.
      corrispondenzaDi(r).et,
    ];
  });
  scaricaPdf({
    params: lastSearchParams || {},
    colonne, righe,
    fonti: results.map(r => r.fonte),
    nome: `automotoradar-${new Date().toISOString().slice(0, 10)}.pdf`,
  });
}
