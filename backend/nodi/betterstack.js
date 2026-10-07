'use strict';

// L'URL contiene la credenziale: resta nella configurazione, mai in ricevute o log.
function validaWebhook(valore) {
  if (valore == null) return null;
  try {
    const u = new URL(valore);
    if (u.protocol === 'https:' && ['incidents.betterstack.com', 'uptime.betterstack.com'].includes(u.hostname)
        && !u.username && !u.password && !u.port && !u.search && !u.hash
        && /^\/api\/v1\/incoming-webhook\/[A-Za-z0-9_-]+$/.test(u.pathname)) return u.href;
  } catch {}
  throw new Error('webhook_betterstack_non_valido');
}

function creaInvio({ url, invia = fetch }) {
  const destinazione = validaWebhook(url);
  if (!destinazione) return null;
  return async payload => {
    try {
      const r = await invia(destinazione, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(4000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload) });
      // La risposta non contiene una ricevuta di consegna email/push. Non conservarne il body.
      await r.body?.cancel();
      return { stato: r.ok ? 'accettato' : r.status >= 400 && r.status < 500 ? 'fallito' : 'incerto',
        http: r.status };
    } catch { return { stato: 'incerto', http: null }; }
  };
}
module.exports = { validaWebhook, creaInvio };
