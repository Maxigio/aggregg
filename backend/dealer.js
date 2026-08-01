'use strict';
/**
 * ⚠ SOSPESO — NESSUNO CHIAMA QUESTO MODULO (verificato 2026-08-01).
 *
 * Scrive il parco del concessionario nel database, e il database e' fermo: `require` non
 * arriva da nessuna parte tranne il suo test (test/dealer-parse.test.js, che prova la sola
 * funzione pura `parseDealerStock` su fixture). Il lavoro che faceva lo fa oggi la sezione
 * Competitor, che vive su file e non su Postgres.
 *
 * Non si cancella perche' e' l'area in pausa: quando Postgres torna vivo, questo o si
 * riaggancia o si butta con cognizione. Fino ad allora resta qui, dichiarato, cosi' chi lo
 * legge non pensa che stia girando — e chi cerca "chi scrive il parco nel DB" trova la
 * risposta invece di un modulo che sembra vivo.
 *
 * F32 Fase 2 — Import del parco concessionario di papà dalla pagina AS24.
 *
 * Perché `__NEXT_DATA__` e non il GraphQL: il search-API AS24 filtra per
 * marca/modello (richiede makeId), NON per venditore → non può isolare lo stock
 * di un concessionario. La pagina `/concessionari/<slug>` ha invece i suoi annunci
 * come JSON strutturato in `props.pageProps.listings` (stessa forma del GraphQL):
 * leggerlo = parsare un blob JSON, non scraping HTML fragile. Il GraphQL resta la
 * via normale per la ricerca per marca/modello.
 *
 * `parseDealerStock` è PURA (testabile su fixture). L'I/O (fetch + DB) è a parte.
 */
const https = require('https');
const db = require('./db');
const watchlistRepo = require('./db/watchlist-repo');

const HOST = 'https://www.autoscout24.it';
const DEALER_SLUG = 'raineri-massimo';   // parco di papà (customerId 9345705)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

const yearOf = reg => {
  const raw = reg && reg.raw;                       // "2002-03-01"
  const y = raw && parseInt(String(raw).slice(0, 4), 10);
  return y && !isNaN(y) ? y : null;
};

/**
 * Estrae il parco dalla pagina concessionario (stringa HTML).
 * GUARD: niente `__NEXT_DATA__` / `listings` non-array / 0 annunci → LANCIA
 * (uno svuotamento silenzioso = falso "venduto tutto"; meglio un errore visibile).
 * @returns {{ customerId:string|null, vehicles:object[] }}
 */
function parseDealerStock(html) {
  const m = String(html).match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('dealer: __NEXT_DATA__ assente (struttura pagina cambiata o blocco)');
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { throw new Error('dealer: __NEXT_DATA__ JSON non valido'); }
  const pp = (data.props && data.props.pageProps) || {};
  const listings = pp.listings;
  if (!Array.isArray(listings)) throw new Error('dealer: props.pageProps.listings non è un array');
  if (listings.length === 0) throw new Error('dealer: 0 annunci (sospetto: blocco o struttura cambiata) → import abortito');

  const customerId = (pp.dealerInfoPage && String(pp.dealerInfoPage.customerId)) || (pp.customerId != null ? String(pp.customerId) : null);
  const vehicles = listings.map(it => {
    const ve = it.vehicle || {};
    const url = /^https?:/i.test(it.url || '') ? it.url : HOST + (it.url || '');
    const priceRaw = it.prices && it.prices.public && it.prices.public.priceRaw;
    return {
      url,
      customerId,
      tipo:    /bike|moto/i.test(ve.articleType || '') ? 'moto' : 'auto',
      marca:   ve.make || null,
      modello: ve.model || null,
      anno:    yearOf(ve.firstRegistrationDate),
      km:      (ve.mileageInKm && ve.mileageInKm.raw) ?? null,
      prezzo:  typeof priceRaw === 'number' ? priceRaw : null,
      posted_at: null,            // non esposto nel blob dealer → enrichabile poi (detail/graphql)
      raw: it,
    };
  }).filter(v => v.url && v.marca && v.modello);
  return { customerId, vehicles };
}

// ─── Repo (best-effort: no-op se DB spento) ──────────────────────────────────
async function upsertStock(vehicles) {
  if (!db.isEnabled() || !vehicles.length) return 0;
  let n = 0;
  for (const v of vehicles) {
    const r = await db.query(
      `INSERT INTO dealer_stock (url, customer_id, tipo, marca, modello, anno, km, my_price, posted_at, raw_json, last_seen, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), 'active')
       ON CONFLICT (url) DO UPDATE SET
         my_price=EXCLUDED.my_price, km=EXCLUDED.km, anno=EXCLUDED.anno,
         modello=EXCLUDED.modello, raw_json=EXCLUDED.raw_json, last_seen=now(), status='active'`,
      [v.url, v.customerId, v.tipo, v.marca, v.modello, v.anno, v.km, v.prezzo, v.posted_at, JSON.stringify(v.raw)]
    );
    if (r) n++;
  }
  return n;
}

// Veicoli del concessionario spariti dalla pagina = non più in vendita (venduto/ritirato):
// li marca 'withdrawn' (non distinguiamo venduto da ritirato → onesto).
async function markDisappeared(customerId, seenUrls) {
  if (!db.isEnabled() || !customerId) return 0;
  const r = await db.query(
    `UPDATE dealer_stock SET status='withdrawn'
     WHERE customer_id=$1 AND status='active' AND url <> ALL($2)`,
    [customerId, seenUrls]
  );
  return r ? r.rowCount : 0;
}

async function listStock() {
  if (!db.isEnabled()) return [];
  const r = await db.query(`SELECT * FROM dealer_stock WHERE status='active' ORDER BY my_price ASC NULLS LAST`);
  return r ? r.rows : [];
}
async function setNote(url, note) {
  return db.query(`UPDATE dealer_stock SET note=$2 WHERE url=$1`, [url, note]);
}
async function setStatus(url, status) {
  const sold = status === 'sold' ? ', sold_at=now()' : '';
  return db.query(`UPDATE dealer_stock SET status=$2${sold} WHERE url=$1`, [url, status]);
}

/**
 * Import completo: fetch pagina → parse → upsert → marca gli spariti → auto-add
 * dei suoi modelli alla watchlist (deep crawl iMac, così i comparabili affluiscono).
 * @returns {{ imported:number, withdrawn:number, modelsAdded:number, customerId:string|null }}
 */
async function importDealer(slug = DEALER_SLUG) {
  const html = await httpGet(`${HOST}/concessionari/${slug}`);
  const { customerId, vehicles } = parseDealerStock(html);   // LANCIA su 0/struttura → import abortito (no svuotamento)
  const imported = await upsertStock(vehicles);
  const withdrawn = await markDisappeared(customerId, vehicles.map(v => v.url));
  // Auto-add modelli alla watchlist (deduplica via UNIQUE + ON CONFLICT DO NOTHING).
  const seen = new Set();
  const models = [];
  for (const v of vehicles) {
    const k = `${v.tipo}|${v.marca}|${v.modello}`.toLowerCase();
    if (!seen.has(k)) { seen.add(k); models.push({ tipo: v.tipo, marca: v.marca, modello: v.modello }); }
  }
  const added = db.isEnabled() ? await watchlistRepo.addCandidates(models, 'imac') : { added: 0 };
  return { imported, withdrawn, modelsAdded: added.added || 0, customerId, total: vehicles.length };
}

module.exports = {
  importDealer, parseDealerStock, upsertStock, markDisappeared, listStock, setNote, setStatus,
  DEALER_SLUG,
};
