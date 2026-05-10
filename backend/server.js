const express = require('express');
const path = require('path');
const scrapeSubito    = require('./scrapers/subito-playwright');
const scrapeAutoscout = require('./scrapers/autoscout-playwright');
const scrapeMotoIt    = require('./scrapers/motoit');
const subitoSession   = require('./scrapers/subito-session');
const { runBootstrap } = require('./scrapers/subito-bootstrap');
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

// Set di regioni valide (derivato da province.json)
const REGIONI_VALIDE = new Set(Object.values(province).map(p => p.regione));

// Validazione e sanitizzazione parametri ricerca
function parseSearchParams(query) {
  const {
    tipo, marca, modello, prezzoMin, prezzoMax, annoMin, annoMax, kmMax, regione,
    mmmvAutoscout, motoitBrandSlug, motoitModelSlug,
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

  // Subito non riceve più metadata per sito: cerca sempre con ?q=marca+modello.
  // Autoscout24 usa mmmvAutoscout, Moto.it usa motoitBrandSlug/motoitModelSlug.
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
    }
  };
}

// Wrapper timeout: se uno scraper fallisce restituisce [] senza bloccare gli altri
async function withTimeout(promise, ms, nomeSito) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout su ${nomeSito}`)), ms)
  );
  try {
    return await Promise.race([promise, timeout]);
  } catch (err) {
    console.warn(`[WARN] ${err.message}`);
    return [];
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
    return { items, status: 'ok' };
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

  const { params } = parsed;

  // ── Risoluzione metadata per-sito dal catalogo unificato ──────────────────
  // Subito: niente metadata da risolvere — usa sempre ?q=marca+modello.
  // Autoscout24: serve mmmvAutoscout (livello modello, fallback livello brand).
  // Moto.it: servono motoitBrandSlug + motoitModelSlug (slug-based, niente fallback).
  const brandEntry = modelsData[params.tipo]?.[params.marca] || null;
  const asMeta     = brandEntry?.autoscout || null;

  // Match modello tramite nome (tolleranza minima: trim + compare diretto)
  const modelEntry = params.modello && brandEntry?.models
    ? brandEntry.models.find(m => m.nome === params.modello.trim())
    : null;

  if (modelEntry) {
    if (!params.mmmvAutoscout && modelEntry.mmmvAutoscout) params.mmmvAutoscout = modelEntry.mmmvAutoscout;
    // Submodelli che su AS24 sono collassati sotto un modelId condiviso
    // (es. Ducati Diavel V4 sta in modelId=70147 insieme a Diavel 1260 e Diavel classico).
    // asFilterToken = sottostringa da cercare nel titolo AS24 per isolare il submodello.
    params.asFilterToken = modelEntry.asFilterToken || null;
  }

  // ── Slug Moto.it (SOLO da catalogo esplicito, niente fallback fallaci) ────
  // Moto.it espone filtri via /moto-usate/ricerca?brand=<slugBrand>&model=<slugBrand>|<slugModel>.
  // La verità su presenza brand/modello è in data/models.json (merge del catalogo Moto.it).
  // NIENTE fallback su slugAS: genererebbe URL fallaci (brand=xxx inesistente
  // su Moto.it → zero risultati, o peggio risultati diversi da quelli attesi).
  if (params.tipo === 'moto') {
    if (!params.motoitBrandSlug && brandEntry?.motoit?.brandSlug) {
      params.motoitBrandSlug = brandEntry.motoit.brandSlug;
    }
    if (!params.motoitModelSlug && modelEntry?.slugMotoIt) {
      params.motoitModelSlug = modelEntry.slugMotoIt;
    }
  }

  const brandOnAutoscout = Boolean(asMeta);
  const brandOnMotoIt    = Boolean(brandEntry?.motoit?.brandSlug);

  // Passa mmmv AS24 al scraper: livello modello > livello brand.
  // Filtro regione: gestito lato scraper con zip=<Region> (Italy)+zipr+lat/lon
  // sul path /lst?mmmv= (verificato contro l'UI AS24; non servono slug per-modello).
  if (brandOnAutoscout) {
    params.autoscoutMmmv = params.mmmvAutoscout || `${asMeta.makeId}|||`;
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

  // Log informativo quando interroghiamo AS24/MotoIt a livello brand-only
  // (fallback che si appoggia al post-filter sul titolo).
  if (params.modello && brandOnAutoscout && !params.mmmvAutoscout) {
    console.log(`[server] AS24 brand-only fallback per "${params.marca} ${params.modello}" (mmmv specifico assente)`);
  }
  if (params.modello && params.tipo === 'moto' && brandOnMotoIt && !params.motoitModelSlug) {
    console.log(`[server] Moto.it brand-only fallback per "${params.marca} ${params.modello}" (slug specifico assente)`);
  }

  // Subito ha wrapper dedicato per propagare 'needs_bootstrap' al frontend
  const [subitoRes, asItems, motoItems] = await Promise.all([
    runSubito(params, TIMEOUT_MS),
    skipAutoscout
      ? Promise.resolve([])
      : withTimeout(scrapeAutoscout(params), TIMEOUT_MS, 'Autoscout24'),
    skipMotoIt
      ? Promise.resolve([])
      : withTimeout(scrapeMotoIt(params), TIMEOUT_MS, 'Moto.it'),
  ]);

  const grezzi = [...subitoRes.items, ...asItems, ...motoItems];

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

  res.json({
    risultati,
    totale:       risultati.length,
    subitoStatus: subitoRes.status,           // 'ok' | 'needs_bootstrap' | 'error'
    subitoReason: subitoRes.reason || null,   // 'captcha' | '403' | 'no_data' | timeout msg
  });
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
  });
});
module.exports = server;
