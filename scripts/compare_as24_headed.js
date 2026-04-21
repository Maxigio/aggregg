/**
 * Apre Chrome VISIBILE (non headless) sull'URL AS24 che usa il tool,
 * estrae __NEXT_DATA__ e stampa i primi 20 annunci + conteggio totale.
 * Poi confronta con l'output del tool locale.
 *
 * Uso: node scripts/compare_as24_headed.js
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

const TOOL_URL = 'http://localhost:3000/api/search?tipo=auto&marca=Fiat&modello=Panda&prezzoMax=4000';
const AS24_BASE = 'https://www.autoscout24.it/lst?cy=I&sort=price&desc=0&priceto=4000&atype=C&mmmv=28|1746||';
const NUM_PAGES = 4;

async function fetchTool() {
  const res = await fetch(TOOL_URL);
  const d   = await res.json();
  return d.risultati.filter(r => r.fonte === 'autoscout');
}

async function fetchAS24Page(browser, url) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const json = await page.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
  if (!json) { await ctx.close(); return { total: 0, items: [] }; }
  await ctx.close();
  const data = JSON.parse(json);
  const listings = data?.props?.pageProps?.listings;
  if (!Array.isArray(listings)) return { total: 0, items: [] };
  const items = listings.map(it => ({
    titolo: `${it.vehicle?.make || ''} ${it.vehicle?.modelVersionInput || it.vehicle?.modelGroup || it.vehicle?.model || ''}`.trim(),
    prezzo: it.price?.priceFormatted,
    url: `https://www.autoscout24.it${it.url}`,
  }));
  return { total: data?.props?.pageProps?.numberOfResults || null, items };
}

async function main() {
  console.log('→ Fetching tool output…');
  const toolItems = await fetchTool();
  console.log(`  Tool AS24: ${toolItems.length} annunci`);

  console.log('\n→ Aprendo Chrome VISIBILE su AS24…');
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const allReal = [];
  let numResultsReal = null;
  for (let p = 1; p <= NUM_PAGES; p++) {
    const url = p === 1 ? AS24_BASE : `${AS24_BASE}&page=${p}`;
    console.log(`  Pagina ${p}: ${url}`);
    const { total, items } = await fetchAS24Page(browser, url);
    if (p === 1) numResultsReal = total;
    console.log(`    → ${items.length} annunci`);
    allReal.push(...items);
  }

  await browser.close();

  const toolUrls = new Set(toolItems.map(r => r.url));
  const realUrls = new Set(allReal.map(r => r.url));

  const inRealNotTool = [...realUrls].filter(u => !toolUrls.has(u));
  const inToolNotReal = [...toolUrls].filter(u => !realUrls.has(u));

  console.log('\n═══ CONFRONTO ═══');
  console.log(`AS24 reale numberOfResults (pag1): ${numResultsReal}`);
  console.log(`AS24 reale (${NUM_PAGES} pagine): ${allReal.length} annunci`);
  console.log(`Tool AS24:                         ${toolItems.length} annunci`);
  console.log(`In reale ma NON in tool: ${inRealNotTool.length}`);
  console.log(`In tool ma NON in reale: ${inToolNotReal.length}`);

  console.log('\n── Primi 20 di AS24 reale (priceasc) ──');
  allReal.slice(0, 20).forEach((r, i) => {
    const mark = toolUrls.has(r.url) ? '✓' : '✗';
    console.log(` ${String(i+1).padStart(2)} ${mark} ${String(r.prezzo).padEnd(10)} ${r.titolo.slice(0, 40).padEnd(40)} ${r.url.slice(0, 80)}`);
  });

  if (inRealNotTool.length > 0) {
    console.log('\n── Mancanti nel tool (sono su AS24 reale) ──');
    inRealNotTool.slice(0, 10).forEach(u => {
      const r = allReal.find(x => x.url === u);
      console.log(` ${String(r.prezzo).padEnd(10)} ${r.titolo.slice(0, 40).padEnd(40)} ${u}`);
    });
  }

  if (inToolNotReal.length > 0) {
    console.log('\n── Presenti nel tool ma NON in reale ──');
    inToolNotReal.slice(0, 10).forEach(u => {
      const r = toolItems.find(x => x.url === u);
      console.log(` ${String(r.prezzo).padEnd(6)} ${(r.titolo||'').slice(0, 40).padEnd(40)} ${u}`);
    });
  }

  fs.writeFileSync('E:/tmp/as24_real.json', JSON.stringify(allReal, null, 2));
  fs.writeFileSync('E:/tmp/as24_tool.json', JSON.stringify(toolItems, null, 2));
  console.log('\nSalvato in E:/tmp/as24_real.json e E:/tmp/as24_tool.json');
}

main().catch(e => { console.error(e); process.exit(1); });
