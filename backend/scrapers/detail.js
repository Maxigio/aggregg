/**
 * Arricchimento ON-CLICK: fetch della pagina-dettaglio annuncio → spec extra
 * (cambio, potenza CV, cilindrata, proprietari, allestimento). Best-effort:
 * campi null se assenti/non estraibili.
 *
 * Sicurezza (anti-SSRF): solo https + hostname in ALLOWED, ri-validato DOPO ogni
 * redirect (il fetch ne segue ≤5). Un link malevolo in un annuncio non può far
 * fetchare risorse interne.
 *
 * Cache per-URL (TTL 12h) con cap LRU + dedup richieste in-flight.
 */
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ALLOWED = new Set([
  'www.subito.it', 'subito.it',
  'www.autoscout24.it', 'autoscout24.it',
  'www.moto.it', 'moto.it',
]);
const TTL_MS    = 12 * 60 * 60 * 1000;
const MAX_CACHE = 500;
const cache    = new Map();   // url → { ts, data }
const inflight = new Map();   // url → Promise

function hostOk(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && ALLOWED.has(x.hostname); }
  catch (_) { return false; }
}

// Fetch con cap redirect + ri-validazione hostname AD OGNI hop (anti-SSRF).
function fetchText(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    if (!hostOk(url)) return reject(new Error('host not allowed'));
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchText(next, hops + 1).then(resolve, reject);   // hostOk ri-controllato nel prossimo giro
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

const EMPTY = { cambio: null, potenzaCv: null, cilindrata: null, proprietari: null, allestimento: null, revisione: null };
const stripTags = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const toInt = s => { if (s == null) return null; const n = parseInt(String(s).replace(/[.\s]/g, ''), 10); return isNaN(n) ? null : n; };

// ─── Autoscout24: __NEXT_DATA__ ricco (rawPowerInHp, rawDisplacementInCCM, …) ──
function parseAutoscout(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  const json = m ? m[1] : html;
  const num = re => { const x = json.match(re); return x ? parseInt(x[1], 10) : null; };
  let cambio = null;
  const g = json.match(/"transmissionType"\s*:\s*\{[^}]*"formatted"\s*:\s*"([^"]+)"/)
         || json.match(/"transmissionType"\s*:\s*"([^"]+)"/)
         || json.match(/"gearbox"\s*:\s*"([^"]+)"/);
  if (g) cambio = g[1];
  return {
    cambio,
    potenzaCv:   num(/"rawPowerInHp"\s*:\s*(\d+)/),
    cilindrata:  num(/"rawDisplacementInCCM"\s*:\s*(\d+)/),
    proprietari: num(/"noOfPreviousOwners"\s*:\s*(\d+)/),
    allestimento: null,
    revisione:   null,
  };
}

// ─── Moto.it: scheda testuale (tag-strip + label→valore) ──────────────────────
function parseMotoit(html) {
  const t = stripTags(html);
  const grab = re => { const x = t.match(re); return x ? x[1] : null; };
  return {
    cambio:       grab(/Cambio\s+([A-Za-zàèéìòù ]{3,20})/i),
    potenzaCv:    toInt(grab(/Potenza\s+([\d.,]+)\s*(?:cv|hp)/i)),
    cilindrata:   toInt(grab(/Cilindrata\s+([\d.]+)\s*c\.?\s*c/i)),
    proprietari:  toInt(grab(/Proprietari precedenti\s+(\d+)/i)),
    allestimento: null,
    revisione:    null,
  };
}

// ─── Subito: best-effort __NEXT_DATA__ features (spesso DataDome blocca → EMPTY)
function parseSubito(html) {
  try {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return { ...EMPTY };
    const j = JSON.parse(m[1]);
    const f = {};
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o.features)) for (const ft of o.features) {
        if (ft && ft.uri) f[ft.uri] = ft.values?.[0]?.value ?? ft.values?.[0]?.key ?? null;
      }
      for (const k in o) walk(o[k]);
    };
    walk(j);
    return {
      cambio:       f['/gearbox'] || null,
      potenzaCv:    toInt(f['/horse_power'] || f['/power']),
      cilindrata:   toInt(f['/engine_displacement'] || f['/cubic_capacity']),
      proprietari:  null,
      allestimento: f['/version'] || null,
      revisione:    null,
    };
  } catch (_) { return { ...EMPTY }; }
}

const PARSERS = { autoscout: parseAutoscout, moto: parseMotoit, subito: parseSubito };
function fonteFromUrl(u) {
  try {
    const h = new URL(u).hostname;
    if (h.includes('autoscout')) return 'autoscout';
    if (h.includes('moto.it'))   return 'moto';
    if (h.includes('subito'))    return 'subito';
  } catch (_) {}
  return null;
}

/** Spec extra per un annuncio, o null se host non valido/parser assente. */
async function getDetail(url) {
  if (!hostOk(url)) throw new Error('host not allowed');
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < TTL_MS) { cache.delete(url); cache.set(url, hit); return hit.data; }  // LRU touch
  if (inflight.has(url)) return inflight.get(url);

  const p = (async () => {
    try {
      const parser = PARSERS[fonteFromUrl(url)];
      if (!parser) return null;
      const html = await fetchText(url);
      const data = parser(html) || { ...EMPTY };
      cache.set(url, { ts: Date.now(), data });
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);  // evict oldest
      return data;
    } catch (e) {
      console.warn(`[detail] ${String(url).slice(0, 70)}: ${e.message}`);
      return null;   // best-effort: la UI mostra "dettagli non disponibili"
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
  return p;
}

module.exports = { getDetail, _hostOk: hostOk };
