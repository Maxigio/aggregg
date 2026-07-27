const path = require('path');
// .env dalla ROOT della repo con path ASSOLUTO: dotenv di default cerca in
// process.cwd(), che sotto Electron può non essere la repo → DATABASE_URL perso.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// Logger centralizzato: install SUBITO dopo dotenv → tee dei console.* + file rotante +
// handler uncaught. Cattura anche il boot dei moduli sotto (che loggano al require).
const logger = require('./logger').install();
const express = require('express');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { buildWorkerBundle, OUTFILE: WORKER_BUNDLE } = require('../scripts/build-worker-bundle');   // F9
const { buildFrontendSync } = require('../scripts/build-frontend');   // F39: minify (via commenti) app.js/style.css
const auth = require('./auth');
const db = require('./db');
const crawler = require('./crawler');
const listingsRepo = require('./db/listings-repo');
const healthRepo = require('./db/health-repo');
const watchlistRepo = require('./db/watchlist-repo');
const accessLog = require('./db/access-log-repo');                      // F50 Fase 4 — log eventi/accessi
const qrcode = require('qrcode-generator');
const scrapeSubito    = require('./scrapers/subito-playwright');
const scrapeAutoscout = require('./scrapers/autoscout-playwright');
const scrapeAutoscoutGraphql = require('./scrapers/autoscout-graphql');
const scrapeSubitoApi = require('./scrapers/subito-api');
const scrapeMotoIt    = require('./scrapers/motoit');
const subitoSession   = require('./scrapers/subito-session');
const { runBootstrap } = require('./scrapers/subito-bootstrap');
const { resolveMotoitSlug } = require('./scrapers/motoit-brands');
const { resolveMotoitModelSlug, getBrandModels, getModelBikes, resolveMotoitVersionEntry } = require('./scrapers/motoit-models');
const { getDetail } = require('./scrapers/detail');
const liquidita      = require('./liquidita');    // liquidita modello (ACI Autoritratto)
const iptCalc        = require('./ipt');          // costo passaggio di proprieta per provincia
const provSigla      = require('./province-sigla'); // localita' dell'annuncio -> sigla provincia
const motornet       = require('./scrapers/motornet');  // kW ufficiali di listino (SPENTO se AMR_MOTORNET!=1)
const carburanti     = require('./carburanti');   // prezzi carburante MIMIT per provincia
const saved = require('./saved');
const budget = require('./budget-richieste');     // quante richieste costa una ricerca: contate, non stimate
const { makeResolver, makeModelResolver, loadAliasMap, resolveAs24Narrowing, as24Spellings, norm } = require('./scrapers/brand-match');
const province        = require('../data/province.json');
const regionCentroids = require('../data/region-centroids.json');  // capoluoghi regione {lat,lng} → raggio AS24 nativo
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

// `norm` arriva da scrapers/brand-match: e' LA normalizzazione dei nomi di veicolo, una sola per
// tutti. Qui ce n'era una copia che non toglieva gli accenti, e bastava che l'annuncio scrivesse
// "Regolarita" e la ricerca "Regolarità" (o viceversa) perche' la moto sparisse dai risultati
// senza nessun errore. Misurati 32 modelli moto accentati, ed e' sulle moto che il filtro-titolo
// e' attivo. Vedi il commento della funzione per il perche' non e' quella di model-key.

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

// AS24: API GraphQL ufficiale come path PRIMARIO (veloce, dati strutturati,
// niente browser). Su errore/401 (credenziale ruotata) → fallback allo scraper
// Playwright. Spegnibile con USE_AS24_GRAPHQL=0. Il post-filter titolo (§12) e i
// filtri numerici lato server restano validi anche sui risultati GraphQL.
const USE_AS24_GRAPHQL = process.env.USE_AS24_GRAPHQL !== '0';
async function scrapeAutoscoutSmart(params) {
  if (USE_AS24_GRAPHQL) {
    // Anno/km ora NATIVI (buildVariables: firstRegistration + mileageInKm) → pagina 1
    // già in-range, niente più hack sort-by-date/maxPages (prima serviva perché il
    // post-filter su una pesca cheapest-first azzerava `annoMin`).
    try { return await scrapeAutoscoutGraphql(params); }
    catch (e) { console.warn(`[AS24] GraphQL fallito (${e.message}) → fallback Playwright`); }
  }
  return scrapeAutoscout(params);
}

// F50 fase 1b — UNIONE MULTI-GRAFIA. AS24 filtra per parola intera e non ha OR: una
// sola grafia perde gli annunci scritti diversamente ("800MT-X" non aggancia
// "800 MT X" né "Mtx"). Interroghiamo le grafie in parallelo e uniamo per url.
// Costo: 1 richiesta per grafia (le query strette esauriscono la lista a pagina 1),
// e solo sul ramo dei modelli senza codice-modello. Va diretto al GraphQL: passando
// da scrapeAutoscoutSmart un GraphQL rotto aprirebbe un browser Playwright PER GRAFIA.
async function scrapeAutoscoutUnion(params) {
  const grafie = params.autoscoutSpellings;
  if (!grafie || grafie.length < 2) return scrapeAutoscoutSmart(params);
  let unaOk = false;
  const liste = await Promise.all(grafie.map(async g => {
    try { const r = await scrapeAutoscoutGraphql({ ...params, autoscoutVersionText: g }); unaOk = true; return r; }
    catch (_) { return []; }
  }));
  if (!unaOk) return scrapeAutoscoutSmart({ ...params, autoscoutVersionText: null });   // GraphQL giù → un solo tentativo classico
  const byUrl = new Map();
  for (const lista of liste) for (const r of lista) if (r && r.url && !byUrl.has(r.url)) byUrl.set(r.url, r);
  return [...byUrl.values()];
}

// Subito: API di prima parte hades.subito.it come PRIMARIO (JSON diretto, niente
// DataDome/bootstrap CAPTCHA). Su errore/blocco → fallback allo scraper Playwright
// (browser+stealth, che gestisce SubitoBlockedError → needs_bootstrap). Così il
// CAPTCHA serve solo se ANCHE l'API fallisce. Spegnibile con USE_SUBITO_API=0.
const USE_SUBITO_API = process.env.USE_SUBITO_API !== '0';
async function scrapeSubitoSmart(params) {
  if (USE_SUBITO_API) {
    // on-search: economici in cima (sort nativo). Regione/prezzo/anno nativi via buildPath.
    try { return await scrapeSubitoApi(params, { sort: 'priceasc' }); }
    catch (e) { console.warn(`[Subito] API hades fallita (${e.message}) → fallback Playwright`); }
  }
  return scrapeSubito(params);
}

// ─── Auth (attiva SOLO se è stata impostata una password) ────────────────────
// Quando attiva, protegge TUTTE le rotte: niente scorciatoia loopback (Funnel
// proxa a 127.0.0.1 → indistinguibile dal desktop). L'Electron locale fa login
// una volta e tiene il cookie. Disattiva = comportamento locale di prima.
const loginAttempts = new Map();   // ip → { fails, until }
const LOCK_MAX = 8;
const LOCK_MS  = 10 * 60 * 1000;
const AUTH_FREE = new Set(['/login', '/logout', '/api/public-url', '/api/health', '/api/whatsapp/webhook']);

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }   // cookie malformato → non crashare (500 a ogni richiesta)
  }
  return out;
}

app.use((req, res, next) => {
  if (!auth.isEnabled()) return next();          // nessuna password → app locale aperta
  if (AUTH_FREE.has(req.path)) return next();     // /login, /logout sempre raggiungibili
  const role = auth.checkToken(parseCookies(req).amr_auth);   // 'full' | 'demo' | null
  if (!role) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'non autorizzato' });
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
      return res.redirect(302, '/login');
    }
    return res.status(401).send('non autorizzato');
  }
  req.authRole = role;
  // Gate DEMO (ospite read-only): solo GET; niente scritture, niente modo Valuta.
  // /login·/logout sono già esenti via AUTH_FREE. (Il pannello admin non esiste più →
  // l'owner-tool DB-puro lo sostituisce; nessuna route /admin da gateare qui.)
  if (role === 'demo') {
    const isReport = req.path === '/api/report';   // l'utente demo DEVE poter segnalare (match esatto)
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
    // review: il gate method-based NON basta. Alcune GET MUTANO (GET /api/crawl/lease scrive
    // leased_by/until) o espongono dati PRIVATI dell'owner (GET /api/saved = ricerche/avvisi di
    // papà). Blocca il demo da questi prefissi a prescindere dal metodo. (/api/saved/check è POST,
    // già coperto da isWrite; qui copriamo la GET di lista e le route di coordinamento crawl.)
    const isPrivate = req.path === '/api/saved' || req.path.startsWith('/api/saved/')
      || req.path.startsWith('/api/crawl/');
    if ((isWrite || isPrivate) && !isReport) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'modalità demo: sola lettura' });
      if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect(302, '/');
      return res.status(403).send('modalità demo: sola lettura');
    }
  }
  return next();
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../frontend/login.html')));

app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  // IP reale dietro Funnel (RIGHTMOST X-Forwarded-For, vedi clientIp). Senza,
  // dietro Funnel ogni utente è 127.0.0.1 → lockout globale.
  const ip = clientIp(req);
  const rec = loginAttempts.get(ip);
  if (rec && rec.until > Date.now()) return res.redirect(302, '/login?err=locked');   // lockout

  const role = auth.verifyRole(req.body && req.body.password);   // 'full' | 'demo' | null
  if (!role) {
    await new Promise(r => setTimeout(r, 1000));   // delay anti-brute
    const fails = (rec ? rec.fails : 0) + 1;
    loginAttempts.set(ip, { fails, until: fails >= LOCK_MAX ? Date.now() + LOCK_MS : 0 });
    accessLog.record('login_fail', { ip, ua: req.headers['user-agent'] });   // best-effort
    return res.redirect(302, '/login?err=1');
  }

  loginAttempts.delete(ip);
  accessLog.record('login_ok', { role, ip, ua: req.headers['user-agent'] });   // best-effort
  const token  = auth.makeToken(role);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `amr_auth=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(auth.TTL_MS / 1000)}${secure}`);
  res.redirect(302, '/');
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'amr_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.redirect(302, '/login');
});

// Ruolo della sessione corrente (per la UI: nasconde salvataggi/admin in demo).
// Auth disattivata (app locale) → 'full'. Sotto /api/ → già protetta dal middleware.
app.get('/api/me', (req, res) => {
  if (!auth.isEnabled()) return res.json({ role: 'full', authDisabled: true });
  res.json({ role: req.authRole || auth.checkToken(parseCookies(req).amr_auth) || null });
});

// Liveness per il probe di avvio Electron (waitForBackend). Auth-exempt: il
// probe gira prima del login. Nessun dato sensibile.
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Log applicativi — SOLO owner (full): le ultime righe del ring-buffer (segreti redatti dal logger).
// ?n=200 righe, ?level=error filtra. Utile per diagnosticare errori-fonte (es. "Web error") senza SSH.
app.get('/api/logs', (req, res) => {
  if (auth.isEnabled() && req.authRole !== 'full') return res.status(403).json({ error: 'solo owner' });
  const n = Math.min(parseInt(req.query.n, 10) || 200, 500);
  let lines = logger.tail(n);
  if (req.query.level) { const L = String(req.query.level).toUpperCase(); lines = lines.filter(l => l.includes(' ' + L + ' ')); }
  res.type('text/plain').send(lines.join('\n'));
});

// IP reale del client: dietro il Funnel Tailscale, l'ULTIMO hop di X-Forwarded-For
// (il leftmost è spoofabile). Senza proxy (Electron locale) → remoteAddress.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) { const p = String(xff).split(',').map(s => s.trim()).filter(Boolean); if (p.length) return p[p.length - 1]; }
  return req.socket.remoteAddress || 'unknown';
}

// ─── Segnalazioni (bug-report) — anche l'utente demo ────────────────────────
// File in append: <USER_DATA_PATH>/reports.jsonl (Electron) o data/ (dev), come saved.js.
// Sicurezza: dietro login (NON in AUTH_FREE), esente dal demo-gate (match esatto),
// rate-limit dedicato (mappa separata, non lockare il login), cap 2000 char, no-echo.
function reportsFile() {
  const ud = process.env.USER_DATA_PATH;
  return (ud && fs.existsSync(ud)) ? path.join(ud, 'reports.jsonl') : path.join(__dirname, '..', 'data', 'reports.jsonl');
}
const reportHits = new Map();   // ip → { windowStart, count } — SEPARATO da loginAttempts
function reportRateOk(ip) {
  const now = Date.now(), w = 10 * 60 * 1000, cap = 5;
  const rec = reportHits.get(ip);
  if (!rec || now - rec.windowStart >= w) { reportHits.set(ip, { windowStart: now, count: 1 }); return true; }
  rec.count++; return rec.count <= cap;
}
app.post('/api/report', express.json({ limit: '32kb' }), (req, res) => {
  if (!reportRateOk(clientIp(req))) return res.status(429).json({ error: 'Troppe segnalazioni, riprova tra qualche minuto.' });
  const b = req.body || {};
  const type = b.type === 'search' ? 'search' : 'bug';
  const message = String(b.message == null ? '' : b.message).slice(0, 2000).trim();
  if (!message) return res.status(400).json({ error: 'messaggio obbligatorio' });
  const rec = {
    ts: new Date().toISOString(),
    type,
    message,
    searchParams: (b.searchParams && typeof b.searchParams === 'object') ? b.searchParams : null,
    count: Number.isFinite(b.count) ? b.count : null,
    role: req.authRole || 'full',
  };
  try {
    fs.appendFileSync(reportsFile(), JSON.stringify(rec) + '\n');
    res.json({ ok: true });   // NO echo del contenuto
  } catch (e) {
    console.error('[report]', e.message);
    res.status(500).json({ error: 'Impossibile salvare la segnalazione' });
  }
});

// F39 — serve app.js/style.css MINIFICATI (commenti via) prima dello static.
// Fallback trasparente al sorgente se la build esbuild fallisce (next()).
let minFE = { js: null, css: null, ver: '' };
try { minFE = buildFrontendSync(); console.log(`[frontend] minify OK v${minFE.ver}`); }
catch (e) { console.warn('[frontend] minify fallita → servo i sorgenti:', e.message); }
const serveMin = (kind, type) => (req, res, next) => {
  if (!minFE[kind]) return next();                         // build fallita → sorgente via static
  res.type(type).set('Cache-Control', 'no-cache').set('ETag', `"${minFE.ver}"`);
  if (req.headers['if-none-match'] === `"${minFE.ver}"`) return res.status(304).end();
  res.send(minFE[kind]);
};
app.get('/app.js',    serveMin('js',  'application/javascript'));
app.get('/style.css', serveMin('css', 'text/css'));

// index.html con asset VERSIONATI (?v=<ver>): al cambio codice l'URL cambia → il browser scarica
// il bundle nuovo da solo su un reload normale (niente hard refresh). ver = hash del build minify.
app.get(['/', '/index.html'], (req, res, next) => {
  try {
    const v = minFE.ver || String(Date.now());
    const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8')
      .replace(/(src|href)="(app\.js|style\.css|pricing\.js)"/g, `$1="$2?v=${v}"`);
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  } catch (_) { next(); }
});

app.use(express.static(path.join(__dirname, '../frontend'), {
  setHeaders(res, filePath) {
    // HTML sempre rivalidato → niente index.html stale in cache dopo un deploy/edit
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// §F1.5 — salute crawler / rilevamento ban. DIETRO auth (l'app è esposta via
// Funnel pubblico → non auth-free). Sommario {ok, blocked[], degraded[], fonti[]}.
app.get('/api/crawler/health', async (req, res) => {
  try {
    res.json(await healthRepo.getHealth());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// §F3 — fill distribuito: coordinatore lease/ingest (DIETRO auth).
// Il worker (Surface) prende 1 target mai crawlato, lo crawla dal SUO IP, e
// rimanda i risultati qui. Niente esposizione DB: tutto via HTTP autenticato.
app.get('/api/crawl/lease', async (req, res) => {
  try {
    const device = String(req.query.device || '').trim() || 'worker';
    // F5 — mode-aware. Default 'fill' (preserva il worker Surface già deployato,
    // che non passa mode). I worker nuovi passano &mode=due per il refresh giornaliero.
    const mode = req.query.mode === 'due' ? 'due' : 'fill';
    const t = await watchlistRepo.leaseDueTarget(device, mode);
    if (!t) return res.json({ none: true });
    // Risolvi qui mmmv AS24 + slug Moto.it (catalogo sull'iMac) → il worker non serve il catalogo.
    const as = crawler._resolveAutoscout(t);
    const out = { id: t.id, tipo: t.tipo, marca: t.marca, modello: t.modello, mmmv: (as && as.mmmv) || null };
    if (t.tipo === 'moto') {
      const mt = await crawler._resolveMotoit(t);
      out.motoitBrandSlug = (mt && mt.brandSlug) || null;
      out.motoitModelSlug = (mt && mt.modelSlug) || null;
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/crawl/ingest', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { id, device, sources, mode } = req.body || {};
    const tRow = await db.query('SELECT tipo, marca, modello FROM watchlist WHERE id=$1', [id]);
    if (!tRow || !tRow.rows.length) return res.status(400).json({ error: 'target id sconosciuto' });
    const target = tRow.rows[0];
    const node = String(device || 'worker').trim();
    // markGone SOLO sul refresh giornaliero (mode='due'). Il 'fill' (1° backfill,
    // anche di target già popolati dall'iMac) vede da un IP/result-set diverso →
    // l'assenza di un URL NON è venduto. Default (mode assente) = non-due → no markGone.
    const doMarkGone = mode === 'due';
    let written = 0;
    for (const s of (Array.isArray(sources) ? sources : [])) {
      if (!s || !s.fonte) continue;
      if (s.error) { await healthRepo.record(s.fonte, { error: s.error, node }); continue; }
      const raw = Array.isArray(s.items) ? s.items : [];
      // Salute = stato del FETCH → conteggio PRE-filtro (Fix D).
      await healthRepo.record(s.fonte, { count: raw.length, node });
      // Guard anti-rumore Subito (free-text) PRIMA dell'upsert (come crawler iMac).
      const items = s.fonte === 'subito' ? raw.filter(i => crawler._titleMatchesModel(i.titolo, target.modello)) : raw;
      const r = await listingsRepo.upsertListings(items, target);
      written += r.written;
      // F5 — sold-detection dai nodi remoti SOLO su 'due' (refresh giornaliero),
      // fonte-scoped (un worker WORKER_SOURCES=moto NON tocca autoscout/subito) e
      // solo se vista COMPLETA (!truncated). Partizione (1 target=1 nodo) + K=2.
      if (doMarkGone && !s.truncated) await listingsRepo.markGone(target, items.map(i => i.url), { fonte: s.fonte });
    }
    await watchlistRepo.completeTarget(id);
    res.json({ written });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── F9 — il centrale serve il worker come 1 file bundle (i nodi lo scaricano, niente git/npm) ──
let workerBundleVersion = null;
async function ensureWorkerBundle() {
  // Ricostruisce a ogni boot → il bundle servito combacia col codice iMac corrente.
  try {
    await buildWorkerBundle();
  } catch (e) {
    console.warn('[worker-bundle] build fallita (esbuild installato? `npm install`):', e.message);
  }
  try {
    const buf = fs.readFileSync(WORKER_BUNDLE);
    workerBundleVersion = crypto.createHash('sha256').update(buf).digest('hex');
    console.log(`[worker-bundle] pronto v${workerBundleVersion.slice(0, 12)} (${buf.length} byte)`);
  } catch (_) {
    console.warn('[worker-bundle] nessun bundle disponibile → /api/worker/bundle.js darà 503');
  }
}

app.get('/api/worker/bundle/version', (req, res) => res.json({ version: workerBundleVersion }));
app.get('/api/worker/bundle.js', (req, res) => {
  if (!workerBundleVersion) return res.status(503).json({ error: 'bundle non pronto' });
  res.type('application/javascript').sendFile(WORKER_BUNDLE);
});

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
// Normalizzazione per match esatto-normalizzato fra cataloghi (NON testo utente).
const normName = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

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
    kindAS:         m.kindAS         || '',
    slugMotoIt:     m.slugMotoIt     || '',
  }));

  // MOTO — F43 Fase 0' (lazy): fonde i modelli AUTOREVOLI dell'API Moto.it
  // (`models/<brand>/Used`, cache 12h) col catalogo: riempie lo slug mancante per
  // match esatto-normalizzato (catalogo↔API, NON testo utente) e aggiunge i modelli
  // assenti dal catalogo. Così la force-select copre tutto Moto.it con slug reali.
  if (tipo === 'moto') {
    const brandSlug = (entry && entry.motoit && entry.motoit.brandSlug) || resolveMotoitSlug(marca.trim()) || null;
    if (brandSlug) {
      try {
        const apiModels = await getBrandModels(brandSlug);   // [{name, slug}]
        const byName = new Map(modelli.map(m => [normName(m.nome), m]));
        for (const am of apiModels) {
          const hit = byName.get(normName(am.name));
          if (hit) { if (!hit.slugMotoIt) hit.slugMotoIt = am.slug; }
          else {
            const nm = { nome: am.name, sites: ['motoit'], mmmvAutoscout: '', kindAS: '', slugMotoIt: am.slug };
            modelli.push(nm); byName.set(normName(am.name), nm);
          }
        }
        modelli.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
      } catch (e) { console.warn('[api/models] merge Moto.it KO:', e.message); }
    }
  }

  res.json({ modelli, sites: (entry && entry.sites) || (tipo === 'moto' ? ['motoit'] : []) });
});

// F43 — Versioni (allestimenti) Moto.it di un modello: per la 2ª force-select (solo moto).
// `bikes/<brand>|<model>/Used` → [{ nome, code }]; `code` va in `motoitBikeCode` (param `bike=`).
// Due modi (Lazy-T2):
//  - `modelSlug` = famiglia Moto.it scelta direttamente → bikes della famiglia.
//  - `modelNome` = voce-catalogo (es. "Dyna Fat Bob") senza slug → risolve famiglia+versioni.
// Ritorna `{ familySlug, versioni:[{nome,code,annoMin,annoMax}] }`.
// ─── Liquidita per MARCA: alimenta il segno accanto a ogni annuncio ───────────
// Si serve solo la marca cercata (poche decine di modelli, non i 1.997 totali), cosi'
// il client puo' attribuire il dato riga per riga senza scaricare tutto l'archivio.
// Serve nelle ricerche per sola marca, dove ogni riga e' un modello diverso.
app.get('/api/liquidita', (req, res) => {
  const marca = String((req.query || {}).marca || '').trim();
  const modello = String((req.query || {}).modello || '').trim();
  const tipo = String((req.query || {}).tipo || 'auto');
  if (!marca) return res.json({ ok: false });
  const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const pref = norm(marca) + '|';
  const modelli = [];
  for (const [k, m] of Object.entries(liquidita.dati.modelli)) {
    if (!k.startsWith(pref)) continue;
    const r = liquidita.ricambioUtile(m);   // niente percentuale dove il rapporto non e' misurabile
    modelli.push({ modello: m.modello, parco: m.parco, trasferimenti: m.trasferimenti, ricambio: r, giudizio: liquidita.giudizio(r) });
  }
  res.set('Cache-Control', 'public, max-age=86400');
  // voce del modello cercato: la sola che sa dire "questo e' il dato del modello base, non
  // della variante" e che porta fonte e nota. Il frontend non deve reinventarle.
  const voce = modello ? liquidita.cerca(marca, modello, tipo) : null;
  res.json({ ok: true, marca, anno: liquidita.dati.anno, fonte: liquidita.dati.fonte, modelli, voce });
});

// ─── Passaggio di proprieta' del SINGOLO annuncio ────────────────────────────
// Potenza e localita' sono gia' nell'annuncio: un operatore che guarda una macchina vuole
// sapere li' quanto gli costa metterla a nome suo, non in un pannello a parte. La localita'
// arriva in tre formati diversi secondo la fonte (sigla, provincia, comune) e va tradotta in
// sigla, altrimenti l'IPT non e' calcolabile. Se la traduzione fallisce si dice perche':
// meglio "non lo so" che un importo su una provincia indovinata.
app.get('/api/passaggio', async (req, res) => {
  const { provincia, cap, cv, kw, tipo, ivaEsposta, storico, marca, modello } = req.query || {};
  const st = storico === '1';
  const loc = provSigla.risolvi(provincia, cap);
  if (!loc) return res.json({ ok: false, motivo: 'localita\' non riconosciuta: "' + String(provincia || '').slice(0, 40) + '"' });

  // Potenze fuori scala: un annuncio con "9999 CV" e' un errore di battitura del venditore,
  // non un veicolo. Meglio rifiutare che firmare un importo assurdo. Bande larghe di proposito
  // (esistono auto da 1.000+ CV): servono solo a fermare l'assurdo.
  const num = x => { const n = Number(x); return Number.isFinite(n) ? n : NaN; };
  const cvN = num(cv), kwN = num(kw);
  if (!Number.isNaN(kwN) && kwN !== 0 && !(kwN >= 1 && kwN <= 1500)) return res.json({ ok: false, provincia: loc.sigla, motivo: 'potenza fuori scala: ' + kwN + ' kW' });
  if (!Number.isNaN(cvN) && cvN !== 0 && !(cvN >= 1 && cvN <= 2000)) return res.json({ ok: false, provincia: loc.sigla, motivo: 'potenza fuori scala: ' + cvN + ' CV' });

  // kW dichiarati se ci sono, altrimenti stimati dai CV: la stima va detta, non nascosta.
  // Si arrotonda a un decimale PRIMA del calcolo: l'IPT si paga sui kW del libretto, che sono
  // un valore dichiarato — portarsi dietro 55,16240625 kW sarebbe finta precisione.
  // I kW DICHIARATI battono la stima: sopra e sotto i 53 kW la tariffa cambia categoria, e la
  // stima dai CV puo' far scavalcare la soglia a un'utilitaria (73 CV → 53,7 kW stimati, ma il
  // libretto puo' dire 53 → 49 € di differenza). Il listino li ha; se non li ha, si stima e si dice.
  let kwListino = null;
  if (motornet.ATTIVO && marca && modello && cvN >= 1) {
    try { kwListino = await motornet.kwDaCavalli(marca, modello, cvN); }
    catch (e) { console.warn('[api/passaggio] motornet KO:', e.message); }
  }
  const kwDiretti = kwN >= 1 ? kwN : (kwListino ? kwListino.kw : null);
  const kwStimati = kwDiretti == null && cvN >= 1 ? Math.round(provSigla.kwDaCv(cvN) * 10) / 10 : null;
  const kW = kwDiretti != null ? kwDiretti : kwStimati;
  if (!(kW > 0) && !st) return res.json({ ok: false, provincia: loc.sigla, motivo: 'potenza non disponibile in questo annuncio' });

  const r = iptCalc.calcola({
    provincia: loc.sigla, kW: kW || 0, tipo: tipo === 'moto' ? 'moto' : 'auto',
    ivaEsposta: ivaEsposta === '1', storico: st,
  });
  r.localita = { testo: String(provincia || '').slice(0, 60), sigla: loc.sigla, via: loc.via };
  if (kwStimati != null) r.potenzaStimata = { cv: cvN, kw: kwStimati };
  // `!(kwN >= 1)`, non `kwN < 1`: senza il parametro kw questo e' NaN, e NaN < 1 e' FALSO —
  // la provenienza non sarebbe mai uscita proprio nel caso per cui esiste. Stessa forma della
  // riga 564, che con NaN sceglie appunto i kW di listino.
  if (kwListino && !(kwN >= 1)) r.potenzaListino = { cv: cvN, kw: kwListino.kw, versioni: kwListino.versioni.slice(0, 3), fonte: kwListino.fonte, url: kwListino.url };
  // Cache solo sui successi: un "non calcolabile" dipende dai dati dell'annuncio, che possono
  // arrivare dopo (Moto.it arricchisce la potenza in un secondo momento).
  if (r.ok) res.set('Cache-Control', 'public, max-age=3600');
  res.json(r);
});

// ─── Prezzi carburante ufficiali per provincia (open data MIMIT, IODL 2.0) ────
// Incrociati col consumo della scheda tecnica danno il costo reale al km dove vive
// l'utente. L'indice è piccolo (107 province × 4 carburanti) → si serve tutto e il
// client calcola: cambiare km/anno o provincia non richiede altre richieste.
// La UI DEVE citare la fonte: è l'obbligo di attribuzione della licenza IODL 2.0.
app.get('/api/carburanti', async (req, res) => {
  try {
    const idx = await carburanti.indice();
    if (!idx) return res.json({ ok: false, motivo: 'prezzi non disponibili' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ ok: true, aggiornato: idx.aggiornato, fonte: idx.fonte, italia: idx.italia, province: idx.province });
  } catch (e) {
    console.warn('[api/carburanti] KO:', e.message);
    res.json({ ok: false, motivo: 'prezzi non disponibili' });
  }
});

app.get('/api/moto-versions', async (req, res) => {
  const marca = (req.query.marca || '').trim();
  const modelSlug = (req.query.modelSlug || '').trim();
  const modelNome = (req.query.modelNome || '').trim();
  if (!marca || (!modelSlug && !modelNome)) return res.json({ versioni: [], familySlug: null });
  const entry = modelsData.moto && modelsData.moto[marca];
  const brandSlug = (entry && entry.motoit && entry.motoit.brandSlug) || resolveMotoitSlug(marca) || null;
  if (!brandSlug) return res.json({ versioni: [], familySlug: null });
  try {
    if (modelSlug) {
      const bikes = await getModelBikes(brandSlug, modelSlug);   // [{name, code, annoMin, annoMax}]
      return res.json({ familySlug: modelSlug, versioni: bikes.map(b => ({ nome: b.name, code: b.code, annoMin: b.annoMin, annoMax: b.annoMax })) });
    }
    const r = await resolveMotoitVersionEntry(brandSlug, modelNome);
    return res.json(r ? { familySlug: r.familySlug, versioni: r.versions } : { versioni: [], familySlug: null });
  } catch (e) {
    console.warn('[api/moto-versions] KO:', e.message);
    res.json({ versioni: [], familySlug: null });
  }
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

// ─── Indirizzi di accesso da telefono (helper "Apri da telefono") ─────────────
// Elenca gli URL http://<ip>:PORT raggiungibili: IPv4 non-internal delle interfacce
// locali. Include LAN (192.168/10.x) e Tailscale (100.64.0.0/10) se attivo.
// Nessun input esterno → nessun rischio. Le "100.x" Tailscale in cima (più utili).
// URL pubblico Funnel (best-effort): prova binari noti, gestisce ENOENT.
// Cache TTL: l'endpoint è auth-exempt → evita di lanciare un subprocess
// `tailscale` ad ogni richiesta (anti-spam/DoS leggero).
let funnelCache = { ts: 0, url: null };
const FUNNEL_TTL = 60 * 1000;
function tailscalePublicUrl(cb) {
  if (Date.now() - funnelCache.ts < FUNNEL_TTL) return cb(funnelCache.url);
  const bins = ['/usr/local/bin/tailscale', 'tailscale'];
  let i = 0;
  const done = url => { funnelCache = { ts: Date.now(), url }; cb(url); };
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
// Il <select> del web manda già lo slug ('lombardia'); il bot manda forma naturale
// ('Lombardia', 'Emilia Romagna') → qui entrambe risolvono allo stesso slug (idempotente).
const normReg = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const REGIONE_BY_NORM = new Map([...REGIONI_VALIDE].map(slug => [normReg(slug), slug]));
const canonRegione = s => REGIONE_BY_NORM.get(normReg(s)) || null;

// Validazione e sanitizzazione parametri ricerca
function parseSearchParams(query) {
  const {
    tipo, marca, modello, prezzoMin, prezzoMax, annoMin, annoMax, kmMin, kmMax, regione, raggio,
    mmmvAutoscout, motoitBrandSlug, motoitModelSlug, motoitBikeCode, motoitNeedsVersion,
  } = query;

  const errors = [];
  if (!tipo || !['auto', 'moto'].includes(tipo)) errors.push('tipo deve essere "auto" o "moto"');
  if (!marca || typeof marca !== 'string' || marca.trim().length === 0) errors.push('marca obbligatoria');
  if (regione && !canonRegione(regione)) errors.push(`regione non valida: ${regione}`);
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
      mmmvAutoscout:    mmmvAutoscout    || null,
      motoitBrandSlug:  motoitBrandSlug  || null,
      motoitModelSlug:  motoitModelSlug  || null,
      motoitBikeCode:   motoitBikeCode   || null,   // versione/allestimento Moto.it (param `bike=`)
      motoitNeedsVersion: motoitNeedsVersion === '1',   // F47.2: versione obbligatoria SOLO Moto.it → skip se non scelta
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
    const items = await Promise.race([scrapeSubitoSmart(params), timeout]);
    return { items, status: items.length ? 'ok' : 'empty', reason: null };
  } catch (err) {
    if (err instanceof SubitoBlockedError) {
      // Senza fallback browser (es. M2) il bootstrap non è proponibile → degrada a
      // "vuoto" silenzioso (AS24/Moto.it portano la ricerca), niente banner-errore.
      if (process.env.HIDE_SUBITO_BOOTSTRAP) return { items: [], status: 'empty', reason: null };
      return { items: [], status: 'needs_bootstrap', reason: err.reason };
    }
    console.warn('[WARN] ' + err.message);
    return { items: [], status: 'error', reason: err.message };
  }
}

// Rate-limit generoso per-IP (seatbelt anti-abuso; un umano non lo tocca, uno script sì).
// Per-IP è sensato: dietro il Funnel usiamo l'IP reale (clientIp). Mappa separata.
const searchHits = new Map();
function searchRateOk(ip) {
  const now = Date.now(), w = 60 * 1000, cap = 60;
  const rec = searchHits.get(ip);
  if (!rec || now - rec.windowStart >= w) { searchHits.set(ip, { windowStart: now, count: 1 }); return true; }
  rec.count++; return rec.count <= cap;
}
app.get('/api/search', async (req, res) => {
  if (!searchRateOk(clientIp(req))) return res.status(429).json({ error: 'Troppe ricerche, attendi un momento.' });
  const parsed = parseSearchParams(req.query);
  if (parsed.errors) {
    return res.status(400).json({ error: parsed.errors.join(', ') });
  }
  try {
    const out = await runSearch(parsed.params);
    accessLog.record('search', {                                   // best-effort, fire-and-forget
      role: req.authRole || (auth.isEnabled() ? null : 'full'),
      ip: clientIp(req),
      ua: req.headers['user-agent'],
      query: parsed.params,
      resultCount: Array.isArray(out && out.risultati) ? out.risultati.length : null,
    });
    res.json(out);
  } catch (e) {
    console.error('[runSearch]', e.message);
    res.status(500).json({ error: 'Errore interno durante la ricerca' });
  }
});

// ─── Ricambi: codice OEM → articoli (auto-doc via stealth) — vedi ricambi-route.js ──
require('./ricambi-route').mount(app, { clientIp });

// ─── Scheda tecnica veicolo (auto-data.net) — vedi scheda-veicolo-route.js ──────────
require('./scheda-veicolo-route').mount(app, { clientIp });

// ─── Catalogo del nuovo (Motornet) — vedi catalogo-route.js ────────────────────
// Sezione indipendente dalla ricerca usato: marche → modelli → allestimenti → scheda.
// Spenta se AMR_MOTORNET != 1, e in quel caso lo dichiara invece di sembrare rotta.
require('./catalogo-route').mount(app, { clientIp });

// ─── Richiami di sicurezza (Safety Gate UE) — vedi richiami-route.js ───────────
require('./richiami-route').mount(app, { clientIp });

// ─── Corrispondenze fra i cataloghi delle tre fonti — vedi ponte-route.js ──────
// Area a se': non sostituisce ne' la ricerca ne' la scheda tecnica. I due file del ponte
// (una decina di MB) si leggono alla PRIMA richiesta, non qui: chi non apre l'area non li paga.
require('./ponte-route').mount(app, { clientIp });

// ─── Fonti dati aperte (OSM, EPREL, bilstein, Wheel-Size) — vedi fonti-route.js ──
require('./fonti-route').mount(app, { clientIp });

// ─── Cache ricerche recenti (§17.4) ───────────────────────────────────────────
// Stessa ricerca entro il TTL → risposta istantanea. NON cacha se una fonte è
// error/needs_bootstrap (non congelare uno stato-bloccato) né i 0-risultati totali.
const SEARCH_CACHE_TTL = 3 * 60 * 1000;
const SEARCH_CACHE_MAX = 50;
const searchCache = new Map();   // key → { ts, data }
function searchCacheKey(p) {
  // review: includere i param-VARIANTE (mmmv AS24, slug/versione Moto.it). Senza, due ricerche
  // che differiscono SOLO per versione Moto.it o mmmv restituivano la cache l'una dell'altra
  // (es. 'Honda CBR' senza versione poi con versione scelta → payload sbagliato per 3 min).
  return ['tipo', 'marca', 'modello', 'prezzoMin', 'prezzoMax', 'annoMin', 'annoMax', 'kmMin', 'kmMax',
          'regione', 'raggio', 'mmmvAutoscout', 'motoitBrandSlug', 'motoitModelSlug', 'motoitBikeCode', 'motoitNeedsVersion']
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
  // Il conto delle richieste si apre QUI, non attorno a runSearch: una risposta servita
  // dalla cache non costa richieste, e contarla come "0" annacquerebbe la misura.
  const etichetta = [params.tipo, params.marca, params.modello].filter(Boolean).join(' ');
  const data = await budget.perRicerca(etichetta || 'ricerca', () => runSearchCore(params));
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
    // Slug-modello ON-DEMAND dalla pagina-brand Moto.it (catalogo incompleto: lo
    // slug manca per molti modelli → senza, la ricerca browser sarebbe brand-only
    // = undersampling, es. 2 Hornet su 39 honda economici). È una SINGOLA richiesta
    // HTTP cacheable 12h (NON il burst parallelo soft-bloccato) → veloce e affidabile
    // in uso normale. Risolto lo slug, il browser cerca server-side `model=`.
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
      console.log(`[server] AS24 fase1 "${params.marca} ${params.modello}": mmmv=${nar.mmmv}${nar.padre ? ` (padre "${nar.padre}")` : ' (brand-only)'} + grafie ${JSON.stringify(params.autoscoutSpellings)}`);
    }
  }
  // Regione AS24 NATIVA (verificato live): centroide capoluogo + raggio (default 100km,
  // come il sito ufficiale: position{lat,lng}+radius). Sostituisce il vecchio post-filtro
  // comune→regione su una pesca di 100 nazionali (che azzerava i risultati in-regione).
  if (params.regione && asMakeId) {
    const ctr = regionCentroids[String(params.regione).trim().toLowerCase()];
    if (ctr) params.autoscoutGeo = { lat: ctr.lat, lng: ctr.lng, radius: params.raggio || 100 };
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
  const skipMotoIt    = params.tipo !== 'moto' || !brandOnMotoIt || params.motoitNeedsVersion;
  // Motivi di skip (per lo stato per-fonte in UI)
  const asSkipReason   = 'marca non su Autoscout';
  const motoSkipReason = params.tipo !== 'moto' ? 'solo moto'
                       : params.motoitNeedsVersion ? 'scegli versione'   // F47.2: versioni presenti, nessuna scelta
                       : 'marca non su Moto.it';

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
  const [subitoRes, asRes0, motoRes] = await Promise.all([
    runSubito(params, TIMEOUT_MS),
    skipAutoscout
      ? Promise.resolve({ items: [], status: 'skipped', reason: asSkipReason })
      : runSource(scrapeAutoscoutUnion(params), TIMEOUT_MS, 'Autoscout24'),
    skipMotoIt
      ? Promise.resolve({ items: [], status: 'skipped', reason: motoSkipReason })
      : runSource(scrapeMotoIt(params), TIMEOUT_MS, 'Moto.it'),
  ]);

  // F50 fase 1 — riallargamento SOLO a zero risultati (scelta di prodotto: mai allargare
  // a priori). Se il filtro nativo non trova nulla, si riprova tenendo il modello-padre:
  // meglio "ti mostro anche il modello imparentato, segnalato" che una schermata vuota.
  let asRes = asRes0, as24Allargato = false;
  if (params.autoscoutVersionText && asRes.status === 'empty') {
    const retry = await runSource(
      scrapeAutoscoutSmart({ ...params, autoscoutVersionText: null, autoscoutSpellings: null }), TIMEOUT_MS, 'Autoscout24');
    if (retry.items.length) { asRes = retry; as24Allargato = true; }
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
    const autoscoutModelFiltered = r.fonte === 'autoscout' && (Boolean(params.mmmvAutoscout) || Boolean(params.autoscoutVersionText)) && !params.asFilterToken;
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

    // 4. Regione: ora NATIVA su tutte e 3 le fonti (Subito `r=`, Moto.it `region=`,
    //    AS24 `position`+`radius` dal capoluogo, vedi sopra `params.autoscoutGeo`).
    //    Rimosso il vecchio post-filtro AS24 comune→regione: girava su una pesca di
    //    100 annunci NAZIONALI → azzerava i risultati in-regione (bug). Verificato live.

    return true;
  });

  // Conteggio per fonte DOPO il post-filter (riflette ciò che l'utente vede)
  const countBy = f => risultati.filter(r => r.fonte === f).length;
  const asCount = countBy('autoscout');

  // §12: AS24 brand-only narrowato per titolo (serie/modello irrisolto) e finito a 0
  // → reason esplicita, così la UI distingue "0 per filtro titolo" da errore/vuoto-vero.
  const asReason = as24Allargato
    ? `nessun "${params.modello}" su Autoscout: mostro ${params.as24Padre ? `"${params.as24Padre}"` : 'la marca'}`
    : (autoTokenRe && asCount === 0 && asRes.status === 'ok')
      ? 'modello filtrato per titolo'
      : (asRes.reason || null);

  // §DB — scrittura opportunistica on-search (fire-and-forget, NON blocca la
  // risposta). Solo con marca+modello entrambi presenti (no brand-only/serie →
  // model_key ambiguo). Dati gratis dei modelli cercati a mano.
  if (params.marca && params.modello && db.isEnabled()) {
    listingsRepo.upsertListings(risultati, { tipo: params.tipo, marca: params.marca, modello: params.modello })
      .catch(e => console.warn('[db] on-search write KO:', e.message));
  }

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
  // Deploy senza fallback browser (es. M2): il bootstrap è impossibile e inutile →
  // stato "ok" così il frontend non mostra il banner-errore a vuoto ogni 60s.
  if (process.env.HIDE_SUBITO_BOOTSTRAP) {
    return res.json({ health: 'ok', blocked: false, hasSession: true, hasDataDome: true,
      expiresIn: null, bootstrapping: false, lastRefresh: null, lastRefreshOk: true });
  }
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

// Closure di ricerca AMR condivisa (bot WhatsApp + assistente web "AI mode"): il modello LLM può
// omettere tipo (default auto) o passare una regione libera non valida → normalizza prima di
// parseSearchParams (che li rigetterebbe). In-process, niente HTTP hop.
const amrSearchFn = async (input) => {
  const q = { ...input, tipo: input.tipo || 'auto' };
  let parsed = parseSearchParams(q);
  if (parsed.errors && q.regione) { delete q.regione; parsed = parseSearchParams(q); }   // regione invalida → droppa e riprova
  if (parsed.errors) return { error: parsed.errors.join(', ') };
  const data = await runSearch(parsed.params);
  return { params: parsed.params, risultati: data.risultati || [], sources: data.sources || {} };
};

// ─── Webhook WhatsApp (Meta Cloud API) — in AUTH_FREE (firma HMAC), searchFn condivisa ─────────
require('./whatsapp/webhook').mount(app, { searchFn: amrSearchFn });

// Si mette in ascolto SOLO se questo file e' il programma avviato, mai se qualcuno lo
// richiede come modulo. Serve ai test: la catena di risoluzione marca/modello vive qui dentro
// e finora nessun test poteva toccarla, perche' bastava il require ad aprire una porta,
// inizializzare il DB, compilare il bundle worker e scaldare due browser headless.
// Produzione invariata: sia `node backend/server.js` sia il fork di Electron eseguono questo
// file come principale, quindi require.main === module e' vero in entrambi i casi.
const avviaAscolto = require.main === module;
const server = !avviaAscolto ? null : app.listen(PORT, () => {
  console.log(`Server avviato su http://localhost:${PORT}`);

  // F9 — costruisce/aggiorna il bundle worker servito ai nodi (best-effort, non blocca il boot).
  ensureWorkerBundle();

  // §DB — init schema (migrazioni) + avvio crawler proattivo. Best-effort: se
  // DATABASE_URL manca o il DB è giù, l'app funziona lo stesso (crawler OFF).
  if (db.isEnabled()) {
    db.init()
      .then(applied => {
        if (applied.length) console.log(`[db] migrazioni applicate: ${applied.join(', ')}`);
        // F60 — scheduler 24h DISATTIVATO di default: il crawl si avvia MANUALMENTE
        // dalla TUI owner (coda crawl_queue + drainer scripts/crawl-once.js). Per
        // riattivare lo scheduler automatico: CRAWLER_AUTO=1.
        if (process.env.CRAWLER_AUTO === '1') {
          crawler.start({ withLock: withSavedLock });
          console.log('[crawler] auto-scheduler ON (CRAWLER_AUTO=1)');
        } else {
          console.log('[crawler] auto-scheduler OFF (CRAWLER_AUTO≠1) → crawl manuale dalla TUI');
        }
      })
      .catch(e => console.error('[db] init KO (crawler OFF):', e.message));
  } else {
    console.log('[db] DATABASE_URL assente → persistenza/crawler disattivati');
  }
  // Pre-warm Chromium: primo lancio sposta il costo (3-5s × 3 browser) dal
  // primo /api/search al boot, eliminando il rischio di timeout sulla prima
  // ricerca quando i 3 scraper partono in parallelo.
  Promise.allSettled([
    scrapeSubito.warmup?.(),
    scrapeAutoscout.warmup?.(),
    // Moto.it: niente warmup (F33: pure-HTTP, nessun browser da pre-avviare).
  ]).then(res => {
    const names = ['Subito', 'AS24'];
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
// Esposte per i test di caratterizzazione: sono le funzioni con cui inizia OGNI risoluzione
// marca/modello, e finora non erano raggiungibili da fuori. Prefisso _ = superficie interna.
module.exports = { server, app, _lookupBrand: lookupBrand, _lookupModelGroup: lookupModelGroup, _catalogResolver: catalogResolver };
