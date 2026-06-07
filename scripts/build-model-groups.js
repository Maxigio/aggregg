#!/usr/bin/env node
/**
 * Genera data/model-groups.json: mappa serie-commerciale → membri (nomi-modello
 * REALI presi dal catalogo). I membri si DERIVANO dal catalogo (sempre completi,
 * niente liste stantie); le REGOLE per-brand sono curate qui. Re-eseguibile.
 *
 * Serve a §12: ricerche per nome-serie (es. BMW "Serie 3", Mercedes "Classe C")
 * non hanno una entry singola nel catalogo (solo i trim: 316/318/320…). Il
 * server usa i membri per narroware il titolo su Autoscout (brand-only).
 *
 * Uso: node scripts/build-model-groups.js
 */
const fs = require('fs');
const path = require('path');

const MODELS = path.join(__dirname, '..', 'data', 'models.json');
const OUT    = path.join(__dirname, '..', 'data', 'model-groups.json');
const models = JSON.parse(fs.readFileSync(MODELS, 'utf8'));

// Regole per-brand: (nome-modello) → chiave-serie, oppure null (modello escluso).
// Aggiungere qui nuove regole quando emergono brand a naming-serie.
const RULES = {
  auto: {
    // BMW: "Serie N" = codici a 3 cifre che iniziano con N (1..8).
    // X1..X7 / Z4 / M-vari NON sono gruppi (l'utente li digita esatti → mmmv diretto).
    BMW: nome => {
      const m = /^([1-8])\d{2}$/.exec(String(nome).trim());
      return m ? `Serie ${m[1]}` : null;
    },
    // Mercedes-Benz: prefisso-lettera prima del numero.
    // 1 lettera → "Classe X" (A/B/C/E/S/V/G); multi-lettera → il prefisso stesso
    // (GLA/GLB/GLC/GLE/GLS/CLA/CLS/SLK/SLC…).
    'Mercedes-Benz': nome => {
      const m = /^([A-Za-z]{1,3})\s*\d/.exec(String(nome).trim());
      if (!m) return null;
      const p = m[1].toUpperCase();
      return p.length === 1 ? `Classe ${p}` : p;
    },
  },
  moto: {},
};

const out = {};
let total = 0;
for (const tipo of ['auto', 'moto']) {
  const brands = RULES[tipo] || {};
  out[tipo] = {};
  for (const [brand, rule] of Object.entries(brands)) {
    const entry = models[tipo]?.[brand];
    if (!entry) { console.warn(`[skip] brand assente nel catalogo: ${tipo}/${brand}`); continue; }
    const groups = {};
    for (const mdl of (entry.models || [])) {
      const key = rule(mdl.nome);
      if (!key) continue;
      (groups[key] = groups[key] || []).push(mdl.nome);
    }
    // dedup + ordina i membri
    for (const k of Object.keys(groups)) groups[k] = [...new Set(groups[k])].sort();
    if (Object.keys(groups).length) {
      out[tipo][brand] = groups;
      total += Object.keys(groups).length;
    }
  }
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`Scritto ${OUT}: ${total} gruppi-serie.`);
for (const tipo of ['auto', 'moto']) for (const [b, g] of Object.entries(out[tipo] || {}))
  console.log(`  ${tipo}/${b}: ${Object.keys(g).map(k => `${k}(${g[k].length})`).join(', ')}`);
