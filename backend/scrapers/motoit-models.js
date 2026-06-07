/**
 * Risoluzione ON-DEMAND dello slug-modello reale di Moto.it.
 *
 * Perché: con solo lo slug-brand la ricerca è brand-only e il post-filter su
 * MAX_PAGES sotto-campiona (es. 3 dei 28 "Alp 4.0"). La pagina-brand
 * /moto-usate/<brandSlug> elenca i modelli coi loro slug REALI
 * (es. "Alp 4.0" → alp-4-0). Risolto lo slug, lo scraper usa model=<brand>|<slug>
 * e Moto.it filtra server-side → tutti i match.
 *
 * Match: esatto-normalizzato + prefix (matcher condiviso, mode modello). Niente
 * slug inventati: si aggancia solo agli slug realmente presenti sulla pagina.
 * Cache in-memory per brand con TTL.
 */
const https = require('https');
const { makeModelResolver } = require('./brand-match');

const BASE = 'https://www.moto.it';
const TTL_MS = 12 * 60 * 60 * 1000; // 12h
const cache = new Map();   // brandSlug → { ts, models }
const inflight = new Map(); // brandSlug → Promise (dedup richieste concorrenti)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchText(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : BASE + res.headers.location;
        return fetchText(next, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
  });
}

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Estrae [{name, slug}] dai link modello /moto-usate/<brandSlug>/<modelSlug>
function parseModels(html, brandSlug) {
  const re = new RegExp(`href="(?:${escapeRe(BASE)})?/moto-usate/${escapeRe(brandSlug)}/([a-z0-9][a-z0-9-]*)"[^>]*>([^<]{1,60})<`, 'gi');
  const out = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1];
    const name = m[2].replace(/\s+/g, ' ').trim();
    if (slug && name && !out.has(slug)) out.set(slug, { name, slug });
  }
  return [...out.values()];
}

async function getBrandModels(brandSlug) {
  const hit = cache.get(brandSlug);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.models;
  if (inflight.has(brandSlug)) return inflight.get(brandSlug);   // dedup concorrenti

  const p = (async () => {
    try {
      const html = await fetchText(`${BASE}/moto-usate/${brandSlug}`);
      const models = parseModels(html, brandSlug);
      cache.set(brandSlug, { ts: Date.now(), models });
      return models;
    } catch (e) {
      console.warn(`[motoit-models] ${brandSlug}: ${e.message}`);
      return [];
    } finally {
      inflight.delete(brandSlug);
    }
  })();
  inflight.set(brandSlug, p);
  return p;
}

/** Risolve lo slug-modello reale, o null (→ fallback brand-only). */
async function resolveMotoitModelSlug(brandSlug, modelloText) {
  if (!brandSlug || !modelloText) return null;
  const models = await getBrandModels(brandSlug);
  if (!models.length) return null;
  const resolver = makeModelResolver(models.map(m => ({ name: m.name, value: m.slug })));
  return resolver(modelloText) || null;
}

module.exports = { resolveMotoitModelSlug, _getBrandModels: getBrandModels };
