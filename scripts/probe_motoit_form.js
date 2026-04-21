/**
 * Indaga la struttura del form di ricerca Moto.it per trovare marche + modelli.
 * Cerca: dropdown brand, dropdown model, eventuali API JSON.
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

  // Registra TUTTE le richieste network per trovare API JSON catalogo
  const nets = [];
  pg.on('request', req => {
    const rt = req.resourceType();
    if (['xhr','fetch','document','script'].includes(rt) && /moto\.it/.test(req.url())) {
      nets.push({ m: req.method(), rt, url: req.url() });
    }
  });

  await pg.goto('https://www.moto.it/moto-usate/ricerca', { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,3000));

  // Cerca il form e i suoi select
  const formInfo = await pg.evaluate(() => {
    // Select tradizionali
    const selects = Array.from(document.querySelectorAll('select')).map(s => ({
      name: s.name, id: s.id,
      optCount: s.options.length,
      firstOpts: Array.from(s.options).slice(0, 5).map(o => ({ v: o.value, l: o.textContent.trim() })),
    }));
    // Dropdown custom (div con data-* o role=listbox)
    const customs = Array.from(document.querySelectorAll('[role="listbox"], [class*="dropdown"], [class*="select"]'))
      .slice(0, 10)
      .map(el => ({ tag: el.tagName, cls: String(el.className||'').slice(0,60), text: (el.textContent||'').trim().slice(0,80) }));
    // Input custom legati a brand/model (cerca data-attr)
    const inputs = Array.from(document.querySelectorAll('input, [data-model], [data-brand]'))
      .filter(el => /brand|model|marca|modell/i.test(el.name||'') || /brand|model/i.test(el.getAttribute?.('data-name')||''))
      .slice(0, 10)
      .map(el => ({ tag: el.tagName, name: el.name, type: el.type, cls: String(el.className||'').slice(0,60) }));
    return { selects, customs, inputs };
  });
  console.log('=== Form info ===');
  console.log('Selects:', JSON.stringify(formInfo.selects, null, 2));
  console.log('\nCustoms:', JSON.stringify(formInfo.customs, null, 2));
  console.log('\nInputs:', JSON.stringify(formInfo.inputs, null, 2));

  // Prova: cerca un bottone "brand" / "marca" e cliccalo per vedere se apre un popup
  console.log('\n=== Click sul bottone brand/marca ===');
  const btn = await pg.locator('button:has-text("Marca"), button:has-text("Brand"), [data-name="brand"], [aria-label*="brand" i]').first();
  if (await btn.count()) {
    try {
      await btn.scrollIntoViewIfNeeded().catch(()=>{});
      await btn.click({ timeout: 3000 });
      await new Promise(r => setTimeout(r, 2000));
      console.log('  Click OK');
    } catch(e) { console.log('  Click err:', e.message.slice(0,80)); }
  } else {
    console.log('  Nessun bottone trovato con locator');
  }

  // Dopo il click, cerca lista marche (ul/li o div con molti items)
  const brandList = await pg.evaluate(() => {
    // Cerca qualsiasi ul con >20 li visibili
    const uls = Array.from(document.querySelectorAll('ul'));
    const candidates = uls.filter(u => u.children.length > 20).slice(0, 5);
    return candidates.map(u => ({
      cls: String(u.className||'').slice(0,60),
      count: u.children.length,
      firstItems: Array.from(u.children).slice(0, 10).map(li => ({
        text: (li.textContent||'').trim().slice(0, 40),
        data: Array.from(li.attributes || []).filter(a => a.name.startsWith('data-')).map(a => `${a.name}=${a.value}`).slice(0,3),
      })),
    }));
  });
  console.log('\n=== Liste trovate (UL con >20 items) ===');
  console.log(JSON.stringify(brandList, null, 2));

  // Networkintercepted filtro moto.it
  console.log('\n=== Chiamate di rete moto.it (XHR/fetch/script) ===');
  const uniq = [...new Map(nets.map(n => [n.url, n])).values()];
  uniq.filter(n => n.rt !== 'document').slice(0, 30).forEach(n => console.log(`  ${n.m} ${n.rt} ${n.url.slice(0, 200)}`));

  await browser.close();
})().catch(e => console.error(e));
