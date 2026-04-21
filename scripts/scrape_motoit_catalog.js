/**
 * Scrape catalogo completo Moto.it: ogni marca + ogni modello con slug verificati.
 *
 * Struttura URL Moto.it:
 *  - /moto-usate                         → lista marche (path /moto-usate/<brandSlug>)
 *  - /moto-usate/<brandSlug>             → lista modelli (path /moto-usate/<brandSlug>/<modelSlug>)
 *  - /moto-usate/ricerca?brand=<brandSlug>&model=<brandSlug>|<modelSlug>&sort=price-a
 *
 * Output: data/motoit_catalog.json
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

const BASE = 'https://www.moto.it';

async function extractBrands(pg) {
  await pg.goto(`${BASE}/moto-usate`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));
  return await pg.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'))
      .filter(a => /^\/moto-usate\/[a-z0-9-]+\/?$/i.test(a.getAttribute('href')));
    const map = new Map();
    for (const a of links) {
      const href = a.getAttribute('href').replace(/\/$/, '');
      const slug = href.split('/').pop();
      // Nome: il testo visibile o l'attr title
      const rawText = (a.textContent || '').replace(/\s+/g, ' ').trim();
      // Filtra testo conteggio eventuale ("Aprilia 1.193" → nome "Aprilia")
      const cleanNome = rawText.replace(/\s+[\d.]+$/, '').trim() || slug;
      if (!map.has(slug)) map.set(slug, { nome: cleanNome, slug });
    }
    return [...map.values()];
  });
}

async function extractModels(pg, brandSlug) {
  const url = `${BASE}/moto-usate/${encodeURIComponent(brandSlug)}`;
  try {
    await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    return { url, error: `goto: ${e.message.slice(0,60)}`, models: [] };
  }
  await new Promise(r => setTimeout(r, 700));
  const models = await pg.evaluate((brandSlugArg) => {
    const re = new RegExp(`^/moto-usate/${brandSlugArg}/([a-z0-9-]+)/?$`, 'i');
    const links = Array.from(document.querySelectorAll('a[href]'))
      .filter(a => re.test(a.getAttribute('href') || ''));
    const map = new Map();
    for (const a of links) {
      const href = a.getAttribute('href').replace(/\/$/, '');
      const slug = href.split('/').pop();
      const rawText = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const cleanNome = rawText.replace(/\s+[\d.]+$/, '').trim() || slug;
      if (!map.has(slug)) map.set(slug, { nome: cleanNome, slug });
    }
    return [...map.values()];
  }, brandSlug);
  return { url, models };
}

(async () => {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: true,
  });
  const ctx = await browser.newContext({ locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage();

  console.log('=== Estraendo marche da /moto-usate ===');
  const brands = await extractBrands(pg);
  console.log(`Trovate ${brands.length} marche`);
  console.log('Primi 10:', brands.slice(0,10).map(b => `${b.nome}(${b.slug})`).join(', '));
  // Cagiva presente?
  const cagiva = brands.find(b => /cagiva/i.test(b.nome));
  console.log('Cagiva?', cagiva ? `SI (${cagiva.slug})` : 'NO');

  console.log(`\n=== Estraendo modelli per ${brands.length} marche ===`);
  const results = [];
  const t0 = Date.now();
  let idx = 0;
  for (const b of brands) {
    idx++;
    const res = await extractModels(pg, b.slug);
    const indicator = res.error ? `ERR ${res.error}` : `${res.models.length} modelli`;
    console.log(`[${idx}/${brands.length}] ${b.nome} (${b.slug}) → ${indicator}`);
    results.push({ ...b, models: res.models, error: res.error || null });
    // Log ogni 10 brand il progresso
    if (idx % 10 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [progresso] ${idx}/${brands.length} in ${elapsed}s`);
    }
  }

  const totalModels = results.reduce((a, b) => a + b.models.length, 0);
  console.log(`\nTOTALE: ${results.length} marche, ${totalModels} modelli`);

  // Log marche notevoli
  const report = ['cagiva', 'ducati', 'bmw', 'honda', 'yamaha', 'kawasaki', 'aprilia', 'moto-guzzi', 'harley-davidson'];
  console.log('\n=== Spot check marche ===');
  for (const slug of report) {
    const b = results.find(x => x.slug === slug);
    if (!b) { console.log(`  ${slug}: NON TROVATO`); continue; }
    console.log(`  ${b.nome}: ${b.models.length} modelli${b.models.length>0 ? ` (es: ${b.models.slice(0,5).map(m=>m.slug).join(', ')})` : ''}`);
  }

  // Verifica Cagiva Electra
  const cag = results.find(x => /cagiva/i.test(x.slug));
  if (cag) {
    const el = cag.models.find(m => /electra/i.test(m.nome) || /electra/i.test(m.slug));
    console.log(`\nCagiva Electra?`, el ? `SI (slug=${el.slug}, nome=${el.nome})` : 'NO');
  }

  const outPath = path.join(__dirname, '../data/motoit_catalog.json');
  fs.writeFileSync(outPath, JSON.stringify({ brands: results, scrapedAt: new Date().toISOString() }, null, 2));
  console.log(`\nScritto: ${outPath}`);

  await ctx.close();
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
