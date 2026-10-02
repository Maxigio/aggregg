'use strict';

// Main può incorporare il template in [data-colleghi-prototipo], poi caricare
// questo script. amr:account invalida dati e risposte pendenti al cambio sessione.
(async () => {
  const incorporato = document.querySelector('[data-colleghi-prototipo]');
  const root = incorporato || document.querySelector('[data-colleghi]');
  if (!root) return;
  if (!incorporato && !location.hash) { location.replace('/#accountPanel'); return; }
  if (incorporato) {
    try {
      const r = await fetch('/api/auth/colleghi/pagina',{signal:AbortSignal.timeout(5000)});
      if (!r.ok) throw new Error();
      const pagina = new DOMParser().parseFromString(await r.text(),'text/html').querySelector('[data-colleghi]');
      if (!pagina) throw new Error();
      root.replaceChildren(...Array.from(pagina.childNodes).map(n => document.importNode(n,true)));
      root.querySelectorAll('.solo-pagina').forEach(n=>n.remove());
    } catch { root.textContent='Colleghi non disponibili. Ricarica la pagina.'; return; }
  }
  const $ = id => root.querySelector('#colleghi-'+id);
  let token = incorporato ? '' : location.hash.slice(1), contesto = null, azienda = '', occupato = false, versione = 0;
  let aggiornamentoRichiesto=false;
  const modifiche = new Map(), accettazione = crypto.randomUUID();
  if (token) history.replaceState(null,'',location.pathname);
  const messaggi = {
    accesso_non_autorizzato:'Gestione consentita al referente della stessa azienda e all’Admin con MFA.',
    sessione_non_valida:'Accedi nuovamente.', sessione_revocata:'Sessione revocata. Accedi nuovamente.',
    invito_non_valido:'Invito non valido, scaduto, revocato o già usato.',
    collega_non_valido:'Serve un collega della stessa azienda. Il referente non può essere revocato: prima trasferisci il ruolo.',
    quota_persone:'I tre posti sono occupati. Revoca un invito o un collega prima di invitarne un altro.',
    invito_esistente:'Esiste già un invito per questa email. Usa quello attuale oppure revocalo.',
    appartenenza_esistente:'Questa persona appartiene già a un’azienda.',
    operazione_in_conflitto:'L’operazione precedente aveva dati diversi. Aggiorna l’elenco.',
    azienda_non_pronta:'L’azienda deve essere attiva e valida per invitare o trasferire il referente.',
    identita_non_verificata:'Verifica prima l’email nella casella locale.',
    accettazione_mfa_non_disponibile:'L’accettazione con MFA già attiva non è disponibile in questo collaudo.',
    input_non_valido:'Controlla i campi inseriti.', accesso_negato:'Controlla password e verifica email.',
    troppi_tentativi:'Troppi tentativi. Attendi un minuto.',
  };
  function svuota() {
    $('gestione').hidden=true; $('invita').hidden=true; $('elenco').replaceChildren(); $('consegna').replaceChildren();
  }
  async function api(verbo, body, v = versione) {
    const r = await fetch('/api/auth/colleghi/'+verbo,{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const d = await r.json().catch(()=>({}));
    if (v !== versione) throw Object.assign(new Error(),{superata:true});
    if (!r.ok) {
      if ([401,403].includes(r.status) && ['accesso_non_autorizzato','sessione_non_valida','sessione_revocata'].includes(d.codice)) svuota();
      throw new Error(messaggi[d.codice] || 'Esito non confermato. Aggiorna lo stato prima di riprovare.');
    }
    return d;
  }
  async function azione(fn) {
    if (occupato) return;
    occupato=true; const v=versione; $('stato').textContent='';
    root.querySelectorAll('button').forEach(b=>b.disabled=true);
    try { await fn(); }
    catch(e) { if (!e.superata && v===versione) $('stato').textContent=e instanceof TypeError
      || e.name==='TimeoutError' ? 'Esito non confermato. Aggiorna lo stato prima di riprovare.'
        : e.message || 'Esito non confermato. Aggiorna lo stato prima di riprovare.'; }
    finally {
      occupato=false; root.querySelectorAll('button').forEach(b=>b.disabled=false);
      root.querySelectorAll('input[type=password]').forEach(i=>i.value='');
      if (aggiornamentoRichiesto) { aggiornamentoRichiesto=false; void azione(sessione); }
    }
  }
  async function modifica(verbo, dati) {
    const chiave=JSON.stringify([contesto?.persona,verbo,dati]);
    if (!modifiche.has(chiave)) modifiche.set(chiave,{id:crypto.randomUUID(),azienda:dati.id,
      tipo:verbo,email:dati.email,confermata:false,consegnaRicevuta:false});
    const op=modifiche.get(chiave);
    const out=await api(verbo,{...dati,operazione:op.id}); op.confermata=true;
    if (verbo==='invita' && out.link) op.consegnaRicevuta=true;
    return out;
  }
  async function elenco(id=azienda) {
    for (const op of modifiche.values()) if (!op.confermata) {
      const stato=await api('operazione',{id:op.azienda,operazione:op.id});
      op.confermata=stato.confermata === true;
    }
    const data=await api('elenco',{id});
    // Conferma SQL e consegna del link sono eventi diversi. Conservare l'UUID
    // recuperabile finché il pending è vivo, anche dopo un refresh dell'elenco.
    for (const [key,op] of modifiche) if (op.confermata && (op.tipo!=='invita'
      || op.consegnaRicevuta || (op.azienda===data.id && !data.inviti.some(i=>
        i.stato==='pending' && i.email.toLowerCase()===op.email)))) modifiche.delete(key);
    azienda=data.id;
    $('gestione').hidden=false; $('invita').hidden=false; $('elenco').replaceChildren();
    const p=document.createElement('p');
    p.textContent='Azienda '+data.id+' · persone: '+data.membri.length+' · inviti in attesa: '+data.inviti.filter(i=>i.stato==='pending').length;
    $('elenco').append(p);
    function bottone(box,testo,verbo,dati) {
      const b=document.createElement('button'); b.type='button'; b.textContent=testo;
      b.addEventListener('click',()=>azione(async()=>{
        await modifica(verbo,dati);
        if (verbo==='revoca-invito') $('consegna').replaceChildren();
        $('stato').textContent='Operazione confermata.'; await elenco(); $('aggiorna').focus();
      })); box.append(b);
    }
    for (const m of data.membri) {
      const box=document.createElement('article'), testo=document.createElement('p');
      testo.textContent=m.email+(m.referente ? ' · referente' : ' · collega')+(m.attiva ? '' : ' · accesso disabilitato'); box.append(testo);
      if (!m.referente) {
        bottone(box,'Revoca collega','revoca',{id:azienda,persona:m.persona});
        if (data.admin && m.attiva) bottone(box,'Rendi referente','referente',{id:azienda,persona:m.persona});
      }
      $('elenco').append(box);
    }
    for (const i of data.inviti) {
      const box=document.createElement('article'), testo=document.createElement('p');
      testo.textContent=i.email+' · '+i.stato+' · scadenza '+new Date(i.scadenza).toLocaleString('it-IT'); box.append(testo);
      bottone(box,'Revoca invito','revoca-invito',{id:azienda,invito:i.id}); $('elenco').append(box);
    }
  }
  async function sessione() {
    const v=++versione;
    const r=await fetch('/api/auth/me',{credentials:'same-origin',signal:AbortSignal.timeout(5000)});
    const c=await r.json().catch(()=>({}));
    if (v!==versione) return;
    if (!r.ok) { contesto=null; svuota(); $('sessione').textContent='Accedi per gestire i colleghi.'; return; }
    if (contesto?.persona !== c.persona) { svuota(); modifiche.clear(); azienda=''; }
    contesto=c;
    $('azienda').hidden=!c.admin;
    $('sessione').textContent=c.admin ? 'Admin con MFA · scegli l’azienda.' : 'Account autenticato · azienda '+(c.azienda || 'non assegnata');
    azienda=c.admin ? azienda : c.azienda;
    if (c.admin) {
      const r=await fetch('/api/auth/aziende/elenco',{credentials:'same-origin',signal:AbortSignal.timeout(5000)});
      const data=await r.json().catch(()=>({}));
      if (v!==versione) return;
      if (!r.ok) { svuota(); throw new Error(messaggi[data.codice] || 'Elenco aziende non disponibile. Aggiorna per riprovare.'); }
      const select=$('azienda').elements.id;
      select.replaceChildren();
      const vuota=document.createElement('option'); vuota.value=''; vuota.textContent='Scegli l’azienda'; select.append(vuota);
      for (const a of data.aziende || []) {
        const opzione=document.createElement('option');opzione.value=a.id;
        opzione.textContent=(a.nome || a.id)+' · '+a.stato;select.append(opzione);
      }
      select.value=azienda;
      if (!select.value) {azienda='';$('invita').hidden=true;$('elenco').replaceChildren();}
      $('gestione').hidden=false;
    }
    if (azienda) await elenco();
  }
  document.addEventListener('amr:account',e=>{
    const c=e.detail;
    const chiave = v=>JSON.stringify([v.persona,v.admin,v.mfa,v.azienda,v.aziendaValida,v.moduli]);
    // Il polling dell'account invariato non cancella operation UUID o consegne.
    if (c && contesto && chiave(c)===chiave(contesto)) return;
    // Invalida anche risposte iniziate prima di logout/revoca o cambio account.
    versione++; contesto=c; azienda=c?.admin ? '' : c?.azienda || ''; modifiche.clear(); svuota();
    $('azienda').elements.id.replaceChildren(); $('invita').reset();
    aggiornamentoRichiesto=Boolean(c && !token);
    $('sessione').textContent=c ? 'Aggiorna per gestire i colleghi.' : 'Accedi per gestire i colleghi.';
    if (aggiornamentoRichiesto && !occupato) {aggiornamentoRichiesto=false;void azione(sessione);}
  });
  $('azienda').addEventListener('submit',e=>{e.preventDefault(); azione(async()=>{
    const candidata=e.target.elements.id.value;
    azienda=''; $('invita').hidden=true; $('elenco').replaceChildren(); $('consegna').replaceChildren();
    await elenco(candidata);
  });});
  $('aggiorna').addEventListener('click',()=>azione(sessione));
  $('invita').addEventListener('submit',e=>{e.preventDefault(); azione(async()=>{
    const d=await modifica('invita',{id:azienda,email:e.target.elements.email.value.toLowerCase()});
    $('consegna').replaceChildren();
    if (d.link) {
      const a=document.createElement('a'); a.href=d.link; a.target='_blank'; a.rel='noopener noreferrer';
      a.textContent='Apri invito locale del collega'; $('consegna').append(a);
    }
    $('stato').textContent=d.link ? 'Invito creato, non inviato via email.' : 'Invito registrato. Link temporaneo non disponibile.';
    await elenco();
  });});
  $('registra').addEventListener('submit',e=>{e.preventDefault(); azione(async()=>{
    const f=e.target.elements;
    if (f.password.value!==f.conferma.value) throw new Error('Le password non coincidono.');
    await api('registra',{token,password:f.password.value}); $('stato').textContent='Verifica richiesta alla posta locale. Aprila in un’altra scheda.';
  });});
  $('reinvia').addEventListener('click',()=>azione(async()=>{
    await api('verifica',{token}); $('stato').textContent='Verifica richiesta alla posta locale.';
  }));
  $('accetta').addEventListener('submit',e=>{e.preventDefault(); azione(async()=>{
    await api('accetta',{token,password:e.target.elements.password.value,operazione:accettazione});
    token=''; $('destinatario').hidden=true; $('stato').textContent='Invito accettato. Accedi nuovamente con il tuo account.';
  });});
  await azione(async()=>{
    if (token) {
      const i=await api('invito',{token}); $('invito').textContent='Destinatario: '+i.email;
      $('destinatario').hidden=false; $('aggiorna').hidden=true; $('sessione').textContent='Invito del collega';
    } else await sessione();
  });
})();
