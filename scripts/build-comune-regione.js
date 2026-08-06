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

  const viste = new Map();   // chiave (nome-comune o CAP) → Set delle regioni in cui compare
  const seenReg = new Set();
  for (const c of comuni) {
    const regNome = (c.regione && c.regione.nome) || c.regione;
    const slug = ALIAS[norm(regNome)] || norm(regNome);
    seenReg.add(slug);
    // CAP→regione: fallback quando il comune AS24 è una frazione/stringa sporca.
    const caps = Array.isArray(c.cap) ? c.cap : (c.cap ? [c.cap] : []);
    for (const k of [norm(c.nome), ...caps.map(String)]) {
      if (!viste.has(k)) viste.set(k, new Set());
      viste.get(k).add(slug);
    }
  }

  /**
   * IL GUARDIANO DELLE AMBIGUITA' — lo stesso del gemello build-comune-sigla, che qui
   * mancava: una chiave che compare in DUE regioni non si indovina, si scarta. Prima
   * vinceva l'ultimo arrivato del dataset: il CAP 12071 (Garessio, provincia di Cuneo,
   * a cavallo col savonese) dichiarava ligure un pezzo del blocco 120xx interamente
   * piemontese, e sette nomi-comune omonimi cross-regione (calliano, castro, livo,
   * paterno, peglio, samone, san-teodoro) prendevano la regione sbagliata a sorte.
   */
  const map = {}; const ambigue = [];
  for (const [k, regs] of viste) {
    if (regs.size === 1) map[k] = [...regs].pop(); else ambigue.push(k);
  }
  if (ambigue.length) console.log('chiavi ambigue scartate (niente indovinelli):', ambigue.length, '→', ambigue.sort().join(', '));

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
