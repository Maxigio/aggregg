/**
 * Conta TUTTI i possibili contenitori di annunci nel DOM di /moto-usate/ducati,
 * anche quelli nascosti via CSS. Verifica se esistono annunci non visibili a .mcard--big.
 */
const { chromium } = require('playwright');
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

(async () => {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: true,
  });
  const pg = await browser.newPage();
  await pg.goto('https://www.moto.it/moto-usate/ducati', { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,2500));

  const stats = await pg.evaluate(() => {
    const counts = {};
    const selectors = [
      '.mcard', '.mcard--big', '.mcard--small', '.mcard--medium',
      '[class*="mcard"]', '[class*="listing"]', '[class*="annunci"]',
      'article', '[itemtype*="Vehicle"]', '[itemtype*="Product"]',
      'a[href*=".htm"]', 'a[href*="/annunci/"]', 'a[href*="-id"]',
    ];
    for (const s of selectors) {
      const els = document.querySelectorAll(s);
      counts[s] = els.length;
    }
    // Conta link ad annunci nel sitemap-like: tutte le <a> che puntano a detail page
    const allLinks = Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(h => h && /\/moto-usate\/[^\/]+\/[^\/]+\.html?/.test(h));
    counts['detail-links (regex)'] = allLinks.length;
    const uniqLinks = [...new Set(allLinks)];
    counts['detail-links unique'] = uniqLinks.length;
    return { counts, sampleLinks: uniqLinks.slice(0, 15) };
  });
  console.log('Conteggi per selettore:');
  Object.entries(stats.counts).forEach(([k,v]) => console.log(`  ${k}: ${v}`));
  console.log('\nEsempi link dettaglio:');
  stats.sampleLinks.forEach(l => console.log(' ', l));

  await browser.close();
})().catch(e => console.error(e));
