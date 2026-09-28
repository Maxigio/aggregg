const path = require('path');
// .env dalla ROOT della repo con path ASSOLUTO: dotenv di default cerca in
// process.cwd(), che sotto Electron può non essere la repo → tutto il .env perso.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// Logger centralizzato: install SUBITO dopo dotenv → tee dei console.* + file rotante +
// handler uncaught. Cattura anche il boot dei moduli sotto (che loggano al require).
const logger = require('./logger').install();
const express = require('express');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const filtriAuto = require('./filtri-auto');            // filtri avanzati auto → dialetto di ogni fonte
const versioneVerifica = require('./versione-verifica');  // la versione, verificata da noi su tutte le fonti
const auth = require('./auth');
const utentiDb = require('./utenti-db');                                // il magazzino delle persone (SQLite)
const salute = require('./fonti-salute');                               // chi ci sta bloccando, e per quanto la saltiamo
const qrcode = require('qrcode-generator');
const scrapeAutoscoutGraphql = require('./scrapers/autoscout-graphql');
const { combaciaModello } = require('./scrapers/autoscout-graphql');   // modello dichiarato vs cercato
const scrapeSubitoApi = require('./scrapers/subito-api');
const scrapeMotoIt    = require('./scrapers/motoit');
const { resolveMotoitSlug } = require('./scrapers/motoit-brands');
const { famiglieMotoit, getBrandModels, getModelBikes, resolveMotoitVersionEntry, correggiModelSlug } = require('./scrapers/motoit-models');
const motoitVersione = require('./scrapers/motoit-versione');   // testo libero → codice/slug versione Moto.it
const { getDetail, fonteFromUrl } = require('./scrapers/detail');
const annullo        = require('./annullo');       // il segnale che chiude le richieste abbandonate
const budget = require('./budget-richieste');     // quante richieste costa una ricerca: contate, non stimate
const { risolviNodo, marcaPseudo } = require('./scrapers/subito-nodo');   // testo digitato → id del catalogo Subito
const { unisciGemelli, marcheNascoste, sinonimiTendina } = require('./menu-gemelli');   // due strade nel menu, la stessa lista
const { versioniDi } = require('./versioni-menu');     // le versioni suggeribili, dal catalogo su disco
const { agganciaSubito } = require('./scrapers/ponte-buchi'); // i modelli che il ponte non copriva
const { codiciAs24, unisciCodici, famigliaSubito, famiglieSubito } = require('./scrapers/as24-modelli');   // traduzione di livello, nei due versi
// (campagna E6: l'import di as24-tassonomia era morto — nessun uso oltre la require)
const { makeModelResolver, resolveAs24Narrowing, as24Spellings, norm } = require('./scrapers/brand-match');
const { catalogResolver, lookupBrand, lookupModelGroup } = require('./catalogo-ricerca');
const province        = require('../data/province.json');
const regionCentroids = require('../data/region-centroids.json');  // capoluoghi regione {lat,lng} → raggio AS24 nativo
// 12.575 CAP → regione. Autoscout il CAP lo manda con ogni annuncio: e' cio' che rende
// preciso il cerchio, che da solo o sborda o taglia (vedi `as24RegioneDaCap`).
const comuneRegione = require('../data/comune-regione.json');
// Il raggio che copre davvero la regione: sta accanto alla tabella dei raggi AS24, non qui.
const { cerchioRegione } = require('./scrapers/utils');
const modelsData      = require('../data/models.json');

// `norm` arriva da scrapers/brand-match: e' LA normalizzazione dei nomi di veicolo, una sola per
// tutti. Qui ce n'era una copia che non toglieva gli accenti, e bastava che l'annuncio scrivesse
// "Regolarita" e la ricerca "Regolarità" (o viceversa) perche' la moto sparisse dai risultati
// senza nessun errore. Misurati 32 modelli moto accentati, ed e' sulle moto che il filtro-titolo
// e' attivo. Vedi il commento della funzione per il perche' non e' quella di model-key.

const app = express();
// Il server e' raggiungibile dal Funnel: non dichiara il framework e applica le difese che non
// dipendono dal contenuto della pagina. La CSP resta fuori da qui finche' il frontend usa script
// e stili inline: una policy finta con `unsafe-inline` darebbe solo una falsa garanzia.
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
// Timeout per-fonte: copre anche le ricerche che leggono più pagine o famiglie.
const TIMEOUT_MS = 45000;

// Auto e Moto su AS24 usano GraphQL. Un errore resta un errore della fonte:
// il ripiego su HTML/Chromium cambierebbe filtri, versione e ampiezza dei modelli.
async function scrapeAutoscoutSmart(params, opts = {}) {
  return scrapeAutoscoutGraphql(params, opts);
}

// F50 fase 1b — UNIONE MULTI-GRAFIA. AS24 filtra per parola intera e non ha OR: una
// sola grafia perde gli annunci scritti diversamente ("800MT-X" non aggancia
// "800 MT X" né "Mtx"). Interroghiamo le grafie in parallelo e uniamo per url.
// Costo: 1 richiesta per grafia (le query strette esauriscono la lista a pagina 1),
// e solo sul ramo dei modelli senza codice-modello. Ogni grafia usa GraphQL.
async function scrapeAutoscoutUnion(params, opts = {}) {
  const grafie = params.autoscoutSpellings;
  if (!grafie || grafie.length < 2) return scrapeAutoscoutSmart(params, opts);
  // `g` e' una riscrittura del solo NOME-MODELLO, mentre autoscoutVersionText a questo punto
  // vale "modello + versione": sostituendolo per intero, la parola scritta dall'utente non
  // partiva MAI su questo ramo. Misurato dal vivo su Volkswagen Golf (74|2084): con "Golf"
  // tornano 6.442 annunci, esattamente quanti senza testo — la versione era ignorata; con
  // "Golf GTD Variant" ne tornano 1. Qui si sostituisce la sola parte-modello.
  const conVersione = g => [g, params.versione].filter(Boolean).join(' ');
  // Gli errori per-grafia NON si inghiottono: una grafia caduta e' una fetta di risultati
  // che manca, e prima spariva in silenzio — risultato parziale spacciato per 'ok' (e
  // cachato), o 'empty' che innescava un riallargamento su un errore transitorio.
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
  // Tutte le grafie cadute: non ripetere la stessa ricerca né passare al browser.
  const byUrl = new Map();
  for (const lista of liste) for (const r of lista) if (r && r.url && !byUrl.has(r.url)) byUrl.set(r.url, r);
  // Superstiti a zero item CON grafie cadute: quelle cadute potevano essere proprio la
  // grafia dell'utente. Non e' "empty", e' un errore: runSource lo classifica 'error',
  // che da solo disinnesca riallargamento, banner "nessuna X" e cache.
  if (errori.length && byUrl.size === 0) throw errori[0];
  // Piu' grafie = piu' ricerche che si sovrappongono: sommare i totali conterebbe due
  // volte gli stessi annunci, e prendere il piu' grande sarebbe arbitrario. Qui il totale
  // della fonte NON e' definito, e si dice null invece di inventarlo.
  // `parziale` viaggia anche senza withMeta: sciogli() normalizza entrambe le forme, e un
  // risultato monco che non si dichiara e' esattamente il difetto che questo campo chiude.
  const parziale = [errori.length ? `${errori.length}/${grafie.length} grafie AS24 non lette per intero: ${errori[0].message}` : null, ...parziali].filter(Boolean).join(' · ') || null;
  // Il GraphQL tagga gia' 403/429 come `blocked`: quel genere NON va sciolto nella stringa
  // `parziale`, senno' runSource registra 'ok' (gli item delle grafie superstiti ci sono) e il
  // freno azzera i colpi proprio mentre AS24 ci sta respingendo. Come subito-api.js:668.
  const respinte = errori.filter(e => e && e.kind === 'blocked');
  // Non ricreare l'errore: perderemmo FONTE_IN_PAUSA e conteremmo un rifiuto
  // locale come una nuova risposta del portale. Il messaggio completo e' in parziale.
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

// Auto e Moto usano sempre hades: gli ID di catalogo e i filtri non vengono sostituiti
// da una ricerca browser a parole quando l'API non risponde.
async function scrapeSubitoSmart(params) {
  return scrapeSubitoApi(params, { sort: 'priceasc', withMeta: true, fetta: params.fetta || 0,
    mainStart: params.subitoMainStart, recuperoStart: null, senzaRecupero: true });
}

// L'accesso si monta prima di ogni rotta protetta, inclusi report e PDF.
const { gateAuth, postLogin, loginAttempts, percorsoGate, soloOwner, SOLO_OWNER, AUTH_FREE,
  tettoGiornaliero, TETTO_GIORNALIERO, clientIp, chiaveLimite } = require('./accesso-route').mount(app, { logger });

// Le segnalazioni e il PDF condividono la chiave di limite dell'account.
require('./report-route').mount(app, { chiaveLimite });

// Bundle, pagina iniziale e Guida precedono le API e lo static: il modello grezzo della Guida resta protetto.
require('./frontend-route').mount(app);

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
    }));
  /**
   * L'UNIONE COL CATALOGO LOCALE, la stessa gia' applicata al resolver degli slug
   * (motoit-brands.js): tre marche che l'app HA su disco — cyclone (7 modelli), tvs-motor
   * (8), um-italia (20) — non comparivano in tendina, e la force-select disabilita Cerca
   * su una marca fuori elenco: 35 modelli posseduti e irraggiungibili, senza altra via.
   * /api/models per quelle marche funziona gia'.
   */
  if (tipo === 'moto') {
    const raggiunte = new Set(lista.map(b => resolveMotoitSlug(b.nome)).filter(Boolean));
    let cat = null;
    try { cat = require('../data/motoit-catalogo.json'); } catch (_) { cat = null; }
    for (const [slug, m] of Object.entries((cat && (cat.marche || cat)) || {})) {
      if (raggiunte.has(slug) || !m || !Object.keys(m.modelli || {}).length) continue;
      lista.push({ nome: m.nome || slug, sites: ['motoit'], autoscout: null });
    }
  }
  /**
   * LE MARCHE NASCOSTE non stanno in tendina (decisione del proprietario, 2026-08-08:
   * «Solo Piaggio, Vespa sparisce»): i loro modelli vivono nella gemella via unione
   * inversa (menu-gemelli), e chi digita il nome nascosto viene portato sulla gemella
   * coi `sinonimi` qui sotto. Il ponte degli ospiti non guarda la tendina.
   */
  const nascoste = marcheNascoste(tipo);
  const visibili = lista.filter(b => !nascoste.has(b.nome));
  visibili.sort((a, b) => a.nome.localeCompare(b.nome, 'it', { sensitivity: 'base' }));
  res.json({ brands: visibili, sinonimi: sinonimiTendina(tipo) });
});

// Endpoint modelli per marca (alimenta il dropdown modello nel frontend).
// La normalizzazione per confrontare i nomi fra cataloghi e' UNA, ed e' `norm` di
// brand-match — che lo dichiara nel suo commento: «chi confronta marche o modelli importa
// questa». `normName` era la copia divergente che quella regola vieta: conservava gli spazi
// mentre `norm` li toglie, e il merge Moto.it aggiungeva 94 doppioni della stessa moto in
// tendina (CL500/CL 500, NX500/NX 500, CRF 300L/CRF 300 L, MH 900e/MH 900 e) — in una
// force-select il cui contratto e' che l'utente SCEGLIE un modello reale.

app.get('/api/models', async (req, res) => {
  const { tipo, marca } = req.query;
  if (!tipo || !['auto', 'moto'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo deve essere "auto" o "moto"' });
  }
  if (!marca || typeof marca !== 'string' || marca.trim().length === 0) {
    return res.status(400).json({ error: 'marca obbligatoria' });
  }
  const entry = modelsData[tipo]?.[marca.trim()];

  // entry.models è sempre un array nel nuovo schema unificato (sia auto sia moto).
  // Subito usa solo ?q=marca+modello, niente più slug/key per Subito nel payload.
  const modelli = ((entry && entry.models) || []).map(m => ({
    nome:           m.nome,
    sites:          m.sites || [],
    mmmvAutoscout:  m.mmmvAutoscout  || '',
    // kindAS non si spedisce piu': campo a valore unico ('model' ovunque), nessun
    // lettore runtime — misurato in campagna E, tolto in E6. Nei DATI resta com'e'.
    // gli slug rotti del catalogo (kx-250 dove Moto.it dice kx250) si correggono QUI,
    // dove il menu esce: cosi' ricerca, versioni e schede ricevono gia' quello vero
    slugMotoIt:     correggiModelSlug(m.slugMotoIt || ''),
  }));

  /**
   * LE MARCHE GEMELLE: due strade, la stessa lista. Il menu Piaggio offriva «Vespa 125
   * GTS» e il menu Vespa no — la ricerca giusta esisteva (ponte degli ospiti) ma la
   * force-select non lasciava chiederla. Le coppie, curate con la prova, stanno in
   * data/menu-gemelli.json; l'unione tiene i campi originali, quindi Autoscout continua
   * a partire per id. Vedi backend/menu-gemelli.js.
   */
  modelli.push(...unisciGemelli(tipo, marca.trim(), modelli, modelsData));
  modelli.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));

  // MOTO — F43 Fase 0' (lazy): fonde i modelli AUTOREVOLI dell'API Moto.it
  // (`models/<brand>/Used`, cache 12h) col catalogo: riempie lo slug mancante per
  // match esatto-normalizzato (catalogo↔API, NON testo utente) e aggiunge i modelli
  // assenti dal catalogo. Così la force-select copre tutto Moto.it con slug reali.
  let motoitKo = null;
  if (tipo === 'moto') {
    const brandSlug = (entry && entry.motoit && entry.motoit.brandSlug) || resolveMotoitSlug(marca.trim()) || null;
    if (brandSlug) {
      try {
        // `rilancia`: senza, un KO di rete tornava [] e la tendina usciva PIU' CORTA con un
        // 200 — chi sceglie da un elenco monco non ha modo di accorgersene. Il KO ora si
        // dichiara nella risposta (`fonteMotoitKo`), i modelli base restano.
        const apiModels = await getBrandModels(brandSlug, { rilancia: true });   // [{name, slug}]
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

// Dati del veicolo e costi, separati dalla ricerca degli annunci.
require('./veicolo-dati-route').mount(app);

/**
 * LE VERSIONI SUGGERIBILI per la tendina del campo Versione (richiesta del proprietario,
 * 2026-08-08). Non un menu che sceglie un id: il campo resta testo libero e quello che
 * scrivi va alle fonti com'e' — la tendina suggerisce i nomi che il catalogo Subito usa
 * davvero per quella famiglia (disco, niente rete). Vedi backend/versioni-menu.js.
 */
app.get('/api/versioni', (req, res) => {
  const tipo = String((req.query || {}).tipo || '');
  const marca = String((req.query || {}).marca || '').trim();
  const modello = String((req.query || {}).modello || '').trim();
  if (!['auto', 'moto'].includes(tipo)) return res.status(400).json({ error: 'tipo deve essere "auto" o "moto"' });
  if (!marca || !modello) return res.status(400).json({ error: 'marca e modello obbligatori' });
  res.json({ versioni: versioniDi(tipo, marca, modello) });
});

// (campagna E6: la rotta /api/moto-versions e' stata tolta — zero chiamanti misurati
// nel frontend; le versioni della tendina passano da /api/versioni qui sopra,
// e la traduzione Moto.it della versione avviene dentro runSearch.)

// §15 — Arricchimento spec ON-CLICK: fetch pagina-dettaglio → { cambio, potenzaCv,
// cilindrata, proprietari, allestimento, revisione }. Anti-SSRF: host allowlist in
// detail.js (https + dominio fonte, ri-validato per-redirect). Best-effort: ok:false
// se la fonte non risponde (es. Subito bloccato).
// I dettagli di un annuncio si chiedono APRENDOLO (l'arricchimento allo scorrimento e'
// spento, vedi frontend/app.js): resta una rotta che va in rete su una fonte esterna, ed era
// l'unica delle otto senza un freno. Stesso limitatore di tutte le altre.
const limiteDettaglio = require('./limite-richieste').crea({ max: 30, cosa: 'aperture di annunci' });
app.get('/api/detail', async (req, res) => {
  const gDet = limiteDettaglio.consuma(chiaveLimite(req));
  if (!gDet.ok) return res.status(429).json({ error: limiteDettaglio.messaggio(gDet), riprovaFra: gDet.attesa, restanti: 0 });
  const url = req.query.url;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url obbligatorio' });
  try {
    const detail = await getDetail(url);
    if (!detail) return res.json({ ok: false, detail: null });
    const fonte = fonteFromUrl(url);
    res.json({ ok: true, detail, fonte, pausa: salute.fermo(fonte) });
  } catch (e) {
    if (e.status === 429 || e.code === 'FONTE_IN_PAUSA') {
      return res.status(502).json({ ok: false, error: e.message, fonte: e.fonte, pausa: salute.fermo(e.fonte) });
    }
    return res.status(400).json({ error: e.message });   // host non in allowlist / schema non-https
  }
});

// ─── Indirizzi di accesso da telefono (helper "Apri da telefono") ─────────────
// Elenca gli URL http://<ip>:PORT raggiungibili: IPv4 non-internal delle interfacce
// locali. Include LAN (192.168/10.x) e Tailscale (100.64.0.0/10) se attivo.
// Nessun input esterno → nessun rischio. Le "100.x" Tailscale in cima (più utili).
// URL pubblico Funnel (best-effort): prova binari noti, gestisce ENOENT.
// Cache TTL: l'endpoint è auth-exempt → evita di lanciare un subprocess
// `tailscale` ad ogni richiesta (anti-spam/DoS leggero).
let funnelCache = { ts: 0, url: null };
const FUNNEL_TTL = 60 * 1000;
// Dedup in volo: la cache copre solo chi arriva DOPO il completamento; senza
// coda, N richieste concorrenti a cache scaduta spawnerebbero N subprocess.
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

// URL pubblico + QR (per il logo cliccabile in app e login). Auth-exempt:
// nessun dato sensibile (l'URL non è segreto, niente password nel QR).
app.get('/api/public-url', (req, res) => {
  tailscalePublicUrl(url => {
    if (!url) return res.json({ url: null, svg: null });
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    res.json({ url, svg: qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }) });
  });
});

// Set di regioni valide (derivato da province.json)
const REGIONI_VALIDE = new Set(Object.values(province).map(p => p.regione));
// Match tollerante: mappa normalizzata (lowercase + solo alfanumerici) → slug canonico.
// Il <select> del web manda già lo slug ('lombardia'); l'API accetta anche la
// forma naturale ('Lombardia', 'Emilia Romagna') e la riconduce allo stesso slug.
const normReg = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const REGIONE_BY_NORM = new Map([...REGIONI_VALIDE].map(slug => [normReg(slug), slug]));
const canonRegione = s => REGIONE_BY_NORM.get(normReg(s)) || null;

// Validazione e sanitizzazione parametri ricerca
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
  // `?modello=a&modello=b` arriva come ARRAY: senza questo, il `.trim()` piu' sotto
  // esplodeva in un 500 HTML del finalizzatore di Express, res.json() del browser moriva
  // e il messaggio dava la colpa alla rete. Un 400 col perche', come per marca.
  if (modello != null && typeof modello !== 'string') errors.push('modello deve essere una stringa sola');
  if (regione && !canonRegione(regione)) errors.push(`regione non valida: ${regione}`);
  // Anche la prima pagina può dover riprovare soltanto alcune fonti.
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

  // Subito cerca con ?q=marca+modello + filtri nativi (regione/prezzo/anno/km/sort).
  // Autoscout24 usa mmmvAutoscout, Moto.it usa motoitBrandSlug/motoitModelSlug.
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
      raggio:           toInt(raggio),   // km raggio AS24 attorno al capoluogo regione (default 100 in runSearchCore)
      // "Carica altri": quale fetta di risultati chiedere alle fonti. 0 = la prima.
      // Il tetto tiene lontano da richieste assurde e dai limiti veri delle fonti
      // (hades si ferma fra start 9.850 e 10.000; qui si ferma alla fetta 50).
      fetta:            Math.min(50, Math.max(0, toInt(fetta) || 0)),
      fontiPagina,
      subitoMainStart: cursoriSubito ? cursoreSubito(subitoMainStart) : undefined,
      subitoRecuperoStart: cursoriSubito ? cursoreSubito(subitoRecuperoStart) : undefined,
      mmmvAutoscout:    mmmvAutoscout    || null,
      motoitBrandSlug:  motoitBrandSlug  || null,
      // la correzione vale anche per chi arriva con lo slug vecchio in tasca (menu in
      // cache del browser o link costruiti con lo slug vecchio): kx-250 rispondeva 404 per sempre
      motoitModelSlug:  correggiModelSlug(motoitModelSlug || '') || null,
      motoitBikeCode:   motoitBikeCode   || null,   // versione/allestimento Moto.it (param `bike=`)
      /**
       * LA VERSIONE, scritta libera. Una sola, e ogni fonte la riceve come puo':
       *   Subito     va in `q=` SOPRA gli id di marca e modello. Non e' la ricerca a
       *              testo libero di Subito (quella sbaglia un risultato su tre): gli id
       *              garantiscono gia' marca e modello, `q` restringe dentro.
       *   Autoscout  va nel suo `modelVersionInput`, che e' nativo e cerca per parole
       *              intere in AND. E' letteralmente la ricerca che faresti sul sito.
       *   Moto.it    e' l'unica che vuole un codice, quindi l'unica dove il testo va
       *              TRADOTTO — contro il catalogo di Moto.it, non contro un altro.
       * 80 caratteri: oltre non e' piu' una versione, e' una frase.
       */
      versione:         versione ? String(versione).trim().slice(0, 80) : null,
      /**
       * I FILTRI AVANZATI, SOLO SULLE AUTO.
       *
       * Le auto le servono Subito e Autoscout, e carrozzeria/cambio/alimentazione/porte/
       * posti/potenza/classe/condizione li hanno tutti e due nativi: nessuna fonte cieca.
       * Le moto invece hanno anche Moto.it, che questi filtri non li onora — misurato con
       * un controllo che funziona (`price_t` muove il totale, `cc_f` e `type` no). Metterli
       * anche li' vorrebbe dire un filtro che una fonte su tre ignora in silenzio.
       */
      filtriAuto:       tipo.trim() === 'auto' ? filtriAuto.leggiDaQuery(query) : {},
    }
  };
}

// Wrapper per-fonte: ritorna { items, status, reason } — mai [] muto.
// status: 'ok' | 'empty' | 'timeout' | 'error'. Così la UI distingue
// "rotto/saltato" da "nessun risultato".
/**
 * QUANTI NE HA LA FONTE, non quanti ne mostriamo noi.
 *
 * Tutte e tre le fonti dicono gia' il totale della ricerca dentro la risposta che
 * leggiamo: Subito con `count_all`, Moto.it dal conteggio in pagina, Autoscout con
 * `metadata.totalItems` (provato live sulla query di produzione — il commento nello
 * scraper diceva il contrario, e non e' piu' vero). Costo: zero richieste in piu'.
 *
 * Gli scraper rispondono un array oppure `{items, total}` a seconda di `withMeta`:
 * qui le due forme diventano una sola, cosi' chi chiama non deve saperlo.
 */
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
    // Il risultato copre TUTTE le richieste fatte alla fonte? La union multi-grafia lo
    // dichiara quando una grafia e' caduta: gli item ci sono ma ne mancano altri.
    parziale: (r && r.parziale) || null,
    // Dentro `parziale` convivono monchi TRANSITORI e DETERMINISTICI: questo dice se ce n'e'
    // almeno uno transitorio. cacheable() legge il flag, mai la stringa — che e' per lo schermo.
    parzialeRete: (r && r.parzialeRete) || null,
    // La fonte ha risposto, ma sa di non aver letto bene: e' successo davvero — una
    // pagina in cui nessun annuncio porta un prezzo non e' un mercato senza prezzi, e'
    // un'etichetta del payload che e' cambiata. Stessa convenzione dei Ricambi.
    sospetto: (r && r.sospetto) || null,
    // Il totale che la fonte dichiara descrive la ricerca che hai fatto, o una piu' larga?
    totaleLargo: (r && r.totaleLargo) || null,
    // Qualche famiglia moto e' stata RESPINTA (403/429) ma altre hanno risposto: un errore
    // taggato col suo genere, che runSubito passa al freno. Se non stesse qui, morirebbe nel
    // passaggio come a suo tempo `parziale` — e' proprio il motivo per cui sciogli() esiste.
    bloccoParziale: (r && r.bloccoParziale) || null,
  };
}

/**
 * @param {Function|Promise} lavoro  meglio una FUNZIONE: cosi' parte dentro il contesto di
 *   annullamento e, quando il timeout scade, la richiesta si chiude davvero invece di
 *   restare aperta verso la fonte a scaricare una pagina che nessuno guardera'. Una Promise
 *   gia' avviata si accetta ancora (i test la passano cosi'), ma non e'
 *   annullabile: e' nata fuori dal contesto.
 */
/**
 * @param {string} [chiaveFonte]  'autoscout' | 'moto' — se c'e', l'esito finisce in
 *   `fonti-salute`. Se manca NON si registra niente, ed e' voluto: le prove chiamano
 *   `_runSource` a mano, e senza questa condizione un errore finto in una prova metterebbe
 *   in pausa una fonte VERA nell'archivio di chi sta sviluppando.
 */
async function runSource(lavoro, ms, nomeSito, chiaveFonte) {
  const segna = (errore, conteggio) => { if (chiaveFonte) salute.registra(chiaveFonte, { errore, conteggio }); };
  const ctrl = new AbortController();
  let scattato;
  const timeout = new Promise((_, reject) => {
    scattato = setTimeout(() => { ctrl.abort(); reject(new Error('__timeout__')); }, ms);
  });
  try {
    // DENTRO il try, non fuori. Fuori, una fonte che lancia in modo SINCRONO (un catalogo
    // mancante al require, un campo letto su undefined) scavalcava questa cattura: la
    // Promise.all di runSearch cadeva e la ricerca intera rispondeva 500, invece di
    // degradare quella sola colonna e lasciare parlare le altre due.
    const avviato = typeof lavoro === 'function' ? annullo.dentro(ctrl.signal, lavoro) : lavoro;
    // Lo SPREAD, non una destrutturazione scelta a mano: sciogli() e' il punto unico che
    // elenca i campi-dichiarazione, e chi ritorna li ripassa TUTTI per costruzione. La
    // destrutturazione era il punto esatto in cui `parziale` moriva nel wrapper gemello
    // (runSubito): il campo era spedito, normalizzato, e poi perso nel passaggio di consegne.
    const s = sciogli(await Promise.race([avviato, timeout]));
    // Una fonte che DICHIARA di non aver letto bene non e' 'ok' e non e' 'empty': con
    // 'empty' a schermo diventerebbe "nessun annuncio", cioe' un fatto sul mercato.
    if (s.sospetto) {
      // Ha risposto, ma male: e' un errore nostro di lettura, non un blocco. Non deve far
      // scattare la pausa, senno' un cambio di markup ci toglie la fonte per ore.
      segna(Object.assign(new Error(s.sospetto), { kind: 'error' }), 0);
      return { ...s, status: 'error', reason: s.sospetto, erroreTipo: 'error' };
    }
    // BLOCCO PARZIALE, stessa regola di runSubito: qualche pagina/grafia e' stata RESPINTA e
    // altre no. Lo stato resta 'ok' (gli annunci ci sono), ma al freno deve arrivare la respinta
    // col suo genere vero: con `errore: null` il ramo 'ok' di fonti-salute azzera i colpi, e in
    // un regime di respinta parziale sostenuta il blocco non veniva contato MAI nemmeno una
    // volta — la fonte non andava in pausa nemmeno respingendo due terzi delle richieste.
    if (s.bloccoParziale) segna(s.bloccoParziale, s.items.length);
    else segna(null, s.items.length);
    // Un risultato parziale con item resta 'ok' (il flag sta ACCANTO allo status, mai al
    // posto suo — stessa regola di `allargato`), ma il perche' viaggia in `reason` e il
    // campo `parziale` arriva fino a `sources`, dove cacheable() lo legge.
    return { ...s, status: s.items.length ? 'ok' : s.parzialeRete ? 'error' : 'empty', reason: s.parziale || null };
  } catch (err) {
    const isTimeout = err.message === '__timeout__';
    // Anche su un errore: se la fonte ha risposto male, quello che resta in volo non serve.
    ctrl.abort();
    // Il timeout e' NOSTRO (l'abbiamo deciso noi), non un verdetto della fonte: va registrato
    // come transitorio, non come blocco. L'errore vero invece porta gia' status/kind da `fail()`.
    segna(isTimeout ? Object.assign(new Error('timeout'), { kind: 'transient' }) : err, 0);
    console.warn(`[WARN] ${nomeSito}: ${isTimeout ? 'timeout' : err.message}`);
    return { items: [], status: isTimeout ? 'timeout' : 'error', reason: isTimeout ? 'timeout' : err.message,
      erroreTipo: isTimeout ? 'transient' : err.kind || 'error', erroreHttp: err.status || null,
      erroreCodice: err.code || null };
  } finally { clearTimeout(scattato); }
}

// Il ramo Hades dichiara gli errori: non esiste una sessione browser da rinnovare.
async function runSubito(params, ms, chiaveFonte) {
  // Come in runSource: senza chiave non si registra niente, cosi' una prova che simula un
  // blocco non mette in pausa Subito nell'archivio vero di chi sviluppa.
  const segna = (errore, conteggio) => { if (chiaveFonte) salute.registra(chiaveFonte, { errore, conteggio }); };
  // Stesso annullamento di runSource: scaduto il tempo, la richiesta a Subito si chiude
  // invece di restare aperta a scaricare una risposta che nessuno leggera'.
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
    // Stesso stampo di runSource: lo spread di sciogli(), MAI una destrutturazione a mano.
    // Qui una vecchia destrutturazione buttava `parziale`: una pagina interrotta
    // usciva senza dichiarazione e poteva entrare in cache per tre minuti.
    const s = sciogli(await Promise.race([avviato, timeout]));
    // Come in runSource: una fonte che dichiara di non aver letto bene non e' 'empty'.
    if (s.sospetto) {
      segna(s.bloccoParziale || Object.assign(new Error(s.sospetto), { kind: 'error' }), 0);
      return { ...s, status: 'error', reason: s.sospetto, erroreTipo: 'error' };
    }
    // BLOCCO PARZIALE: una pagina aggiuntiva o il recupero e' stato RESPINTO (403/429).
    // Non e' un errore di lettura e non e' "mercato parziale": lo stato resta 'ok' con la nota
    // `parziale` (se ci sono annunci), ma il freno anti-ban deve vedere la respinta col suo
    // genere vero — non un 'error' generico, che non ferma mai.
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

// L'ULTIMA copia del limitatore scritta a mano: le altre rotte passano dal modulo comune
// dalla campagna dei limiti, questa contava per indirizzo — e dietro il Funnel l'ufficio
// ha UN indirizzo: il blocco di uno era il blocco di tutti, senza dire fra quanto
// riprovare, e la mappa non si potava mai. Stessi numeri di prima: 60 per 60 secondi.
const limiteRicerche = require('./limite-richieste').crea({ max: 60, cosa: 'ricerche' });
app.get('/api/search', async (req, res) => {
  const gRic = limiteRicerche.consuma(chiaveLimite(req));
  if (!gRic.ok) return res.status(429).json({ error: limiteRicerche.messaggio(gRic), riprovaFra: gRic.attesa, restanti: 0 });
  const parsed = parseSearchParams(req.query);
  if (parsed.errors) {
    return res.status(400).json({ error: parsed.errors.join(', ') });
  }
  parsed.params._cacheScope = req.authId || 'locale';
  // Il tetto giornaliero si addebita QUI, dopo il limitatore al minuto e la validazione: una
  // richiesta che viene rifiutata non deve costare una ricerca. `tettoGiornaliero` chiama
  // next() solo se si puo' procedere; altrimenti ha gia' risposto lui.
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

// Registrazione, pannello del proprietario e link d'invito. Le sue pagine stanno in `pagine/`,
// FUORI da `frontend/`: quella cartella la serve express.static, e su un filesystem che non
// distingue le maiuscole un pannello protetto da un solo handler si scaricherebbe con
// `GET /richieste.html`.
require('./registrazioni-route').mount(app, { json: express.json({ limit: '4kb' }), chiaveLimite, clientIp });
// Le sole impostazioni di prezzo seguono l'account invece del dispositivo.
require('./dati-utente').mount(app, { json: express.json({ limit: '8kb' }), utenteDi: req => req.authId || 'owner', chiaveLimite });

// ─── Scheda tecnica veicolo (auto-data.net) — vedi scheda-veicolo-route.js ──────────
require('./scheda-veicolo-route').mount(app, { chiaveLimite });

// ─── Richiami di sicurezza (Safety Gate UE) — vedi richiami-route.js ───────────
require('./richiami-route').mount(app, { chiaveLimite });

// ─── Verifica per targa: il CAPTCHA lo risolve una persona — vedi targa.js ─────
// Una targa per gesto umano, niente archivio, niente targhe nei log.
require('./targa').mount(app, { json: express.json({ limit: '2kb' }), chiaveLimite });

// ─── Fonti dati aperte (OSM, EPREL, Wheel-Size) — vedi fonti-route.js ──
require('./fonti-route').mount(app, { chiaveLimite });

// ─── Le MISURE della redazione (auto.it, inSella) — vedi prove-route.js ────────
// Dentro l'ADD ON della scheda tecnica: dicono quanto va davvero un mezzo contro quello che
// il costruttore dichiara. Su richiesta, una fonte per tipo di veicolo.
require('./prove-route').mount(app, { chiaveLimite });


// ─── Cache ricerche recenti (§17.4) ───────────────────────────────────────────
// Stessa ricerca entro il TTL → risposta istantanea. NON cacha se una fonte è
// error/timeout (non congelare uno stato-bloccato) né i 0-risultati totali.
const SEARCH_CACHE_TTL = 3 * 60 * 1000;
const SEARCH_CACHE_MAX = 50;
// Se una fonte fallisce nella pagina successiva, il tentativo non pubblica nulla.
// Conserviamo per poco le altre colonne gia' COMPLETE: il clic di riprova non deve
// inviare loro le stesse richieste una seconda volta.
const pagineInSospeso = new Map();
const searchCache = new Map();   // key → { ts, data }
function searchCacheKey(p) {
  // review: includere i param-VARIANTE (mmmv AS24, slug/versione Moto.it). Senza, due ricerche
  // che differiscono SOLO per versione Moto.it o mmmv restituivano la cache l'una dell'altra
  // (es. 'Honda CBR' senza versione poi con versione scelta → payload sbagliato per 3 min).
  // Lo stesso morso, una seconda volta: il parametro-versione nato dopo (`versione`)
  // non era qui, e cercando la stessa Golf prima con
  // versione GTI e poi con GTD la seconda riceveva i risultati della prima per tre minuti.
  // Visto succedere: "Golf GTD" tornava sessanta GTI, con le etichette tutte "esatto".
  // Chi aggiunge un parametro che cambia i RISULTATI deve aggiungerlo anche qui.
  // I filtri avanzati sono un OGGETTO, quindi non basta interpolarlo: `[object Object]`
  // sarebbe identico per carrozzeria=suv e carrozzeria=berlina, cioe' lo stesso morso una
  // terza volta. Si srotolano in coppie ordinate, cosi' due scelte diverse danno chiavi diverse.
  const avanzati = filtriAuto.chiaveCache(p.filtriAuto);
  return ['_cacheScope', 'tipo', 'marca', 'modello', 'prezzoMin', 'prezzoMax', 'annoMin', 'annoMax', 'kmMin', 'kmMax',
          'regione', 'raggio', 'mmmvAutoscout', 'motoitBrandSlug', 'motoitModelSlug', 'motoitBikeCode',
          'versione', 'fetta', 'fontiPagina', 'subitoMainStart', 'subitoRecuperoStart']
    .map(f => `${f}=${p[f] ?? ''}`).concat(`avanzati=${avanzati}`).join('&').toLowerCase();
}
function cacheable(data) {
  // 'timeout' e' uno stato-rotto come gli altri, e mancava: se AS24 o Moto.it scadevano mentre
  // un'altra fonte portava annunci, la risposta MONCA entrava in cache per tre minuti. L'utente
  // vedeva il badge rosso, ripremeva Cerca e riceveva istantaneamente la stessa risposta senza
  // che nessuna richiesta ripartisse: l'unico gesto per rimediare non faceva nulla.
  const bad = s => s === 'error' || s === 'timeout';
  const src = data.sources || {};
  if (Object.values(src).some(s => s?.pausa?.fermo || s?.pausa?.verifica)) return false;
  if (bad(src.subito?.status) || bad(src.autoscout?.status) || bad(src.moto?.status)) return false;
  // Un risultato PARZIALE (grafie AS24 cadute con item superstiti) e' monco quanto un
  // timeout: congelarlo tre minuti renderebbe inutile il gesto di ripremere Cerca.
  if (src.autoscout?.parziale || src.moto?.parziale) return false;
  // Per Subito conta il flag di incompletezza di rete, non il testo dell’avviso.
  if (src.subito?.parzialeRete) return false;
  // Il menu versioni Moto.it caduto per RETE: la ricerca parte senza filtro versione (o con
  // un elenco monco che puo' agganciare la versione sbagliata) ma lo status resta 'ok'.
  // Stessa classe dei due casi qui sopra. I monchi deterministici (oltre 12 famiglie,
  // modello senza codice) NON alzano questo flag e restano cachabili: ritentare non cambia.
  if (src.moto?.versioneKoRete) return false;
  if (src.moto?.modelloKoRete) return false;
  return (data.totale || 0) > 0;
}

// Wrapper con cache attorno al core.
/**
 * LA STESSA RICERCA GIA' IN VOLO NON SI RIFA': la seconda si attacca alla prima.
 *
 * La cache copre le risposte GIA' ARRIVATE; fra la partenza e l'arrivo non c'era niente,
 * e due schede aperte (o un doppio clic su Cerca) facevano due giri completi verso Subito,
 * Autoscout e Moto.it per la stessa identica domanda — doppio costo verso le fonti proprio
 * nel momento in cui e' piu' facile farsi bloccare. La mappa e' lo stampo di detail.js:26
 * e motoit-models: chiave uguale a quella della cache, quindi due ricerche diverse restano
 * due ricerche.
 */
const searchInFlight = new Map();   // chiave cache → Promise
async function runSearch(params) {
  const key = searchCacheKey(params);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.ts < SEARCH_CACHE_TTL) {
    searchCache.delete(key); searchCache.set(key, hit);   // LRU touch
    return salute.conStatoFonti(hit.data);
  }
  if (searchInFlight.has(key)) return salute.conStatoFonti(await searchInFlight.get(key));
  // Il conto delle richieste si apre QUI, non attorno a runSearch: una risposta servita
  // dalla cache non costa richieste, e contarla come "0" annacquerebbe la misura.
  const etichetta = [params.tipo, params.marca, params.modello].filter(Boolean).join(' ');
  const p = (async () => {
    const data = await budget.perRicerca(etichetta || 'ricerca', () => runSearchCore(params));
    if (cacheable(data)) {
      searchCache.set(key, { ts: Date.now(), data });
      if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
    }
    return data;
  })();
  // `finally` PRIMA del return: se la ricerca fallisce la chiave si libera comunque, senno'
  // un errore transitorio incollerebbe tutte le richieste successive a una Promise gia'
  // rifiutata. Chi era attaccato riceve lo stesso errore, che e' la verita' per tutti.
  searchInFlight.set(key, p);
  try { return salute.conStatoFonti(await p); } finally { searchInFlight.delete(key); }
}

/**
 * A CHE LIVELLO si e' allargata la ricerca AS24 quando la prima passata era vuota.
 *
 * Il codice PROPRIO del modello e' solo `mmmvAutoscout`: `autoscoutMmmv` sul ramo moto
 * fase-1 porta il codice del PADRE, che ha SEMPRE la parte-modello valorizzata (misurato:
 * 7779/7779 nel catalogo). Leggendo quello, l'esito 'padre' era irraggiungibile — ogni
 * riallargamento usciva 'versione', il banner interpolava `params.versione` (null,
 * letteralmente a schermo, su ricerche senza versione) e diceva "mostro tutte le versioni
 * di Dorsoduro 1200" mentre in lista c'erano i fratelli 750 e 900.
 * Pura e a modulo per essere provabile senza aprire porte.
 */
function as24LivelloAllargamento(params, asRes, as24Allargato) {
  if (!as24Allargato) return null;
  const modelloAncoraFiltrato = Boolean(String(params.mmmvAutoscout || '').split('|')[1]);
  if (asRes.viaSoloModello || modelloAncoraFiltrato) return 'versione';
  return params.as24Padre ? 'padre' : 'marca';
}

// ─── Core ricerca RIUSABILE (§11) ─────────────────────────────────────────────
// Pipeline unica: risoluzione metadata → scraping multi-fonte → post-filter →
// stato per-fonte. Chiamata dalla rotta /api/search e dalla superficie di test
// _amrSearchFn; restituisce l'oggetto della risposta.
async function runSearchCore(params) {
  const richiesta = f => !params.fontiPagina || params.fontiPagina.split(',').includes(f);
  const as24Retry = { retryPages: true, retryScope: params._cacheScope || 'interno' };
  // ── Risoluzione metadata per-sito dal catalogo unificato ──────────────────
  // Subito: gli id del suo catalogo (cb/cm auto, bb/bm moto) — vedi subito-nodo.
  // Autoscout24: serve mmmvAutoscout (livello modello, fallback livello brand).
  // Moto.it: servono motoitBrandSlug + motoitModelSlug (slug-based, niente fallback).

  // SUBITO PER ID. Il testo libero resta il ripiego, non la regola: misurato sui primi
  // 50 risultati di sei veicoli, il testo dava 213 su 300 giusti (71%) e su "Audi 80"
  // zero. Quando il nodo non si risolve si torna al testo, e lo si DICHIARA nello stato
  // della fonte: una ricerca approssimata deve dirsi tale.
  // AMR_SUBITO_TESTO=1 rimette il testo libero senza toccare il codice: serve per
  // confrontare vecchio e nuovo sulla stessa app, ed e' la leva se la fonte cambia idea.
  params.subitoNodo = process.env.AMR_SUBITO_TESTO === '1'
    ? null : (risolviNodo(params.tipo, params.marca, params.modello) || null);
  if (params.subitoNodo && !params.subitoNodo.famigliaIds && params.modello) {
    params.subitoNodo = null;   // marca sola con un modello chiesto: il testo fa meglio
  }
  // I BUCHI DEL PONTE. Tredici modelli Autoscout che su Subito non sono una famiglia ma
  // una versione dentro una famiglia ("Golf GTI" dentro "Golf"): il nodo risolto da solo
  // li porta alla famiglia intera, cioe' a tutte le Golf. L'aggancio scritto a mano
  // aggiunge il testo che li isola. Misurato sui titoli dei venditori: 44% → 91% sui
  // dieci col testo. AMR_PONTE_BUCHI=0 lo spegne per confrontare vecchio e nuovo.
  if (process.env.AMR_PONTE_BUCHI !== '0') {
    const buco = agganciaSubito(params.tipo, params.marca, params.modello);
    if (buco) {
      params.subitoNodo = buco;
      console.log(`[ponte] Subito "${params.marca} ${params.modello}": buco chiuso — famiglia ${buco.famigliaNome}${buco.testo ? ` + testo "${buco.testo}"` : ''}`);
    }
  }
  // LA VERSIONE HA BISOGNO DELLA FAMIGLIA PER VIAGGIARE.
  //
  // `cv`/`bv` vivono accanto a `cb`/`cm`: senza un nodo risolto la ricerca va a testo
  // libero e la versione scelta non parte per nessuno. Succede proprio ai modelli col
  // nome di Autoscout ("320"), che ora nel menu le versioni ce le hanno — sarebbe un
  // menu che promette un filtro e non lo applica.
  //
  // Si risolve la famiglia leggendo il ponte al contrario, e SOLO quando una versione
  // e' stata scelta: senza versione il nodo resta com'era. Il motivo e' misurato —
  // cercando "320" il testo libero prende le 320, la famiglia "Serie 3" prenderebbe
  // anche 316 e 318. Con la versione il rischio non c'e': l'id di versione e' piu'
  // stretto della famiglia, e restringe a quella sola.
  // Vale per QUALUNQUE versione scelta, non solo per quelle di Subito: se arriva dal
  // catalogo Autoscout serve lo stesso, perche' senza famiglia non c'e' nemmeno l'insieme
  // di id su cui filtrare. Visto succedere: "BMW 320" + versione "320d" tornava cento
  // annunci e nessuno marcato esatto, perche' il nodo restava vuoto.
  if (!params.subitoNodo && params.versione && params.mmmvAutoscout) {
    // Il ponte puo' proporre piu' famiglie: nessuna e' la scelta univoca dell'utente.
    // In quel caso la ricerca resta a testo libero, anche sulle auto.
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

  // ── TRADUZIONE DI LIVELLO: il ponte dice ad Autoscout quali modelli sono ────
  // Le tre fonti tagliano il veicolo su piani diversi. "Serie 3" e' una voce su Subito
  // e undici modelli su Autoscout, perche' li' il motore E' il modello. Senza questo,
  // per quei veicoli si scende a livello marca e si restringe filtrando i titoli —
  // misurato su "Beta R-12": 100 annunci mostrati, 100 di un altro modello.
  //
  // Si UNISCE a quello che l'app trova gia' (mai si sostituisce): un codice in piu'
  // allarga dentro la stessa marca, un codice al posto di un altro sposterebbe la
  // ricerca su un veicolo diverso. Misurati 7 casi auto e 8 moto dove i due indicano
  // modelli diversi ed entrambi sono legittimi (Ford "Focus/Focus C-Max").
  //
  // Autoscout accetta piu' modelli nella STESSA query (verificato) → zero richieste
  // in piu'. E dove il codice compare, il ramo multi-grafia (una richiesta per grafia)
  // smette di servire: il costo scende, non sale.
  // AMR_PONTE_AS24=0 spegne la traduzione senza toccare il codice: serve a confrontare
  // vecchio e nuovo sulla stessa app, ed e' la leva se il ponte sbagliasse un aggancio.
  /**
   * MA LA FAMIGLIA PUO' ESSERE PIU' LARGA DI QUELLO CHE HAI CHIESTO, e allora unire
   * ALLARGA invece di completare.
   *
   * Il ponte parte dal nome della FAMIGLIA Subito. Quando la famiglia E' il veicolo
   * chiesto ("Golf" → Golf, Golf Variant, Golf Plus su AS24) unire e' esattamente il
   * punto. Ma quando il chiesto vive DENTRO la famiglia ("Golf GTD" sta nella famiglia
   * Subito "Golf"), unire rimette in lista tutte le Golf: misurato dal vivo, "Golf GTD"
   * + versione "Variant" tornava 74|76518|| UNITO a 74|2084||, cioe' 68 Golf Variant
   * senza GTD — e tutte marcate 'esatto', perche' il codice-modello c'era e nessuno
   * dichiarava che era stato allargato.
   *
   * Il segnale di "famiglia piu' larga" c'e' gia': e' il testo che isola il modello
   * dentro di essa — quello provato a mano (`testo`) o quello dedotto dal catalogo
   * (`testoDedotto`). Se c'e' quel testo E abbiamo gia' il codice del modello, il ponte
   * non ha niente da aggiungere: sarebbe solo rumore piu' largo.
   */
  const codiceModello = Boolean(String(params.mmmvAutoscout || '').split('|')[1]);
  const famigliaPiuLarga = Boolean(params.subitoNodo
    && (params.subitoNodo.testo || params.subitoNodo.testoDedotto));
  if (params.subitoNodo && params.subitoNodo.famigliaNome && process.env.AMR_PONTE_AS24 !== '0'
      && !(codiceModello && famigliaPiuLarga)) {
    const dalPonte = codiciAs24(params.tipo, params.subitoNodo.marcaNome, params.subitoNodo.famigliaNome);
    const uniti = unisciCodici(params.mmmvAutoscout, dalPonte);
    if (uniti.length > 1) {
      params.autoscoutModelli = uniti;
      if (!params.mmmvAutoscout) params.mmmvAutoscout = uniti[0];   // il resto del codice legge questo
      console.log(`[ponte] AS24 "${params.marca} ${params.modello}": ${uniti.length} modelli — ${uniti.join(' ')}`);
    } else if (uniti.length === 1 && !params.mmmvAutoscout) {
      params.mmmvAutoscout = uniti[0];
      console.log(`[ponte] AS24 "${params.marca} ${params.modello}": codice dal ponte ${uniti[0]} (l'app non lo trovava)`);
    }
  }

  // Il ponte AS24 sopra puo' ancora usare la famiglia risolta. Per la richiesta Hades,
  // una voce AMR che aggancia piu' famiglie non identifica un solo filtro nativo.
  if (params.subitoNodo?.famigliaIds?.length > 1) params.subitoNodo = null;

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
      // TERZO ingresso dello slug, e vuole la correzione come gli altri due (menu e
      // parametro dal client): `modelEntry` esce da data/models.json GREZZO, quindi qui
      // passa il kx-250 che Moto.it non conosce — e assegnandolo si salta pure
      // famiglieMotoit, cioe' l'unica via che avrebbe ripescato lo slug buono.
      params.motoitModelSlug = correggiModelSlug(modelEntry.slugMotoIt);
    }
    // Slug-modello ON-DEMAND dalla pagina-brand Moto.it (catalogo incompleto: lo
    // slug manca per molti modelli → senza, la ricerca browser sarebbe brand-only
    // = undersampling, es. 2 Hornet su 39 honda economici). È una SINGOLA richiesta
    // HTTP cacheable 12h (NON il burst parallelo soft-bloccato) → veloce e affidabile
    // in uso normale. Risolto lo slug, il browser cerca server-side `model=`.
    if (richiesta('moto') && !params.motoitModelSlug && params.motoitBrandSlug && params.modello) {
      try {
        // TUTTE le famiglie che il nome aggancia, non una sorteggiata: su Moto.it la stessa
        // moto e' spezzata per cilindrata ("Scarabeo" sono nove famiglie) e prima si teneva la
        // piu' corta — cercando le Scarabeo 500 arrivavano gli scooter 50. Misurato dal vivo:
        // una famiglia 29 annunci, tutte e nove 71.
        params.motoitModelSlug = await famiglieMotoit(params.motoitBrandSlug, params.modello, { rilancia: true }) || null;
      } catch (_) {
        // La ricerca larga resta possibile, ma un menu non letto non prova che il modello manchi.
        params.motoitModelloKoRete = true;
      }
    }
  }

  // makeId AS24: dal catalogo (fuzzy lookup recupera anche le entry con nome-variante,
  // es. "Beta"→"Betamotor"=50011). brandOnAutoscout dipende dal makeId, non dalla
  // sola presenza dell'oggetto autoscout (2 marche moto hanno autoscout senza makeId).
  const asMakeId         = asMeta?.makeId || null;
  const brandOnAutoscout = Boolean(asMakeId);
  const brandOnMotoIt    = Boolean(params.motoitBrandSlug);  // slug reale risolto

  // Passa mmmv AS24 al scraper: livello modello > livello brand (brand-only = makeId|||).
  if (asMakeId) {
    params.autoscoutMmmv = params.mmmvAutoscout || `${asMakeId}|||`;
    // F50 fase 1 — modelli MOTO senza codice-modello (18,6%): invece della pesca cieca
    // brand-only (100 annunci dal più economico, dove il modello spesso non c'è), si
    // restringe con il codice del modello-PADRE dedotto dal catalogo + il filtro
    // testuale NATIVO di AS24. Le auto non passano di qui (100% ha già il codice).
    if (params.tipo === 'moto' && params.modello && !params.mmmvAutoscout) {
      const nar = resolveAs24Narrowing(brandEntry?.models, params.modello, asMakeId);
      params.autoscoutMmmv = nar.mmmv;
      params.autoscoutVersionText = nar.versionText;
      params.autoscoutSpellings = as24Spellings(params.modello);   // grafie alternative (unione)
      params.as24Padre = nar.padre;   // solo per diagnostica/UI
      // I FRATELLI del modello cercato dentro il bucket del padre ("Dorsoduro 750"/"900"
      // cercando "Dorsoduro 1200"): servono alla marcatura per-riga quando il testo nativo
      // cade e il bucket porta anche loro. Si escludono il padre stesso e ogni prefisso del
      // cercato, senno' "Dorsoduro" marcherebbe 'altro-modello' anche i veri 1200.
      params.as24Fratelli = nar.padre
        ? (brandEntry?.models || []).map(m => m.nome).filter(n =>
            norm(n).startsWith(norm(nar.padre)) && norm(n) !== norm(params.modello)
            && !norm(params.modello).startsWith(norm(n)))
        : null;
      console.log(`[server] AS24 fase1 "${params.marca} ${params.modello}": mmmv=${nar.mmmv}${nar.padre ? ` (padre "${nar.padre}")` : ' (brand-only)'} + grafie ${JSON.stringify(params.autoscoutSpellings)}`);
    }
    // LA VERSIONE SU AUTOSCOUT, E IL TESTO LO SCRIVE LUI, NON NOI.
    //
    // Il campo versione della ricerca AS24 e' `modelVersionInput`: testo, parole intere,
    // piu' parole in AND. Finora glielo mandavamo solo per i modelli senza codice; la
    // versione scelta dall'utente non ci arrivava mai.
    //
    // Prima lo ricavavo dal nome di Subito togliendo quello che mi sembrava rumore
    // (`cat`, `porte`, le cifre sciolte). Era una regola scritta guardando un caso solo,
    // e altrove taglia troppo o troppo poco. Autoscout ha il proprio catalogo di versioni
    // — la tendina che il venditore usa per inserire l'annuncio — e il suo `subtitle` e'
    // esattamente il testo che il campo `modelVersionInput` riconosce: misurato "320d"
    // 50 annunci su 50, "Gran Turismo 320d" 50 su 50.
    //
    // Arriva dal campo versione, scritto dall'utente: non e' una nostra traduzione.
    // Se non c'e' non si manda niente, e la riga lo dichiara — vedi `etichettaAs24`.
    //
    // IL VINCOLO DA NON ROMPERE: se il testo restringesse troppo, la ricerca tornerebbe
    // vuota; il ritentativo senza testo (piu' sotto, `asRes.status === 'empty'`) deve
    // restare — e' la rete che impedisce a una versione rara di azzerare la fonte.
    if (params.versione) {
      // Il testo del SOLO modello si tiene da parte: e' il gradino intermedio del
      // riallargamento (vedi piu' sotto). Senza, l'unica via di uscita da una versione che
      // svuota sarebbe saltare direttamente al bucket del padre, cioe' a un altro modello.
      params.autoscoutVersionModello = params.autoscoutVersionText || null;
      params.autoscoutVersionText = [params.autoscoutVersionText, params.versione].filter(Boolean).join(' ');
      console.log(`[server] AS24 versione: "${params.versione}"`);
    }
  }

  /**
   * E SUBITO? Il testo va in `q=`, SOPRA gli id di marca e modello.
   *
   * Non e' la ricerca a testo libero di Subito — quella sbaglia un risultato su tre
   * (misurato: 213 su 300, e su "Audi 80" zero, perche' "80" pesca dentro "180 CV" e
   * "80.000 km"). Qui gli id garantiscono gia' marca e modello, e `q` restringe DENTRO:
   * le Golf sono 11.646, con `q=gti` diventano 1.631.
   *
   * E NON FILTRIAMO NOI A VALLE. La fonte risponde, e quello che risponde si mostra:
   * "Subito riceve quello che ho scritto" vuol dire anche che non ci mettiamo in mezzo
   * dopo. Il controllo sul nome-versione dichiarato resta acceso solo per `nodo.testo`,
   * che e' un'altra cosa — il modello che vive dentro una famiglia ("Golf GTI" dentro
   * Golf) — e senza quello "Golf GTI" tornerebbe a pescare tutte le Golf.
   */
  if (params.versione && params.subitoNodo) {
    params.subitoVersioneTesto = params.versione;
    console.log(`[server] Subito: q="${params.versione}" sopra gli id di marca/modello`);
  } else if (params.versione) {
    /**
     * SENZA NODO la ricerca Subito e' gia' testo libero (q = marca+modello) — e la
     * versione scritta ci si ACCODA invece di sparire. Misurato (campagna E): il 56,9%
     * dei nomi del menu non risolve un nodo, e per tutti quelli la versione digitata
     * non partiva MAI verso Subito, in silenzio: si chiedeva «Golf GTD» e si riceveva
     * ogni Golf, presentata come risposta alla domanda intera. Il testo resta testo
     * (niente id quasi giusti): restringe come restringono le altre parole di q.
     */
    params.subitoVersioneTesto = params.versione;
    console.log(`[server] Subito: versione "${params.versione}" accodata al testo libero`);
  }

  /**
   * E MOTO.IT? E' l'unica che vuole un codice, quindi l'unica dove il testo va tradotto.
   * Vedi backend/scrapers/motoit-versione.js per il come e per i numeri.
   */
  if (richiesta('moto') && params.versione && params.tipo === 'moto'
      && params.motoitBrandSlug && params.motoitModelSlug && !params.motoitBikeCode) {
    try {
      // `motoitModelSlug` puo' essere una LISTA di famiglie (vedi famiglieMotoit): getModelBikes
      // ne vuole una sola, quindi si raccolgono le versioni di tutte. Le richieste sono cachate
      // 12h. Tetto a 12 famiglie: oltre si cerca senza filtro versione, e lo si dice.
      const fam = String(params.motoitModelSlug).split(',').map(s => s.trim()).filter(Boolean);
      const TETTO_FAM = 12;
      if (fam.length > TETTO_FAM) {
        // «e lo si dice» significa A SCHERMO: il solo console.log lasciava le righe
        // 'versione-non-verificata' senza spiegazione (misurato in campagna E: oggi la
        // categoria e' vuota, ma il contratto del commento era gia' falso).
        params.motoitVersioneElencoMonco = `"${params.modello}" aggancia ${fam.length} famiglie su Moto.it (oltre ${TETTO_FAM}): il filtro versione non si applica a questa fonte, si cerca largo`;
        console.log(`[server] Moto.it: ${params.motoitVersioneElencoMonco}`);
        throw new Error(`troppe famiglie (${fam.length}) per risolvere la versione`);
      }
      /**
       * IL MENU VERSIONI CHE NON RISPONDE NON E' UN CATALOGO SENZA QUELLA VERSIONE.
       *
       * `getModelBikes` chiudeva con un `.catch(() => [])`, quindi l'errore di rete e il
       * modello che davvero non ha versioni arrivavano qui identici: un elenco vuoto. Con
       * TUTTE le famiglie cadute si cercava senza filtro versione e non lo diceva nessuno —
       * l'utente aveva scritto una versione, Subito e Autoscout la applicavano, la colonna
       * Moto.it no. Con ALCUNE cadute era peggio: il filtro si stringeva su un elenco monco,
       * cioe' poteva agganciare la versione sbagliata perche' quella giusta non era arrivata.
       */
      let famigliKo = 0;
      const bikes = (await Promise.all(fam.map(s =>
        getModelBikes(params.motoitBrandSlug, s, { rilancia: true }).catch(() => { famigliKo++; return []; })
      ))).flat();
      if (famigliKo) {
        params.motoitVersioneElencoMonco = famigliKo >= fam.length
          ? 'il menu versioni di Moto.it non ha risposto: il filtro versione non e\' stato applicato a questa fonte'
          : `${famigliKo} famiglie su ${fam.length} non hanno risposto: l'elenco versioni di Moto.it e' incompleto`;
        // KO DI RETE, non di catalogo: fra un attimo puo' riuscire (motoit-models fa risalire
        // apposta l'errore per NON metterlo in cache 12h). Il flag arriva a `sources.moto`
        // dove cacheable() lo legge: senza, la risposta senza filtro versione (o col filtro
        // stretto su un elenco monco) restava 'ok' e congelava tre minuti — ripremere Cerca,
        // l'unico gesto di rimedio, non ritentava niente. Gli ALTRI due elenchi-monchi
        // (oltre 12 famiglie, modello senza codice) restano cachabili: sono deterministici,
        // ritentare da' lo stesso identico esito.
        params.motoitVersioneKoRete = true;
        console.warn(`[server] Moto.it: ${params.motoitVersioneElencoMonco}`);
      }
      const r = motoitVersione.risolvi(bikes, params.versione, { marca: params.marca, modello: params.modello });
      if (r.versioni.length === 1) {
        params.motoitBikeCode = r.versioni[0].code;
        console.log(`[server] Moto.it: "${params.versione}" → bike=${r.versioni[0].code} ("${r.versioni[0].nome}")`);
      } else if (r.versioni.length > 1) {
        // Piu' voci = la stessa moto spezzata per periodo. `bike=` ne accetta una sola,
        // quindi non si chiede alla fonte: si tengono gli annunci il cui slug e' fra queste.
        params.motoitSlugAmmessi = new Set(r.versioni.map(v => v.slug));
        console.log(`[server] Moto.it: "${params.versione}" → ${r.versioni.length} versioni, filtro sullo slug dell'annuncio`);
      } else {
        console.log(`[server] Moto.it: "${params.versione}" non e' nel suo catalogo → nessun filtro versione`);
      }
      /**
       * LE PAROLE BUTTATE VANNO DETTE A CHI GUARDA, non al registro del server.
       *
       * "Se svuota, si ignora" e' la dottrina giusta, ma il file stesso dice che la parola
       * scartata "si dice quale" — e l'unico posto in cui si diceva era questo console.log.
       * Intanto, se una parola restava, il codice versione veniva impostato e OGNI riga
       * Moto.it usciva marcata 'esatto', cioe' "versione confrontata e combaciante", su un
       * confronto fatto a meta'. Cercando "MT-07 ABS Rally": "abs" aggancia, "rally" sparisce,
       * e le righe si dichiaravano esatte.
       */
      if (r.scartate.length) {
        params.motoitVersioneScartate = r.scartate.slice();
        console.log(`[server] Moto.it: parole ignorate ${JSON.stringify(r.scartate)}`);
      }
    } catch (e) {
      console.warn('[server] Moto.it versione non risolta: ' + e.message);   // la ricerca vale lo stesso
    }
  } else if (params.versione && params.tipo === 'moto' && params.motoitBrandSlug && !params.motoitModelSlug && !params.motoitBikeCode) {
    /**
     * SENZA SLUG-MODELLO LA VERSIONE NON SI TENTA NEMMENO — E VA DETTO. Misurato in
     * campagna E: 2.074 voci moto del menu (19,3%) hanno la marca su Moto.it ma nessuno
     * slug-modello; la condizione qui sopra era falsa, il filtro versione non partiva e a
     * schermo la chip «da verificare» parlava del MODELLO, mai della versione scritta.
     * Stesso canale del banner gia' esistente: si dichiara, non si tappa.
     */
    params.motoitVersioneElencoMonco = `il modello non ha un codice su Moto.it: la ricerca su questa fonte e' larga e la versione "${params.versione}" non la filtra (righe da verificare)`;
    console.log(`[server] Moto.it: ${params.motoitVersioneElencoMonco}`);
  }
  /**
   * LA REGIONE SU AUTOSCOUT: CERCHIO LARGO, POI IL CAP.
   *
   * Autoscout un filtro "regione" non ce l'ha. Misurato oggi sulla Golf in Sicilia:
   *   nessun filtro                          6.411 annunci
   *   cerchio 100 km da Palermo                 83
   *   cerchio 250 km                           241
   *   SOLO l'etichetta "Sicilia (italy)"      6.411  ← identico a nessun filtro
   *   etichetta + cerchio 100                   83  ← identico al cerchio da solo
   * L'etichetta che il codice sa gia' mandare e' inerte: resta il cerchio. E il cerchio da
   * 100 km, in Sicilia, tagliava fuori Catania (166 km), Messina (192) e Siracusa (205):
   * 83 annunci su 241.
   *
   * Quindi il cerchio si allarga fino a coprire la regione, e la precisione la da' il CAP
   * che Autoscout manda con ogni annuncio: `data/comune-regione.json` ne mappa 12.575 alla
   * loro regione. Non e' un post-filtro che nasconde — e' il filtro che hai chiesto,
   * applicato su cio' che l'annuncio dichiara di se'.
   */
  if (params.regione && asMakeId) {
    const reg = String(params.regione).trim().toLowerCase();
    const cerchio = cerchioRegione(reg);
    if (cerchio) {
      // Il raggio scritto da te vince: li' stai chiedendo "entro N km", non "in regione", e
      // in quel caso non si filtra nemmeno sul CAP (il cerchio E' la richiesta).
      params.autoscoutGeo = params.raggio
        ? { lat: cerchio.lat, lng: cerchio.lng, radius: params.raggio }
        : cerchio;
      if (!params.raggio) params.as24RegioneDaCap = reg;
    } else {
      // Regione fuori tabella: si resta sul capoluogo, come prima.
      const ctr = regionCentroids[reg];
      if (ctr) params.autoscoutGeo = { lat: ctr.lat, lng: ctr.lng, radius: params.raggio || 100 };
    }
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

  // LE PSEUDO-MARCHE NON SI CHIEDONO A SUBITO. «Oldtimer», «Trike», «Pocket Bike» sono
  // categorie di Autoscout, non marche: la query q="Oldtimer Abarth" trovava nulla e il
  // mercato Subito passava per vuoto senza esserlo. Decisione del proprietario
  // (2026-08-08): la fonte non parte e la colonna dichiara il perche' — lo skip e' uno
  // stato esplicito, come per le altre due fonti. Su Autoscout tutto invariato.
  const skipSubito = marcaPseudo(params.tipo, params.marca);
  const subitoSkipReason = 'categoria di catalogo (Oldtimer, Trike…): Subito non ha l\'equivalente';

  /**
   * LA FONTE CHE CI STA BLOCCANDO NON SI INTERROGA. Le fonti bannano la macchina, non
   * l'utente: insistere mentre ci respingono allunga il blocco per tutti quelli che usano
   * questo Mac. `fonti-salute` decide quando smettere e per quanto (due respinte di fila, poi
   * una pausa che parte da un quarto d'ora), e qui si legge e basta.
   *
   * Lo stato e' 'skipped' e non 'error' perche' e' una scelta nostra, non un guasto: a schermo
   * la colonna resta grigia con scritto il perche', invece di accendersi in rosso.
   */
  const pausa = f => salute.fermo(f).fermo;
  const inPausaSubito = pausa('subito'), inPausaAs = pausa('autoscout'), inPausaMoto = pausa('moto');

  // Ogni fonte ritorna { items, status, reason }. Subito ha wrapper dedicato
  // Lo skip è uno stato esplicito, non un [] muto.
  // I cursori di Subito non cambiano la pagina delle altre fonti. Le porzioni
  // complete hanno una chiave propria, con tutti i filtri ma solo i propri cursori.
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
      // UNA PAGINA IN PIU' QUANDO IL CAP FILTRA. Il cerchio regione sborda nelle regioni
      // confinanti — misurato in Sicilia: dei 100 letti, 25 calabresi — e quelli il filtro
      // sul CAP li toglie. La fetta resta una pagina nativa da 50: le altre si chiedono
      // con «Carica altro», senza anticipare pagine solo per compensare il post-filtro.
      : runSource(() => scrapeAutoscoutUnion(params, { withMeta: true, fetta: params.fetta || 0,
          ...as24Retry }), TIMEOUT_MS, 'Autoscout24', 'autoscout'),
    !richiesta('moto') ? Promise.resolve(esaurita()) : salvate?.moto ? Promise.resolve(salvate.moto) : skipMotoIt
      ? Promise.resolve({ items: [], status: 'skipped', reason: motoSkipReason })
      : inPausaMoto
        ? Promise.resolve({ items: [], status: 'skipped', reason: salute.MOTIVO_PAUSA })
        : runSource(() => scrapeMotoIt(params, { withMeta: true, fetta: params.fetta || 0 }), TIMEOUT_MS, 'Moto.it', 'moto'),
  ]);

  // F50 fase 1 — riallargamento SOLO a zero risultati (scelta di prodotto: mai allargare
  // a priori). Se il filtro nativo non trova nulla, si riprova tenendo il modello-padre:
  // meglio "ti mostro anche il modello imparentato, segnalato" che una schermata vuota.
  let asRes = asRes0, as24Allargato = salvate?.autoscout?.allargato || false;
  if (!salvate?.autoscout && params.autoscoutVersionText && asRes.status === 'empty' && !asRes.parziale) {
    // UN GRADINO PER VOLTA. Ora che la versione parte davvero (vedi scrapeAutoscoutUnion), lo
    // zero-risultati non e' piu' un caso raro: il filtro di AS24 e' un AND su tutte le parole
    // ed e' durissimo — misurato su Golf, "Golf GTD" 145 annunci, "Golf GTD Variant" 1.
    // Saltare qui al bucket del padre vorrebbe dire togliere versione E modello insieme, cioe'
    // mostrare un altro modello dove prima c'erano gli annunci di questo. Quindi: prima si
    // riprova col SOLO modello (le richieste che partivano prima del fix), e solo se anche
    // quella e' vuota si scende al padre.
    // La fetta va ripassata: senza, il riallargamento ripartiva sempre dalla prima pagina, e
    // dal secondo "Carica altri" in poi da Autoscout tornavano solo annunci gia' visti.
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
      // Un ritentativo SCADUTO non e' "la fonte non ha nulla": lasciando 'empty' la risposta
      // monca finiva pure in cache per tre minuti (vedi `cacheable`). Si porta fuori lo stato
      // vero, cosi' il badge e' rosso e la ricerca si puo' rifare davvero.
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
    // autoscoutVersionText (fase 1) = AS24 ha già filtrato per modello server-side; il
    // filtro-titolo locale qui taglierebbe grafie legittime ("CFMOTO 800 MT X" non
    // contiene "800mtx") proprio sul ramo che vogliamo recuperare.
    const as24TestoPartito = Boolean(params.autoscoutVersionText);
    const autoscoutModelFiltered = r.fonte === 'autoscout' && (Boolean(params.mmmvAutoscout) || as24TestoPartito) && !params.asFilterToken;
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

    // 3. Filtri numerici. Prezzo/anno restano qui come rete ridondante: sono nativi
    //    ed esatti su tutte le fonti (Subito ps/pe·ys/ye, AS24 price·firstRegistration,
    //    Moto.it price_f/t·year_f/t) → questo blocco è un no-op innocuo.
    //    KM **NON** è qui di proposito: è nativo su tutte le fonti (Subito ms/me a
    //    categoria 5000km, AS24 mileageInKm, Moto.it km_f/km_t). Un post-filter km
    //    ri-taglierebbe il dato nativo (es. la categoria Subito over-include 5000km) →
    //    proibito. Si accetta la granularità-categoria nativa di Subito.
    if (params.prezzoMin != null && r.prezzo != null && r.prezzo < params.prezzoMin)   return false;
    if (params.prezzoMax != null && r.prezzo != null && r.prezzo > params.prezzoMax)   return false;
    if (params.annoMin   != null && r.anno   != null && r.anno   < params.annoMin)     return false;
    if (params.annoMax   != null && r.anno   != null && r.anno   > params.annoMax)     return false;

    /**
     * 4. Regione. Su Subito (`r=`) e Moto.it (`region=`) e' un filtro nativo vero e qui non
     * c'e' niente da fare. Su Autoscout no: il filtro e' un CERCHIO dal capoluogo, e
     * l'etichetta di regione che la loro API accetta e' inerte (misurato: con e senza,
     * 6.411 annunci identici). Il cerchio ora e' largo abbastanza da coprire la regione —
     * senno' in Sicilia si vedevano 83 annunci su 241 — e la precisione la da' il CAP che
     * l'annuncio dichiara.
     *
     * Non e' il vecchio post-filtro comune→regione, quello che girava su una pesca di 100
     * annunci NAZIONALI e azzerava i risultati: qui la pesca e' gia' regionale, e questo
     * toglie solo lo sbordo del cerchio nelle regioni confinanti.
     *
     * Un annuncio SENZA CAP non si butta: non si e' potuto verificare, e non verificabile
     * non vuol dire fuori regione.
     */
    if (params.as24RegioneDaCap && r.fonte === 'autoscout' && /^\d{5}$/.test(String(r.zip || ''))) {
      const reg = comuneRegione[String(r.zip)];
      if (reg && reg !== params.as24RegioneDaCap) return false;
    }

    return true;
  });

  // ── Marcatura: cosa è DAVVERO ogni annuncio rispetto a quello che hai chiesto ──
  // Subito lo dice già da sé (scrapers/subito-api: `dichiarazione` dai livelli che
  // l'annuncio dichiara). Qui si fa lo stesso per Autoscout, col modello che dichiara.
  //
  // Serve al ramo ALLARGATO: quando un modello non ha codice su AS24 (Beta R-12,
  // Ducati Scrambler 1100, Triumph Bonneville) la ricerca scende a livello marca, e fra
  // i risultati restano altri modelli. Oggi lo dice solo l'intestazione della fonte —
  // misurato su Beta R-12: 100 annunci mostrati, 100 di un altro modello, nessuno
  // marcato. Ogni riga deve dire cosa è, non solo il totale.
  if (params.modello) {
    // Quando AS24 ha filtrato per CODICE-modello (suo o tradotto dal ponte), il modello
    // e' garantito dalla fonte: confrontarlo col testo digitato darebbe il falso allarme
    // piu' odioso — cercando "Serie 3" gli annunci tornano come "320", che e' giusto.
    // Il confronto sul nome serve SOLO sul ramo allargato a livello marca.
    //
    // ATTENZIONE ALLA TRAPPOLA gia' morsa: `params.autoscoutMmmv` sul ramo moto fase-1
    // porta il codice del PADRE, che ha SEMPRE la parte-modello valorizzata (misurato:
    // 7779/7779 nel catalogo). Leggerlo qui marcava "modello garantito" le righe dei
    // FRATELLI (Dorsoduro 750/900 cercando la 1200). Il codice PROPRIO e' solo
    // `mmmvAutoscout`; sul ramo padre la garanzia esiste solo se il testo-modello nativo
    // e' partito davvero (non tolto dal retry).
    const codiceProprio = Boolean(String(params.mmmvAutoscout || '').split('|')[1]);
    const testoModelloArrivato = Boolean(params.autoscoutVersionText)
      && (!as24Allargato || Boolean(asRes.viaSoloModello));
    const as24HaFiltrato = codiceProprio || (Boolean(params.as24Padre) && testoModelloArrivato);
    // I nomi che valgono come risposta: quello digitato PIU' i membri della serie
    // commerciale. Cercando "Serie 3" gli annunci tornano come "320" o "318": senza i
    // membri verrebbero marcati "altro modello", che e' un falso allarme — sono
    // esattamente quello che si e' chiesto, con il nome che usa Autoscout.
    const nomiAmmessi = [params.modello, ...(groupMembers || [])].filter(Boolean);

    /**
     * "Esatto" si dice solo dopo un confronto. Su Autoscout la versione non e' un
     * catalogo ma testo libero, e le si manda quel testo (`modelVersionInput`): quando
     * parte, la fonte ha filtrato e la riga puo' dirsi esatta.
     *
     * Ma non parte sempre. La versione "320 2 porte", tolto il nome del modello, resta
     * "2 porte" — carrozzeria, che Autoscout tiene in un campo numerico e non nel testo.
     * Li' non si manda niente, e prima quegli annunci uscivano marcati "esatto": 99 su
     * 100, con 64 versioni diverse dentro. Una corrispondenza che nessuno aveva guardato.
     *
     * IL VINCOLO DA NON ROMPERE: senza versione scelta "esatto" continua a valere quello
     * che valeva — modello garantito dalla fonte — e non va declassato.
     */
    const versioneChiesta = Boolean(params.versione);
    // `params.autoscoutVersionText` dice cosa VOLEVAMO mandare, non cosa e' partito: il
    // riallargamento lavora su una COPIA dei parametri e
    // lasciano intatto l'originale. Leggendo solo quello, dopo un riallargamento ogni riga con
    // una variante usciva marcata 'esatto' — cioe' "versione confrontata" — su annunci di
    // qualunque allestimento, e senza nessun segno a schermo. Ora si guarda anche se e' partita.
    const as24HaVistoLaVersione = Boolean(params.autoscoutVersionText) && !as24Allargato;
    const etichettaAs24 = r => (versioneChiesta && !as24HaVistoLaVersione)
      ? 'versione-non-verificata'
      : (r.variante ? 'esatto' : 'senza-versione');

    // MOTO.IT. Il filtro e' server-side quando lo slug-modello e' risolto (`model=`);
    // altrimenti si e' allargato alla marca e il post-filtro tiene solo i titoli che
    // nominano il modello — quegli annunci sono corretti ma riconosciuti dal titolo,
    // non dal catalogo, ed e' giusto che lo dicano. Con `bike=` c'e' anche la versione.
    for (const r of risultati) {
      if (r.fonte !== 'moto' || r.dichiarazione) continue;
      if (!params.motoitModelSlug) r.dichiarazione = 'senza-modello';
      // La versione su Moto.it e' filtrata in due modi, e valgono uguale: `bike=` quando
      // il testo ne aggancia una sola, lo slug dichiarato dall'annuncio quando ne aggancia
      // piu' d'una (la stessa moto spezzata per periodo).
      // Con una parola della versione buttata via, il confronto e' stato fatto a META': la
      // riga non puo' dirsi 'esatto', che significa "versione confrontata e combaciante".
      // "MT-07 ABS Rally": "abs" aggancia, "rally" non esiste in quel catalogo e sparisce.
      else if (params.motoitBikeCode || (params.motoitSlugAmmessi && params.motoitSlugAmmessi.size)) {
        r.dichiarazione = (params.motoitVersioneScartate && params.motoitVersioneScartate.length)
          ? 'versione-non-verificata' : 'esatto';
      }
      /**
       * QUI L'ETICHETTA RACCONTAVA IL NOSTRO FILTRO, NON L'ANNUNCIO.
       *
       * Senza `bike=` e senza slug ammessi ogni riga usciva 'senza-versione', che a schermo
       * diventa «Il venditore non ha indicato la versione» — e su Moto.it e' falso: la
       * versione sta nell'URL dell'annuncio, e l'app quello slug lo sa leggere (lo usa gia'
       * per filtrare). Misurato su una ricerca Honda CB 500: sette righe su sette dicevano
       * «versione n.d.» mentre gli URL portavano `cb-500` e `cb-500-s`, due moto diverse.
       *
       * Adesso `r.variante` c'e' anche su Moto.it (vedi scrapers/motoit.js), quindi vale la
       * STESSA riga che governa Subito e Autoscout: se la versione e' dichiarata si dice
       * quella, se non c'e' si dice che non c'e'.
       *
       * E il caso «versione chiesta ma non applicata»: li' Subito riceve
       * 'versione-non-verificata' e Moto.it riceveva 'senza-versione' — due frasi per la
       * stessa situazione, e quella che dava la colpa al venditore era la sbagliata.
       */
      else if (versioneChiesta) r.dichiarazione = 'versione-non-verificata';
      else r.dichiarazione = r.variante ? 'esatto' : 'senza-versione';
    }

    // SUBITO. Stessa regola di Autoscout, e la simmetria conta perche' e' lo stesso
    // utente che legge le due colonne affiancate: se il testo e' partito, la fonte ha
    // filtrato; se non e' partito, non si scrive "esatto" dove non si e' guardato.
    const subitoHaConfrontato = Boolean(params.subitoVersioneTesto || (params.subitoNodo && params.subitoNodo.testo));
    if (versioneChiesta && !subitoHaConfrontato) {
      for (const r of risultati) if (r.fonte === 'subito') r.dichiarazione = 'versione-non-verificata';
    }

    for (const r of risultati) {
      if (r.fonte !== 'autoscout' || r.dichiarazione) continue;
      if (as24HaFiltrato) { r.dichiarazione = etichettaAs24(r); continue; }
      /**
       * BUCKET DEL PADRE SENZA TESTO NATIVO: qui `combaciaModello` non basta. Ogni
       * annuncio del bucket dichiara il nome del PADRE ("Dorsoduro"), che per la regola
       * del sottoinsieme combacia con "Dorsoduro 1200" — e i fratelli (750/900)
       * uscirebbero 'esatto'. Si decide col TITOLO, come il post-filtro moto: se nomina
       * il modello cercato e' 'senza-modello' (riconosciuto dal titolo, non dal
       * catalogo — esattamente vero qui); se nomina un fratello e' 'altro-modello';
       * altrimenti nessuna pretesa. L'ordine cercato-prima-dei-fratelli e' obbligatorio:
       * "Dorsoduro 1200" contiene "Dorsoduro". Le righe fratelle RESTANO in lista
       * ("se svuota, si ignora"): cambia solo l'etichetta.
       */
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
        if (x === false) c = false;          // nessuno combacia finora, ma il dato c'e'
      }
      if (c === true) r.dichiarazione = etichettaAs24(r);
      else if (c === false) r.dichiarazione = 'altro-modello';
      // c === null: AS24 non dichiara il modello ("Altro") → nessuna pretesa, nessun marchio
    }
  }

  // Conteggio per fonte DOPO il post-filter (riflette ciò che l'utente vede)
  const countBy = f => risultati.filter(r => r.fonte === f).length;
  const asCount = countBy('autoscout');

  // §12: AS24 brand-only narrowato per titolo (serie/modello irrisolto) e finito a 0
  // → reason esplicita, così la UI distingue "0 per filtro titolo" da errore/vuoto-vero.
  // La frase diceva sempre "mostro il padre / la marca", anche quando il riallargamento si era
  // fermato al gradino intermedio (stesso modello, senza versione): li' il modello e' ancora
  // quello giusto ed e' la VERSIONE a non essere stata applicata. Dirlo com'e'.
  // A CHE LIVELLO ci si e' allargati. Non basta guardare `as24Padre`: quando il modello ha il
  // suo codice AS24 (`mmmv` con la parte-modello valorizzata) il ritentativo lo TIENE, e toglie
  // la sola versione — misurato su Golf + una versione inesistente: tornano 100 annunci, tutti
  // Golf. Dire li' "mostro tutta la marca" sarebbe una bugia, ed e' proprio il difetto che
  // questo blocco corregge.
  const asAllargatoA = as24LivelloAllargamento(params, asRes, as24Allargato);
  const asReason = as24Allargato
    ? (asAllargatoA === 'versione'
        ? `nessuna "${params.versione}" su Autoscout: mostro tutte le versioni di "${params.modello}"`
        : `nessun "${params.modello}" su Autoscout: mostro ${params.as24Padre ? `il modello base "${params.as24Padre}"` : 'tutta la marca'}`)
    : (autoTokenRe && asCount === 0 && asRes.status === 'ok')
      ? 'modello filtrato per titolo'
      : (asRes.reason || null);

  /**
   * LA VERSIONE, VERIFICATA DA NOI E UGUALE PER TUTTE E TRE LE COLONNE.
   *
   * Ogni fonte applicava la versione a un dato diverso: Autoscout al campo (100% di
   * precisione su 16 casi), Subito al titolo scritto dal venditore (mediana 82%, mai 100%),
   * Moto.it a un codice o a niente (100% oppure 0%). La stessa richiesta significava tre cose.
   * Qui si marca soltanto — togliere e' compito del browser, cosi' il totale resta onesto e la
   * riga "mostrali" ha ancora cosa mostrare. Vedi backend/versione-verifica.js.
   */
  // Se il modello AMR include una sigla che Subito cataloga come versione della
  // famiglia (es. 748 R sotto 748), confrontiamo il campo nativo degli annunci
  // Subito. Le altre fonti possono modellare quella sigla come modello autonomo.
  const versioneConto = versioneVerifica.marcaRicerca(risultati, params.versione, params.subitoNodo);

  return {
    risultati,
    totale:       risultati.length,
    // Quanti non dichiarano la versione chiesta: il browser li tiene fuori e lo scrive.
    versioneChiesta: params.versione || null,
    versioneConto:   versioneConto ? versioneConto.conto : null,
    versionePerFonte: versioneConto ? versioneConto.perFonte : null,
    subitoStatus: subitoRes.status,
    subitoReason: subitoRes.reason || null,
    // Stato per-fonte: la UI distingue saltato / vuoto / errore / ok.
    sources: {
      // `come` dice SU COSA si e' cercato: gli id del catalogo Subito, oppure il testo.
      // Il testo e' il ripiego (71% di precisione misurata) e deve risultare, non passare
      // per una ricerca precisa che non e'.
      // `count` = quanti ne mostriamo dopo i nostri filtri. `totale` = quanti ne ha la
      // FONTE per questa ricerca. Sono due popolazioni diverse e restano due numeri.
      subito:    { status: subitoRes.status, reason: subitoRes.reason || null, count: countBy('subito'),
                   totale: subitoRes.total ?? null, hasMore: subitoRes.hasMore ?? null,
                   mainNextStart: subitoRes.mainNextStart ?? null,
                   recuperoNextStart: subitoRes.recuperoNextStart ?? null,
                   erroreTipo: subitoRes.erroreTipo || null, erroreHttp: subitoRes.erroreHttp || null,
                   erroreCodice: subitoRes.erroreCodice || null,
                   errori: subitoRes.erroriSubito || [],
                   pausa: salute.fermo('subito'),
                   parziale: subitoRes.parziale || null,
                   // Un risultato parziale per guasto di rete non va congelato in cache.
                   parzialeRete: subitoRes.parzialeRete || null,
      // Senza nodo di catalogo la ricerca Hades usa il testo libero.
                   come: params.subitoNodo ? (params.subitoNodo.come || 'id') : 'testo libero',
                   // La famiglia da cui e' partita la ricerca: serve all'avviso
                   // dell'allestimento, che senza il nome direbbe meta' della verita'.
                   famigliaNome: (params.subitoNodo && params.subitoNodo.famigliaNome) || null,
                   // Il filtro km di Subito lavora a FASCE, su ENTRAMBI i lati: chiedendo un
                   // massimo di 200.000 arrivano annunci fino a 249.999, e chiedendone un minimo
                   // di 22.000 arrivano da 20.000. Finora non si notava perche' mostravamo il
                   // fondo-fascia; ora che i km sono quelli veri, si dice invece di far sembrare
                   // un errore dell'app. Coi numeri tondi non c'e' niente da dire: e' null.
                   kmFino: scrapeSubitoApi.kmTettoFascia(params.kmMax),
                   kmDa:   scrapeSubitoApi.kmPavimentoFascia(params.kmMin) },
      // `allargato` sta ACCANTO allo status, mai al posto suo ('ok' resta 'ok', quindi cache e
      // "Carica altri" non cambiano comportamento). Serve perche' `reason` la UI la stampava
      // solo per le fonti 'skipped', e queste frasi nascono proprio a status 'ok': il
      // riallargamento veniva calcolato, spedito, e non arrivava mai sotto gli occhi di nessuno.
      autoscout: { status: asRes.status,     reason: asReason,                 count: asCount,
                   totale: asRes.total ?? null, hasMore: asRes.hasMore ?? null,
                   erroreTipo: asRes.erroreTipo || null, erroreHttp: asRes.erroreHttp || null,
                   erroreCodice: asRes.erroreCodice || null,
                   parzialeRete: asRes.parzialeRete || null,
                   pausa: salute.fermo('autoscout'), allargato: asAllargatoA,
                   // Grafie AS24 cadute con superstiti: gli item ci sono ma ne mancano
                   // altri. cacheable() lo legge per non congelare la risposta monca.
                   parziale: asRes.parziale || null },
      moto:      { status: motoRes.status,   reason: motoRes.reason || null,   count: countBy('moto'),
                   totale: motoRes.total ?? null, hasMore: motoRes.hasMore ?? null,
                   erroreTipo: motoRes.erroreTipo || null, erroreHttp: motoRes.erroreHttp || null,
                   erroreCodice: motoRes.erroreCodice || null,
                   parzialeRete: motoRes.parzialeRete || null,
                   pausa: salute.fermo('moto'),
                   // Senza lo slug del modello la ricerca si allarga alla MARCA, e il totale
                   // in pagina e' quello della marca: la pill scriveva "39 di 148" come se
                   // quel 148 fosse del modello chiesto. Il numero resta, e dice di chi e'.
                   totaleLargo: motoRes.totaleLargo || null,
                   // Anche qui, come per Autoscout: un elenco monco che non si dichiara e'
                   // esattamente il difetto che questo campo chiude.
                   parziale: motoRes.parziale || null,
                   // Le parole della versione che il catalogo Moto.it non conosce e che sono
                   // state ignorate ("se svuota, si ignora"). Finora finivano in un log del
                   // server, cioe' in nessun posto che l'utente possa guardare, mentre a
                   // schermo le righe si dichiaravano "esatto".
                   versioneIgnorata: (params.motoitVersioneScartate && params.motoitVersioneScartate.length)
                     ? params.motoitVersioneScartate : null,
                   // Il menu versioni che non ha risposto: senza, un timeout della fonte
                   // valeva "questa versione non esiste a catalogo".
                   versioneElencoMonco: params.motoitVersioneElencoMonco || null,
                   // Vero SOLO quando l'elenco monco viene da un KO di rete (transitorio):
                   // cacheable() lo legge per non congelare tre minuti una ricerca partita
                   // senza filtro versione. I monchi deterministici non lo alzano.
                   versioneKoRete: params.motoitVersioneKoRete || null,
                   modelloKoRete: params.motoitModelloKoRete || null },
    },
  };
}

// Superficie interna ancora usata dai test di ricerca: mantiene il percorso in-process
// e la sua validazione, compreso il tetto giornaliero. Non ha chiamanti di produzione
// dopo l'accantonamento del bot; va rimossa solo insieme alla migrazione dei test.
const amrSearchFn = async (input, utente) => {
  const q = { ...input, tipo: input.tipo || 'auto' };
  let parsed = parseSearchParams(q);
  if (parsed.errors && q.regione) { delete q.regione; parsed = parseSearchParams(q); }   // regione invalida → droppa e riprova
  if (parsed.errors) return { error: parsed.errors.join(', ') };
  parsed.params._cacheScope = utente?.id || 'interno';
  // IL TETTO GIORNALIERO VALE ANCHE QUI. Questa closure arriva a runSearch in-process e
  // saltava il gate di /api/search: un 'demo' fermo alle 50 ricerche sul web continuava
  // illimitato da WhatsApp, dallo stesso IP di casa che il tetto deve proteggere. Stessa
  // regola del web: paga solo il ruolo demo con identita' (owner, full e il fallback legacy
  // senza identita' no), e l'addebito sta DOPO la validazione — un parametro sbagliato non
  // costa una delle 50. Se il magazzino non si apre, consumaRicerca lancia: fail-closed,
  // come il 503 del web (il chiamante risponde "errore tecnico", non cerca).
  if (utente && utente.ruolo === 'demo' && utente.id) {
    const g = utentiDb.consumaRicerca(String(utente.id), TETTO_GIORNALIERO);
    if (!g.ok) return { tettoEsaurito: { usate: g.usate, max: g.max } };
  }
  const data = await runSearch(parsed.params);
  return { params: parsed.params, risultati: data.risultati || [], sources: data.sources || {} };
};

/**
 * L'ULTIMA RETE. Va DOPO ogni rotta: e' l'ultimo `app.use` del file, e i quattro argomenti
 * sono cio' che lo rende un gestore d'errore per Express (tre non basterebbero).
 *
 * Senza, la risposta a un errore non catturato la scrive il finalizzatore di Express, e
 * `app.get('env')` qui vale 'development' — NODE_ENV non lo imposta nessuno: ne' il codice, ne'
 * il launchd del M2, ne' il .env. In quello stato il finalizzatore mette `err.stack` NEL CORPO.
 * Due cose rotte insieme:
 *   - il corpo e' `text/html`, non `{ok:false,error}`: il `r.json()` del frontend muore e il
 *     `.catch` da' la colpa alla RETE mentre il server ha risposto (pagine/invito.html:108,125);
 *   - il server e' pubblicato su internet dal Funnel (docs/DEPLOY-M2.md), e quel corpo regala
 *     percorsi assoluti e sorgenti a chiunque mandi un `{"token":` monco a /api/invito, che sta
 *     in AUTH_FREE e non chiede nessuna sessione.
 * Il repo il sintomo lo conosceva gia' (commento a parseSearchParams), ma aveva chiuso IL CASO
 * con una validazione, non la causa.
 *
 * Lo stack non si perde: va nel log, che e' il posto dove serve. Fuori esce solo il perche'.
 */
app.use((err, req, res, next) => {
  // Risposta gia' partita (uno stream di PDF che muore a meta'): lo stato non si puo' piu'
  // cambiare, e l'unica cosa sensata e' lasciare che Express chiuda la connessione.
  if (res.headersSent) return next(err);
  const s = Number(err && (err.status || err.statusCode));
  const codice = Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500;
  // Un 4xx e' un errore del CHIAMANTE (corpo monco, corpo troppo grosso) e nel log ne basta il
  // tipo: il messaggio di JSON.parse puo' portarsi dietro un pezzo del corpo ricevuto, e il
  // corpo di /api/invito contiene una password. Torna a chi l'ha scritta, non finisce su disco.
  if (codice < 500) console.warn(`[errore] ${req.method} ${req.path} → ${codice} ${(err && err.name) || 'Error'}`);
  else              console.error(`[errore] ${req.method} ${req.path} → ${codice}`, err);
  res.status(codice).set('Cache-Control', 'no-store').json({
    ok: false,
    // Il messaggio di un 500 e' un guasto NOSTRO e puo' dire piu' di quanto vada detto fuori.
    error: codice < 500 && err && err.message ? String(err.message) : 'Errore interno del server. Riprova fra poco.',
  });
});

// Si mette in ascolto SOLO se questo file e' il programma avviato, mai se qualcuno lo
// richiede come modulo. Serve ai test: la catena di risoluzione marca/modello vive qui dentro
// e finora nessun test poteva toccarla, perche' bastava il require ad aprire una porta
// e avviare lavoro di rete non richiesto.
// Produzione invariata: sia `node backend/server.js` sia il fork di Electron eseguono questo
// file come principale, quindi require.main === module e' vero in entrambi i casi.
/**
 * SENZA PASSWORD NON SI PARTE.
 *
 * Finche' l'app era di uno solo, "nessuna password" voleva dire "app locale aperta". Da
 * quando ci lavorano in piu' persone quella comodita' e' un buco: il server ascolta su tutte
 * le interfacce, il Funnel puo' essere rimasto acceso nel demone da una chiusura non pulita,
 * e in quello stato chiunque raggiunga la porta entra. Il controllo sta QUI dentro, nel ramo
 * che parte solo quando questo file e' il programma avviato: i test che lo caricano come
 * modulo non devono morire.
 *
 * La password si imposta da terminale, ed e' anche il posto dove si aggiungono le persone:
 *     node scripts/set-password.js                 (il proprietario)
 *     node scripts/set-password.js "Giulia Rossi"  (un collega, in sola lettura)
 */
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
// Esposte per i test di caratterizzazione: sono le funzioni con cui inizia OGNI risoluzione
// marca/modello, e finora non erano raggiungibili da fuori. Prefisso _ = superficie interna.
module.exports = { server, app, _lookupBrand: lookupBrand, _lookupModelGroup: lookupModelGroup, _catalogResolver: catalogResolver,
  // Superficie interna per i test: due gestori che senza questo non sarebbero raggiungibili
  // senza aprire una porta (supertest non e' fra le dipendenze).
  _gateAuth: gateAuth, _postLogin: postLogin, _loginAttempts: loginAttempts, _cacheable: cacheable,
  _percorsoGate: percorsoGate, _soloOwner: soloOwner, _SOLO_OWNER: SOLO_OWNER, _AUTH_FREE: AUTH_FREE,
  _tettoGiornaliero: tettoGiornaliero, _TETTO_GIORNALIERO: TETTO_GIORNALIERO, _amrSearchFn: amrSearchFn,
  // La dedup delle chiamate in volo (un solo subprocess tailscale per cache-miss)
  // si prova solo eseguendo la funzione con richieste concorrenti.
  _tailscalePublicUrl: tailscalePublicUrl,
  // Chi si puo' credere e come si contano i limiti sono due decisioni di sicurezza:
  // vanno provate, e senza aprire una porta.
  _clientIp: clientIp, _chiaveLimite: chiaveLimite,
  // I due wrapper delle fonti: la regola «parziale e sospetto attraversano il wrapper» si
  // prova ESEGUENDOLI (con lo stub HTTP di subito-api), non leggendo il sorgente — la
  // guardia a parole era verde mentre runSubito buttava il campo, perche' combaciava con
  // la copia gemella di runSource.
  _runSource: runSource, _runSubito: runSubito,
  _as24LivelloAllargamento: as24LivelloAllargamento };
