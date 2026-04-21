/**
 * Indaga perché un annuncio specifico manca dal tool.
 * - Apre la pagina dettaglio annuncio
 * - Apre le prime 3 pagine della ricerca Subito con gli stessi filtri del tool
 * - Verifica in quale pagina (se mai) compare
 */

const { chromium } = require('playwright');
const path = require('path');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

const AD_URL = 'https://www.subito.it/moto-e-scooter/ducati-diavel-v4-nuovo-da-immatricolare-2024-verona-638410818.htm';
const AD_ID  = '638410818';
const SEARCH_BASE = 'https://www.subito.it/annunci-italia/vendita/moto-e-scooter/?order=priceasc&bb=000040&bm=005061&ps=5000';

async function fetchNextData(browser, url) {
  const ctx = await browser.newContext({ locale:'it-IT', viewport:{width:1280,height:900} });
  const pg  = await ctx.newPage();
  try {
    await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const json = await pg.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
    return json ? JSON.parse(json) : null;
  } finally { await ctx.close(); }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
  });

  // 1. Pagina dettaglio
  console.log('=== DETTAGLIO ANNUNCIO ===');
  const detail = await fetchNextData(browser, AD_URL);
  const ad = detail?.props?.pageProps?.ad || detail?.props?.pageProps?.item?.item || detail?.props?.pageProps;
  // Stampa struttura top-level per capire
  console.log('Top-level keys:', Object.keys(detail?.props?.pageProps || {}).slice(0,20));
  const ad2 = detail?.props?.pageProps?.ad;
  if (ad2) {
    console.log('ad.features /price:', JSON.stringify(ad2?.features?.['/price'], null, 2));
    console.log('ad.subject:', ad2?.subject);
    console.log('ad.kind:', ad2?.kind);
    console.log('ad.category:', ad2?.category);
    console.log('ad.features keys:', Object.keys(ad2?.features || {}));
    console.log('ad.features /sub_category:', JSON.stringify(ad2?.features?.['/sub_category']));
    console.log('ad.features /type:', JSON.stringify(ad2?.features?.['/type']));
    console.log('ad.features /brand:', JSON.stringify(ad2?.features?.['/brand']));
    console.log('ad.features /model:', JSON.stringify(ad2?.features?.['/model']));
  }

  // 2. Pagine di ricerca 1-4
  console.log('\n=== RICERCA SUBITO (pagine 1-4, con priceasc&ps=5000) ===');
  let found = null;
  for (let p = 1; p <= 4; p++) {
    const u = p === 1 ? SEARCH_BASE : SEARCH_BASE + '&o=' + p;
    const data = await fetchNextData(browser, u);
    const list = data?.props?.pageProps?.initialState?.items?.list || [];
    const total = data?.props?.pageProps?.initialState?.items?.total;
    console.log(` Pagina ${p}: ${list.length} annunci (total pretended=${total})`);
    const match = list.find(e => e?.item?.urls?.default?.includes(AD_ID));
    if (match) {
      found = { page: p, item: match.item };
      const f = match.item.features || {};
      const prezzo = Number(f['/price']?.values?.[0]?.key);
      console.log(` 🎯 TROVATO in pagina ${p} — prezzo=${prezzo} titolo="${match.item.subject}"`);
      break;
    }
  }
  if (!found) console.log(' ❌ Annuncio NON trovato nelle 4 pagine priceasc&ps=5000');

  // 3. Se non trovato con ps=5000, prova senza ps (forse il prezzo è inferiore a 5000?)
  if (!found) {
    console.log('\n=== Prova SENZA ps (prezzoMin) ===');
    const noPsBase = 'https://www.subito.it/annunci-italia/vendita/moto-e-scooter/?order=priceasc&bb=000040&bm=005061';
    for (let p = 1; p <= 4; p++) {
      const u = p === 1 ? noPsBase : noPsBase + '&o=' + p;
      const data = await fetchNextData(browser, u);
      const list = data?.props?.pageProps?.initialState?.items?.list || [];
      console.log(` Pagina ${p}: ${list.length} annunci`);
      const match = list.find(e => e?.item?.urls?.default?.includes(AD_ID));
      if (match) {
        const f = match.item.features || {};
        const prezzo = Number(f['/price']?.values?.[0]?.key);
        console.log(` 🎯 TROVATO in pagina ${p} (no ps) — prezzo=${prezzo}`);
        break;
      }
    }
  }

  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
