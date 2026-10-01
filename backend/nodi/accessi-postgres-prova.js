'use strict';

// Lettura dei permessi dal provider reale. Il pool è del processo, mai del client.
function creaAccessiPostgres({ pool }) {
  let inAttesa = 0;
  const indisponibile = () => Object.assign(new Error('autorizzazione_non_disponibile'), {
    codice: 'autorizzazione_non_disponibile', status: 503 });
  return async persona => {
    if (typeof persona !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(persona)) return null;
    // Il pool limita le connessioni, non il numero di Promise che le attendono.
    if (inAttesa >= 32) throw indisponibile();
    inAttesa++;
    try {
      const r = await pool.query('SELECT * FROM amr_accessi.identita($1::uuid)', [persona]);
      const p = r.rows[0];
      if (!p) return null;
      return { attiva: p.attiva === true, admin: p.admin === true, epoca: p.epoca,
        azienda: p.azienda, aziendaValida: p.azienda_valida === true, moduli: p.moduli };
    } catch {
      throw indisponibile();
    } finally { inAttesa--; }
  };
}
module.exports = { creaAccessiPostgres };
