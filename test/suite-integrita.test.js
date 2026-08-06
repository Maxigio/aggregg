'use strict';
/**
 * INTEGRITA' DELLA SUITE — garantisce che i test esistano ancora.
 *
 * CORREZIONE DEL 2026-07-26. La prima versione di questo commento diceva che `node --test` esce
 * con codice 0 quando un file di test non riesce a CARICARSI. E' FALSO, ed era una misura
 * sbagliata: l'exit code letto veniva da un `| tail` in coda al comando, non da node. Rimisurato
 * su node v26.4.0 senza pipe — require di modulo inesistente, throw dopo la registrazione, sia
 * sul singolo file sia sulla suite intera — l'uscita e' sempre 1. Il fallimento al load si vede.
 * (Un granello di verita' resta: dentro `describe` i CONTATORI possono dire «pass 0, fail 0».
 * L'uscita del processo no, ed e' l'unica cosa che npm test guarda.)
 *
 * PERCHE' IL FILE RESTA, per un motivo diverso da quello scritto prima: dodici moduli del
 * backend non sono richiesti da NESSUN test e sono coperti solo qui — fra cui auth.js,
 * db/index.js, normalize.js, utils.js, web-parts.js. Se uno prende un errore
 * di sintassi o un require morto, senza il primo test qui sotto la suite resta verde. E' uno
 * smoke test sul caricamento, e costa circa un secondo.
 *
 * Il secondo test (dipendenze dei file di test) e' piu' debole: i file che le usano falliscono
 * gia' da soli al load. Serve pero' a scoprire subito QUALE simbolo e' sparito, senza leggere
 * lo stack di un altro file.
 */
// Il log NON va nel registro operativo vero: questo file requira server.js (o un modulo
// che lo tira dentro), e server.js installa il tee su file. Senza questa riga ogni run
// appendeva a data/logs/amr.log, righe ERROR comprese, e con la rotazione a 5 MB poteva
// far ruotare il log vero. Deve stare PRIMA di ogni require di backend: LOG_DIR e' una
// const valutata al caricamento del modulo.
const os = require('node:os'), fsTmp = require('node:fs'), pathTmp = require('node:path');
process.env.AMR_LOG_DIR = fsTmp.mkdtempSync(pathTmp.join(os.tmpdir(), 'amr-log-'));

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RADICE = path.join(__dirname, '..');

function tuttiJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : tuttiJs(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('ogni modulo del backend si carica', () => {
  const mods = tuttiJs(path.join(RADICE, 'backend'));
  assert.ok(mods.length > 40, `attesi molti moduli, trovati ${mods.length}: il conteggio e' crollato?`);
  const ko = [];
  for (const m of mods) {
    try { require(m); } catch (e) { ko.push(`${path.relative(RADICE, m)} → ${e.message}`); }
  }
  assert.deepStrictEqual(ko, [], 'moduli che non si caricano');
});

test('ogni dipendenza dichiarata dai file di test si risolve', () => {
  // Si caricano le DIPENDENZE dei file di test, non i file stessi (li ri-registrerebbe).
  // E' la difesa diretta: se un backend cambia nome, qui diventa rosso invece di far sparire
  // in silenzio il file che lo usava.
  // La lettura qui e' RICORSIVA, il glob di npm test NO — e le due cose insieme erano una
  // trappola: `node --test test/*.test.js` non attraversa le cartelle (misurato su node
  // v26.4.0: un file in test/_prova/ non viene eseguito), mentre questo conteggio lo
  // includeva. Un test spostato in una sottocartella smetteva di girare IN SILENZIO e la
  // suite restava verde. Il commento di prima prometteva il contrario.
  const files = fs.readdirSync(__dirname, { recursive: true }).map(String).filter(f => f.endsWith('.test.js'));
  assert.ok(files.length >= 30, `attesi almeno 30 file di test, trovati ${files.length}`);
  // La guardia che rende vera la promessa: se un file finisce in una sottocartella, il
  // runner non lo esegue — quindi qui diventa rosso invece di sparire.
  const nascosti = files.filter(f => f.includes(path.sep));
  assert.deepStrictEqual(nascosti, [],
    'questi file NON vengono eseguiti da "npm test" (il glob non e\' ricorsivo): riportali in test/ o cambia lo script');
  const ko = [];
  for (const f of files) {
    const testo = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const m of testo.matchAll(/require\(\s*'(\.[^']+)'\s*\)/g)) {
      const rel = m[1];
      if (/fixtures\//.test(rel)) continue;          // le fixture le prova gia' il test che le usa
      try { require(path.resolve(__dirname, rel)); }
      catch (e) { ko.push(`${f} richiede ${rel} → ${e.message}`); }
    }
  }
  assert.deepStrictEqual(ko, [], 'dipendenze di test non risolvibili');
});

test('init: il gestore del cambio tipo e\' registrato PRIMA del ripristino del modo', () => {
  // `ripristinaModo()` rimette il radio su Moto e lancia `change`; l'unico posto che chiama
  // populateMarca('moto') e' il gestore di quel `change`. Registrandolo dopo, l'evento partiva
  // a vuoto e chi riapriva l'app in Moto non poteva scrivere NESSUNA marca.
  const src = fs.readFileSync(path.join(RADICE, 'frontend', 'app.js'), 'utf8');
  const init = src.slice(src.indexOf('async function init()'), src.indexOf('\n// ─── Modi di ricerca'));
  const gestore = init.indexOf("tipoInputs.forEach(input => input.addEventListener('change'");
  // La CHIAMATA, non il nome: cercando la sola `ripristinaModo()` si aggancia il commento
  // qui sopra in app.js, e il test diventa rosso per un motivo che non c'entra.
  const ripristino = init.indexOf('daUrl) ripristinaModo()');
  assert.ok(gestore > 0, 'il gestore del cambio tipo non e\' piu\' in init()');
  assert.ok(ripristino > 0, 'la chiamata `if (!daUrl) ripristinaModo();` non e\' piu\' in init()');
  assert.ok(gestore < ripristino,
    'il gestore di `change` va registrato PRIMA di ripristinaModo(), altrimenti il ripristino su Moto lascia il catalogo marche vuoto');
});

test('il cambio tab dei Ricambi tocca tutti e soli gli input dei Ricambi', () => {
  // `.rc-input` e' un GANCIO, non uno stile: decide quale dei tre input mostrare. Quando la
  // presa era su tutto il documento agganciava anche #cpUrl (il link della vetrina, altra riga
  // della stessa barra), che senza `data-rcfor` finiva nascosto a ogni cambio tab.
  const app = fs.readFileSync(path.join(RADICE, 'frontend', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(RADICE, 'frontend', 'index.html'), 'utf8');

  // 1) la presa e' ancorata al contenitore dei Ricambi
  for (const sel of ["#ricambiFields .rc-input[data-rcfor=", "'#ricambiFields .rc-input'"]) {
    assert.ok(app.includes(sel), `la ricerca di .rc-input non e' piu' ancorata a #ricambiFields (${sel})`);
  }
  // 2) e nessun elemento fuori da #ricambiFields porta quella classe
  // `\b` non basta: il trattino e' un confine di parola, quindi \brc-input\b aggancia anche
  // `rc-input-row`, che e' la riga contenitore e non c'entra. Serve il token intero.
  const GANCIO = /class="[^"]*\brc-input(?=[\s"])/g;
  const dentro = html.slice(html.indexOf('id="ricambiFields"'), html.indexOf('id="competitorFields"'));
  const fuori = html.replace(dentro, '');
  assert.strictEqual((fuori.match(GANCIO) || []).length, 0,
    'un elemento fuori da #ricambiFields porta la classe-gancio rc-input: verra\' nascosto dal cambio tab');
  // 3) e i tre input dei Ricambi ce l'hanno ancora, con il loro data-rcfor
  assert.strictEqual((dentro.match(/class="[^"]*\brc-input(?=[\s"])[^"]*"[^>]*data-rcfor=/g) || []).length, 3,
    'i tre input dei Ricambi devono avere sia rc-input sia data-rcfor');
});

test('richiedere server.js resta senza effetti collaterali', () => {
  // Se qualcuno rimettesse app.listen incondizionato, l'intera suite aprirebbe una porta e
  // scalderebbe due browser headless a ogni esecuzione.
  const srv = require('../backend/server');
  assert.strictEqual(srv.server, null,
    'server.js si e\' rimesso in ascolto al require: rimetti la guardia require.main === module');
});

// ─── Il pacchetto e' il programma che gira ─────────────────────────────────────────────
//
// `build.files` e' un elenco scritto a mano, e un elenco scritto a mano diverge dal grafo
// delle dipendenze reale: e' GIA' successo nei due sensi. Le build di giugno imbarcavano
// data/.subito-session.json (cookie DataDome) e data/chrome-profile/ interi; e i require
// di ../scripts/ in cima a server.js avrebbero ucciso al boot la build successiva, perche'
// scripts/ non era nell'elenco. Queste guardie sono statiche (niente build dentro i test):
// difendono l'ELENCO, la prova sull'artefatto resta un gesto da fare alla build.

test('pacchetto: ogni segreto di .gitignore ha la sua negazione in build.files', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RADICE, 'package.json'), 'utf8'));
  const files = pkg.build.files;
  // Un glob di electron-builder → regex: ** attraversa le cartelle, * no.
  const daGlob = g => new RegExp('^' + g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*') + '$');
  const negazioni = files.filter(f => f.startsWith('!')).map(f => daGlob(f.slice(1)));
  const righe = fs.readFileSync(path.join(RADICE, '.gitignore'), 'utf8').split('\n')
    .map(r => r.trim()).filter(r => r.startsWith('data/'));
  assert.ok(righe.length >= 15, `attese molte righe data/ in .gitignore, trovate ${righe.length}`);
  const scoperte = righe.filter(r => {
    // Una cartella ignorata si rappresenta con un file dentro di lei.
    const rappresentante = r.endsWith('/') ? r + 'x' : r;
    return !negazioni.some(re => re.test(rappresentante));
  });
  assert.deepStrictEqual(scoperte, [],
    'righe data/ di .gitignore che "data/**" imbarcherebbe nel pacchetto: aggiungi la negazione in build.files');
});

test('pacchetto: quello che il boot richiede e\' nell\'elenco', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RADICE, 'package.json'), 'utf8'));
  const files = pkg.build.files;
  // I require di primo livello verso ../scripts/ in server.js: ognuno pretende scripts/**.
  const srv = fs.readFileSync(path.join(RADICE, 'backend', 'server.js'), 'utf8');
  const daScripts = [...srv.matchAll(/^const .+= require\('\.\.\/scripts\/[^']+'\)/gm)];
  if (daScripts.length) {
    assert.ok(files.includes('scripts/**'),
      `server.js richiede ${daScripts.length} moduli da ../scripts/ al boot: senza "scripts/**" in build.files l'app impacchettata non parte`);
    // E la Guida legge i markdown: senza docs/guida/** parte e serve una Guida vuota.
    assert.ok(files.includes('docs/guida/**'),
      'build-guida legge docs/guida/*.md a runtime: serve "docs/guida/**" in build.files');
  }
  // Nessuna devDependency puo' essere richiesta A LIVELLO DI MODULO da un file che il boot
  // carica: nel pacchetto le devDependencies non ci sono, e il require top-level scavalca
  // ogni try/catch dichiarato piu' a valle (e' successo con esbuild in build-frontend.js).
  const devDeps = Object.keys(pkg.devDependencies || {});
  const alBoot = [...srv.matchAll(/require\('\.\.\/scripts\/([^']+)'\)/g)].map(m => m[1]);
  const ko = [];
  for (const s of alBoot) {
    const testo = fs.readFileSync(path.join(RADICE, 'scripts', s + '.js'), 'utf8')
      .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');   // i commenti possono nominare il pacchetto
    for (const dep of devDeps) {
      if (new RegExp(`^const .+= require\\('${dep}'\\)`, 'm').test(testo)) {
        ko.push(`scripts/${s}.js richiede '${dep}' (devDependency) a livello di modulo`);
      }
    }
  }
  assert.deepStrictEqual(ko, [], 'require top-level di devDependencies in moduli caricati al boot');
});
