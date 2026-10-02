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
  let token = incorporato ? '' : location.hash.slice(1), occupato = false, revisione = 0, aziendeCorrenti = [];
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
    identita_non_verificata: 'Verifica prima l’email nella casella locale.'
  };
  function comunica(contesto) {
    if (incorporato) document.dispatchEvent(new CustomEvent('amr:account', { detail: contesto }));
  }
  function nascondiGestione() {
    $('admin').hidden = true; $('aziende').replaceChildren(); $('consegna').replaceChildren();
  }
  async function api(url, body) {
    const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if ([401, 403].includes(r.status) && ['sessione_non_valida', 'sessione_revocata', 'accesso_non_autorizzato'].includes(d.codice)) {
        nascondiGestione(); comunica(null);
      }
      throw Object.assign(new Error(messaggi[d.codice] || `Operazione non riuscita (HTTP ${r.status}). Aggiorna lo stato prima di riprovare.`), { codice: d.codice });
    }
    return d;
  }
  const aziende = (v, body) => api('/api/auth/aziende/' + v, body);
  async function azione(fn) {
    if (occupato) return;
    occupato = true; revisione++;
    root.querySelectorAll('button').forEach(b => b.disabled = true);
    try { await fn(); }
    catch (e) { $('stato').textContent = e instanceof TypeError || e.name === 'TimeoutError'
      ? 'Esito non confermato. Aggiorna lo stato prima di riprovare.' : e.message; }
    finally {
      occupato = false; root.querySelectorAll('button').forEach(b => b.disabled = false);
      root.querySelectorAll('input[type=password]').forEach(i => i.value = '');
    }
  }
  // Identificativi di operazione stabili anche dopo un aggiornamento dell'elenco.
  const attivazioni = new Map();
  async function elenco() {
    const data = await aziende('elenco');
    aziendeCorrenti = data.aziende || [];
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
        b.textContent = 'Attiva per un anno';
        if (!attivazioni.has(a.id)) attivazioni.set(a.id, crypto.randomUUID());
        b.addEventListener('click', () => azione(async () => {
          await aziende('attiva', { id: a.id, operazione: attivazioni.get(a.id) });
          $('stato').textContent = 'Azienda attivata. Copia esterna ancora da configurare.';
          await elenco();
        })); box.append(b);
      }
      $('aziende').append(box);
    }
    if (!data.aziende?.length) $('aziende').textContent = 'Nessuna azienda: crea il primo invito.';
  }
  async function sessione() {
    const versione = ++revisione;
    const r = await fetch('/api/auth/me', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
    const me = await r.json().catch(() => ({}));
    if (versione !== revisione) return;
    if (!r.ok) {
      nascondiGestione(); $('esci').hidden = true;
      $('sessione').textContent = r.status >= 500 ? 'Verifica account non disponibile.' : 'Nessuna sessione attiva. Accedi per continuare.';
      comunica(null); return;
    }
    $('esci').hidden = false;
    $('sessione').textContent = me.admin ? 'Admin autenticato con MFA · gestione aziende abilitata'
      : me.aziendaValida ? 'Azienda ' + me.azienda + ' · moduli: ' + (me.moduli || []).join(', ')
        : 'Account autenticato · azienda in attesa di attivazione';
    comunica(me);
    if (me.admin) await elenco(); else nascondiGestione();
  }
  let operazione = crypto.randomUUID(), ultimoBody = '';
  $('invita').addEventListener('submit', e => {
    e.preventDefault(); azione(async () => {
      const f = e.target.elements;
      const dati = { nome: f.nome.value, email: f.email.value,
        moduli: f.moduli.value === 'entrambi' ? ['auto', 'moto'] : [f.moduli.value] };
      const key = JSON.stringify(dati);
      if (ultimoBody && ultimoBody !== key) operazione = crypto.randomUUID();
      ultimoBody = key;
      let d;
      try { d = await aziende('invita', { ...dati, id: 'azienda-' + operazione, operazione }); }
      catch (e) {
        if (e.codice !== 'invito_esistente') throw e;
        await elenco();
        // Solo recupero idempotente: il dominio confronta tutti i parametri e
        // l'Admin originale. Nessun nuovo invito né token rigenerato.
        const candidate = aziendeCorrenti.filter(a => a.stato === 'pending' && a.nome === dati.nome
          && /^azienda-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(a.id));
        if (candidate.length !== 1) throw e;
        const originale = candidate[0].id.slice('azienda-'.length);
        d = await aziende('invita', { ...dati, id: candidate[0].id, operazione: originale });
        operazione = originale;
      }
      $('consegna').replaceChildren();
      if (d.link) {
        const a = document.createElement('a'); a.href = d.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = 'Apri invito locale del referente'; $('consegna').append(a);
      } else $('consegna').textContent = 'Invito già creato: link temporaneo non disponibile dopo riavvio.';
      $('stato').textContent = 'Invito disponibile nel link qui sopra; non inviato via email. Aprilo, verifica l’email nella casella locale e accetta. Poi attiva l’azienda da Admin.'; await elenco();
    });
  });
  $('aggiorna').addEventListener('click', () => azione(elenco));
  $('sessione-aggiorna').addEventListener('click', () => azione(sessione));
  $('esci').addEventListener('click', () => azione(async () => {
    nascondiGestione(); comunica(null);
    await api('/api/auth/logout', {});
    $('esci').hidden = true; $('sessione').textContent = 'Sessione terminata.';
    $('stato').textContent = 'Accedi nuovamente per usare il tuo account.';
  }));
  $('registra').addEventListener('submit', e => {
    e.preventDefault(); azione(async () => {
      if (e.target.elements.password.value !== e.target.elements.conferma.value) throw new Error('Le password non coincidono.');
      await aziende('registra', { token, password: e.target.elements.password.value });
      $('stato').textContent = 'Registrazione ricevuta. La verifica è nella posta locale, non in Gmail. Aprila in un’altra scheda e torna qui.';
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
    await aziende('verifica', { token }); $('stato').textContent = 'Verifica richiesta alla posta locale, non a Gmail.';
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
