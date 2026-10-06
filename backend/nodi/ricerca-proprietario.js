'use strict';

const idValido = id => typeof id === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);

function creaRicercaProprietario({ identificatore = null, accessi }) {
  if (identificatore !== null && (!idValido(identificatore) || !accessi)) {
    throw new Error('configurazione_proprietario_non_valida');
  }
  const negato = () => Object.assign(new Error('accesso_interrotto'), { status: 403, codice: 'accesso_interrotto' });
  const ambitoSessione = s => identificatore && s?.persona === identificatore ? 'diagnostica:' + identificatore : null;
  return {
    ambitoSessione,
    async verifica(s, tipo) {
      if (!ambitoSessione(s) || tipo !== undefined && !['auto', 'moto'].includes(tipo)) throw negato();
      // Il ruolo corrente, MFA, scadenza e revoca sono verificati dal provider;
      // l'identificatore configurato da solo non concede alcun accesso.
      let c;
      try { c = await accessi.verifica(s, { admin: true }); }
      catch (e) {
        if ([401, 403].includes(e.status)) throw negato();
        throw Object.assign(new Error('autorizzazione_non_disponibile'), { status: 503 });
      }
      if (c?.persona !== identificatore || c.admin !== true || c.mfa !== true) throw negato();
      return { persona: c.persona, azienda: ambitoSessione(s), moduli: ['auto', 'moto'] };
    },
  };
}

module.exports = { creaRicercaProprietario, idValido };
