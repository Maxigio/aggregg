#!/usr/bin/env node
/**
 * Canonicalizza le marche duplicate in data/models.json secondo i gruppi curati
 * in data/brand-aliases.json. Fonde le entry-variante nella canonica (unione
 * modelli dedup + metadata) e rimuove le varianti. Re-eseguibile, logga i merge.
 *
 * Uso: node scripts/canonicalize-brands.js
 */
const fs = require('fs');
const path = require('path');

const MODELS = path.join(__dirname, '..', 'data', 'models.json');
const ALIASES = path.join(__dirname, '..', 'data', 'brand-aliases.json');
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

const models  = JSON.parse(fs.readFileSync(MODELS, 'utf8'));
const aliases = JSON.parse(fs.readFileSync(ALIASES, 'utf8'));

let merges = 0, removed = 0;
for (const tipo of ['auto', 'moto']) {
  const groups = aliases[tipo] || [];
  for (const group of groups) {
    if (!Array.isArray(group) || group.length < 2) continue;
    const [canonical, ...variants] = group;
    const cEntry = models[tipo]?.[canonical];
    if (!cEntry) { console.warn(`[skip] canonico assente: ${tipo}/${canonical}`); continue; }
    cEntry.models = cEntry.models || [];
    const modelByNorm = new Map(cEntry.models.map(m => [norm(m.nome), m]));

    for (const v of variants) {
      const vEntry = models[tipo]?.[v];
      if (!vEntry) continue;
      // metadata: riempi i buchi del canonico con la variante
      if (!cEntry.autoscout && vEntry.autoscout) cEntry.autoscout = vEntry.autoscout;
      if (!cEntry.motoit && vEntry.motoit)       cEntry.motoit = vEntry.motoit;
      cEntry.sites = [...new Set([...(cEntry.sites || []), ...(vEntry.sites || [])])];
      // modelli: aggiungi i mancanti; per i duplicati FONDI i campi mancanti
      // (non scartare i metadati della variante: slugMotoIt, mmmvAutoscout, …)
      let added = 0, mergedFields = 0;
      for (const mdl of (vEntry.models || [])) {
        const key = norm(mdl.nome);
        const ex = modelByNorm.get(key);
        if (!ex) { cEntry.models.push(mdl); modelByNorm.set(key, mdl); added++; }
        else for (const [k, val] of Object.entries(mdl)) {
          if ((ex[k] == null || ex[k] === '') && val != null && val !== '') { ex[k] = val; mergedFields++; }
        }
      }
      delete models[tipo][v];
      removed++;
      console.log(`[merge] ${tipo}: "${v}" → "${canonical}"  (+${added} modelli, +${mergedFields} campi, motoit=${cEntry.motoit?.brandSlug || '-'}, as=${cEntry.autoscout?.makeId || '-'})`);
    }
    merges++;
  }
}

fs.writeFileSync(MODELS, JSON.stringify(models, null, 2));
console.log(`\nFatto: ${merges} gruppi, ${removed} varianti rimosse.`);
