/**
 * Test end-to-end: chiama /api/search e confronta i risultati per fonte.
 */
const http = require('http');

function apiCall(params) {
  const qs = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000/api/search?${qs}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function test(label, params) {
  console.log(`\n\n=== ${label} ===`);
  console.log('Params:', JSON.stringify(params));
  const t0 = Date.now();
  try {
    const r = await apiCall(params);
    const elapsed = Date.now() - t0;
    if (r.error) {
      console.log('ERR:', r.error);
      return;
    }
    const byFonte = r.risultati.reduce((a, x) => (a[x.fonte] = (a[x.fonte]||0) + 1, a), {});
    console.log(`→ ${r.totale} totali in ${elapsed}ms | per fonte: ${JSON.stringify(byFonte)}`);
    // Top 10 più economici
    console.log('Top 10 più economici:');
    r.risultati.slice(0, 10).forEach((x, i) => {
      console.log(`  [${i}] €${x.prezzo} | ${x.fonte} | ${x.anno} | ${x.km}km | ${x.provincia||''} | ${(x.titolo||'').slice(0,55)}`);
    });
  } catch (e) {
    console.log('EXCEPTION:', e.message);
  }
}

(async () => {
  // Test 1: Ducati Monster 1100, senza filtri (dovrebbe avere subito+autoscout+moto)
  await test('Ducati Monster 1100', {
    tipo: 'moto',
    marca: 'Ducati',
    modello: 'Monster 1100',
  });

  // Test 2: Honda Africa Twin 1000 con filtri prezzo/km
  await test('Honda Africa Twin CRF1000L 5-15k km<40k', {
    tipo: 'moto',
    marca: 'Honda',
    modello: 'CRF1000L Africa Twin',
    prezzoMin: 5000,
    prezzoMax: 15000,
    kmMax: 40000,
  });

  // Test 3: Yamaha MT-07 ≤7000€
  await test('Yamaha MT-07 ≤7000€', {
    tipo: 'moto',
    marca: 'Yamaha',
    modello: 'MT-07',
    prezzoMax: 7000,
  });

  // Test 4: Ducati Diavel V4 min 5000€ (il caso problematico)
  await test('Ducati Diavel V4 ≥5000€', {
    tipo: 'moto',
    marca: 'Ducati',
    modello: 'Diavel V4',
    prezzoMin: 5000,
  });

  // Test 5: brand senza modello (Kawasaki tutti)
  await test('Kawasaki tutti ≤4000€', {
    tipo: 'moto',
    marca: 'Kawasaki',
    prezzoMax: 4000,
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
