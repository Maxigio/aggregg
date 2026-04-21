/**
 * Accetta cookie iubenda e poi cerca bottoni/link di paginazione.
 * Inoltre: ispeziona HTML raw per trovare numeri pagina / contatori.
 * Testa anche URL con slash (/ricerca/2) e varianti.
 */
const { chromium } = require('playwright');
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

(async () => {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: true,
  });
  const ctx = await browser.newContext({
    locale: 'it-IT',
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const pg = await ctx.newPage();

  const base = 'https://www.moto.it/moto-usate/ricerca?brand=ducati&sort=price-a';
  await pg.goto(base, { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,3000));

  // Accetta iubenda cookie se presente
  console.log('=== Accetto cookie iubenda ===');
  const accept = pg.locator('.iubenda-cs-accept-btn, #iubenda-cs-banner button:has-text("Accetta"), button:has-text("Accetta"), button:has-text("OK")').first();
  if (await accept.count() > 0) {
    try {
      await accept.click({ timeout: 3000 });
      await new Promise(r=>setTimeout(r,2000));
      console.log('  Cookie accettati');
    } catch (e) { console.log('  Err accept:', e.message.slice(0,60)); }
  } else {
    console.log('  Banner non trovato');
  }

  // Ora cerca elementi paginazione
  const pag = await pg.evaluate(() => {
    // Cerca contenitori con keyword pag/paginazione
    const containers = Array.from(document.querySelectorAll('[class*="pag"], [class*="pagination"], nav, .pagination, ul.pagination'));
    const info = containers.map(c => ({
      cls: String(c.className||'').slice(0,80),
      tag: c.tagName,
      visible: !!c.offsetParent,
      innerText: (c.innerText||'').trim().slice(0,200),
      hrefs: Array.from(c.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).slice(0,10),
    }));
    // Cerca anche link con testo numerico (1,2,3...)
    const numLinks = Array.from(document.querySelectorAll('a[href]'))
      .filter(a => /^\d+$/.test((a.textContent||'').trim()))
      .map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))
      .slice(0, 15);
    // Cerca testo "Pagina 1 di N" / "X-Y di Z"
    const body = document.body.innerText;
    const patterns = [
      /(\d+)\s*[-–]\s*(\d+)\s*di\s*(\d+)/i,
      /pagina\s+(\d+)\s+di\s+(\d+)/i,
      /di\s+(\d+)\s+(annunci|risultati)/i,
      /(\d[\d\.]*)\s+(annunci|risultati|moto)/i,
    ];
    const matches = patterns.map(p => body.match(p)?.[0] || null).filter(Boolean);
    return { containers: info, numLinks, matches };
  });
  console.log('\n=== Contenitori paginazione trovati ===');
  pag.containers.slice(0, 10).forEach(c => console.log(`  [${c.visible?'V':'h'}] ${c.tag}.${c.cls} "${c.innerText.slice(0,80)}" hrefs=${JSON.stringify(c.hrefs)}`));
  console.log('\n=== Link con testo numerico ===');
  pag.numLinks.forEach(l => console.log(`  ${l.text}: ${l.href}`));
  console.log('\n=== Pattern testo "N annunci" ===');
  pag.matches.forEach(m => console.log(`  "${m}"`));

  // Testa URL con slash
  console.log('\n=== Testa URL /ricerca/2 (slash) ===');
  const variants = [
    'https://www.moto.it/moto-usate/ricerca/2?brand=ducati&sort=price-a',
    'https://www.moto.it/moto-usate/ricerca?brand=ducati&sort=price-a&p=2',
    'https://www.moto.it/moto-usate/ducati/pagina/2',
    'https://www.moto.it/moto-usate/ducati/2',
  ];
  for (const u of variants) {
    try {
      const resp = await pg.goto(u, { waitUntil:'domcontentloaded', timeout:15000 });
      await new Promise(r=>setTimeout(r,1200));
      const firstLink = await pg.evaluate(() => document.querySelector('.mcard--big a[href]')?.getAttribute('href')?.slice(-35));
      console.log(`  status=${resp?.status()} url=${pg.url().slice(0,80)} firstCard=${firstLink}`);
    } catch (e) {
      console.log(`  ERR ${u.slice(0,60)}: ${e.message.slice(0,60)}`);
    }
  }

  // Raw HTML: cerca numeri di pagina o "off"/"page" nel markup
  console.log('\n=== Ricerca pattern paginazione in HTML raw ===');
  await pg.goto(base, { waitUntil:'domcontentloaded', timeout:20000 });
  await new Promise(r=>setTimeout(r,2000));
  const rawFindings = await pg.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const findings = {};
    const patterns = ['page=', 'off=', 'offset=', 'start=', 'pag=', '/ricerca/', 'Successiva', 'successiva', 'Avanti', 'Carica altri', 'loadMore', 'nextPage'];
    for (const p of patterns) {
      const count = (html.match(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      if (count > 0) findings[p] = count;
    }
    // Trova prime 3 occorrenze di "page=" con contesto
    const re = /page=\d+/g;
    const ctxs = [];
    let m;
    while ((m = re.exec(html)) && ctxs.length < 5) {
      ctxs.push(html.slice(Math.max(0,m.index-40), m.index+40));
    }
    return { findings, ctxs };
  });
  console.log('Pattern trovati:', rawFindings.findings);
  console.log('Contesti "page=":', rawFindings.ctxs);

  await ctx.close();
  await browser.close();
})().catch(e => console.error(e));
