/**
 * 5 test moto: tool vs Subito reale + AS24 reale (Playwright headed).
 * Per ogni test legge server.log per estrarre gli URL effettivi usati dal tool,
 * poi apre Chrome VISIBILE sugli stessi URL e confronta per URL set.
 *
 * Uso: node scripts/compare_moto_5.js
 */

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

const SERVER_LOG = 'E:/tmp/server.log';

const TESTS = [
  { label: 'Honda Hornet ≤3000€',                        marca: 'Honda',    modello: 'Hornet',       prezzoMax: 3000 },
  { label: 'Yamaha MT-07 ≤6000€ anno≥2015',              marca: 'Yamaha',   modello: 'MT-07',        prezzoMax: 6000, annoMin: 2015 },
  { label: 'Ducati Monster 1100 ≤5000€',                 marca: 'Ducati',   modello: 'Monster 1100', prezzoMax: 5000 },
  { label: 'Kawasaki Versys 650 ≤4500€ anno≥2010',       marca: 'Kawasaki', modello: 'Versys 650',   prezzoMax: 4500, annoMin: 2010 },
  { label: 'Piaggio Beverly 300 ≤3500€',                 marca: 'Piaggio',  modello: 'Beverly 300',  prezzoMax: 3500 },
];

function buildQS(t) {
  const qs = new URLSearchParams({ tipo: 'moto', marca: t.marca, modello: t.modello });
  if (t.prezzoMax != null) qs.set('prezzoMax', t.prezzoMax);
  if (t.annoMin   != null) qs.set('annoMin',   t.annoMin);
  if (t.kmMax     != null) qs.set('kmMax',     t.kmMax);
  return qs.toString();
}

async function fetchTool(t) {
  const res = await fetch(`http://localhost:3000/api/search?${buildQS(t)}`);
  const d   = await res.json();
  return d.risultati || [];
}

async function fetchSubito(browser, url) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT', viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const json = await page.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
    if (!json) return [];
    const data = JSON.parse(json);
    const list = data?.props?.pageProps?.initialState?.items?.list || [];
    return list.map(e => {
      const it = e?.item;
      if (!it || it.kind !== 'AdItem') return null;
      return { titolo: it.subject, url: it.urls?.default, prezzo: Number(it.features?.['/price']?.values?.[0]?.key) };
    }).filter(Boolean);
  } finally { await ctx.close(); }
}

async function fetchAS24(browser, url) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT', viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (resp && resp.status() === 404) return [];
    const json = await page.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
    if (!json) return [];
    const data = JSON.parse(json);
    const listings = data?.props?.pageProps?.listings || [];
    return listings.map(it => ({
      titolo: `${it.vehicle?.make || ''} ${it.vehicle?.modelVersionInput || it.vehicle?.model || ''}`.trim(),
      prezzo: it.price?.priceFormatted,
      url:    `https://www.autoscout24.it${it.url}`,
    }));
  } finally { await ctx.close(); }
}

function extractUrlsFromLog(logChunk) {
  const subito = logChunk.match(/\[Subito-PW\] Pagina 1: (.+)/)?.[1]?.trim();
  const as24Match = logChunk.match(/\[AS24-PW\] Fetching \d+ pagine: (.+)/);
  const as24First = as24Match?.[1]?.trim();
  return { subito, as24First };
}

function setFromUrls(arr) { return new Set(arr.map(r => r.url)); }

async function main() {
  console.log('Avvio Chrome visibile per confronti…\n');
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const report = [];
  for (const t of TESTS) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`TEST: ${t.label}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const logPosStart = fs.existsSync(SERVER_LOG) ? fs.statSync(SERVER_LOG).size : 0;
    const toolStart   = Date.now();
    const toolRes     = await fetchTool(t);
    const toolMs      = Date.now() - toolStart;

    await new Promise(r => setTimeout(r, 500));
    const fullLog   = fs.readFileSync(SERVER_LOG, 'utf8');
    const newLog    = fullLog.slice(logPosStart);
    const urls      = extractUrlsFromLog(newLog);

    const subitoTool = toolRes.filter(r => r.fonte === 'subito');
    const as24Tool   = toolRes.filter(r => r.fonte === 'autoscout');
    const motoTool   = toolRes.filter(r => r.fonte === 'moto');

    console.log(`Tool: ${toolRes.length} totali (Subito=${subitoTool.length}, AS24=${as24Tool.length}, Moto.it=${motoTool.length}) — ${toolMs}ms`);
    console.log(`URL Subito tool:  ${urls.subito || '(n/a)'}`);
    console.log(`URL AS24 tool:    ${urls.as24First || '(n/a)'}`);

    // Confronto Subito: fetch pag1 + pag2 (stessa paginazione del tool)
    let subitoReal = [];
    if (urls.subito) {
      const u1 = urls.subito;
      const u2 = u1.includes('o=2') ? u1 : u1 + (u1.includes('?') ? '&' : '?') + 'o=2';
      // Il tool usa o=N per pagina > 1; ricostruiamo
      const base = u1.replace(/&?o=\d+/, '');
      const page1 = await fetchSubito(browser, base);
      const page2 = await fetchSubito(browser, base + (base.includes('?') ? '&' : '?') + 'o=2');
      const seen = new Set();
      subitoReal = [...page1, ...page2].filter(r => {
        if (!r.url || seen.has(r.url)) return false;
        seen.add(r.url); return true;
      });
    }

    // Confronto AS24: 4 pagine
    let as24Real = [];
    if (urls.as24First) {
      const base = urls.as24First.replace(/&page=\d+/, '');
      for (let p = 1; p <= 4; p++) {
        const u = p === 1 ? base : base + (base.includes('?') ? '&' : '?') + 'page=' + p;
        const items = await fetchAS24(browser, u);
        as24Real.push(...items);
      }
    }

    const toolSubUrls = setFromUrls(subitoTool);
    const realSubUrls = setFromUrls(subitoReal);
    const toolAsUrls  = setFromUrls(as24Tool);
    const realAsUrls  = setFromUrls(as24Real);

    const subInRealNotTool = [...realSubUrls].filter(u => !toolSubUrls.has(u));
    const subInToolNotReal = [...toolSubUrls].filter(u => !realSubUrls.has(u));
    const asInRealNotTool  = [...realAsUrls ].filter(u => !toolAsUrls.has(u));
    const asInToolNotReal  = [...toolAsUrls ].filter(u => !realAsUrls.has(u));

    const intersect = (a, b) => [...a].filter(u => b.has(u)).length;
    const subMatch = realSubUrls.size === 0 ? '—' : `${intersect(toolSubUrls, realSubUrls)}/${Math.max(toolSubUrls.size, realSubUrls.size)}`;
    const asMatch  = realAsUrls.size  === 0 ? '—' : `${intersect(toolAsUrls,  realAsUrls)}/${Math.max(toolAsUrls.size,  realAsUrls.size)}`;

    console.log(`\n── Subito: tool=${subitoTool.length}, reale=${subitoReal.length}, match=${subMatch}, solo-reale=${subInRealNotTool.length}, solo-tool=${subInToolNotReal.length}`);
    console.log(`── AS24:   tool=${as24Tool.length}, reale=${as24Real.length}, match=${asMatch}, solo-reale=${asInRealNotTool.length}, solo-tool=${asInToolNotReal.length}`);

    if (subInRealNotTool.length) {
      console.log('   Primi mancanti Subito (nel tool):');
      subInRealNotTool.slice(0,3).forEach(u => {
        const r = subitoReal.find(x=>x.url===u);
        console.log(`     ${String(r.prezzo).padStart(5)} ${(r.titolo||'').slice(0,50)}`);
      });
    }
    if (asInRealNotTool.length) {
      console.log('   Primi mancanti AS24 (nel tool):');
      asInRealNotTool.slice(0,3).forEach(u => {
        const r = as24Real.find(x=>x.url===u);
        console.log(`     ${String(r.prezzo).padStart(8)} ${(r.titolo||'').slice(0,50)}`);
      });
    }

    report.push({
      label: t.label,
      tool: { total: toolRes.length, subito: subitoTool.length, as24: as24Tool.length, motoit: motoTool.length },
      subMatch, asMatch,
      subMissing: subInRealNotTool.length, asMissing: asInRealNotTool.length,
    });
  }

  await browser.close();

  console.log('\n\n════════════ RIEPILOGO ════════════');
  report.forEach((r,i) => {
    console.log(`${i+1}. ${r.label}`);
    console.log(`   Tool: ${r.tool.total} (sub=${r.tool.subito}, as=${r.tool.as24}, moto=${r.tool.motoit})`);
    console.log(`   Subito match: ${r.subMatch} (mancanti=${r.subMissing})`);
    console.log(`   AS24 match:   ${r.asMatch} (mancanti=${r.asMissing})`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
