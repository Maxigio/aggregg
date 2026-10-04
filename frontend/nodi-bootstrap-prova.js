'use strict';
// Il cookie HttpOnly è condiviso fra schede: solo questo POST può crearlo.
// Non tenere il lock durante password/MFA, altrimenti bloccherebbe il logout.
window.amrBootstrap = async function (login = false) {
  if (!navigator.locks) throw Object.assign(new Error('Questo browser non supporta il coordinamento delle schede. Usa un browser aggiornato.'), { preparazione: true });
  return navigator.locks.request('amr-contesto-accesso', { signal: AbortSignal.timeout(5000) }, async () => {
    const r = await fetch('/api/auth/bootstrap', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(login ? { login: true } : {}), signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(r.status === 429 && Number.isSafeInteger(data.riprovaFra)
      ? `Troppi tentativi. Riprova fra ${data.riprovaFra} secondi.`
      : 'Preparazione dell’accesso non riuscita. Riprova.'), { preparazione: true });
    return data;
  });
};
