const express = require('express');
const path = require('path');
const scrapeSubito    = require('./scrapers/subito-playwright');
const scrapeAutoscout = require('./scrapers/autoscout-playwright');
const scrapeMotoIt    = require('./scrapers/motoit');
const province        = require('../data/province.json');
const modelsData      = require('../data/models.json');

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
      subito:    b.subito    || null,
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
  if (!entry) return res.json({ modelli: [], brandKey: null, sites: [] });

  // entry.models è sempre un array nel nuovo schema unificato (sia auto sia moto)
  const modelli = (entry.models || []).map(m => ({
    nome:           m.nome,
    sites:          m.sites || [],
    slugSubito:     m.slugSubito     || '',
    subitoKey:      m.subitoKey      || '',
    mmmvAutoscout:  m.mmmvAutoscout  || '',
    kindAS:         m.kindAS         || '',
    slugMotoIt:     m.slugMotoIt     || '',
  }));
  const brandKey = entry.subito?.brandKey || null;
  res.json({ modelli, brandKey, sites: entry.sites || [] });
});

// Set di regioni valide (derivato da province.json)
const REGIONI_VALIDE = new Set(Object.values(province).map(p => p.regione));

// Validazione e sanitizzazione parametri ricerca
function parseSearchParams(query) {
  const {
    tipo, marca, modello, prezzoMin, prezzoMax, annoMin, annoMax, kmMax, regione,
    slugSubito, slugAutoscout, slugMoto, mmmvAutoscout, modelloSlugSubito, modelloSlugMoto, slugMotoAs,
    motoBrandKey, motoModelKey,
    motoitBrandSlug, motoitModelSlug,
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

  return {
    params: {
      tipo:          tipo.trim(),
      marca:         marca.trim(),
      modello:       modello ? modello.trim() : '',
      regione:       regione ? regione.trim() : '',
      prezzoMin:     toInt(prezzoMin),
      prezzoMax:     toInt(prezzoMax),
      annoMin:       toInt(annoMin),
      annoMax:       toInt(annoMax),
      kmMax:         toInt(kmMax),
      slugSubito:         slugSubito         || null,
      slugAutoscout:      slugAutoscout      || null,
      slugMoto:           slugMoto           || null,
      mmmvAutoscout:      mmmvAutoscout      || null,
      modelloSlugSubito:  modelloSlugSubito  || null,
      modelloSlugMoto:    modelloSlugMoto    || null,
      slugMotoAs:         slugMotoAs         || null,
      motoBrandKey:       motoBrandKey       || null,
      motoModelKey:       motoModelKey       || null,
      motoitBrandSlug:    motoitBrandSlug    || null,
      motoitModelSlug:    motoitModelSlug    || null,
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

app.get('/api/search', async (req, res) => {
  const parsed = parseSearchParams(req.query);
  if (parsed.errors) {
    return res.status(400).json({ error: parsed.errors.join(', ') });
  }

  const { params } = parsed;

  // ── Risoluzione metadata per-sito dal catalogo unificato ──────────────────
  // La verità su "brand/modello è su AS24 / Subito / MotoIt?" sta in data/models.json.
  // Il server risolve autonomamente i metadata a partire da (marca, modello) —
  // il client può anche non passare mmmv/slug, e il server li deriva dal DB.
  const brandEntry = modelsData[params.tipo]?.[params.marca] || null;
  const asMeta     = brandEntry?.autoscout || null;
  const subMeta    = brandEntry?.subito    || null;

  // Match modello tramite nome (tolleranza minima: trim + compare diretto)
  const modelEntry = params.modello && brandEntry?.models
    ? brandEntry.models.find(m => m.nome === params.modello.trim())
    : null;

  // Se il client non ha passato i campi metadata, li deriviamo dal DB.
  if (modelEntry) {
    if (!params.mmmvAutoscout     && modelEntry.mmmvAutoscout) params.mmmvAutoscout     = modelEntry.mmmvAutoscout;
    if (!params.modelloSlugSubito && modelEntry.slugSubito)    params.modelloSlugSubito = modelEntry.slugSubito;
    if (!params.motoModelKey      && modelEntry.subitoKey && params.tipo === 'moto') {
      params.motoModelKey = modelEntry.subitoKey;
    }
    // Submodelli che su AS24 sono collassati sotto un modelId condiviso
    // (es. Ducati Diavel V4 sta in modelId=70147 insieme a Diavel 1260 e Diavel classico).
    // asFilterToken = sottostringa da cercare nel titolo AS24 per isolare il submodello.
    params.asFilterToken = modelEntry.asFilterToken || null;
  }
  if (brandEntry && params.tipo === 'moto' && !params.motoBrandKey && subMeta?.brandKey) {
    params.motoBrandKey = subMeta.brandKey;
  }

  // ── Slug Moto.it (SOLO da catalogo esplicito, niente fallback fallaci) ────
  // Moto.it espone filtri via /moto-usate/ricerca?brand=<slugBrand>&model=<slugBrand>|<slugModel>.
  // La verità su presenza brand/modello è in data/models.json (merge del catalogo Moto.it).
  // NIENTE fallback su slugAS/slugSubito: genererebbero URL fallaci (brand=xxx inesistente
  // su Moto.it → zero risultati, o peggio risultati diversi da quelli attesi).
  if (params.tipo === 'moto') {
    if (!params.motoitBrandSlug && brandEntry?.motoit?.brandSlug) {
      params.motoitBrandSlug = brandEntry.motoit.brandSlug;
    }
    if (!params.motoitModelSlug && modelEntry?.slugMotoIt) {
      params.motoitModelSlug = modelEntry.slugMotoIt;
    }
  }

  const brandOnSubito    = Boolean(subMeta) || !brandEntry; // brand sconosciuto → tentiamo
  const brandOnAutoscout = Boolean(asMeta);
  const brandOnMotoIt    = Boolean(brandEntry?.motoit?.brandSlug);

  const modelSpecified   = Boolean(params.modello);
  const modelOnSubito    = modelEntry ? (modelEntry.sites || []).includes('subito')    : true;
  const modelOnAutoscout = modelEntry ? (modelEntry.sites || []).includes('autoscout') : Boolean(params.mmmvAutoscout);
  const modelOnMotoIt    = modelEntry ? (modelEntry.sites || []).includes('motoit')    : true;

  // Passa mmmv AS24 al scraper: livello modello > livello brand.
  // Filtro regione: gestito lato scraper con zip=<Region> (Italy)+zipr+lat/lon
  // sul path /lst?mmmv= (verificato contro l'UI AS24; non servono slug per-modello).
  if (brandOnAutoscout) {
    params.autoscoutMmmv = params.mmmvAutoscout || `${asMeta.makeId}|||`;
  }

  // Skippa siti dove il modello non esiste (D3=a simmetrico su entrambi i siti).
  const skipAutoscout = !brandOnAutoscout || (modelSpecified && modelEntry && !modelOnAutoscout);
  const skipSubito    = !brandOnSubito    || (modelSpecified && modelEntry && !modelOnSubito);
  // Skippa Moto.it se il brand non è nel catalogo motoit (niente fallback → niente URL fallaci).
  const skipMotoIt    = params.tipo !== 'moto'
                        || !brandOnMotoIt
                        || (modelSpecified && modelEntry && !modelOnMotoIt);

  const scrapers = [
    skipSubito
      ? Promise.resolve([])
      : withTimeout(scrapeSubito(params),    TIMEOUT_MS, 'Subito.it'),
    skipAutoscout
      ? Promise.resolve([])
      : withTimeout(scrapeAutoscout(params), TIMEOUT_MS, 'Autoscout24'),
    skipMotoIt
      ? Promise.resolve([])
      : withTimeout(scrapeMotoIt(params), TIMEOUT_MS, 'Moto.it'),
  ];

  const grezzi = (await Promise.all(scrapers)).flat();

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
    //    - Subito auto:  brand nel path /vendita/auto/{marca}/, modello in /{modello}/
    //    - Subito moto:  brand via param bb=, modello via param bm= (motoBrandKey/motoModelKey)
    //    - Autoscout/Moto.it: brand sempre nel path → fidiamoci del sito.
    //    Senza questa eccezione il post-filter scarta annunci validi con titoli "creativi"
    //    (es. "KTM Adventure 1190" cercando "1190 Adventure", o "Giulia TI 2.2" senza "Alfa").
    const subitoFiltered    = r.fonte === 'subito'    && (params.tipo === 'auto' || params.motoBrandKey);
    const autoscoutFiltered = r.fonte === 'autoscout' && Boolean(params.autoscoutMmmv);
    // Moto.it filtra server-side via ?brand= (quasi sempre presente) o ?model=
    const motoitFiltered    = r.fonte === 'moto'      && Boolean(params.motoitBrandSlug || params.motoitModelSlug);
    const siteAlreadyFiltered = subitoFiltered || autoscoutFiltered || motoitFiltered;

    if (!siteAlreadyFiltered && !titoloLow.includes(marcaKeyword))                     return false;

    // Modello: filtro titolo solo per MOTO e solo se il sito non ha già filtrato per modello.
    // (Per auto i nomi modello Autoscout sono in inglese "3-Series" e non compaiono nei titoli.)
    // Eccezione: asFilterToken forza il filtro titolo su AS24 anche quando mmmvAutoscout esiste,
    // per isolare submodelli che AS24 colloca sotto un modelId condiviso (es. Diavel V4).
    const subitoModelFiltered    = r.fonte === 'subito'    && (params.modelloSlugSubito || params.motoModelKey);
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

  res.json({ risultati, totale: risultati.length });
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
  });
});
module.exports = server;
