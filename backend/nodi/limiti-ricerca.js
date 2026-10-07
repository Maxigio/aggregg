'use strict';

const TEMPO_RICERCA_MS = 60000;
const erroreScadenza = () => Object.assign(new Error('tempo della ricerca esaurito'), {
  status: 504, codice: 'ricerca_scaduta' });
const erroreAbbandono = () => Object.assign(new Error('ricerca abbandonata'), {
  status: 503, codice: 'ricerca_abbandonata' });
function validaTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new Error('timeout ricerca non valido');
  }
}

function creaBudgetRicerca({ timeoutMs = TEMPO_RICERCA_MS, scadeAl,
  oraMono = () => performance.now() } = {}) {
  validaTimeout(timeoutMs);
  const fine = scadeAl ?? oraMono() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => interrompi(erroreScadenza()), Math.max(0, fine - oraMono()));
  function interrompi(e = erroreAbbandono()) {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(e);
  }
  function controlla() {
    if (oraMono() >= fine) interrompi(erroreScadenza());
    if (controller.signal.aborted) throw controller.signal.reason;
  }
  function attendi(fn) {
    return new Promise((resolve, reject) => {
      try { controlla(); } catch (e) { reject(e); return; }
      const abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      let promessa;
      try { promessa = fn(); } catch (e) {
        controller.signal.removeEventListener('abort', abort); reject(e); return;
      }
      Promise.resolve(promessa).then(value => {
        try { controlla(); resolve(value); } catch (e) { reject(e); }
      }, reject).finally(() => controller.signal.removeEventListener('abort', abort));
    });
  }
  return { scadeAl: fine, signal: controller.signal, controlla, attendi, interrompi,
    restante: () => { controlla(); return Math.max(0, fine - oraMono()); },
    chiudi: () => clearTimeout(timer) };
}

function creaLimitiRicerca({ timeoutMs = TEMPO_RICERCA_MS, maxPersona = 2, maxTotale = 60, oraMono, leggi = null } = {}) {
  validaTimeout(timeoutMs);
  for (const [nome, valore] of Object.entries({ maxPersona, maxTotale })) {
    if (!Number.isSafeInteger(valore) || valore < 1) throw new Error(nome + ' non valido');
  }
  // Identità soltanto dalle sessioni server: una persona può avere più sessioni/aziende.
  const persone = new Map();
  const richieste = new Set();
  let totale = 0;
  function ammetti(sessione) {
    // Una sola fotografia per ammissione; gli avvii già ammessi conservano il budget.
    const correnti = leggi ? leggi() : { timeoutMs, maxPersona, maxTotale };
    validaTimeout(correnti.timeoutMs);
    for (const k of ['maxPersona', 'maxTotale']) {
      if (!Number.isSafeInteger(correnti[k]) || correnti[k] < 1) throw new Error(k + ' non valido');
    }
    const persona = sessione.persona || sessione.identita?.persona || sessione.identita || sessione;
    if (totale >= correnti.maxTotale || (persone.get(persona) || 0) >= correnti.maxPersona) {
      throw Object.assign(new Error('troppe ricerche pendenti'), {
        status: 429, codice: 'troppe_ricerche_pendenti' });
    }
    const budget = creaBudgetRicerca({ timeoutMs: correnti.timeoutMs, oraMono });
    totale++; persone.set(persona, (persone.get(persona) || 0) + 1);
    let terminata = false, inVolo = 0, liberata = false;
    function libera() {
      // Una verifica non cancellabile conserva il posto fino al vero completamento.
      if (!terminata || inVolo || liberata) return;
      liberata = true; totale--;
      const n = persone.get(persona) - 1;
      if (n) persone.set(persona, n); else persone.delete(persona);
    }
    const richiesta = { budget, limiti: Object.freeze({ timeoutMs: correnti.timeoutMs,
      maxPersona: correnti.maxPersona, maxTotale: correnti.maxTotale, revisione: correnti.revisione ?? 0 }),
    verifica: fn => budget.attendi(async () => {
      inVolo++;
      try { return await fn(); } finally { inVolo--; libera(); }
    }), termina: () => { terminata = true; budget.chiudi(); richieste.delete(richiesta); libera(); } };
    richieste.add(richiesta);
    return richiesta;
  }
  return { ammetti, close: () => {
    for (const r of richieste) { r.budget.interrompi(); r.termina(); }
  } };
}

module.exports = { creaBudgetRicerca, creaLimitiRicerca, TEMPO_RICERCA_MS };
