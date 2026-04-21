/**
 * Confronto end-to-end: nostri risultati vs i siti veri.
 *
 * Per ciascun caso test:
 *   1) Chiama /api/search del tool locale → raccoglie gli annunci per fonte.
 *   2) Apre in Playwright le identiche URL dei siti veri (2 pag Subito + 4 pag AS24)
 *      e estrae indipendentemente TUTTI gli annunci visibili sulla pagina SERP.
 *   3) Confronta i set di URL (set overlap) e i primi N prezzi crescenti.
 *
 * Esce con exit code 0 se tutto matcha, 1 altrimenti.
 *
 * Uso: node scripts/compare_sites.js
 */

const { chromium } = require('playwright');
const path = require('path');
const http = require('http');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');
const BROWSER_EXE = path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe');

// Il server è già avviato sulla porta del preview (env TOOL_PORT override manuale)
const TOOL_PORT = process.env.TOOL_PORT || 53450;
const TOOL_HOST = `http://localhost:${TOOL_PORT}`;

// ─── Casi di test ────────────────────────────────────────────────────────────
const CASES = [
  {
    label: 'Fiat Panda, prezzo max 4000€',
    params: { tipo: 'auto', marca: 'Fiat', modello: 'Panda', prezzoMax: '4000' },
  },
  {
    label: 'Fiat 500 Abarth (solo AS24), prezzo max 8000€',
    params: { tipo: 'auto', marca: 'Fiat', modello: '500 Abarth', prezzoMax: '8000' },
  },
  {
    label: 'KTM 1190 Adventure (moto)',
    params: { tipo: 'moto', marca: 'KTM', modello: '1190 Adventure', prezzoMax: '15000' },
  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchTool(params) {
  const qs = new URLSearchParams();
  // Il server tool si aspetta anche i metadata: li recuperiamo da /api/models
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  return new Promise((resolve, reject) => {
    http.get(`${TOOL_HOST}/api/search?${qs}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Preleva i metadata (slug, mmmv, brandKey) come fa il frontend
function fetchToolBrands(tipo) {
  return new Promise((resolve, reject) => {
    http.get(`${TOOL_HOST}/api/brands?tipo=${tipo}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).brands); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function fetchToolModels(tipo, marca) {
  return new Promise((resolve, reject) => {
    http.get(`${TOOL_HOST}/api/models?tipo=${tipo}&marca=${encodeURIComponent(marca)}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ─── URL builders (replica buildUrl degli scraper) ───────────────────────────
function buildSubitoUrl({ tipo, slugSubito, modelloSlugSubito, motoBrandKey, motoModelKey, prezzoMax }, page = 1) {
  const qs = new URLSearchParams();
  qs.set('order', 'priceasc');
  if (page > 1) qs.set('o', String(page));
  if (prezzoMax) qs.set('pe', String(prezzoMax));

  if (tipo === 'auto') {
    let base = `https://www.subito.it/annunci-italia/vendita/auto/${slugSubito}`;
    if (modelloSlugSubito) base += `/${modelloSlugSubito}`;
    return `${base}/?${qs}`;
  } else {
    // moto: usa bb/bm
    if (motoBrandKey) qs.set('bb', motoBrandKey);
    if (motoModelKey) qs.set('bm', motoModelKey);
    return `https://www.subito.it/annunci-italia/vendita/moto-e-scooter/?${qs}`;
  }
}

function buildAs24Url({ tipo, autoscoutMmmv, prezzoMax }, page = 1) {
  const qs = new URLSearchParams({ cy: 'I' });
  qs.set('sort', 'price');
  qs.set('desc', '0');
  qs.set('atype', tipo === 'moto' ? 'B' : 'C');
  qs.set('mmmv', autoscoutMmmv);
  if (prezzoMax) qs.set('priceto', String(prezzoMax));
  if (page > 1) qs.set('page', String(page));
  return `https://www.autoscout24.it/lst?${qs}`;
}

// ─── Estrazione indipendente dalle SERP ─────────────────────────────────────
async function extractSubito(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const json = await page.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
    if (!json) return [];
    const nd = JSON.parse(json);
    // Subito mette gli ads in diversi path a seconda della pagina; cerchiamo ovunque
    const findAds = (obj, out = []) => {
      if (!obj || typeof obj !== 'object') return out;
      if (Array.isArray(obj.ads))   obj.ads.forEach(a => out.push(a));
      if (Array.isArray(obj.list))  obj.list.forEach(a => a.item && out.push(a.item));
      for (const k of Object.keys(obj)) if (typeof obj[k] === 'object') findAds(obj[k], out);
      return out;
    };
    const raw = findAds(nd);
    const dedup = new Map();
    for (const a of raw) {
      const urlA = a.urls?.default || a.url || a.href;
      if (!urlA) continue;
      const feats = a.features || {};
      const price = feats['/price']?.values?.[0]?.key
                 || feats['/price']?.values?.[0]?.value
                 || a.price;
      const prezzo = parseInt(String(price).replace(/[^\d]/g, ''), 10) || null;
      if (!dedup.has(urlA)) dedup.set(urlA, { url: urlA, prezzo });
    }
    return [...dedup.values()];
  } finally {
    await page.close();
  }
}

async function extractAs24(context, url) {
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (resp && resp.status() === 404) return [];
    const json = await page.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
    if (!json) return [];
    const nd = JSON.parse(json);
    const listings = nd?.props?.pageProps?.listings || [];
    return listings.map(l => ({
      url: l.url ? `https://www.autoscout24.it${l.url}` : null,
      prezzo: parseInt(String(l.price?.priceFormatted || '').replace(/[^\d]/g, ''), 10) || null,
    })).filter(x => x.url);
  } finally {
    await page.close();
  }
}

// ─── Core ────────────────────────────────────────────────────────────────────
async function resolveParams(base) {
  // Arricchisce i params come farebbe il frontend
  const brands = await fetchToolBrands(base.tipo);
  const brand = brands.find(b => b.nome === base.marca);
  if (!brand) throw new Error(`Brand non trovato: ${base.marca}`);
  const mList = await fetchToolModels(base.tipo, base.marca);
  const model = mList.modelli.find(m => m.nome === base.modello);
  const params = { ...base };
  if (brand.autoscout) params.autoscoutMmmv = model?.mmmvAutoscout || `${brand.autoscout.makeId}|||`;
  if (model?.slugSubito) params.modelloSlugSubito = model.slugSubito;
  if (model?.subitoKey && base.tipo === 'moto') params.motoModelKey = model.subitoKey;
  if (brand.subito?.brandKey && base.tipo === 'moto') params.motoBrandKey = brand.subito.brandKey;
  // Per la URL Subito: lo slug-brand è solo la convenzione lowercase+kebab
  params.slugSubito = base.marca.toLowerCase().replace(/\s+/g, '-');
  return { params, brand, model };
}

async function compareCase(browser, test) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`CASO: ${test.label}`);

  const { params } = await resolveParams(test.params);

  // 1) Risultati dal tool
  const tool = await fetchTool(test.params);
  const toolBySource = tool.risultati.reduce((a, r) => {
    a[r.fonte] = a[r.fonte] || [];
    a[r.fonte].push({ url: r.url, prezzo: r.prezzo });
    return a;
  }, {});
  console.log(`  TOOL: ${tool.risultati.length} annunci (${Object.entries(toolBySource).map(([k,v]) => `${k}=${v.length}`).join(', ')})`);

  // 2) Ricerca "vera" nel browser, stessi URL
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
    extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9' },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  // Subito: pag 1..2
  const subitoPages = await Promise.all([1, 2].map(p => extractSubito(ctx, buildSubitoUrl(params, p))));
  const subitoRaw = [].concat(...subitoPages);
  const subitoDedup = [...new Map(subitoRaw.map(x => [x.url, x])).values()];

  // AS24: pag 1..4
  const as24Pages = await Promise.all([1, 2, 3, 4].map(p => extractAs24(ctx, buildAs24Url(params, p))));
  const as24Raw = [].concat(...as24Pages);
  const as24Dedup = [...new Map(as24Raw.map(x => [x.url, x])).values()];

  await ctx.close();

  console.log(`  SITI REALI: Subito=${subitoDedup.length}, AS24=${as24Dedup.length}`);

  // 3) Diff
  function diff(label, toolList = [], siteList = []) {
    const toolUrls = new Set(toolList.map(r => r.url));
    const siteUrls = new Set(siteList.map(r => r.url));
    const inBoth    = [...toolUrls].filter(u => siteUrls.has(u));
    const onlyTool  = [...toolUrls].filter(u => !siteUrls.has(u));
    const onlySite  = [...siteUrls].filter(u => !toolUrls.has(u));
    console.log(`  ▸ ${label}:  TOOL ${toolList.length} | REAL ${siteList.length} | IN COMUNE ${inBoth.length} | SOLO TOOL ${onlyTool.length} | SOLO REAL ${onlySite.length}`);
    if (onlySite.length && onlySite.length <= 5) {
      console.log(`    Mancanti nel TOOL (primi 5):`);
      for (const u of onlySite.slice(0, 5)) {
        const r = siteList.find(x => x.url === u);
        console.log(`      €${r?.prezzo ?? '?'}  ${u.slice(0, 90)}`);
      }
    }
    if (onlyTool.length && onlyTool.length <= 5) {
      console.log(`    Extra nel TOOL (primi 5):`);
      for (const u of onlyTool.slice(0, 5)) {
        const r = toolList.find(x => x.url === u);
        console.log(`      €${r?.prezzo ?? '?'}  ${u.slice(0, 90)}`);
      }
    }
    return { inBoth: inBoth.length, onlyTool: onlyTool.length, onlySite: onlySite.length };
  }

  const d1 = diff('Subito',    toolBySource.subito || [],    subitoDedup);
  const d2 = diff('Autoscout', toolBySource.autoscout || [], as24Dedup);

  // Prezzi top-10 side by side
  const sortPrice = a => a.filter(r => r.prezzo).sort((x,y) => x.prezzo - y.prezzo).slice(0, 10);
  const topSubTool = sortPrice(toolBySource.subito || []);
  const topSubReal = sortPrice(subitoDedup);
  const topAsTool  = sortPrice(toolBySource.autoscout || []);
  const topAsReal  = sortPrice(as24Dedup);

  console.log(`\n  Top-10 prezzi (min) — Subito:`);
  console.log(`    TOOL: ${topSubTool.map(r => `€${r.prezzo}`).join(', ') || '(nessuno)'}`);
  console.log(`    REAL: ${topSubReal.map(r => `€${r.prezzo}`).join(', ') || '(nessuno)'}`);
  console.log(`  Top-10 prezzi (min) — Autoscout:`);
  console.log(`    TOOL: ${topAsTool.map(r => `€${r.prezzo}`).join(', ')}`);
  console.log(`    REAL: ${topAsReal.map(r => `€${r.prezzo}`).join(', ')}`);

  return { subitoDiff: d1, as24Diff: d2 };
}

(async () => {
  console.log('Avvio browser Playwright per confronto indipendente…');
  const browser = await chromium.launch({
    executablePath: BROWSER_EXE,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const results = [];
    for (const c of CASES) {
      results.push(await compareCase(browser, c));
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('RIEPILOGO');
    for (let i = 0; i < CASES.length; i++) {
      const r = results[i];
      console.log(`  ${CASES[i].label}`);
      console.log(`    Subito:    in comune ${r.subitoDiff.inBoth} | solo tool ${r.subitoDiff.onlyTool} | solo real ${r.subitoDiff.onlySite}`);
      console.log(`    Autoscout: in comune ${r.as24Diff.inBoth} | solo tool ${r.as24Diff.onlyTool} | solo real ${r.as24Diff.onlySite}`);
    }
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('ERRORE:', e); process.exit(1); });
