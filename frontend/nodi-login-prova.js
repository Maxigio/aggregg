'use strict';
const login = document.querySelector('#login'), mfa = document.querySelector('#mfa');
const stato = document.querySelector('#stato'), logout = document.querySelector('#logout');
const prototipo = document.querySelector('#prototipo');
let occupato = false, sequenza = 0;
const messaggi = { input_non_valido: 'Controlla i dati inseriti.', accesso_negato: 'Accesso non riuscito. Ripeti il login.',
  accesso_non_autorizzato: 'Accesso non autorizzato. Per l’Admin serve MFA.', ripeti_login: 'Ripeti il login per un nuovo codice.',
  troppi_tentativi: 'Troppi tentativi. Riprova più tardi.', identita_non_disponibile: 'Servizio di accesso non disponibile.',
  sessione_non_valida: 'Sessione terminata.' };
async function manda(endpoint, body) {
  if (occupato) return;
  occupato = true; sequenza++;
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const r = await fetch('/api/auth/' + endpoint, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const data = await r.json();
    if (!r.ok) {
      stato.textContent = data.codice === 'troppi_tentativi' && Number.isSafeInteger(data.riprovaFra)
        ? `Troppi tentativi. Riprova fra ${data.riprovaFra} secondi.`
        : messaggi[data.codice] || 'Operazione non riuscita. Ripeti il login.';
      mfa.hidden = true; login.hidden = false; return;
    }
    if (data.mfa) { login.hidden = true; mfa.hidden = false; mfa.elements.otp.focus(); stato.textContent = 'Inserisci il codice dell’autenticatore.'; }
    else if (endpoint === 'logout') { prototipo.hidden = true; login.hidden = false; mfa.hidden = true; logout.hidden = true;
      stato.textContent = data.providerRevocato ? 'Sessione terminata.' : 'Sessione AMR terminata. Revoca Nhost non confermata.'; }
    else { prototipo.hidden = false; login.hidden = true; mfa.hidden = true; logout.hidden = false; stato.textContent = 'Accesso verificato dal backend.'; location.replace('/'); }
  } catch { stato.textContent = 'Esito non confermato. Ripeti il login.'; login.hidden = false; mfa.hidden = true; }
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
fetch('/api/auth/me', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) }).then(async r => {
  if (!r.ok || sequenzaIniziale !== sequenza) return;
  login.hidden = true; logout.hidden = false; prototipo.hidden = false;
  stato.textContent = 'Sessione attiva.'; location.replace('/');
}).catch(() => {});
