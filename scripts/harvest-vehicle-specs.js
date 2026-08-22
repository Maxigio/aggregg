'use strict';
// Costruisce l'indice marca/modello → slug auto-data.net (una volta, come build-model-groups).
// Uso: node scripts/harvest-vehicle-specs.js [--limit N] [--out data/autodata-index.json]
// Output: { generatedAt, brands: { norm(marca): { name, slug, models: { norm(modello): { name, slug } } } } }
const fs = require('fs');
const path = require('path');
const { norm } = require('../backend/scrapers/brand-match');
const vs = require('../backend/scrapers/vehicle-specs');

const args = process.argv.slice(2);
const limit = (() => { const i = args.indexOf('--limit'); return i >= 0 ? Number(args[i + 1]) : 0; })();
const outPath = (() => {
  const i = args.indexOf('--out');
  if (i >= 0) return path.join(__dirname, '..', args[i + 1]);
  // `--limit` e' fatto per le prove: un giro limitato NON deve sovrascrivere l'indice che l'app
  // usa. Senza `--out` esplicito scrive su un file di prova accanto.
  return path.join(__dirname, '..', limit ? 'data/autodata-index.PROVA.json' : 'data/autodata-index.json');
})();
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('[harvest] allbrands…');
  const { body } = await vs.httpGetText(vs.HOST + '/en/allbrands');
  let brands = vs.parseBrandList(body);
  console.log(`[harvest] ${brands.length} marche`);
  if (limit) brands = brands.slice(0, limit);

  const out = { generatedAt: new Date().toISOString().slice(0, 10), brands: {} };
  let ok = 0, ko = 0, models = 0;
  for (let i = 0; i < brands.length; i++) {
    const b = brands[i];
    try {
      const r = await vs.httpGetText(`${vs.HOST}/en/${b.slug}`);
      const ms = vs.parseModelList(r.body);
      const mmap = {};
      for (const m of ms) { const k = norm(m.name); if (k && !mmap[k]) mmap[k] = { name: m.name, slug: m.slug }; }
      const key = norm(b.name);   // nomi-marca duplicati (es. "Audi" main + JV) → unisci i modelli
      const ex = out.brands[key];
      out.brands[key] = { name: b.name, slug: (ex && ex.slug) || b.slug, models: Object.assign({}, ex && ex.models, mmap) };
      models += Object.keys(mmap).length; ok++;
      if (i % 25 === 0 || i === brands.length - 1) console.log(`[harvest] ${i + 1}/${brands.length} ${b.name} (${Object.keys(mmap).length} modelli)`);
    } catch (e) { ko++; console.warn(`[harvest] KO ${b.name}: ${e.message}`); }
    await sleep(250);   // gentile
  }
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`[harvest] scritto ${outPath} — marche ${ok} (ko ${ko}), modelli ${models}, bytes ${fs.statSync(outPath).size}`);
})().catch(e => { console.error('[harvest] FATAL', e.message); process.exit(1); });
