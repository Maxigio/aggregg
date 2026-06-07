#!/usr/bin/env node
/**
 * Audit qualità dati del catalogo (data/models.json) — scopre problemi del tipo
 * "Beta/Betamotor" in modo sistematico, senza aspettare che emergano da una
 * ricerca fallita.
 *
 * Rileva (OFFLINE di default, veloce e affidabile):
 *  1) ALIAS/DUPLICATI: coppie per contenimento normalizzato. Classificate via
 *     makeId AS24: stesso makeId ⇒ quasi certo alias; makeId diverso ⇒ probabili
 *     brand distinti (Ariel Motor vs Ariel Motorcycles). Esclude quelle già in
 *     data/brand-aliases.json.
 *  2) GAP COPERTURA: per tipo, brand senza makeId AS24 / senza slug Moto.it.
 *  3) (opz. --live) UNDERSAMPLING: confronta i nostri conteggi col conteggio
 *     reale dichiarato dal sito su ricerche-campione. [placeholder, vedi nota]
 *
 * Uso:  node scripts/audit-catalog.js  [--json]
 */
const models  = require('../data/models.json');
const aliases = require('../data/brand-aliases.json');
let motoitBrands = [];
try { motoitBrands = require('../data/motoit-brands.json'); } catch (_) {}

const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const asJson = process.argv.includes('--json');

// nomi già canonicalizzati (per non riproporre alias risolti)
const knownAlias = new Set();
for (const tipo of ['auto', 'moto']) for (const g of (aliases[tipo] || [])) for (const n of g) knownAlias.add(tipo + ':' + norm(n));

const report = { aliasCandidates: { auto: [], moto: [] }, coverage: {}, motoitBrandsUnused: [] };

for (const tipo of ['auto', 'moto']) {
  const keys = Object.keys(models[tipo] || {});
  const N = keys.map(k => ({ k, n: norm(k), e: models[tipo][k] }));

  // 1) coppie per contenimento (a ⊂ b), classificate via makeId
  for (let i = 0; i < N.length; i++) for (let j = 0; j < N.length; j++) {
    if (i === j) continue;
    const a = N[i], b = N[j];
    if (a.n.length < 3 || b.n.length <= a.n.length || !b.n.includes(a.n)) continue;
    if (knownAlias.has(tipo + ':' + a.n) && knownAlias.has(tipo + ':' + b.n)) continue; // già gestita
    const idA = a.e.autoscout?.makeId, idB = b.e.autoscout?.makeId;
    const verdict = (idA && idB && idA === idB) ? 'ALIAS (stesso makeId)'
                  : (idA && idB && idA !== idB) ? 'distinti? (makeId diversi)'
                  : 'rivedere (makeId mancante)';
    report.aliasCandidates[tipo].push({ short: a.k, long: b.k, makeIdA: idA || null, makeIdB: idB || null, verdict });
  }

  // 2) gap copertura
  const noAS  = keys.filter(k => !models[tipo][k].autoscout?.makeId);
  const noMI  = tipo === 'moto' ? keys.filter(k => !models[tipo][k].motoit?.brandSlug) : [];
  report.coverage[tipo] = { totale: keys.length, senzaMakeIdAS24: noAS.length, senzaSlugMotoit: noMI.length, esempiNoAS: noAS.slice(0, 12), esempiNoMI: noMI.slice(0, 12) };
}

// 3) marche reali Moto.it mai agganciate a un'entry catalogo (gap inverso)
if (motoitBrands.length) {
  const catMotoNorm = new Set(Object.keys(models.moto || {}).map(norm));
  report.motoitBrandsUnused = motoitBrands
    .filter(b => !catMotoNorm.has(norm(b.name)) && !catMotoNorm.has(norm(b.slug)))
    .map(b => b.name).slice(0, 40);
}

// 4) gruppi-serie (§12): brand con regola in build-model-groups ma assenti dal
//    catalogo, e serie con un solo membro (sospette: regola troppo larga/stretta).
let modelGroups = {};
try { modelGroups = require('../data/model-groups.json'); } catch (_) {}
report.modelGroups = { singletons: [], brands: {} };
for (const tipo of ['auto', 'moto']) {
  for (const [brand, groups] of Object.entries(modelGroups[tipo] || {})) {
    report.modelGroups.brands[`${tipo}/${brand}`] = Object.fromEntries(
      Object.entries(groups).map(([k, v]) => [k, v.length]));
    for (const [serie, membri] of Object.entries(groups))
      if (membri.length < 2) report.modelGroups.singletons.push(`${tipo}/${brand}/${serie} (${membri.length})`);
  }
}

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

// ─── Report leggibile ────────────────────────────────────────────────────────
const line = '─'.repeat(70);
console.log(`\n${line}\nAUDIT CATALOGO — data/models.json\n${line}`);
for (const tipo of ['moto', 'auto']) {
  const cand = report.aliasCandidates[tipo];
  const likely = cand.filter(c => c.verdict.startsWith('ALIAS'));
  console.log(`\n## ${tipo.toUpperCase()} — alias candidati non ancora gestiti: ${cand.length} (probabili alias: ${likely.length})`);
  cand.slice(0, 30).forEach(c => console.log(`  ${c.short}  ⊂  ${c.long}   [${c.makeIdA}/${c.makeIdB}]  → ${c.verdict}`));
  const cov = report.coverage[tipo];
  console.log(`\n## ${tipo.toUpperCase()} — copertura: ${cov.totale} marche · senza makeId AS24: ${cov.senzaMakeIdAS24}` + (tipo === 'moto' ? ` · senza slug Moto.it: ${cov.senzaSlugMotoit}` : ''));
  if (cov.esempiNoAS.length) console.log(`   no-AS24: ${cov.esempiNoAS.join(', ')}`);
  if (cov.esempiNoMI?.length) console.log(`   no-Moto.it: ${cov.esempiNoMI.join(', ')}`);
}
if (report.motoitBrandsUnused.length) {
  console.log(`\n## Marche reali su Moto.it MAI nel catalogo (${report.motoitBrandsUnused.length}):`);
  console.log('   ' + report.motoitBrandsUnused.join(', '));
}

// Gruppi-serie (§12)
const mgBrands = Object.keys(report.modelGroups.brands);
console.log(`\n## Gruppi-serie (data/model-groups.json): ${mgBrands.length} brand`);
for (const b of mgBrands) {
  const g = report.modelGroups.brands[b];
  console.log(`   ${b}: ${Object.entries(g).map(([k, n]) => `${k}(${n})`).join(', ')}`);
}
if (report.modelGroups.singletons.length)
  console.log(`   ⚠️  serie con 1 solo membro (rivedere la regola): ${report.modelGroups.singletons.join(', ')}`);
console.log(`   Rigenera: node scripts/build-model-groups.js`);

console.log(`\n${line}\nSuggerimento: aggiungi le coppie "ALIAS (stesso makeId)" a data/brand-aliases.json,\npoi  node scripts/canonicalize-brands.js.\n${line}\n`);
