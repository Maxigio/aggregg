'use strict';
// Costruisce l'indice moto marca/modello → URL ultimatespecs dalle sitemap (una volta).
// Uso: node scripts/harvest-moto-specs.js [--out data/ultimatespecs-moto-index.json]
// Output: { generatedAt, host, brands: { norm(marca): { name, seg, models: { norm(modello): { label, items:[[anno, slug]] } } } } }
const fs = require('fs');
const path = require('path');
const { norm } = require('../backend/scrapers/brand-match');
const ms = require('../backend/scrapers/moto-specs');

const outPath = (() => { const i = process.argv.indexOf('--out'); return path.join(__dirname, '..', i >= 0 ? process.argv[i + 1] : 'data/ultimatespecs-moto-index.json'); })();
const sleep = t => new Promise(r => setTimeout(r, t));
// path loc: /motorcycles-specs/{seg}/{seg}-{model}-{anno}
const RE = /\/motorcycles-specs\/([^/]+)\/(.+)-(\d{4})$/;

(async () => {
  console.log('[moto] sitemap indice…');
  const idxXml = (await ms.httpGetText(ms.HOST + '/sitemap_bikes.xml')).body;
  const subs = ms.parseSitemapLocs(idxXml);
  console.log(`[moto] ${subs.length} sub-sitemap`);

  const out = { generatedAt: new Date().toISOString().slice(0, 10), host: ms.HOST, brands: {} };
  let urls = 0, skipped = 0;
  for (const sub of subs) {
    await sleep(1000);   // gentile (robots crawl-delay)
    const xml = (await ms.httpGetText(sub)).body;
    const locs = ms.parseSitemapLocs(xml);
    for (const loc of locs) {
      const p = loc.replace(/^https?:\/\/[^/]+/, '');
      const m = RE.exec(p);
      if (!m) { skipped++; continue; }
      const seg = m[1];
      const fullSlug = decodeURIComponent(p.split('/').pop());   // {seg}-{model}-{anno} esatto dallo slug
      const year = Number(m[3]);
      const modelSlug = m[2].replace(new RegExp('^' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-?'), '');   // togli prefisso marca
      const bKey = norm(seg);
      if (!bKey) { skipped++; continue; }
      const brand = out.brands[bKey] || (out.brands[bKey] = { name: ms.prettyMoto(seg), seg, models: {} });
      const mKey = norm(modelSlug);
      if (!mKey) { skipped++; continue; }
      const model = brand.models[mKey] || (brand.models[mKey] = { label: ms.prettyMoto(modelSlug), items: [] });
      model.items.push([year, fullSlug]);
      urls++;
    }
    console.log(`[moto] ${sub.split('/').pop()} → tot url ${urls}`);
  }
  // dedup + sort per anno desc
  let brands = 0, models = 0;
  for (const b of Object.values(out.brands)) {
    brands++;
    for (const key of Object.keys(b.models)) {
      const seen = new Set();
      const items = b.models[key].items.filter(([, s]) => (seen.has(s) ? false : (seen.add(s), true)));
      items.sort((x, y) => y[0] - x[0]);
      b.models[key].items = items; models++;
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`[moto] scritto ${outPath} — marche ${brands}, modelli ${models}, url ${urls} (skip ${skipped}), bytes ${fs.statSync(outPath).size}`);
})().catch(e => { console.error('[moto] FATAL', e.message); process.exit(1); });
