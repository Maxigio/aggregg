#!/usr/bin/env node
/**
 * CHI CHIEDE DI ENTRARE — elenco, approvazione, rifiuto, revoca, registro.
 *
 * QUESTO NON E' UN PANNELLO WEB, ED E' UNA SCELTA. C'era, dentro l'app, e l'ha tolto il
 * proprietario dopo averne misurato il costo: approvare una richiesta crea una credenziale
 * PERMANENTE, cioe' trasforma una sessione presa in prestito per un minuto — un telefono lasciato
 * sul bancone, non un attacco da internet — in un accesso che sopravvive alla scadenza del
 * cookie, alla revoca della sessione e al cambio della password del proprietario. L'approvazione
 * restituisce un link che vale 48 ore e che si consuma senza piu' nessuna sessione, e la variante
 * peggiore non fabbrica un account nuovo: approva una richiesta VERA e se ne prende il nome.
 * Da qui dentro quel potere ce l'ha chi ha accesso alla macchina, e basta.
 *
 * ⚠ SI LANCIA SULLA MACCHINA CHE SERVE LE PERSONE (il Mac M2), via ssh. Lanciato altrove apre un
 * ALTRO archivio — sull'iMac `data/` esiste, quindi non darebbe nessun errore: mostrerebbe una
 * coda vuota e approverebbe nel vuoto. Per questo il percorso del database si stampa SEMPRE,
 * prima di ogni cosa: leggilo. Vedi `docs/DEPLOY-M2.md`.
 *
 * Uso:
 *   node scripts/richieste.js --elenco                    chi ha chiesto, e chi c'e' gia'
 *   node scripts/richieste.js --approva "Mario Rossi"     genera il link (compare UNA volta)
 *   node scripts/richieste.js --rifiuta "Mario Rossi" [motivo]
 *   node scripts/richieste.js --revoca  "Mario Rossi"     toglie l'accesso a chi ce l'ha
 *   node scripts/richieste.js --registro [quante]         cosa e' successo, dalla piu' recente
 *
 * L'indirizzo pubblico con cui si compone il link si prende da AMR_URL_PUBBLICO se c'e';
 * altrimenti si usa quello scritto in docs/DEPLOY-M2.md.
 */
const auth = require('../backend/auth');
const reg = require('../backend/registrazioni');
const dbmod = require('../backend/utenti-db');

const URL_PUBBLICO = process.env.AMR_URL_PUBBLICO || 'https://auto-moto-radar.tailc82888.ts.net';

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const dopo = n => { const i = argv.indexOf(n); return i >= 0 ? argv.slice(i + 1).filter(a => !a.startsWith('--')) : []; };

function esci(msg) { console.error(msg); process.exit(1); }
const quando = t => (t ? new Date(Number(t)).toLocaleString('it-IT') : '—');

/** Il primo gesto, sempre: dire su quale archivio si sta lavorando. */
function intestazione() {
  const s = dbmod.stato();
  console.log(`Archivio: ${dbmod.percorso()}  [${s}]`);
  if (s !== 'ok') {
    esci(s === 'assente'
      ? '  La cartella dei dati non esiste. Sei sulla macchina giusta? (vedi docs/DEPLOY-M2.md)'
      : `  Non si apre: ${dbmod.guasto()}`);
  }
  console.log('');
}

/**
 * Trova UNA richiesta viva da quello che hai scritto: il numero, oppure il nome (anche parziale,
 * anche con le maiuscole sbagliate). Se ne trova due, non ne sceglie una: le fa vedere entrambe.
 * Scegliere al posto di chi comanda, su un gesto che crea un accesso, non e' un favore.
 */
function trovaRichiesta(chiave, vive) {
  const q = String(chiave || '').trim().toLowerCase();
  if (!q) esci('Serve il numero o il nome della richiesta (--elenco per vederle).');
  const perNumero = vive.filter(r => String(r.id) === q);
  if (perNumero.length === 1) return perNumero[0];
  const esatte = vive.filter(r => r.nome.toLowerCase() === q || r.persona === q);
  if (esatte.length === 1) return esatte[0];
  const parziali = vive.filter(r => r.nome.toLowerCase().includes(q));
  if (parziali.length === 1) return parziali[0];
  if (parziali.length > 1) {
    console.error(`"${chiave}" corrisponde a ${parziali.length} richieste:`);
    for (const r of parziali) console.error(`  #${r.id}  ${r.nome}  <${r.email}>`);
    esci('Scegline una col suo numero.');
  }
  esci(`Nessuna richiesta viva per "${chiave}". Guarda --elenco.`);
  return null;
}

try {
  if (flag('--elenco') || argv.length === 0) {
    if (argv.length === 0) {
      console.log('Uso: --elenco | --approva <chi> | --rifiuta <chi> [motivo] | --revoca <chi> | --registro [n]\n');
    }
    intestazione();
    const vive = reg.elenco();
    console.log(`RICHIESTE (${vive.length})`);
    if (!vive.length) console.log('  nessuna.');
    for (const r of vive) {
      const stato = r.stato === 'approvata'
        ? `link gia' emesso, scade ${quando(r.invitoScadeIl)}`
        : 'in attesa';
      console.log(`  #${r.id}  ${r.nome}  <${r.email}>`);
      console.log(`        id: ${r.persona}${r.collide ? '   ⚠ QUESTO NOME E\' GIA\' DI UNA PERSONA CHE ENTRA' : ''}`);
      console.log(`        da ${r.ip || '?'} il ${quando(r.creata_il)} — ${stato}`);
    }
    const persone = auth.persone();
    console.log(`\nCHI ENTRA OGGI (${persone.length})`);
    if (!persone.length) console.log('  nessuno oltre al proprietario.');
    for (const p of persone) {
      console.log(`  ${p.nome}  (${p.id})  ${p.ruolo === 'full' ? 'puo\' scrivere' : 'guarda e salva le sue cose'}`
        + `  — ${p.origine === 'web' ? 'registrato dal sito' : 'elenco del .env'}`);
    }
    process.exit(0);
  }

  if (flag('--approva')) {
    intestazione();
    const r = trovaRichiesta(dopo('--approva')[0], reg.elenco());
    const inv = reg.approva(r.id);
    console.log(`Approvata la richiesta di ${inv.nome}.`);
    console.log('\nMandagli QUESTO link. Compare una volta sola: se lo perdi, riapprova e te ne do un altro.\n');
    console.log(`  ${URL_PUBBLICO}/invito#t=${inv.token}\n`);
    console.log(`Vale fino al ${quando(inv.scadeIl)}. Chi lo apre sceglie li' la sua password:`);
    console.log('non gliene devi dare nessuna, e nessuno — nemmeno tu — la vedra\'.');
    process.exit(0);
  }

  if (flag('--rifiuta')) {
    intestazione();
    const a = dopo('--rifiuta');
    const r = trovaRichiesta(a[0], reg.elenco());
    reg.rifiuta(r.id, a.slice(1).join(' ') || null);
    console.log(`Rifiutata la richiesta di ${r.nome}. Se aveva gia' un link, adesso non vale piu'.`);
    process.exit(0);
  }

  if (flag('--revoca')) {
    intestazione();
    const chi = dopo('--revoca')[0];
    if (!chi) esci('Serve il nome (o l\'id) della persona. --elenco per vederli.');
    const tolta = reg.revoca(chi);
    if (!tolta) esci(`Nessuna persona di nome o id "${chi}".`);
    console.log(`${tolta.nome} non entra piu'. Smette subito: la sessione si ricontrolla a ogni richiesta.`);
    console.log('Le sue ricerche e i suoi salvataggi restano dove sono, e il suo nome resta riservato.');
    process.exit(0);
  }

  if (flag('--registro')) {
    intestazione();
    const n = Number(dopo('--registro')[0]) || 50;
    const righe = dbmod.registro(n);
    console.log(`REGISTRO — le ultime ${righe.length} righe, dalla piu' recente\n`);
    if (!righe.length) console.log('  vuoto.');
    for (const r of righe) {
      console.log(`  ${quando(r.quando).padEnd(20)} ${String(r.evento).padEnd(16)} ${r.nome || r.persona || ''}`);
      if (r.dettagli) console.log(`  ${' '.repeat(20)} ${' '.repeat(16)} ${r.dettagli}`);
    }
    process.exit(0);
  }

  esci('Non ho capito. Lancialo senza argomenti per vedere come si usa.');
} catch (e) {
  esci('Errore: ' + e.message);
}
