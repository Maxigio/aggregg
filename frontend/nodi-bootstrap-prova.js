'use strict';
// Le schede ordinano tutte le scritture dei cookie, mai l'attesa di Nhost.
// La sicurezza del tentativo resta sul server; il lock coordina il nostro frontend.
window.amrCookieFetch = async function (url, options) {
  if (!navigator.locks) throw Object.assign(new Error('Questo browser non supporta il coordinamento delle schede. Usa un browser aggiornato.'), { preparazione: true });
  return navigator.locks.request('amr-contesto-accesso', { signal: AbortSignal.timeout(5000) },
    () => fetch(url, options));
};
window.amrBootstrap = async function (login = false, email) {
  const r = await window.amrCookieFetch('/api/auth/bootstrap', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(login ? { login: true, email } : {}), signal: AbortSignal.timeout(5000) });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(r.status === 429 && Number.isSafeInteger(data.riprovaFra)
    ? `Troppi tentativi. Riprova fra ${data.riprovaFra} secondi.`
    : 'Preparazione dell’accesso non riuscita. Riprova.'), { preparazione: true });
  return data;
};
