'use strict';
const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const CODICI = new Map([
  ['input_non_valido', 400], ['accesso_non_autorizzato', 403], ['sessione_revocata', 403],
  ['invito_non_valido', 403], ['collega_non_valido', 403], ['azienda_non_pronta', 409],
  ['operazione_in_conflitto', 409], ['invito_esistente', 409], ['appartenenza_esistente', 409],
  ['quota_persone', 409], ['quota_aziende', 409], ['operazione_non_disponibile', 503],
]);
const errore = codice => Object.assign(new Error(codice), { codice, status: CODICI.get(codice) });
const valido = (regex, value) => typeof value === 'string' && regex.test(value);
const impronta = token => {
  if (!valido(TOKEN, token)) throw errore('invito_non_valido');
  return crypto.createHash('sha256').update(token).digest('hex');
};

// Un'istanza per pool server limitato, con statement_timeout/lock_timeout.
// session SOLO da login.sessione(req); providerUUID SOLO da login del provider.
// Non gestisce proprie sessioni, cookie, SMTP o lifecycle del processo principale.
function creaColleghiPostgres({ pool }) {
  if (!pool || typeof pool.query !== 'function') throw errore('operazione_non_disponibile');
  let inAttesa = 0;
  const sessione = s => {
    if (!s || !valido(UUID, s.persona) || !Number.isInteger(s.epoca)
      || s.epoca < 0 || s.epoca > 2147483647 || typeof s.mfa !== 'boolean') {
      throw errore('accesso_non_autorizzato');
    }
    return [s.persona, s.epoca, s.mfa];
  };
  const operazione = input => {
    if (!input || !valido(UUID, input.operazione) || !valido(ID, input.id)) throw errore('input_non_valido');
    return [input.operazione, input.id];
  };
  async function esegui(sql, params) {
    if (inAttesa >= 32) throw errore('operazione_non_disponibile');
    inAttesa++;
    try {
      // Una funzione SQL = una transazione implicita. Nessun BEGIN/COMMIT su pool
      // differenti, nessun retry automatico dopo un timeout con esito incerto.
      const r = await pool.query(sql, params);
      if (!r.rows?.[0]?.risultato || typeof r.rows[0].risultato !== 'object') {
        throw errore('operazione_non_disponibile');
      }
      return r.rows[0].risultato;
    } catch (e) {
      throw errore(e?.code === 'P0001' && CODICI.has(e.message) ? e.message : 'operazione_non_disponibile');
    } finally { inAttesa--; }
  }
  async function modifica(s, input, tipo) {
    const params = [...sessione(s), ...operazione(input), tipo];
    let token;
    if (tipo === 'invita') {
      if (typeof input.email !== 'string' || input.email.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || /[\u0000-\u001f\u007f]/.test(input.email)) {
        throw errore('input_non_valido');
      }
      token = crypto.randomBytes(32).toString('hex');
      params.push(null, input.email.toLowerCase(), impronta(token));
    } else {
      const target = tipo === 'revoca_invito' ? input.invito : input.persona;
      if (!valido(UUID, target)) throw errore('input_non_valido');
      params.push(target, null, null);
    }
    const out = await esegui('SELECT amr_accessi.colleghi_scrivi($1::uuid,$2::integer,$3::boolean,'
      + '$4::uuid,$5::text,$6::text,$7::uuid,$8::text,$9::text) AS risultato', params);
    // Solo prima consegna; il retry non sostituisce l'impronta già confermata.
    return token && out.giaEseguita === false && out.tokenDisponibile === true ? { ...out, token } : out;
  }
  return {
    invita: (s, input) => modifica(s, input, 'invita'),
    revoca: (s, input) => modifica(s, input, 'revoca'),
    revocaInvito: (s, input) => modifica(s, input, 'revoca_invito'),
    cambiaReferente: (s, input) => modifica(s, input, 'cambia_referente'),
    invito: token => esegui('SELECT amr_accessi.colleghi_invito($1::text) AS risultato', [impronta(token)]),
    async accetta(providerUUID, input) {
      if (!valido(UUID, providerUUID)) throw errore('invito_non_valido');
      if (!valido(UUID, input?.operazione)) throw errore('input_non_valido');
      return esegui('SELECT amr_accessi.colleghi_accetta($1::uuid,$2::uuid,$3::text) AS risultato',
        [providerUUID, input.operazione, impronta(input.token)]);
    },
    async elenco(s, input) {
      const params = sessione(s);
      if (!valido(ID, input?.id)) throw errore('input_non_valido');
      return esegui('SELECT amr_accessi.colleghi_elenco($1::uuid,$2::integer,$3::boolean,$4::text) AS risultato',
        [...params, input.id]);
    },
    async statoOperazione(s, input) {
      return esegui('SELECT amr_accessi.colleghi_operazione($1::uuid,$2::integer,$3::boolean,$4::uuid,$5::text) AS risultato',
        [...sessione(s), ...operazione(input)]);
    },
  };
}
module.exports = { creaColleghiPostgres };
