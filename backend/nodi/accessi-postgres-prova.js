'use strict';

// Lettura dei permessi dal provider reale. Il pool è del processo, mai del client.
function creaAccessiPostgres({ pool }) {
  let inAttesa = 0;
  const uuid = value => typeof value === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  const indisponibile = () => Object.assign(new Error('autorizzazione_non_disponibile'), {
    codice: 'autorizzazione_non_disponibile', status: 503 });
  async function query(sql, params) {
    // Il pool limita le connessioni, non il numero di Promise che le attendono.
    if (inAttesa >= 32) throw indisponibile();
    inAttesa++;
    try {
      return await pool.query(sql, params);
    } catch {
      throw indisponibile();
    } finally { inAttesa--; }
  }
  const identita = async persona => {
    if (!uuid(persona)) return null;
    const r = await query('SELECT * FROM amr_accessi.identita($1::uuid)', [persona]);
    const p = r.rows[0];
    if (!p) return null;
    return { attiva: p.attiva === true, admin: p.admin === true, epoca: p.epoca,
      azienda: p.azienda, aziendaValida: p.azienda_valida === true, moduli: p.moduli };
  };
  // Capability sempre presente sul lettore PG: schema/grant mancanti negano l'accesso.
  Object.defineProperty(identita, 'inizioLogin', { value: async email => {
    if (typeof email !== 'string' || email.length > 254 || !email.includes('@')) return null;
    const r = await query('SELECT * FROM amr_accessi.inizio_login($1::text)', [email]);
    // Un risultato ambiguo non può scegliere arbitrariamente un'identità.
    if (r.rows.length !== 1) return null;
    const p = r.rows[0];
    if (!uuid(p.persona) || !Number.isInteger(p.epoca) || p.epoca < 0 || p.epoca > 2147483647) {
      throw indisponibile();
    }
    return Object.freeze({ persona: p.persona.toLowerCase(), epoca: p.epoca });
  } });
  return identita;
}
module.exports = { creaAccessiPostgres };
