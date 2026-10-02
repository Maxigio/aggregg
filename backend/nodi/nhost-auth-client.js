'use strict';

// URL e origine Auth fissate dal processo, mai ricevute dal browser.
function creaClient({ base, origineAuth, richiesta = fetch, timeoutMs = 10000 }) {
  const url = new URL(base);
  const locale = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/v1';
  const https = url.protocol === 'https:' && typeof origineAuth === 'string'
    && require('./trasporto-prova').origineConfigurata(origineAuth).origin === url.origin;
  // Un prefisso esplicito (es. /v1 oppure /v1/auth), senza normalizzazioni,
  // query, path traversal o segmenti codificati che possano cambiare endpoint.
  if (typeof base !== 'string' || url.username || url.password || url.search || url.hash
      || (!locale && !https) || (origineAuth !== undefined && origineAuth !== url.origin)
      || !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(url.pathname)
      || base !== url.origin + (url.pathname === '/' ? '' : url.pathname)) {
    throw new Error('base Auth non valida: HTTP loopback /v1 oppure HTTPS con origineAuth esplicita');
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
    registra: (email, password, redirectTo) => chiama('/signup/email-password', {
      // Verifica email senza refresh token nel redirect; l'accesso resta un login separato.
      email, password, options: { redirectTo },
      codeChallenge: require('node:crypto').createHash('sha256')
        .update(require('node:crypto').randomBytes(32)).digest('base64url'),
    }),
    reinviaVerifica: (email, redirectTo) => chiama('/user/email/send-verification-email', {
      email, options: { redirectTo }, codeChallenge: require('node:crypto').createHash('sha256')
        .update(require('node:crypto').randomBytes(32)).digest('base64url'),
    }),
    login: (email, password) => chiama('/signin/email-password', { email, password }),
    mfa: (ticket, otp) => chiama('/signin/mfa/totp', { ticket, otp }),
    logout: s => chiama('/signout', { refreshToken: s.refreshToken }, s.accessToken),
  };
}
module.exports = { creaClient };
