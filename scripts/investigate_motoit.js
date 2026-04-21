/**
 * Indagine Moto.it: cattura tutte le richieste di rete, identifica l'API interna,
 * esamina lo state lato client (Vue/Nuxt/Next).
 *
 * Test case: Ducati Diavel V4 con filtro prezzoMin=5000€ ordinato priceasc.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

const TEST_URLS = [
  'https://www.moto.it/moto-usate/ducati/diavel-v4',
  'https://www.moto.it/moto-usate/ducati',
  'https://www.moto.it/moto-usate',
];

async function inspect(browser, url) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
    viewport: { width: 1280, height: 900 },
  });
  const pg = await ctx.newPage();

  const xhrs = [];
  pg.on('request', req => {
    const rt = req.resourceType();
    if (rt === 'xhr' || rt === 'fetch') {
      xhrs.push({ method: req.method(), url: req.url(), rt });
    }
  });
  pg.on('response', async resp => {
    const rt = resp.request().resourceType();
    if (rt === 'xhr' || rt === 'fetch') {
      const u = resp.url();
      let bodyPreview = null;
      try {
        const headers = resp.headers();
        if (headers['content-type']?.includes('json')) {
          const text = await resp.text();
          bodyPreview = text.slice(0, 400);
        }
      } catch (_) {}
      const entry = xhrs.find(x => x.url === u);
      if (entry) { entry.status = resp.status(); entry.bodyPreview = bodyPreview; }
    }
  });

  console.log(`\n━━━ ${url} ━━━`);
  try {
    const resp = await pg.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('  Status:', resp?.status(), ' Final URL:', pg.url());

    // Snapshot globals nel contesto pagina
    const globals = await pg.evaluate(() => {
      const out = {};
      for (const key of ['__NUXT__', '__INITIAL_STATE__', '__NEXT_DATA__', '__APOLLO_STATE__', '__VUE_APP__']) {
        out[key] = typeof window[key] !== 'undefined' ? 'PRESENT' : 'absent';
      }
      // __NEXT_DATA__ è uno script tag, non window
      out.nextDataScript = !!document.getElementById('__NEXT_DATA__');
      out.nuxtScript = !!document.getElementById('__NUXT_DATA__');
      // Stampa tutti gli script id
      out.scriptIds = Array.from(document.querySelectorAll('script[id]')).map(s => s.id);
      return out;
    });
    console.log('  Globals:', JSON.stringify(globals));

    // Se c'è __NEXT_DATA__ o __NUXT_DATA__, leggilo
    if (globals.nextDataScript) {
      const text = await pg.$eval('#__NEXT_DATA__', el => el.textContent);
      console.log('  __NEXT_DATA__ first 600 chars:', text.slice(0, 600));
    }
    if (globals.nuxtScript) {
      const text = await pg.$eval('#__NUXT_DATA__', el => el.textContent);
      console.log('  __NUXT_DATA__ first 600 chars:', text.slice(0, 600));
    }

    // Conta card di annunci
    const cardCount = await pg.evaluate(() => document.querySelectorAll('.mcard--big').length);
    console.log('  .mcard--big count:', cardCount);

    // Dump API-looking XHRs
    const apiLike = xhrs.filter(x => /api|search|listing|annunc|feed|\.json/i.test(x.url));
    console.log('  API-like XHR count:', apiLike.length);
    apiLike.slice(0, 10).forEach(x => {
      console.log(`    ${x.method} [${x.status || '?'}] ${x.url}`);
      if (x.bodyPreview) console.log(`      body: ${x.bodyPreview.replace(/\s+/g, ' ').slice(0, 200)}`);
    });

    // Dump altri XHR non-api (magari ci sono chiamate utili)
    const others = xhrs.filter(x => !apiLike.includes(x)).slice(0, 5);
    if (others.length) {
      console.log('  Altri XHR (primi 5):');
      others.forEach(x => console.log(`    ${x.method} [${x.status || '?'}] ${x.url}`));
    }
  } catch (e) {
    console.log('  ERR:', e.message);
  } finally {
    await ctx.close();
  }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  for (const u of TEST_URLS) await inspect(browser, u);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
