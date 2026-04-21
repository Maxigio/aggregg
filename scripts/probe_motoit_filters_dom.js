/**
 * Ispeziona pattern di filtro non-standard nella pagina /moto-usate/ducati.
 * Cerca: bottoni con "ordina/prezzo/filtro/marca" nel testo/classi/data-*,
 *        dropdown custom, link con querystring.
 * Poi simula click sul primo controllo di ordinamento e registra il network.
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

  const net = [];
  pg.on('request', req => {
    const rt = req.resourceType();
    if (rt === 'xhr' || rt === 'fetch' || rt === 'document') {
      const u = req.url();
      if (/analytics|publytics|iubenda|doubleclick|adform|adservice|gstatic|fonts\.g|googleads|googlesyndication|tncid|region1|accounts\.google/.test(u)) return;
      net.push({ method: req.method(), url: u, rt, phase: 'request' });
    }
  });

  await pg.goto('https://www.moto.it/moto-usate/ducati', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2500));

  // Ispezione DOM: cerca qualsiasi cosa con "ordina", "filter", "prezzo", "sort" in attr/class/text
  const suspects = await pg.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const re = /(ordin|filtro|filter|prezzo|sort|price)/i;
    const hits = [];
    for (const el of all) {
      const cls = el.className?.baseVal ?? el.className ?? '';
      const attrs = Array.from(el.attributes || []).map(a => `${a.name}=${a.value}`).join('|').slice(0, 150);
      const text = (el.textContent || '').slice(0, 40).replace(/\s+/g, ' ').trim();
      const clickable = el.onclick || el.getAttribute('role') === 'button' || ['BUTTON','A'].includes(el.tagName);
      if (clickable && (re.test(cls) || re.test(attrs) || re.test(text))) {
        hits.push({ tag: el.tagName, cls: String(cls).slice(0, 80), attrs, text });
        if (hits.length > 30) break;
      }
    }
    return hits;
  });
  console.log('=== Elementi clickable con keyword filtro/ordina/prezzo ===');
  suspects.slice(0, 20).forEach(h => console.log(`  ${h.tag}.${h.cls} text="${h.text}" attrs=${h.attrs.slice(0, 100)}`));

  // Cerca elementi con data-* attributes legati a sort/filter
  const dataAttrs = await pg.evaluate(() => {
    const re = /(sort|filter|price|ordin|ordina|prezzo)/i;
    const all = Array.from(document.querySelectorAll('*'));
    const out = [];
    for (const el of all) {
      for (const a of el.attributes || []) {
        if (a.name.startsWith('data-') && re.test(a.name)) {
          out.push({ tag: el.tagName, attr: a.name, value: a.value.slice(0, 60), cls: String(el.className || '').slice(0, 60) });
          if (out.length > 30) return out;
        }
      }
    }
    return out;
  });
  console.log('\n=== Elementi con data-* relativi a sort/filter ===');
  dataAttrs.forEach(d => console.log(`  ${d.tag}.${d.cls} [${d.attr}=${d.value}]`));

  // Tenta click su un pulsante "ordina" (se esiste)
  console.log('\n=== Tentativo di click su controlli sort ===');
  const clickTargets = [
    'button:has-text("Ordina")',
    '[role="button"]:has-text("Ordina")',
    'a:has-text("Ordina")',
    '.sort, .ordina, [class*="sort"], [class*="ordina"]',
    'select[name*="order" i], select[name*="sort" i]',
  ];
  let clicked = false;
  for (const sel of clickTargets) {
    try {
      const loc = pg.locator(sel).first();
      if (await loc.count() > 0) {
        console.log(`  Provo click su: ${sel}`);
        await loc.scrollIntoViewIfNeeded().catch(()=>{});
        await loc.click({ timeout: 3000 });
        await new Promise(r => setTimeout(r, 1500));
        clicked = true;
        console.log('  Click OK, URL:', pg.url());
        break;
      }
    } catch (e) { /* continua */ }
  }
  if (!clicked) console.log('  Nessun sort control trovato/cliccabile');

  // Network dopo interazione
  console.log('\n=== Network non-tracking intercettato (richieste) ===');
  net.slice(0, 20).forEach(n => console.log(`  ${n.method} ${n.rt} ${n.url}`));

  // HTML parse: estrai tutti gli <a href> che puntano a /moto-usate/ con querystring
  const interestingLinks = await pg.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="/moto-usate"]'))
      .map(a => a.getAttribute('href'))
      .filter(h => /[?&](sort|order|pmin|pmax|page|anno|ordina|price|prezzo)/i.test(h))
      .slice(0, 15);
  });
  console.log('\n=== Link interni /moto-usate con query params ===');
  interestingLinks.forEach(h => console.log('  ', h));
  if (!interestingLinks.length) console.log('  (nessuno)');

  await ctx.close();
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
