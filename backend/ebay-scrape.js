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
/**
 * SOLO EURO, e scritto all'italiana. Qui serve eBay.it: un importo in dollari o in sterline
 * non e' un prezzo da convertire a occhio, ed e' anche formattato al contrario — provato,
 * "US $1,234.56" con questa lettura diventava 1,23, e usciva marcato "EUR". Meglio nessun
 * prezzo che un prezzo di mille volte sbagliato nella valuta sbagliata.
 */
const ALTRA_VALUTA = /(\$|£|\bUSD\b|\bGBP\b|\bCHF\b)/i;
function parsePrezzoEur(s) {
  const t = String(s || '');
  if (ALTRA_VALUTA.test(t)) return null;
  const m = t.match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/\./g, '') + '.' + (m[2] || '00'));
  return isFinite(n) ? n : null;
}

// Placeholder pubblicitari nella serp ("Shop on eBay", url finto ebay.com/itm/123456).
const isPlaceholder = (titolo, url) => /shop on ebay/i.test(titolo || '') || /ebay\.com\/itm\/123456/.test(url || '');

// Righe del pannello acquisto che NON sono dati tecnici (spedizione/consegna/resi/pagamenti…). Pura.
const isJunkSpec = k => /spedizion|consegna|restituzion|pagament|garanzia clienti|vedi i veicoli|oggetto che si trova/i.test(String(k || ''));

// Le Item specifics arrivano nella LINGUA DEL VENDITORE (annuncio tedesco → "Hersteller").
// WHITELIST: solo le chiavi che sappiamo mappare in italiano; ogni altra (incl. tedesco senza
// umlaut tipo "Lieferumfang") → scartata → zero label straniere residue nella scheda. Pura.
const SPEC_IT = new Map(Object.entries({
  'hersteller': 'Marca', 'marke': 'Marca', 'brand': 'Marca', 'manufacturer': 'Marca', 'marca': 'Marca',
  'herstellernummer': 'Codice produttore', 'manufacturer part number': 'Codice produttore', 'mpn': 'Codice produttore',
  'numero di parte del produttore': 'Codice produttore', 'numero parte produttore': 'Codice produttore',
  'oe/oem referenznummer(n)': 'Numero OEM', 'oe-oem referenznummer(n)': 'Numero OEM', 'oe/oem part number': 'Numero OEM',
  'numero ricambio oem': 'Numero OEM', 'numero oem': 'Numero OEM', 'oem': 'Numero OEM',
  'referenznummer(n)': 'Numero di riferimento', 'referenznummer': 'Numero di riferimento',
  'reference number': 'Numero di riferimento', 'vergleichsnummer': 'Numero di riferimento',
  'ean': 'EAN', 'gtin': 'EAN',
  'farbe': 'Colore', 'colour': 'Colore', 'color': 'Colore', 'colore': 'Colore',
  'material': 'Materiale', 'materiale': 'Materiale',
  'einbauposition': 'Posizione', 'placement on vehicle': 'Posizione', 'posizione sul veicolo': 'Posizione',
  'einbauseite': 'Lato di montaggio', 'lato di montaggio': 'Lato di montaggio',
  'zustand': 'Condizione', 'condition': 'Condizione', 'condizione': 'Condizione',
  'oberfläche': 'Finitura', 'surface finish': 'Finitura', 'finitura': 'Finitura',
  'produktart': 'Tipo', 'product type': 'Tipo', 'tipo': 'Tipo', 'typ': 'Tipo',
  'gewicht': 'Peso', 'weight': 'Peso', 'peso': 'Peso',
  'abmessungen': 'Dimensioni', 'größe': 'Dimensioni', 'size': 'Dimensioni', 'dimensioni': 'Dimensioni', 'dimensions': 'Dimensioni',
  'breite': 'Larghezza', 'width': 'Larghezza', 'larghezza': 'Larghezza',
  'höhe': 'Altezza', 'height': 'Altezza', 'altezza': 'Altezza',
  'länge': 'Lunghezza', 'length': 'Lunghezza', 'lunghezza': 'Lunghezza',
  'durchmesser': 'Diametro', 'diameter': 'Diametro', 'diametro': 'Diametro',
  'garantie': 'Garanzia', 'warranty': 'Garanzia', 'garanzia': 'Garanzia',
  'menge': 'Quantità', 'stückzahl': 'Quantità', 'quantity': 'Quantità', 'quantità': 'Quantità',
}));
// Valori enum ricorrenti nella lingua del venditore → italiano (token-wise). ponytail: set comune (posizioni/colori/materiali), non un traduttore.
const VALUE_IT = new Map(Object.entries({
  'neu': 'Nuovo', 'gebraucht': 'Usato', 'generalüberholt': 'Rigenerato', 'generaluberholt': 'Rigenerato',
  'vorne': 'Anteriore', 'hinten': 'Posteriore', 'links': 'Sinistra', 'rechts': 'Destra',
  'oben': 'Alto', 'unten': 'Basso', 'vorderachse': 'Assale anteriore', 'hinterachse': 'Assale posteriore',
  // colori
  'schwarz': 'Nero', 'weiß': 'Bianco', 'weiss': 'Bianco', 'rot': 'Rosso', 'blau': 'Blu', 'grün': 'Verde',
  'gruen': 'Verde', 'grau': 'Grigio', 'silber': 'Argento', 'gelb': 'Giallo', 'braun': 'Marrone',
  // materiali
  'stahl': 'Acciaio', 'edelstahl': 'Acciaio inox', 'aluminium': 'Alluminio', 'kunststoff': 'Plastica',
  'gummi': 'Gomma', 'messing': 'Ottone', 'kupfer': 'Rame', 'chrom': 'Cromo',
}));
function normalizzaSpec(k) {
  const key = String(k || '').replace(/:$/, '').trim();
  if (!key) return null;
  return SPEC_IT.get(key.toLowerCase()) || null;   // whitelist: chiave ignota → scartata (niente tedesco residuo)
}
// Traduce parola-per-parola i termini enum noti (es. "Vorne links" → "Anteriore Sinistra"); numeri/colori/testo libero intatti. Pura.
function normalizzaVal(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return s;
  return s.split(/\s+/).map(w => VALUE_IT.get(w.toLowerCase().replace(/[.,;]+$/, '')) || w).join(' ');
}

// Context persistente con warm-up (la sessione amortizza il 403 a freddo). Si ricrea se il browser cade.
let _ctx = null, _warm = false;
async function getCtx() {
  const browser = await getBrowser();
  // `pages()` su una sessione chiusa NON lancia: torna una lista vuota. Il ramo di recupero
  // era quindi irraggiungibile, e dopo un crash di Chromium restava un browser nuovo
  // accoppiato a una sessione morta: eBay spento fino al riavvio dell'applicazione.
  // Il controllo sul browser serve perche' `getBrowser()` puo' averne creato uno nuovo:
  // una sessione del browser precedente e' morta anche se non risulta chiusa.
  if (_ctx && !_ctx.isClosed?.() && _ctx.browser() === browser) return _ctx;
  if (_ctx) { _ctx = null; _warm = false; }
  _ctx = await browser.newContext({ userAgent: UA, locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  return _ctx;
}
async function warmup(page) {
  if (_warm) return;
  await page.goto('https://www.ebay.it/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  _warm = true;
}

// Metadati dalla card serp (.su-styled-text): eBay ha spostato condizione/spedizione fuori dai
// vecchi .s-item__* (ora morti, PROVATO col probe). Estrae dai soli span brevi. Pura (testabile).
const EBAY_COND = [[/seconda mano|usato/i, 'Usato'], [/ricondizionat|refurbish/i, 'Ricondizionato'], [/\bnuovo\b|brand new/i, 'Nuovo']];
function ebayCardMeta(attrs) {
  const list = (attrs || []).map(s => String(s || '').replace(/\s*\|\s*$/, '').trim()).filter(Boolean);
  let condizione = null, spedizione = null;
  for (const s of list) {
    if (!condizione && s.length <= 30) for (const [re, v] of EBAY_COND) if (re.test(s)) { condizione = v; break; }
    if (!spedizione && /per la consegna|consegna grati|spedizione grati/i.test(s)) {
      spedizione = /grati/i.test(s) ? 'Consegna gratis' : s.replace(/^\+\s*/, '').trim();
    }
  }
  return { condizione, spedizione };
}
// Immagine eBay al formato grande (s-l1600) — le thumbnail arrivano s-l140/500. Pura.
const ebayBig = u => String(u || '').replace(/\/s-l\d+\./, '/s-l1600.');

// Venditore dal blocco ".x-sellercard-atf__info__about-seller" ("nome(feedback)Venditore professionale…"). Pura.
function parseEbaySeller(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return {};
  const nome = (s.match(/^([^(]+?)\s*\(/) || s.match(/^([\w.\-]+)/) || [])[1] || null;
  const feedback = (s.match(/\((\d[\d.\s]*)\)/) || [])[1]?.replace(/\s/g, '') || null;
  const tipo = /venditore professionale/i.test(s) ? 'Professionale' : /venditore privato|\bprivato\b/i.test(s) ? 'Privato' : null;
  return { nome: nome ? nome.trim() : null, feedback, tipo };
}
// "5 disponibili - 1 venduto" / "Più di 10 disponibili" → riassunto. Pura (best-effort).
function parseEbayQty(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const disp = s.match(/((?:più di\s*)?\d[\d.]*)\s*disponibil/i);
  const sold = s.match(/(\d[\d.]*)\s*vendut/i);
  const parts = [];
  if (disp) parts.push(`${disp[1].trim()} disponibili`);
  if (sold) parts.push(`${sold[1]} venduti`);
  return parts.length ? parts.join(' · ') : null;
}

// fetchEbayItemDetails(url) → { venditore, spedizione, quantita, marca } dalla pagina item (enrich lazy dell'annuncio).
// Assembla i campi enrich dai testi grezzi estratti (pura, testabile).
function buildEbayDetails(raw) {
  const out = {};
  const seller = parseEbaySeller(raw.seller);
  if (seller.nome) out.venditore = `${seller.nome}${seller.feedback ? ` (${seller.feedback})` : ''}${seller.tipo ? ` · ${seller.tipo}` : ''}`;
  // il value spedizione concatena spans extra ("Vedi i dettagli…Oggetto che si trova a…") → tronca al primo marker
  const sped = cleanEbayTitle(raw.shipping || '').split(/vedi i dettagli|oggetto che si trova|consegna prevista/i)[0].replace(/[.\s]+$/, '').trim();
  if (sped) out.spedizione = sped.slice(0, 80);
  const qty = parseEbayQty(raw.qty);
  if (qty) out.quantita = qty;
  if (raw.marca) { const m = normalizzaVal(cleanEbayTitle(raw.marca)).trim(); if (m) out.marca = m.slice(0, 40); }
  return out;
}

// fetchEbayItemDetails(url) → { venditore, spedizione, quantita, marca }. Il contenuto item è CLIENT-rendered
// (l'HTTP puro non basta), ma `waitUntil:'commit'` + waitForSelector aspetta SOLO gli elementi utili → ~2s invece di 6s.
async function fetchEbayItemDetails(url) {
  const u = String(url || '');
  if (!/^https:\/\/www\.ebay\.\w+\/itm\//.test(u)) return {};
  const ctx = await getCtx();
  const page = await ctx.newPage();
  try {
    await warmup(page);
    const resp = await page.goto(u, { waitUntil: 'commit', timeout: 30000 });
    if (resp && resp.status() === 403) { _warm = false; throw new Error('eBay 403 (item)'); }
    await page.waitForSelector('.x-sellercard-atf__info__about-seller, .ux-labels-values', { timeout: 12000 }).catch(() => {});
    const raw = await page.evaluate(() => {
      const norm = e => e ? e.textContent.replace(/\s+/g, ' ').trim() : null;
      const pick = sels => { for (const s of sels) { const e = document.querySelector(s); if (e && norm(e)) return norm(e); } return null; };
      let marca = null;
      for (const l of document.querySelectorAll('.ux-labels-values')) {
        const k = norm(l.querySelector('.ux-labels-values__labels')) || '';
        if (/^(marca|hersteller|marke|brand)\b/i.test(k)) { marca = norm(l.querySelector('.ux-labels-values__values')); break; }
      }
      return {
        seller: pick(['.x-sellercard-atf__info__about-seller']),
        shipping: pick(['.ux-labels-values--shipping .ux-labels-values__values', '.d-shipping-minview .ux-textspans']),
        qty: pick(['.d-quantity__availability', '.x-quantity__availability', '[data-testid="x-quantity"]']),
        marca,
      };
    });
    return buildEbayDetails(raw);
  } catch (e) { logger.warn('[ebay]', `item details "${u}": ${e.message}`); return {}; }
  finally { await page.close().catch(() => {}); }
}

// searchEbay('34218526568') → [{fonte:'ebay', nome, prezzo, valuta, immagine, url, condizione, spedizione}]
async function searchEbay(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const ctx = await getCtx();
  const page = await ctx.newPage();
  try {
    await warmup(page);
    const resp = await page.goto(`https://www.ebay.it/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=0`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (resp && resp.status() === 403) { _warm = false; throw new Error('eBay 403 (serp)'); }
    await page.waitForTimeout(2000);
    const raw = await page.evaluate(() => {
      return [...document.querySelectorAll('.s-item, li.s-card, [data-viewport] .s-card')].slice(0, 25).map(it => {
        const t = it.querySelector('.s-item__title, .s-card__title')?.textContent?.replace(/\s+/g, ' ').trim() || null;
        const p = it.querySelector('.s-item__price, .s-card__price')?.textContent?.trim() || null;
        const u = it.querySelector('a[href*="/itm/"]')?.href?.split('?')[0] || null;
        const img = it.querySelector('img')?.src || null;
        const attrs = [...it.querySelectorAll('.su-styled-text')].map(e => e.textContent.replace(/\s+/g, ' ').trim());
        return { t, p, u, img, attrs };
      });
    });
    return raw
      .filter(r => r.t && r.u && !isPlaceholder(r.t, r.u))
      .slice(0, MAX_ITEMS)
      .map(r => ({
        fonte: 'ebay',
        nome: cleanEbayTitle(r.t),
        // il vecchio .s-card__price può essere vuoto → fallback allo span EUR breve della card
        prezzo: parsePrezzoEur(r.p) ?? parsePrezzoEur((r.attrs || []).find(s => /^(eur|€|us ?\$|\$)\s*[\d.,]/i.test(s))),
        valuta: 'EUR',
        immagine: (r.img && /ebayimg/.test(r.img)) ? r.img : null,
        url: r.u,
        ...ebayCardMeta(r.attrs),
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
    await page.waitForTimeout(1500);
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
      const gallery = [...document.querySelectorAll('.ux-image-carousel img, .ux-image-carousel-item img, button.ux-image-grid-item img, .ux-image-grid img')]
        .map(i => i.getAttribute('src') || i.getAttribute('data-src')).filter(Boolean);
      return { pairs, immagine: og || hi, gallery };
    });
    const specs = {};
    for (const [k, v] of raw.pairs) {   // junk via (spedizione/resi); chiavi → whitelist IT; valori puliti
      if (isJunkSpec(k) || isJunkSpec(v)) continue;
      const kIt = normalizzaSpec(k);
      if (!kIt || kIt === 'Tipo' || kIt === 'Condizione') continue;   // 'Tipo' ridondante con tipoPezzo; 'Condizione' = stato dell'annuncio usato, non un dato tecnico della scheda
      let vv = normalizzaVal(cleanEbayTitle(v));   // via il testo di accessibilità + enum DE→IT sui valori
      if (vv.length > 80) vv = vv.slice(0, 80).trim();          // taglia eventuali tooltip lunghi residui
      if (vv && !(kIt in specs) && Object.keys(specs).length < 10) specs[kIt] = vv;
    }
    // galleria unica al formato grande → alimenta il lightbox della scheda
    const seen = new Set(), galleria = [];
    for (const g of raw.gallery || []) { const big = ebayBig(g); if (/ebayimg/.test(big) && !seen.has(big)) { seen.add(big); galleria.push(big); } }
    return { specs, immagine: raw.immagine, galleria: galleria.slice(0, 12) };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { searchEbay, fetchEbayItemSpecs, fetchEbayItemDetails, buildEbayDetails, parsePrezzoEur, isPlaceholder, isJunkSpec, normalizzaSpec, normalizzaVal, cleanEbayTitle, ebayCardMeta, parseEbaySeller, parseEbayQty };

// self-check manuale: `node backend/ebay-scrape.js 34218526568`
if (require.main === module) {
  const { closeBrowser } = require('./oem-lookup');
  searchEbay(process.argv[2] || '34218526568')
    .then(r => { console.log(JSON.stringify(r, null, 2)); return closeBrowser(); })
    .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
