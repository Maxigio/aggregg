const filtriAuto = require('./filtri-auto');
const versioneVerifica = require('./versione-verifica');
const salute = require('./fonti-salute');
const scrapeAutoscoutGraphql = require('./scrapers/autoscout-graphql');
const { combaciaModello } = require('./scrapers/autoscout-graphql');
const scrapeSubitoApi = require('./scrapers/subito-api');
const scrapeMotoIt = require('./scrapers/motoit');
const annullo = require('./annullo');
const budget = require('./budget-richieste');
const { risolviNodo, marcaPseudo } = require('./scrapers/subito-nodo');
const { agganciaSubito } = require('./scrapers/ponte-buchi');
const { codiciAs24, unisciCodici, famiglieSubito } = require('./scrapers/as24-modelli');
const { makeModelResolver, norm } = require('./scrapers/brand-match');
const { lookupBrand } = require('./catalogo-ricerca');
const ricercaAuto = require('./ricerca-auto');
const ricercaMoto = require('./ricerca-moto');
const regionCentroids = require('../data/region-centroids.json');
const comuneRegione = require('../data/comune-regione.json');
const { cerchioRegione } = require('./scrapers/utils');
const { FONTI_PAGINA } = require('./ricerca-parametri');

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
  const esterno = annullo.segnale();
  const segnale = esterno ? AbortSignal.any([ctrl.signal, esterno]) : ctrl.signal;
  let scattato;
  const timeout = new Promise((_, reject) => {
    scattato = setTimeout(() => { ctrl.abort(); reject(new Error('__timeout__')); }, ms);
  });
  try {

    const avviato = typeof lavoro === 'function' ? annullo.dentro(segnale, lavoro) : lavoro;

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
  const esterno = annullo.segnale();
  const segnale = esterno ? AbortSignal.any([ctrl.signal, esterno]) : ctrl.signal;
  let scattato;
  const timeout = new Promise((_, reject) => {
    scattato = setTimeout(() => {
      reject(Object.assign(new Error('Timeout su Subito.it'), { code: 'AMR_TIMEOUT', kind: 'transient' }));
      ctrl.abort();
    }, ms);
  });
  try {
    const avviato = annullo.dentro(segnale, () => scrapeSubitoSmart(params));

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

  const groupMembers = ricercaAuto.membriGruppo(params, brandName, modelEntry);

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
    await ricercaMoto.preparaModello(params, brandEntry, modelEntry, richiesta('moto'));
  }

  const asMakeId         = asMeta?.makeId || null;
  const brandOnAutoscout = Boolean(asMakeId);
  const brandOnMotoIt    = Boolean(params.motoitBrandSlug);

  if (asMakeId) {
    params.autoscoutMmmv = params.mmmvAutoscout || `${asMakeId}|||`;

    ricercaMoto.preparaAutoscout(params, brandEntry, asMakeId);

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

  if (params.tipo === 'moto') await ricercaMoto.preparaVersione(params, richiesta('moto'));

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
    skipSubito ? Promise.resolve({ items: [], status: 'skipped', reason: subitoSkipReason })
      : !richiesta('subito') ? Promise.resolve(esaurita()) : salvate?.subito ? Promise.resolve(salvate.subito)
      : inPausaSubito
        ? Promise.resolve({ items: [], status: 'skipped', reason: salute.MOTIVO_PAUSA })
        : runSubito(params, TIMEOUT_MS, 'subito'),
    skipAutoscout ? Promise.resolve({ items: [], status: 'skipped', reason: asSkipReason })
      : !richiesta('autoscout') ? Promise.resolve(esaurita()) : salvate?.autoscout ? Promise.resolve(salvate.autoscout.risposta)
      : inPausaAs
      ? Promise.resolve({ items: [], status: 'skipped', reason: salute.MOTIVO_PAUSA })

      : runSource(() => scrapeAutoscoutUnion(params, { withMeta: true, fetta: params.fetta || 0,
          ...as24Retry }), TIMEOUT_MS, 'Autoscout24', 'autoscout'),
    skipMotoIt ? Promise.resolve({ items: [], status: 'skipped', reason: motoSkipReason })
      : !richiesta('moto') ? Promise.resolve(esaurita()) : salvate?.moto ? Promise.resolve(salvate.moto)
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

  const autoTokenRe = ricercaAuto.regexTitolo(params, groupMembers);

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

    if (autoTokenRe && r.fonte === 'autoscout' && !autoTokenRe.test(ricercaAuto.normSp(r.titolo))) return false;

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

    ricercaMoto.dichiaraRisultati(params, risultati, versioneChiesta);

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

module.exports = { runSearch, cacheable, runSource, runSubito, as24LivelloAllargamento, FONTI_PAGINA };
