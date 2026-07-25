#!/usr/bin/env node
'use strict';
/**
 * Genera data/comune-sigla.json = da una localita' scritta in italiano alla SIGLA della
 * provincia (BS, MI, …), che e' l'unica chiave con cui backend/ipt.js sa calcolare.
 *
 * Serve perche' le tre fonti dell'usato scrivono la localita' in tre modi diversi:
 *   Moto.it   → sigla        ("BS")
 *   Subito    → provincia    ("Genova")
 *   AutoScout → COMUNE       ("Gussago")
 * Senza questa tabella il comune di AutoScout non e' traducibile in provincia e il calcolo
 * del passaggio sull'annuncio non si puo' fare.
 *
 * Tre mappe separate e non una sola: un comune puo' chiamarsi come una provincia diversa, e
 * fondere tutto darebbe una risposta sbagliata in silenzio. Chi consulta prova in ordine di
 * affidabilita' (sigla → provincia → CAP → comune) e sa sempre da dove viene la risposta.
 *
 * Sorgente: matteocontrini/comuni-json (dati ISTAT), la stessa gia' usata da
 * scripts/build-comune-regione.js. Rigenerabile:  node scripts/build-comune-sigla.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = 'https://raw.githubusercontent.com/matteocontrini/comuni-json/master/comuni.json';
const OUT = path.join(__dirname, '..', 'data', 'comune-sigla.json');
const PROVINCE = require('../data/province.json');

const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

(async () => {
  const comuni = JSON.parse(await get(SRC));
  const sigleValide = new Set(Object.keys(PROVINCE));

  const nomi = {};      // "brescia" → BS   (nome della provincia)
  const cap = {};       // "25064"   → BS
  const comune = {};    // "gussago" → BS
  const ambigui = [];      // stesso nome di comune su province diverse: si scarta, non si indovina
  const capVisti = {};     // CAP → Set di sigle: alcuni CAP sono a cavallo di due province
  const capAmbigui = [];

  // I nomi delle province vengono da province.json, non dal dataset: e' la nostra tabella
  // di riferimento, quella su cui e' chiavata anche l'IPT.
  for (const [sig, p] of Object.entries(PROVINCE)) nomi[norm(p.nome)] = sig;
  // Alias delle province che cambiano nome/grafia (il dataset ISTAT e le fonti usano forme diverse).
  const ALIAS = {
    'massa carrara': 'MS', 'massa e carrara': 'MS', 'monza e della brianza': 'MB',
    'monza brianza': 'MB', 'monza e brianza': 'MB', 'reggio emilia': 'RE',
    'reggio nell emilia': 'RE', 'reggio calabria': 'RC', 'reggio di calabria': 'RC',
    'forli cesena': 'FC', 'forli': 'FC', 'pesaro urbino': 'PU', 'pesaro e urbino': 'PU',
    'bolzano': 'BZ', 'bozen': 'BZ', 'aosta': 'AO', 'la spezia': 'SP', 'l aquila': 'AQ',
    'barletta andria trani': 'BT', 'verbano cusio ossola': 'VB', 'vibo valentia': 'VV',
    'ascoli piceno': 'AP', 'sud sardegna': 'SU', 'roma': 'RM',
  };
  for (const [k, v] of Object.entries(ALIAS)) if (sigleValide.has(v)) nomi[k] = v;

  let senzaSigla = 0;
  for (const c of comuni) {
    const sig = String(c.sigla || '').toUpperCase();
    if (!sigleValide.has(sig)) { senzaSigla++; continue; }
    if (c.provincia && c.provincia.nome) {
      const n = norm(c.provincia.nome);
      if (!nomi[n]) nomi[n] = sig;          // non sovrascrive mai province.json
    }
    // I CAP vanno filtrati come i comuni: ce ne sono a cavallo di due province, e tenere il
    // primo che arriva significa dichiarare una provincia falsa con la faccia di un dato certo.
    for (const z of (c.cap || [])) { if (!/^\d{5}$/.test(z)) continue; (capVisti[z] = capVisti[z] || new Set()).add(sig); }
    const n = norm(c.nome);
    if (!n) continue;
    if (comune[n] && comune[n] !== sig) { ambigui.push(n); delete comune[n]; continue; }
    if (!ambigui.includes(n)) comune[n] = sig;
  }

  for (const [z, set] of Object.entries(capVisti)) {
    if (set.size === 1) cap[z] = [...set][0]; else capAmbigui.push(z);
  }

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    fonte: SRC,
    nota: 'Da localita\' in chiaro alla sigla provincia. Ordine di consultazione: sigla, nomi, cap, comuni.',
    nomi, cap, comuni: comune,
    ambigui: [...new Set(ambigui)].sort(),
    capAmbigui: capAmbigui.sort(),
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('[comune-sigla] comuni sorgente:', comuni.length, '| scartati (sigla fuori tabella):', senzaSigla);
  console.log('[comune-sigla] nomi provincia:', Object.keys(nomi).length,
    '| CAP:', Object.keys(cap).length, '| comuni:', Object.keys(comune).length,
    '| comuni ambigui scartati:', out.ambigui.length, '| CAP ambigui scartati:', out.capAmbigui.length);
  console.log('[comune-sigla] scritto', OUT);
})().catch(e => { console.error('[comune-sigla] KO:', e.message); process.exit(1); });
