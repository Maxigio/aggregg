'use strict';
// Fonte CMSNL (cmsnl.com): catalogo OEM MOTO mondiale — il gemello di Autodoc per le moto.
// PROVATO (2026-07-09): lo slug nell'URL prodotto è irrilevante → `products/x_<codice>/` serve
// la pagina del pezzo con JSON-LD Product completo (name, brand, sku, mpn, price EUR,
// availability). Estrazione dal JSON-LD (SEO) → niente selettori CSS fragili.
// Cloudflare passa in NAVIGAZIONE con lo stack stealth (curl nudo = bloccato).
// Riusa il browser singleton di oem-lookup (un solo Chrome per il processo).
const { getBrowser, normOen } = require('./oem-lookup');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// lookupCmsnl('34218526568') → { oen, articoli:[{fonte:'cmsnl',...}], count, blocked?, error? }
async function lookupCmsnl(oenRaw) {
  const oen = normOen(oenRaw);
  if (!oen) return { oen: '', articoli: [], count: 0, error: 'codice vuoto' };
  const url = `https://www.cmsnl.com/it-it/products/x_${oen.toLowerCase()}/`;

  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: UA, locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = resp ? resp.status() : 0;
    for (let i = 0; i < 8; i++) {   // challenge CF non-interattiva → si risolve da sola
      const t = await page.title().catch(() => '');
      if (!/just a moment|attention required|attendere|un momento|verifica/i.test(t)) break;
      await page.waitForTimeout(2000);
    }
    const title = await page.title().catch(() => '');
    if (/just a moment|attention required|attendere|un momento|verifica/i.test(title) || status === 403) {
      return { oen, articoli: [], count: 0, blocked: true, error: 'Cloudflare ha bloccato la pagina' };
    }
    if (status === 404) return { oen, articoli: [], count: 0 };   // codice non a catalogo

    // attesa idratazione: la sezione "Modelli di adattamento" e la galleria arrivano dal
    // gateway GraphQL dopo il domcontentloaded (verificato col probe). I fits si caricano
    // SOLO quando la sezione entra nel viewport (lazy) → scrollala prima di estrarre.
    await page.waitForTimeout(3500);
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('h2,h3')].find(x => /modelli di adattamento|fits models/i.test(x.textContent || ''));
      if (h) h.scrollIntoView({ block: 'center' });
    }).catch(() => {});
    await page.waitForTimeout(3500);
    const p = await page.evaluate(() => {
      const lds = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map(s => { try { return JSON.parse(s.textContent); } catch { return null; } })
        .filter(Boolean);
      const prod = lds.find(x => x['@type'] === 'Product') || null;
      if (!prod) return null;
      const bodyTxt = document.body.innerText.replace(/\s+/g, ' ');
      // extra dal testo pagina (formato verificato: "CMSNL Numero di prodotto:BM0005.7801",
      // "Tempo di spedizione stimato: 6-15 giorni")
      const codiceCmsnl = (bodyTxt.match(/CMSNL Numero di prodotto:\s*([A-Z0-9.\-]+)/i) || [])[1] || null;
      const spedizione = (bodyTxt.match(/spedizione stimat[oa]:\s*([^A-Z]{2,30}?giorn\w+)/i) || [])[1]?.trim() || null;
      // "Modelli di adattamento": link _model DENTRO la sezione fits (esclude la nav marche in header)
      let fits = null;
      const fitsHead = [...document.querySelectorAll('h2,h3')].find(h => /modelli di adattamento|fits models/i.test(h.textContent || ''));
      if (fitsHead) {
        const scope = fitsHead.closest('section,div') || fitsHead.parentElement;
        const names = scope ? [...scope.querySelectorAll('a[href*="_model"]')]
          .map(a => a.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 3) : [];
        if (names.length) fits = [...new Set(names)].slice(0, 20);
      }
      // immagine reale dalla galleria (il campo image del JSON-LD è spesso vuoto)
      const galImg = document.querySelector('main img[src*="cmsnl"], main img[src*="product"], [class*=gallery] img')?.getAttribute('src') || null;
      return { prod, codiceCmsnl, spedizione, fits, galImg };
    });
    if (!p || !p.prod || !p.prod.name) return { oen, articoli: [], count: 0 };   // niente Product → non trovato

    const prod = p.prod;
    const prezzo = (prod.offers && typeof prod.offers.price === 'number') ? prod.offers.price
      : (prod.offers && parseFloat(prod.offers.price)) || null;
    const articoli = [{
      fonte: 'cmsnl',
      nome: prod.name,
      marca: (typeof prod.brand === 'string' ? prod.brand : prod.brand?.name) || null,
      articolo: prod.mpn || null,
      codiceCmsnl: p.codiceCmsnl,
      prezzo: (typeof prezzo === 'number' && isFinite(prezzo)) ? prezzo : null,
      valuta: (prod.offers && prod.offers.priceCurrency) || 'EUR',
      disponibile: prod.offers ? /InStock/i.test(String(prod.offers.availability || '')) : null,
      condizione: prod.offers && /NewCondition/i.test(String(prod.offers.itemCondition || '')) ? 'Nuovo' : null,
      venditore: (prod.offers && prod.offers.seller && String(prod.offers.seller.name || '').trim()) || 'CMSNL',
      spedizione: p.spedizione,
      immagine: prod.image || p.galImg || null,
      url: prod.url || url,
    }];
    return { oen, tipoPezzo: prod.name, veicoli: p.fits ? p.fits.join(', ') : null, articoli, count: 1 };
  } catch (e) {
    return { oen, articoli: [], count: 0, error: e.message };
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { lookupCmsnl };

// self-check manuale: `node backend/cmsnl-lookup.js 34218526568`
if (require.main === module) {
  const { closeBrowser } = require('./oem-lookup');
  lookupCmsnl(process.argv[2] || '34218526568')
    .then(r => { console.log(JSON.stringify(r, null, 2)); return closeBrowser(); })
    .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
