'use strict';
// Scheda tecnica moto da ultimatespecs.com — fetch HTTP (https nativo) + parsing cheerio.
// Un URL per modello-anno-variante: /motorcycles-specs/{brand}/{brand}-{model}-{anno}.
// Indice costruito dalle sitemap (harvest-moto-specs.js). Zero nuove dipendenze.
const https = require('https');
const zlib = require('zlib');
const cheerio = require('cheerio');
const { fail, kindForStatus } = require('./utils');

const HOST = 'https://www.ultimatespecs.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 20000;

// Anti-SSRF: questo scraper parla SOLO con ultimatespecs.com (URL iniziale E ogni redirect).
const isAllowedHost = h => /(^|\.)ultimatespecs\.com$/i.test(String(h || ''));

function httpGetText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (_) { return reject(fail('url non valido', { kind: 'error' })); }
    if (!isAllowedHost(u.hostname)) return reject(fail('host non consentito', { kind: 'blocked' }));
    const req = https.get(url, { headers: {
      'user-agent': UA, 'accept-encoding': 'gzip, deflate',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
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

// Etichetta leggibile da uno slug: "mt-07-abs" → "MT-07-ABS", "moto-cage" → "Moto-Cage".
function prettyMoto(slug) {
  return String(slug || '').split('-').map(w => {
    if (!w) return w;
    if (/\d/.test(w) || w.length <= 3) return w.toUpperCase();   // sigle/cilindrate → maiuscolo
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('-');
}

// Valore: togli le conversioni imperiali/alternative tra parentesi, tieni il metrico.
function cleanVal(v) {
  return clean(v)
    .replace(/\s*\((?:[^)]*\b(?:inch|inches|pounds|lbs|gallons|quarts|cubic|mph|ft\.?\s?lbs|kgf|miles|cu\.?)\b[^)]*)\)/gi, '')
    .replace(/\s+/g, ' ').trim() || clean(v);
}

// Titolo sezione del sito → gruppo IT. "<Brand> <Model> Engine and Transmission…" → "Motore e trasmissione".
function mapSection(t) {
  const s = String(t || '').toLowerCase();
  if (/general information/.test(s)) return 'Generale';
  if (/dimension|aerodynamic|weight/.test(s)) return 'Dimensioni e peso';
  if (/engine|transmission/.test(s)) return 'Motore e trasmissione';
  if (/performance/.test(s)) return 'Prestazioni';
  if (/electric|ignition|equipment/.test(s)) return 'Impianto elettrico';
  return clean(t).replace(/\s+(General Information|Performance)$/i, '') || 'Altro';
}
const IDENTITY_KEYS = new Set(['Brand', 'Model', 'Start year', 'Year']);

// pagina modello → { head, title, groups:[{title, rows:[{k,v}]}] }
// Le righe kv stanno in <table class="content_text">; ogni sezione è introdotta da td.spec_title.
function parseMotoSpecs(html) {
  const $ = cheerio.load(html);
  const head = {};
  const byGroup = {}; const order = []; const seen = new Set();
  let cur = 'Generale';
  $('table.content_text tr').each((_, tr) => {
    const st = $(tr).find('td.spec_title, th.spec_title');
    if (st.length) { cur = mapSection(st.text()); return; }   // riga-titolo → cambia gruppo
    const cells = $(tr).find('td, th');
    if (cells.length < 2) return;
    const k = clean($(cells[0]).text()).replace(/\s*:\s*$/, '');   // alcune pagine hanno "Brand:" / "Ratio :"
    if (!k) return;
    const vRaw = clean($(cells[1]).text());
    if (k === 'Brand') head.brand = vRaw;
    else if (k === 'Model') head.model = vRaw;
    else if (k === 'Year') head.year = vRaw;
    else if (k === 'Category') head.category = vRaw;
    if (IDENTITY_KEYS.has(k) || seen.has(k)) return;   // identità → head; niente duplicati
    const v = cleanVal(vRaw);
    if (!v || v === '-' || v === k) return;             // "-" = dato assente → salta
    seen.add(k);
    if (!byGroup[cur]) { byGroup[cur] = []; order.push(cur); }
    byGroup[cur].push({ k, v });
  });
  const title = clean($('title').text()).replace(/\s*Technical Specifications\s*$/i, '');
  const groups = order.filter(t => byGroup[t] && byGroup[t].length).map(t => ({ title: t, rows: byGroup[t] }));
  return { head, title, groups };
}

async function fetchMotoSpecs(url) {
  const { body } = await httpGetText(url);
  const parsed = parseMotoSpecs(body);
  if (!parsed.groups.length) throw fail('nessuna specifica trovata', { kind: 'error' });
  return { ...parsed, source: 'ultimatespecs.com', url };
}

// sitemap XML → array di URL <loc>
function parseSitemapLocs(xml) {
  return (String(xml).match(/<loc>([^<]+)<\/loc>/g) || []).map(s => s.replace(/<\/?loc>/g, '').trim());
}

module.exports = { HOST, httpGetText, fetchMotoSpecs, parseMotoSpecs, parseSitemapLocs, prettyMoto, cleanVal, mapSection };
