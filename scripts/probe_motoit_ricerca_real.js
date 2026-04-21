/**
 * Investiga il vero motore di ricerca /moto-usate/ricerca trovato dall'utente.
 * Verifica: conteggio annunci, paginazione, ordinamenti, filtri funzionanti.
 */
const { chromium } = require('playwright');
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

async function countAds(pg, url) {
  await pg.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,2000));
  return await pg.evaluate(() => {
    const cards = document.querySelectorAll('.mcard--big').length;
    const allCards = document.querySelectorAll('[class*="mcard"]').length;
    // Cerca testo "X annunci" / "X risultati"
    const txt = document.body.textContent;
    const m = txt.match(/(\d[\d.\s]*)\s*(annunci|risultati|moto)/i);
    const total = m ? m[1].replace(/[\s.]/g,'') : null;
    // Cerca link paginazione
    const pageLinks = Array.from(document.querySelectorAll('a[href*="off="], a[href*="page="]'))
      .map(a => a.getAttribute('href')).slice(0,5);
    // Cerca select sort
    const selects = Array.from(document.querySelectorAll('select')).map(s => ({
      name: s.name, id: s.id,
      opts: Array.from(s.options).map(o => ({ v: o.value, l: o.textContent.trim().slice(0,30) })),
    }));
    return { cards, allCards, total, pageLinks, selects };
  });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: true,
  });
  const pg = await browser.newPage();

  // Test 1: URL completo come fornito dall'utente
  const URL_USER = 'https://www.moto.it/moto-usate/ricerca?brand=honda&model=honda%7Cafrica-twin-crf-1000l&price_f=5000&price_t=15000&km_t=40000&sort=year-a';
  console.log('=== TEST 1: URL filtro utente (Honda Africa Twin 5-15k, km<40k) ===');
  const r1 = await countAds(pg, URL_USER);
  console.log(`Cards visibili: ${r1.cards} | tutte: ${r1.allCards} | totale dichiarato: ${r1.total}`);
  console.log('Select trovati:', r1.selects.length);
  r1.selects.forEach(s => console.log(`  ${s.name||s.id}: ${s.opts.slice(0,10).map(o=>o.v).join(', ')}`));
  console.log('Link paginazione:', r1.pageLinks);

  // Test 2: solo marca + sort price ascendente
  console.log('\n=== TEST 2: ducati, sort price-a ===');
  const r2 = await countAds(pg, 'https://www.moto.it/moto-usate/ricerca?brand=ducati&sort=price-a');
  console.log(`Cards: ${r2.cards} | totale dichiarato: ${r2.total}`);
  console.log('Link pag:', r2.pageLinks);

  // Test 3: paginazione via off=N
  console.log('\n=== TEST 3: ducati off=20 ===');
  const r3 = await countAds(pg, 'https://www.moto.it/moto-usate/ricerca?brand=ducati&sort=price-a&off=20');
  console.log(`Cards: ${r3.cards} | totale dichiarato: ${r3.total}`);

  // Test 4: Estrai dettaglio delle card in una pagina (per capire formato dati)
  console.log('\n=== TEST 4: dettaglio cards ducati sort price-a ===');
  await pg.goto('https://www.moto.it/moto-usate/ricerca?brand=ducati&sort=price-a', { waitUntil:'domcontentloaded', timeout:30000 });
  await new Promise(r=>setTimeout(r,2500));
  const detail = await pg.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.mcard--big')).slice(0,5);
    return cards.map(c => {
      const title = c.querySelector('h2, h3, .mcard-title, [class*="title"]')?.textContent?.trim().slice(0,80) || null;
      const price = c.querySelector('[class*="price"], [class*="prezzo"]')?.textContent?.trim().slice(0,30) || null;
      const link = c.querySelector('a[href]')?.getAttribute('href') || null;
      const imgs = c.querySelectorAll('img').length;
      return { title, price, link, imgs, html: c.outerHTML.slice(0, 200) };
    });
  });
  detail.forEach((d,i) => {
    console.log(`\n[${i}] title: ${d.title}`);
    console.log(`    price: ${d.price}`);
    console.log(`    link: ${d.link}`);
  });

  // Test 5: quanti annunci totali Ducati? Prova paginazione profonda
  console.log('\n=== TEST 5: pagina profonda (off=100) ===');
  const r5 = await countAds(pg, 'https://www.moto.it/moto-usate/ricerca?brand=ducati&sort=price-a&off=100');
  console.log(`Cards: ${r5.cards} | totale: ${r5.total}`);

  // Test 6: ordinamenti validi? prova valori comuni
  console.log('\n=== TEST 6: ordinamenti ===');
  for (const s of ['price-a','price-d','year-a','year-d','km-a','km-d']) {
    const r = await countAds(pg, `https://www.moto.it/moto-usate/ricerca?brand=ducati&sort=${s}`);
    const firstCard = await pg.evaluate(() => {
      const c = document.querySelector('.mcard--big');
      return c ? {
        title: c.querySelector('h2, h3, [class*="title"]')?.textContent?.trim().slice(0,60),
        price: c.querySelector('[class*="price"]')?.textContent?.trim().slice(0,20),
      } : null;
    });
    console.log(`  sort=${s}: cards=${r.cards} totale=${r.total} primo=${JSON.stringify(firstCard)}`);
  }

  await browser.close();
})().catch(e => console.error(e));
