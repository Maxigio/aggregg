#!/usr/bin/env node
'use strict';
/**
 * ENUMERA il catalogo di Moto.it — marche, modelli, versioni — in data/motoit-catalogo.json.
 *
 * Le API sono quelle che il sito stesso usa per riempire i menu Marca → Modello → Versione,
 * gia' documentate in backend/scrapers/motoit-models.js:
 *
 *   GET /api-50/market/search/models/<brandSlug>/Used
 *       → { result:"OK", message:null, data:[ { value:"<brand>|<modelSlug>", text:"Nome" } ] }
 *   GET /api-50/market/search/bikes/<brand>|<model>/Used
 *       → data:[ { value:"<codice 6 caratteri>", text:"Nome versione (anni)" } ]
 *
 * Le marche NON si inventano: si leggono da data/motoit-brands.json, che le prende dal <select>
 * del motore di ricerca (vedi scripts/harvest-motoit-brands.js). Slug indovinati mai.
 *
 * TRE COSE VERIFICATE SUL CAMPO, contro quello che il repo documentava:
 *  1. il suffisso " - sigla" dopo gli anni NON e' garantito: su Ducati e Vespa, 0 casi su 14.
 *     Chi fa parsing non deve assumerlo presente.
 *  2. il testo della versione RIPETE il nome del modello ("Monster 1000 Dark", non "Dark").
 *     Qui si conserva il testo intero: tagliarlo sarebbe una perdita, non una pulizia.
 *  3. gli anni sono sempre fra parentesi ("(2003 - 05)", "(2026)") e si estraggono a parte,
 *     perche' la generazione e' un ATTRIBUTO e non un livello — su Moto.it lo stesso modello ha
 *     piu' versioni con lo stesso nome e anni diversi.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROTEZIONI, le stesse dell'enumeratore Subito e per gli stessi motivi:
 *
 *  BUDGET      tetto di richieste per esecuzione. Il catalogo intero e' ~3.800 chiamate: si fa
 *              in piu' riprese invece che in un colpo solo su un sito piccolo.
 *  RIPRESA     una marca chiusa si segna `completa` e non si ripete.
 *  ACCUMULO    non si rifa' mai da zero: si unisce a quello che c'e'.
 *  MANIFESTO   `modelliAttesi` contro `modelliFatti`: una marca a meta' RISULTA a meta'.
 *  STOP SECCO  al primo 403/429 ci si ferma e si salva. Nessuna riprova.
 *  NIENTE INDOVINELLI  `result` diverso da "OK", o `data` che non e' un elenco, e' un errore
 *              dichiarato — non un formato alternativo da interpretare.
 *
 * Uso:
 *   node scripts/enumera-motoit.js                     riprende (tetto 800 richieste)
 *   node scripts/enumera-motoit.js --budget 3000
 *   node scripts/enumera-motoit.js --marche ducati,bmw
 *   node scripts/enumera-motoit.js --senza-versioni    solo marche e modelli: 94 richieste
 *   node scripts/enumera-motoit.js --dry
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const RADICE = path.join(__dirname, '..');
const OUT = path.join(RADICE, 'data', 'motoit-catalogo.json');
const MARCHE_FILE = path.join(RADICE, 'data', 'motoit-brands.json');

const HOST = 'www.moto.it';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAUSA_MS = 1500;
const TIMEOUT_MS = 25000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
class Bloccati extends Error {}

let spese = 0;
function chiedi(percorso) {
  spese++;
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: HOST, path: percorso,
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'it-IT,it;q=0.9' },
    }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429) return reject(new Bloccati('HTTP ' + res.statusCode));
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        let j;
        try { j = JSON.parse(s); } catch (_) { return reject(new Error('risposta non JSON')); }
        // `JSON.parse("null")` torna null, che e' JSON VALIDO ma non un oggetto: leggerci dentro
        // solleva un TypeError qui, cioe' dentro il gestore della risposta e FUORI dal try/catch
        // del corpo — il processo muore e si perde tutto. E' successo davvero: 44 marche e 1.392
        // richieste buttate. Il controllo del tipo viene prima di ogni campo.
        if (!j || typeof j !== 'object') return reject(new Error('risposta JSON ma non un oggetto: ' + JSON.stringify(j)));
        if (j.result !== 'OK') return reject(new Error('result=' + j.result + (j.message ? ' (' + j.message + ')' : '')));
        if (!Array.isArray(j.data)) return reject(new Error('manca il campo `data`'));
        resolve(j.data);
      });
    });
    req.on('error', e => reject(new Error(e.message)));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

/**
 * Gli anni fra parentesi: "(2003 - 05)" → {da:2003, a:2005}, "(2026)" → {da:2026, a:2026}.
 * L'anno a due cifre si completa sul secolo del primo, non su una soglia inventata: in
 * "2003 - 05" il 05 e' 2005 perche' viene dopo il 2003, non perche' 05 < 50.
 */
function anniDa(testo) {
  const m = String(testo || '').match(/\((\d{4})(?:\s*[-–]\s*(\d{2,4}))?\s*\)/);
  if (!m) return null;
  const da = Number(m[1]);
  if (!m[2]) return { da, a: da };
  const g = Number(m[2]);
  const a = g > 999 ? g : Math.floor(da / 100) * 100 + g;
  return { da, a: a >= da ? a : a + 100 };
}

// ─── Argomenti ───────────────────────────────────────────────────────────────
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const BUDGET = Math.max(1, Number(arg('budget', 800)) || 800);
const SOLO = (arg('marche', '') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SENZA_VERSIONI = process.argv.includes('--senza-versioni');
const RIFAI = process.argv.includes('--rifai');
const DRY = process.argv.includes('--dry');

// ─── Corpo ───────────────────────────────────────────────────────────────────
/**
 * Le marche, prese dal SITO e non solo dal file.
 *
 * data/motoit-brands.json lo legge anche l'applicazione in produzione (crawler, server,
 * scheda-veicolo): qui NON si tocca. Si legge, e ci si aggiunge quello che il sito pubblica oggi
 * — verificato: 93 slug nei link contro i 94 del file, con 2 marche vere che al file mancano
 * (hyosung, um-italia). Se la pagina non risponde si va avanti col solo file: una marca in meno
 * e' meglio di un raccolto che non parte.
 *
 * `-altre-moto-o-tipologie` NON e' una marca: e' la voce "tutto il resto" del loro menu, e va
 * esclusa o si enumererebbe una categoria fantasma.
 */
async function marcheDaSito() {
  const html = await new Promise(resolve => {
    const req = https.get({ host: HOST, path: '/moto-usate/ricerca', headers: { 'User-Agent': UA } }, res => {
      let s = ''; res.on('data', c => { s += c; });
      res.on('end', () => resolve(res.statusCode === 200 ? s : ''));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve(''); });
  });
  // Le pagine regionali (/moto-usate/annunci-lombardia/) NON sono marche. Si riconoscono per
  // schema e non a elenco: elencarle a mano era il mio errore, e ne avevo escluse cinque su
  // venticinque. Sono finite anche in data/motoit-brands.json, che le ha da prima di oggi.
  const NON_MARCHE = new Set(['ricerca', 'vendi', 'prezzi', 'usato', '-altre-moto-o-tipologie']);
  const regione = x => x.startsWith('annunci-');
  return [...new Set([...String(html).matchAll(/\/moto-usate\/([a-z0-9-]+)(?:\/|["'])/g)].map(m => m[1]))]
    .filter(x => !NON_MARCHE.has(x) && !regione(x));
}

(async () => {
  const grezze = JSON.parse(fs.readFileSync(MARCHE_FILE, 'utf8'));
  const daFile = (Array.isArray(grezze) ? grezze : Object.values(grezze))
    .map(x => (typeof x === 'string' ? { slug: x, name: x } : x))
    .filter(x => x && x.slug && x.slug !== '-altre-moto-o-tipologie' && !x.slug.startsWith('annunci-'));
  const daWeb = await marcheDaSito();
  const visti = new Set(daFile.map(x => x.slug));
  const marche = [...daFile, ...daWeb.filter(s => !visti.has(s)).map(s => ({ slug: s, name: s }))];
  console.log('[motoit] marche: ' + daFile.length + ' dal file + ' + (marche.length - daFile.length) + ' nuove dal sito');
  if (!marche.length) throw new Error('nessuna marca: ne dal file ne dal sito');

  const prima = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { return null; } })();
  const cat = (prima && prima.marche) || {};
  const eranoMarche = Object.keys(cat).length;

  let bloccato = false;
  const falliti = [];

  /**
   * SALVA DOPO OGNI MARCA, non solo alla fine.
   *
   * Il salvataggio in fondo sembra sufficiente finche' il programma finisce sempre. Ma un
   * TypeError dentro un gestore di risposta non passa dal try/catch del corpo: uccide il
   * processo, e il salvataggio finale non arriva mai. E' successo: 44 marche e 1.392 richieste
   * buttate perche' la fonte ha risposto `null` una volta sola.
   *
   * Scrivendo dopo ogni marca, il peggio che si perde e' la marca in corso. Costa una scrittura
   * di poche decine di kilobyte ogni minuto o due: niente, contro il rischio.
   *
   * La scrittura e' ATOMICA — file temporaneo e rename — perche' un crash a meta' scrittura
   * lascerebbe un JSON troncato, che e' peggio di un file vecchio: il vecchio si legge.
   */
  const salva = () => {
    if (DRY) return;
    const v = Object.values(cat);
    const conta = {
      marche: v.length,
      complete: v.filter(x => x.completa).length,
      modelli: v.reduce((a, x) => a + Object.keys(x.modelli || {}).length, 0),
      versioni: v.reduce((a, x) => a + Object.values(x.modelli || {}).reduce((b, y) => b + Object.keys(y.versioni || {}).length, 0), 0),
    };
    const fuori = {
      generatedAt: new Date().toISOString(),
      fonte: 'moto.it — API api-50, le stesse che riempiono i menu Marca/Modello/Versione del sito',
      nota: 'Catalogo enumerato. `completa` su una marca vuol dire che tutti i suoi modelli hanno '
        + 'avuto la chiamata versioni. Gli `anni` sono un attributo della versione, non un livello: '
        + 'lo stesso modello puo\' avere piu\' versioni con lo stesso nome e anni diversi.',
      conta, richiesteSpese: spese, bloccato, falliti,
      marche: cat,
    };
    const tmp = OUT + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(fuori, null, 1) + '\n');
    fs.renameSync(tmp, OUT);
    return conta;
  };


  /**
   * RETE DI ULTIMA ISTANZA. Le protezioni sopra coprono gli errori che ho PREVISTO: blocchi,
   * budget, risposte malformate. Ma un TypeError in un punto a cui non ho pensato uccide il
   * processo prima di qualunque salvataggio — e' successo, 44 marche buttate.
   * Qui si salva e poi si muore, invece di morire e basta. Non ripara il difetto: impedisce che
   * il difetto costi il lavoro gia' fatto.
   */
  const rete = (che, e) => {
    console.error('[motoit] ' + che + ': ' + (e && e.stack || e));
    try { salva(); console.error('[motoit] salvato quello che c\'era prima di uscire'); }
    catch (e2) { console.error('[motoit] nemmeno il salvataggio e\' riuscito: ' + e2.message); }
    process.exit(1);
  };
  process.on('uncaughtException', e => rete('eccezione non gestita', e));
  process.on('unhandledRejection', e => rete('promessa rifiutata e non gestita', e));

  console.log('[motoit] ' + marche.length + ' marche da data/motoit-brands.json · budget ' + BUDGET
    + (SENZA_VERSIONI ? ' · solo marche e modelli' : ''));

  for (const marca of marche) {
    if (bloccato) break;
    if (SOLO.length && !SOLO.includes(marca.slug.toLowerCase())) continue;
    const gia = cat[marca.slug];
    if (gia && (SENZA_VERSIONI ? gia.completaModelli : gia.completa) && !RIFAI) continue;
    // Il budget si guarda PRIMA di aprire una marca: cosi' sul disco c'e' sempre o una marca
    // intera o una marca marcata incompleta, mai un troncone che si crede completo.
    if (spese >= BUDGET) { console.log('[motoit] budget esaurito: mi fermo, il resto al prossimo giro'); break; }

    const nodo = cat[marca.slug] = {
      nome: marca.name || marca.slug, slug: marca.slug,
      modelli: (gia && gia.modelli) || {},
      completa: false,
    };

    try {
      const modelli = await chiedi('/api-50/market/search/models/' + encodeURIComponent(marca.slug) + '/Used');
      await sleep(PAUSA_MS);
      nodo.modelliAttesi = modelli.length;

      let fatti = 0;
      for (const m of modelli) {
        // `value` e' "<brand>|<modelSlug>": e' anche il parametro `model=` della ricerca, quindi
        // si conserva intero invece di spezzarlo e ricomporlo a mano.
        const chiave = String(m.value || '');
        const slugModello = chiave.split('|')[1] || chiave;
        const vecchio = nodo.modelli[slugModello];
        if (SENZA_VERSIONI) {
          nodo.modelli[slugModello] = { nome: m.text, chiave, versioni: (vecchio && vecchio.versioni) || {}, completoVersioni: false };
          fatti++; continue;
        }
        if (vecchio && vecchio.completoVersioni && !RIFAI) { fatti++; continue; }
        if (spese >= BUDGET) break;                       // la marca restera' incompleta, e lo dira'
        let vers;
        try { vers = await chiedi('/api-50/market/search/bikes/' + encodeURIComponent(chiave) + '/Used'); }
        catch (e) {
          if (e instanceof Bloccati) throw e;
          nodo.modelli[slugModello] = { nome: m.text, chiave, versioni: (vecchio && vecchio.versioni) || {}, completoVersioni: false, motivo: e.message };
          await sleep(PAUSA_MS); continue;
        }
        const mappa = { ...((vecchio && vecchio.versioni) || {}) };
        for (const v of vers) {
          if (!v || !v.value) continue;
          mappa[String(v.value)] = { nome: String(v.text || ''), anni: anniDa(v.text) };
        }
        nodo.modelli[slugModello] = { nome: m.text, chiave, versioni: mappa, completoVersioni: true };
        fatti++;
        // Si salva anche DENTRO la marca, non solo alla fine. Una marca grossa (aprilia: 78
        // modelli) sono due minuti: salvando solo a marca chiusa, morire a meta' li butta tutti.
        // Salvare qui e' sicuro perche' `completa` resta false finche' la marca non e' finita
        // davvero — il file dice sempre la verita' su cosa manca.
        if (fatti % 15 === 0) salva();
        await sleep(PAUSA_MS);
      }
      nodo.modelliFatti = Object.keys(nodo.modelli).length;
      // Due livelli distinti: i modelli possono essere completi anche se le versioni no.
      nodo.completaModelli = true;
      nodo.completa = !SENZA_VERSIONI && fatti === modelli.length
        && Object.values(nodo.modelli).every(x => x.completoVersioni);
      console.log('  ' + marca.slug.padEnd(22)
        + 'modelli ' + String(modelli.length).padStart(3)
        + ' · versioni ' + String(Object.values(nodo.modelli).reduce((a, x) => a + Object.keys(x.versioni || {}).length, 0)).padStart(4)
        + (nodo.completa ? ' · completa' : nodo.completaModelli ? ' · modelli ok' : ' · INCOMPLETA')
        + ' · spese ' + spese);
    } catch (e) {
      if (e instanceof Bloccati) { bloccato = true; console.warn('[motoit] ' + marca.slug + ': ' + e.message + ' → mi fermo e salvo'); salva(); break; }
      falliti.push(marca.slug + ': ' + e.message);
    }
    salva();                                  // dopo OGNI marca, riuscita o fallita
  }

  // ─── Guardie ───────────────────────────────────────────────────────────────
  const ora = Object.keys(cat).length;
  if (ora < eranoMarche) throw new Error(`il catalogo si e' RIMPICCIOLITO: ${ora} marche contro ${eranoMarche}. Non scrivo.`);

  const v = Object.values(cat);
  const conta = salva() || {
    marche: v.length, complete: v.filter(x => x.completa).length,
    modelli: v.reduce((a, x) => a + Object.keys(x.modelli || {}).length, 0),
    versioni: v.reduce((a, x) => a + Object.values(x.modelli || {}).reduce((b, y) => b + Object.keys(y.versioni || {}).length, 0), 0),
  };

  console.log('\n[motoit] richieste ' + spese + '/' + BUDGET + (bloccato ? ' · FERMATO da un blocco' : ''));
  console.log('  ' + conta.marche + ' marche (' + conta.complete + ' complete) · ' + conta.modelli + ' modelli · ' + conta.versioni + ' versioni');
  if (falliti.length) console.log('  falliti: ' + falliti.length + ' → ' + falliti.slice(0, 3).join(' | '));
  const restano = v.filter(x => !x.completa).length;
  if (restano) console.log('  marche da completare: ' + restano + ' — rilancia per continuare');

  console.log(DRY ? '[motoit] --dry: niente scritto' : '[motoit] scritto ' + path.relative(RADICE, OUT));
})().catch(e => { console.error('[motoit] ' + e.message); process.exit(1); });
