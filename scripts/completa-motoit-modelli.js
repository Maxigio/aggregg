'use strict';
/**
 * COMPLETA i MODELLI di data/motoit-catalogo.json dalle pagine /listino.
 *
 * PERCHE'. L'enumeratore ha chiesto i modelli a `/api-50/market/search/models/<marca>/Used`,
 * che restituisce i modelli con un USATO IN VENDITA adesso, non il catalogo. E' la stessa
 * trappola gia' trovata sulle versioni, sulla stessa fonte e nella stessa riga di codice.
 * Misurato su tre marche:
 *     yamaha  api 163  ·  pagine listino 230   (+41%)
 *     honda   api 198  ·  pagine listino 284   (+44%)
 *     ducati  api 121  ·  pagine listino 153   (+26%)
 *
 * COSA FA. Due pagine per marca — /listino/<marca> e /listino/fuori-listino/<marca> — e ne
 * estrae gli slug dei modelli. 76 marche, ~152 richieste.
 *
 * NON DISTRUGGE. I modelli esistenti non si toccano: si AGGIUNGONO quelli mancanti, marcati
 * `fonte: "listino"`, con `versioni: {}` e `completoVersioni: false` cosi' che la passata
 * delle versioni sappia che gli mancano.
 *
 * GUARDIA SULLO SPAZIO DEGLI SLUG. Se gli slug delle pagine fossero un identificatore diverso
 * da quello dell'API, aggiungerli creerebbe doppioni invece di copertura. Per ogni marca si
 * misura quanti degli slug gia' noti ricompaiono nelle pagine: sotto il 50% ci si ferma e lo
 * si dichiara, invece di sporcare il catalogo.
 */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const OUT = path.join(R, 'data', 'motoit-catalogo.json');
const HOST = 'www.moto.it';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAUSA_MS = 1500;
const TIMEOUT_MS = 30000;
const SOGLIA_SOVRAPPOSIZIONE = 0.5;

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const BUDGET = Math.max(1, Number(arg('budget', 400)) || 400);
const SOLO = (arg('marche', '') || '').split(',').map(s => s.trim()).filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
class Bloccati extends Error {}
let spese = 0, bloccato = false;

function scarica(percorso) {
  spese++;
  return new Promise((resolve, reject) => {
    const req = https.get({ host: HOST, path: percorso, headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' } }, res => {
      if (res.statusCode === 403 || res.statusCode === 429) { res.resume(); return reject(new Bloccati('HTTP ' + res.statusCode)); }
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(scarica(new URL(res.headers.location, 'https://' + HOST + percorso).pathname));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const pezzi = [];
      res.on('data', c => pezzi.push(c));
      res.on('end', () => {
        let b = Buffer.concat(pezzi);
        if ((res.headers['content-encoding'] || '').includes('gzip')) {
          try { b = zlib.gunzipSync(b); } catch (e) { return reject(new Error('gzip illeggibile')); }
        }
        resolve(b.toString('utf8'));
      });
    });
    req.on('error', e => reject(new Error(e.message)));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Modelli di una marca dentro una pagina. Il link modello e' /listino/<marca>/<modello>,
 * quello versione ha un segmento in piu': /listino/<marca>/<modello>/<versione>/<id>.
 * Si prende il PRIMO segmento dopo la marca in entrambi i casi, cosi' un modello che compare
 * solo tramite una sua versione non si perde.
 */
function modelliNella(html, marcaSlug) {
  const re = new RegExp('href="\\/listino\\/(?:fuori-listino\\/)?' + esc(marcaSlug) + '\\/([^"\\/?#]+)(?:\\/([^"\\/?#]+)\\/([0-9A-Za-z]{4,10}))?"(?:[^>]*title="([^"]*)")?', 'g');
  const out = new Map();
  let m;
  while ((m = re.exec(html))) {
    const slug = m[1];
    if (!slug || slug === 'fuori-listino') continue;
    // il titolo appartiene alla VERSIONE quando il link e' di terzo livello: non e' il nome
    // del modello e non va usato come tale.
    const titolo = m[2] ? '' : (m[4] || '');
    if (!out.has(slug) || (titolo && !out.get(slug))) out.set(slug, titolo);
  }
  return out;
}

(function autotest() {
  const finto = '<a href="/listino/yamaha/mt-07" title="Yamaha MT-07">x</a>'
    + '<a href="/listino/yamaha/mt-09/mt-09-2021-24/AbC123" title="MT-09 (2021 - 24)">y</a>'
    + '<a href="/listino/fuori-listino/yamaha/tdm-900" title="Yamaha TDM 900">z</a>'
    + '<a href="/listino/honda/cb-500">altra marca</a>';
  const v = modelliNella(finto, 'yamaha');
  if (v.size !== 3) throw new Error('modelliNella: attesi 3 modelli, trovati ' + v.size + ' → ' + [...v.keys()]);
  if (!v.has('mt-09')) throw new Error('modelliNella: un modello raggiunto solo via versione va preso lo stesso');
  if (v.get('mt-09')) throw new Error('modelliNella: il titolo di un link-versione non e il nome del modello');
  if (v.has('cb-500')) throw new Error('modelliNella: presa una marca sbagliata');
  console.log('autotest modelliNella: ok');
})();

(async () => {
  const cat = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const falliti = [], sospette = [];
  let aggiunti = 0, marcheFatte = 0;

  const conta = () => {
    const m = Object.values(cat.marche);
    return {
      marche: m.length,
      complete: m.filter(x => x.completa).length,
      completeModelli: m.filter(x => x.completaModelli !== false).length,
      modelli: m.reduce((a, x) => a + Object.keys(x.modelli || {}).length, 0),
      versioni: m.reduce((a, x) => a + Object.values(x.modelli || {}).reduce((b, y) => b + Object.keys(y.versioni || {}).length, 0), 0),
    };
  };
  const salva = () => {
    cat.generatedAt = new Date().toISOString();
    cat.conta = conta();
    cat.richiesteSpeseModelliListino = spese;
    cat.bloccatoModelliListino = bloccato;
    cat.fallitiModelliListino = falliti;
    cat.sospetteModelliListino = sospette;
    cat.notaModelliListino = 'I modelli marcati `fonte: "listino"` vengono dalle pagine /listino, '
      + 'perche\' l\'API /Used elenca solo i modelli con un usato in vendita: misurato su tre marche, '
      + 'dal 26% al 44% mancante. Nessun modello preesistente e\' stato tolto.';
    const tmp = OUT + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cat, null, 1) + '\n');
    fs.renameSync(tmp, OUT);
  };
  const rete = (che, e) => {
    console.error('[modelli] ' + che + ': ' + ((e && e.stack) || e));
    try { salva(); console.error('[modelli] salvato quello che c\'era prima di uscire'); }
    catch (e2) { console.error('[modelli] nemmeno il salvataggio e\' riuscito: ' + e2.message); }
    process.exit(1);
  };
  process.on('uncaughtException', e => rete('eccezione non gestita', e));
  process.on('unhandledRejection', e => rete('promessa rifiutata e non gestita', e));

  const prima = conta();
  console.log('[modelli] partenza: ' + prima.marche + ' marche · ' + prima.modelli + ' modelli · budget ' + BUDGET);

  for (const [slug, marca] of Object.entries(cat.marche)) {
    if (bloccato || spese >= BUDGET) break;
    if (SOLO.length && !SOLO.includes(slug)) continue;
    if (marca.completoModelliListino) continue;

    const trovati = new Map();
    let erroreMarca = null;
    for (const p of ['/listino/' + slug, '/listino/fuori-listino/' + slug]) {
      let html;
      try { html = await scarica(p); }
      catch (e) {
        if (e instanceof Bloccati) { bloccato = true; erroreMarca = e.message; break; }
        erroreMarca = e.message; await sleep(PAUSA_MS); continue;
      }
      await sleep(PAUSA_MS);
      for (const [s, t] of modelliNella(html, slug)) if (!trovati.has(s) || (t && !trovati.get(s))) trovati.set(s, t);
    }
    if (bloccato) break;
    if (!trovati.size) { falliti.push(slug + ': ' + (erroreMarca || 'nessun modello nelle pagine')); continue; }

    // GUARDIA: gli slug delle pagine devono essere lo STESSO spazio di quelli che abbiamo
    const noti = Object.keys(marca.modelli || {});
    const ricompaiono = noti.filter(s => trovati.has(s)).length;
    const q = noti.length ? ricompaiono / noti.length : 1;
    if (noti.length >= 5 && q < SOGLIA_SOVRAPPOSIZIONE) {
      sospette.push(slug + ': solo ' + ricompaiono + '/' + noti.length + ' slug noti ricompaiono nelle pagine — spazio di identificatori diverso?');
      console.log('  ' + slug.padEnd(22) + '⚠ SALTATA: sovrapposizione ' + (100 * q).toFixed(0) + '%');
      continue;
    }

    let nuovi = 0;
    for (const [s, titolo] of trovati) {
      if (marca.modelli[s]) continue;
      const nome = String(titolo || '').replace(new RegExp('^' + esc(marca.nome) + '\\s+', 'i'), '').trim()
        || s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      marca.modelli[s] = { nome, chiave: slug + '|' + s, versioni: {}, completoVersioni: false, fonte: 'listino' };
      nuovi++; aggiunti++;
    }
    marca.completoModelliListino = true;
    marcheFatte++;
    console.log('  ' + slug.padEnd(22) + 'noti ' + String(noti.length).padStart(4)
      + ' · nelle pagine ' + String(trovati.size).padStart(4)
      + ' · NUOVI ' + String(nuovi).padStart(4)
      + ' · sovrapposizione ' + (100 * q).toFixed(0) + '%'
      + ' · richieste ' + spese);
    salva();
  }

  salva();
  const dopo = conta();
  console.log('\n[modelli] richieste ' + spese + '/' + BUDGET + (bloccato ? '  BLOCCATO' : ''));
  console.log('  marche fatte ' + marcheFatte + ' · falliti ' + falliti.length + ' · sospette ' + sospette.length);
  console.log('  modelli: ' + prima.modelli + ' → ' + dopo.modelli + '  (+' + aggiunti + ')');
  const restano = Object.values(cat.marche).filter(m => !m.completoModelliListino).length;
  console.log('  marche ancora da fare: ' + restano + (restano ? ' — rilancia per continuare' : ''));
  if (sospette.length) { console.log('  SOSPETTE (saltate, nessun dato toccato):'); sospette.forEach(x => console.log('     ' + x)); }
  console.log('[modelli] scritto data/motoit-catalogo.json');
})().catch(e => { console.error('ERRORE', e && e.stack); process.exit(1); });
