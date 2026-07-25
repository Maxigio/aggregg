#!/usr/bin/env node
'use strict';
/**
 * Genera data/ipt-province.json: maggiorazione IPT per provincia + tariffe base.
 *
 * Perché un generatore e non una tabella scritta a mano: le percentuali cambiano quando
 * una provincia delibera, e riscriverle a mano è come sono nati i nostri errori peggiori.
 * Si rilancia e si vede il diff.
 *
 * FONTI (lette il 2026-07-25, entrambe HTTP 200):
 *  - maggiorazioni per provincia:
 *    https://aci.gov.it/pratica-auto/calcolo-ipt-percentuali-di-maggiorazione/
 *  - tariffe base (tabella allegata al D.M. Finanze 27/11/1998 n. 435):
 *    https://aci.gov.it/pratica-auto/normativa-ipt-ministero-delle-finanze-decreto-27-novembre-1998-n-435/
 *
 * Uso: node scripts/build-ipt-province.js [--dry]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const cheerio = require('cheerio');

const OUT = path.join(__dirname, '..', 'data', 'ipt-province.json');
const PROVINCE = require(path.join(__dirname, '..', 'data', 'province.json'));
const URL_MAGG = 'https://aci.gov.it/pratica-auto/calcolo-ipt-percentuali-di-maggiorazione/';
const URL_DM = 'https://aci.gov.it/pratica-auto/normativa-ipt-ministero-delle-finanze-decreto-27-novembre-1998-n-435/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function get(url, hops = 0) {
  return new Promise((res, rej) => {
    if (hops > 5) return rej(new Error('troppi redirect'));
    if (!/^https:\/\/(www\.)?aci\.gov\.it\//i.test(url)) return rej(new Error('host non consentito'));
    https.get(url, { headers: { 'user-agent': UA, 'accept-language': 'it-IT', 'accept-encoding': 'gzip' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return get(new URL(r.headers.location, url).href, hops + 1).then(res, rej); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error(`http ${r.statusCode}`)); }
      const c = []; let s = r;
      if ((r.headers['content-encoding'] || '').toLowerCase() === 'gzip') s = r.pipe(zlib.createGunzip());
      s.on('data', x => c.push(x)); s.on('end', () => res(Buffer.concat(c).toString('utf8'))); s.on('error', rej);
    }).on('error', rej);
  });
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[’']/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

// nome provincia (come lo scrive ACI) → sigla, usando il nostro data/province.json
const perNome = new Map();
for (const [sigla, v] of Object.entries(PROVINCE)) perNome.set(norm(v.nome), sigla);
// varianti di scrittura osservate sulle pagine ACI
const ALIAS = {
  'massa carrara': 'MS', 'monza e brianza': 'MB', 'pesaro urbino': 'PU', 'verbano cusio ossola': 'VB',
  'sud sardegna': 'SU', 'reggio calabria': 'RC', 'reggio emilia': 'RE', 'l aquila': 'AQ',
  'forli cesena': 'FC', 'barletta andria trani': 'BT', 'bolzano': 'BZ', 'trento': 'TN', 'aosta': 'AO',
};
// "Regione Friuli Venezia Giulia" nell'elenco ACI = tutte le sue province
const REGIONI = { 'regione friuli venezia giulia': ['GO', 'PN', 'TS', 'UD'] };

function siglaDa(nome) {
  const n = norm(nome);
  if (REGIONI[n]) return REGIONI[n];
  return perNome.get(n) || ALIAS[n] || null;
}

(async () => {
  const dry = process.argv.includes('--dry');
  const [htmlM, htmlD] = await Promise.all([get(URL_MAGG), get(URL_DM)]);

  // ── maggiorazioni: tabella "Aumento | Provincia" ──
  const $m = cheerio.load(htmlM);
  const maggiorazioni = {}; const nonRisolti = [];
  $m('table tr').each((_, tr) => {
    const c = $m(tr).find('th,td').map((_, x) => $m(x).text().replace(/\s+/g, ' ').trim()).get();
    if (c.length < 2) return;
    const pct = /nessun/i.test(c[0]) ? 0 : (c[0].match(/(\d{1,2})\s*%/) ? Number(RegExp.$1) : null);
    if (pct == null) return;                                   // riga di intestazione
    for (const pezzo of c[1].split(',')) {
      const nome = pezzo.replace(/\(\d+\)/g, '').trim();       // via i richiami alle note
      if (!nome) continue;
      const s = siglaDa(nome);
      if (!s) { nonRisolti.push(nome); continue; }
      for (const sig of [].concat(s)) maggiorazioni[sig] = pct;
    }
  });

  // ── tariffe base dalla tabella del D.M. 435/1998 ──
  const $d = cheerio.load(htmlD);
  const testoDM = $d('table').text().replace(/\s+/g, ' ');
  const num = re => { const m = testoDM.match(re); return m ? Number(m[1].replace(',', '.')) : null; };
  // NB: quantificatori NON greedy. Con `[^€]*` greedy la riga "oltre 53 kw" pescava
  // l'importo degli AUTOBUS (1,7559) invece del suo (3,5119): errore da centinaia di euro.
  const tariffe = {
    autoFino53Kw: num(/autovetture fino a 53 kw[^€]*?Euro\s*([\d.,]+)/i),
    autoOltre53PerKw: num(/autovetture oltre 53 kw[^€]*?Euro\s*([\d.,]+)\s*per ogni kw/i),
    autobusFino110Kw: num(/autobus e trattori stradali fino a 110 kw[^€]*?Euro\s*([\d.,]+)/i),
    autobusOltre110PerKw: num(/autobus e trattori stradali oltre 110 kw[^€]*?Euro\s*([\d.,]+)\s*per ogni kw/i),
  };

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    fonti: { maggiorazioni: URL_MAGG, tariffe: URL_DM },
    licenza: 'contenuto istituzionale ACI, nessuna licenza aperta dichiarata → citare la fonte, non ripubblicare i testi',
    tariffe,
    emolumentiAci: 27.00,           // pagina "Passaggio di proprietà" ACI, importo fisso dichiarato
    // Imposta di bollo: ACI la dichiara "importo variabile" perché si applica PER DOCUMENTO
    // (atto + modulistica) e il numero di documenti cambia con la pratica. Non esiste un
    // importo unico da mettere in un totale: si dichiara e, se l'operatore lo conosce, lo
    // inserisce lui. Fonte: pagina ACI "Passaggio di proprietà".
    nonIncluso: ['imposta di bollo su atto e modulistica (ACI: "importo variabile", si paga per documento)'],
    bollo: { variabile: true, perche: 'si applica per documento (atto + modulistica): il numero di documenti dipende dalla pratica', fonte: 'https://aci.gov.it/pratica-auto/passaggio-di-proprieta/' },
    // Veicoli storici ULTRATRENTENNALI — verificato testualmente su
    // https://aci.gov.it/pratica-auto/ipt-veicoli-storici/ (art. 63 c.4 L. 342/2000):
    // "Per gli autoveicoli l'IPT è ridotta a euro 51,65. Per i motoveicoli l'IPT è ridotta a euro 25,82."
    storici: {
      autoveicoli: 51.65, motoveicoli: 25.82, norma: 'art. 63 comma 4 L. 342/2000',
      anni: 30,
      // ATTENZIONE per un operatore: la riduzione NON spetta ai veicoli usati nell'attività.
      condizione: 'Solo veicoli costruiti da oltre 30 anni e NON adibiti a uso professionale né utilizzati nell\'esercizio di impresa, arti o professioni. Va chiesta espressamente sulla nota di presentazione al PRA.',
      dal2015: 'Dal 1° gennaio 2015 gli ultraVENTennali (20-29 anni) non godono più dell\'agevolazione, tranne nella Provincia autonoma di Bolzano.',
      fonte: 'https://aci.gov.it/pratica-auto/ipt-veicoli-storici/',
    },
    // Motocicli: la tesi "esenti IPT per art. 17 c.39 L. 449/97" e' SBAGLIATA. Quel comma
    // esenta dall'imposta ERARIALE di trascrizione, un tributo diverso dall'IPT (provinciale);
    // lo si legge nel preambolo del D.M. 435/1998 sulla pagina ACI. E la pagina sui veicoli
    // storici parla di IPT "ridotta a 25,82" per i motoveicoli: se fossero esenti non ci
    // sarebbe nulla da ridurre. Resta il fatto che la tabella del D.M. NON ha una riga per i
    // motocicli (ha "motocarrozzette", che sono i sidecar) → il loro importo base non e'
    // ricavabile da questa fonte e non lo si inventa.
    motocicli: {
      esenti: false,
      chiarimento: 'L\'esenzione dell\'art. 17 c.39 L. 449/1997 riguarda l\'imposta ERARIALE di trascrizione, non l\'IPT provinciale.',
      tariffaBase: null,
      perche: 'La tabella del D.M. 435/1998 non ha una riga per i motocicli (elenca le motocarrozzette, cioè i sidecar): l\'importo base non e\' ricavabile da questa fonte.',
      storico: 25.82,
    },
    maggiorazioni,
    // Eccezioni che contano per un OPERATORE (verificate sulla pagina ACI):
    eccezioni: {
      TO: { ivaEsposta: 20, senzaIva: 30, nota: 'Torino: 20% sugli atti soggetti a IVA (vendita con fattura), 30% sugli altri' },
      BA: { nota: 'Bari: IPT agevolata al 75% per locazione senza conducente, TPL, taxi/NCC, trasporto cose c/terzi e c/proprio, trasporto specifico e trattori' },
      RM: { nota: 'Roma: nessuna maggiorazione per locazione senza conducente, TPL, taxi/NCC, trasporto cose, trattori, e leasing con locatario a Roma' },
      FI: { nota: 'Firenze: nessuna maggiorazione per gli stessi usi professionali' },
      AG: { nota: 'Agrigento: tariffa D.M. senza maggiorazione su prime iscrizioni per usi professionali' },
    },
    regole: {
      consecutivi: 'Passaggi consecutivi sullo stesso veicolo nella stessa giornata: IPT dovuta solo sull\'ultima formalità. L\'esenzione DECADE per le richieste presentate dopo il 60° giorno dalla sottoscrizione.',
      speciali: 'Veicoli speciali (specialità sulla carta di circolazione): IPT ridotta a un quarto (art. 56 c.8 D.Lgs. 446/97).',
      storici: 'Veicoli storici oltre 30 anni: IPT ridotta a importo fisso (art. 63 c.4 L. 342/2000). Importi e condizioni in `storici`, verificati sulla pagina ACI dedicata.',
      ritardo: 'Oltre il termine: sanzione ordinaria 30% dell\'IPT dovuta + interessi legali.',
    },
    daVerificare: [
      'motocicli non storici: tariffa base assente dalla tabella del D.M. 435/1998 → unico importo ancora non calcolabile',
    ],
  };

  const mancanti = Object.keys(PROVINCE).filter(s => !(s in maggiorazioni));
  console.log(`[ipt] province con maggiorazione: ${Object.keys(maggiorazioni).length}/107`);
  // Le maggiorazioni si difendono come le tariffe base: con un throw, non con un warn. Un warn
  // lascia proseguire fino alla writeFileSync, e una tabella vuota sovrascrive quella buona con
  // exit 0 — da quel momento ogni /api/passaggio risponde "provincia sconosciuta" e il costo
  // della pratica sparisce da tutti i margini, senza che niente lo dica.
  if (mancanti.length) throw new Error(`${mancanti.length}/107 province senza percentuale (${mancanti.join(', ')}): la pagina ACI e' cambiata, tabella NON riscritta`);
  if (nonRisolti.length) console.warn(`[ipt] nomi non risolti a sigla: ${[...new Set(nonRisolti)].join(' | ')}`);
  console.log('[ipt] tariffe:', JSON.stringify(tariffe));
  const perPct = {};
  for (const p of Object.values(maggiorazioni)) perPct[p] = (perPct[p] || 0) + 1;
  console.log('[ipt] distribuzione:', JSON.stringify(perPct));
  if (Object.values(tariffe).some(v => v == null)) throw new Error('tariffe base non lette: la pagina D.M. è cambiata');
  if (dry) { console.log('[ipt] --dry: niente scritto'); return; }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`[ipt] scritto ${OUT}`);
})().catch(e => { console.error('[ipt] FATAL', e.message); process.exit(1); });
