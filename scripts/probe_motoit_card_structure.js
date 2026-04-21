/**
 * Estrae il dettaglio completo di una card annuncio Moto.it e valida filtri modello.
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

  const urls = [
    { label: 'Ducati brand only sort price-a pag 1', url: 'https://www.moto.it/moto-usate/ricerca?brand=ducati&sort=price-a' },
    { label: 'Ducati brand only sort price-a pag 2', url: 'https://www.moto.it/moto-usate/ricerca/pagina-2?brand=ducati&sort=price-a' },
    { label: 'Ducati Monster 1100 sort price-a', url: 'https://www.moto.it/moto-usate/ricerca?brand=ducati&model=ducati%7Cmonster-1100&sort=price-a' },
    { label: 'Honda Africa Twin filtri utente', url: 'https://www.moto.it/moto-usate/ricerca?brand=honda&model=honda%7Cafrica-twin-crf-1000l&price_f=5000&price_t=15000&km_t=40000&sort=price-a' },
  ];

  for (const { label, url } of urls) {
    console.log(`\n=== ${label} ===`);
    console.log(`URL: ${url}`);
    await pg.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
    await new Promise(r=>setTimeout(r,2000));

    const data = await pg.evaluate(() => {
      const total = (document.body.innerText.match(/(\d[\d.]*)\s+annunci/i) || [])[1] || null;
      // Estrai tutte le card .mcard--big e prova vari selettori
      const cards = Array.from(document.querySelectorAll('.mcard--big')).slice(0, 5).map(c => {
        const html = c.outerHTML;
        // Estrai testo pulito
        const title = c.querySelector('h2, h3, .mcard-title, [class*="title"]')?.innerText?.trim() || null;
        const price = c.querySelector('[class*="price"], [class*="prezzo"]')?.innerText?.trim() || null;
        const link = c.querySelector('a[href]')?.getAttribute('href') || null;
        // Cerca anno, km, cilindrata tramite span/li/div
        const allText = c.innerText.replace(/\n+/g, ' | ').trim();
        // Ricerca pattern anno (4 cifre 19xx|20xx) e km
        const anno = (allText.match(/\b(19\d{2}|20\d{2})\b/) || [])[0] || null;
        const km = (allText.match(/([\d.]+)\s*km/i) || [])[0] || null;
        const cc = (allText.match(/([\d.]+)\s*cc/i) || [])[0] || null;
        // Città: spesso nelle card c'è una loc
        // Cerca tutti gli span/div brevi
        const labels = Array.from(c.querySelectorAll('span, div, li, p'))
          .map(e => (e.innerText||'').trim())
          .filter(t => t.length > 0 && t.length < 50)
          .slice(0, 15);
        return { title, price, link, anno, km, cc, allText: allText.slice(0,200), labels: labels.slice(0,10) };
      });
      return { total, cards };
    });

    console.log(`Totale annunci: ${data.total}`);
    data.cards.forEach((c, i) => {
      console.log(`\n  [${i}] title: "${c.title}"`);
      console.log(`      price: ${c.price}`);
      console.log(`      anno: ${c.anno} | km: ${c.km} | cc: ${c.cc}`);
      console.log(`      link: ${c.link}`);
      console.log(`      text: "${c.allText}"`);
      console.log(`      labels: ${JSON.stringify(c.labels)}`);
    });
  }

  await browser.close();
})().catch(e => console.error(e));
