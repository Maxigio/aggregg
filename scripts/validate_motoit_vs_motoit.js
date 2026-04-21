/**
 * Validazione: confronta i risultati dello scraper Moto.it con la stessa ricerca
 * eseguita direttamente sul sito moto.it (via Playwright, "ground truth").
 *
 * Per ogni caso:
 *  1. Lancia lo scraper locale con i params dati
 *  2. Apre la URL equivalente su moto.it e raccoglie tutti gli URL annuncio dalle prime N pagine
 *  3. Calcola: intersezione, solo-scraper, solo-sito, copertura %
 */
const { chromium } = require('playwright');
const path = require('path');
const scrapeMotoIt = require('../backend/scrapers/motoit');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

const BASE = 'https://www.moto.it';
const PAGES_TO_CHECK = 5; // stesso MAX_PAGES dello scraper

// Costruisce la URL moto.it equivalente ai params (stessa logica di motoit.js)
function siteUrl(params, page = 1) {
  const { marca, prezzoMin, prezzoMax, annoMin, annoMax, kmMax, motoitBrandSlug, motoitModelSlug } = params;
  const pagePath = page > 1 ? `/pagina-${page}` : '';
  const qs = new URLSearchParams();
  const brandSlug = motoitBrandSlug || marca.toLowerCase().replace(/\s+/g, '-');
  qs.set('brand', brandSlug);
  if (motoitModelSlug) qs.set('model', `${brandSlug}|${motoitModelSlug}`);
  if (prezzoMin != null) qs.set('price_f', String(prezzoMin));
  if (prezzoMax != null) qs.set('price_t', String(prezzoMax));
  if (kmMax     != null) qs.set('km_t',    String(kmMax));
  if (annoMin   != null) qs.set('year_f',  String(annoMin));
  if (annoMax   != null) qs.set('year_t',  String(annoMax));
  qs.set('sort', 'price-a');
  return `${BASE}/moto-usate/ricerca${pagePath}?${qs.toString()}`;
}

// Scarica gli URL annuncio direttamente dal sito per N pagine
async function fetchSiteTruth(params) {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({ locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  const pg  = await ctx.newPage();

  const allUrls = [];
  let totalDeclared = null;

  for (let p = 1; p <= PAGES_TO_CHECK; p++) {
    const url = siteUrl(params, p);
    await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 1200));
    const data = await pg.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.mcard--big'));
      const urls = cards.map(c => c.querySelector('a[href]')?.getAttribute('href')).filter(Boolean);
      const total = (document.body.innerText.match(/(\d[\d.]*)\s+annunci/i) || [])[1] || null;
      return { urls, total };
    });
    if (p === 1) totalDeclared = data.total;
    if (data.urls.length === 0) break;
    allUrls.push(...data.urls);
  }

  await ctx.close();
  await browser.close();
  return { urls: allUrls, totalDeclared };
}

async function validate(label, params) {
  console.log(`\n\n════════ ${label} ════════`);
  console.log('Params:', JSON.stringify(params));

  // 1. Scraper locale
  console.log('\n[1/2] Scraper locale...');
  const t0 = Date.now();
  const scraped = await scrapeMotoIt(params);
  console.log(`   ${scraped.length} annunci in ${Date.now()-t0}ms`);

  // 2. Ground truth sito
  console.log('\n[2/2] Sito moto.it (ground truth)...');
  const t1 = Date.now();
  const site = await fetchSiteTruth(params);
  console.log(`   ${site.urls.length} annunci raccolti dal sito (totale dichiarato: ${site.totalDeclared}) in ${Date.now()-t1}ms`);

  // 3. Confronto
  // Normalizza URL: sito restituisce path relativo, scraper li rende assoluti
  const normalize = u => u.replace(/^https?:\/\/(www\.)?moto\.it/, '');
  const setScraper = new Set(scraped.map(r => normalize(r.url)));
  const setSite = new Set(site.urls.map(normalize));

  const intersezione = [...setScraper].filter(u => setSite.has(u));
  const soloScraper = [...setScraper].filter(u => !setSite.has(u));
  const soloSito    = [...setSite].filter(u => !setScraper.has(u));

  const copertura = setSite.size > 0 ? (intersezione.length / setSite.size * 100).toFixed(1) : 'N/A';

  console.log(`\n── Confronto ──`);
  console.log(`  Scraper: ${setScraper.size} unici`);
  console.log(`  Sito:    ${setSite.size} unici`);
  console.log(`  ∩:       ${intersezione.length}`);
  console.log(`  solo-scraper: ${soloScraper.length}`);
  console.log(`  solo-sito:    ${soloSito.length}`);
  console.log(`  COPERTURA: ${copertura}%`);

  if (soloSito.length > 0) {
    console.log(`\n  ⚠ Annunci sul sito ma NON nello scraper (primi 5):`);
    soloSito.slice(0, 5).forEach(u => console.log(`     ${u}`));
  }
  if (soloScraper.length > 0) {
    console.log(`\n  ⚠ Annunci nello scraper ma NON sul sito (primi 5):`);
    soloScraper.slice(0, 5).forEach(u => console.log(`     ${u}`));
  }
}

(async () => {
  await validate('A. Ducati Monster 1100', {
    tipo: 'moto', marca: 'Ducati', motoitBrandSlug: 'ducati', motoitModelSlug: 'monster-1100',
  });

  await validate('B. Honda Africa Twin 5-15k km<40k', {
    tipo: 'moto', marca: 'Honda', motoitBrandSlug: 'honda', motoitModelSlug: 'africa-twin-crf-1000l',
    prezzoMin: 5000, prezzoMax: 15000, kmMax: 40000,
  });

  await validate('C. Ducati brand-only ≤3000€ (ordinamento prezzo crescente)', {
    tipo: 'moto', marca: 'Ducati', motoitBrandSlug: 'ducati', prezzoMax: 3000,
  });

  await validate('D. Kawasaki Versys 650', {
    tipo: 'moto', marca: 'Kawasaki', motoitBrandSlug: 'kawasaki', motoitModelSlug: 'versys-650',
  });

  await validate('E. Yamaha MT-07', {
    tipo: 'moto', marca: 'Yamaha', motoitBrandSlug: 'yamaha', motoitModelSlug: 'mt-07',
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
