/**
 * Forza viewport mobile e verifica se compaiono filtri / il tab Annunci diventa cliccabile.
 */

const { chromium } = require('playwright');
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

(async () => {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
  });
  const ctx = await browser.newContext({
    locale: 'it-IT',
    viewport: { width: 390, height: 844 },       // iPhone 13 Pro
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });
  const pg = await ctx.newPage();

  const net = [];
  pg.on('request', req => {
    const rt = req.resourceType();
    if (!['xhr','fetch','document'].includes(rt)) return;
    if (/analytics|publytics|iubenda|doubleclick|adform|google(ads|syndication)|gstatic|fonts\.g|tncid|region1|accounts\.google|adservice/.test(req.url())) return;
    net.push({ method: req.method(), rt, url: req.url() });
  });

  await pg.goto('https://www.moto.it/moto-usate/ducati', { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,3000));
  const before = net.length;
  console.log(`Mobile viewport — network non-tracking iniziale: ${before}`);

  // Info iniziale DOM in mobile
  const info0 = await pg.evaluate(() => {
    const cards = document.querySelectorAll('.mcard--big').length;
    const tabs = Array.from(document.querySelectorAll('.mlist-tab-link, [class*="tab"]'))
      .map(t => ({ text: (t.textContent||'').trim().slice(0,30), visible: !!(t.offsetParent), cls: String(t.className).slice(0,80) }))
      .slice(0, 10);
    const selects = document.querySelectorAll('select').length;
    const forms = document.querySelectorAll('form').length;
    return { cards, tabs, selects, forms };
  });
  console.log('Mobile DOM iniziale:', JSON.stringify(info0, null, 2));

  // Prova click tab Annunci
  console.log('\nProvo click tab Annunci su mobile...');
  try {
    const btn = pg.locator('.mlist-tab-link.app-first-tab-btn').first();
    if (await btn.count()) {
      const visible = await btn.isVisible().catch(()=>false);
      console.log('  Annunci visible:', visible);
      if (visible) {
        await btn.click({ timeout: 5000 });
        await new Promise(r=>setTimeout(r,2500));
        console.log('  Click OK, URL:', pg.url());
      } else {
        // forza click con dispatch
        console.log('  Forzo click via dispatch...');
        await btn.dispatchEvent('click');
        await new Promise(r=>setTimeout(r,2500));
        console.log('  URL post-dispatch:', pg.url());
      }
    }
  } catch (e) {
    console.log('  ERR:', e.message);
  }

  console.log(`\nNetwork dopo click: ${net.length - before}`);
  net.slice(before).forEach(n => console.log(` ${n.method} ${n.rt} ${n.url}`));

  // DOM dopo click
  const info1 = await pg.evaluate(() => {
    const cards = document.querySelectorAll('.mcard--big').length;
    const selects = Array.from(document.querySelectorAll('select')).map(s => ({ name: s.name, id: s.id, opts: Array.from(s.options).slice(0,5).map(o => o.value) }));
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({ action: f.action, method: f.method, inputs: f.querySelectorAll('input,select').length }));
    const inputs = Array.from(document.querySelectorAll('input')).slice(0,15).map(i => ({ name: i.name, type: i.type, placeholder: i.placeholder }));
    return { cards, selects, forms, inputs };
  });
  console.log('\nDOM dopo interazione mobile:');
  console.log(JSON.stringify(info1, null, 2));

  await browser.close();
})().catch(e => console.error(e));
