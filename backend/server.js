const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const logger = require('./logger').install();
const express = require('express');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const filtriAuto = require('./filtri-auto');
const versioneVerifica = require('./versione-verifica');
const auth = require('./auth');
const utentiDb = require('./utenti-db');
const salute = require('./fonti-salute');
const qrcode = require('qrcode-generator');
const scrapeAutoscoutGraphql = require('./scrapers/autoscout-graphql');
const { combaciaModello } = require('./scrapers/autoscout-graphql');
const scrapeSubitoApi = require('./scrapers/subito-api');
const scrapeMotoIt    = require('./scrapers/motoit');
const { resolveMotoitSlug } = require('./scrapers/motoit-brands');
const { famiglieMotoit, getBrandModels, getModelBikes, resolveMotoitVersionEntry, correggiModelSlug } = require('./scrapers/motoit-models');
const motoitVersione = require('./scrapers/motoit-versione');
const { getDetail, fonteFromUrl } = require('./scrapers/detail');
const annullo        = require('./annullo');
const budget = require('./budget-richieste');
const { risolviNodo, marcaPseudo } = require('./scrapers/subito-nodo');
const { unisciGemelli, marcheNascoste, sinonimiTendina } = require('./menu-gemelli');
const { versioniDi } = require('./versioni-menu');
const { agganciaSubito } = require('./scrapers/ponte-buchi');
const { codiciAs24, unisciCodici, famigliaSubito, famiglieSubito } = require('./scrapers/as24-modelli');

const { makeModelResolver, resolveAs24Narrowing, as24Spellings, norm } = require('./scrapers/brand-match');
const { catalogResolver, lookupBrand, lookupModelGroup } = require('./catalogo-ricerca');
const province        = require('../data/province.json');
const regionCentroids = require('../data/region-centroids.json');

const comuneRegione = require('../data/comune-regione.json');

const { cerchioRegione } = require('./scrapers/utils');
const modelsData      = require('../data/models.json');

const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
const PORT = process.env.PORT || 3000;

const TIMEOUT_MS = 45000;

async function scrapeAutoscoutSmart(params, opts = {}) {
  return scrapeAutoscoutGraphql(params, opts);
}

async function scrapeAutoscoutUnion(params, opts = {}) {
  const grafie = params.autoscoutSpellings;
  if (!grafie || grafie.length < 2) return scrapeAutoscoutSmart(params, opts);

  const conVersione = g => [g, params.versione].filter(Boolean).join(' ');

  const errori = [], parziali = [];
  let hasMore = false;
  const liste = await Promise.all(grafie.map(async g => {
    try {
      const r = await scrapeAutoscoutGraphql({ ...params, autoscoutVersionText: conVersione(g) },
        { ...opts, withMeta: true, retainPages: true });
      if (r.parziale) parziali.push(r.parziale);
      if (r.bloccoParziale) errori.push(r.bloccoParziale);
      if (r.hasMore) hasMore = true;
      if (r.erroreTipo && !r.bloccoParziale) errori.push({
        kind: r.erroreTipo, status: r.erroreHttp, code: r.erroreCodice,
        message: r.parziale || 'pagina non letta',
      });
      return r.items;
    } catch (e) { errori.push(e); return []; }
  }));

  const byUrl = new Map();
  for (const lista of liste) for (const r of lista) if (r && r.url && !byUrl.has(r.url)) byUrl.set(r.url, r);

  if (errori.length && byUrl.size === 0) throw errori[0];

  const parziale = [errori.length ? `${errori.length}/${grafie.length} grafie AS24 non lette per intero: ${errori[0].message}` : null, ...parziali].filter(Boolean).join(' · ') || null;

  const respinte = errori.filter(e => e && e.kind === 'blocked');

  const bloccoParziale = respinte.find(e => e.status === 429)
    || respinte.find(e => e.code !== 'FONTE_IN_PAUSA') || respinte[0] || null;
  const peggiore = errori.find(e => e?.status === 429) || errori.find(e => e?.kind === 'blocked') || errori[0];
  if (!errori.length && scrapeAutoscoutGraphql._clearRetryPages) for (const g of grafie)
    scrapeAutoscoutGraphql._clearRetryPages({ ...params, autoscoutVersionText: conVersione(g) }, opts);
  return { items: [...byUrl.values()], total: null, hasMore, parziale,
    parzialeRete: !!errori.length, erroreTipo: peggiore?.kind || null,
    erroreHttp: peggiore?.status || null,
    erroreCodice: errori.find(e => e?.code === 'AS24_BODY_TOO_LARGE')?.code || peggiore?.code || null,
    bloccoParziale };
}

async function scrapeSubitoSmart(params) {
  return scrapeSubitoApi(params, { sort: 'priceasc', withMeta: true, fetta: params.fetta || 0,
    mainStart: params.subitoMainStart, recuperoStart: null, senzaRecupero: true });
}

const { gateAuth, postLogin, loginAttempts, percorsoGate, soloOwner, SOLO_OWNER, AUTH_FREE,
  tettoGiornaliero, TETTO_GIORNALIERO, clientIp, chiaveLimite } = require('./accesso-route').mount(app, { logger });

require('./report-route').mount(app, { chiaveLimite });

require('./frontend-route').mount(app);

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
    }));

  if (tipo === 'moto') {
    const raggiunte = new Set(lista.map(b => resolveMotoitSlug(b.nome)).filter(Boolean));
    let cat = null;
    try { cat = require('../data/motoit-catalogo.json'); } catch (_) { cat = null; }
    for (const [slug, m] of Object.entries((cat && (cat.marche || cat)) || {})) {
      if (raggiunte.has(slug) || !m || !Object.keys(m.modelli || {}).length) continue;
      lista.push({ nome: m.nome || slug, sites: ['motoit'], autoscout: null });
    }
  }

  const nascoste = marcheNascoste(tipo);
  const visibili = lista.filter(b => !nascoste.has(b.nome));
  visibili.sort((a, b) => a.nome.localeCompare(b.nome, 'it', { sensitivity: 'base' }));
  res.json({ brands: visibili, sinonimi: sinonimiTendina(tipo) });
});

app.get('/api/models', async (req, res) => {
  const { tipo, marca } = req.query;
  if (!tipo || !['auto', 'moto'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo deve essere "auto" o "moto"' });
  }
  if (!marca || typeof marca !== 'string' || marca.trim().length === 0) {
    return res.status(400).json({ error: 'marca obbligatoria' });
  }
  const entry = modelsData[tipo]?.[marca.trim()];

  const modelli = ((entry && entry.models) || []).map(m => ({
    nome:           m.nome,
    sites:          m.sites || [],
    mmmvAutoscout:  m.mmmvAutoscout  || '',

    slugMotoIt:     correggiModelSlug(m.slugMotoIt || ''),
  }));

  modelli.push(...unisciGemelli(tipo, marca.trim(), modelli, modelsData));
  modelli.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));

  let motoitKo = null;
  if (tipo === 'moto') {
    const brandSlug = (entry && entry.motoit && entry.motoit.brandSlug) || resolveMotoitSlug(marca.trim()) || null;
    if (brandSlug) {
      try {

        const apiModels = await getBrandModels(brandSlug, { rilancia: true });
        const byName = new Map(modelli.map(m => [norm(m.nome), m]));
        for (const am of apiModels) {
          const hit = byName.get(norm(am.name));
          if (hit) { if (!hit.slugMotoIt) hit.slugMotoIt = am.slug; }
          else {
            const nm = { nome: am.name, sites: ['motoit'], mmmvAutoscout: '', slugMotoIt: am.slug };
            modelli.push(nm); byName.set(norm(am.name), nm);
          }
        }
        modelli.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
      } catch (e) { console.warn('[api/models] merge Moto.it KO:', e.message); motoitKo = e.message || 'moto.it non raggiungibile'; }
    }
  }

  res.json({ modelli, sites: (entry && entry.sites) || (tipo === 'moto' ? ['motoit'] : []),
    ...(motoitKo ? { fonteMotoitKo: motoitKo } : {}) });
});

require('./veicolo-dati-route').mount(app);

app.get('/api/versioni', (req, res) => {
  const tipo = String((req.query || {}).tipo || '');
  const marca = String((req.query || {}).marca || '').trim();
  const modello = String((req.query || {}).modello || '').trim();
  if (!['auto', 'moto'].includes(tipo)) return res.status(400).json({ error: 'tipo deve essere "auto" o "moto"' });
  if (!marca || !modello) return res.status(400).json({ error: 'marca e modello obbligatori' });
  res.json({ versioni: versioniDi(tipo, marca, modello) });
});

const limiteDettaglio = require('./limite-richieste').crea({ max: 30, cosa: 'richieste di dettagli alle fonti' });
app.get('/api/detail', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url obbligatorio' });
  try {
    const detail = await getDetail(url, { onRequest: () => {
      const gDet = limiteDettaglio.consuma(chiaveLimite(req));
      if (!gDet.ok) throw Object.assign(new Error(limiteDettaglio.messaggio(gDet)),
        { code: 'AMR_DETAIL_LIMIT', riprovaFra: gDet.attesa });
    } });
    if (!detail) return res.json({ ok: false, detail: null });
    const fonte = fonteFromUrl(url);
    res.json({ ok: true, detail, fonte, pausa: salute.fermo(fonte) });
  } catch (e) {
    if (e.code === 'AMR_DETAIL_LIMIT') {
      return res.status(429).json({ ok: false, error: e.message, limiteDettaglio: true, riprovaFra: e.riprovaFra });
    }
    if (e.code === 'DETAIL_BODY_TOO_LARGE') {
      return res.status(502).json({ ok: false, error: e.message, detailTroppoGrande: true, fonte: e.fonte });
    }
    if (e.status === 429 || e.code === 'FONTE_IN_PAUSA') {
      return res.status(502).json({ ok: false, error: e.message, fonte: e.fonte, pausa: salute.fermo(e.fonte) });
    }
    return res.status(400).json({ error: e.message });
  }
});

let funnelCache = { ts: 0, url: null };
const FUNNEL_TTL = 60 * 1000;

let funnelInVolo = null;
function tailscalePublicUrl(cb) {
  if (Date.now() - funnelCache.ts < FUNNEL_TTL) return cb(funnelCache.url);
  if (funnelInVolo) { funnelInVolo.push(cb); return; }
  funnelInVolo = [cb];
  const bins = ['/usr/local/bin/tailscale', 'tailscale'];
  let i = 0;
  const done = url => {
    funnelCache = { ts: Date.now(), url };
    const attese = funnelInVolo; funnelInVolo = null;
    for (const f of attese) f(url);
  };
  const tryNext = () => {
    if (i >= bins.length) return done(null);
    execFile(bins[i++], ['funnel', 'status'], { timeout: 3000 }, (err, stdout) => {
      if (err) return err.code === 'ENOENT' ? tryNext() : done(null);
      const m = String(stdout).match(/https:\/\/[^\s]+/);
      done(m ? m[0].replace(/\/$/, '') : null);
    });
  };
  tryNext();
}

app.get('/api/public-url', (req, res) => {
  tailscalePublicUrl(url => {
    if (!url) return res.json({ url: null, svg: null });
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    res.json({ url, svg: qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }) });
  });
});

const REGIONI_VALIDE = new Set(Object.values(province).map(p => p.regione));

const normReg = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const REGIONE_BY_NORM = new Map([...REGIONI_VALIDE].map(slug => [normReg(slug), slug]));
const canonRegione = s => REGIONE_BY_NORM.get(normReg(s)) || null;

const FONTI_PAGINA = ['subito', 'autoscout', 'moto'];
function parseSearchParams(query) {
  const {
    tipo, marca, modello, prezzoMin, prezzoMax, annoMin, annoMax, kmMin, kmMax, regione, raggio,
    mmmvAutoscout, motoitBrandSlug, motoitModelSlug, motoitBikeCode, versione, fetta, fonti,
    subitoMainStart, subitoRecuperoStart,
  } = query;

  const errors = [];
  if (!tipo || !['auto', 'moto'].includes(tipo)) errors.push('tipo deve essere "auto" o "moto"');
  if (!marca || typeof marca !== 'string' || marca.trim().length === 0) errors.push('marca obbligatoria');

  if (modello != null && typeof modello !== 'string') errors.push('modello deve essere una stringa sola');
  if (regione && !canonRegione(regione)) errors.push(`regione non valida: ${regione}`);

  const primaPagina = fetta === '0' || fetta === 0;
  let fontiPagina = null;
  if (fonti != null) {
    const voci = typeof fonti === 'string' ? fonti.split(',') : [];
    if (!(Number(fetta) > 0 || primaPagina) || !voci.length || new Set(voci).size !== voci.length
        || voci.some(f => !FONTI_PAGINA.includes(f))) errors.push('fonti della pagina non valide');
    else fontiPagina = FONTI_PAGINA.filter(f => voci.includes(f)).join(',');
  }
  const cursoriSubito = subitoMainStart !== undefined || subitoRecuperoStart !== undefined;
  const cursoreSubito = v => v === '-1' ? null
    : typeof v === 'string' && /^(?:0|[1-9]\d*)$/.test(v) && Number(v) % 50 === 0
      && Number(v) <= 2500 ? Number(v) : undefined;
  if (cursoriSubito && (!(Number(fetta) > 0 || primaPagina) || !fontiPagina?.split(',').includes('subito')
      || cursoreSubito(subitoMainStart) === undefined
      || cursoreSubito(subitoRecuperoStart) === undefined)) errors.push('cursori Subito non validi');
  if (errors.length) return { errors };

  const toInt = (val) => {
    const n = parseInt(val, 10);
    return isNaN(n) || n < 0 ? null : n;
  };

  return {
    params: {
      tipo:             tipo.trim(),
      marca:            marca.trim(),
      modello:          modello ? modello.trim() : '',
      regione:          regione ? (canonRegione(regione) || '') : '',
      prezzoMin:        toInt(prezzoMin),
      prezzoMax:        toInt(prezzoMax),
      annoMin:          toInt(annoMin),
      annoMax:          toInt(annoMax),
      kmMin:            toInt(kmMin),
      kmMax:            toInt(kmMax),
      raggio:           toInt(raggio),

      fetta:            Math.min(50, Math.max(0, toInt(fetta) || 0)),
      fontiPagina,
      subitoMainStart: cursoriSubito ? cursoreSubito(subitoMainStart) : undefined,
      subitoRecuperoStart: cursoriSubito ? cursoreSubito(subitoRecuperoStart) : undefined,
      mmmvAutoscout:    mmmvAutoscout    || null,
      motoitBrandSlug:  motoitBrandSlug  || null,

      motoitModelSlug:  correggiModelSlug(motoitModelSlug || '') || null,
      motoitBikeCode:   motoitBikeCode   || null,

      versione:         versione ? String(versione).trim().slice(0, 80) : null,

      filtriAuto:       tipo.trim() === 'auto' ? filtriAuto.leggiDaQuery(query) : {},
    }
  };
}

function sciogli(r) {
  if (Array.isArray(r)) return { items: r, total: null, parziale: null, sospetto: null };
  return {
    items: (r && r.items) || [],
    total: (r && Number.isFinite(r.total)) ? r.total : null,
    hasMore: (r && typeof r.hasMore === 'boolean') ? r.hasMore : null,
    mainNextStart: r?.mainNextStart ?? null,
    limiteRaggiunto: r?.limiteRaggiunto === true,
    recuperoNextStart: r?.recuperoNextStart ?? null,
    erroreTipo: (r && r.erroreTipo) || null,
    erroreHttp: (r && r.erroreHttp) || null,
    erroreCodice: (r && r.erroreCodice) || null,
    erroriSubito: (r && r.erroriSubito) || [],

    parziale: (r && r.parziale) || null,

    parzialeRete: (r && r.parzialeRete) || null,

    sospetto: (r && r.sospetto) || null,

    totaleLargo: (r && r.totaleLargo) || null,

    bloccoParziale: (r && r.bloccoParziale) || null,
  };
}

async function runSource(lavoro, ms, nomeSito, chiaveFonte) {
  const segna = (errore, conteggio) => { if (chiaveFonte) salute.registra(chiaveFonte, { errore, conteggio }); };
  const ctrl = new AbortController();
  let scattato;
  const timeout = new Promise((_, reject) => {
    scattato = setTimeout(() => { ctrl.abort(); reject(new Error('__timeout__')); }, ms);
  });
  try {

    const avviato = typeof lavoro === 'function' ? annullo.dentro(ctrl.signal, lavoro) : lavoro;

    const s = sciogli(await Promise.race([avviato, timeout]));

    if (s.sospetto) {

      segna(Object.assign(new Error(s.sospetto), { kind: 'error' }), 0);
      return { ...s, status: 'error', reason: s.sospetto, erroreTipo: 'error' };
    }

    if (s.bloccoParziale) segna(s.bloccoParziale, s.items.length);
    else segna(null, s.items.length);

    return { ...s, status: s.items.length ? 'ok' : s.parzialeRete ? 'error' : 'empty', reason: s.parziale || null };
  } catch (err) {
    const isTimeout = err.message === '__timeout__';

    ctrl.abort();

    segna(isTimeout ? Object.assign(new Error('timeout'), { kind: 'transient' }) : err, 0);
    console.warn(`[WARN] ${nomeSito}: ${isTimeout ? 'timeout' : err.message}`);
    return { items: [], status: isTimeout ? 'timeout' : 'error', reason: isTimeout ? 'timeout' : err.message,
      erroreTipo: isTimeout ? 'transient' : err.kind || 'error', erroreHttp: err.status || null,
      erroreCodice: err.code || null };
  } finally { clearTimeout(scattato); }
}

async function runSubito(params, ms, chiaveFonte) {

  const segna = (errore, conteggio) => { if (chiaveFonte) salute.registra(chiaveFonte, { errore, conteggio }); };

  const ctrl = new AbortController();
  let scattato;
  const timeout = new Promise((_, reject) => {
    scattato = setTimeout(() => {
      reject(Object.assign(new Error('Timeout su Subito.it'), { code: 'AMR_TIMEOUT', kind: 'transient' }));
      ctrl.abort();
    }, ms);
  });
  try {
    const avviato = annullo.dentro(ctrl.signal, () => scrapeSubitoSmart(params));

    const s = sciogli(await Promise.race([avviato, timeout]));

    if (s.sospetto) {
      segna(s.bloccoParziale || Object.assign(new Error(s.sospetto), { kind: 'error' }), 0);
      return { ...s, status: 'error', reason: s.sospetto, erroreTipo: 'error' };
    }

    if (s.bloccoParziale) segna(s.bloccoParziale, s.items.length);
    else if (s.parzialeRete && !s.items.length) segna(Object.assign(new Error(s.parziale || 'risposta parziale'), { kind: 'transient' }), 0);
    else segna(null, s.items.length);
    return { ...s, status: s.items.length ? 'ok' : s.parzialeRete ? 'error' : 'empty', reason: s.parziale || null };
  } catch (err) {
    ctrl.abort();
    segna(err, 0);
    console.warn('[WARN] ' + err.message);
    const isTimeout = err.code === 'AMR_TIMEOUT';
    const avviso = err.status === 429 ? scrapeSubitoApi.AVVISO_429 : null;
    return { items: [], status: isTimeout ? 'timeout' : 'error', reason: avviso || err.message, parziale: avviso,
      erroreTipo: isTimeout ? 'transient' : err.kind || 'error', erroreHttp: err.status || null,
      erroreCodice: err.code === 'SUBITO_BODY_TOO_LARGE' ? err.code : null,
      erroriSubito: err.erroriSubito || [] };
  } finally { clearTimeout(scattato); }
}

const limiteRicerche = require('./limite-richieste').crea({ max: 60, cosa: 'ricerche' });
app.get('/api/search', async (req, res) => {
  const gRic = limiteRicerche.consuma(chiaveLimite(req));
  if (!gRic.ok) return res.status(429).json({ error: limiteRicerche.messaggio(gRic), riprovaFra: gRic.attesa, restanti: 0 });
  const parsed = parseSearchParams(req.query);
  if (parsed.errors) {
    return res.status(400).json({ error: parsed.errors.join(', ') });
  }
  parsed.params._cacheScope = req.authId || 'locale';

  let passa = false;
  tettoGiornaliero(req, res, () => { passa = true; });
  if (!passa) return;
  try {
    const out = await runSearch(parsed.params);
    res.json(out);
  } catch (e) {
    console.error('[runSearch]', e.message);
    res.status(500).json({ error: 'Errore interno durante la ricerca' });
  }
});

require('./registrazioni-route').mount(app, { json: express.json({ limit: '4kb' }), chiaveLimite, clientIp });

require('./dati-utente').mount(app, { json: express.json({ limit: '8kb' }), utenteDi: req => req.authId || 'owner', chiaveLimite });

require('./scheda-veicolo-route').mount(app, { chiaveLimite });

require('./richiami-route').mount(app, { chiaveLimite });

require('./targa').mount(app, { json: express.json({ limit: '2kb' }), chiaveLimite });

require('./fonti-route').mount(app, { chiaveLimite });

require('./prove-route').mount(app, { chiaveLimite });

const SEARCH_CACHE_TTL = 3 * 60 * 1000;
const SEARCH_CACHE_MAX = 50;

const pagineInSospeso = new Map();
const searchCache = new Map();
function searchCacheKey(p) {

  const avanzati = filtriAuto.chiaveCache(p.filtriAuto);
  return ['_cacheScope', 'tipo', 'marca', 'modello', 'prezzoMin', 'prezzoMax', 'annoMin', 'annoMax', 'kmMin', 'kmMax',
          'regione', 'raggio', 'mmmvAutoscout', 'motoitBrandSlug', 'motoitModelSlug', 'motoitBikeCode',
          'versione', 'fetta', 'fontiPagina', 'subitoMainStart', 'subitoRecuperoStart']
    .map(f => `${f}=${p[f] ?? ''}`).concat(`avanzati=${avanzati}`).join('&').toLowerCase();
}
function cacheable(data) {

  const bad = s => s === 'error' || s === 'timeout';
  const src = data.sources || {};
  if (Object.values(src).some(s => s?.pausa?.fermo || s?.pausa?.verifica)) return false;
  if (bad(src.subito?.status) || bad(src.autoscout?.status) || bad(src.moto?.status)) return false;

  if (src.autoscout?.parziale || src.moto?.parziale) return false;

  if (src.subito?.parzialeRete) return false;

  if (src.moto?.versioneKoRete) return false;
  if (src.moto?.modelloKoRete) return false;
  return (data.totale || 0) > 0;
}

const searchInFlight = new Map();
async function runSearch(params) {
  const key = searchCacheKey(params);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.ts < SEARCH_CACHE_TTL) {
    searchCache.delete(key); searchCache.set(key, hit);
    return salute.conStatoFonti(hit.data);
  }
  if (searchInFlight.has(key)) return salute.conStatoFonti(await searchInFlight.get(key));

  const etichetta = [params.tipo, params.marca, params.modello].filter(Boolean).join(' ');
  const p = (async () => {
    const data = await budget.perRicerca(etichetta || 'ricerca', () => runSearchCore(params));
    if (cacheable(data)) {
      searchCache.set(key, { ts: Date.now(), data });
      if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
    }
    return data;
  })();

  searchInFlight.set(key, p);
  try { return salute.conStatoFonti(await p); } finally { searchInFlight.delete(key); }
}

function as24LivelloAllargamento(params, asRes, as24Allargato) {
  if (!as24Allargato) return null;
  const modelloAncoraFiltrato = Boolean(String(params.mmmvAutoscout || '').split('|')[1]);
  if (asRes.viaSoloModello || modelloAncoraFiltrato) return 'versione';
  return params.as24Padre ? 'padre' : 'marca';
}

async function runSearchCore(params) {
  const richiesta = f => !params.fontiPagina || params.fontiPagina.split(',').includes(f);
  const as24Retry = { retryPages: true, retryScope: params._cacheScope || 'interno' };

  params.subitoNodo = process.env.AMR_SUBITO_TESTO === '1'
    ? null : (risolviNodo(params.tipo, params.marca, params.modello) || null);
  if (params.subitoNodo && !params.subitoNodo.famigliaIds && params.modello) {
    params.subitoNodo = null;
  }

  if (process.env.AMR_PONTE_BUCHI !== '0') {
    const buco = agganciaSubito(params.tipo, params.marca, params.modello);
    if (buco) {
      params.subitoNodo = buco;
      console.log(`[ponte] Subito "${params.marca} ${params.modello}": buco chiuso — famiglia ${buco.famigliaNome}${buco.testo ? ` + testo "${buco.testo}"` : ''}`);
    }
  }

  if (!params.subitoNodo && params.versione && params.mmmvAutoscout) {

    const famiglie = famiglieSubito(params.tipo, params.mmmvAutoscout);
    const nodi = famiglie.map(f => risolviNodo(params.tipo, params.marca, f)).filter(n => n && n.famigliaIds);
    if (nodi.length) {
      const ids = [...new Set(nodi.flatMap(n => n.famigliaIds.map(String)))];
      if (ids.length === 1) {
        params.subitoNodo = nodi[0];
        console.log(`[ponte] Subito "${params.marca} ${params.modello}": famiglia "${famiglie[0]}" dal ponte, per portare la versione`);
      }
    }
  }

  const brandHit   = lookupBrand(params.tipo, params.marca);
  const brandEntry = brandHit?.entry || null;
  const brandName  = brandHit?.nome  || null;
  const asMeta     = brandEntry?.autoscout || null;

  let modelEntry = null;
  if (params.modello && brandEntry?.models?.length) {
    const resolveModel = makeModelResolver(brandEntry.models.map(m => ({ name: m.nome, value: m })));
    modelEntry = resolveModel(params.modello) || null;
  }

  const groupMembers = (!modelEntry && params.modello && params.tipo === 'auto')
    ? lookupModelGroup(params.tipo, brandName, params.modello)
    : null;

  if (modelEntry) {
    if (!params.mmmvAutoscout && modelEntry.mmmvAutoscout) params.mmmvAutoscout = modelEntry.mmmvAutoscout;

    params.asFilterToken = modelEntry.asFilterToken || null;
  }

  const codiceModello = Boolean(String(params.mmmvAutoscout || '').split('|')[1]);
  const famigliaPiuLarga = Boolean(params.subitoNodo
    && (params.subitoNodo.testo || params.subitoNodo.testoDedotto));
  if (params.subitoNodo && params.subitoNodo.famigliaNome && process.env.AMR_PONTE_AS24 !== '0'
      && !(codiceModello && famigliaPiuLarga)) {
    const dalPonte = codiciAs24(params.tipo, params.subitoNodo.marcaNome, params.subitoNodo.famigliaNome);
    const uniti = unisciCodici(params.mmmvAutoscout, dalPonte);
    if (uniti.length > 1) {
      params.autoscoutModelli = uniti;
      if (!params.mmmvAutoscout) params.mmmvAutoscout = uniti[0];
      console.log(`[ponte] AS24 "${params.marca} ${params.modello}": ${uniti.length} modelli — ${uniti.join(' ')}`);
    } else if (uniti.length === 1 && !params.mmmvAutoscout) {
      params.mmmvAutoscout = uniti[0];
      console.log(`[ponte] AS24 "${params.marca} ${params.modello}": codice dal ponte ${uniti[0]} (l'app non lo trovava)`);
    }
  }

  if (params.subitoNodo?.famigliaIds?.length > 1) params.subitoNodo = null;

  if (params.tipo === 'moto') {
    if (!params.motoitBrandSlug) {
      params.motoitBrandSlug = brandEntry?.motoit?.brandSlug || resolveMotoitSlug(params.marca) || null;
    }
    if (!params.motoitModelSlug && modelEntry?.slugMotoIt) {

      params.motoitModelSlug = correggiModelSlug(modelEntry.slugMotoIt);
    }

    if (richiesta('moto') && !params.motoitModelSlug && params.motoitBrandSlug && params.modello) {
      try {

        params.motoitModelSlug = await famiglieMotoit(params.motoitBrandSlug, params.modello, { rilancia: true }) || null;
      } catch (_) {

        params.motoitModelloKoRete = true;
      }
    }
  }

  const asMakeId         = asMeta?.makeId || null;
  const brandOnAutoscout = Boolean(asMakeId);
  const brandOnMotoIt    = Boolean(params.motoitBrandSlug);

  if (asMakeId) {
    params.autoscoutMmmv = params.mmmvAutoscout || `${asMakeId}|||`;

    if (params.tipo === 'moto' && params.modello && !params.mmmvAutoscout) {
      const nar = resolveAs24Narrowing(brandEntry?.models, params.modello, asMakeId);
      params.autoscoutMmmv = nar.mmmv;
      params.autoscoutVersionText = nar.versionText;
      params.autoscoutSpellings = as24Spellings(params.modello);
      params.as24Padre = nar.padre;

      params.as24Fratelli = nar.padre
        ? (brandEntry?.models || []).map(m => m.nome).filter(n =>
            norm(n).startsWith(norm(nar.padre)) && norm(n) !== norm(params.modello)
            && !norm(params.modello).startsWith(norm(n)))
        : null;
      console.log(`[server] AS24 fase1 "${params.marca} ${params.modello}": mmmv=${nar.mmmv}${nar.padre ? ` (padre "${nar.padre}")` : ' (brand-only)'} + grafie ${JSON.stringify(params.autoscoutSpellings)}`);
    }

    if (params.versione) {

      params.autoscoutVersionModello = params.autoscoutVersionText || null;
      params.autoscoutVersionText = [params.autoscoutVersionText, params.versione].filter(Boolean).join(' ');
      console.log(`[server] AS24 versione: "${params.versione}"`);
    }
  }

  if (params.versione && params.subitoNodo) {
    params.subitoVersioneTesto = params.versione;
    console.log(`[server] Subito: q="${params.versione}" sopra gli id di marca/modello`);
  } else if (params.versione) {

    params.subitoVersioneTesto = params.versione;
    console.log(`[server] Subito: versione "${params.versione}" accodata al testo libero`);
  }

  if (richiesta('moto') && params.versione && params.tipo === 'moto'
      && params.motoitBrandSlug && params.motoitModelSlug && !params.motoitBikeCode) {
    try {

      const fam = String(params.motoitModelSlug).split(',').map(s => s.trim()).filter(Boolean);
      const TETTO_FAM = 12;
      if (fam.length > TETTO_FAM) {

        params.motoitVersioneElencoMonco = `"${params.modello}" aggancia ${fam.length} famiglie su Moto.it (oltre ${TETTO_FAM}): il filtro versione non si applica a questa fonte, si cerca largo`;
        console.log(`[server] Moto.it: ${params.motoitVersioneElencoMonco}`);
        throw new Error(`troppe famiglie (${fam.length}) per risolvere la versione`);
      }

      let famigliKo = 0;
      const bikes = (await Promise.all(fam.map(s =>
        getModelBikes(params.motoitBrandSlug, s, { rilancia: true }).catch(() => { famigliKo++; return []; })
      ))).flat();
      if (famigliKo) {
        params.motoitVersioneElencoMonco = famigliKo >= fam.length
          ? 'il menu versioni di Moto.it non ha risposto: il filtro versione non e\' stato applicato a questa fonte'
          : `${famigliKo} famiglie su ${fam.length} non hanno risposto: l'elenco versioni di Moto.it e' incompleto`;

        params.motoitVersioneKoRete = true;
        console.warn(`[server] Moto.it: ${params.motoitVersioneElencoMonco}`);
      }
      const r = motoitVersione.risolvi(bikes, params.versione, { marca: params.marca, modello: params.modello });
      if (r.versioni.length === 1) {
        params.motoitBikeCode = r.versioni[0].code;
        console.log(`[server] Moto.it: "${params.versione}" → bike=${r.versioni[0].code} ("${r.versioni[0].nome}")`);
      } else if (r.versioni.length > 1) {

        params.motoitSlugAmmessi = new Set(r.versioni.map(v => v.slug));
        console.log(`[server] Moto.it: "${params.versione}" → ${r.versioni.length} versioni, filtro sullo slug dell'annuncio`);
      } else {
        console.log(`[server] Moto.it: "${params.versione}" non e' nel suo catalogo → nessun filtro versione`);
      }

      if (r.scartate.length) {
        params.motoitVersioneScartate = r.scartate.slice();
        console.log(`[server] Moto.it: parole ignorate ${JSON.stringify(r.scartate)}`);
      }
    } catch (e) {
      console.warn('[server] Moto.it versione non risolta: ' + e.message);
    }
  } else if (params.versione && params.tipo === 'moto' && params.motoitBrandSlug && !params.motoitModelSlug && !params.motoitBikeCode) {

    params.motoitVersioneElencoMonco = `il modello non ha un codice su Moto.it: la ricerca su questa fonte e' larga e la versione "${params.versione}" non la filtra (righe da verificare)`;
    console.log(`[server] Moto.it: ${params.motoitVersioneElencoMonco}`);
  }

  if (params.regione && asMakeId) {
    const reg = String(params.regione).trim().toLowerCase();
    const cerchio = cerchioRegione(reg);
    if (cerchio) {

      params.autoscoutGeo = params.raggio
        ? { lat: cerchio.lat, lng: cerchio.lng, radius: params.raggio }
        : cerchio;
      if (!params.raggio) params.as24RegioneDaCap = reg;
    } else {

      const ctr = regionCentroids[reg];
      if (ctr) params.autoscoutGeo = { lat: ctr.lat, lng: ctr.lng, radius: params.raggio || 100 };
    }
  }

  const skipAutoscout = !brandOnAutoscout;
  const skipMotoIt    = params.tipo !== 'moto' || !brandOnMotoIt;

  const asSkipReason   = 'marca non su Autoscout';
  const motoSkipReason = params.tipo !== 'moto' ? 'solo moto' : 'marca non su Moto.it';

  if (params.modello && brandOnAutoscout && !params.mmmvAutoscout) {
    console.log(`[server] AS24 brand-only fallback per "${params.marca} ${params.modello}" (mmmv specifico assente)`);
  }
  if (params.modello && params.tipo === 'moto' && brandOnMotoIt && !params.motoitModelSlug) {
    console.log(`[server] Moto.it brand-only fallback per "${params.marca} ${params.modello}" (slug specifico assente)`);
  }

  const skipSubito = marcaPseudo(params.tipo, params.marca);
  const subitoSkipReason = 'categoria di catalogo (Oldtimer, Trike…): Subito non ha l\'equivalente';

  const pausa = f => salute.fermo(f).fermo;
  const inPausaSubito = pausa('subito'), inPausaAs = pausa('autoscout'), inPausaMoto = pausa('moto');

  const chiaviPagina = Object.fromEntries(FONTI_PAGINA.map(f => [f, searchCacheKey({ ...params,
    fetta: params.fetta || 0, fontiPagina: f,
    ...(f === 'subito' ? {} : { subitoMainStart: undefined, subitoRecuperoStart: undefined }),
  })]));
  const salvate = {};
  for (const f of FONTI_PAGINA) {
    const hit = pagineInSospeso.get(chiaviPagina[f]);
    if (hit && Date.now() - hit.ts < SEARCH_CACHE_TTL) salvate[f] = hit.data;
    else if (hit) pagineInSospeso.delete(chiaviPagina[f]);
  }
  const esaurita = () => ({ items: [], status: 'skipped', reason: 'fonte esaurita nelle pagine precedenti', hasMore: false });
  const [subitoRes, asRes0, motoRes] = await Promise.all([
    !richiesta('subito') ? Promise.resolve(esaurita()) : salvate?.subito ? Promise.resolve(salvate.subito) : skipSubito
      ? Promise.resolve({ items: [], status: 'skipped', reason: subitoSkipReason })
      : inPausaSubito
        ? Promise.resolve({ items: [], status: 'skipped', reason: salute.MOTIVO_PAUSA })
        : runSubito(params, TIMEOUT_MS, 'subito'),
    !richiesta('autoscout') ? Promise.resolve(esaurita()) : salvate?.autoscout ? Promise.resolve(salvate.autoscout.risposta) : skipAutoscout
      ? Promise.resolve({ items: [], status: 'skipped', reason: asSkipReason })
      : inPausaAs
      ? Promise.resolve({ items: [], status: 'skipped', reason: salute.MOTIVO_PAUSA })

      : runSource(() => scrapeAutoscoutUnion(params, { withMeta: true, fetta: params.fetta || 0,
          ...as24Retry }), TIMEOUT_MS, 'Autoscout24', 'autoscout'),
    !richiesta('moto') ? Promise.resolve(esaurita()) : salvate?.moto ? Promise.resolve(salvate.moto) : skipMotoIt
      ? Promise.resolve({ items: [], status: 'skipped', reason: motoSkipReason })
      : inPausaMoto
        ? Promise.resolve({ items: [], status: 'skipped', reason: salute.MOTIVO_PAUSA })
        : runSource(() => scrapeMotoIt(params, { withMeta: true, fetta: params.fetta || 0 }), TIMEOUT_MS, 'Moto.it', 'moto'),
  ]);

  let asRes = asRes0, as24Allargato = salvate?.autoscout?.allargato || false;
  if (!salvate?.autoscout && params.autoscoutVersionText && asRes.status === 'empty' && !asRes.parziale) {

    const fetta = params.fetta || 0;
    if (params.autoscoutVersionModello) {
      const soloModello = await runSource(() =>
        scrapeAutoscoutUnion({ ...params, versione: null, autoscoutVersionText: params.autoscoutVersionModello },
          { withMeta: true, fetta, ...as24Retry }), TIMEOUT_MS, 'Autoscout24', 'autoscout');
      if (soloModello.items.length) { asRes = { ...soloModello, viaSoloModello: true }; as24Allargato = true; }
      else if (soloModello.status !== 'empty' || soloModello.parziale) asRes = soloModello;
    }
    if (!as24Allargato && asRes.status === 'empty' && !asRes.parziale) {
      const retry = await runSource(() =>
        scrapeAutoscoutSmart({ ...params, autoscoutVersionText: null, autoscoutSpellings: null }, { withMeta: true, fetta, ...as24Retry }), TIMEOUT_MS, 'Autoscout24', 'autoscout');
      if (retry.items.length) { asRes = retry; as24Allargato = true; }
      else if (retry.status === 'timeout' || retry.status === 'error') asRes = retry;
    }
  }

  const rispostePagina = { subito: subitoRes, autoscout: asRes, moto: motoRes };
  const fallita = Object.values(rispostePagina).some(r =>
    r.status === 'error' || r.status === 'timeout' || r.parzialeRete);
  for (const f of FONTI_PAGINA) {
    if (!richiesta(f)) continue;
    const r = rispostePagina[f];
    const completa = (r.status === 'ok' || r.status === 'empty')
      && !r.parzialeRete && !r.bloccoParziale && !r.sospetto && (f === 'subito' || !r.parziale);
    if (fallita && completa) {
      const key = chiaviPagina[f], hit = pagineInSospeso.get(key);
      pagineInSospeso.set(key, { ts: hit?.ts || Date.now(),
        data: f === 'autoscout' ? { risposta: r, allargato: as24Allargato } : r });
      if (pagineInSospeso.size > 30) pagineInSospeso.delete(pagineInSospeso.keys().next().value);
    } else if (!fallita) pagineInSospeso.delete(chiaviPagina[f]);
  }

  const grezzi = [...subitoRes.items, ...asRes.items, ...motoRes.items];

  const stripAccents = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const BRAND_GENERIC = new Set(['automobiles', 'motorcycles', 'cars', 'motors', 'motor', 'group', 'moto']);
  const brandTokens   = stripAccents(params.marca).toLowerCase().split(/[\s\-_]+/);
  const marcaKeyword  = brandTokens.find(w => w.length >= 3 && !BRAND_GENERIC.has(w))
                        || brandTokens[0];

  const normModello = params.modello ? norm(params.modello) : '';

  const normSp = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const autoTokens = (params.tipo === 'auto' && params.modello && !params.mmmvAutoscout)
    ? (groupMembers && groupMembers.length ? groupMembers.map(normSp) : [normSp(params.modello)]).filter(Boolean)
    : null;

  const autoTokenRe = autoTokens && autoTokens.length
    ? new RegExp('(?:^| )(' + autoTokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![0-9])')
    : null;

  const risultati = grezzi.filter(r => {

    const titoloLow  = stripAccents(r.titolo).toLowerCase();
    const titoloNorm = norm(r.titolo);

    const subitoFiltered    = r.fonte === 'subito';
    const autoscoutFiltered = r.fonte === 'autoscout' && Boolean(params.autoscoutMmmv);

    const motoitFiltered    = r.fonte === 'moto'      && Boolean(params.motoitBrandSlug || params.motoitModelSlug);
    const siteAlreadyFiltered = subitoFiltered || autoscoutFiltered || motoitFiltered;

    if (!siteAlreadyFiltered && !titoloLow.includes(marcaKeyword))                     return false;

    const subitoModelFiltered    = r.fonte === 'subito'    && Boolean(params.modello);

    const as24TestoPartito = Boolean(params.autoscoutVersionText);
    const autoscoutModelFiltered = r.fonte === 'autoscout' && (Boolean(params.mmmvAutoscout) || as24TestoPartito) && !params.asFilterToken;

    const motoitModelFiltered    = r.fonte === 'moto'      && Boolean(params.motoitModelSlug);
    const siteAlreadyFilteredModel = subitoModelFiltered || autoscoutModelFiltered || motoitModelFiltered;

    if (normModello && params.tipo === 'moto' && !siteAlreadyFilteredModel && !titoloNorm.includes(normModello)) return false;

    if (r.fonte === 'autoscout' && params.asFilterToken) {
      const tokenNorm = norm(params.asFilterToken);
      if (tokenNorm && !titoloNorm.includes(tokenNorm)) return false;
    }

    if (autoTokenRe && r.fonte === 'autoscout' && !autoTokenRe.test(normSp(r.titolo))) return false;

    if (params.prezzoMin != null && r.prezzo != null && r.prezzo < params.prezzoMin)   return false;
    if (params.prezzoMax != null && r.prezzo != null && r.prezzo > params.prezzoMax)   return false;
    if (params.annoMin   != null && r.anno   != null && r.anno   < params.annoMin)     return false;
    if (params.annoMax   != null && r.anno   != null && r.anno   > params.annoMax)     return false;

    if (params.as24RegioneDaCap && r.fonte === 'autoscout' && /^\d{5}$/.test(String(r.zip || ''))) {
      const reg = comuneRegione[String(r.zip)];
      if (reg && reg !== params.as24RegioneDaCap) return false;
    }

    return true;
  });

  if (params.modello) {

    const codiceProprio = Boolean(String(params.mmmvAutoscout || '').split('|')[1]);
    const testoModelloArrivato = Boolean(params.autoscoutVersionText)
      && (!as24Allargato || Boolean(asRes.viaSoloModello));
    const as24HaFiltrato = codiceProprio || (Boolean(params.as24Padre) && testoModelloArrivato);

    const nomiAmmessi = [params.modello, ...(groupMembers || [])].filter(Boolean);

    const versioneChiesta = Boolean(params.versione);

    const as24HaVistoLaVersione = Boolean(params.autoscoutVersionText) && !as24Allargato;
    const etichettaAs24 = r => (versioneChiesta && !as24HaVistoLaVersione)
      ? 'versione-non-verificata'
      : (r.variante ? 'esatto' : 'senza-versione');

    for (const r of risultati) {
      if (r.fonte !== 'moto' || r.dichiarazione) continue;
      if (!params.motoitModelSlug) r.dichiarazione = 'senza-modello';
      else if (params.motoitBikeCode || (params.motoitSlugAmmessi && params.motoitSlugAmmessi.size)) {
        r.dichiarazione = (params.motoitVersioneScartate && params.motoitVersioneScartate.length)
          ? 'versione-non-verificata' : 'esatto';
      }
      else if (versioneChiesta) r.dichiarazione = 'versione-non-verificata';
      else r.dichiarazione = r.variante ? 'esatto' : 'senza-versione';
    }

    const subitoHaConfrontato = Boolean(params.subitoVersioneTesto || (params.subitoNodo && params.subitoNodo.testo));
    if (versioneChiesta && !subitoHaConfrontato) {
      for (const r of risultati) if (r.fonte === 'subito') r.dichiarazione = 'versione-non-verificata';
    }

    for (const r of risultati) {
      if (r.fonte !== 'autoscout' || r.dichiarazione) continue;
      if (as24HaFiltrato) { r.dichiarazione = etichettaAs24(r); continue; }

      if (params.as24Padre && !testoModelloArrivato) {
        const t = norm(r.titolo);
        if (nomiAmmessi.some(n => t.includes(norm(n)))) r.dichiarazione = 'senza-modello';
        else if ((params.as24Fratelli || []).some(n => t.includes(norm(n)))) r.dichiarazione = 'altro-modello';
        continue;
      }
      let c = null;
      for (const nome of nomiAmmessi) {
        const x = combaciaModello(r.modelloDichiarato, nome);
        if (x === true) { c = true; break; }
        if (x === false) c = false;
      }
      if (c === true) r.dichiarazione = etichettaAs24(r);
      else if (c === false) r.dichiarazione = 'altro-modello';
    }
  }

  const countBy = f => risultati.filter(r => r.fonte === f).length;
  const asCount = countBy('autoscout');

  const asAllargatoA = as24LivelloAllargamento(params, asRes, as24Allargato);
  const asReason = as24Allargato
    ? (asAllargatoA === 'versione'
        ? `nessuna "${params.versione}" su Autoscout: mostro tutte le versioni di "${params.modello}"`
        : `nessun "${params.modello}" su Autoscout: mostro ${params.as24Padre ? `il modello base "${params.as24Padre}"` : 'tutta la marca'}`)
    : (autoTokenRe && asCount === 0 && asRes.status === 'ok')
      ? 'modello filtrato per titolo'
      : (asRes.reason || null);

  const versioneConto = versioneVerifica.marcaRicerca(risultati, params.versione, params.subitoNodo);

  return {
    risultati,
    totale:       risultati.length,

    versioneChiesta: params.versione || null,
    versioneConto:   versioneConto ? versioneConto.conto : null,
    versionePerFonte: versioneConto ? versioneConto.perFonte : null,
    subitoStatus: subitoRes.status,
    subitoReason: subitoRes.reason || null,

    sources: {

      subito:    { status: subitoRes.status, reason: subitoRes.reason || null, count: countBy('subito'),
                   totale: subitoRes.total ?? null, hasMore: subitoRes.hasMore ?? null,
                   mainNextStart: subitoRes.mainNextStart ?? null,
                   recuperoNextStart: subitoRes.recuperoNextStart ?? null,
                   erroreTipo: subitoRes.erroreTipo || null, erroreHttp: subitoRes.erroreHttp || null,
                   erroreCodice: subitoRes.erroreCodice || null,
                   errori: subitoRes.erroriSubito || [],
                   pausa: salute.fermo('subito'),
                   parziale: subitoRes.parziale || null,

                   parzialeRete: subitoRes.parzialeRete || null,

                   come: params.subitoNodo ? (params.subitoNodo.come || 'id') : 'testo libero',

                   famigliaNome: (params.subitoNodo && params.subitoNodo.famigliaNome) || null,

                   kmFino: scrapeSubitoApi.kmTettoFascia(params.kmMax),
                   kmDa:   scrapeSubitoApi.kmPavimentoFascia(params.kmMin) },

      autoscout: { status: asRes.status,     reason: asReason,                 count: asCount,
                   totale: asRes.total ?? null, hasMore: asRes.hasMore ?? null,
                   erroreTipo: asRes.erroreTipo || null, erroreHttp: asRes.erroreHttp || null,
                   erroreCodice: asRes.erroreCodice || null,
                   parzialeRete: asRes.parzialeRete || null,
                   pausa: salute.fermo('autoscout'), allargato: asAllargatoA,

                   parziale: asRes.parziale || null },
      moto:      { status: motoRes.status,   reason: motoRes.reason || null,   count: countBy('moto'),
                   totale: motoRes.total ?? null, hasMore: motoRes.hasMore ?? null,
                   erroreTipo: motoRes.erroreTipo || null, erroreHttp: motoRes.erroreHttp || null,
                   erroreCodice: motoRes.erroreCodice || null,
                   parzialeRete: motoRes.parzialeRete || null,
                   pausa: salute.fermo('moto'),

                   totaleLargo: motoRes.totaleLargo || null,

                   parziale: motoRes.parziale || null,

                   versioneIgnorata: (params.motoitVersioneScartate && params.motoitVersioneScartate.length)
                     ? params.motoitVersioneScartate : null,

                   versioneElencoMonco: params.motoitVersioneElencoMonco || null,

                   versioneKoRete: params.motoitVersioneKoRete || null,
                   modelloKoRete: params.motoitModelloKoRete || null },
    },
  };
}

const amrSearchFn = async (input, utente) => {
  const q = { ...input, tipo: input.tipo || 'auto' };
  let parsed = parseSearchParams(q);
  if (parsed.errors && q.regione) { delete q.regione; parsed = parseSearchParams(q); }
  if (parsed.errors) return { error: parsed.errors.join(', ') };
  parsed.params._cacheScope = utente?.id || 'interno';

  if (utente && utente.ruolo === 'demo' && utente.id) {
    const g = utentiDb.consumaRicerca(String(utente.id), TETTO_GIORNALIERO);
    if (!g.ok) return { tettoEsaurito: { usate: g.usate, max: g.max } };
  }
  const data = await runSearch(parsed.params);
  return { params: parsed.params, risultati: data.risultati || [], sources: data.sources || {} };
};

app.use((err, req, res, next) => {

  if (res.headersSent) return next(err);
  const s = Number(err && (err.status || err.statusCode));
  const codice = Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500;

  if (codice < 500) console.warn(`[errore] ${req.method} ${req.path} → ${codice} ${(err && err.name) || 'Error'}`);
  else              console.error(`[errore] ${req.method} ${req.path} → ${codice}`, err);
  res.status(codice).set('Cache-Control', 'no-store').json({
    ok: false,

    error: codice < 500 && err && err.message ? String(err.message) : 'Errore interno del server. Riprova fra poco.',
  });
});

const avviaAscolto = require.main === module;
if (avviaAscolto && auth.stato() === 'assente') {
  console.error('\n  AMR non parte: non c\'e\' nessuna password impostata.\n');
  console.error('  Il server ascolta sulla rete e l\'esposizione pubblica puo\' essere rimasta accesa:');
  console.error('  senza password chiunque arrivi alla porta entra. Impostala e riprova:\n');
  console.error('      node scripts/set-password.js\n');
  process.exit(1);
}
const server = !avviaAscolto ? null : app.listen(PORT, () => {
  console.log(`Server avviato su http://localhost:${PORT}`);

});

module.exports = { server, app, _lookupBrand: lookupBrand, _lookupModelGroup: lookupModelGroup, _catalogResolver: catalogResolver,

  _gateAuth: gateAuth, _postLogin: postLogin, _loginAttempts: loginAttempts, _cacheable: cacheable,
  _percorsoGate: percorsoGate, _soloOwner: soloOwner, _SOLO_OWNER: SOLO_OWNER, _AUTH_FREE: AUTH_FREE,
  _tettoGiornaliero: tettoGiornaliero, _TETTO_GIORNALIERO: TETTO_GIORNALIERO, _amrSearchFn: amrSearchFn,

  _tailscalePublicUrl: tailscalePublicUrl,

  _clientIp: clientIp, _chiaveLimite: chiaveLimite,

  _runSource: runSource, _runSubito: runSubito,
  _as24LivelloAllargamento: as24LivelloAllargamento };
