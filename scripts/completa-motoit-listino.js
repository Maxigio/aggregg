'use strict';
/**
 * COMPLETA data/motoit-catalogo.json con le versioni che l'API non da'.
 *
 * PERCHE'  L'endpoint /api-50/market/search/bikes/<chiave>/Used restituisce le versioni che
 *          hanno un usato in vendita ADESSO, non il catalogo. Misurato su 20 modelli scelti
 *          uno ogni 106 in ordine alfabetico: 53 versioni dall'API contro 83 dalle pagine
 *          listino, cioe' il 36% mancante, su 11 modelli su 20. `/New` e' un sottoinsieme di
 *          `/Used` (verificato: unione = 18 = Used). La pagina listino e' l'unica lista intera.
 *
 * COSA FA  Una pagina per modello: /listino/<marca>/<modello>, e se non contiene link-versione
 *          di QUEL modello, /listino/fuori-listino/<marca>/<modello>. La prima si reindirizza
 *          al listino di marca quando il modello e' fuori produzione — per questo il criterio
 *          non e' "status 200" ma "ha trovato versioni di questo modello".
 *
 * NON DISTRUGGE  Le versioni gia' presenti non si toccano mai: il nome dell'API vince, l'HTML
 *          aggiunge solo id nuovi. Un modello che fallisce tiene quello che aveva e si scrive
 *          il motivo. Il file non perde mai dati rispetto a prima.
 *
 * RIPRESA  Ogni modello chiuso porta `completoListino: true`. Rilanciare riparte da li'.
 *
 * Uso:
 *   node scripts/completa-motoit-listino.js                 riprende (tetto 3000 richieste)
 *   node scripts/completa-motoit-listino.js --budget 500
 *   node scripts/completa-motoit-listino.js --marche yamaha,bmw
 */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'motoit-catalogo.json');
const HOST = 'www.moto.it';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAUSA_MS = 1500;
const TIMEOUT_MS = 30000;
const SALVA_OGNI = 20;

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const BUDGET = Math.max(1, Number(arg('budget', 3000)) || 3000);
const SOLO = (arg('marche', '') || '').split(',').map(s => s.trim()).filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
class Bloccati extends Error {}

let spese = 0;
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

/** "MT-07 ABS (2014 - 16)" → {da:2014,a:2016}. Il secondo gruppo puo' essere a due cifre. */
function anniDa(testo) {
  const m = String(testo || '').match(/\((\d{4})(?:\s*[-–]\s*(\d{2,4}))?\s*\)/);
  if (!m) return null;
  const da = Number(m[1]);
  if (!m[2]) return { da, a: da };
  const g = Number(m[2]);
  const a = g > 999 ? g : Math.floor(da / 100) * 100 + g;
  return { da, a: a >= da ? a : a + 100 };
}

/**
 * Versioni di UN modello dentro una pagina. Gli id sono a caso MISTO (pyRg2m, R9Lybg): una
 * classe di caratteri in sole maiuscole ne perde la maggior parte — errore gia' fatto.
 * La stessa versione compare piu' volte nella pagina: la Map deduplica per id.
 */
function versioniNella(html, marcaSlug, modelloSlug) {
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    'href="\\/listino\\/(?:fuori-listino\\/)?' + esc(marcaSlug) + '\\/' + esc(modelloSlug)
    + '\\/([^"\\/]+)\\/([0-9A-Za-z]{4,10})"(?:[^>]*title="([^"]*)")?', 'g');
  const out = new Map();
  let m;
  while ((m = re.exec(html))) {
    const [, slug, id, titolo] = m;
    if (!out.has(id) || (titolo && !out.get(id).titolo)) out.set(id, { id, slug, titolo: titolo || '' });
  }
  return out;
}

/** Il titolo in produzione porta la marca davanti, quello fuori produzione no: si uniforma. */
function senzaMarca(titolo, marcaNome) {
  const t = String(titolo || '').trim();
  const p = String(marcaNome || '').trim();
  if (p && t.toLowerCase().startsWith(p.toLowerCase() + ' ')) return t.slice(p.length + 1).trim();
  return t;
}

// ── autocontrollo: se questi saltano, la corsa non ha senso ──────────────────
(function autotest() {
  for (const [t, da, a] of [['MT-07 (2014 - 16)', 2014, 2016], ['MT-07 (2025 - 26)', 2025, 2026],
    ['Caballero 500 Scrambler Deluxe 4T (2020)', 2020, 2020], ['Africa Twin (1999 - 02)', 1999, 2002]]) {
    const r = anniDa(t);
    if (!r || r.da !== da || r.a !== a) throw new Error('anniDa rotto su ' + t + ' → ' + JSON.stringify(r));
  }
  if (anniDa('CB 1000 Hornet') !== null) throw new Error('anniDa deve dare null senza anni');
  if (senzaMarca('Yamaha MT-07 (2025 - 26)', 'Yamaha') !== 'MT-07 (2025 - 26)') throw new Error('senzaMarca rotta');
  if (senzaMarca('MT-07 (2014 - 16)', 'Yamaha') !== 'MT-07 (2014 - 16)') throw new Error('senzaMarca non deve tagliare');
  const finta = '<a href="/listino/yamaha/mt-07/mt-07-2014-16/R9Lybg" title="MT-07 (2014 - 16)">x</a>'
    + '<a href="/listino/yamaha/mt-07/mt-07-2014-16/R9Lybg" title="MT-07 (2014 - 16)">x</a>';
  const v = versioniNella(finta, 'yamaha', 'mt-07');
  if (v.size !== 1 || !v.has('R9Lybg')) throw new Error('versioniNella: dedup o caso misto rotti');
  console.log('autotest: ok');
})();

(async () => {
  const cat = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  let bloccato = false;
  const falliti = [];

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
    cat.richiesteSpeseListino = spese;
    cat.bloccatoListino = bloccato;
    cat.fallitiListino = falliti;
    cat.notaListino = 'Le versioni marcate `fonte: "listino"` vengono dalla pagina /listino, che e\' '
      + 'l\'unica lista intera: l\'API /Used da\' solo le versioni con usato in vendita (misurato: '
      + '36% mancante su 20 modelli). Le versioni dell\'API non sono state toccate.';
    const tmp = OUT + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cat, null, 1) + '\n');
    fs.renameSync(tmp, OUT);
  };
  const rete = (che, e) => {
    console.error('[listino] ' + che + ': ' + ((e && e.stack) || e));
    try { salva(); console.error('[listino] salvato quello che c\'era prima di uscire'); }
    catch (e2) { console.error('[listino] nemmeno il salvataggio e\' riuscito: ' + e2.message); }
    process.exit(1);
  };
  process.on('uncaughtException', e => rete('eccezione non gestita', e));
  process.on('unhandledRejection', e => rete('promessa rifiutata e non gestita', e));

  const prima = conta();
  console.log('[listino] partenza: ' + prima.modelli + ' modelli · ' + prima.versioni + ' versioni · budget ' + BUDGET);

  let fatti = 0, aggiunte = 0, saltati = 0;
  for (const [marcaSlug, marca] of Object.entries(cat.marche)) {
    if (bloccato || spese >= BUDGET) break;
    if (SOLO.length && !SOLO.includes(marcaSlug)) continue;
    let addMarca = 0, koMarca = 0;

    for (const [modSlug, mod] of Object.entries(marca.modelli || {})) {
      if (bloccato) break;
      if (mod.completoListino) { saltati++; continue; }
      if (spese >= BUDGET) break;

      let trovate = null, motivo = null;
      for (const p of ['/listino/' + marcaSlug + '/' + modSlug,
                       '/listino/fuori-listino/' + marcaSlug + '/' + modSlug]) {
        let html;
        try { html = await scarica(p); }
        catch (e) {
          if (e instanceof Bloccati) { bloccato = true; motivo = e.message; break; }
          motivo = e.message; await sleep(PAUSA_MS); continue;
        }
        await sleep(PAUSA_MS);
        const v = versioniNella(html, marcaSlug, modSlug);
        // criterio: NON "status 200" ma "questa pagina parla di questo modello". La pagina in
        // produzione si reindirizza al listino di marca quando il modello e' fuori produzione.
        if (v.size) { trovate = v; motivo = null; break; }
      }
      if (bloccato) break;

      if (!trovate) {
        koMarca++;
        mod.motivoListino = motivo || 'nessuna versione nella pagina';
        falliti.push(marcaSlug + '/' + modSlug + ': ' + mod.motivoListino);
        continue;
      }

      // MERGE che non distrugge: l'API vince sul nome, l'HTML aggiunge solo id nuovi.
      mod.versioni = mod.versioni || {};
      for (const v of trovate.values()) {
        if (mod.versioni[v.id]) continue;
        const nome = senzaMarca(v.titolo, marca.nome) || v.slug;
        mod.versioni[v.id] = { nome, anni: anniDa(v.titolo) || anniDa(v.slug), fonte: 'listino' };
        addMarca++; aggiunte++;
      }
      mod.completoListino = true;
      delete mod.motivoListino;
      fatti++;
      if (fatti % SALVA_OGNI === 0) salva();
    }

    marca.completaListino = Object.values(marca.modelli || {}).every(m => m.completoListino);
    console.log('  ' + marcaSlug.padEnd(22)
      + 'modelli ' + String(Object.keys(marca.modelli || {}).length).padStart(3)
      + ' · versioni aggiunte ' + String(addMarca).padStart(4)
      + (koMarca ? ' · falliti ' + koMarca : '')
      + (marca.completaListino ? ' · completa' : ' · INCOMPLETA')
      + ' · richieste ' + spese);
    salva();
  }

  salva();
  const dopo = conta();
  console.log('\n[listino] richieste ' + spese + '/' + BUDGET + (bloccato ? '  BLOCCATO' : ''));
  console.log('  modelli chiusi ' + fatti + ' · gia\' fatti prima ' + saltati + ' · falliti ' + falliti.length);
  console.log('  versioni: ' + prima.versioni + ' → ' + dopo.versioni + '  (+' + aggiunte + ')');
  const restano = Object.values(cat.marche).reduce((a, m) => a + Object.values(m.modelli || {}).filter(x => !x.completoListino).length, 0);
  console.log('  modelli ancora da fare: ' + restano + (restano ? ' — rilancia per continuare' : ''));
  console.log('[listino] scritto data/motoit-catalogo.json');
})().catch(e => { console.error('ERRORE', e && e.stack); process.exit(1); });
