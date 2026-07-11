'use strict';
// Fonte eBay.it per i ricambi — SCRAPE-BRIDGE in attesa delle chiavi API ufficiali (apply inviata).
// Modulo isolato: quando arrivano le chiavi, lo swap con l'API Browse è drop-in (stesso shape).
//
// Anti-bot (PROVATO col probe 2026-07-11): l'item/search a freddo → 403, ma con un WARM-UP della
// homepage (cookie di sessione) tutto risponde 200. Quindi: context persistente + warm-up 1 volta.
// Riusa il Chrome singleton di oem-lookup (stesso stack stealth di Autodoc/CMSNL).
const { getBrowser } = require('./oem-lookup');
const logger = require('./logger');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_ITEMS = 10;

// I titoli della serp includono il testo di accessibilità del link. Pura.
const cleanEbayTitle = t => String(t || '')
  .replace(/viene aperta una nuova finestra o scheda/gi, '')
  .replace(/si apre in una nuova finestra o scheda/gi, '')
  .replace(/opens in a new window or tab/gi, '')
  .replace(/\s+/g, ' ').trim();

// "EUR 50,00" / "EUR 1.234,56" → numero. Pura (testabile).
function parsePrezzoEur(s) {
  const m = String(s || '').match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/\./g, '') + '.' + (m[2] || '00'));
  return isFinite(n) ? n : null;
}

// Placeholder pubblicitari nella serp ("Shop on eBay", url finto ebay.com/itm/123456).
const isPlaceholder = (titolo, url) => /shop on ebay/i.test(titolo || '') || /ebay\.com\/itm\/123456/.test(url || '');

// Righe del pannello acquisto che NON sono dati tecnici (spedizione/consegna/resi/pagamenti…). Pura.
const isJunkSpec = k => /spedizion|consegna|restituzion|pagament|garanzia clienti|vedi i veicoli|oggetto che si trova/i.test(String(k || ''));

// Le Item specifics arrivano nella LINGUA DEL VENDITORE (annuncio tedesco → "Hersteller").
// Mappa sinonimi DE/EN → etichetta italiana; chiave ignota chiaramente straniera → scartata. Pura.
const SPEC_IT = new Map(Object.entries({
  'hersteller': 'Marca', 'marke': 'Marca', 'brand': 'Marca', 'manufacturer': 'Marca', 'marca': 'Marca',
  'herstellernummer': 'Codice produttore', 'manufacturer part number': 'Codice produttore', 'mpn': 'Codice produttore',
  'numero di parte del produttore': 'Codice produttore', 'numero parte produttore': 'Codice produttore',
  'oe/oem referenznummer(n)': 'Numero OEM', 'oe-oem referenznummer(n)': 'Numero OEM', 'oe/oem part number': 'Numero OEM',
  'numero ricambio oem': 'Numero OEM', 'numero oem': 'Numero OEM', 'oem': 'Numero OEM',
  'ean': 'EAN', 'gtin': 'EAN',
  'farbe': 'Colore', 'colour': 'Colore', 'color': 'Colore', 'colore': 'Colore',
  'material': 'Materiale', 'materiale': 'Materiale',
  'einbauposition': 'Posizione', 'placement on vehicle': 'Posizione', 'posizione sul veicolo': 'Posizione', 'lato di montaggio': 'Posizione',
  'zustand': 'Condizione', 'condition': 'Condizione', 'condizione': 'Condizione',
  'oberfläche': 'Finitura', 'surface finish': 'Finitura',
  'produktart': 'Tipo', 'product type': 'Tipo', 'tipo': 'Tipo',
}));
function normalizzaSpec(k) {
  const key = String(k || '').replace(/:$/, '').trim();
  if (!key) return null;
  const hit = SPEC_IT.get(key.toLowerCase());
  if (hit) return hit;
  // ignota: tienila solo se plausibilmente italiana/neutra; scarta il lessico straniero evidente
  if (/[äöüßÄÖÜ]/.test(key)) return null;
  if (/\b(number|width|height|length|weight|type|size|fitment|part|color|side)\b/i.test(key)) return null;
  return key;
}

// Context persistente con warm-up (la sessione amortizza il 403 a freddo). Si ricrea se il browser cade.
let _ctx = null, _warm = false;
async function getCtx() {
  const browser = await getBrowser();
  if (_ctx) { try { _ctx.pages(); return _ctx; } catch { _ctx = null; _warm = false; } }
  _ctx = await browser.newContext({ userAgent: UA, locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  return _ctx;
}
async function warmup(page) {
  if (_warm) return;
  await page.goto('https://www.ebay.it/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  _warm = true;
}

// searchEbay('34218526568') → [{fonte:'ebay', nome, prezzo, valuta, immagine, url}]
async function searchEbay(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const ctx = await getCtx();
  const page = await ctx.newPage();
  try {
    await warmup(page);
    const resp = await page.goto(`https://www.ebay.it/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=0`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (resp && resp.status() === 403) { _warm = false; throw new Error('eBay 403 (serp)'); }
    await page.waitForTimeout(3000);
    const raw = await page.evaluate(() => {
      return [...document.querySelectorAll('.s-item, li.s-card, [data-viewport] .s-card')].slice(0, 25).map(it => {
        const t = it.querySelector('.s-item__title, .s-card__title')?.textContent?.replace(/\s+/g, ' ').trim() || null;
        const p = it.querySelector('.s-item__price, .s-card__price')?.textContent?.trim() || null;
        const u = it.querySelector('a[href*="/itm/"]')?.href?.split('?')[0] || null;
        const img = it.querySelector('img')?.src || null;
        return { t, p, u, img };
      });
    });
    return raw
      .filter(r => r.t && r.u && !isPlaceholder(r.t, r.u))
      .slice(0, MAX_ITEMS)
      .map(r => ({
        fonte: 'ebay',
        nome: cleanEbayTitle(r.t),
        prezzo: parsePrezzoEur(r.p),
        valuta: 'EUR',
        immagine: (r.img && /ebayimg/.test(r.img)) ? r.img : null,
        url: r.u,
      }));
  } finally {
    await page.close().catch(() => {});
  }
}

// fetchEbayItemSpecs(url) → { specs: {k:v,...}, immagine } dalla pagina item ("Item specifics").
async function fetchEbayItemSpecs(url) {
  const u = String(url || '');
  if (!/^https:\/\/www\.ebay\.\w+\/itm\//.test(u)) return { specs: {}, immagine: null };
  const ctx = await getCtx();
  const page = await ctx.newPage();
  try {
    await warmup(page);
    const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (resp && resp.status() === 403) { _warm = false; throw new Error('eBay 403 (item)'); }
    await page.waitForTimeout(2500);
    const raw = await page.evaluate(() => {
      const txt = el => el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
      const pairs = [];
      for (const l of document.querySelectorAll('.ux-labels-values')) {
        const k = txt(l.querySelector('.ux-labels-values__labels'));
        const v = txt(l.querySelector('.ux-labels-values__values'));
        if (k && v) pairs.push([k, v]);
      }
      const og = document.querySelector('meta[property="og:image"]')?.content || null;
      const hi = [...document.querySelectorAll('img[src*="ebayimg"]')].map(i => i.src).find(s => /s-l(9|1[0-9])\d\d/.test(s)) || null;
      return { pairs, immagine: og || hi };
    });
    const specs = {};
    for (const [k, v] of raw.pairs) {   // via spedizione/consegna/resi + chiavi tradotte in italiano
      if (isJunkSpec(k) || isJunkSpec(v)) continue;
      const kIt = normalizzaSpec(k);
      if (kIt && !(kIt in specs) && Object.keys(specs).length < 10) specs[kIt] = v;
    }
    return { specs, immagine: raw.immagine };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { searchEbay, fetchEbayItemSpecs, parsePrezzoEur, isPlaceholder, isJunkSpec, normalizzaSpec, cleanEbayTitle };

// self-check manuale: `node backend/ebay-scrape.js 34218526568`
if (require.main === module) {
  const { closeBrowser } = require('./oem-lookup');
  searchEbay(process.argv[2] || '34218526568')
    .then(r => { console.log(JSON.stringify(r, null, 2)); return closeBrowser(); })
    .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
