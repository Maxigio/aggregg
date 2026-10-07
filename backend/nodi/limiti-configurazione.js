'use strict';

const MASSIMI = Object.freeze({ timeoutMs: 60000, maxPersona: 2, maxTotale: 60 });
const CAMPI = Object.keys(MASSIMI);
const errore = (codice, status) => Object.assign(new Error(codice), { codice, status });
function valida(valori, massimi = MASSIMI) {
  if (!valori || Array.isArray(valori) || Object.keys(valori).length !== CAMPI.length
      || CAMPI.some(k => !Number.isSafeInteger(valori[k]) || valori[k] < 1 || valori[k] > massimi[k])) {
    throw errore('limiti_non_validi', 400);
  }
  return Object.fromEntries(CAMPI.map(k => [k, valori[k]]));
}

function creaConfigurazioneLimiti({ db, iniziali = MASSIMI, ora = Date.now }) {
  // Il file di configurazione può restringere ulteriormente il perimetro Admin.
  const massimi = valida(iniziali);
  db.exec(`CREATE TABLE IF NOT EXISTS limiti_ricerca (
    id INTEGER PRIMARY KEY CHECK(id=1), revisione INTEGER NOT NULL CHECK(revisione>=0),
    timeoutMs INTEGER NOT NULL CHECK(timeoutMs BETWEEN 1 AND 60000),
    maxPersona INTEGER NOT NULL CHECK(maxPersona BETWEEN 1 AND 2),
    maxTotale INTEGER NOT NULL CHECK(maxTotale BETWEEN 1 AND 60));
    CREATE TABLE IF NOT EXISTS limiti_ricerca_audit (
      revisione INTEGER PRIMARY KEY, ts INTEGER NOT NULL, operatore TEXT NOT NULL,
      prima TEXT NOT NULL, dopo TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO limiti_ricerca VALUES(1,0,?,?,?)')
    .run(massimi.timeoutMs, massimi.maxPersona, massimi.maxTotale);
  function stato() {
    const r = db.prepare('SELECT revisione,timeoutMs,maxPersona,maxTotale FROM limiti_ricerca WHERE id=1').get();
    if (!r || !Number.isSafeInteger(r.revisione)) throw errore('limiti_non_disponibili', 503);
    const valori = valida({ timeoutMs: r.timeoutMs, maxPersona: r.maxPersona, maxTotale: r.maxTotale }, massimi);
    return { revisione: r.revisione, valori, massimi: { ...massimi } };
  }
  // Configurazione incompatibile al riavvio: fermarsi, senza rialzare i limiti.
  stato();
  function pulisci() {
    db.prepare('DELETE FROM limiti_ricerca_audit WHERE ts<?').run(ora() - 7 * 86400000);
  }
  function aggiorna(input, operatore) {
    if (!input || Array.isArray(input) || Object.keys(input).length !== 2
        || !Number.isSafeInteger(input.revisione) || input.revisione < 0) {
      throw errore('limiti_non_validi', 400);
    }
    const dopo = valida(input.valori, massimi);
    if (typeof operatore !== 'string' || !/^(locale|[a-f0-9-]{36})$/.test(operatore)) {
      throw errore('operatore_non_valido', 403);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const prima = stato();
      if (prima.revisione !== input.revisione) throw errore('limiti_modificati', 409);
      if (CAMPI.every(k => prima.valori[k] === dopo[k])) { db.exec('COMMIT'); return prima; }
      if (prima.revisione === Number.MAX_SAFE_INTEGER) throw errore('limiti_non_disponibili', 503);
      const ts = ora();
      pulisci();
      if (db.prepare('SELECT count(*) AS n FROM limiti_ricerca_audit').get().n >= 10000) {
        throw errore('audit_limiti_esaurito', 503);
      }
      const revisione = prima.revisione + 1;
      db.prepare('UPDATE limiti_ricerca SET revisione=?,timeoutMs=?,maxPersona=?,maxTotale=? WHERE id=1')
        .run(revisione, dopo.timeoutMs, dopo.maxPersona, dopo.maxTotale);
      db.prepare('INSERT INTO limiti_ricerca_audit VALUES(?,?,?,?,?)')
        .run(revisione, ts, operatore, JSON.stringify(prima.valori), JSON.stringify(dopo));
      db.exec('COMMIT'); return { revisione, valori: dopo, massimi: { ...massimi } };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return { stato, aggiorna, pulisci };
}
module.exports = { creaConfigurazioneLimiti, MASSIMI };
