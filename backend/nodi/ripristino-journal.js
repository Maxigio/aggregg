'use strict';

const { createHash } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TIPI = {
  aziende: ['invita', 'accetta', 'attiva', 'rinnova', 'revoca_azienda'],
  colleghi: ['invita', 'accetta', 'revoca', 'revoca_invito', 'cambia_referente'],
};
const inUso = new WeakSet(), inutilizzabili = new WeakSet();

class ErroreRipristino extends Error {
  constructor(codice) { super(codice); this.codice = codice; this.manuale = true; }
}
const errore = codice => new ErroreRipristino(codice);
const invalido = () => { throw errore('ripristino_journal_non_valido'); };
function oggetto(v, campi) {
  if (!v || ![Object.prototype, null].includes(Object.getPrototypeOf(v))
      || Object.keys(v).length !== campi.length || campi.some(k => !Object.hasOwn(v, k))) invalido();
}
function uuid(v, nullable = false) {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !UUID.test(v)) invalido();
  return v.toLowerCase();
}
function booleano(v) { if (typeof v !== 'boolean') invalido(); return v; }
function sequenza(v) {
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,18}$/.test(v) || BigInt(v) > 9223372036854775807n) invalido();
  return v;
}
// JSON PostgreSQL usa ISO con offset e al massimo sei cifre frazionarie.
// Canonicalizzare senza perdere i microsecondi rende il fingerprint stabile.
function timestamp(v, nullable = false) {
  if (v === null && nullable) return null;
  if (typeof v !== 'string') invalido();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  if (!m) invalido();
  const [anno, mese, giorno, ore, minuti, secondi] = m.slice(1, 7).map(Number);
  const d = new Date(0);
  d.setUTCFullYear(anno, mese - 1, giorno); d.setUTCHours(ore, minuti, secondi, 0);
  if (anno < 1 || d.getUTCFullYear() !== anno || d.getUTCMonth() !== mese - 1
      || d.getUTCDate() !== giorno || ore > 23 || minuti > 59 || secondi > 59
      || (m[8] !== 'Z' && (Number(m[8].slice(1, 3)) > 15 || Number(m[8].slice(4)) > 59))) invalido();
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) invalido();
  const iso = new Date(ms).toISOString();
  if (!/^\d{4}-/.test(iso) || iso.startsWith('0000-')) invalido();
  return iso.replace(/\.\d{3}Z$/, '.' + (m[7] || '').padEnd(6, '0') + 'Z');
}
function validaJournal(input) {
  oggetto(input, ['versione','sequenza','dominio','operazione','tipo','confermata_il',
    'attore','destinatario','invito','azienda','persone']);
  if (input.versione !== 1 || typeof input.dominio !== 'string' || !Object.hasOwn(TIPI, input.dominio)
      || !TIPI[input.dominio].includes(input.tipo)) invalido();
  const a = input.azienda;
  oggetto(a, ['id','nome','attiva','moduli','scadenza','referente','accettata_il','attivata_il']);
  if (typeof a.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id)
      || (a.nome !== null && (typeof a.nome !== 'string' || !a.nome.length || [...a.nome].length > 80
        || a.nome.trim() !== a.nome || /[\x00-\x1f\x7f-\x9f]/.test(a.nome)))
      || !Array.isArray(a.moduli) || a.moduli.length < 1 || a.moduli.length > 2
      || a.moduli.some(v => !['auto','moto'].includes(v)) || new Set(a.moduli).size !== a.moduli.length
      || !Array.isArray(input.persone)) invalido();
  const azienda = { id: a.id, nome: a.nome, attiva: booleano(a.attiva), moduli: [...a.moduli].sort(),
    scadenza: timestamp(a.scadenza), referente: uuid(a.referente, true),
    accettata_il: timestamp(a.accettata_il, true), attivata_il: timestamp(a.attivata_il, true) };
  if (azienda.nome !== null && ((azienda.referente === null) !== (azienda.accettata_il === null)
      || (azienda.attivata_il !== null && (azienda.accettata_il === null
        || azienda.attivata_il < azienda.accettata_il || azienda.scadenza <= azienda.attivata_il))
      || (azienda.attiva && azienda.attivata_il === null))) invalido();
  const persone = input.persone.map(p => {
    oggetto(p, ['id','attiva','epoca','membro']);
    if (!Number.isInteger(p.epoca) || p.epoca < 0 || p.epoca > 2147483647) invalido();
    return { id: uuid(p.id), attiva: booleano(p.attiva), epoca: p.epoca, membro: booleano(p.membro) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(persone.map(p => p.id)).size !== persone.length
      || (azienda.referente !== null && !persone.some(p => p.id === azienda.referente && p.membro))) invalido();
  let invito = null;
  if (input.invito !== null) {
    const i = input.invito;
    oggetto(i, ['id','stato','scadenza','persona']);
    if (!['pending','accettato','revocato'].includes(i.stato)
        || (input.dominio === 'aziende' && i.stato === 'revocato')) invalido();
    invito = { id: uuid(i.id), stato: i.stato, scadenza: timestamp(i.scadenza), persona: uuid(i.persona, true) };
    if ((invito.stato === 'pending' && invito.persona !== null)
        || (invito.stato === 'accettato' && invito.persona === null)) invalido();
  }
  const journal = { versione: 1, sequenza: sequenza(input.sequenza), dominio: input.dominio,
    operazione: uuid(input.operazione), tipo: input.tipo, confermata_il: timestamp(input.confermata_il),
    attore: uuid(input.attore), destinatario: uuid(input.destinatario, true), invito, azienda, persone };
  const json = JSON.stringify(journal);
  if (Buffer.byteLength(json) > 16384) invalido();
  return { journal, json, impronta: createHash('sha256').update(json).digest('hex') };
}

// Solo un client dedicato dell'operatore, su DB separato e senza transazione
// preesistente. Non apre connessioni, non rilascia il client e non ripristina Auth.
// Inviti e operazioni sono metadata dell'audit: il journal non contiene email,
// impronte o risultati necessari a ricreare quelle tabelle operative.
async function applicaJournal({ client, journal: input } = {}) {
  if (!client || typeof client.query !== 'function') throw errore('ripristino_client_non_valido');
  if (inutilizzabili.has(client)) throw errore('ripristino_client_non_utilizzabile');
  if (inUso.has(client)) throw errore('ripristino_client_occupato');
  const { journal: j, json, impronta } = validaJournal(input);
  inUso.add(client);
  let iniziata = false;
  try {
    await client.query('BEGIN'); iniziata = true;
    await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
    await client.query("SET LOCAL timezone = 'UTC'");
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    // ponytail: ripristino offline serializzato; nessuna nuova coda o lock live.
    await client.query("SELECT pg_advisory_xact_lock(724013, 1)");
    let dump;
    try {
      dump = (await client.query('SELECT sequenza::text FROM amr_backup.aziende_sequenza WHERE azienda=$1', [j.azienda.id])).rows[0];
      if (dump) sequenza(dump.sequenza);
    } catch (e) {
      if (e instanceof ErroreRipristino || ['42P01','42703'].includes(e?.code)) throw errore('ripristino_base_non_verificabile');
      throw e;
    }
    const anteDump = !!dump && BigInt(j.sequenza) <= BigInt(dump.sequenza);
    await client.query(`CREATE SCHEMA IF NOT EXISTS amr_ripristino;
      REVOKE ALL ON SCHEMA amr_ripristino FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS amr_ripristino.aziende (
        azienda text PRIMARY KEY, sequenza bigint NOT NULL CHECK (sequenza > 0));
      CREATE TABLE IF NOT EXISTS amr_ripristino.operazioni (
        id uuid PRIMARY KEY, azienda text NOT NULL, sequenza bigint NOT NULL CHECK (sequenza > 0),
        impronta text NOT NULL CHECK (impronta ~ '^[a-f0-9]{64}$'),
        stato text NOT NULL CHECK (stato IN ('applicato','superato')), journal jsonb NOT NULL,
        importata_il timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(azienda,sequenza));
      REVOKE ALL ON ALL TABLES IN SCHEMA amr_ripristino FROM PUBLIC`);
    const op = (await client.query('SELECT impronta,stato FROM amr_ripristino.operazioni WHERE id=$1', [j.operazione])).rows[0];
    if (op) {
      if (op.impronta !== impronta) throw errore('ripristino_operazione_in_conflitto');
      await client.query('COMMIT'); iniziata = false;
      return { stato: anteDump ? 'superato' : op.stato, giaEseguita: true };
    }
    const ultima = (await client.query('SELECT sequenza::text FROM amr_ripristino.aziende WHERE azienda=$1', [j.azienda.id])).rows[0];
    const stessaSequenza = (await client.query('SELECT id FROM amr_ripristino.operazioni WHERE azienda=$1 AND sequenza=$2',
      [j.azienda.id, j.sequenza])).rows[0];
    // Il watermark del dump sopravvive al prune dell'outbox. Il registro offline
    // conserva poi la massima sequenza importata, anche per aziende post-dump.
    const aziendaEsistente = (await client.query('SELECT id FROM amr_accessi.aziende WHERE id=$1', [j.azienda.id])).rows.length > 0;
    if (aziendaEsistente && !ultima && !dump) throw errore('ripristino_base_non_verificabile');
    const precedente = [ultima ? BigInt(ultima.sequenza) : 0n, dump ? BigInt(dump.sequenza) : 0n].reduce((a,b) => a > b ? a : b);
    if (stessaSequenza || (!anteDump && precedente === BigInt(j.sequenza))) throw errore('ripristino_sequenza_in_conflitto');
    const stato = anteDump || BigInt(j.sequenza) < precedente ? 'superato' : 'applicato';
    if (stato === 'applicato') {
      const ids = [...new Set([j.attore, j.destinatario, j.invito?.persona, j.azienda.referente,
        ...j.persone.map(p => p.id)].filter(Boolean))].sort();
      const auth = (await client.query('SELECT id FROM auth.users WHERE id=ANY($1::uuid[]) FOR KEY SHARE', [ids])).rows;
      if (ids.some(id => !auth.some(p => p.id === id))) throw errore('ripristino_identita_mancante');
      // I lock impediscono modifiche fra controllo dei conflitti e sostituzione.
      await client.query('LOCK TABLE amr_accessi.aziende, amr_accessi.persone, amr_accessi.membri IN SHARE ROW EXCLUSIVE MODE');
      const presenti = (await client.query('SELECT id,admin FROM amr_accessi.persone WHERE id=ANY($1::uuid[])',
        [j.persone.map(p => p.id)])).rows;
      if (j.persone.some(p => p.membro && presenti.some(v => v.id === p.id && v.admin))) {
        throw errore('ripristino_appartenenza_in_conflitto');
      }
      const membri = (await client.query('SELECT persona,azienda FROM amr_accessi.membri WHERE persona=ANY($1::uuid[])',
        [j.persone.map(p => p.id)])).rows;
      if (membri.some(p => p.azienda !== j.azienda.id)) throw errore('ripristino_appartenenza_in_conflitto');
      for (const p of j.persone) await client.query(`INSERT INTO amr_accessi.persone(id,attiva,epoca) VALUES($1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET attiva=EXCLUDED.attiva,epoca=greatest(amr_accessi.persone.epoca,EXCLUDED.epoca)`,
      [p.id, p.attiva, p.epoca]);
      const a = j.azienda, valori = [a.id,a.nome,a.attiva,a.moduli,a.scadenza,a.referente,a.accettata_il,a.attivata_il];
      const aggiornata = await client.query(`UPDATE amr_accessi.aziende SET nome=$2,attiva=$3,moduli=$4,
        scadenza=$5,referente=$6,accettata_il=$7,attivata_il=$8 WHERE id=$1`, valori);
      // Evitare INSERT ... ON CONFLICT: il BEFORE INSERT della quota scatta
      // anche per un'azienda esistente quando il DB contiene già dieci aziende.
      if (!aggiornata.rowCount) await client.query(`INSERT INTO amr_accessi.aziende
        (id,nome,attiva,moduli,scadenza,referente,accettata_il,attivata_il) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, valori);
      await client.query('DELETE FROM amr_accessi.membri WHERE azienda=$1', [a.id]);
      for (const p of j.persone.filter(p => p.membro)) await client.query('INSERT INTO amr_accessi.membri(persona,azienda) VALUES($1,$2)', [p.id,a.id]);
    }
    const massima = BigInt(j.sequenza) > precedente ? j.sequenza : String(precedente);
    await client.query(`INSERT INTO amr_ripristino.aziende(azienda,sequenza) VALUES($1,$2)
      ON CONFLICT(azienda) DO UPDATE SET sequenza=greatest(amr_ripristino.aziende.sequenza,EXCLUDED.sequenza)`, [j.azienda.id,massima]);
    await client.query(`INSERT INTO amr_ripristino.operazioni(id,azienda,sequenza,impronta,stato,journal)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [j.operazione,j.azienda.id,j.sequenza,impronta,stato,json]);
    await client.query('COMMIT'); iniziata = false;
    return { stato, giaEseguita: false };
  } catch (e) {
    if (iniziata) {
      try { await client.query('ROLLBACK'); }
      catch { inutilizzabili.add(client); throw errore('ripristino_rollback_non_disponibile'); }
    }
    if (e instanceof ErroreRipristino) throw e;
    throw errore(['23503','23505','23514'].includes(e?.code) ? 'ripristino_vincolo_in_conflitto' : 'ripristino_non_disponibile');
  } finally { inUso.delete(client); }
}

module.exports = { applicaJournal };
