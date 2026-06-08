const express = require('express');
const path = require('path');
const scrapeSubito    = require('./scrapers/subito-playwright');
const scrapeAutoscout = require('./scrapers/autoscout-playwright');
const scrapeMotoIt    = require('./scrapers/motoit');
const subitoSession   = require('./scrapers/subito-session');
const { runBootstrap } = require('./scrapers/subito-bootstrap');
const filtersSchema   = require('./scrapers/filters-schema');
const { resolveMotoitSlug } = require('./scrapers/motoit-brands');
const { resolveMotoitModelSlug } = require('./scrapers/motoit-models');
const { getDetail } = require('./scrapers/detail');
const saved = require('./saved');
const { makeResolver, makeModelResolver, loadAliasMap } = require('./scrapers/brand-match');
const province        = require('../data/province.json');
const modelsData      = require('../data/models.json');

const { SubitoBlockedError, keepAliveSubito } = scrapeSubito;

// Auto-refresh: keep-alive periodico a Subito per estendere il cookie DataDome
// finché l'app resta aperta. Riduce il bootstrap manuale a "quasi-mai".
//   - INTERVAL: ogni 15 minuti (tipico TTL DataDome è 24h, ma DataDome estende
//     spesso il cookie ad ogni request valida — 15 min è abbondante per stare
//     dentro qualunque finestra ragionevole).
//   - Solo se esiste già una session (no point chiamare keep-alive senza state).
const KEEP_ALIVE_INTERVAL_MS = 15 * 60 * 1000;
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(async () => {
    const state = subitoSession.loadStorageState();
    if (!state) return;  // niente da rinfrescare
    if (subitoSession.isSubitoBlocked()) return;  // già bloccato, l'utente farà bootstrap
    const res = await keepAliveSubito();
    console.log('[keep-alive] ' + (res.ok ? 'OK' : 'FAIL ' + res.reason));
  }, KEEP_ALIVE_INTERVAL_MS);
  keepAliveTimer.unref?.();
}

/** Normalizza stringa: solo lettere e cifre minuscole (per matching fuzzy) */
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Lookup marca FUZZY (matcher condiviso): "BMW"/"bmw", "Beta"→"Betamotor",
// "Fantic"→"Fantic Motor" agganciano la stessa entry. Evita lo skip a cascata di
// AS24/Moto.it quando la marca digitata non combacia esatta col nome catalogo.
// NB: serve solo a recuperare i metadata (makeId/slug/modelli); la query Subito
// usa sempre il testo digitato dall'utente, non il nome catalogo.
// Il value porta sia il nome canonico sia l'entry: serve il nome per la chiave
// dei gruppi-serie (model-groups.json), l'entry per i metadata (makeId/slug/modelli).
const catalogResolver = {
  auto: makeResolver(Object.entries(modelsData.auto || {}).map(([nome, entry]) => ({ name: nome, value: { nome, entry } })), { alias: loadAliasMap('auto') }),
  moto: makeResolver(Object.entries(modelsData.moto || {}).map(([nome, entry]) => ({ name: nome, value: { nome, entry } })), { alias: loadAliasMap('moto') }),
};
const lookupBrand = (tipo, marca) => catalogResolver[tipo]?.(marca) || null;

// Gruppi-serie commerciali (es. BMW "Serie 3" → [316,318,320,…]) generati da
// scripts/build-model-groups.js. Usati per narroware il titolo AS24 quando la
// serie non ha una entry-modello singola (niente mmmv di modello).
let modelGroups = { auto: {}, moto: {} };
try { modelGroups = require('../data/model-groups.json'); } catch (_) { /* opzionale */ }
function lookupModelGroup(tipo, brandName, modelText) {
  const brands = modelGroups[tipo];
  if (!brands || !brandName) return null;
  const g = brands[brandName];
  if (!g) return null;
  const q = norm(modelText);
  if (!q) return null;
  for (const [serie, membri] of Object.entries(g)) if (norm(serie) === q) return membri;
  return null;
}

const app = express();
const PORT = process.env.PORT || 3000;
// Timeout per-scraper. Serve a coprire: lancio Chromium (primo avvio ~3-5s),
// caricamento pagina (DOMContentLoaded), fino a 5 pagine sequenziali.
// Pre-warming al boot toglie il costo del lancio dalla prima richiesta,
// ma manteniamo il timeout generoso per siti lenti (Subito spesso >20s full sort).
const TIMEOUT_MS = 45000;

app.use(express.static(path.join(__dirname, '../frontend')));

// Endpoint lista brand (con metadata per-sito) — alimenta il dropdown marca
app.get('/api/brands', (req, res) => {
  const { tipo } = req.query;
  if (!tipo || !['auto', 'moto'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo deve essere "auto" o "moto"' });
  }
  const brands = modelsData[tipo] || {};
  const lista = Object.entries(brands)
    .map(([nome, b]) => ({
      nome,
      sites:     b.sites || [],
      autoscout: b.autoscout || null,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'it', { sensitivity: 'base' }));
  res.json({ brands: lista });
});

// Endpoint modelli per marca (alimenta il dropdown modello nel frontend)
app.get('/api/models', (req, res) => {
  const { tipo, marca } = req.query;
  if (!tipo || !['auto', 'moto'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo deve essere "auto" o "moto"' });
  }
  if (!marca || typeof marca !== 'string' || marca.trim().length === 0) {
    return res.status(400).json({ error: 'marca obbligatoria' });
  }
  const entry = modelsData[tipo]?.[marca.trim()];
  if (!entry) return res.json({ modelli: [], sites: [] });

  // entry.models è sempre un array nel nuovo schema unificato (sia auto sia moto).
  // Subito usa solo ?q=marca+modello, niente più slug/key per Subito nel payload.
  const modelli = (entry.models || []).map(m => ({
    nome:           m.nome,
    sites:          m.sites || [],
    mmmvAutoscout:  m.mmmvAutoscout  || '',
    kindAS:         m.kindAS         || '',
    slugMotoIt:     m.slugMotoIt     || '',
  }));
  res.json({ modelli, sites: entry.sites || [] });
});

// Endpoint filtri per-piattaforma (P10): l'UI lo chiama all'avvio per
// renderizzare il pannello filtri tripartito Subito | Autoscout | Moto.it.
//   GET /api/filters?tipo=auto|moto
// → { subito: [...], autoscout: [...], motoit: [...] }
app.get('/api/filters', (req, res) => {
  const { tipo } = req.query;
  if (!tipo || !['auto', 'moto'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo deve essere "auto" o "moto"' });
  }
  res.json(filtersSchema.getSchema(tipo));
});

// §15 — Arricchimento spec ON-CLICK: fetch pagina-dettaglio → { cambio, potenzaCv,
// cilindrata, proprietari, allestimento, revisione }. Anti-SSRF: host allowlist in
// detail.js (https + dominio fonte, ri-validato per-redirect). Best-effort: ok:false
// se la fonte non risponde (es. Subito bloccato).
app.get('/api/detail', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url obbligatorio' });
  try {
    const detail = await getDetail(url);
    if (!detail) return res.json({ ok: false, detail: null });
    res.json({ ok: true, detail });
  } catch (e) {
    return res.status(400).json({ error: e.message });   // host non in allowlist / schema non-https
  }
});

// Set di regioni valide (derivato da province.json)
const REGIONI_VALIDE = new Set(Object.values(province).map(p => p.regione));

// Validazione e sanitizzazione parametri ricerca
function parseSearchParams(query) {
  const {
    tipo, marca, modello, prezzoMin, prezzoMax, annoMin, annoMax, kmMax, regione,
    mmmvAutoscout, motoitBrandSlug, motoitModelSlug,
    filtersSubito, filtersAutoscout, filtersMotoit,
  } = query;

  const errors = [];
  if (!tipo || !['auto', 'moto'].includes(tipo)) errors.push('tipo deve essere "auto" o "moto"');
  if (!marca || typeof marca !== 'string' || marca.trim().length === 0) errors.push('marca obbligatoria');
  if (regione && !REGIONI_VALIDE.has(regione.trim())) errors.push(`regione non valida: ${regione}`);
  if (errors.length) return { errors };

  const toInt = (val) => {
    const n = parseInt(val, 10);
    return isNaN(n) || n < 0 ? null : n;
  };

  // Filtri per-piattaforma (P10) — il client li passa come stringhe JSON
  // separate. Es: filtersSubito='{"carburante":"2","cambio":"1"}'.
  const parseFiltersBlob = (str, label) => {
    if (!str) return {};
    try {
      const parsed = typeof str === 'string' ? JSON.parse(str) : str;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      console.warn(`[parseFiltersBlob] ${label} JSON invalido: ${err.message}`);
      return {};
    }
  };

  // Subito non riceve più metadata per sito: cerca sempre con ?q=marca+modello.
  // Autoscout24 usa mmmvAutoscout, Moto.it usa motoitBrandSlug/motoitModelSlug.
  // I blob filters{Subito,Autoscout,Motoit} contengono i filtri specifici del sito (P10).
  return {
    params: {
      tipo:             tipo.trim(),
      marca:            marca.trim(),
      modello:          modello ? modello.trim() : '',
      regione:          regione ? regione.trim() : '',
      prezzoMin:        toInt(prezzoMin),
      prezzoMax:        toInt(prezzoMax),
      annoMin:          toInt(annoMin),
      annoMax:          toInt(annoMax),
      kmMax:            toInt(kmMax),
      mmmvAutoscout:    mmmvAutoscout    || null,
      motoitBrandSlug:  motoitBrandSlug  || null,
      motoitModelSlug:  motoitModelSlug  || null,
      filtersSubito:    parseFiltersBlob(filtersSubito,    'subito'),
      filtersAutoscout: parseFiltersBlob(filtersAutoscout, 'autoscout'),
      filtersMotoit:    parseFiltersBlob(filtersMotoit,    'motoit'),
    }
  };
}

// Wrapper per-fonte: ritorna { items, status, reason } — mai [] muto.
// status: 'ok' | 'empty' | 'timeout' | 'error'. Così la UI distingue
// "rotto/saltato" da "nessun risultato".
async function runSource(promise, ms, nomeSito) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('__timeout__')), ms)
  );
  try {
    const items = await Promise.race([promise, timeout]);
    return { items, status: items.length ? 'ok' : 'empty', reason: null };
  } catch (err) {
    const isTimeout = err.message === '__timeout__';
    console.warn(`[WARN] ${nomeSito}: ${isTimeout ? 'timeout' : err.message}`);
    return { items: [], status: isTimeout ? 'timeout' : 'error', reason: isTimeout ? 'timeout' : err.message };
  }
}

// Wrapper Subito-specifico: distingue fra bloccato (CAPTCHA/403 → needs_bootstrap)
// e altri errori (timeout/parsing → 'error'). Ritorna { items, status }.
async function runSubito(params, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout su Subito.it')), ms)
  );
  try {
    const items = await Promise.race([scrapeSubito(params), timeout]);
    return { items, status: items.length ? 'ok' : 'empty', reason: null };
  } catch (err) {
    if (err instanceof SubitoBlockedError) {
      return { items: [], status: 'needs_bootstrap', reason: err.reason };
    }
    console.warn('[WARN] ' + err.message);
    return { items: [], status: 'error', reason: err.message };
  }
}

app.get('/api/search', async (req, res) => {
  const parsed = parseSearchParams(req.query);
  if (parsed.errors) {
    return res.status(400).json({ error: parsed.errors.join(', ') });
  }
  try {
    res.json(await runSearch(parsed.params));
  } catch (e) {
    console.error('[runSearch]', e.message);
    res.status(500).json({ error: 'Errore interno durante la ricerca' });
  }
});

// ─── Cache ricerche recenti (§17.4) ───────────────────────────────────────────
// Stessa ricerca entro il TTL → risposta istantanea. NON cacha se una fonte è
// error/needs_bootstrap (non congelare uno stato-bloccato) né i 0-risultati totali.
const SEARCH_CACHE_TTL = 3 * 60 * 1000;
const SEARCH_CACHE_MAX = 50;
const searchCache = new Map();   // key → { ts, data }
function searchCacheKey(p) {
  return ['tipo', 'marca', 'modello', 'prezzoMin', 'prezzoMax', 'annoMin', 'annoMax', 'kmMax', 'regione']
    .map(f => `${f}=${p[f] ?? ''}`).join('&').toLowerCase();
}
function cacheable(data) {
  const bad = s => s === 'error' || s === 'needs_bootstrap';
  const src = data.sources || {};
  if (bad(src.subito?.status) || bad(src.autoscout?.status) || bad(src.moto?.status)) return false;
  return (data.totale || 0) > 0;
}

// Wrapper con cache attorno al core.
async function runSearch(params) {
  const key = searchCacheKey(params);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.ts < SEARCH_CACHE_TTL) {
    searchCache.delete(key); searchCache.set(key, hit);   // LRU touch
    return hit.data;
  }
  const data = await runSearchCore(params);
  if (cacheable(data)) {
    searchCache.set(key, { ts: Date.now(), data });
    if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  }
  return data;
}

// ─── Core ricerca RIUSABILE (§11) ─────────────────────────────────────────────
// Pipeline unica: risoluzione metadata → scraping multi-fonte → post-filter →
// stato per-fonte. Chiamato da GET /api/search E dal motore avvisi (saved-check),
// così UI e avvisi danno risultati/rating coerenti. Ritorna l'oggetto-response.
async function runSearchCore(params) {
  // ── Risoluzione metadata per-sito dal catalogo unificato ──────────────────
  // Subito: niente metadata da risolvere — usa sempre ?q=marca+modello.
  // Autoscout24: serve mmmvAutoscout (livello modello, fallback livello brand).
  // Moto.it: servono motoitBrandSlug + motoitModelSlug (slug-based, niente fallback).
  const brandHit   = lookupBrand(params.tipo, params.marca);
  const brandEntry = brandHit?.entry || null;
  const brandName  = brandHit?.nome  || null;   // nome canonico catalogo (chiave gruppi-serie)
  const asMeta     = brandEntry?.autoscout || null;

  // Match modello: matcher condiviso (esatto-normalizzato → prefix), case/accent-insensitive.
  // Risolve "durango"→"Durango", "318d"→"318". (Niente più `===` esatto case-sensitive.)
  let modelEntry = null;
  if (params.modello && brandEntry?.models?.length) {
    const resolveModel = makeModelResolver(brandEntry.models.map(m => ({ name: m.nome, value: m })));
    modelEntry = resolveModel(params.modello) || null;
  }

  // Serie commerciale senza entry-modello singola (es. BMW "Serie 3", solo i trim
  // 316/318/… esistono nel catalogo). Membri dal catalogo → narrowing titolo AS24.
  const groupMembers = (!modelEntry && params.modello && params.tipo === 'auto')
    ? lookupModelGroup(params.tipo, brandName, params.modello)
    : null;

  if (modelEntry) {
    if (!params.mmmvAutoscout && modelEntry.mmmvAutoscout) params.mmmvAutoscout = modelEntry.mmmvAutoscout;
    // Submodelli che su AS24 sono collassati sotto un modelId condiviso
    // (es. Ducati Diavel V4 sta in modelId=70147 insieme a Diavel 1260 e Diavel classico).
    // asFilterToken = sottostringa da cercare nel titolo AS24 per isolare il submodello.
    params.asFilterToken = modelEntry.asFilterToken || null;
  }

  // ── Slug brand Moto.it — SOLO slug REALI (niente guess) ───────────────────
  // Fonte 1: catalogo (brandEntry.motoit.brandSlug, quando presente).
  // Fonte 2: data/motoit-brands.json (slug veri harvestati da Moto.it), risolto
  //          per nome con match normalizzato/contenimento (es. "Beta"→betamotor).
  // Il model slug resta SOLO dal catalogo: in mancanza si va brand-only e il
  // post-filter sul titolo restringe al modello (es. "Alp 4.0"). Niente slug
  // modello inventati.
  if (params.tipo === 'moto') {
    if (!params.motoitBrandSlug) {
      params.motoitBrandSlug = brandEntry?.motoit?.brandSlug || resolveMotoitSlug(params.marca) || null;
    }
    if (!params.motoitModelSlug && modelEntry?.slugMotoIt) {
      params.motoitModelSlug = modelEntry.slugMotoIt;
    }
    // Slug-modello ON-DEMAND dalla pagina-brand Moto.it (evita undersampling:
    // brand-only prende solo le prime pagine → 3/28 "Alp 4.0"). Solo se manca dal
    // catalogo e abbiamo brandSlug + modello digitato. Cache nel modulo.
    if (!params.motoitModelSlug && params.motoitBrandSlug && params.modello) {
      try {
        params.motoitModelSlug = await resolveMotoitModelSlug(params.motoitBrandSlug, params.modello) || null;
      } catch (_) { /* fallback brand-only + post-filter */ }
    }
  }

  // makeId AS24: dal catalogo (fuzzy lookup recupera anche le entry con nome-variante,
  // es. "Beta"→"Betamotor"=50011). brandOnAutoscout dipende dal makeId, non dalla
  // sola presenza dell'oggetto autoscout (2 marche moto hanno autoscout senza makeId).
  const asMakeId         = asMeta?.makeId || null;
  const brandOnAutoscout = Boolean(asMakeId);
  const brandOnMotoIt    = Boolean(params.motoitBrandSlug);  // slug reale risolto

  // Passa mmmv AS24 al scraper: livello modello > livello brand (brand-only = makeId|||).
  // Filtro regione: gestito lato scraper con zip=<Region> (Italy)+zipr+lat/lon.
  if (asMakeId) {
    params.autoscoutMmmv = params.mmmvAutoscout || `${asMakeId}|||`;
  }

  // ── Skip tollerante (P6) ──────────────────────────────────────────────────
  // L'app interroga ogni fonte se il BRAND è coperto da quella fonte. Non skippa
  // AS24 / Moto.it solo perché il `sites` del modello specifico non li include:
  // il flag `sites` era derivato dal catalogo statico al build (assenza del
  // metadata ≠ assenza degli annunci). Il post-filter sul titolo per le moto
  // (riga ~280) garantisce che gli annunci di altri modelli vengano scartati.
  //
  // Auto: 100% dei modelli ha sites=[subito,autoscout], quindi la nuova regola
  // non cambia nulla.
  // Moto: 90% dei modelli aveva sites monco → ora coperti automaticamente.
  const skipAutoscout = !brandOnAutoscout;
  const skipMotoIt    = params.tipo !== 'moto' || !brandOnMotoIt;
  // Motivi di skip (per lo stato per-fonte in UI)
  const asSkipReason   = 'marca non su Autoscout';
  const motoSkipReason = params.tipo !== 'moto' ? 'solo moto' : 'marca non su Moto.it';

  // Log informativo quando interroghiamo AS24/MotoIt a livello brand-only
  // (fallback che si appoggia al post-filter sul titolo).
  if (params.modello && brandOnAutoscout && !params.mmmvAutoscout) {
    console.log(`[server] AS24 brand-only fallback per "${params.marca} ${params.modello}" (mmmv specifico assente)`);
  }
  if (params.modello && params.tipo === 'moto' && brandOnMotoIt && !params.motoitModelSlug) {
    console.log(`[server] Moto.it brand-only fallback per "${params.marca} ${params.modello}" (slug specifico assente)`);
  }

  // Ogni fonte ritorna { items, status, reason }. Subito ha wrapper dedicato
  // (propaga 'needs_bootstrap'). Lo skip è uno stato esplicito, non un [] muto.
  const [subitoRes, asRes, motoRes] = await Promise.all([
    runSubito(params, TIMEOUT_MS),
    skipAutoscout
      ? Promise.resolve({ items: [], status: 'skipped', reason: asSkipReason })
      : runSource(scrapeAutoscout(params), TIMEOUT_MS, 'Autoscout24'),
    skipMotoIt
      ? Promise.resolve({ items: [], status: 'skipped', reason: motoSkipReason })
      : runSource(scrapeMotoIt(params), TIMEOUT_MS, 'Moto.it'),
  ]);

  const grezzi = [...subitoRes.items, ...asRes.items, ...motoRes.items];

  // ── Filtro post-scraping ─────────────────────────────────────────────────────
  // Rimuove accenti per confronto robusto (es. "Citroën" → "Citroen")
  const stripAccents = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Brand keyword: primo token non-generico e ≥ 3 caratteri, oppure il primo token.
  // BRAND_GENERIC esclude suffissi informativi ma non caratteristici del brand.
  const BRAND_GENERIC = new Set(['automobiles', 'motorcycles', 'cars', 'motors', 'motor', 'group', 'moto']);
  const brandTokens   = stripAccents(params.marca).toLowerCase().split(/[\s\-_]+/);
  const marcaKeyword  = brandTokens.find(w => w.length >= 3 && !BRAND_GENERIC.has(w))
                        || brandTokens[0];

  // Modello normalizzato (per match su titolo)
  const normModello = params.modello ? norm(params.modello) : '';

  // Narrowing AS24 brand-only per AUTO (§12): quando manca l'mmmv di modello
  // (serie commerciale o modello irrisolto), filtra i titoli AS24 sui token-modello.
  // Confine-parola su forma space-normalizzata: evita "c220" ⊂ "glc220" (GLC≠Classe C).
  const normSp = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const autoTokens = (params.tipo === 'auto' && params.modello && !params.mmmvAutoscout)
    ? (groupMembers && groupMembers.length ? groupMembers.map(normSp) : [normSp(params.modello)]).filter(Boolean)
    : null;
  // Right-boundary = "non seguito da cifra": il codice-serie (es. "320") matcha i
  // titoli con lettera-variante attaccata ("320d","318i") ma NON "3200"/"1320".
  const autoTokenRe = autoTokens && autoTokens.length
    ? new RegExp('(?:^| )(' + autoTokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![0-9])')
    : null;

  const risultati = grezzi.filter(r => {
    // Usa titolo senza accenti per un match robusto (es. "Citroën" = "Citroen")
    const titoloLow  = stripAccents(r.titolo).toLowerCase();
    const titoloNorm = norm(r.titolo);

    // 1+2. Marca/modello: skip post-filter quando il sito li ha già filtrati server-side.
    //    - Subito (auto+moto): ricerca testuale ?q=marca+modello → titolo già filtrato.
    //    - Autoscout: brand+modello via mmmv → modelId server-side.
    //    - Moto.it:   brand+modello via slug nel path/query.
    //    Senza questa eccezione il post-filter scarta annunci validi con titoli "creativi"
    //    (es. "KTM Adventure 1190" cercando "1190 Adventure", o "Giulia TI 2.2" senza "Alfa").
    const subitoFiltered    = r.fonte === 'subito';
    const autoscoutFiltered = r.fonte === 'autoscout' && Boolean(params.autoscoutMmmv);
    // Moto.it filtra server-side via ?brand= (quasi sempre presente) o ?model=
    const motoitFiltered    = r.fonte === 'moto'      && Boolean(params.motoitBrandSlug || params.motoitModelSlug);
    const siteAlreadyFiltered = subitoFiltered || autoscoutFiltered || motoitFiltered;

    if (!siteAlreadyFiltered && !titoloLow.includes(marcaKeyword))                     return false;

    // Modello: filtro titolo solo per MOTO e solo se il sito non ha già filtrato per modello.
    // (Per auto i nomi modello Autoscout sono in inglese "3-Series" e non compaiono nei titoli.)
    // Eccezione: asFilterToken forza il filtro titolo su AS24 anche quando mmmvAutoscout esiste,
    // per isolare submodelli che AS24 colloca sotto un modelId condiviso (es. Diavel V4).
    const subitoModelFiltered    = r.fonte === 'subito'    && Boolean(params.modello);
    const autoscoutModelFiltered = r.fonte === 'autoscout' && Boolean(params.mmmvAutoscout) && !params.asFilterToken;
    // Moto.it filtra per modello quando il client/server ha risolto motoitModelSlug
    const motoitModelFiltered    = r.fonte === 'moto'      && Boolean(params.motoitModelSlug);
    const siteAlreadyFilteredModel = subitoModelFiltered || autoscoutModelFiltered || motoitModelFiltered;

    if (normModello && params.tipo === 'moto' && !siteAlreadyFilteredModel && !titoloNorm.includes(normModello)) return false;

    // Filtro AS24 per asFilterToken (submodello collassato): cerca il token nel titolo normalizzato.
    if (r.fonte === 'autoscout' && params.asFilterToken) {
      const tokenNorm = norm(params.asFilterToken);
      if (tokenNorm && !titoloNorm.includes(tokenNorm)) return false;
    }

    // Narrowing AS24 brand-only per AUTO (§12): serie commerciale / modello irrisolto.
    // Confine-parola su titolo space-normalizzato (vedi autoTokenRe).
    if (autoTokenRe && r.fonte === 'autoscout' && !autoTokenRe.test(normSp(r.titolo))) return false;

    // 3. Filtri numerici
    if (params.prezzoMin != null && r.prezzo != null && r.prezzo < params.prezzoMin)   return false;
    if (params.prezzoMax != null && r.prezzo != null && r.prezzo > params.prezzoMax)   return false;
    if (params.annoMin   != null && r.anno   != null && r.anno   < params.annoMin)     return false;
    if (params.annoMax   != null && r.anno   != null && r.anno   > params.annoMax)     return false;
    if (params.kmMax     != null && r.km     != null && r.km     > params.kmMax)       return false;

    // 4. Filtro geografico regione: NON serve post-filter.
    //    Tutti e 3 gli scraper filtrano server-side:
    //    - Subito: path /annunci-<regione>/...
    //    - AS24:   path /lst-*/<brand>/<model>/<Region>%20(Italy) + lat/lon/zipr
    //    - Moto.it: query region=<slug>
    //    Ci fidiamo del filtro nativo di ciascun sito.

    return true;
  });

  // Conteggio per fonte DOPO il post-filter (riflette ciò che l'utente vede)
  const countBy = f => risultati.filter(r => r.fonte === f).length;
  const asCount = countBy('autoscout');

  // §12: AS24 brand-only narrowato per titolo (serie/modello irrisolto) e finito a 0
  // → reason esplicita, così la UI distingue "0 per filtro titolo" da errore/vuoto-vero.
  const asReason = (autoTokenRe && asCount === 0 && asRes.status === 'ok')
    ? 'modello filtrato per titolo'
    : (asRes.reason || null);

  return {
    risultati,
    totale:       risultati.length,
    subitoStatus: subitoRes.status,           // 'ok' | 'empty' | 'needs_bootstrap' | 'error'
    subitoReason: subitoRes.reason || null,   // 'captcha' | '403' | 'no_data' | timeout msg
    // Stato per-fonte: la UI distingue saltato / vuoto / errore / ok.
    sources: {
      subito:    { status: subitoRes.status, reason: subitoRes.reason || null, count: countBy('subito') },
      autoscout: { status: asRes.status,     reason: asReason,                 count: asCount },
      moto:      { status: motoRes.status,   reason: motoRes.reason || null,   count: countBy('moto') },
    },
  };
}

// ─── §11 Ricerche salvate + avvisi ───────────────────────────────────────────
const SAVED_STALE_MS  = 6 * 60 * 60 * 1000;  // ricontrolla al boot solo se più vecchio di 6h
const SAVED_BOOT_CAP  = 5;                    // max ricerche processate per avvio

// MUTEX unico: TUTTI i check (singolo, tutti, boot) passano da qui → SERIALIZZA
// gli scraping concorrenti (risorse/anti-block). NB l'integrità-file è già
// garantita a parte: recordCheck è sincrono (load→save senza await) e ri-legge
// fresh, quindi atomico anche vs CRUD. Single-processo (Electron forka 1 server).
let savedLock = Promise.resolve();
function withSavedLock(fn) {
  const run = savedLock.then(fn, fn);   // esegue dopo il precedente, anche se errore
  savedLock = run.then(() => {}, () => {});
  return run;
}

// Normalizza i params salvati (stringhe dal frontend) negli stessi tipi che
// l'endpoint produce, riusando parseSearchParams (validazione + int). Fallback
// ai grezzi se non validi.
function normalizeSavedParams(raw) {
  const parsed = parseSearchParams(raw || {});
  return parsed.errors ? { ...raw } : parsed.params;
}

// Check di UNA ricerca (SENZA lock — usato dentro il lock). `s` = oggetto con
// {id, params, label} (da listSaved o getSaved) → niente reload (fix review §19).
async function _checkSavedOne(s) {
  if (!s) return null;
  const out = await runSearch(normalizeSavedParams(s.params));
  const alerts = saved.recordCheck(s.id, out.risultati || []);
  return { id: s.id, label: s.label, nuovi: alerts.length, sources: out.sources };
}

// Check di tutte (o le stantie), SENZA lock. Salta se Subito è bloccato.
async function _checkAll({ onlyStale = false, cap = Infinity } = {}) {
  const esiti = [];
  if (subitoSession.isSubitoBlocked()) {
    console.log('[saved] Subito bloccato → salto il check automatico.');
    return esiti;
  }
  const now = Date.now();
  let done = 0;
  for (const s of saved.listSaved()) {   // s ha già params/label → passato diretto
    if (done >= cap) break;
    if (onlyStale && s.lastChecked && now - s.lastChecked < SAVED_STALE_MS) continue;
    try { esiti.push(await _checkSavedOne(s)); done++; }
    catch (e) { console.warn(`[saved] check ${s.id} fallito: ${e.message}`); }
  }
  return esiti;
}

const checkSaved    = (id)   => withSavedLock(() => _checkSavedOne(saved.getSaved(id)));
const checkAllSaved = (opts) => withSavedLock(() => _checkAll(opts));

// CRUD
app.get('/api/saved', (req, res) => res.json({ saved: saved.listSaved() }));

app.post('/api/saved', express.json(), (req, res) => {
  const { label, params } = req.body || {};
  if (!params || !params.tipo || !params.marca) {
    return res.status(400).json({ error: 'params con tipo+marca obbligatori' });
  }
  res.json({ saved: saved.addSaved({ label, params }) });
});

app.delete('/api/saved/:id', (req, res) => {
  res.json({ ok: saved.removeSaved(req.params.id) });
});

app.post('/api/saved/:id/read', (req, res) => {
  res.json({ ok: saved.markRead(req.params.id) });
});

// Controlla ora: una (?id=) o tutte. Restituisce gli esiti + la lista aggiornata.
app.post('/api/saved/check', express.json(), async (req, res) => {
  try {
    const id = req.query.id;
    const esiti = id ? [await checkSaved(id)].filter(Boolean) : await checkAllSaved({ cap: 20 });
    res.json({ esiti, saved: saved.listSaved() });
  } catch (e) {
    console.error('[saved/check]', e.message);
    res.status(500).json({ error: 'Errore durante il controllo' });
  }
});

// ─── Subito session bootstrap ────────────────────────────────────────────────
// L'utente clicca "Aggiorna sessione Subito" → questo endpoint apre Chrome
// non-headless puntato a subito.it; quando l'utente risolve il CAPTCHA, lo
// storageState viene salvato e le ricerche tornano a funzionare in headless.

let bootstrapInFlight = null;  // promise in corso, evita lanci multipli concorrenti

app.post('/api/subito/bootstrap', express.json(), async (req, res) => {
  if (bootstrapInFlight) {
    return res.status(409).json({ ok: false, reason: 'already_in_progress' });
  }
  bootstrapInFlight = runBootstrap({
    onProgress: msg => console.log('[bootstrap] ' + msg),
  });
  try {
    const result = await bootstrapInFlight;
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, reason: 'exception', error: err.message });
  } finally {
    bootstrapInFlight = null;
  }
});

app.get('/api/subito/status', (req, res) => {
  const state = subitoSession.loadStorageState();
  const info  = subitoSession.inspectSession(state);
  const last  = subitoSession.getLastRefresh();
  res.json({
    health:        subitoSession.getSessionHealth(),  // 'ok' | 'expiring_soon' | 'blocked' | 'never_configured'
    blocked:       subitoSession.isSubitoBlocked(),
    hasSession:    Boolean(state),
    hasDataDome:   info.hasDataDome,
    expiresIn:     info.expiresIn,        // secondi residui o null
    bootstrapping: Boolean(bootstrapInFlight),
    lastRefresh:   last.at,               // timestamp ms ultimo keep-alive riuscito (o null)
    lastRefreshOk: last.ok,               // bool: ultimo tentativo
  });
});

// Endpoint per forzare un keep-alive on-demand (es. utente clicca "rinfresca ora")
app.post('/api/subito/keep-alive', express.json(), async (req, res) => {
  const result = await keepAliveSubito();
  res.json(result);
});

const server = app.listen(PORT, () => {
  console.log(`Server avviato su http://localhost:${PORT}`);
  // Pre-warm Chromium: primo lancio sposta il costo (3-5s × 3 browser) dal
  // primo /api/search al boot, eliminando il rischio di timeout sulla prima
  // ricerca quando i 3 scraper partono in parallelo.
  Promise.allSettled([
    scrapeSubito.warmup?.(),
    scrapeAutoscout.warmup?.(),
    scrapeMotoIt.warmup?.(),
  ]).then(res => {
    const names = ['Subito', 'AS24', 'MotoIt'];
    res.forEach((r, i) => {
      if (r.status === 'rejected') console.warn(`[prewarm] ${names[i]} KO: ${r.reason?.message || r.reason}`);
      else                         console.log(`[prewarm] ${names[i]} OK`);
    });

    // Boot keep-alive immediato (se c'è già una session) — rinfresca il cookie
    // all'avvio dell'app, prima che l'utente lanci la prima ricerca.
    const state = subitoSession.loadStorageState();
    if (state) {
      keepAliveSubito().then(r => {
        console.log('[keep-alive boot] ' + (r.ok ? 'OK' : 'FAIL ' + r.reason));
      });
    }
    startKeepAlive();

    // §11 — boot-check ricerche salvate (gentile): solo le stantie (>6h), cap 5,
    // sequenziale, non bloccante, salta se Subito è bloccato. Ritardo per non
    // competere col keep-alive boot.
    setTimeout(() => {
      checkAllSaved({ onlyStale: true, cap: SAVED_BOOT_CAP })
        .then(esiti => {
          const tot = esiti.reduce((a, e) => a + (e?.nuovi || 0), 0);
          if (esiti.length) console.log(`[saved] boot-check: ${esiti.length} ricerche, ${tot} nuovi avvisi.`);
        })
        .catch(e => console.warn('[saved] boot-check KO:', e.message));
    }, 8000).unref?.();
  });
});
module.exports = server;
