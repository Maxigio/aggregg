/**
 * Esplora la pagina /moto-usate/ricerca per capire i parametri supportati.
 * Identifica form, select, input, quindi prova diverse combinazioni di URL.
 */

const { chromium } = require('playwright');
const path = require('path');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

async function main() {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
  });
  const ctx = await browser.newContext({ locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  const pg  = await ctx.newPage();

  // Cattura TUTTE le chiamate utili
  const xhrs = [];
  pg.on('request', req => {
    const rt = req.resourceType();
    if (rt === 'xhr' || rt === 'fetch' || rt === 'document') {
      xhrs.push({ method: req.method(), url: req.url(), rt });
    }
  });

  console.log('=== /moto-usate/ricerca ===');
  try {
    await pg.goto('https://www.moto.it/moto-usate/ricerca', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    console.log('Final URL:', pg.url());

    const info = await pg.evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        action: f.getAttribute('action'),
        method: f.method,
        inputs: Array.from(f.querySelectorAll('input,select,textarea')).map(i => ({
          name: i.name,
          type: i.type,
          value: i.value || null,
          options: i.tagName === 'SELECT' ? Array.from(i.options).slice(0, 5).map(o => ({ value: o.value, label: o.textContent.trim().slice(0, 40) })) : null,
        })),
      }));
      const selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name || s.id,
        options: Array.from(s.options).slice(0, 5).map(o => ({ value: o.value, label: o.textContent.trim() })),
      }));
      const bodyText = document.body.textContent.slice(0, 500);
      const cards = document.querySelectorAll('.mcard--big').length;
      return { forms, selects, cards, bodyText };
    });
    console.log('Cards:', info.cards);
    console.log('\nForms trovati:', info.forms.length);
    info.forms.forEach((f, i) => {
      console.log(`  [${i}] action=${f.action}, method=${f.method}, inputs=${f.inputs.length}`);
      f.inputs.slice(0, 20).forEach(inp => console.log(`     - ${inp.name} (${inp.type})${inp.options ? ' opts=' + JSON.stringify(inp.options.slice(0,3)) : ''}`));
    });
    console.log('\nSelects top-level:', info.selects.length);
    info.selects.slice(0, 8).forEach(s => console.log(`  ${s.name}: ${JSON.stringify(s.options)}`));
  } catch (e) {
    console.log('ERR:', e.message);
  }

  // Controllo anche un secondo URL: moto.it/market (spesso marchi usano endpoint separato)
  console.log('\n\n=== /market ===');
  try {
    const resp = await pg.goto('https://www.moto.it/market', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Status:', resp?.status(), ' URL:', pg.url());
    const info = await pg.evaluate(() => {
      const cards = document.querySelectorAll('.mcard--big').length;
      const forms = document.querySelectorAll('form').length;
      const title = document.title;
      return { cards, forms, title };
    });
    console.log('Info:', info);
  } catch (e) { console.log('ERR:', e.message); }

  // XHR raccolte
  const apiLike = xhrs.filter(x => /\.(json|xml)|\/api\/|\/search|\/annunc/i.test(x.url) && !/publytics|analytics|adform|doubleclick|googletag|gstatic|fonts/.test(x.url));
  console.log('\n\nXHR utili:', apiLike.length);
  apiLike.slice(0, 15).forEach(x => console.log(` ${x.method} ${x.rt} ${x.url}`));

  await ctx.close();
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
