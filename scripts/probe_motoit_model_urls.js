/**
 * Verifica se esistono URL gerarchiche /moto-usate/{marca}/{modello} e quanti annunci contengono.
 * Estrae i link dalla pagina marca e li visita uno per uno.
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

  // Registra TUTTE le chiamate di rete senza filtri (per trovare API nascoste)
  const allNet = [];
  pg.on('request', req => {
    const rt = req.resourceType();
    if (['xhr','fetch'].includes(rt)) {
      allNet.push({ m: req.method(), rt, url: req.url() });
    }
  });

  await pg.goto('https://www.moto.it/moto-usate/ducati', { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,2500));

  // Estrai tutti i link che puntano a sub-path di /moto-usate/ducati/
  const modelLinks = await pg.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(h => h && /\/moto-usate\/ducati\//.test(h))
      .map(h => h.startsWith('http') ? h : ('https://www.moto.it' + h))
      .filter((v,i,a) => a.indexOf(v) === i)   // dedup
      .slice(0, 40);
  });
  console.log(`Trovati ${modelLinks.length} link sub-path:`);
  modelLinks.forEach(l => console.log(' ', l));

  // Verifica il primo link (es. /moto-usate/ducati/monster) — quante card ha?
  console.log('\n=== Test copertura per singolo modello ===');
  const results = [];
  for (const url of modelLinks.slice(0, 8)) {
    try {
      await pg.goto(url, { waitUntil:'domcontentloaded', timeout:20000 });
      await new Promise(r=>setTimeout(r,1500));
      const stats = await pg.evaluate(() => {
        const cards = document.querySelectorAll('.mcard--big').length;
        const title = document.title.slice(0, 80);
        // Estrai anche i link ad annunci reali (detail page)
        const detailLinks = Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.getAttribute('href'))
          .filter(h => h && /\.htm/.test(h) && !/\/moto-usate\/[^\/]+\/?$/.test(h));
        return { cards, title, detailLinks: [...new Set(detailLinks)].length };
      });
      results.push({ url, cards: stats.cards, detailLinks: stats.detailLinks, title: stats.title });
      console.log(`  ${stats.cards} cards | ${stats.detailLinks} detail-links | ${url.slice(0, 70)}`);
    } catch (e) {
      console.log(`  ERR ${url}: ${e.message.slice(0, 80)}`);
    }
  }

  // XHR totali registrati durante l'intera sessione
  console.log(`\n=== XHR/fetch durante sessione (${allNet.length}) ===`);
  // Aggreghiamo per host + path (per vedere pattern)
  const byHost = {};
  allNet.forEach(n => {
    try {
      const u = new URL(n.url);
      const k = u.hostname + u.pathname;
      byHost[k] = (byHost[k] || 0) + 1;
    } catch {}
  });
  const sorted = Object.entries(byHost).sort((a,b) => b[1]-a[1]).slice(0, 30);
  sorted.forEach(([k,v]) => console.log(`  ${v}x ${k}`));

  // Filtra solo quelli moto.it
  console.log('\n=== Solo moto.it (possibili API) ===');
  allNet.filter(n => /moto\.it/.test(n.url))
    .slice(0, 15)
    .forEach(n => console.log(`  ${n.m} ${n.rt} ${n.url.slice(0, 150)}`));

  await browser.close();
})().catch(e => console.error(e));
