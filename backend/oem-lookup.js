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
const fs = require('fs');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const { resolveChromiumExecutable } = require('./scrapers/utils');

// pw-browsers come negli scraper (bundle Electron → resources/pw-browsers).
// Con `existsSync`: electron/main.js inietta RESOURCES_PATH
// SEMPRE, anche non impacchettato, e in `npm run electron` quel percorso e'
// node_modules/electron/dist/Electron.app/Contents/Resources — dove pw-browsers non c'e'.
// Senza il controllo, li' tutta l'area Ricambi che passa dal browser (Autodoc, CMSNL, eBay)
// falliva con "pw-browsers non trovato", e il sintomo diceva "i ricambi sono rotti".
const _res = process.env.RESOURCES_PATH;
const PW_BROWSERS = (_res && fs.existsSync(path.join(_res, 'pw-browsers')))
  ? path.join(_res, 'pw-browsers')
  : path.join(__dirname, '../pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = PW_BROWSERS;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_ARTICOLI = 12;

let browserInstance = null;
// Il LANCIO IN CORSO, memoizzato. Senza, due chiamate concorrenti trovavano entrambe
// `browserInstance` a null e lanciavano DUE Chromium: il perdente non veniva mai chiuso
// (closeBrowser chiude solo il singleton) e restava in RAM per tutta la giornata. Succede
// alla prima ricerca ricambi dopo ogni avvio, perche' autodoc/cmsnl ed eBay partono
// insieme in Promise.all — e il singleton e' condiviso anche con ebay-scrape e cmsnl-lookup.
let launching = null;
async function getBrowser() {
  if (browserInstance) { try { browserInstance.contexts(); return browserInstance; } catch { /* riavvia */ } }
  if (launching) return launching;
  launching = chromium.launch({
    executablePath: resolveChromiumExecutable(PW_BROWSERS),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  }).then(b => {
    browserInstance = b;
    // `b === browserInstance` prima di azzerare: un'istanza vecchia che si disconnette
    // dopo che ne e' nata una nuova non deve buttare via quella buona.
    b.on('disconnected', () => { if (browserInstance === b) browserInstance = null; });
    return b;
  }).finally(() => { launching = null; });
  return launching;
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
    // `vistaChallenge` serve al controllo qui sotto: le challenge JS viaggiano su HTTP 403,
    // e `status` e' la fotografia della PRIMA risposta — quella della challenge stessa, mai
    // riletta. Con `|| status === 403` nudo, i sedici secondi di attesa esistevano per un
    // esito che il controllo poi buttava via: challenge risolta, listing nel DOM, e la fonte
    // dichiarata 'blocked' lo stesso.
    let vistaChallenge = false;
    for (let i = 0; i < 8; i++) {
      const t = await page.title().catch(() => '');
      if (!/just a moment|attendere|un momento|verifica/i.test(t)) break;
      vistaChallenge = true;
      await page.waitForTimeout(2000);
    }
    const title = await page.title().catch(() => '');
    const ancoraChallenge = /just a moment|attendere|un momento|verifica/i.test(title);   // stessa regex del wait-loop
    if (ancoraChallenge || (status === 403 && !vistaChallenge)) {
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
        // URL PRODOTTO: il link del nome, se valido; altrimenti il primo link col pattern product-page
        // /{brand-slug}/{id-numerico}. Scarta i badge servizio (/services/, consegna, checkout) che
        // altrimenti mandavano fetchAutodocSpecs su una pagina sbagliata → compatibilità persa.
        // Esclusione ancorata al SEGMENTO path (non substring: 'cart' bocciava /cartechnic/123, brand reale);
        // ammesso anche il fragment dopo l'id (/ridex/123#reviews).
        const nameHref = nameEl && nameEl.getAttribute('href');
        const isProd = h => /\/[a-z0-9-]+\/\d+(?:$|[/?#])/i.test(h) && !/(?:^|\/)(?:services|consegna|checkout|cart)(?:\/|$|\?)/i.test(h);
        const links = [...it.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(Boolean);
        const href = (nameHref && isProd(nameHref)) ? nameHref : (links.find(isProd) || null);
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

      /**
       * NUMERI OE EQUIVALENTI: SI LEGGE LA STRUTTURA, NON IL TESTO.
       *
       * Qui si cercava un'intestazione "Numeri/Codici OE" e poi si pescavano frammenti dal
       * testo del blocco con un'espressione che accettava anche le minuscole. Due difetti in
       * uno, misurati sulla pagina vera (sonda del 2026-08-01 su 1K0905851B):
       *
       *  - QUELL'INTESTAZIONE NON C'E'. L'unico titolo della pagina e' "Bloccasterzo,
       *    Cilindro serratura OEM 1K0 905 851 B", quindi il blocco non veniva mai trovato e
       *    i codici equivalenti non uscivano MAI. Su quella pagina ce ne sono dieci.
       *  - E quando l'intestazione c'era, il testo produceva codici finti: "Garanzia 2 anni",
       *    "Consegna in 24 - 48 ore" e "Adatto a Golf V 2003 - 2008" passano tutti il filtro
       *    a valle (5-20 caratteri, almeno una cifra) e finivano a schermo come codici OE,
       *    cliccabili. Un codice OE sbagliato fa ordinare il pezzo sbagliato.
       *
       * I codici sono LINK a un'altra pagina OEM (`/pezzi-di-ricambio/oem/<codice>`): e' la
       * pagina stessa a dichiarare che quello e' un codice, e non c'e' euristica che tenga il
       * confronto. Una frase non e' un link, quindi non puo' piu' entrare.
       */
      const oeRaw = [...document.querySelectorAll('a[href*="/pezzi-di-ricambio/oem/"]')]
        .map(a => (a.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      // Quanti elementi di listino c'erano PRIMA del filtro sul codice. Zero articoli dopo il
      // filtro e zero elementi in pagina sono due cose diverse, e finora uscivano identiche.
      return { categoria, items, oeRaw, visti: document.querySelectorAll('.listing-item[data-product-item]').length };
    }, { cap: MAX_ARTICOLI, want: oen });

    const tipoPezzo = data.items.find(i => i.generic)?.generic || null;
    const articoli = data.items.map(({ generic, _oem, ...rest }) => rest);   // togli i campi interni
    const oeAlternativi = dedupeOe(data.oeRaw || [], oen);
    // "Autodoc non ha quel codice" e "non sono riuscito a leggere l'elenco" hanno lo stesso
    // aspetto: zero articoli. Li separa DOVE siamo finiti: quando il codice non e' a catalogo
    // Autodoc porta via dalla pagina /oem/, quando invece ci siamo restati e non c'e' nemmeno
    // un elemento di listino l'elenco non e' stato letto (classe rinominata, attributo cambiato,
    // pagina servita a meta'). Nel dubbio non si afferma un fatto sul catalogo.
    const suPaginaOem = /\/pezzi-di-ricambio\/oem\//i.test(page.url() || '');
    const sospetto = (!articoli.length && !data.visti && suPaginaOem)
      ? 'nessun elemento di listino nella pagina del codice: prima di dire "non a catalogo" va guardato il markup di Autodoc'
      : null;
    if (sospetto) require('./logger').warn('[oem-lookup]', `"${oen}": ${sospetto}`);
    return { oen, categoria: data.categoria, tipoPezzo, oeAlternativi, articoli, count: articoli.length, visti: data.visti, sospetto };
  } catch (e) {
    require('./logger').error('[oem-lookup]', `scrape "${oen}" fallito:`, e);
    return { oen, articoli: [], count: 0, error: e.message };
  } finally {
    await context.close().catch(() => {});
  }
}

// fetchAutodocSpecs(url): +1 navigazione alla pagina-prodotto dell'articolo → tabella "Informazioni
// prodotto" (Potenza/Anno/Codice produttore + eventuali misure) + modelli compatibili. Solo AUTO.
// Le specs della listing-card sono dietro uno <span> AJAX (non estraibili); la product page sì (verificato).
// `motivo` distingue i tre modi in cui questa funzione tornava lo stesso identico shape vuoto:
// pagina senza tabelle, HTTP >= 400 e qualunque eccezione. Senza, il frontend non disegnava
// nulla e chi guardava leggeva "questo articolo non ha specifiche", che e' un'altra cosa.
async function fetchAutodocSpecs(url) {
  const u = String(url || '');
  if (!/^https?:\/\/(www\.)?auto-doc\.it\//i.test(u)) return { datiTecnici: {}, compatibilita: null, motivo: 'url-non-valido' };
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: UA, locale: 'it-IT', viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (resp && resp.status() >= 400) return { datiTecnici: {}, compatibilita: null, motivo: 'http-' + resp.status() };
    const extract = () => page.evaluate(() => {
      const norm = t => t.replace(/\s+/g, ' ').trim();
      const out = [];
      for (const t of document.querySelectorAll('table')) {
        const trs = t.querySelectorAll('tr');
        if (trs.length > 25) continue;   // liste prodotti/cross-sell → non è la tabella specifiche
        for (const tr of trs) {
          const cells = [...tr.querySelectorAll('th,td')].map(c => norm(c.textContent));
          if (cells.length >= 2 && cells[0] && cells[1]) out.push([cells[0], cells[1]]);
        }
      }
      return out;
    });
    await page.waitForTimeout(2500);
    let rows = await extract();
    if (!rows.length) { await page.waitForTimeout(2500); rows = await extract(); }   // challenge CF ancora in corso → 1 retry
    if (!rows.length) {
      // Nessuna tabella nemmeno dopo il secondo giro: se siamo ancora sulla challenge, la
      // pagina prodotto non l'abbiamo mai vista, e dirlo non costa niente.
      const titolo = await page.title().catch(() => '');
      if (/just a moment|attendere|un momento|verifica/i.test(titolo)) {
        return { datiTecnici: {}, compatibilita: null, motivo: 'bloccato' };
      }
    }
    const COMPAT = /modelli di auto/i;
    const SKIP = /motori|numero.*parte oe|numero\/i di parte/i;   // fitment lunghi / OE (già in oeAlternativi)
    let compatibilita = null;
    const datiTecnici = {};
    for (const [k, v] of rows) {
      if (COMPAT.test(k)) { compatibilita = v.split(/\s*;\s*/).map(x => x.trim()).filter(Boolean).slice(0, 40); continue; }
      if (SKIP.test(k)) continue;
      if (k.length > 45 || v.length > 60) continue;   // via i blob (liste motori ecc.)
      if (!(k in datiTecnici) && Object.keys(datiTecnici).length < 10) datiTecnici[k] = v;
    }
    return { datiTecnici, compatibilita, motivo: rows.length ? 'ok' : 'senza-tabelle' };
  } catch (e) { return { datiTecnici: {}, compatibilita: null, motivo: 'errore', errore: e && e.message }; }
  finally { await context.close().catch(() => {}); }
}

async function closeBrowser() {
  if (browserInstance) { await browserInstance.close().catch(() => {}); browserInstance = null; }
}

module.exports = { lookupOem, normOen, dedupeOe, closeBrowser, getBrowser, fetchAutodocSpecs };

// self-check manuale: `node backend/whatsapp/oem-lookup.js 1K0905851B`
if (require.main === module) {
  const oen = process.argv[2] || '1K0905851B';
  lookupOem(oen).then(r => {
    console.log(JSON.stringify(r, null, 2));
    return closeBrowser();
  }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
