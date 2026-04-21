/**
 * Test isolato del nuovo scraper Moto.it.
 * Casi:
 *  1. brand only (Ducati) sort price-a
 *  2. brand + model (Ducati Monster 1100)
 *  3. brand + model + prezzo + km (Honda Africa Twin 5-15k, km<40k)
 *  4. brand + prezzoMax (Ducati ≤3000€)
 */
const scrapeMotoIt = require('../backend/scrapers/motoit');

async function run(label, params) {
  console.log(`\n\n=== ${label} ===`);
  console.log('Params:', JSON.stringify(params));
  const t0 = Date.now();
  const results = await scrapeMotoIt(params);
  console.log(`→ ${results.length} risultati in ${Date.now()-t0}ms`);
  results.slice(0, 10).forEach((r, i) => {
    console.log(`  [${i}] €${r.prezzo} | ${r.anno} | ${r.km}km | ${r.provincia} | ${r.titolo.slice(0,60)}`);
  });
  if (results.length > 10) console.log(`  ... e altri ${results.length - 10}`);
}

(async () => {
  await run('1. Ducati brand-only', {
    tipo: 'moto',
    marca: 'Ducati',
    motoitBrandSlug: 'ducati',
  });

  await run('2. Ducati Monster 1100', {
    tipo: 'moto',
    marca: 'Ducati',
    motoitBrandSlug: 'ducati',
    motoitModelSlug: 'monster-1100',
  });

  await run('3. Honda Africa Twin 5000-15000 km<40000', {
    tipo: 'moto',
    marca: 'Honda',
    motoitBrandSlug: 'honda',
    motoitModelSlug: 'africa-twin-crf-1000l',
    prezzoMin: 5000,
    prezzoMax: 15000,
    kmMax: 40000,
  });

  await run('4. Ducati ≤3000€', {
    tipo: 'moto',
    marca: 'Ducati',
    motoitBrandSlug: 'ducati',
    prezzoMax: 3000,
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
