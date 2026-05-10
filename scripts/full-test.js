/**
 * Test end-to-end del backend Auto Moto Radar.
 *
 * Avvia il server, esegue una serie di assertion su:
 *  - Catalogo (no voci modelLine, no pagina-N, campi obsoleti rimossi)
 *  - Endpoint /api/brands, /api/models
 *  - Endpoint /api/search (auto + moto, con e senza filtri)
 *  - Endpoint /api/subito/status, /api/subito/keep-alive
 *  - Casi paradigmatici di P1 (BMW 318, Mercedes Classe A) — refactor verificato
 *
 * Ogni assertion stampa ✅ / ❌ con dettagli.
 * Exit 0 se tutte passano, 1 altrimenti.
 *
 * Uso:  node scripts/full-test.js
 */

const http     = require('http');
const { spawn } = require('child_process');
const path     = require('path');

const PORT = 3001;
const BASE = `http://localhost:${PORT}`;

// ─── Stato test ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function ok(label, info) {
  passed++;
  console.log(`  ✅ ${label}` + (info ? '  ' + info : ''));
}
function fail(label, info) {
  failed++;
  failures.push(label + (info ? ' — ' + info : ''));
  console.log(`  ❌ ${label}` + (info ? '  ' + info : ''));
}
function assert(cond, label, infoOk, infoFail) {
  if (cond) ok(label, infoOk);
  else      fail(label, infoFail);
}
function section(name) {
  console.log('\n┌─── ' + name);
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = { method, host: 'localhost', port: PORT, path, timeout: 90000 };
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }); }
        catch (err) { reject(new Error('JSON parse: ' + err.message + ' body[0:200]: ' + data.slice(0, 200))); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout 90s')); });
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const get  = p => req('GET',  p);
const post = (p, b) => req('POST', p, b);

async function waitReady(maxSeconds = 45) {
  for (let i = 0; i < maxSeconds; i++) {
    try {
      const r = await new Promise((resolve, reject) => {
        const rq = http.get({ host: 'localhost', port: PORT, path: '/api/subito/status', timeout: 1500 }, res => {
          res.resume();
          if (res.statusCode === 200) resolve(true);
          else reject(new Error('status ' + res.statusCode));
        });
        rq.on('error', reject);
        rq.on('timeout', () => { rq.destroy(new Error('t')); });
      });
      return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// ─── Catalogo: regression check sul models.json ──────────────────────────────
function testCatalogo() {
  section('CATALOGO (data/models.json — post pulizia P1)');
  const data = require(path.join(__dirname, '../data/models.json'));

  const autoBrands = Object.keys(data.auto || {});
  const motoBrands = Object.keys(data.moto || {});
  assert(autoBrands.length > 250, 'Brand auto > 250',  `(${autoBrands.length})`, `(${autoBrands.length})`);
  assert(motoBrands.length > 400, 'Brand moto > 400',  `(${motoBrands.length})`, `(${motoBrands.length})`);

  // Conta voci totali
  let autoModels = 0, motoModels = 0;
  let modelLineFound = 0, paginaFound = 0, slugSubitoFound = 0, autoNoMmmv = 0;
  for (const [, b] of Object.entries(data.auto || {})) {
    autoModels += (b.models || []).length;
    for (const m of (b.models || [])) {
      if (m.kindAS === 'modelLine')                   modelLineFound++;
      if ('slugSubito' in m || 'subitoKey' in m)      slugSubitoFound++;
      if (!m.mmmvAutoscout)                           autoNoMmmv++;
    }
    if ('subito' in b) slugSubitoFound++;
  }
  for (const [, b] of Object.entries(data.moto || {})) {
    motoModels += (b.models || []).length;
    for (const m of (b.models || [])) {
      if (m.kindAS === 'modelLine')                                    modelLineFound++;
      if (m.slugMotoIt && /^pagina-\d+$/.test(m.slugMotoIt))            paginaFound++;
      if ('slugSubito' in m || 'subitoKey' in m || 'brandKey' in m)    slugSubitoFound++;
    }
    if ('subito' in b) slugSubitoFound++;
  }
  assert(autoModels > 4500, 'Modelli auto > 4500', `(${autoModels})`);
  assert(motoModels > 9000, 'Modelli moto > 9000', `(${motoModels})`);
  assert(modelLineFound === 0, 'Nessuna voce kindAS=modelLine',  '0', `(trovate ${modelLineFound})`);
  assert(paginaFound === 0,    'Nessuna voce slugMotoIt=pagina-N','0', `(trovate ${paginaFound})`);
  assert(slugSubitoFound === 0,'Nessun campo Subito obsoleto',    '0', `(trovati ${slugSubitoFound})`);
  assert(autoNoMmmv === 0,     'Tutte le auto hanno mmmvAutoscout','0', `(senza: ${autoNoMmmv})`);

  // Spot check struttura
  const bmwAuto = data.auto.BMW;
  assert(!!bmwAuto && Array.isArray(bmwAuto.models), 'BMW auto presente con array models',
         `(${bmwAuto?.models?.length} modelli)`);
  assert(bmwAuto.sites?.includes('subito') && bmwAuto.sites?.includes('autoscout'),
         'BMW auto sites include subito+autoscout', `(${bmwAuto.sites?.join(',')})`);

  const bmwMoto = data.moto.BMW;
  assert(!!bmwMoto && bmwMoto.sites?.includes('motoit'),
         'BMW moto presente con sites motoit',
         `(${bmwMoto?.models?.length} modelli, sites=${bmwMoto?.sites?.join(',')})`);
  console.log('└──────');
}

// ─── Endpoint brands/models ──────────────────────────────────────────────────
async function testBrandsModels() {
  section('ENDPOINT /api/brands e /api/models');

  // /api/brands
  const ba = await get('/api/brands?tipo=auto');
  assert(ba.status === 200,                               'GET /api/brands?tipo=auto → 200', `(${ba.status})`);
  assert(Array.isArray(ba.json?.brands) && ba.json.brands.length > 250, 'brands auto > 250',
         `(${ba.json?.brands?.length})`);

  const bm = await get('/api/brands?tipo=moto');
  assert(bm.status === 200, 'GET /api/brands?tipo=moto → 200', `(${bm.status})`);
  assert(Array.isArray(bm.json?.brands) && bm.json.brands.length > 400, 'brands moto > 400',
         `(${bm.json?.brands?.length})`);

  const sample = (ba.json.brands || [])[0];
  assert(sample && sample.nome && Array.isArray(sample.sites),
         'brand entry ha nome + sites', `(${sample?.nome}, ${sample?.sites?.join(',')})`);

  // /api/models BMW auto
  const ma = await get('/api/models?tipo=auto&marca=BMW');
  assert(ma.status === 200,                          'GET /api/models BMW auto → 200', `(${ma.status})`);
  assert(Array.isArray(ma.json?.modelli) && ma.json.modelli.length > 80,
         'BMW auto: > 80 modelli', `(${ma.json?.modelli?.length})`);
  assert(ma.json.modelli.every(m => !('slugSubito' in m) && !('subitoKey' in m)),
         'BMW auto modelli: niente campi Subito obsoleti');
  assert(ma.json.modelli.every(m => m.mmmvAutoscout || m.kindAS !== 'modelLine'),
         'BMW auto modelli: niente modelLine');

  // /api/models BMW moto
  const mm = await get('/api/models?tipo=moto&marca=BMW');
  assert(mm.status === 200, 'GET /api/models BMW moto → 200');
  assert(Array.isArray(mm.json?.modelli) && mm.json.modelli.length > 200,
         'BMW moto: > 200 modelli', `(${mm.json?.modelli?.length})`);
  assert(mm.json.modelli.every(m => !/^pagina-\d+$/.test(m.slugMotoIt || '')),
         'BMW moto: niente slugMotoIt=pagina-N');

  // marca inesistente
  const me = await get('/api/models?tipo=auto&marca=NonEsiste123');
  assert(me.status === 200 && (me.json?.modelli || []).length === 0,
         'Marca inesistente → modelli=[]');
  console.log('└──────');

  // ── /api/filters (P10 — schema filtri per-piattaforma) ───────────────────
  section('ENDPOINT /api/filters (P10)');
  const fa = await get('/api/filters?tipo=auto');
  assert(fa.status === 200, 'GET /api/filters?tipo=auto → 200', `(${fa.status})`);
  assert(fa.json?.subito?.length    > 0, 'auto: filtri Subito > 0',    `(${fa.json?.subito?.length})`);
  assert(fa.json?.autoscout?.length > 0, 'auto: filtri AS24 > 0',      `(${fa.json?.autoscout?.length})`);
  assert((fa.json?.motoit || []).length === 0, 'auto: 0 filtri MotoIt (esclusi)');

  const fm = await get('/api/filters?tipo=moto');
  assert(fm.status === 200, 'GET /api/filters?tipo=moto → 200');
  assert(fm.json?.subito?.length    > 0, 'moto: filtri Subito > 0',    `(${fm.json?.subito?.length})`);
  assert(fm.json?.motoit?.length    > 0, 'moto: filtri MotoIt > 0',    `(${fm.json?.motoit?.length})`);

  // struttura filtro
  const filterSample = fa.json.autoscout[0];
  assert(filterSample.key && filterSample.label && filterSample.type,
         'filtro ha key+label+type', `(${filterSample.key} / ${filterSample.label} / ${filterSample.type})`);

  // filtri applicati: ricerca BMW 318 con carburante=Diesel via filtersAutoscout
  const filtersJson = JSON.stringify({ carburante: 'D' });
  const filtered = await get('/api/search?tipo=auto&marca=BMW&modello=318&filtersAutoscout=' + encodeURIComponent(filtersJson));
  assert(filtered.status === 200, 'search con filtersAutoscout → 200');
  const asResults = (filtered.json?.risultati || []).filter(r => r.fonte === 'autoscout');
  assert(asResults.length > 0, '  filtri AS24 applicati: > 0 risultati', `(${asResults.length})`);
  const allDiesel = asResults.slice(0, 10).every(r => !r.carburante || /diesel/i.test(r.carburante));
  assert(allDiesel, '  primi 10 AS24 sono Diesel (filtro funziona)');
  console.log('└──────');
}

// ─── Endpoint search (cuore di P1) ───────────────────────────────────────────
async function testSearch() {
  section('ENDPOINT /api/search (P1 — Subito ?q= + Subito session)');

  // Caso paradigmatico P1: BMW 318 (slug "318" non era categoria Subito)
  console.log('  → BMW 318 (caso paradigmatico)');
  const t0 = Date.now();
  const r1 = await get('/api/search?tipo=auto&marca=BMW&modello=318');
  const t1 = Date.now();
  assert(r1.status === 200, '  status 200', `(${r1.status})`);
  assert(typeof r1.json?.totale === 'number' && r1.json.totale > 0,
         '  totale > 0', `(${r1.json?.totale} risultati in ${t1 - t0}ms)`);
  const fonti1 = (r1.json?.risultati || []).reduce((acc, r) => { acc[r.fonte] = (acc[r.fonte] || 0) + 1; return acc; }, {});
  assert((fonti1.autoscout || 0) > 30, '  AS24 > 30 risultati', `(${fonti1.autoscout})`,
         `(${JSON.stringify(fonti1)})`);
  assert(r1.json?.subitoStatus === 'ok' || r1.json?.subitoStatus === 'needs_bootstrap',
         '  subitoStatus valido', `(${r1.json?.subitoStatus} reason=${r1.json?.subitoReason || '-'})`);

  // Mercedes Classe A (slug ambiguo storico)
  console.log('  → Mercedes-Benz Classe A');
  const r2 = await get('/api/search?tipo=auto&marca=Mercedes-Benz&modello=' + encodeURIComponent('Classe A'));
  assert(r2.status === 200, '  status 200');
  assert((r2.json?.risultati || []).length > 0, '  risultati > 0', `(${r2.json?.totale})`);

  // Filtri numerici
  console.log('  → BMW 320 con filtri (prezzo 5000-25000, anno 2015-2022, km≤100k)');
  const r3 = await get('/api/search?tipo=auto&marca=BMW&modello=320&prezzoMin=5000&prezzoMax=25000&annoMin=2015&annoMax=2022&kmMax=100000');
  assert(r3.status === 200, '  status 200');
  const r3items = r3.json?.risultati || [];
  const violazioniPrezzo = r3items.filter(r => r.prezzo != null && (r.prezzo < 5000 || r.prezzo > 25000));
  const violazioniAnno   = r3items.filter(r => r.anno   != null && (r.anno   < 2015 || r.anno   > 2022));
  const violazioniKm     = r3items.filter(r => r.km     != null && r.km     > 100000);
  assert(violazioniPrezzo.length === 0, '  filtro prezzo rispettato', `0 violazioni`,
         `(${violazioniPrezzo.length} violazioni: ${violazioniPrezzo.slice(0,2).map(v => v.prezzo).join(',')})`);
  assert(violazioniAnno.length === 0,   '  filtro anno rispettato',   '0', `(${violazioniAnno.length})`);
  assert(violazioniKm.length === 0,     '  filtro km rispettato',     '0', `(${violazioniKm.length})`);

  // Moto: BMW R 1250 GS — verifica AS24 + Moto.it
  console.log('  → BMW R 1250 GS (moto, 3 fonti)');
  const r4 = await get('/api/search?tipo=moto&marca=BMW&modello=' + encodeURIComponent('R 1250 GS'));
  const fonti4 = (r4.json?.risultati || []).reduce((acc, r) => { acc[r.fonte] = (acc[r.fonte] || 0) + 1; return acc; }, {});
  assert(r4.status === 200, '  status 200');
  assert((fonti4.autoscout || 0) > 0, '  AS24 ha risultati', `(${fonti4.autoscout})`);
  assert((fonti4.moto || 0) > 0,      '  Moto.it ha risultati', `(${fonti4.moto})`);

  // Solo marca, no modello
  console.log('  → Tesla solo marca');
  const r5 = await get('/api/search?tipo=auto&marca=Tesla');
  assert(r5.status === 200, '  status 200');
  assert((r5.json?.risultati || []).length > 0, '  risultati > 0', `(${r5.json?.totale})`);

  // Caso d'errore: marca mancante
  const r6 = await get('/api/search?tipo=auto');
  assert(r6.status === 400, '  marca mancante → 400', `(${r6.status})`);
  console.log('└──────');
}

// ─── Endpoint Subito session/bootstrap/keep-alive ────────────────────────────
async function testSubitoSession() {
  section('ENDPOINT /api/subito/* (session bootstrap + auto-refresh)');
  const s = await get('/api/subito/status');
  assert(s.status === 200, 'GET /api/subito/status → 200', `(${s.status})`);
  const j = s.json || {};
  assert(['ok', 'expiring_soon', 'blocked', 'never_configured'].includes(j.health),
         'health è uno dei valori attesi', `(${j.health})`);
  assert(typeof j.blocked === 'boolean',     'blocked è bool', `(${j.blocked})`);
  assert(typeof j.hasSession === 'boolean',  'hasSession è bool', `(${j.hasSession})`);
  assert('lastRefresh' in j && 'lastRefreshOk' in j, 'campi lastRefresh presenti');
  assert(typeof j.bootstrapping === 'boolean', 'bootstrapping è bool');

  // keep-alive senza session → no_session
  const k = await post('/api/subito/keep-alive');
  assert(k.status === 200,   'POST /api/subito/keep-alive → 200');
  assert(k.json?.ok === false && k.json?.reason === 'no_session',
         'keep-alive senza session → {ok:false, reason:no_session}',
         `(${JSON.stringify(k.json)})`);
  console.log('└──────');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══ Test end-to-end Auto Moto Radar ═══');

  // Catalogo: non serve server, lo facciamo subito
  testCatalogo();

  // Avvia backend
  console.log('\nAvvio backend su porta ' + PORT + '…');
  const proc = spawn('node', [path.join(__dirname, '../backend/server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  proc.stdout.on('data', d => bootLog += d.toString());
  proc.stderr.on('data', d => bootLog += d.toString());

  const ready = await waitReady();
  if (!ready) {
    console.error('Backend non si è avviato. Log:\n' + bootLog);
    proc.kill();
    process.exit(2);
  }
  console.log('Backend pronto. Aspetto prewarm browser…');
  // Aspetta che i 3 prewarm siano completati (anche se non strettamente necessario)
  await new Promise(r => setTimeout(r, 5000));

  try {
    await testBrandsModels();
    await testSearch();
    await testSubitoSession();
  } catch (err) {
    console.error('\n💥 Errore inatteso durante i test:', err.message);
    failed++;
  }

  // Summary
  console.log('\n═══ Summary ═══');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log('   • ' + f));
  }

  // Cleanup
  proc.kill();
  await new Promise(r => setTimeout(r, 1500));

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
