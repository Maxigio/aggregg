'use strict';
/**
 * Scraper Subito via API di prima parte (hades.subito.it).
 *
 * Path PRIMARIO per Subito: GET JSON diretto, niente browser/DataDome/bootstrap
 * CAPTCHA → elimina il punto più fragile dell'app. Su errore/blocco → throw, così
 * server.js fa fallback a subito-playwright (browser+stealth).
 *
 * Schema verificato:
 *  GET /v1/search/items?c=<cat>&t=s&q=<marca modello>&lim=<n>&start=<off>
 *  c=2 Auto, c=3 Moto e Scooter (macrocategoria Motori).
 *  ad.subject (titolo), ad.urls.default (URL), ad.geo.region.friendly_name +
 *  ad.geo.city.value, ad.features[] (label→values[0].value): Prezzo, Km,
 *  Immatricolazione, Carburante, Cambio, Potenza, …
 */
const https = require('https');

// Errore "taggato" per la classificazione salute crawler (F1.5).
function kindForStatus(s) {
  if (s === 401) return 'auth';
  if (s === 403 || s === 429) return 'blocked';
  if (s >= 500) return 'transient';
  return 'error';
}
function fail(msg, { status = null, kind = 'error' } = {}) {
  const e = new Error(msg); e.status = status; e.kind = kind; return e;
}

const HOST = 'hades.subito.it';
const CAT = { auto: '2', moto: '3' };
const PAGE_SIZE = 50;
const MAX_PAGES = 2;            // 2×50 = 100
const TIMEOUT_MS = 12000;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

function httpGetJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: HOST, path,
      headers: { 'user-agent': UA, 'referer': 'https://www.subito.it/', 'accept': 'application/json' },
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
  });
}

// feature per label → primo value
function feat(ad, label) {
  const f = (ad.features || []).find(x => x.label === label);
  if (!f) return null;
  const v = f.values && f.values[0];
  return (v && (v.value != null ? v.value : v.key)) || null;
}

const digits = s => { const m = String(s == null ? '' : s).replace(/\./g, '').match(/\d+/); return m ? parseInt(m[0], 10) : null; };
const yearOf = s => { const y = parseInt(String(s || '').split('/').pop(), 10); return Number.isFinite(y) && y > 1900 ? y : null; };

function mapAd(ad, opts = {}) {
  const url = ad.urls && (ad.urls.default || ad.urls.mobile);
  if (!url) return null;
  // km: "124000 Km" oppure bucket "120.000 - 129.999" → estremo inferiore
  const kmRaw = feat(ad, 'Km');
  const km = kmRaw ? digits(String(kmRaw).split('-')[0]) : null;
  // data pubblicazione: hades espone ad.date (ISO) — usata come posted_at.
  const posted = ad.date || (ad.dates && (ad.dates.display || ad.dates.created)) || null;
  const out = {
    fonte: 'subito',
    titolo: ad.subject || 'Annuncio senza titolo',
    prezzo: digits(feat(ad, 'Prezzo')),
    km,
    anno: yearOf(feat(ad, 'Immatricolazione') || feat(ad, 'Anno di immatricolazione')),
    carburante: feat(ad, 'Carburante'),
    provincia: (ad.geo && ad.geo.city && ad.geo.city.value) || null,
    cambio: feat(ad, 'Cambio'),
    cilindrata: digits(feat(ad, 'Cilindrata')),
    variante: null,
    url,
    // Campi per il DB (crawler); Subito non espone danni/nuovo pulito → null.
    nuovo: null,
    danni: null,
    posted_at: posted,
  };
  if (opts.attachRaw) out._raw = ad;   // foto grezza per raw_json (keep-last)
  return out;
}

function buildPath(params, start) {
  const c = CAT[params.tipo] || CAT.auto;
  const q = [params.marca, params.modello].filter(Boolean).join(' ').trim();
  const qs = new URLSearchParams({ c, t: 's', lim: String(PAGE_SIZE), start: String(start) });
  if (q) qs.set('q', q);
  return `/v1/search/items?${qs.toString()}`;
}

async function fetchPage(params, start) {
  const res = await httpGetJson(buildPath(params, start));
  if (res.status !== 200) throw fail(`Subito hades HTTP ${res.status}`, { status: res.status, kind: kindForStatus(res.status) });
  let j;
  try { j = JSON.parse(res.body); } catch (_) { throw fail('Subito hades: body non-JSON (blocco?)', { status: res.status, kind: 'blocked' }); }
  if (j.errors) throw fail('Subito hades errors: ' + JSON.stringify(j.errors).slice(0, 100), { kind: 'error' });
  return Array.isArray(j.ads) ? j.ads : [];
}

/**
 * Annunci Subito via API. Throw su errore → fallback Playwright.
 * @param opts.maxPages  override profondità (crawler: 10-20; on-search: 2)
 * @param opts.attachRaw allega `_raw` (foto grezza) per il DB
 * @param opts.withMeta  ritorna {items, truncated} invece dell'array (back-compat).
 *                       truncated=true se fermato al cap con ultima pagina PIENA
 *                       (vista parziale → il crawler NON deve rilevare venduti).
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scrapeSubitoApi(params, opts = {}) {
  const regione = params.regione ? String(params.regione).trim().toLowerCase() : null;
  const maxPages = opts.maxPages || MAX_PAGES;
  const pageDelay = opts.pageDelayMs || 0;   // pausa tra le pagine (anti-ban su crawl profondi)
  const out = [];
  let truncated = false;
  for (let p = 0; p < maxPages; p++) {
    if (p > 0 && pageDelay) await sleep(pageDelay);   // mai raffica di pagine
    const ads = await fetchPage(params, p * PAGE_SIZE);
    for (const ad of ads) {
      // Filtro regione nativo: geo.region.friendly_name == nostra regione (stesso
      // formato di province.json). Senza regione → tutti.
      if (regione) {
        const r = ad.geo && ad.geo.region && ad.geo.region.friendly_name;
        if (r && r.toLowerCase() !== regione) continue;
      }
      const m = mapAd(ad, opts);
      if (m && m.prezzo != null) out.push(m);
    }
    if (ads.length < PAGE_SIZE) break;       // lista esaurita = vista completa
    if (p === maxPages - 1) truncated = true; // ultima pagina piena al cap → forse altro
  }
  return opts.withMeta ? { items: out, truncated } : out;
}

module.exports = scrapeSubitoApi;
module.exports._mapAd = mapAd;
module.exports._buildPath = buildPath;
