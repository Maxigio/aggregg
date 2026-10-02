'use strict';
const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const CODICI = new Map([
  ['input_non_valido', 400], ['accesso_non_autorizzato', 403], ['sessione_revocata', 403],
  ['invito_non_valido', 403], ['referente_non_valido', 403],
  ['operazione_in_conflitto', 409], ['azienda_esistente', 409], ['invito_esistente', 409],
  ['quota_aziende', 409], ['quota_persone', 409], ['appartenenza_esistente', 409],
  ['azienda_non_pronta', 409], ['operazione_non_disponibile', 503],
]);
const errore = codice => Object.assign(new Error(codice), { codice, status: CODICI.get(codice) });
const valido = (regex, value) => typeof value === 'string' && regex.test(value);
const impronta = token => {
  if (!valido(TOKEN, token)) throw errore('invito_non_valido');
  return crypto.createHash('sha256').update(token).digest('hex');
};

// Solo server: session da login.sessione(req), providerUUID da risposta Auth ottenuta
// server-side. UUID/MFA ricevuti nel body del browser NON sono prove d'identità.
// Un'istanza per pool/processo; nessuna cache di token o invio email nel dominio.
function creaAziendePostgres({ pool }) {
  if (!pool || typeof pool.query !== 'function') throw errore('operazione_non_disponibile');
  let inAttesa = 0;
  function admin(session) {
    if (!session || !valido(UUID, session.persona) || session.mfa !== true
        || !Number.isInteger(session.epoca) || session.epoca < 0 || session.epoca > 2147483647) {
      throw errore('accesso_non_autorizzato');
    }
    return [session.persona, session.epoca, true];
  }
  function operazione(input) {
    if (!input || !valido(UUID, input.operazione) || !valido(ID, input.id)) {
      throw errore('input_non_valido');
    }
    return [input.operazione, input.id];
  }
  async function esegui(sql, params) {
    if (inAttesa >= 32) throw errore('operazione_non_disponibile');
    inAttesa++;
    try {
      // Una query = una funzione atomica / una transazione implicita sullo stesso
      // client. Non usare BEGIN/COMMIT su pool.query e non fare retry automatici.
      const result = await pool.query(sql, params);
      if (!result.rows?.[0]?.risultato) throw errore('operazione_non_disponibile');
      return result.rows[0].risultato;
    } catch (e) {
      // Non propagare detail, constraint, query, parametri, stack o cause del DB.
      const codice = e?.code === 'P0001' && CODICI.has(e.message)
        ? e.message : 'operazione_non_disponibile';
      throw errore(codice);
    } finally { inAttesa--; }
  }
  return {
    async invita(session, input) {
      const params = [...admin(session), ...operazione(input)];
      if (typeof input.nome !== 'string' || [...input.nome].length < 1 || [...input.nome].length > 80
          || input.nome !== input.nome.trim() || /[\u0000-\u001f\u007f]/.test(input.nome)
          || typeof input.email !== 'string' || input.email.length > 254
          || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
          || /[\u0000-\u001f\u007f]/.test(input.email)
          || !Array.isArray(input.moduli) || input.moduli.length < 1 || input.moduli.length > 2
          || !input.moduli.every(m => m === 'auto' || m === 'moto')
          || new Set(input.moduli).size !== input.moduli.length) {
        throw errore('input_non_valido');
      }
      const token = crypto.randomBytes(32).toString('hex');
      const out = await esegui('SELECT amr_accessi.aziende_invita($1::uuid, $2::integer, $3::boolean, '
        + '$4::uuid, $5::text, $6::text, $7::text, $8::text[], $9::text) AS risultato',
      [...params, input.nome, input.email, [...input.moduli], impronta(token)]);
      // Retry/concorrenza/commit con risposta persa: nessun nuovo record o token
      // recuperabile. Il chiamante conserva la prima consegna esclusivamente in RAM.
      return out.giaCreata === false ? { ...out, token } : out;
    },
    async invito(token) {
      return esegui('SELECT amr_accessi.aziende_invito($1::text) AS risultato', [impronta(token)]);
    },
    async accetta(providerUUID, token) {
      if (!valido(UUID, providerUUID)) throw errore('invito_non_valido');
      return esegui('SELECT amr_accessi.aziende_accetta($1::uuid, $2::text) AS risultato',
        [providerUUID, impronta(token)]);
    },
    async attiva(session, input) {
      return esegui('SELECT amr_accessi.aziende_attiva($1::uuid, $2::integer, $3::boolean, '
        + '$4::uuid, $5::text) AS risultato', [...admin(session), ...operazione(input)]);
    },
    async elenco(session) {
      return esegui('SELECT amr_accessi.aziende_elenco($1::uuid, $2::integer, $3::boolean) AS risultato',
        admin(session));
    },
  };
}
module.exports = { creaAziendePostgres };
