#!/usr/bin/env node
/**
 * IL NUMERO WHATSAPP DI OGNI PERSONA.
 *
 * Il bot WhatsApp risponde solo a chi riconosce, e riconoscere vuol dire risalire dal numero
 * del mittente a una persona di auth.json — le stesse persone del login web (set-password.js).
 * Qui si assegna o si toglie quel numero. Il prefisso e' libero: "+39 352 072 7252",
 * "393520727252" e "3520727252" sono lo stesso numero — un numero senza prefisso si intende
 * italiano. Un numero ESTERO va scritto col suo prefisso, se no non verra' riconosciuto.
 *
 * Uso:
 *   node scripts/set-telefono.js "Giulia Rossi" "+39 352 072 7252"   assegna il numero
 *   node scripts/set-telefono.js --togli "Giulia Rossi"              toglie il numero
 *   node scripts/set-telefono.js --elenco                            chi ha quale numero
 */
const auth = require('../backend/auth');

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const args = argv.filter(a => !a.startsWith('--'));

function esci(msg) { console.error(msg); process.exit(1); }

try {
  if (flag('--elenco')) {
    const p = auth.persone();
    if (!p.length) console.log('Nessuna persona registrata (si aggiungono con scripts/set-password.js).');
    else for (const x of p) console.log(`  ${x.nome}  (id ${x.id})  ${x.telefono ? 'tel ' + x.telefono : 'senza telefono'}`);
    process.exit(0);
  }

  if (flag('--togli')) {
    const chi = args[0];
    if (!chi) esci('Uso: node scripts/set-telefono.js --togli "<nome>"');
    const r = auth.setTelefono(chi, '');
    console.log(`${r.nome} non ha piu' un numero WhatsApp associato: il bot non la riconoscera' piu'.`);
    process.exit(0);
  }

  if (args.length >= 2) {
    const [nome, tel] = args;
    const r = auth.setTelefono(nome, tel);
    console.log(`${r.nome} (id ${r.id}) e' il numero ${r.telefono}: il bot WhatsApp la riconosce.`);
    process.exit(0);
  }

  esci([
    'Uso:',
    '  node scripts/set-telefono.js "Nome Cognome" "+39 ..."   assegna il numero WhatsApp',
    '  node scripts/set-telefono.js --togli "Nome Cognome"     toglie il numero',
    '  node scripts/set-telefono.js --elenco                   chi ha quale numero',
  ].join('\n'));
} catch (e) {
  esci('Errore: ' + e.message);
}
