#!/usr/bin/env node
'use strict';
/**
 * Genera data/comune-regione.json = { <comune normalizzato>: <regione-slug> }
 * per il post-filtro regione su AS24 (l'API GraphQL ritorna il comune, non la
 * regione). Slug-regione allineato a province.json (es. "emilia-romagna").
 *
 * Sorgente: matteocontrini/comuni-json (dati ISTAT). Rigenerabile:
 *   node scripts/build-comune-regione.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = 'https://raw.githubusercontent.com/matteocontrini/comuni-json/master/comuni.json';
const OUT = path.join(__dirname, '..', 'data', 'comune-regione.json');

function norm(s) {
  return String(s == null ? '' : s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

(async () => {
  const comuni = JSON.parse(await get(SRC));
  const validRegioni = new Set(Object.values(require('../data/province.json')).map(p => p.regione));

  // Nomi bilingui del dataset → slug province.json.
  const ALIAS = {
    'trentino-alto-adige-sudtirol': 'trentino-alto-adige',
    'valle-d-aosta-vallee-d-aoste': 'valle-d-aosta',
  };

  const map = {};
  const seenReg = new Set();
  for (const c of comuni) {
    const regNome = (c.regione && c.regione.nome) || c.regione;
    const slug = ALIAS[norm(regNome)] || norm(regNome);
    seenReg.add(slug);
    map[norm(c.nome)] = slug;
    // CAP→regione: fallback quando il comune AS24 è una frazione/stringa sporca.
    const caps = Array.isArray(c.cap) ? c.cap : (c.cap ? [c.cap] : []);
    for (const cap of caps) map[String(cap)] = slug;
  }

  // Validazione: ogni regione del dataset deve esistere in province.json
  const mismatch = [...seenReg].filter(r => !validRegioni.has(r));
  if (mismatch.length) {
    console.warn('⚠️  regioni NON allineate a province.json:', mismatch);
    console.warn('    (allineare la normalizzazione prima di affidarsi al filtro)');
  }
  console.log('comuni mappati:', Object.keys(map).length, '| regioni:', seenReg.size);
  fs.writeFileSync(OUT, JSON.stringify(map));
  console.log('scritto', OUT);
})().catch(e => { console.error('errore:', e.message); process.exit(1); });
