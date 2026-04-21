/**
 * Scansiona TUTTE le pagine Ducati Diavel su AS24 cercando "V4" in titolo/version.
 */
const { chromium } = require('playwright');
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

async function fetchPage(browser, url) {
  const ctx = await browser.newContext({ locale:'it-IT', viewport:{width:1280,height:900} });
  const pg = await ctx.newPage();
  try {
    await pg.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
    const json = await pg.$eval('#__NEXT_DATA__', el => el.textContent).catch(()=>null);
    if (!json) return [];
    const d = JSON.parse(json);
    return d?.props?.pageProps?.listings || [];
  } finally { await ctx.close(); }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
  });

  const base = 'https://www.autoscout24.it/lst?cy=I&atype=B&mmmv=50030|70147||&sort=price&desc=0';
  const all = [];
  for (let p = 1; p <= 5; p++) {
    const u = p === 1 ? base : `${base}&page=${p}`;
    const items = await fetchPage(browser, u);
    console.log(`Pag ${p}: ${items.length} listings`);
    if (!items.length) break;
    all.push(...items);
  }

  console.log(`\nTotale: ${all.length}`);
  const v4 = all.filter(it => {
    const bag = [
      it.vehicle?.make, it.vehicle?.model, it.vehicle?.modelGroup,
      it.vehicle?.modelVersionInput, it.vehicle?.variant, it.vehicle?.subtitle,
    ].filter(Boolean).join(' ').toLowerCase();
    return /v4/i.test(bag);
  });
  console.log(`Annunci con "V4": ${v4.length}`);
  v4.slice(0,10).forEach(it => {
    console.log(' ', it.price?.priceFormatted, '|', it.vehicle?.modelVersionInput || it.vehicle?.model, '|', it.vehicle?.variant, '|', it.vehicle?.subtitle, '|', it.vehicle?.modelId);
  });

  // Anche: lista unique modelId visti nei Diavel per vedere se ce ne sono altri oltre 70147
  const ids = new Set(all.map(it => it.vehicle?.modelId));
  console.log('\nmodelId distinti nei 82 Diavel:', [...ids]);

  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
