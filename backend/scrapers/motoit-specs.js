'use strict';
/**
 * Scheda tecnica moto da **Moto.it** (sezione `/listino/`).
 *
 * Perché questa fonte oltre a ultimatespecs (moto-specs.js): copre il mercato italiano
 * dell'usato, è in **italiano nativo** (nessun dizionario da applicare) e include il
 * **prezzo di listino**. Misurato su 6 marche/1087 modelli: ultimatespecs 50,6%,
 * Moto.it 42,2%, unione 62,6% → sono complementari, non alternative.
 *
 * URL scheda: `/listino/<marca>/<modello>/<qualsiasi>/<CODICE>`. Il CODICE (6 caratteri
 * opachi) è lo stesso che l'API `bikes` di motoit-models.js già restituisce per le
 * versioni, quindi non serve alcun harvest: si costruisce l'URL da dati che abbiamo già.
 * Con lo slug-versione sbagliato il sito reindirizza a quello canonico (verificato).
 *
 * ATTENZIONE (verificato su 12 pagine di 5 categorie diverse):
 *  - le 5 tabelle NON hanno titolo nell'HTML → i gruppi si ricavano classificando le
 *    chiavi (classifyKey di vehicle-specs.js, già bilingue IT/EN);
 *  - i numeri sono in formato italiano: migliaia col PUNTO ("2.234 mm"), decimali con la
 *    VIRGOLA ("91,2 CV") — l'opposto di auto-data.net. Chi converte le unità deve saperlo;
 *  - ~11 campi su 67 valgono "n.d." o "-" → scartati, non sono dati;
 *  - nessuna conversione imperiale da ripulire (a differenza di auto-data.net).
 */
const https = require('https');
const zlib = require('zlib');
const cheerio = require('cheerio');
const { fail, kindForStatus } = require('./utils');
const { classifyKey, GROUP_ORDER } = require('./vehicle-specs');

const HOST = 'https://www.moto.it';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 20000;

// Anti-SSRF: questo scraper parla SOLO con moto.it (URL iniziale E ogni redirect).
const isAllowedHost = h => /(^|\.)moto\.it$/i.test(String(h || ''));

function httpGetText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (_) { return reject(fail('url non valido', { kind: 'error' })); }
    if (!isAllowedHost(u.hostname)) return reject(fail('host non consentito', { kind: 'blocked' }));
    const req = https.get(url, { headers: {
      'user-agent': UA, 'accept-encoding': 'gzip, deflate',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'it-IT,it;q=0.9',
    } }, res => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < 5) {
        res.resume();
        let next; try { next = new URL(res.headers.location, url); } catch (_) { return reject(fail('redirect non valido', { kind: 'error' })); }
        if (!isAllowedHost(next.hostname)) return reject(fail('redirect fuori host', { kind: 'blocked' }));
        return resolve(httpGetText(next.href, redirects + 1));
      }
      if (code === 403 || code === 429) { res.resume(); return reject(fail(`http ${code}`, { status: code, kind: 'blocked' })); }
      if (code >= 400) { res.resume(); return reject(fail(`http ${code}`, { status: code, kind: kindForStatus(code) })); }
      const chunks = [];
      let s = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') s = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      s.on('data', c => chunks.push(c));
      s.on('end', () => resolve({ status: code, body: Buffer.concat(chunks).toString('utf8') }));
      s.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
  });
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
// "n.d." / "-" / "" non sono dati: meglio l'assenza del campo che un valore finto.
const isVuoto = v => !v || /^(n\.?d\.?|-{1,2}|—)$/i.test(v);
// Identità della moto: va nel `head`, non tra le specifiche.
const IDENTITY = new Set(['Marca', 'Modello', 'Allestimento', 'Categoria']);

// URL della scheda da (brandSlug, modelSlug, codice-versione). Lo slug intermedio è
// irrilevante: il sito reindirizza al canonico usando il codice.
function specUrl(brandSlug, modelSlug, code) {
  const p = [brandSlug, modelSlug, 'v', code].map(x => encodeURIComponent(String(x || '')));
  return `${HOST}/listino/${p[0]}/${p[1]}/${p[2]}/${p[3]}`;
}

// Foto segnaposto di Moto.it: le moto storiche restituiscono "swap.jpg" (immagine generica),
// non una foto del mezzo. Meglio il riquadro vuoto che una foto sbagliata.
const isFotoVera = u => /^https:\/\/cdn-img\.moto\.it\//i.test(u || '') && !/swap\.jpg|logo-moto/i.test(u);

// pagina-MODELLO → { versioni: { <codice>: {img, prezzo} }, fotoModello }.
// UNA richiesta (cacheabile) per tutte le versioni, invece di una per foto. Attenzione:
// la pagina ha due blocchi, il listino corrente (con foto e prezzo) e "fuori listino"
// (soli link di testo) → le versioni fuori produzione restano senza foto propria. Per
// quelle si ripiega su `fotoModello` (og:image della pagina): è lo stesso modello, e la
// variante la dice l'etichetta della card — come l'auto, dove una foto copre tutta la
// generazione. Meglio riconoscere la moto che una griglia di riquadri vuoti.
function parseModelVersionsMeta(html, brandSlug, modelSlug) {
  const $ = cheerio.load(html);
  const base = `/listino/${brandSlug}/${modelSlug}/`;
  const versioni = {};
  $(`a[href*="${base}"]`).each((_, a) => {
    const href = String($(a).attr('href') || '');
    const code = href.split('/').filter(Boolean).pop();
    if (!code || versioni[code]) return;
    const box = $(a).closest('li, article, div');
    const img = box.find('img').first();
    const src = String(img.attr('src') || img.attr('data-src') || '');
    const prezzo = (box.text().match(/€\s*[\d.]+/) || [])[0] || '';
    versioni[code] = { img: isFotoVera(src) ? src : '', prezzo: clean(prezzo) };
  });
  const og = String($('meta[property="og:image"]').attr('content') || '');
  return { versioni, fotoModello: isFotoVera(og) ? og : '' };
}

// pagina-versione → { head:{marca,modello,allestimento,categoria}, groups:[{title,rows:[{k,v}]}] }
function parseMotoitSpecs(html) {
  const $ = cheerio.load(html);
  const head = {};
  const byGroup = {}; const seen = new Set();
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('th,td');
    if (cells.length < 2) return;
    const k = clean($(cells[0]).text());
    if (!k) return;
    $(cells[1]).find('br').replaceWith(' ');
    const v = clean($(cells[1]).text());
    if (k === 'Marca') head.marca = v;
    else if (k === 'Modello') head.modello = v;
    else if (k === 'Allestimento') head.allestimento = v;
    else if (k === 'Categoria') head.categoria = v;
    if (IDENTITY.has(k) || seen.has(k) || isVuoto(v) || v === k) return;
    seen.add(k);
    const g = classifyKey(k);
    (byGroup[g] = byGroup[g] || []).push({ k, v });
  });
  const groups = GROUP_ORDER.filter(t => byGroup[t]).map(t => ({ title: t, rows: byGroup[t] }));
  return { head, groups };
}

async function fetchMotoitSpecs(url) {
  const { body } = await httpGetText(url);
  const parsed = parseMotoitSpecs(body);
  // "Allestimento" è il marcatore di pagina valida: su moto.it un modello inesistente
  // NON dà 404, reindirizza alla pagina-marca (HTTP 200 ingannevole). Verificato.
  if (!parsed.head.allestimento || !parsed.groups.length) {
    throw fail('scheda non disponibile su Moto.it', { kind: 'error' });
  }
  return { ...parsed, source: 'moto.it', url };
}

// URL della pagina-modello (elenco versioni con foto/prezzo).
function modelUrl(brandSlug, modelSlug) {
  return `${HOST}/listino/${encodeURIComponent(brandSlug)}/${encodeURIComponent(modelSlug)}`;
}

module.exports = { HOST, httpGetText, fetchMotoitSpecs, parseMotoitSpecs, parseModelVersionsMeta, specUrl, modelUrl, isVuoto, isFotoVera };
