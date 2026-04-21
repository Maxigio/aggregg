/**
 * Prova diverse URL AS24 per trovare il mmmv corretto di Ducati Diavel V4.
 */

const { chromium } = require('playwright');
const path = require('path');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

const CANDIDATES = [
  'https://www.autoscout24.it/lst/ducati/diavel-v4?atype=B',
  'https://www.autoscout24.it/lst/ducati/diavel?atype=B',
  'https://www.autoscout24.it/lst?atype=B&q=Ducati%20Diavel%20V4',
  'https://www.autoscout24.it/lst/ducati?atype=B',
];

async function fetchMeta(browser, url) {
  const ctx = await browser.newContext({ locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  const pg  = await ctx.newPage();
  try {
    await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const finalUrl = pg.url();
    const json = await pg.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
    if (!json) return { finalUrl, error: 'no __NEXT_DATA__' };
    const d = JSON.parse(json);
    const pp = d?.props?.pageProps;
    const totalResults = pp?.numberOfResults;
    const query = pp?.search?.query || pp?.request?.query || pp?.searchMetadata || null;
    const sampleListing = pp?.listings?.[0];
    const sampleVehicle = sampleListing?.vehicle;
    return {
      finalUrl,
      totalResults,
      firstListingTitle: sampleListing ? `${sampleVehicle?.make} ${sampleVehicle?.modelVersionInput || sampleVehicle?.model}` : null,
      firstModelId: sampleVehicle?.modelId || null,
      firstModelName: sampleVehicle?.model || null,
      // Cerca mmmv nell'URL o nei filtri
      filters: pp?.activeFilters || pp?.filters || null,
    };
  } finally { await ctx.close(); }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
  });
  for (const url of CANDIDATES) {
    console.log('\n==>', url);
    try {
      const meta = await fetchMeta(browser, url);
      console.log(JSON.stringify(meta, null, 2).slice(0, 1500));
    } catch (e) {
      console.log('ERR:', e.message);
    }
  }
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
