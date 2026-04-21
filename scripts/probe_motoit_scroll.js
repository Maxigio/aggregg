/**
 * Scroll + interazioni su Moto.it per catturare lazy-load / infinite scroll / bottoni.
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

  const xhrs = [];
  pg.on('response', async resp => {
    const rt = resp.request().resourceType();
    if (rt !== 'xhr' && rt !== 'fetch') return;
    const u = resp.url();
    if (/google|doubleclick|publytics|iubenda|tncid|analytics|adsbygoogle|ads/.test(u)) return;
    xhrs.push({ status: resp.status(), url: u, method: resp.request().method() });
  });

  const URL_BASE = 'https://www.moto.it/moto-usate/ducati';
  await pg.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000)); // assorbe render iniziale
  let count0 = await pg.evaluate(() => document.querySelectorAll('.mcard--big').length);
  console.log(`Inizio: ${count0} card, XHR raccolte: ${xhrs.length}`);

  // Scroll fino in fondo, 10 volte, con pausa per permettere lazy-load
  for (let i = 1; i <= 10; i++) {
    await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 1200));
    const c = await pg.evaluate(() => document.querySelectorAll('.mcard--big').length);
    if (c !== count0) console.log(`  scroll ${i}: count=${c} (cambiato!)`);
    count0 = c;
  }
  console.log(`Dopo 10 scroll: ${count0} card, XHR totali: ${xhrs.length}`);

  // Enumera bottoni con testo "successivo", "carica", "altri", "next", ecc
  const buttons = await pg.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const re  = /(successiv|pagin|carica|altri|mostra|load|next|more)/i;
    return all.filter(el => re.test(el.textContent || el.ariaLabel || ''))
      .slice(0, 15)
      .map(el => ({
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 60),
        href: el.getAttribute?.('href') || null,
        aria: el.getAttribute?.('aria-label') || null,
      }));
  });
  console.log('\nBottoni/link con keyword paginazione:');
  buttons.forEach(b => console.log(' ', JSON.stringify(b)));

  // Ispeziona il DOM del primo pulsante/link "successivo" e cliccaci
  const nextSelector = await pg.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const match = all.find(el => /successiv|next|pagina 2/i.test(el.textContent || el.ariaLabel || ''));
    if (!match) return null;
    // Genera un selettore semplice
    const id = match.id;
    if (id) return '#' + id;
    return null; // lascia gestire a Playwright con locator
  });

  // Try to click "next" via Playwright locator
  try {
    const nextLoc = pg.locator('a:has-text("Successiva"), a:has-text("Successivo"), button:has-text("Successiva"), button:has-text("Carica altri"), a[aria-label*="succ" i]').first();
    if (await nextLoc.count() > 0) {
      console.log('\nClicco link "successivo"...');
      const preCount = count0;
      const preXhr = xhrs.length;
      await nextLoc.click({ timeout: 5000 });
      await new Promise(r => setTimeout(r, 3000));
      const postCount = await pg.evaluate(() => document.querySelectorAll('.mcard--big').length);
      console.log(`  card prima=${preCount}, dopo=${postCount}, XHR nuove=${xhrs.length - preXhr}`);
      console.log(`  URL corrente: ${pg.url()}`);
    } else {
      console.log('\nNessun link "successivo" trovato.');
    }
  } catch (e) {
    console.log('\nClick next failed:', e.message);
  }

  console.log(`\nXHR non-analytics registrate durante sessione (${xhrs.length}):`);
  xhrs.slice(0, 20).forEach(x => console.log(` ${x.method} [${x.status}] ${x.url}`));

  await ctx.close();
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
