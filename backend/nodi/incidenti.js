'use strict';
const { randomUUID } = require('node:crypto');
const FONTI = ['subito', 'autoscout', 'moto'];
const NOMI = { nodo_offline: 'Nodo non raggiungibile', worker_fermato: 'Worker fermato manualmente',
  worker_intervento: 'Worker: intervento necessario', fonte_pausa: 'Fonte in pausa',
  sospensione: 'Sospensione manuale', manutenzione: 'Manutenzione globale' };
const SETTIMANA = 7 * 86400000, CAP = 10000;

function creaIncidenti({ db, ora = () => Date.now(), invia = null }) {
  db.exec(`CREATE TABLE IF NOT EXISTS incidenti (
    id TEXT PRIMARY KEY, chiave TEXT NOT NULL, codice TEXT NOT NULL,
    nodo TEXT, fonte TEXT, aperto INTEGER NOT NULL, chiuso INTEGER,
    osservazione INTEGER, avviso TEXT NOT NULL, risoluzione TEXT NOT NULL,
    avviso_http INTEGER, risoluzione_http INTEGER, verificato INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS incidente_aperto ON incidenti(chiave) WHERE chiuso IS NULL;
    CREATE TABLE IF NOT EXISTS incidenti_heartbeat (nodo TEXT PRIMARY KEY, istante INTEGER NOT NULL, boot TEXT);
    CREATE INDEX IF NOT EXISTS incidenti_aperto_il ON incidenti(aperto);`);
  if (!db.prepare('PRAGMA table_info(incidenti)').all().some(c => c.name === 'verificato')) {
    db.exec('ALTER TABLE incidenti ADD COLUMN verificato INTEGER');
  }
  // Un invio in corso al crash può essere arrivato: non ripeterlo automaticamente.
  db.exec("UPDATE incidenti SET avviso='incerto' WHERE avviso='invio'; UPDATE incidenti SET risoluzione='incerto' WHERE risoluzione='invio'");
  const osservati = new Map(db.prepare('SELECT * FROM incidenti_heartbeat').all()
    .map(r => [r.nodo, { ...r, stabileDa: null }]));
  let chiuso = false, spedizione = null, guasto = null;
  function transazione(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (e) {
      if (e.status !== 409) guasto = e.message === 'capacita_incidenti_esaurita' ? e.message : 'registro_incidenti_non_disponibile';
      db.exec('ROLLBACK'); throw e;
    }
  }
  const attuale = chiave => db.prepare('SELECT * FROM incidenti WHERE chiave=? AND chiuso IS NULL').get(chiave);
  function apri(chiave, codice, nodo = null, fonte = null, osservazione = null) {
    const corrente = attuale(chiave);
    if (corrente) return corrente.id;
    // Non cancellare avvisi incerti/aperti per fare posto a nuovi episodi.
    db.prepare("DELETE FROM incidenti WHERE chiuso<? AND avviso IN ('accettato','riconciliato') AND risoluzione IN ('accettato','riconciliata')")
      .run(ora() - SETTIMANA);
    if (db.prepare('SELECT count(*) AS n FROM incidenti').get().n >= CAP) {
      throw new Error('capacita_incidenti_esaurita');
    }
    const id = randomUUID();
    db.prepare("INSERT INTO incidenti(id,chiave,codice,nodo,fonte,aperto,osservazione,avviso,risoluzione) VALUES(?,?,?,?,?,?,?,'pendente','non_necessaria')")
      .run(id, chiave, codice, nodo, fonte, ora(), osservazione);
    return id;
  }
  function termina(chiave) {
    const r = attuale(chiave);
    if (!r) return;
    // La chiusura non cancella l'avviso: anche una sospensione breve va notificata.
    db.prepare("UPDATE incidenti SET chiuso=?,risoluzione='pendente' WHERE id=?")
      .run(ora(), r.id);
  }
  function controllo({ codice, nodo = null, fonte = null, attivo }) {
    const chiave = [codice, nodo || '', fonte || ''].join(':');
    if (attivo) apri(chiave, codice, nodo, fonte); else termina(chiave);
  }
  function supervisione(s) {
    if (s.stato === 'fermato' || s.stato === 'intervento') {
      apri('nodo:' + s.nodo, 'worker_' + s.stato, s.nodo);
    }
  }
  function confermaSupervisione(s) {
    const visto = osservati.get(s.nodo);
    if (visto && s.stato !== 'attivo') visto.stabileDa = null;
  }
  function heartbeat(n) {
    const adesso = ora(), precedente = osservati.get(n.id);
    const continuo = precedente && precedente.boot === (n.boot || null)
      && adesso >= precedente.istante && adesso - precedente.istante < 6000;
    const prossimo = { nodo: n.id, istante: adesso, boot: n.boot || null,
      stabileDa: continuo && precedente.stabileDa !== null ? precedente.stabileDa : adesso };
    transazione(() => {
      // Il timer può non osservare il gap prima del rientro dell'heartbeat.
      if (precedente && adesso - precedente.istante >= 30000) apri('nodo:' + n.id, 'nodo_offline', n.id);
      db.prepare(`INSERT INTO incidenti_heartbeat(nodo,istante,boot) VALUES(?,?,?)
        ON CONFLICT(nodo) DO UPDATE SET istante=excluded.istante,boot=excluded.boot`)
        .run(n.id, adesso, prossimo.boot);
      if (adesso - prossimo.stabileDa >= 15000
          && (!n.supervisione || n.supervisione.boot !== n.boot || n.supervisione.stato === 'attivo')) termina('nodo:' + n.id);
      if (!n.soloStato) for (const fonte of FONTI) {
        const f = n.fonti[fonte];
        if (!f) continue; // Una fonte assente resta sconosciuta.
        const chiave = 'fonte:' + n.id + ':' + fonte;
        if (f.fermo === true) apri(chiave, 'fonte_pausa', n.id, fonte, f.aggiornataIl ?? null);
        else if (f.fermo === false && ['ok', 'vuoto'].includes(f.esito)
            && Number.isSafeInteger(f.aggiornataIl)) {
          const r = attuale(chiave);
          if (r && f.aggiornataIl !== r.osservazione) termina(chiave);
        }
      }
    });
    osservati.set(n.id, prossimo);
  }
  function verifica() {
    if (chiuso) return;
    try {
      transazione(() => {
        for (const n of osservati.values()) if (ora() - n.istante >= 30000) {
          apri('nodo:' + n.nodo, 'nodo_offline', n.nodo);
          n.stabileDa = null;
        }
      });
    } catch { guasto = 'registro_incidenti_non_disponibile'; }
  }
  function payload(r, azione) {
    const status = azione === 'avviso' ? 'alert' : 'resolved';
    return { incident: { id: r.id, status, title: 'AMR · ' + NOMI[r.codice],
      description: [r.codice, r.nodo, r.fonte].filter(Boolean).join(' · '),
      metadata: { codice: r.codice, nodo: r.nodo, fonte: r.fonte,
        aperto: r.aperto, chiuso: r.chiuso } } };
  }
  async function spedisci() {
    if (chiuso || !invia) return;
    // Una sola consegna in corso. Niente retry automatici per esiti falliti/incerti.
    for (let n = 0; n < 20 && !chiuso; n++) {
      const r = db.prepare(`SELECT * FROM incidenti WHERE avviso='pendente'
        OR (risoluzione='pendente' AND avviso IN ('accettato','riconciliato')) ORDER BY aperto,id LIMIT 1`).get();
      if (!r) break;
      const azione = r.avviso === 'pendente' ? 'avviso' : 'risoluzione';
      db.prepare(`UPDATE incidenti SET ${azione}='invio' WHERE id=?`).run(r.id);
      let esito;
      try { esito = await invia(payload(r, azione)); } catch { esito = { stato: 'incerto' }; }
      if (chiuso) break; // Il prossimo startup riconcilia 'invio' come incerto.
      const stato = ['accettato', 'fallito', 'incerto'].includes(esito?.stato) ? esito.stato : 'incerto';
      const http = Number.isInteger(esito?.http) && esito.http >= 100 && esito.http <= 599 ? esito.http : null;
      db.prepare(`UPDATE incidenti SET ${azione}=?,${azione}_http=? WHERE id=?`).run(stato, http, r.id);
    }
  }
  function scarica() {
    if (spedizione || chiuso) return spedizione || Promise.resolve();
    spedizione = spedisci().catch(() => { guasto = 'registro_incidenti_non_disponibile'; })
      .finally(() => { spedizione = null; });
    return spedizione;
  }
  function stato(nodo = null, richiestaPagina = 1) {
    const totale = db.prepare('SELECT count(*) AS n FROM incidenti').get().n;
    const filtrati = nodo ? db.prepare('SELECT count(*) AS n FROM incidenti WHERE nodo=?').get(nodo).n : totale;
    const pagine = Math.max(1, Math.ceil(filtrati / 30));
    const pagina = Number.isSafeInteger(richiestaPagina) && richiestaPagina > 0 ? Math.min(richiestaPagina, pagine) : 1;
    return { configurato: !!invia, guasto: totale >= CAP ? 'capacita_incidenti_esaurita' : guasto, capacita: CAP, totale, pagina, pagine,
      riepilogo: db.prepare('SELECT avviso AS stato,count(*) AS n FROM incidenti GROUP BY avviso').all(),
      episodi: nodo ? db.prepare('SELECT * FROM incidenti WHERE nodo=? ORDER BY aperto DESC,id LIMIT 30 OFFSET ?').all(nodo, (pagina - 1) * 30)
        : db.prepare('SELECT * FROM incidenti ORDER BY aperto DESC,id LIMIT 30 OFFSET ?').all((pagina - 1) * 30) };
  }
  function riconcilia(id, azione) {
    const r = db.prepare('SELECT * FROM incidenti WHERE id=?').get(id);
    if (!r || !['presente','risolto'].includes(azione) || r.avviso === 'invio' || r.risoluzione === 'invio'
        || (azione === 'presente' && !['incerto','fallito'].includes(r.avviso))
        || (azione === 'risolto' && (r.chiuso === null || !['incerto','fallito','accettato','riconciliato'].includes(r.avviso)))) {
      throw Object.assign(new Error('riconciliazione_non_ammessa'), { status: 409 });
    }
    // Conferma esplicita dell'Admin, distinta dalla ricevuta HTTP; mai reinviare l'avviso.
    db.prepare(`UPDATE incidenti SET avviso=CASE WHEN avviso IN ('incerto','fallito') THEN 'riconciliato' ELSE avviso END,
      risoluzione=?,verificato=? WHERE id=?`)
      .run(azione === 'risolto' ? 'riconciliata' : r.chiuso === null ? r.risoluzione : 'pendente', ora(), id);
  }
  return { transazione, controllo, supervisione, confermaSupervisione, heartbeat, verifica, scarica, stato, riconcilia,
    close: () => { chiuso = true; } };
}
module.exports = { creaIncidenti };
