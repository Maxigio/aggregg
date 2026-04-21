/**
 * Trova la pagina corretta con la lista completa delle marche Moto.it.
 */
const { chromium } = require('playwright');
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

async function check(pg, url) {
  await pg.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,1500));
  const info = await pg.evaluate(() => {
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    // Link con ?brand=SLUG senza &model=
    const brandOnly = allLinks
      .map(a => a.getAttribute('href'))
      .filter(h => h && /[?&]brand=[^&]+$/.test(h) && !h.includes('model='));
    // Link col path /moto-usate/SLUG/ (landing marca)
    const pathBrand = allLinks
      .map(a => a.getAttribute('href'))
      .filter(h => h && /^\/moto-usate\/[a-z0-9-]+\/?$/i.test(h));
    const counts = {
      queryBrand: brandOnly.length,
      queryBrandUniq: new Set(brandOnly).size,
      pathBrand: pathBrand.length,
      pathBrandUniq: new Set(pathBrand).size,
    };
    return { counts, sampleQuery: [...new Set(brandOnly)].slice(0,10), samplePath: [...new Set(pathBrand)].slice(0,10) };
  });
  console.log(`\nURL: ${url}`);
  console.log(JSON.stringify(info, null, 2));
}

(async () => {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: true,
  });
  const pg = await browser.newPage();

  await check(pg, 'https://www.moto.it/moto-usate');
  await check(pg, 'https://www.moto.it/moto-usate/ricerca');
  await check(pg, 'https://www.moto.it/moto-usate/ricerca?brand=ducati');
  await check(pg, 'https://www.moto.it/moto-usate/ricerca?brand=bmw');

  await browser.close();
})().catch(e => console.error(e));
