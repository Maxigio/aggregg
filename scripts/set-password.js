#!/usr/bin/env node
/**
 * LE PERSONE CHE POSSONO ENTRARE.
 *
 * Fino a ieri le password erano due: la tua e una da ospite, condivisa da chiunque. Con 2-5
 * colleghi quella condivisa non basta piu': l'app non poteva distinguere chi fosse chi,
 * quindi i limiti di richieste erano di tutti insieme, la coda degli avvisi era una sola e
 * il registro accessi diceva "demo" senza dire chi.
 *
 * Uso:
 *   node scripts/set-password.js "<password>"                  la TUA password (proprietario)
 *   node scripts/set-password.js "Giulia Rossi" "<password>"   un collega, in sola lettura
 *   node scripts/set-password.js "Marco" "<password>" --piena  un collega che puo' scrivere
 *   node scripts/set-password.js --togli "Giulia Rossi"        toglie una persona
 *   node scripts/set-password.js --elenco                      chi c'e' adesso
 *
 * Senza la password del proprietario l'app non parte affatto: e' la prima cosa da fare.
 */
const auth = require('../backend/auth');

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const args = argv.filter(a => !a.startsWith('--'));

function esci(msg) { console.error(msg); process.exit(1); }

try {
  if (flag('--elenco')) {
    const p = auth.persone();
    console.log(`Proprietario: ${auth.stato() === 'ok' ? 'password impostata' : 'NESSUNA PASSWORD — l\'app non parte'}`);
    if (!p.length) console.log('Nessun collega registrato.');
    else for (const x of p) console.log(`  ${x.nome}  (id ${x.id})  ${x.ruolo === 'full' ? 'puo\' scrivere' : 'sola lettura'}`);
    process.exit(0);
  }

  if (flag('--togli')) {
    const chi = args[0];
    if (!chi) esci('Uso: node scripts/set-password.js --togli "<nome>"');
    if (!auth.togliPersona(chi)) esci(`Nessuna persona di nome "${chi}".`);
    console.log(`"${chi}" non puo' piu' entrare. Il suo accesso smette di valere subito.`);
    process.exit(0);
  }

  // Un argomento solo = la password del proprietario (com'era prima di oggi).
  if (args.length === 1) {
    const p = auth.setPassword(args[0]);
    console.log('Password del proprietario impostata. File:', p);
    console.log('I colleghi si aggiungono cosi\':  node scripts/set-password.js "Nome Cognome" "<password>"');
    process.exit(0);
  }

  if (args.length >= 2) {
    const [nome, pw] = args;
    const r = auth.setPersona(nome, pw, flag('--piena') ? 'full' : 'demo');
    console.log(`${r.nome} puo' entrare (id ${r.id}, ${r.ruolo === 'full' ? 'puo\' scrivere' : 'sola lettura'}).`);
    process.exit(0);
  }

  esci([
    'Uso:',
    '  node scripts/set-password.js "<password>"                  la tua password',
    '  node scripts/set-password.js "Nome Cognome" "<password>"   un collega in sola lettura',
    '  node scripts/set-password.js "Nome" "<password>" --piena   un collega che puo\' scrivere',
    '  node scripts/set-password.js --togli "Nome Cognome"',
    '  node scripts/set-password.js --elenco',
  ].join('\n'));
} catch (e) {
  esci('Errore: ' + e.message);
}
