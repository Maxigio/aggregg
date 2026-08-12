#!/usr/bin/env node
'use strict';
/**
 * CHI PUÒ ENTRARE, SCRITTO IN UN FILE INVECE CHE A COMANDI.
 *
 * `set-password.js` aggiunge una persona alla volta: per undici accessi sono undici comandi
 * da ricordare, e nessun posto dove rileggere chi c'e' senza interrogare l'app. Peggio: chi
 * viene tolto va tolto a mano, quindi una password data e dimenticata resta valida per sempre.
 *
 * Qui l'elenco sta nel `.env` e questo script ce lo RISPECCHIA: chi c'e' nel file entra, chi
 * non c'e' PIU' non entra piu' — comprese la password demo condivisa e le persone di ieri.
 * Il `.env` non e' versionato (`.gitignore`), quindi le password in chiaro restano su una
 * macchina sola.
 *
 * Nel .env:
 *   AMR_ADMIN_PASSWORD=<password del proprietario>
 *   AMR_UTENTE_01=Nome Cognome:password              → sola lettura
 *   AMR_UTENTE_02=Nome Cognome:password:piena        → puo' anche scrivere
 *   AMR_UTENTE_03=                                   → riga vuota: ignorata
 *
 * Uso:
 *   node scripts/utenti-da-env.js --prova     dice cosa farebbe, non scrive niente
 *   node scripts/utenti-da-env.js             applica
 *
 * DUE COSE CHE SUCCEDONO SEMPRE, ed e' voluto:
 *   - cambiare la password del proprietario rigenera il `secret`: TUTTE le sessioni aperte
 *     (anche quelle di chi non e' cambiato) devono rifare il login;
 *   - la password demo condivisa viene ritirata: con una password a testa l'ospite anonimo
 *     non serve piu', e resterebbe una chiave in giro senza nome.
 *
 * PRIMA si controlla tutto, POI si scrive. Una password corta alla nona riga non deve
 * lasciare otto persone dentro e tre fuori.
 */
const fs = require('fs');
const path = require('path');
const auth = require('../backend/auth');

/**
 * dotenv si chiama DENTRO il comando, non al caricamento del file.
 *
 * Caricarlo qui in cima voleva dire che bastava `require` di questo modulo per riversare il
 * .env di questa macchina dentro `process.env` — comprese le destinazioni di AMR_AUTH_ANCHE.
 * Un modulo non deve cambiare l'ambiente di chi lo importa: chi lo importa sono i test.
 */
const caricaEnv = () => require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CHIAVE_ADMIN = 'AMR_ADMIN_PASSWORD';
const PREFISSO_UTENTE = 'AMR_UTENTE_';
const SUFFISSO_PIENA = ':piena';

/**
 * Una riga `Nome:password[:piena]` → {nome, pw, ruolo}.
 *
 * Si divide sul PRIMO due-punti, non su tutti: il resto e' la password, che i due-punti puo'
 * contenerli. L'unico limite e' che non puo' FINIRE con `:piena`, ed e' scritto nel .env.
 */
function leggiVoce(chiave, valore) {
  const grezzo = String(valore == null ? '' : valore).trim();
  const taglio = grezzo.indexOf(':');
  if (taglio < 1) throw new Error(`${chiave}: serve la forma "Nome Cognome:password" (manca il due-punti o il nome).`);
  const nome = grezzo.slice(0, taglio).trim();
  let resto = grezzo.slice(taglio + 1);
  let ruolo = 'demo';
  if (resto.toLowerCase().endsWith(SUFFISSO_PIENA)) {
    ruolo = 'full';
    resto = resto.slice(0, -SUFFISSO_PIENA.length);
  }
  if (!nome) throw new Error(`${chiave}: il nome e' vuoto.`);
  if (resto.length < auth.MIN_LEN) {
    throw new Error(`${chiave} (${nome}): password troppo corta, minimo ${auth.MIN_LEN} caratteri.`);
  }
  const id = auth.idDaNome(nome);
  if (!id) throw new Error(`${chiave}: "${nome}" non produce un identificativo utilizzabile.`);
  if (auth.ID_RISERVATI.has(id)) throw new Error(`${chiave}: "${id}" e' riservato, usa un altro nome.`);
  return { chiave, nome, id, pw: resto, ruolo };
}

/**
 * Dall'ambiente al piano, senza toccare niente. Torna {admin, voci} oppure lancia.
 * Le chiavi si ordinano per nome (AMR_UTENTE_01, _02, …) cosi' l'ordine e' quello del file.
 */
function pianifica(env) {
  const admin = String(env[CHIAVE_ADMIN] == null ? '' : env[CHIAVE_ADMIN]).trim();
  if (!admin) throw new Error(`Manca ${CHIAVE_ADMIN} nel .env: senza password del proprietario l'app non parte.`);
  if (admin.length < auth.MIN_LEN) {
    throw new Error(`${CHIAVE_ADMIN}: password troppo corta, minimo ${auth.MIN_LEN} caratteri.`);
  }
  const voci = Object.keys(env)
    .filter(k => k.startsWith(PREFISSO_UTENTE) && String(env[k] || '').trim())
    .sort()
    .map(k => leggiVoce(k, env[k]));

  // Due nomi diversi che danno lo stesso id sarebbero la stessa persona: il secondo
  // sovrascriverebbe il primo in silenzio, e uno dei due si troverebbe fuori senza spiegazione.
  const visti = new Map();
  for (const v of voci) {
    if (visti.has(v.id)) throw new Error(`${v.chiave} e ${visti.get(v.id)}: "${v.nome}" da' lo stesso identificativo (${v.id}). Cambiane uno.`);
    visti.set(v.id, v.chiave);
  }

  // Due password uguali NON sono due accessi: verifica() torna la prima che combacia, quindi
  // il secondo entrerebbe con l'identita' del primo — stesso limite di richieste, stesso nome
  // nel registro accessi. Va detto qui, non scoperto dopo.
  const perPassword = new Map();
  for (const v of [{ chiave: CHIAVE_ADMIN, nome: 'proprietario', pw: admin }, ...voci]) {
    const gia = perPassword.get(v.pw);
    if (gia) throw new Error(`${gia} e ${v.chiave} hanno la STESSA password: chi entra col secondo verrebbe scambiato per il primo. Cambiane una.`);
    perPassword.set(v.pw, v.chiave);
  }
  return { admin, voci };
}

// ─── Le altre copie di auth.json ────────────────────────────────────────────
/**
 * LO STESSO FILE VIVE IN PIU' POSTI, E DIMENTICARNE UNO NON SI VEDE.
 *
 * Misurato il 2026-08-03: le credenziali erano in tre posti — `data/auth.json`, la cartella
 * Electron `~/Library/Application Support/automotoradar` (il servizio dell'iMac parte con
 * USER_DATA_PATH puntato li') e l'installazione sul Mac di papa'. Aggiornati i primi due, il
 * terzo e' rimasto al 18 giugno: la password nuova veniva rifiutata da un server, e quella
 * "ritirata" continuava a funzionare su un altro raggiungibile dal tailnet. Nessun errore,
 * nessun avviso: solo due macchine che rispondevano cose diverse alla stessa password.
 *
 * Nel .env:
 *   AMR_AUTH_ANCHE=/percorso/locale, utente@host:/percorso/remoto
 *   AMR_AUTH_SSH_KEY=~/.ssh/chiave        (facoltativa, per le destinazioni remote)
 *
 * Sono CARTELLE, non file: dentro ognuna finisce `auth.json`.
 */
const CHIAVE_ANCHE = 'AMR_AUTH_ANCHE';
const CHIAVE_SSH = 'AMR_AUTH_SSH_KEY';

/** `utente@host:/percorso` e' remoto; tutto il resto e' una cartella su questo computer. */
const eRemota = d => /^[^/\s]+@[^:\s]+:/.test(d);

function destinazioni(env) {
  return String(env[CHIAVE_ANCHE] || '')
    .split(/[,\n]/).map(s => s.trim()).filter(Boolean)
    .map(d => ({ dove: d, remota: eRemota(d) }));
}

const opzioniSsh = env => {
  const k = String(env[CHIAVE_SSH] || '').trim();
  const chiave = k.startsWith('~') ? path.join(require('os').homedir(), k.slice(1)) : k;
  return chiave ? ['-i', chiave, '-o', 'IdentitiesOnly=yes'] : [];
};

/**
 * SI CONTROLLA PRIMA, come per le password. Una destinazione irraggiungibile scoperta a
 * meta' giro lascerebbe due macchine allineate e una indietro — cioe' esattamente il guaio
 * che questa funzione esiste per evitare.
 */
function verificaDestinazioni(dest, env) {
  const { execFileSync } = require('child_process');
  for (const d of dest) {
    if (!d.remota) {
      if (!fs.existsSync(d.dove)) throw new Error(`${CHIAVE_ANCHE}: la cartella "${d.dove}" non esiste.`);
      if (!fs.statSync(d.dove).isDirectory()) throw new Error(`${CHIAVE_ANCHE}: "${d.dove}" non e' una cartella.`);
      try { fs.accessSync(d.dove, fs.constants.W_OK); }
      catch (_) { throw new Error(`${CHIAVE_ANCHE}: "${d.dove}" non e' scrivibile.`); }
      continue;
    }
    const [host, percorso] = [d.dove.slice(0, d.dove.indexOf(':')), d.dove.slice(d.dove.indexOf(':') + 1)];
    try {
      execFileSync('ssh', [...opzioniSsh(env), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
        host, `test -d ${JSON.stringify(percorso)}`], { stdio: 'pipe' });
    } catch (_) {
      throw new Error(`${CHIAVE_ANCHE}: non raggiungo "${d.dove}" (host irraggiungibile, chiave sbagliata o cartella assente).`);
    }
  }
}

/** Copia auth.json in ogni destinazione. Torna un resoconto, mai il contenuto. */
function copiaAltrove(sorgente, dest, env) {
  const { execFileSync } = require('child_process');
  return dest.map(d => {
    try {
      if (d.remota) {
        const sep = d.dove.endsWith('/') ? '' : '/';
        execFileSync('scp', [...opzioniSsh(env), '-q', sorgente, `${d.dove}${sep}auth.json`], { stdio: 'pipe' });
      } else {
        fs.copyFileSync(sorgente, path.join(d.dove, 'auth.json'));
      }
      return { dove: d.dove, esito: 'copiato' };
    } catch (e) {
      return { dove: d.dove, esito: 'FALLITA: ' + String(e.message).split('\n')[0] };
    }
  });
}

/**
 * Il piano diventa auth.json. Torna il resoconto, senza nessuna password dentro.
 *
 * L'AMBIENTE E' OBBLIGATORIO, e non ha `process.env` come valore di difetto. Ce l'aveva, ed e'
 * costato caro: `require` di questo file esegue `dotenv.config()`, quindi dentro i test
 * `process.env` conteneva il .env VERO. Una chiamata senza ambiente copiava le credenziali di
 * prova nella cartella Electron dell'iMac e, via scp, sul Mac di papa'. Far girare la suite
 * chiudeva fuori tutti da entrambe le macchine. Ora chi non lo passa prende un errore invece
 * di scrivere sulle macchine di qualcun altro.
 */
function applica({ admin, voci }, env) {
  if (!env || typeof env !== 'object') {
    throw new Error("applica(): serve l'ambiente da cui leggere le destinazioni. Passa `process.env` dal comando, `{}` nei test.");
  }
  const dest = destinazioni(env);
  verificaDestinazioni(dest, env);                           // prima di scrivere ovunque, anche qui
  const file = auth.setPassword(admin);                      // per primo: gli altri hanno bisogno che il file esista
  for (const v of voci) auth.setPersona(v.nome, v.pw, v.ruolo);
  const tenuti = new Set(voci.map(v => v.id));
  // CHI E' ENTRATO DALL'ALTRA PORTA NON E' UN DIMENTICATO.
  // Lo specchio del .env vale per chi dal .env e' arrivato. Da quando le persone possono
  // registrarsi da sole ed essere approvate (`auth.creaPersona`, origine 'web'), toglierle qui
  // vorrebbe dire che il primo giro di gestione utenti cancella tutti gli iscritti — e i loro
  // dati restano nel magazzino senza piu' un padrone che possa entrare a prenderli.
  const persone = auth.persone();
  const daWeb = persone.filter(p => p.origine === 'web').map(p => p.id);
  const tolti = persone.filter(p => p.origine !== 'web' && !tenuti.has(p.id)).map(p => p.id);
  for (const id of tolti) auth.togliPersona(id);
  const demoTolta = auth.togliDemoCondiviso();
  const copie = copiaAltrove(file, dest, env);
  return { file, tolti, daWeb, demoTolta, copie };
}

function principale(argv) {
  caricaEnv();
  const prova = argv.includes('--prova');
  const piano = pianifica(process.env);

  console.log(`Proprietario: password ${prova ? 'da impostare' : 'impostata'}.`);
  if (!piano.voci.length) console.log('Nessun utente elencato nel .env.');
  for (const v of piano.voci) {
    console.log(`  ${v.nome}  (id ${v.id})  ${v.ruolo === 'full' ? "puo' scrivere" : 'sola lettura'}`);
  }

  const dest = destinazioni(process.env);

  if (prova) {
    const persone = auth.persone();
    const tenuti = new Set(piano.voci.map(v => v.id));
    const daWeb = persone.filter(p => p.origine === 'web').map(p => p.id);
    const tolti = persone.filter(p => p.origine !== 'web' && !tenuti.has(p.id)).map(p => p.id);
    if (tolti.length) console.log(`Verrebbero tolti: ${tolti.join(', ')}`);
    if (daWeb.length) console.log(`Restano comunque (registrati dal web, non stanno nel .env): ${daWeb.join(', ')}`);
    if (dest.length) {
      console.log('Le credenziali finirebbero anche in:');
      for (const d of dest) console.log(`  ${d.dove}${d.remota ? '  (via ssh)' : ''}`);
      // La raggiungibilita' si prova ADESSO: scoprire a giro finito che una macchina non
      // risponde vuol dire scoprirlo quando le altre sono gia' cambiate.
      try { verificaDestinazioni(dest, process.env); console.log('  tutte raggiungibili.'); }
      catch (e) { console.log('  ' + e.message); }
    }
    console.log('Prova soltanto: non ho scritto niente. Togli --prova per applicare.');
    return;
  }

  const esito = applica(piano, process.env);
  console.log(`Scritto in ${esito.file}`);
  for (const c of esito.copie) console.log(`  → ${c.dove}: ${c.esito}`);
  if (esito.tolti.length) console.log(`Tolti (non entrano piu'): ${esito.tolti.join(', ')}`);
  if (esito.daWeb.length) console.log(`Lasciati stare (registrati dal web): ${esito.daWeb.join(', ')}`);
  if (esito.demoTolta) console.log('Password demo condivisa ritirata.');
  console.log('Tutte le sessioni aperte sono scadute: chi era dentro rifa il login.');
  const falliti = esito.copie.filter(c => c.esito !== 'copiato');
  if (falliti.length) {
    // Non basta stamparlo: una copia mancata e' una macchina che accetta ancora le password
    // vecchie, ed e' il guaio esatto che questo elenco serve a chiudere.
    console.error(`\nATTENZIONE: ${falliti.length} cop${falliti.length === 1 ? 'ia' : 'ie'} non riuscit${falliti.length === 1 ? 'a' : 'e'}: quelle macchine hanno ancora le credenziali vecchie.`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try { principale(process.argv.slice(2)); }
  catch (e) { console.error('Errore: ' + e.message); process.exit(1); }
}

module.exports = {
  leggiVoce, pianifica, applica, destinazioni, verificaDestinazioni, copiaAltrove,
  CHIAVE_ADMIN, PREFISSO_UTENTE, CHIAVE_ANCHE, CHIAVE_SSH,
};
