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
// I FLAG SONO UN ELENCO CHIUSO. Prima `args` buttava via QUALSIASI cosa cominciasse con `--`,
// password comprese: `set-password.js "Mario Rossi" "--segreta"` restava con un argomento solo e
// il ramo "un argomento = password del proprietario" impostava la password del PROPRIETARIO a
// "Mario Rossi", senza dirlo. Un `--` che non e' un flag noto e' un argomento come un altro.
const FLAG = new Set(['--elenco', '--togli', '--piena']);
const flag = n => argv.includes(n);
const args = argv.filter(a => !FLAG.has(a));
// UN FLAG CHE NON ESISTE E' UN ERRORE DI SINTASSI, NON UN TESTO. `--help`, `--Elenco`,
// `--togli=Mario`: proseguendo, da solo diventerebbe la NUOVA password del proprietario e
// butterebbe fuori tutti. Se una password deve davvero cominciare per `--`, si passa come
// SECONDO argomento dopo un nome: il ramo "un argomento = proprietario" non accetta un `--`.
function esci(msg) { console.error(msg); process.exit(1); }
const USO = `Uso:\n  node scripts/set-password.js "<password>"\n  node scripts/set-password.js "Nome Cognome" "<password>" [--piena]\n  node scripts/set-password.js --togli "Nome"\n  node scripts/set-password.js --elenco`;

// LA REGOLA E' UNA SOLA: il ramo "password del proprietario" si prende SOLO con argv di lunghezza
// esattamente 1, senza nessun flag. Qualunque `--` — noto o ignoto — insieme a un solo testo e'
// un errore d'uso, e si esce con l'uso invece di indovinare. Prima, tre casi diversi finivano
// tutti per impostare la password del proprietario al NOME di un collega: "Mario Rossi" --piena
// (password dimenticata), "Mario Rossi" --segreta (password che comincia per --), --help da solo.
const ignoti = argv.filter(a => a.startsWith('--') && !FLAG.has(a));
const haFlag = argv.some(a => a.startsWith('--'));
// Un `--` ignoto e' ammesso SOLO in posizione di password (secondo argomento, dopo un nome che
// non comincia per --): e' l'unico modo di avere una password che inizia con due trattini.
const ignotoComePassword = ignoti.length === 1 && args.length === 2 && args[1] === ignoti[0] && !args[0].startsWith('--');
if (ignoti.length && !ignotoComePassword) esci(`"${ignoti[0]}" non e' un'opzione.\n${USO}`);
if (flag('--piena') && args.length !== 2) esci(`--piena si usa solo con "Nome Cognome" "<password>".\n${USO}`);

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
    // Da `registrazioni.revoca`, non da `auth.togliPersona`: cosi' la revoca viene ANNOTATA e
    // l'id resta bruciato (chi si registrasse dopo con lo stesso nome erediterebbe i dati).
    if (!require('../backend/registrazioni').revoca(chi)) esci(`Nessuna persona di nome "${chi}".`);
    console.log(`"${chi}" non puo' piu' entrare. Il suo accesso smette di valere subito.`);
    process.exit(0);
  }

  // Un argomento solo = la password del proprietario (com'era prima di oggi). ESATTAMENTE uno, e
  // senza flag: con un flag in giro non si arriva qui (vedi le guardie in cima).
  if (args.length === 1 && !haFlag) {
    const p = auth.setPassword(args[0]);
    console.log('Password del proprietario impostata. File:', p);
    console.log('I colleghi si aggiungono cosi\':  node scripts/set-password.js "Nome Cognome" "<password>"');
    process.exit(0);
  }

  if (args.length === 1) esci(`Con un flag serve anche la password: "Nome Cognome" "<password>".\n${USO}`);
  if (args.length >= 2) {
    const [nome, pw] = args;
    if (nome.startsWith('--')) esci(`"${nome}" non puo' essere un nome.\n${USO}`);
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
