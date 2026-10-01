'use strict';

const crypto = require('node:crypto');
const SETTE_GIORNI = 7 * 86400000;
const nega = (codice, status = 403) => { throw Object.assign(new Error(codice), { codice, status }); };

// Solo collaudo locale: identità sintetiche, nessuna password o integrazione Nhost.
// Le transazioni SQLite provano questo esperimento, non la concorrenza PostgreSQL.
function creaAccountProva({ db, identita, ora = () => Date.now() }) {
  db.exec(`
    CREATE TABLE persone_prova(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      verificata INTEGER NOT NULL, attiva INTEGER NOT NULL, admin INTEGER NOT NULL,
      mfa INTEGER NOT NULL, epoca INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE aziende_prova(id TEXT PRIMARY KEY, referente TEXT NOT NULL,
      attiva INTEGER NOT NULL, scadenza INTEGER NOT NULL, moduli TEXT NOT NULL);
    CREATE TABLE membri_prova(persona TEXT PRIMARY KEY, azienda TEXT NOT NULL);
    CREATE TABLE inviti_prova(id TEXT PRIMARY KEY, azienda TEXT NOT NULL, email TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE, scadenza INTEGER NOT NULL, stato TEXT NOT NULL);
  `);
  for (const p of identita) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(p.id) || !/^[^\s@]+@[^\s@]+\.invalid$/.test(p.email)) {
      throw new Error('sono ammesse soltanto identità sintetiche .invalid');
    }
    db.prepare('INSERT INTO persone_prova(id,email,verificata,attiva,admin,mfa) VALUES(?,?,?,?,?,?)')
      .run(p.id, p.email.toLowerCase(), Number(p.verificata === true), Number(p.attiva !== false),
        Number(p.admin === true), Number(p.mfa === true));
  }
  const hash = token => crypto.createHash('sha256').update(token).digest('hex');
  function transazione(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function persona(s) {
    const p = typeof s?.persona === 'string'
      ? db.prepare('SELECT * FROM persone_prova WHERE id=?').get(s.persona) : null;
    if (!p || !p.attiva || !p.verificata || p.epoca !== s.epoca) nega('identita_non_autorizzata');
    return p;
  }
  function sessione(id) {
    const p = typeof id === 'string' ? db.prepare('SELECT * FROM persone_prova WHERE id=?').get(id) : null;
    if (!p) nega('identita_non_autorizzata', 401);
    const s = { persona: p.id, epoca: p.epoca, mfaVerificata: p.mfa === 1 };
    persona(s);
    return s;
  }
  function contesto(s, { tipo, admin = false, referente = false, azienda } = {}) {
    const p = persona(s);
    if (admin) {
      if (!p.admin || !p.mfa || s.mfaVerificata !== true) nega('admin_mfa_richiesta');
      return { persona: p.id, admin: true };
    }
    const a = db.prepare(`SELECT a.* FROM aziende_prova a JOIN membri_prova m
      ON m.azienda=a.id WHERE m.persona=?`).get(p.id);
    if (!a || !a.attiva || a.scadenza <= ora()) nega('azienda_non_autorizzata');
    if (azienda !== undefined && azienda !== a.id) nega('azienda_non_autorizzata');
    const moduli = JSON.parse(a.moduli);
    if (tipo !== undefined && !moduli.includes(tipo)) nega('modulo_non_autorizzato');
    if (referente && a.referente !== p.id) nega('referente_richiesto');
    return { persona: p.id, azienda: a.id, moduli, referente: a.referente === p.id };
  }
  function moduliValidi(moduli) {
    if (!Array.isArray(moduli) || !moduli.length || moduli.length > 2
        || moduli.some(m => !['auto', 'moto'].includes(m)) || new Set(moduli).size !== moduli.length) {
      nega('moduli_non_validi', 400);
    }
    return JSON.stringify(moduli);
  }
  function creaAzienda(s, { id, referente, scadenza, moduli }) {
    return transazione(() => {
      contesto(s, { admin: true });
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id || '') || !Number.isSafeInteger(scadenza)
          || scadenza <= ora()) nega('azienda_non_valida', 400);
      const p = db.prepare('SELECT * FROM persone_prova WHERE id=?').get(referente);
      if (!p?.attiva || !p.verificata || p.admin) nega('referente_non_valido', 400);
      if (db.prepare('SELECT 1 FROM membri_prova WHERE persona=?').get(referente)) nega('appartenenza_esistente', 409);
      if (db.prepare('SELECT count(*) AS n FROM aziende_prova').get().n >= 10) nega('quota_aziende', 409);
      db.prepare('INSERT INTO aziende_prova VALUES(?,?,?,?,?)').run(id, referente, 1, scadenza, moduliValidi(moduli));
      db.prepare('INSERT INTO membri_prova VALUES(?,?)').run(referente, id);
      return { ok: true };
    });
  }
  function configuraAzienda(s, { id, scadenza, moduli, attiva }) {
    return transazione(() => {
      contesto(s, { admin: true });
      if (!Number.isSafeInteger(scadenza) || typeof attiva !== 'boolean') nega('azienda_non_valida', 400);
      const n = db.prepare('UPDATE aziende_prova SET scadenza=?,moduli=?,attiva=? WHERE id=?')
        .run(scadenza, moduliValidi(moduli), Number(attiva), id).changes;
      if (!n) nega('azienda_non_trovata', 404);
      return { ok: true };
    });
  }
  function scadiInviti() {
    db.prepare("UPDATE inviti_prova SET stato='scaduto' WHERE stato='pending' AND scadenza<=?").run(ora());
  }
  function invita(s, { email }) {
    return transazione(() => {
      const c = contesto(s, { referente: true });
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.invalid$/.test(email)) nega('email_non_valida', 400);
      email = email.toLowerCase();
      scadiInviti();
      if (db.prepare(`SELECT 1 FROM membri_prova m JOIN persone_prova p ON p.id=m.persona
        WHERE p.email=?`).get(email)) nega('appartenenza_esistente', 409);
      if (db.prepare("SELECT 1 FROM inviti_prova WHERE azienda=? AND email=? AND stato='pending'").get(c.azienda, email)) nega('invito_esistente', 409);
      const membri = db.prepare('SELECT count(*) AS n FROM membri_prova WHERE azienda=?').get(c.azienda).n;
      const inviti = db.prepare("SELECT count(*) AS n FROM inviti_prova WHERE azienda=? AND stato='pending'").get(c.azienda).n;
      if (membri + inviti >= 3) nega('quota_persone', 409);
      const token = crypto.randomBytes(32).toString('hex'), id = crypto.randomUUID();
      db.prepare('INSERT INTO inviti_prova VALUES(?,?,?,?,?,?)')
        .run(id, c.azienda, email, hash(token), ora() + SETTE_GIORNI, 'pending');
      return { id, token };
    });
  }
  function accetta(s, { token }) {
    return transazione(() => {
      const p = persona(s);
      if (p.admin) nega('appartenenza_non_ammessa');
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) nega('invito_non_valido', 400);
      scadiInviti();
      const i = db.prepare("SELECT * FROM inviti_prova WHERE hash=? AND stato='pending'").get(hash(token));
      if (!i || i.email !== p.email) nega('invito_non_valido');
      const a = db.prepare('SELECT * FROM aziende_prova WHERE id=?').get(i.azienda);
      if (!a?.attiva || a.scadenza <= ora()) nega('azienda_non_autorizzata');
      if (db.prepare('SELECT 1 FROM membri_prova WHERE persona=?').get(p.id)) nega('appartenenza_esistente', 409);
      db.prepare('INSERT INTO membri_prova VALUES(?,?)').run(p.id, i.azienda);
      db.prepare("UPDATE inviti_prova SET stato='accettato' WHERE id=?").run(i.id);
      return { ok: true, azienda: i.azienda };
    });
  }
  function revoca(s, { persona: id }) {
    return transazione(() => {
      const c = contesto(s, { referente: true });
      if (id === c.persona) nega('referente_non_revocabile');
      const n = db.prepare('DELETE FROM membri_prova WHERE persona=? AND azienda=?').run(id, c.azienda).changes;
      if (!n) nega('membro_non_trovato', 404);
      db.prepare('UPDATE persone_prova SET epoca=epoca+1 WHERE id=?').run(id);
      return { ok: true };
    });
  }
  function revocaInvito(s, { id }) {
    return transazione(() => {
      const c = contesto(s, { referente: true });
      const n = db.prepare("UPDATE inviti_prova SET stato='revocato' WHERE id=? AND azienda=? AND stato='pending'")
        .run(id, c.azienda).changes;
      if (!n) nega('invito_non_trovato', 404);
      return { ok: true };
    });
  }
  function cambiaReferente(s, { azienda, persona: id }) {
    return transazione(() => {
      contesto(s, { admin: true });
      if (!db.prepare(`SELECT 1 FROM membri_prova m JOIN persone_prova p ON p.id=m.persona
        WHERE m.persona=? AND m.azienda=? AND p.attiva=1 AND p.verificata=1`).get(id, azienda)) {
        nega('referente_non_valido', 400);
      }
      db.prepare('UPDATE aziende_prova SET referente=? WHERE id=?').run(id, azienda);
      return { ok: true };
    });
  }
  return { sessione, contesto, verificaIdentita: s => ({ persona: persona(s).id }),
    creaAzienda, configuraAzienda, invita, accetta, revoca,
    revocaInvito, cambiaReferente };
}

module.exports = { creaAccountProva };
