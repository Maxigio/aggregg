/**
 * Clicca il tab "Annunci" nella pagina /moto-usate/ducati e esamina
 * se appaiono nuovi filtri / chiamate XHR / più risultati.
 */

const { chromium } = require('playwright');
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

(async () => {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
  });
  const pg = await browser.newPage();

  const net = [];
  pg.on('request', req => {
    const rt = req.resourceType();
    if (!['xhr','fetch','document'].includes(rt)) return;
    if (/analytics|publytics|iubenda|doubleclick|adform|google(ads|syndication)|gstatic|fonts\.g|tncid|region1|accounts\.google|adservice/.test(req.url())) return;
    net.push({ method: req.method(), rt, url: req.url() });
  });

  await pg.goto('https://www.moto.it/moto-usate/ducati', { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,2500));
  const before = net.length;
  console.log('Prima del click — network non-tracking:', before);

  // Click sul tab "Annunci"
  console.log('\nClicco tab "Annunci"...');
  const btn = pg.locator('.mlist-tab-link.app-first-tab-btn').first();
  const exists = await btn.count();
  console.log('  locator count:', exists);
  if (exists) {
    await btn.scrollIntoViewIfNeeded().catch(()=>{});
    await btn.click({ timeout: 5000 });
    await new Promise(r=>setTimeout(r,2500));
    console.log('  URL dopo click:', pg.url());
  }

  console.log('\nNetwork registrato dopo click:', net.length - before);
  net.slice(before).forEach(n => console.log(` ${n.method} ${n.rt} ${n.url}`));

  // Ora verifica cosa è cambiato nel DOM: count annunci, presenza filtri/selects
  const domAfter = await pg.evaluate(() => {
    const cards = document.querySelectorAll('.mcard--big').length;
    const selects = Array.from(document.querySelectorAll('select')).map(s => ({ name: s.name, opts: Array.from(s.options).slice(0,5).map(o => o.value) }));
    const inputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"]')).slice(0,10).map(i => ({ name: i.name, placeholder: i.placeholder }));
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({ action: f.action, method: f.method }));
    const visibleLinks = Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(h => h && h.includes('?') && /moto-usate/.test(h))
      .slice(0, 10);
    return { cards, selects, inputs, forms, visibleLinks };
  });
  console.log('\nDOM dopo click:');
  console.log(JSON.stringify(domAfter, null, 2));

  await browser.close();
})().catch(e => console.error(e));
