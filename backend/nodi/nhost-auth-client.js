'use strict';

// Client del collaudo: URL fissata dal processo, mai ricevuta dal browser.
function creaClient({ base, richiesta = fetch, timeoutMs = 10000 }) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.username || url.password || url.search || url.hash || url.pathname !== '/v1') {
    throw new Error('Auth del collaudo deve essere http://127.0.0.1:porta/v1');
  }
  async function chiama(endpoint, body, token) {
    try {
      const r = await richiesta(base + endpoint, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      // Anche un 429 in testo semplice deve mantenere la classificazione HTTP.
      if (!r.ok) {
        const rawAttesa = r.headers?.get('retry-after');
        const attesa = rawAttesa && /^\d+$/.test(rawAttesa) ? Number(rawAttesa) : null;
        await r.body?.cancel().catch(() => {});
        throw Object.assign(new Error('accesso_negato'), { status: r.status === 429 ? 429
          : r.status >= 500 ? 503 : 401, codice: r.status === 429 ? 'troppi_tentativi'
          : r.status >= 500 ? 'identita_non_disponibile' : 'accesso_negato',
          riprovaFra: Number.isSafeInteger(attesa) && attesa > 0 && attesa <= 86400 ? attesa : null });
      }
      return await r.json();
    } catch (e) {
      if (e.codice) throw e;
      throw Object.assign(new Error('identita_non_disponibile'), { status: 503, codice: 'identita_non_disponibile',
        tipoTrasporto: e instanceof TypeError ? 'TypeError' : e instanceof SyntaxError ? 'SyntaxError' : 'errore' });
    }
  }
  return {
    login: (email, password) => chiama('/signin/email-password', { email, password }),
    mfa: (ticket, otp) => chiama('/signin/mfa/totp', { ticket, otp }),
    logout: s => chiama('/signout', { refreshToken: s.refreshToken }, s.accessToken),
  };
}
module.exports = { creaClient };
