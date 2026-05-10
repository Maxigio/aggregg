/**
 * Smoke test per il refactor P1 (Subito ?q=).
 *
 * Cosa fa:
 * 1. Stampa l'URL Subito generato per ~10 combinazioni note (auto + moto).
 * 2. Se il backend è up su localhost:3000 (o porta da env PORT/47321), chiama
 *    /api/search e stampa risultati per fonte. (Opzionale: il test funziona
 *    anche senza backend — in tal caso salta la parte API.)
 *
 * Uso:
 *   node scripts/smoke-test.js                    # stampa URL + tenta API
 *   node scripts/smoke-test.js > /tmp/before.txt  # cattura baseline
 */

const http = require('http');
const subito = require('../backend/scrapers/subito-playwright');

if (typeof subito.buildUrl !== 'function') {
  console.error('ERRORE: buildUrl non esportato da subito-playwright.js');
  process.exit(1);
}

// Casi di test: combinazioni notoriamente problematiche + casi base
const CASES = [
  // Auto — combinazioni problematiche note (slug categoria mancante su Subito)
  { tipo: 'auto', marca: 'BMW',           modello: '318',         label: 'BMW 318 (caso paradigmatico — 318 non è categoria Subito)' },
  { tipo: 'auto', marca: 'BMW',           modello: '318d',        label: 'BMW 318d (variante diesel)' },
  { tipo: 'auto', marca: 'Mercedes-Benz', modello: 'Classe A',    label: 'Mercedes Classe A (slug "classe-a" ambiguo)' },
  { tipo: 'auto', marca: 'Mercedes-Benz', modello: 'A 180',       label: 'Mercedes A 180' },
  // Auto — casi che dovrebbero funzionare già oggi (no regressioni)
  { tipo: 'auto', marca: 'Audi',          modello: 'A3',          label: 'Audi A3 (caso semplice)' },
  { tipo: 'auto', marca: 'Fiat',          modello: 'Panda',       label: 'Fiat Panda (caso semplice)' },
  { tipo: 'auto', marca: 'Volkswagen',    modello: 'Golf',        label: 'Volkswagen Golf' },
  // Auto — solo marca, no modello
  { tipo: 'auto', marca: 'Tesla',         modello: '',            label: 'Tesla (solo marca)' },
  // Moto
  { tipo: 'moto', marca: 'Ducati',        modello: 'Panigale V4', label: 'Ducati Panigale V4' },
  { tipo: 'moto', marca: 'BMW',           modello: 'R 1250 GS',   label: 'BMW R 1250 GS' },
  { tipo: 'moto', marca: 'Yamaha',        modello: 'MT-07',       label: 'Yamaha MT-07' },
  // Filtri numerici
  { tipo: 'auto', marca: 'BMW',           modello: '320',         prezzoMin: 5000, prezzoMax: 25000, annoMin: 2015, annoMax: 2022, kmMax: 100000, label: 'BMW 320 con tutti i filtri' },
];

console.log('=== SMOKE TEST — Subito buildUrl() ===\n');
for (const c of CASES) {
  const url = subito.buildUrl(c, 1);
  console.log(`[${c.tipo}] ${c.label}`);
  console.log(`  → ${url}\n`);
}

// ─── API check (opzionale) ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port: PORT, path, timeout: 60000 }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`JSON parse: ${err.message} — body: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout 60s')); });
  });
}

async function checkApi() {
  console.log('=== API /api/search (se backend attivo su porta ' + PORT + ') ===\n');

  // Tentativo connessione veloce
  try {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: 'localhost', port: PORT, path: '/api/brands?tipo=auto', timeout: 2000 }, res => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else reject(new Error('status ' + res.statusCode));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout 2s')); });
    });
  } catch (err) {
    console.log(`Backend non raggiungibile su porta ${PORT} (${err.message}) — skip API tests.`);
    console.log('Per eseguirli: avvia il server (cd backend && node server.js) e rilancia.\n');
    return;
  }

  // Solo i casi più rappresentativi per non saturare le richieste
  const apiCases = [
    { tipo: 'auto', marca: 'BMW',           modello: '318',     label: 'BMW 318' },
    { tipo: 'auto', marca: 'Mercedes-Benz', modello: 'Classe A',label: 'Mercedes Classe A' },
    { tipo: 'auto', marca: 'Fiat',          modello: 'Panda',   label: 'Fiat Panda' },
    { tipo: 'moto', marca: 'BMW',           modello: 'R 1250 GS', label: 'BMW R 1250 GS' },
  ];

  for (const c of apiCases) {
    const qs = new URLSearchParams({ tipo: c.tipo, marca: c.marca, modello: c.modello }).toString();
    process.stdout.write(`[${c.tipo}] ${c.label.padEnd(28)} `);
    try {
      const t0 = Date.now();
      const data = await getJson(`/api/search?${qs}`);
      const ms  = Date.now() - t0;
      const tot = (data.risultati || []).length;
      const per = (data.risultati || []).reduce((acc, r) => {
        acc[r.fonte] = (acc[r.fonte] || 0) + 1;
        return acc;
      }, {});
      const breakdown = Object.entries(per).map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`${tot.toString().padStart(4)} risultati  (${breakdown || 'vuoto'})  ${(ms/1000).toFixed(1)}s`);
    } catch (err) {
      console.log('ERRORE — ' + err.message);
    }
  }
  console.log();
}

checkApi().catch(err => {
  console.error('Errore inatteso:', err);
  process.exit(1);
});
