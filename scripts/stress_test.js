/**
 * Stress test autonomo dei 3 scraper con filtro regione.
 * Esegue query sequenziali a http://localhost:3003/api/search
 * e riporta per ogni test:
 *   - totale annunci
 *   - breakdown per fonte
 *   - province AS24 parseable (per spotting leak regionali)
 *   - primi 3 titoli AS24 (per spotting bug slug/modello sbagliato)
 */
const http = require('http');

const BASE = 'http://localhost:3003';

function req(path) {
  return new Promise((resolve, reject) => {
    const r = http.get(BASE + path, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.setTimeout(90000, () => { r.destroy(new Error('timeout')); });
  });
}

const TESTS = [
  // #1 - Regressione baseline (moto)
  { id: '1a', desc: 'Yamaha MT-07 / Lombardia (moto baseline)',
    qs: 'tipo=moto&marca=Yamaha&modello=MT-07&regione=lombardia' },

  // #2 - Auto (fix AS24 condiviso moto+auto, verifica end-to-end)
  { id: '2a', desc: 'Fiat 500 / Emilia-Romagna (auto)',
    qs: 'tipo=auto&marca=Fiat&modello=500&regione=emilia-romagna' },
  { id: '2b', desc: 'Ford Fiesta / Lazio (auto)',
    qs: 'tipo=auto&marca=Ford&modello=Fiesta&regione=lazio' },
  { id: '1b', desc: 'BMW Serie 3 / Lombardia (auto baseline)',
    qs: 'tipo=auto&marca=BMW&modello=Serie%203&regione=lombardia' },

  // #3 - Brand-only + regione
  { id: '3',  desc: 'Ducati brand-only / Toscana',
    qs: 'tipo=moto&marca=Ducati&regione=toscana' },

  // #4 - Regioni piccole/isole
  { id: '4a', desc: 'Yamaha MT-07 / Molise (regione piccola)',
    qs: 'tipo=moto&marca=Yamaha&modello=MT-07&regione=molise' },
  { id: '4b', desc: 'Yamaha MT-07 / Sardegna (isola)',
    qs: 'tipo=moto&marca=Yamaha&modello=MT-07&regione=sardegna' },
  { id: '4c', desc: 'Yamaha MT-07 / Valle d\'Aosta (minuscola)',
    qs: 'tipo=moto&marca=Yamaha&modello=MT-07&regione=valle-d-aosta' },

  // #5 - Modelli con slug divergenti
  { id: '5a', desc: 'Ducati Monster 1100 / Emilia-Romagna (trattini)',
    qs: 'tipo=moto&marca=Ducati&modello=Monster%201100&regione=emilia-romagna' },
  { id: '5b', desc: 'BMW R 1200 GS / Lombardia (spazi multipli)',
    qs: 'tipo=moto&marca=BMW&modello=R%201200%20GS&regione=lombardia' },
  { id: '5c', desc: 'Honda Africa Twin / Lazio (due parole)',
    qs: 'tipo=moto&marca=Honda&modello=Africa%20Twin&regione=lazio' },

  // #7 - Filtri combinati + regione
  { id: '7',  desc: 'BMW Serie 3 / ER / 5-15k€ / 2015-2020 / <100k km',
    qs: 'tipo=auto&marca=BMW&modello=Serie%203&regione=emilia-romagna&prezzoMin=5000&prezzoMax=15000&annoMin=2015&annoMax=2020&kmMax=100000' },
];

// Province attese per ogni regione (per spotting leak)
const PROV_BY_REGION = {
  'emilia-romagna': new Set(['BO','FE','FC','MO','PR','PC','RA','RE','RN']),
  'lombardia': new Set(['BG','BS','CO','CR','LC','LO','MN','MI','MB','PV','SO','VA']),
  'toscana': new Set(['AR','FI','GR','LI','LU','MS','PI','PO','PT','SI']),
  'lazio': new Set(['FR','LT','RI','RM','VT']),
  'molise': new Set(['CB','IS']),
  'sardegna': new Set(['CA','NU','OR','SS','SU']),
  'valle-d-aosta': new Set(['AO']),
};

async function runTest(t) {
  const regione = (t.qs.match(/regione=([^&]+)/) || [,null])[1];
  const inRegion = regione ? PROV_BY_REGION[regione] : null;
  const t0 = Date.now();
  let j;
  try { j = await req('/api/search?' + t.qs); }
  catch (e) { return { id: t.id, desc: t.desc, error: e.message }; }
  const ms = Date.now() - t0;

  const by = { autoscout: [], subito: [], moto: [] };
  (j.risultati || []).forEach(r => by[r.fonte]?.push(r));

  // Province AS24 (filtra null)
  const asProvs = by.autoscout.map(r => r.provincia).filter(Boolean);
  const asDist = {};
  asProvs.forEach(p => asDist[p] = (asDist[p] || 0) + 1);

  // Leak detection: province non in regione attesa (border ok ma annotato)
  let asLeak = 0;
  if (inRegion) {
    asProvs.forEach(p => { if (!inRegion.has(p)) asLeak++; });
  }

  return {
    id: t.id,
    desc: t.desc,
    ms,
    totale: j.totale || 0,
    as24: by.autoscout.length,
    subito: by.subito.length,
    moto: by.moto.length,
    as24Top3: by.autoscout.slice(0, 3).map(r => `${r.prezzo}€ ${r.titolo} [${r.provincia||'?'}]`),
    asDist,
    asLeak,
    asProvParsed: asProvs.length,
  };
}

(async () => {
  console.log('='.repeat(80));
  console.log('STRESS TEST AUTONOMO - BananaChePrezzi');
  console.log('='.repeat(80));
  for (const t of TESTS) {
    const r = await runTest(t);
    console.log(`\n[${r.id}] ${r.desc}`);
    if (r.error) { console.log(`  ❌ ERRORE: ${r.error}`); continue; }
    console.log(`  totale: ${r.totale}  (AS24: ${r.as24} · Subito: ${r.subito} · Moto.it: ${r.moto})  [${r.ms}ms]`);
    if (r.as24Top3.length) console.log(`  AS24 top 3: ${r.as24Top3.join(' | ')}`);
    if (r.asProvParsed > 0) {
      const distStr = Object.entries(r.asDist).sort((a,b)=>b[1]-a[1]).map(([p,n])=>`${p}:${n}`).join(' ');
      console.log(`  AS24 province (parsed ${r.asProvParsed}/${r.as24}): ${distStr}`);
      if (r.asLeak > 0) console.log(`  ⚠️  LEAK regionale AS24: ${r.asLeak} annunci fuori regione (border ok)`);
      else console.log(`  ✅ Nessun leak fuori regione/border`);
    }
  }
  console.log('\n' + '='.repeat(80));
  console.log('DONE');
})();
