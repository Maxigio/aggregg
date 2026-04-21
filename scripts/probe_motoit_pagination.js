/**
 * Trova il parametro di paginazione corretto di /moto-usate/ricerca.
 * - Prova diverse varianti (page, p, pg, start, offset, off)
 * - Registra TUTTE le chiamate XHR/fetch (senza filtri)
 * - Scroll per verificare lazy-load
 * - Cerca bottoni "Successiva"/"Carica altri" e li clicca
 */
const { chromium } = require('playwright');
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

async function firstCardSignature(pg) {
  return await pg.evaluate(() => {
    const c = document.querySelector('.mcard--big');
    if (!c) return null;
    return {
      link: c.querySelector('a[href]')?.getAttribute('href')?.slice(-30),
      price: c.querySelector('[class*="price"]')?.textContent?.trim().slice(0,20),
    };
  });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: true,
  });
  const pg = await browser.newPage();

  // registra ogni chiamata di rete moto.it (xhr/fetch)
  const nets = [];
  pg.on('request', req => {
    const rt = req.resourceType();
    if (['xhr','fetch','document'].includes(rt) && /moto\.it/.test(req.url())) {
      nets.push({ m: req.method(), rt, url: req.url() });
    }
  });

  // Baseline: URL senza paginazione
  const base = 'https://www.moto.it/moto-usate/ricerca?brand=ducati&sort=price-a';
  await pg.goto(base, { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,2500));
  const sigBase = await firstCardSignature(pg);
  console.log('Baseline (no pagination):', sigBase);

  // Prova varianti parametri paginazione
  const params = ['page', 'p', 'pg', 'start', 'offset', 'off', 'n', 'pagina'];
  console.log('\n=== Test parametri paginazione ===');
  for (const pname of params) {
    const url = `${base}&${pname}=2`;
    await pg.goto(url, { waitUntil:'domcontentloaded', timeout:20000 });
    await new Promise(r=>setTimeout(r,1500));
    const sig = await firstCardSignature(pg);
    const changed = JSON.stringify(sig) !== JSON.stringify(sigBase);
    console.log(`  ${pname}=2 → primo=${sig?.link} prezzo=${sig?.price} ${changed ? '★ DIVERSO' : '(uguale)'}`);
  }

  // Test anche valori più alti
  console.log('\n=== Test con valori alti ===');
  for (const [pname, val] of [['page',3],['p',3],['off',30],['offset',30]]) {
    const url = `${base}&${pname}=${val}`;
    await pg.goto(url, { waitUntil:'domcontentloaded', timeout:20000 });
    await new Promise(r=>setTimeout(r,1200));
    const sig = await firstCardSignature(pg);
    const changed = JSON.stringify(sig) !== JSON.stringify(sigBase);
    console.log(`  ${pname}=${val} → primo=${sig?.link} prezzo=${sig?.price} ${changed ? '★ DIVERSO' : '(uguale)'}`);
  }

  // Torna alla baseline e scroll/cerca next
  console.log('\n=== Scroll + cerca pulsanti next ===');
  nets.length = 0;
  await pg.goto(base, { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,2500));
  // scroll 10 volte
  for (let i=0; i<10; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r=>setTimeout(r, 800));
  }
  const sigAfterScroll = await firstCardSignature(pg);
  const nScrollCards = await pg.evaluate(() => document.querySelectorAll('.mcard--big').length);
  console.log(`Dopo scroll: cards=${nScrollCards}, primo=${JSON.stringify(sigAfterScroll)}`);

  // Enumera bottoni candidati paginazione
  const candidates = await pg.evaluate(() => {
    const re = /(successiv|pagin|carica|altri|mostra|next|more|avanti|vedi)/i;
    return Array.from(document.querySelectorAll('a, button, [role="button"]'))
      .filter(el => re.test((el.textContent||'') + ' ' + (el.getAttribute('aria-label')||'')))
      .map(el => ({
        tag: el.tagName,
        text: (el.textContent||'').trim().slice(0,50),
        href: el.getAttribute('href'),
        aria: el.getAttribute('aria-label'),
        cls: String(el.className||'').slice(0,80),
        visible: !!el.offsetParent,
      }))
      .slice(0, 20);
  });
  console.log('\nCandidati "next" nel DOM:');
  candidates.forEach(c => console.log(`  ${c.tag}[${c.visible?'V':'h'}] "${c.text}" href=${c.href} aria=${c.aria} cls=${c.cls}`));

  // Prova click sul primo candidato visibile con "success" o "next" o link con href
  console.log('\n=== Tentativo click bottone next ===');
  const tryClick = [
    'a[href*="page="]:visible',
    'a[href*="off="]:visible',
    'a:has-text("Successiva")',
    'a:has-text("Avanti")',
    'button:has-text("Carica altri")',
    'button:has-text("Mostra altri")',
    '[class*="next"]:visible',
    '[class*="pagination"] a:not([class*="current"])',
  ];
  const preXhr = nets.length;
  for (const sel of tryClick) {
    try {
      const loc = pg.locator(sel).first();
      const c = await loc.count();
      if (c > 0) {
        console.log(`  Provo click: ${sel} (count=${c})`);
        await loc.scrollIntoViewIfNeeded().catch(()=>{});
        await loc.click({ timeout: 3000 });
        await new Promise(r=>setTimeout(r, 2500));
        const sig = await firstCardSignature(pg);
        const nCards = await pg.evaluate(() => document.querySelectorAll('.mcard--big').length);
        console.log(`    → URL: ${pg.url()}`);
        console.log(`    → cards=${nCards} primo=${JSON.stringify(sig)}`);
        break;
      }
    } catch (e) { /* continua */ }
  }

  // Stampa tutte le chiamate moto.it registrate
  console.log(`\n=== Chiamate moto.it (xhr/fetch/document) durante sessione: ${nets.length} ===`);
  const uniq = [...new Map(nets.map(n => [n.url, n])).values()];
  uniq.slice(0, 25).forEach(n => console.log(`  ${n.m} ${n.rt} ${n.url.slice(0, 180)}`));

  await browser.close();
})().catch(e => console.error(e));
