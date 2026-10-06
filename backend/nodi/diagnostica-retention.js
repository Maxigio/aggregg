'use strict';

const SETTE_GIORNI = 7 * 86400000;
const CAP = 10000;
const TABELLE = Object.freeze({ lavori: 'creato', eventi: 'ts' });

function creaRetention({ db, ora }) {
  // Solo metadati aggregati del taglio: nessun filtro, annuncio o identificativo.
  let tagli = null;
  function pulisci() {
    // Anche la preparazione è diagnostica: il chiamante protegge l'intera
    // operazione, così un disco pieno non impedisce l'avvio del centro.
    db.exec("CREATE TABLE IF NOT EXISTS diagnostica_tagli (area TEXT PRIMARY KEY CHECK(area IN ('lavori','eventi')), ultimo_il INTEGER NOT NULL, fino_il INTEGER NOT NULL, righe INTEGER NOT NULL)");
    // Recupera l'evidenza già confermata prima delle scritture: rimane
    // disponibile anche se la pulizia dopo un riavvio viene rifiutata.
    tagli = db.prepare('SELECT area,ultimo_il,fino_il,righe FROM diagnostica_tagli ORDER BY area').all();
    const adesso = ora(), soglia = adesso - SETTE_GIORNI;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [tabella, tempo] of Object.entries(TABELLE)) {
        db.prepare(`DELETE FROM ${tabella} WHERE ${tempo} < ?`).run(soglia);
        // Preserva il comportamento preesistente: un lavoro ancora attivo
        // non viene eliminato dal cap, anche se le righe superano il limite.
        const eccedenti = `rowid NOT IN (SELECT rowid FROM ${tabella} ORDER BY ${tabella === 'eventi' ? 'id' : tempo} DESC LIMIT ${CAP})`
          + (tabella === 'lavori' ? " AND stato NOT IN ('attesa','in_corso')" : '');
        const taglio = db.prepare(`SELECT count(*) AS n, max(${tempo}) AS fino FROM ${tabella} WHERE ${eccedenti}`).get();
        if (taglio.n) {
          db.prepare(`DELETE FROM ${tabella} WHERE ${eccedenti}`).run();
          db.prepare('INSERT INTO diagnostica_tagli(area,ultimo_il,fino_il,righe) VALUES(?,?,?,?) ON CONFLICT(area) DO UPDATE SET ultimo_il=excluded.ultimo_il,fino_il=max(fino_il,excluded.fino_il),righe=excluded.righe')
            .run(tabella, adesso, taglio.fino, taglio.n);
        }
      }
      db.prepare('DELETE FROM diagnostica_tagli WHERE fino_il < ?').run(soglia);
      const nuove = db.prepare('SELECT area,ultimo_il,fino_il,righe FROM diagnostica_tagli ORDER BY area').all();
      // Il taglio e la sua evidenza sono atomici. Un guasto non può
      // cancellare righe e poi presentare la storia come completa.
      db.exec('COMMIT');
      tagli = nuove;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
  function stato() {
    const validi = (tagli || []).filter(t => t.fino_il >= ora() - SETTE_GIORNI);
    return { giorni: 7, cap: { lavori: CAP, eventi: CAP }, conosciuta: tagli !== null,
      troncata: tagli === null ? null : validi.length > 0,
      tagli: validi.map(t => ({ area: t.area, ultimoIl: t.ultimo_il, finoIl: t.fino_il,
        righeUltimoTaglio: t.righe })), backup: 'download_manuale' };
  }
  return { pulisci, stato };
}

module.exports = { creaRetention };
