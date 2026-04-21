/**
 * Sonda URL parameters di Moto.it: paginazione, ordinamento, filtri prezzo/anno/km.
 * Estrae anche link di paginazione e opzioni dei select dal DOM per capire la sintassi reale.
 */

const { chromium } = require('playwright');
const path = require('path');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

async function fetchCount(pg, url) {
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  const data = await pg.evaluate(() => {
    const cards = document.querySelectorAll('.mcard--big');
    const prices = Array.from(cards).map(c => {
      const p = c.querySelector('.mcard-price-value');
      return p ? p.textContent.trim() : null;
    }).filter(Boolean);
    // Paginazione: cerca tutti i link che puntano a questa pagina con ?page= o /page/N
    const pageLinks = Array.from(document.querySelectorAll('a[href*="page"]')).slice(0, 15).map(a => ({ href: a.getAttribute('href'), text: a.textContent.trim().slice(0, 20) }));
    // Form/select per ordinamento
    const selects = Array.from(document.querySelectorAll('select')).map(s => ({
      name: s.name || s.id,
      options: Array.from(s.options).slice(0, 8).map(o => ({ value: o.value, label: o.textContent.trim().slice(0, 40) })),
    }));
    // Form action + inputs
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      action: f.getAttribute('action'),
      method: f.method,
      inputs: Array.from(f.querySelectorAll('input,select')).map(i => ({ name: i.name, type: i.type, value: i.value })).slice(0, 20),
    })).slice(0, 3);
    // Total count textuale (es. "123 annunci")
    const bodyText = document.body.textContent;
    const totMatch = bodyText.match(/(\d{1,5})\s+(annunci|risultati|moto)/i);
    return { count: cards.length, prices, pageLinks, selects, forms, totMatch: totMatch?.[0] };
  });
  return { url, finalUrl: pg.url(), ...data };
}

async function main() {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
  });
  const ctx = await browser.newContext({ locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  const pg  = await ctx.newPage();

  const TESTS = [
    // Base
    'https://www.moto.it/moto-usate/ducati',
    // Paginazione
    'https://www.moto.it/moto-usate/ducati?page=2',
    'https://www.moto.it/moto-usate/ducati/page/2',
    'https://www.moto.it/moto-usate/ducati?p=2',
    // Ordinamento
    'https://www.moto.it/moto-usate/ducati?order=priceasc',
    'https://www.moto.it/moto-usate/ducati?sort=price',
    'https://www.moto.it/moto-usate/ducati?order=prezzo-crescente',
    'https://www.moto.it/moto-usate/ducati?sort=prezzo_asc',
    // Filtri prezzo
    'https://www.moto.it/moto-usate/ducati?prezzo_min=5000',
    'https://www.moto.it/moto-usate/ducati?pmin=5000',
    'https://www.moto.it/moto-usate/ducati?priceMin=5000',
    // Modello + filtro
    'https://www.moto.it/moto-usate/ducati/diavel-v4?prezzo_min=5000',
  ];

  for (const url of TESTS) {
    try {
      const r = await fetchCount(pg, url);
      console.log(`\n${url}`);
      console.log(`  → ${r.finalUrl}`);
      console.log(`  count=${r.count}, totMatch="${r.totMatch}"`);
      if (r.prices.length) console.log(`  primi prezzi: ${r.prices.slice(0,6).join(' | ')}`);
      if (r.pageLinks.length) {
        const unique = [...new Set(r.pageLinks.map(x => x.href))].slice(0, 5);
        console.log(`  pageLinks unique:`, unique);
      }
      // Solo sul primo test stampo select+form
      if (url.endsWith('/ducati')) {
        if (r.selects.length) {
          console.log(`  selects:`);
          r.selects.forEach(s => console.log(`    ${s.name}:`, JSON.stringify(s.options.slice(0,4))));
        }
        if (r.forms.length) {
          console.log(`  forms:`);
          r.forms.forEach(f => console.log(`    action=${f.action}, method=${f.method}, inputs=`, f.inputs.slice(0,6).map(i => `${i.name}(${i.type})`).join(',')));
        }
      }
    } catch (e) {
      console.log(`\n${url} — ERR: ${e.message}`);
    }
  }

  await ctx.close();
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
