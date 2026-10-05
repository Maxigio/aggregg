'use strict';
const login = document.querySelector('#login'), mfa = document.querySelector('#mfa');
const stato = document.querySelector('#stato'), logout = document.querySelector('#logout');
const prototipo = document.querySelector('#prototipo');
let occupato = false, sequenza = 0;
const messaggi = { input_non_valido: 'Controlla i dati inseriti.', accesso_negato: 'Accesso non riuscito. Ripeti il login.',
  accesso_non_autorizzato: 'Accesso AMR non autorizzato. Se devi ancora completare l’invito, verifica l’email e accettalo dalla sua pagina. Negli altri casi, contatta l’Admin per verificare l’abilitazione dell’account.', ripeti_login: 'Ripeti il login per un nuovo codice.',
  troppi_tentativi: 'Troppi tentativi. Riprova più tardi.', identita_non_disponibile: 'Servizio di accesso non disponibile.',
  sessione_non_valida: 'Sessione terminata.' };
function mostraRevoca(provider) {
  stato.textContent = provider?.stato === 'confirmed' ? 'Sessione AMR terminata. Revoca Nhost confermata.'
    : provider?.stato === 'pending' ? 'Sessione AMR terminata. Revoca Nhost in corso.'
    : 'Sessione AMR terminata. Revoca Nhost non confermata.';
}
async function seguiRevoca(provider, versione) {
  if (provider?.stato !== 'pending' || !/^[a-f0-9]{64}$/.test(provider.id)) return;
  // Letture limitate; un nuovo login rende obsolete queste notifiche.
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (versione !== sequenza) return;
    try {
      const r = await fetch('/api/auth/logout/stato', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: provider.id }),
        signal: AbortSignal.timeout(3000) });
      const data = await r.json();
      if (versione !== sequenza) return;
      if (!r.ok) { mostraRevoca(null); return; }
      mostraRevoca(data.provider);
      if (data.provider?.stato !== 'pending') return;
    } catch { if (versione === sequenza) mostraRevoca(null); return; }
  }
  if (versione === sequenza) mostraRevoca(null);
}
async function manda(endpoint, body) {
  if (occupato) return;
  occupato = true; sequenza++;
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    if (endpoint === 'login') body = { ...body, tentativo: (await window.amrBootstrap(true)).tentativo };
    else if (endpoint === 'mfa') await window.amrBootstrap();
    const invia = endpoint === 'logout' && navigator.locks ? window.amrCookieFetch : fetch;
    let r = await invia('/api/auth/' + endpoint, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    let data = await r.json();
    if (r.ok && data.conferma) {
      r = await window.amrCookieFetch('/api/auth/finalizza', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conferma: data.conferma }),
        signal: AbortSignal.timeout(15000) });
      data = await r.json();
    }
    if (!r.ok) {
      stato.textContent = data.codice === 'troppi_tentativi' && Number.isSafeInteger(data.riprovaFra)
        ? `Troppi tentativi. Riprova fra ${data.riprovaFra} secondi.`
        : messaggi[data.codice] || 'Operazione non riuscita. Ripeti il login.';
      mfa.hidden = true; login.hidden = false; return;
    }
    if (data.mfa) { login.hidden = true; mfa.hidden = false; mfa.elements.otp.focus(); stato.textContent = 'Inserisci il codice dell’autenticatore.'; }
    else if (endpoint === 'logout') { prototipo.hidden = true; login.hidden = false; mfa.hidden = true; logout.hidden = true;
      mostraRevoca(data.provider); void seguiRevoca(data.provider, sequenza); }
    else { prototipo.hidden = false; login.hidden = true; mfa.hidden = true; logout.hidden = false; stato.textContent = 'Accesso verificato dal backend.'; location.replace('/'); }
  } catch (e) { stato.textContent = e.preparazione ? e.message : 'Esito non confermato. Ripeti il login.'; login.hidden = false; mfa.hidden = true; }
  finally {
    login.elements.password.value = ''; mfa.elements.otp.value = '';
    occupato = false; document.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
}
login.addEventListener('submit', e => { e.preventDefault(); manda('login', { email: login.elements.email.value,
  password: login.elements.password.value }); });
mfa.addEventListener('submit', e => { e.preventDefault(); manda('mfa', { otp: mfa.elements.otp.value }); });
logout.addEventListener('click', () => manda('logout', {}));

const sequenzaIniziale = sequenza;
window.amrBootstrap().then(() => fetch('/api/auth/me', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) })).then(async r => {
  if (!r.ok || sequenzaIniziale !== sequenza) return;
  login.hidden = true; logout.hidden = false; prototipo.hidden = false;
  stato.textContent = 'Sessione attiva.'; location.replace('/');
}).catch(e => { if (sequenzaIniziale === sequenza) stato.textContent = e.message; });
