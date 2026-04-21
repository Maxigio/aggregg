/**
 * Sondaggi mirati per trovare mmmv Diavel V4 su AS24.
 */

const { chromium } = require('playwright');
const path = require('path');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

const CANDIDATES = [
  // URL path-based moto
  'https://www.autoscout24.it/lst-moto/ducati/diavel-v4?atype=B',
  'https://www.autoscout24.it/lst-moto/ducati/diavel-v4/?atype=B',
  // Tutti i Diavel e guardo campi vehicle per capire il V4
  'https://www.autoscout24.it/lst?cy=I&atype=B&mmmv=50030|70147||&sort=price&desc=0',
];

async function probe(browser, url) {
  const ctx = await browser.newContext({ locale:'it-IT', viewport:{width:1280,height:900} });
  const pg  = await ctx.newPage();
  try {
    const resp = await pg.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
    const finalUrl = pg.url();
    const status = resp?.status();
    const json = await pg.$eval('#__NEXT_DATA__', el => el.textContent).catch(()=>null);
    if (!json) return { finalUrl, status, error:'no __NEXT_DATA__' };
    const d = JSON.parse(json);
    const pp = d?.props?.pageProps;
    return { finalUrl, status, numberOfResults: pp?.numberOfResults, listings: pp?.listings, rest: Object.keys(pp||{}) };
  } finally { await ctx.close(); }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
  });

  for (const url of CANDIDATES) {
    console.log('\n==>', url);
    const r = await probe(browser, url);
    console.log('  finalUrl:', r.finalUrl);
    console.log('  status:', r.status);
    console.log('  total:', r.numberOfResults);
    if (r.listings && r.listings.length) {
      console.log('  First listing vehicle keys:', Object.keys(r.listings[0].vehicle || {}));
      console.log('  First listing vehicle:', JSON.stringify(r.listings[0].vehicle, null, 2).slice(0, 800));
      // Cerca V4 nei modelli
      const v4 = r.listings.filter(l => /v4/i.test(`${l.vehicle?.modelVersionInput||''} ${l.vehicle?.model||''} ${l.vehicle?.modelGroup||''}`));
      console.log(`  Annunci con V4 nei campi: ${v4.length}/${r.listings.length}`);
      if (v4.length) {
        console.log('  V4 vehicle esempio:', JSON.stringify(v4[0].vehicle, null, 2));
      }
    }
    if (r.rest) console.log('  pageProps keys:', r.rest.slice(0,15));
    if (r.error) console.log('  error:', r.error);
  }

  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
