/**
 * Indaga Ducati Diavel V4 ≥5000€:
 * - Subito: confronta tool con sito reale (primi 60)
 * - AS24: scopri il mmmv corretto per Diavel V4 navigando la pagina marca Ducati
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

async function main() {
  const toolRes = JSON.parse(fs.readFileSync('E:/tmp/diavel_tool.json','utf8'));
  const toolSubUrls = new Set(toolRes.risultati.filter(r=>r.fonte==='subito').map(r=>r.url));

  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // ── SUBITO: fetch 2 pagine (come fa il tool) ──
  console.log('\n=== SUBITO ===');
  const subitoBase = 'https://www.subito.it/annunci-italia/vendita/moto-e-scooter/?order=priceasc&bb=000040&bm=005061&ps=5000';
  async function fetchSubitoPage(url) {
    const ctx = await browser.newContext({ locale:'it-IT', viewport:{width:1280,height:900} });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      const json = await page.$eval('#__NEXT_DATA__', el => el.textContent);
      const data = JSON.parse(json);
      const list = data?.props?.pageProps?.initialState?.items?.list || [];
      const total = data?.props?.pageProps?.initialState?.items?.total;
      const items = list.map(e => {
        const it = e?.item;
        if (!it || it.kind !== 'AdItem') return null;
        return { titolo: it.subject, url: it.urls?.default, prezzo: Number(it.features?.['/price']?.values?.[0]?.key) };
      }).filter(Boolean);
      return { items, total };
    } finally { await ctx.close(); }
  }
  const { items: p1, total } = await fetchSubitoPage(subitoBase);
  const { items: p2 }        = await fetchSubitoPage(subitoBase + '&o=2');
  const seen = new Set();
  const realSub = [...p1, ...p2].filter(r => r.url && !seen.has(r.url) && seen.add(r.url));
  console.log(`Subito reale (2 pagine): ${realSub.length}, total pretended:`, total);
  console.log(`Tool Subito: ${toolSubUrls.size}`);
  const realSubUrls = new Set(realSub.map(r=>r.url));
  const onlyReal = [...realSubUrls].filter(u => !toolSubUrls.has(u));
  const onlyTool = [...toolSubUrls].filter(u => !realSubUrls.has(u));
  console.log(`Solo reale (mancanti tool): ${onlyReal.length}`);
  console.log(`Solo tool (extra): ${onlyTool.length}`);
  if (onlyReal.length) {
    console.log('\nPrimi 10 Subito mancanti nel tool:');
    onlyReal.slice(0,10).forEach(u => {
      const r = realSub.find(x=>x.url===u);
      console.log(' ', String(r.prezzo).padStart(6), (r.titolo||'').slice(0,50), u);
    });
  }

  // ── AS24: trova mmmv per Diavel V4 navigando ──
  console.log('\n=== AS24 ===');
  // Prima: pagina Ducati senza submodello, per capire quanti annunci ha Diavel V4
  const ctx2 = await browser.newContext({ locale:'it-IT', viewport:{width:1280,height:900} });
  const pg2 = await ctx2.newPage();
  try {
    // Strategia: usa l'URL form-builder di AS24 con mv=70147 (Diavel) e cerca una version/submodel
    // Ma più sicuro: apro la pagina con modello Diavel e leggo le modelVersion disponibili
    const asUrl = 'https://www.autoscout24.it/lst?cy=I&sort=price&desc=0&pricefrom=5000&atype=B&mmmv=50030|70147||';
    console.log('URL AS24 (Diavel brand, senza V4 specifico):', asUrl);
    await pg2.goto(asUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const nextJson = await pg2.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
    if (nextJson) {
      const d = JSON.parse(nextJson);
      const listings = d?.props?.pageProps?.listings || [];
      console.log(`Totale listings su AS24 per Ducati Diavel ≥5000€: ${d?.props?.pageProps?.numberOfResults}`);
      console.log('Primi 20 titoli (cerca "V4"):');
      listings.slice(0, 20).forEach((it, i) => {
        const title = [it.vehicle?.make, it.vehicle?.modelVersionInput || it.vehicle?.model].filter(Boolean).join(' ');
        const mv = it.vehicle?.modelVersionInput || '';
        const v4 = /v4/i.test(title) ? '✓V4' : '   ';
        console.log(' ', String(i+1).padStart(2), v4, String(it.price?.priceFormatted).padStart(10), title.slice(0, 60));
      });

      // Cerca dei filtri disponibili / modelVersions per capire il mmmv esatto
      const aggregations = d?.props?.pageProps?.aggregations || d?.props?.pageProps?.searchMetadata || {};
      const versionKeys = Object.keys(aggregations).filter(k => /version/i.test(k));
      console.log('\nAggregation keys (filtro version):', versionKeys);
      if (versionKeys.length) {
        for (const k of versionKeys) {
          const val = aggregations[k];
          if (Array.isArray(val)) {
            console.log(`  ${k}:`, val.slice(0,10).map(v => ({ key: v.key || v.id || v.value, count: v.count || v.doc_count, label: v.label || v.name })));
          }
        }
      }
    }
  } finally { await ctx2.close(); }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
