'use strict';

// Lo stesso pannello viene usato nella pagina d'invito e nella diagnostica.
// Selettori e blocco delle azioni restano confinati al pannello account.
(async () => {
  const incorporato = document.querySelector('[data-account-prototipo]');
  const root = incorporato || document.querySelector('[data-aziende]');
  if (!root) return;
  // Il template resta condiviso; la gestione senza invito ha un solo ingresso.
  if (!incorporato && !location.hash) {
    location.replace('/#accountPanel');
    return;
  }
  if (incorporato) {
    try {
      const r = await fetch('/api/auth/aziende/pagina', { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error();
      const pagina = new DOMParser().parseFromString(await r.text(), 'text/html');
      const contenuto = pagina.querySelector('[data-aziende]');
      if (!contenuto) throw new Error();
      root.replaceChildren(...Array.from(contenuto.childNodes).map(n => document.importNode(n, true)));
      root.querySelectorAll('.solo-pagina').forEach(n => n.remove());
    } catch {
      root.textContent = 'Gestione account non disponibile. Ricarica la pagina per riprovare.';
      return;
    }
  }
  const $ = id => root.querySelector('#account-' + id);
  let token = incorporato ? '' : location.hash.slice(1), occupato = false, revisione = 0;
  let revocaInCorso = null, persona = null;
  const avvisoSessioni = document.createElement('p');
  avvisoSessioni.id = 'account-sessioni-avviso'; avvisoSessioni.hidden = true;
  avvisoSessioni.setAttribute('role', 'status'); $('sessioni-panel').append(avvisoSessioni);
  if (token) history.replaceState(null, '', location.pathname);
  const messaggi = {
    accettazione_mfa_non_disponibile: 'Questo account ha già MFA attiva: questa accettazione non è ancora disponibile nel collaudo.',
    troppi_tentativi: 'Troppi tentativi. Attendi un minuto.',
    accesso_negato: 'Accesso non riuscito: controlla password e verifica email.',
    invito_non_valido: 'Invito non valido, scaduto o già usato.',
    input_non_valido: 'Controlla i campi inseriti.',
    accesso_non_autorizzato: 'Serve il login Admin con autenticatore.',
    sessione_non_valida: 'Sessione terminata. Accedi nuovamente.',
    sessione_revocata: 'Sessione revocata. Accedi nuovamente.',
    referente_non_valido: 'Il referente deve usare una mail distinta da quella del login Admin.',
    quota_aziende: 'Raggiunto il limite di aziende.',
    appartenenza_esistente: 'Questa persona appartiene già a un’azienda.',
    invito_esistente: 'Esiste già un invito per questa email. Controlla l’azienda e usa i dati dell’invito originale.',
    azienda_esistente: 'Questa azienda esiste già. Aggiorna l’elenco prima di riprovare.',
    operazione_in_conflitto: 'I dati non coincidono con l’invito originale: verifica nome, email e moduli.',
    azienda_non_pronta: 'Il referente deve verificare l’email e accettare l’invito prima dell’attivazione.',
    operazione_non_disponibile: 'Il servizio di gestione aziende non è disponibile. Aggiorna lo stato prima di riprovare.',
    identita_non_verificata: 'Verifica prima l’email nella casella del referente.'
  };
  function comunica(contesto) {
    if (incorporato) document.dispatchEvent(new CustomEvent('amr:account', { detail: contesto }));
  }
  function nascondiGestione() {
    $('admin').hidden = true; $('aziende').replaceChildren(); $('consegna').replaceChildren();
  }
  function nascondiSessioni() {
    $('sessioni-panel').hidden = true; $('sessioni').replaceChildren();
    avvisoSessioni.hidden = true; avvisoSessioni.textContent = '';
  }
  async function elencoSessioni() {
    const versione = revisione;
    const data = await api('/api/auth/sessioni');
    if (versione !== revisione) return;
    const lista = $('sessioni'); lista.replaceChildren(); $('sessioni-panel').hidden = false;
    avvisoSessioni.hidden = true; avvisoSessioni.textContent = '';
    for (const s of data.sessioni || []) {
      const box = document.createElement('article'), testo = document.createElement('p');
      testo.textContent = (s.corrente ? 'Questo browser' : 'Altro browser')
        + ' · accesso ' + new Date(s.creata).toLocaleString('it-IT')
        + ' · scadenza ' + new Date(s.scadenza).toLocaleString('it-IT');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn quiet';
      b.dataset.sessione = s.id;
      b.textContent = s.corrente ? 'Termina questa sessione' : 'Revoca sessione';
      b.addEventListener('click', () => azione(async () => {
        const esito = await api('/api/auth/sessioni/revoca', { id: s.id });
        if (s.corrente) {
          aggiornaPersona(null);
          nascondiGestione(); nascondiSessioni(); comunica(null);
          $('esci').hidden = true; $('sessione').textContent = 'Sessione terminata.';
        }
        mostraRevoca(esito.provider, s.corrente); void seguiRevoca(esito.provider, revisione, s.corrente);
        if (!s.corrente) { box.remove(); await aggiornaSessioni(); }
      }));
      box.append(testo, b); lista.append(box);
    }
  }
  async function aggiornaSessioni() {
    try { await elencoSessioni(); }
    catch (e) {
      if ($('sessioni-panel').hidden && ['sessione_non_valida', 'sessione_revocata', 'accesso_non_autorizzato'].includes(e.codice)) {
        $('sessione').textContent = e.message;
        return;
      }
      avvisoSessioni.textContent = 'Elenco delle sessioni non aggiornato. Usa “Aggiorna sessioni” per riprovare.';
      avvisoSessioni.hidden = false;
    }
  }
  async function api(url, body, timeoutMs = 15000) {
    const invia = ['/api/auth/logout', '/api/auth/sessioni/revoca'].includes(url) && window.amrCookieFetch && navigator.locks
      ? window.amrCookieFetch : fetch;
    const r = await invia(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if ([401, 403].includes(r.status) && ['sessione_non_valida', 'sessione_revocata', 'accesso_non_autorizzato'].includes(d.codice)) {
        if (d.codice !== 'accesso_non_autorizzato') aggiornaPersona(null);
        nascondiGestione(); nascondiSessioni(); comunica(null);
      }
      throw Object.assign(new Error(messaggi[d.codice] || `Operazione non riuscita (HTTP ${r.status}). Aggiorna lo stato prima di riprovare.`), { codice: d.codice });
    }
    return d;
  }
  const aziende = (v, body) => api('/api/auth/aziende/' + v, body);
  async function azione(fn) {
    if (occupato) return;
    interrompiRevoca();
    const focusPrima = document.activeElement;
    const focusAzienda = root.contains(focusPrima) ? focusPrima.dataset.azienda : null;
    const focusSessione = root.contains(focusPrima) ? focusPrima.dataset.sessione : null;
    const focusAzione = focusPrima?.dataset?.azione || '';
    occupato = true; revisione++;
    root.querySelectorAll('button').forEach(b => b.disabled = true);
    try { await fn(); }
    catch (e) { $('stato').textContent = e instanceof TypeError || e.name === 'TimeoutError'
      ? 'Esito non confermato. Aggiorna lo stato prima di riprovare.' : e.message; }
    finally {
      occupato = false; root.querySelectorAll('button').forEach(b => b.disabled = false);
      root.querySelectorAll('input[type=password]').forEach(i => i.value = '');
      if ((focusAzienda || focusSessione) && (document.activeElement === document.body || document.activeElement === focusPrima)) {
        const equivalente = focusSessione
          ? Array.from($('sessioni').querySelectorAll('[data-sessione]')).find(b => b.dataset.sessione === focusSessione)
          : Array.from($('aziende').querySelectorAll('[data-azienda]'))
            .find(b => b.dataset.azienda === focusAzienda && (b.dataset.azione || '') === focusAzione);
        const fallback = focusSessione && !$('sessioni-panel').hidden ? $('sessioni-aggiorna')
          : focusAzienda && !$('admin').hidden ? $('aggiorna') : $('sessione-aggiorna');
        (equivalente || fallback).focus({ preventScroll: true });
      }
    }
  }
  // Identificativi di operazione stabili anche dopo un aggiornamento dell'elenco.
  const attivazioni = new Map();
  const modifiche = new Map();
  const dateRinnovo = new Map();
  function operazioneStabile(chiave) {
    if (!modifiche.has(chiave)) modifiche.set(chiave, { id: crypto.randomUUID(), confermata: false });
    return modifiche.get(chiave);
  }
  async function modifica(verbo, chiave, body) {
    const operazione = operazioneStabile(chiave);
    operazione.azienda = body.id;
    if (!operazione.confermata) {
      await aziende(verbo, { ...body, operazione: operazione.id });
      operazione.confermata = true;
    }
  }
  async function elenco() {
    // Un timeout non dimostra rollback. Confermare l'ID nel DB evita di riusare
    // una vecchia revoca dopo un successivo ciclo di riattivazione.
    for (const op of modifiche.values()) if (!op.confermata) {
      const stato = await aziende('operazione', { id: op.azienda, operazione: op.id });
      op.confermata = stato.confermata === true;
    }
    const data = await aziende('elenco');
    const lista = $('aziende');
    const attivo = document.activeElement;
    const focusAzienda = lista.contains(attivo) ? attivo.dataset.azienda : null;
    const focusAzione = attivo?.dataset?.azione || '';
    for (const data of lista.querySelectorAll('input[data-azienda]')) dateRinnovo.set(data.dataset.azienda,data.value);
    // Una mutazione confermata resta riprovabile soltanto finché manca la
    // lettura aggiornata. La successiva azione intenzionale ha un nuovo ID.
    for (const [key, op] of modifiche) if (op.confermata) modifiche.delete(key);
    $('admin').hidden = false; $('aziende').replaceChildren();
    for (const a of data.aziende || []) {
      const box = document.createElement('article'), p = document.createElement('p');
      box.className = 'account-azienda';
      p.textContent = (a.nome || a.id) + ' — ' + a.stato
        + (a.inviteScadenza && a.stato === 'pending' ? ' · invito valido fino al ' + new Date(a.inviteScadenza).toLocaleString('it-IT') : '')
        + (a.scadenza ? ' · scadenza ' + new Date(a.scadenza).toLocaleString('it-IT') : '');
      box.append(p);
      if (a.stato === 'accettato') {
        const b = document.createElement('button'); b.className = 'btn primary'; b.type = 'button';
        b.dataset.azienda = a.id;
        b.textContent = 'Attiva per un anno';
        if (!attivazioni.has(a.id)) attivazioni.set(a.id, crypto.randomUUID());
        b.addEventListener('click', () => azione(async () => {
          await aziende('attiva', { id: a.id, operazione: attivazioni.get(a.id) });
          $('stato').textContent = 'Azienda attivata. Copia esterna ancora da configurare.';
          await elenco();
        })); box.append(b);
      }
      if (['attiva','scaduta','revocata'].includes(a.stato)) {
        const form = document.createElement('form'), label = document.createElement('label');
        label.textContent = 'Scadenza personalizzata (facoltativa)';
        const data = document.createElement('input'); data.type = 'datetime-local'; label.append(data);
        data.dataset.azienda = a.id; data.dataset.azione = 'scadenza'; data.value = dateRinnovo.get(a.id) || '';
        const rinnova = document.createElement('button'); rinnova.type = 'submit'; rinnova.className = 'btn';
        rinnova.textContent = a.stato === 'revocata' ? 'Rinnova e riattiva' : 'Rinnova per un anno';
        rinnova.dataset.azienda = a.id; rinnova.dataset.azione = 'rinnova';
        form.append(label, rinnova);
        form.addEventListener('submit', e => { e.preventDefault(); azione(async () => {
          const scadenza = data.value ? new Date(data.value).toISOString() : null;
          const key = JSON.stringify(['rinnova',a.id,a.scadenza,scadenza]);
          await modifica('rinnova', key, { id:a.id, scadenza });
          $('stato').textContent = 'Rinnovo confermato. Copia esterna ancora da configurare.';
          await elenco();
        }); });
        box.append(form);
        if (a.stato !== 'revocata') {
          const revoca = document.createElement('button'); revoca.type = 'button'; revoca.className = 'btn';
          revoca.textContent = 'Revoca accesso azienda'; revoca.dataset.azienda = a.id; revoca.dataset.azione = 'revoca';
          revoca.addEventListener('click', () => {
            if (!confirm('Revocare subito tutti gli accessi di questa azienda?')) return;
            azione(async () => {
              await modifica('revoca', JSON.stringify(['revoca',a.id,a.scadenza]), { id:a.id });
              $('stato').textContent = 'Accesso azienda revocato. Copia esterna ancora da configurare.';
              await elenco();
            });
          }); box.append(revoca);
        }
      }
      $('aziende').append(box);
    }
    if (!data.aziende?.length) $('aziende').textContent = 'Nessuna azienda: crea il primo invito.';
    if (focusAzienda) {
      const equivalente = Array.from(lista.querySelectorAll('[data-azienda]'))
        .find(b => b.dataset.azienda === focusAzienda && (b.dataset.azione || '') === focusAzione);
      (equivalente || $('aggiorna')).focus({ preventScroll: true });
    }
  }
  async function sessione() {
    interrompiRevoca();
    const versione = ++revisione;
    const r = await fetch('/api/auth/me', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
    const me = await r.json().catch(() => ({}));
    if (versione !== revisione) return;
    if (!r.ok) {
      if ([401, 403].includes(r.status)) aggiornaPersona(null);
      nascondiGestione(); nascondiSessioni(); $('esci').hidden = true;
      $('sessione').textContent = r.status >= 500 ? 'Verifica account non disponibile.' : 'Nessuna sessione attiva. Accedi per continuare.';
      comunica(null); return;
    }
    aggiornaPersona(me.persona);
    $('esci').hidden = false;
    $('sessione').textContent = me.admin ? 'Admin autenticato con MFA · gestione aziende abilitata'
      : me.aziendaValida ? 'Azienda ' + me.azienda + ' · moduli: ' + (me.moduli || []).join(', ')
        : 'Account autenticato · azienda in attesa di attivazione';
    comunica(me);
    if (me.admin) await elenco(); else nascondiGestione();
    await elencoSessioni();
  }
  let operazione = crypto.randomUUID(), idInvito = 'azienda-' + operazione, ultimoBody = '';
  function aggiornaPersona(prossima) {
    if (persona === prossima) return;
    persona = prossima;
    // Il draft e gli UUID appartengono alla persona, non al polling o al ruolo.
    $('invita').reset();
    // La perdita d'accesso conserva l'esito di una revoca appena confermata.
    if (prossima !== null) $('stato').textContent = '';
    operazione = crypto.randomUUID(); idInvito = 'azienda-' + operazione; ultimoBody = '';
    attivazioni.clear(); modifiche.clear(); dateRinnovo.clear();
    nascondiGestione(); nascondiSessioni();
  }
  $('invita').addEventListener('submit', e => {
    e.preventDefault(); azione(async () => {
      const f = e.target.elements;
      const dati = { nome: f.nome.value, email: f.email.value,
        moduli: f.moduli.value === 'entrambi' ? ['auto', 'moto'] : [f.moduli.value] };
      const key = JSON.stringify(dati);
      if (ultimoBody && ultimoBody !== key) {
        operazione = crypto.randomUUID(); idInvito = 'azienda-' + operazione;
      }
      ultimoBody = key;
      const d = await aziende('invita', { ...dati, id: idInvito, operazione });
      operazione = d.operazione; idInvito = d.id;
      $('consegna').replaceChildren();
      if (d.link) {
        const a = document.createElement('a'); a.href = d.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = 'Apri invito del referente'; $('consegna').append(a);
      } else $('consegna').textContent = 'Invito già creato: link temporaneo non disponibile dopo riavvio.';
      $('stato').textContent = d.link
        ? 'Invito disponibile nel link qui sopra; non inviato via email. Aprilo, verifica l’email del referente e accetta. Poi attiva l’azienda da Admin.'
        : 'Invito già registrato; il link temporaneo non è disponibile. Nessun nuovo invito creato.';
      await elenco();
    });
  });
  $('aggiorna').addEventListener('click', () => azione(elenco));
  $('sessione-aggiorna').addEventListener('click', () => azione(sessione));
  $('sessioni-aggiorna').addEventListener('click', () => azione(aggiornaSessioni));
  function interrompiRevoca() {
    if (revocaInCorso && $('stato').textContent === revocaInCorso.testo) {
      mostraRevoca(null, revocaInCorso.corrente);
    }
    revocaInCorso = null;
  }
  function mostraRevoca(provider, corrente = true) {
    const terminata = corrente ? 'Sessione AMR terminata.' : 'Sessione selezionata terminata.';
    $('stato').textContent = provider?.stato === 'confirmed'
      ? terminata + ' Revoca Nhost confermata.'
      : provider?.stato === 'pending' ? terminata + ' Revoca Nhost in corso.'
        : terminata + ' La revoca della sessione Nhost non è confermata.';
    revocaInCorso = provider?.stato === 'pending' ? { corrente, testo: $('stato').textContent } : null;
  }
  async function seguiRevoca(provider, versione, corrente = true) {
    if (provider?.stato !== 'pending' || !/^[a-f0-9]{64}$/.test(provider.id)) return;
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 2000));
      if (versione !== revisione) return;
      try {
        const esito = await api('/api/auth/logout/stato', { id: provider.id }, 3000);
        if (versione !== revisione) return;
        mostraRevoca(esito.provider, corrente);
        if (esito.provider?.stato !== 'pending') return;
      } catch { if (versione === revisione) mostraRevoca(null, corrente); return; }
    }
    if (versione === revisione) mostraRevoca(null, corrente);
  }
  $('esci').addEventListener('click', () => azione(async () => {
    aggiornaPersona(null);
    nascondiGestione(); nascondiSessioni(); comunica(null);
    const esito = await api('/api/auth/logout', {});
    $('esci').hidden = true; $('sessione').textContent = 'Sessione terminata.';
    mostraRevoca(esito.provider); void seguiRevoca(esito.provider, revisione);
  }));
  $('registra').addEventListener('submit', e => {
    e.preventDefault(); azione(async () => {
      if (e.target.elements.password.value !== e.target.elements.conferma.value) throw new Error('Le password non coincidono.');
      await aziende('registra', { token, password: e.target.elements.password.value });
      $('stato').textContent = 'Registrazione ricevuta. Cerca il messaggio di verifica nella casella del referente, anche nello spam. Nel collaudo con Auth locale usa MailHog; nello staging Nhost usa la casella reale. Apri la verifica in un’altra scheda e torna qui per accettare l’invito.';
    });
  });
  $('accetta').addEventListener('submit', e => {
    e.preventDefault(); azione(async () => {
      await aziende('accetta', { token, password: e.target.elements.password.value });
      token = ''; $('destinatario').hidden = true;
      $('stato').textContent = 'Invito accettato. Le ricerche restano bloccate fino all’attivazione dell’Admin.';
    });
  });
  $('reinvia').addEventListener('click', () => azione(async () => {
    await aziende('verifica', { token }); $('stato').textContent = 'Verifica richiesta. Controlla la casella del referente; MailHog serve soltanto il collaudo con Auth locale.';
  }));
  await azione(async () => {
    if (token) {
      const i = await aziende('invito', { token });
      $('invito').textContent = 'Destinatario: ' + i.email; $('destinatario').hidden = false;
      $('sessione-aggiorna').hidden = true;
      $('sessione').textContent = 'Invito del referente · nessun accesso Admin richiesto per accettarlo.';
    } else await sessione();
  });
  if (!token) setInterval(() => { if (!occupato) azione(sessione); }, 30000);
})();
