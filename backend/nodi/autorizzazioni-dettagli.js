'use strict';
const crypto = require('node:crypto');

// Le chiavi seguono la vita delle sessioni, non degli annunci. Nessun elenco di
// URL conservato: firma, scadenza e permessi correnti autorizzano ogni apertura.
function creaAutorizzazioniDettagli({ ora = () => Date.now() } = {}) {
  const chiavi = new WeakMap();
  const impronta = url => crypto.createHash('sha256').update(url).digest('hex');
  const firma = (chiave, body) => crypto.createHmac('sha256', chiave).update(body).digest();
  return {
    emetti(sessione, url, tipo) {
      const scadenza = sessione.scadenza ?? sessione.ts + 3600000;
      if (!['auto','moto'].includes(tipo) || typeof url !== 'string'
          || !Number.isFinite(scadenza) || scadenza <= ora()) return null;
      if (!chiavi.has(sessione)) chiavi.set(sessione, crypto.randomBytes(32));
      const body = Buffer.from(JSON.stringify([tipo, scadenza, impronta(url), sessione.azienda ?? null])).toString('base64url');
      return body + '.' + firma(chiavi.get(sessione), body).toString('base64url');
    },
    verifica(sessione, url, token) {
      const chiave = chiavi.get(sessione);
      if (!chiave || typeof url !== 'string' || typeof token !== 'string'
          || token.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const [body, sig] = token.split('.'), ricevuta = Buffer.from(sig,'base64url');
      const attesa = firma(chiave,body);
      if (ricevuta.length !== attesa.length || !crypto.timingSafeEqual(ricevuta,attesa)) return null;
      try {
        const [tipo, scadenza, hash, azienda] = JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
        return ['auto','moto'].includes(tipo) && Number.isFinite(scadenza)
          && scadenza > ora() && hash === impronta(url)
          && azienda === (sessione.azienda ?? null) ? tipo : null;
      } catch { return null; }
    },
  };
}
module.exports = { creaAutorizzazioniDettagli };
