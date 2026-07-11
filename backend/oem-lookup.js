'use strict';
// Lookup codice OEM → articoli, scrapando la pagina auto-doc.it dell'OEN con lo
// stack stealth di AMR (playwright-extra + puppeteer-extra-plugin-stealth), lo stesso
// che supera Cloudflare per Subito.
//
// Perché il DOM e non l'AJAX: l'endpoint /ajax/selector/vehicle resta 403 (Cloudflare
// non rilascia cf_clearance all'XHR), MA la navigazione della pagina OEM passa e la
// lista articoli è nel DOM renderizzato. (Verificato 2026-07-07.)
//
// La compatibilità-veicoli NON è qui: vive solo nell'AJAX bloccato. Follow-up.
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const { resolveChromiumExecutable } = require('./scrapers/utils');

// pw-browsers come negli scraper (bundle Electron → resources/pw-browsers).
const PW_BROWSERS = process.env.RESOURCES_PATH
  ? path.join(process.env.RESOURCES_PATH, 'pw-browsers')
  : path.join(__dirname, '../pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = PW_BROWSERS;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_ARTICOLI = 12;

let browserInstance = null;
async function getBrowser() {
  if (browserInstance) { try { browserInstance.contexts(); return browserInstance; } catch { /* riavvia */ } }
  browserInstance = await chromium.launch({
    executablePath: resolveChromiumExecutable(PW_BROWSERS),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  browserInstance.on('disconnected', () => { browserInstance = null; });
  return browserInstance;
}

// Normalizza un OEN: maiuscolo, solo alfanumerici (l'utente scrive con/ senza spazi).
const normOen = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Filtra/normalizza/deduplica codici OE grezzi. Esclude il codice cercato e i non-codici.
// PURA (testabile senza browser): l'unico pezzo con logica dei numeri OE che posso verificare.
function dedupeOe(rawList, wantNorm) {
  const seen = new Set([wantNorm]);
  const out = [];
  for (const raw of rawList || []) {
    const disp = String(raw).replace(/\s+/g, ' ').trim();
    const n = disp.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (n.length < 5 || n.length > 20 || !/\d/.test(n)) continue;   // codici OE: 5-20 char, almeno una cifra
    if (seen.has(n)) continue;
    seen.add(n); out.push(disp);
    if (out.length >= 20) break;
  }
  return out;
}

// lookupOem('1K0905851B') → { oen, categoria, tipoPezzo, articoli:[...arricchiti], count, blocked?, error? }
// Estrazione arricchita (marca, immagine, prezzo num, PVC/listino, sconto, disponibilità, variante).
// FILTRO MATCH: tiene solo i listing con data-oem-number == OEN cercato → niente risultati "sparsi";
// 0 dopo il filtro ⇒ Autodoc non ha quel codice (verificato: 06A906032HP → homepage, 0 match).
async function lookupOem(oenRaw) {
  const oen = normOen(oenRaw);
  if (!oen) return { oen: '', articoli: [], count: 0, error: 'codice vuoto' };
  const url = `https://www.auto-doc.it/pezzi-di-ricambio/oem/${oen.toLowerCase()}?search=OEN+${oen}`;

  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: UA, locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = resp ? resp.status() : 0;

    // attesa Cloudflare (challenge JS non-interattiva → si risolve da sola con stealth)
    for (let i = 0; i < 8; i++) {
      const t = await page.title().catch(() => '');
      if (!/just a moment|attendere|un momento|verifica/i.test(t)) break;
      await page.waitForTimeout(2000);
    }
    const title = await page.title().catch(() => '');
    if (/just a moment|attendere|un momento|verifica/i.test(title) || status === 403) {   // stessa regex del wait-loop
      return { oen, articoli: [], count: 0, blocked: true, error: 'Cloudflare ha bloccato la pagina' };
    }

    const data = await page.evaluate(({ cap, want }) => {
      const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
      const numIt = s => {                                   // "1.070,88 €" → 1070.88
        const m = String(s || '').match(/(\d[\d.]*,\d{2}|\d[\d.]*)/);
        if (!m) return null;
        const n = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
        return isFinite(n) ? n : null;
      };
      const crumbs = [...document.querySelectorAll('[itemprop="itemListElement"], .breadcrumbs a, nav a')].map(a => a.textContent.trim());
      const categoria = crumbs.filter(Boolean).slice(-1)[0] || null;

      const items = [...document.querySelectorAll('.listing-item[data-product-item]')].map(it => {
        // nome pulito (senza la variante) + variante separata
        const nameEl = it.querySelector('.listing-item__name');
        let nome = '';
        const nameSpan = it.querySelector('.listing-item__name-span');
        if (nameEl) {
          const clone = nameEl.cloneNode(true);
          clone.querySelector('.listing-item__name-span')?.remove();
          nome = clone.textContent.replace(/\s+/g, ' ').trim();
        }
        const variante = txt(nameSpan) || null;
        const href = (nameEl && nameEl.getAttribute('href')) || (it.querySelector('a[href]')?.getAttribute('href'));
        const url = href ? (href.startsWith('http') ? href : 'https://www.auto-doc.it' + href) : null;
        // marca dal logo brand (alt = "TOPRAN 114 221" → tolgo i token numerici)
        const brandAlt = (it.querySelector('.listing-item__image-brand img')?.getAttribute('alt') || '').trim();
        const marca = brandAlt.split(/\s+/).filter(t => t && !/^\d+$/.test(t)).join(' ') || null;
        // immagine prodotto: COSTRUITA dall'articleId (le img sono lazy-load → sotto la piega
        // non hanno URL nel DOM). cdn.autodoc thumb m=2 ~3KB, 200 per tutti (verificato).
        const artId = it.getAttribute('data-article-id');
        const immagine = artId ? `https://cdn.autodoc.de/thumb?id=${artId}&m=2&n=0&lng=it` : null;
        // n° articolo produttore ("Numero articolo: 114 221")
        const articolo = (txt(it.querySelector('.listing-item__article-item')).replace(/^.*?:\s*/, '') || null);
        const pRaw = parseFloat(it.getAttribute('data-price'));   // data-price è dot-decimal ("30.99") → parse diretto
        const prezzo = isFinite(pRaw) ? pRaw : null;
        const prezzoListino = numIt(txt(it.querySelector('.product-retail-price__old_price')));   // testo IT "70,88 €"
        let sconto = null;
        if (prezzo != null && prezzoListino && prezzoListino > prezzo) sconto = Math.round((1 - prezzo / prezzoListino) * 100);
        else { const d = (txt(it.querySelector('.product-block__discount')).match(/-?(\d+)\s*%/) || [])[1]; if (d) sconto = parseInt(d, 10); }
        const disp = txt(it.querySelector('.listing-item__available'));
        return {
          fonte: 'autodoc',
          nome, variante, marca, articolo,
          prezzo, valuta: it.getAttribute('data-currency-origin') || 'EUR',
          prezzoListino, sconto,
          immagine,
          disponibile: disp ? /disponibile/i.test(disp) : null,
          stelle: it.getAttribute('data-stars-qty') || null,
          recensioni: it.getAttribute('data-comments-qty') || null,
          url,
          articleId: it.getAttribute('data-article-id') || null,
          sellerId: it.getAttribute('data-seller-id') || null,
          generic: it.getAttribute('data-generic-name') || null,
          _oem: norm(it.getAttribute('data-oem-number')),
        };
      })
        .filter(x => x._oem === want)      // FILTRO MATCH: solo il codice cercato (niente sparsi)
        .filter(x => x.nome || x.prezzo != null)
        .slice(0, cap);

      // Numeri OE equivalenti (cross-reference). ⚠ SELETTORE NON VERIFICATO: nessun fixture
      // salvato e non eseguo lo scraper live (vincolo). Strategia difensiva: raccolgo il testo
      // SOLO da un blocco la cui intestazione matcha "Numeri/Codici OE"; il lato node filtra e
      // deduplica (dedupeOe). Se il blocco non c'è → [] (nessun codice inventato).
      let oeRaw = [];
      const oeHead = [...document.querySelectorAll('h2,h3,h4,.title,.section-title,strong,dt,th,summary')]
        .find(el => /\bnumeri?\s*oe\b|\bcodici?\s*oe\b|oe[-\s]?number|numeri di riferimento/i.test(el.textContent || ''));
      if (oeHead) {
        const scope = oeHead.closest('section,table,dl,ul,div') || oeHead.parentElement;
        if (scope) oeRaw = (scope.textContent.match(/[A-Z0-9][A-Z0-9 .\-\/]{4,}/gi) || []).map(s => s.trim());
      }
      return { categoria, items, oeRaw };
    }, { cap: MAX_ARTICOLI, want: oen });

    const tipoPezzo = data.items.find(i => i.generic)?.generic || null;
    const articoli = data.items.map(({ generic, _oem, ...rest }) => rest);   // togli i campi interni
    const oeAlternativi = dedupeOe(data.oeRaw || [], oen);
    return { oen, categoria: data.categoria, tipoPezzo, oeAlternativi, articoli, count: articoli.length };
  } catch (e) {
    require('./logger').error('[oem-lookup]', `scrape "${oen}" fallito:`, e);
    return { oen, articoli: [], count: 0, error: e.message };
  } finally {
    await context.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (browserInstance) { await browserInstance.close().catch(() => {}); browserInstance = null; }
}

module.exports = { lookupOem, normOen, dedupeOe, closeBrowser, getBrowser };

// self-check manuale: `node backend/whatsapp/oem-lookup.js 1K0905851B`
if (require.main === module) {
  const oen = process.argv[2] || '1K0905851B';
  lookupOem(oen).then(r => {
    console.log(JSON.stringify(r, null, 2));
    return closeBrowser();
  }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
