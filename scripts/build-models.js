/**
 * Genera data/models.json
 *
 * AUTO  : Autoscout taxonomy (C-type modelLines, fallback a models individuali)
 * MOTO  : Moto.it brand page (slug precisi) + cross-reference con Autoscout per mmmv
 *
 * Ogni entry:
 *   { nome, mmmv?, slugMoto? }
 *
 * Uso: node scripts/build-models.js
 */

const axios  = require('axios');
const cheerio = require('cheerio');
const fs     = require('fs');
const path   = require('path');
const { HEADERS, toSlug, extractNextData } = require('../backend/scrapers/utils');

// ─── Brand list ───────────────────────────────────────────────────────────────
const BRANDS = {
  auto: [
    { nome: 'Abarth',        slugAS: 'abarth' },
    { nome: 'Alfa Romeo',    slugAS: 'alfa-romeo' },
    { nome: 'Alpine',        slugAS: 'alpine' },
    { nome: 'Audi',          slugAS: 'audi' },
    { nome: 'BMW',           slugAS: 'bmw' },
    { nome: 'BYD',           slugAS: 'byd' },
    { nome: 'Chevrolet',     slugAS: 'chevrolet' },
    { nome: 'Citroën',       slugAS: 'citroen' },
    { nome: 'Cupra',         slugAS: 'cupra' },
    { nome: 'Dacia',         slugAS: 'dacia' },
    { nome: 'DS Automobiles',slugAS: 'ds-automobiles' },
    { nome: 'Fiat',          slugAS: 'fiat' },
    { nome: 'Ford',          slugAS: 'ford' },
    { nome: 'Honda',         slugAS: 'honda' },
    { nome: 'Hyundai',       slugAS: 'hyundai' },
    { nome: 'Jaguar',        slugAS: 'jaguar' },
    { nome: 'Jeep',          slugAS: 'jeep' },
    { nome: 'Kia',           slugAS: 'kia' },
    { nome: 'Land Rover',    slugAS: 'land-rover' },
    { nome: 'Lancia',        slugAS: 'lancia' },
    { nome: 'Lexus',         slugAS: 'lexus' },
    { nome: 'Mazda',         slugAS: 'mazda' },
    { nome: 'Mercedes-Benz', slugAS: 'mercedes-benz' },
    { nome: 'MG',            slugAS: 'mg' },
    { nome: 'Mini',          slugAS: 'mini' },
    { nome: 'Mitsubishi',    slugAS: 'mitsubishi' },
    { nome: 'Nissan',        slugAS: 'nissan' },
    { nome: 'Opel',          slugAS: 'opel' },
    { nome: 'Peugeot',       slugAS: 'peugeot' },
    { nome: 'Porsche',       slugAS: 'porsche' },
    { nome: 'Renault',       slugAS: 'renault' },
    { nome: 'SEAT',          slugAS: 'seat' },
    { nome: 'Skoda',         slugAS: 'skoda' },
    { nome: 'Smart',         slugAS: 'smart' },
    { nome: 'Subaru',        slugAS: 'subaru' },
    { nome: 'Suzuki',        slugAS: 'suzuki' },
    { nome: 'Tesla',         slugAS: 'tesla' },
    { nome: 'Toyota',        slugAS: 'toyota' },
    { nome: 'Volkswagen',    slugAS: 'volkswagen' },
    { nome: 'Volvo',         slugAS: 'volvo' },
  ],
  moto: [
    { nome: 'Aprilia',          slugAS: 'aprilia',         slugMI: 'aprilia' },
    { nome: 'Benelli',          slugAS: 'benelli',         slugMI: 'benelli' },
    { nome: 'Beta',             slugAS: 'beta',            slugMI: 'betamotor' },
    { nome: 'BMW',              slugAS: 'bmw',             slugMI: 'bmw' },
    { nome: 'CF Moto',          slugAS: 'cfmoto',          slugMI: 'cfmoto' },
    { nome: 'Ducati',           slugAS: 'ducati',          slugMI: 'ducati' },
    { nome: 'Fantic',           slugAS: 'fantic',          slugMI: 'fantic-motor' },
    { nome: 'GasGas',           slugAS: 'gas-gas',         slugMI: 'gasgas' },
    { nome: 'Harley-Davidson',  slugAS: 'harley-davidson', slugMI: 'harley-davidson' },
    { nome: 'Honda',            slugAS: 'honda',           slugMI: 'honda' },
    { nome: 'Husqvarna',        slugAS: 'husqvarna',       slugMI: 'husqvarna' },
    { nome: 'Indian',           slugAS: 'indian',          slugMI: 'indian' },
    { nome: 'Kawasaki',         slugAS: 'kawasaki',        slugMI: 'kawasaki' },
    { nome: 'KTM',              slugAS: 'ktm',             slugMI: 'ktm' },
    { nome: 'Kymco',            slugAS: 'kymco',           slugMI: 'kymco' },
    { nome: 'Moto Guzzi',       slugAS: 'moto-guzzi',      slugMI: 'moto-guzzi' },
    { nome: 'MV Agusta',        slugAS: 'mv-agusta',       slugMI: 'mv-agusta' },
    { nome: 'Piaggio',          slugAS: 'piaggio',         slugMI: 'piaggio' },
    { nome: 'Royal Enfield',    slugAS: 'royal-enfield',   slugMI: 'royal-enfield' },
    { nome: 'Sherco',           slugAS: 'sherco',          slugMI: 'sherco' },
    { nome: 'Suzuki',           slugAS: 'suzuki',          slugMI: 'suzuki' },
    { nome: 'SYM',              slugAS: 'sym',             slugMI: 'sym' },
    { nome: 'Triumph',          slugAS: 'triumph',         slugMI: 'triumph' },
    { nome: 'Vespa',            slugAS: 'piaggio',         slugMI: 'vespa' },
    { nome: 'Yamaha',           slugAS: 'yamaha',          slugMI: 'yamaha' },
    { nome: 'Zero Motorcycles', slugAS: 'zero',            slugMI: 'zero' },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Normalizza per matching fuzzy: rimuove tutto tranne lettere e cifre */
function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Slug Moto.it → nome display (es. "cb-500-f" → "CB 500 F") */
function slugToNome(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── 1. Autoscout taxonomy (AUTO) ─────────────────────────────────────────────
async function fetchModelsAuto(slugAS) {
  const url = `https://www.autoscout24.it/lst/${slugAS}?cy=I&atype=C`;
  try {
    const res      = await axios.get(url, { headers: HEADERS, maxRedirects: 5, timeout: 15000 });
    const nextData = extractNextData(res.data);
    if (!nextData) return [];
    const pp      = nextData?.props?.pageProps;
    const tx      = pp?.taxonomy || {};
    const makeId  = parseInt((pp?.pageQuery?.mmmv || '').split('|')[0], 10);
    if (!makeId || isNaN(makeId)) return [];

    // Prova modelLines di tipo C (famiglie auto, es. "3-Series")
    const lines = (tx.modelLines?.[makeId] || []).filter(ml => ml.vehicleTypeId === 'C');
    if (lines.length >= 3) {
      return lines
        .map(ml => ({ nome: ml.name, mmmv: `${makeId}||${ml.id}|` }))
        .sort((a, b) => a.nome.localeCompare(b.nome));
    }

    // Fallback: modelli individuali
    return (tx.models?.[makeId] || [])
      .map(m => ({ nome: m.label, mmmv: `${makeId}|${m.value}||` }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  } catch (err) {
    console.warn(`  [WARN AS auto] ${slugAS}: ${err.message}`);
    return [];
  }
}

// ─── 2. Autoscout taxonomy (MOTO) ─────────────────────────────────────────────
/**
 * Ritorna mappa { normNome → { mmmv, slugAS } } per cross-reference.
 * Usa SEMPRE i modelli individuali (non le B-lines) perché le lines sono
 * categorie generiche (Adventure/Sport/Tour) che non corrispondono a modelli
 * specifici (es. BMW ha B-lines "Adventure", "Roadster" invece di "R 1250 GS").
 * slugAS = slug del path Autoscout per URL model-specific (/lst-moto/{brand}/{slugAS})
 */
async function fetchMmmvMapMoto(slugAS) {
  const url = `https://www.autoscout24.it/lst-moto/${slugAS}?cy=I`;
  const map = {};
  try {
    const res      = await axios.get(url, { headers: HEADERS, maxRedirects: 5, timeout: 15000 });
    const nextData = extractNextData(res.data);
    if (!nextData) return map;
    const pp     = nextData?.props?.pageProps;
    const tx     = pp?.taxonomy || {};
    const makeId = parseInt((pp?.pageQuery?.mmmv || '').split('|')[0], 10);
    if (!makeId || isNaN(makeId)) return map;

    // Sempre modelli individuali: slugAS = toSlug(label) per URL path-based
    (tx.models?.[makeId] || []).forEach(m => {
      map[norm(m.label)] = {
        mmmv:   `${makeId}|${m.value}||`,
        slugAS: toSlug(m.label),
      };
    });
  } catch (err) {
    console.warn(`  [WARN AS moto] ${slugAS}: ${err.message}`);
  }
  return map;
}

// ─── 3. Moto.it brand page scraping ──────────────────────────────────────────
async function fetchModelsMotoIt(slugMI) {
  const url = `https://www.moto.it/moto-usate/${slugMI}`;
  try {
    const res = await axios.get(url, { headers: HEADERS, maxRedirects: 5, timeout: 15000 });
    const $   = cheerio.load(res.data);
    const slugs = new Set();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      // Pattern: /moto-usate/{marca}/{modello}  (solo un livello, no date/id)
      const m = href.match(new RegExp(`^/moto-usate/${slugMI}/([a-z0-9][a-z0-9-]+)$`));
      if (!m) return;
      const slug = m[1];
      // Escludi regioni, ID opachi e pattern non utili
      if (slug.startsWith('annunci-'))          return;
      if (/^\d+$/.test(slug))                   return;
      if (/^[a-z0-9]{6,7}$/.test(slug) && !/\d{3,}/.test(slug)) return; // ID opachi
      if (slug.startsWith('-'))                 return;
      slugs.add(slug);
    });

    return [...slugs]
      .map(slug => ({ nome: slugToNome(slug), slugMoto: slug }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  } catch (err) {
    console.warn(`  [WARN MI] ${slugMI}: ${err.message}`);
    return [];
  }
}

// ─── 4. Cross-reference mmmv ← → Moto.it ─────────────────────────────────────
function enrichWithMmmv(motoItModels, mmmvMap) {
  return motoItModels.map(m => {
    const nSlug = norm(m.slugMoto);
    const nNome = norm(m.nome);

    const applyMatch = (entry) => ({ ...m, mmmv: entry.mmmv, slugAS: entry.slugAS });

    // 1. Match esatto slug
    if (mmmvMap[nSlug]) return applyMatch(mmmvMap[nSlug]);
    // 2. Match esatto nome display
    if (mmmvMap[nNome]) return applyMatch(mmmvMap[nNome]);

    // 3. Fuzzy: slug Moto.it inizia con chiave AS (variante più lunga dello stesso modello)
    //    Es: "r1250gsadventure" startsWith "r1250gs" → match "R 1250 GS"
    //    Richiede key ≥ 5 char per evitare falsi positivi corti ("cb50" ≠ "cb500f")
    for (const [key, entry] of Object.entries(mmmvMap)) {
      if (key.length < 5) continue;
      if (nSlug.startsWith(key) || nNome.startsWith(key)) return applyMatch(entry);
      if (nSlug.length >= 5 && key.startsWith(nSlug))     return applyMatch(entry);
    }
    return m; // nessun match AS
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const result = { auto: {}, moto: {} };
  let total = 0;

  // ── AUTO ──
  console.log('\n=== AUTO (Autoscout taxonomy) ===');
  for (const brand of BRANDS.auto) {
    process.stdout.write(`  ${brand.nome.padEnd(20)} `);
    const modelli = await fetchModelsAuto(brand.slugAS);
    if (modelli.length > 0) {
      result.auto[brand.nome] = modelli;
      total += modelli.length;
      console.log(`✓ ${modelli.length}`);
    } else {
      console.log('—');
    }
    await sleep(700);
  }

  // ── MOTO ──
  console.log('\n=== MOTO (Moto.it + Autoscout cross-ref) ===');
  for (const brand of BRANDS.moto) {
    process.stdout.write(`  ${brand.nome.padEnd(20)} `);

    // Fetch in parallelo: Moto.it models + Autoscout mmmv map
    const [motoItModels, mmmvMap] = await Promise.all([
      fetchModelsMotoIt(brand.slugMI),
      fetchMmmvMapMoto(brand.slugAS),
    ]);

    if (motoItModels.length === 0) {
      console.log('—');
    } else {
      const enriched = enrichWithMmmv(motoItModels, mmmvMap);
      const withMmmv = enriched.filter(m => m.mmmv).length;
      result.moto[brand.nome] = enriched;
      total += enriched.length;
      console.log(`✓ ${enriched.length} modelli (${withMmmv} con mmmv Autoscout)`);
    }

    await sleep(1000); // due fetch in parallelo → più gentile col server
  }

  const outPath = path.join(__dirname, '../data/models.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n✅ Salvato in data/models.json`);
  console.log(`   Auto: ${Object.keys(result.auto).length} marche, Moto: ${Object.keys(result.moto).length} marche`);
  console.log(`   Totale modelli: ${total}`);
}

main().catch(err => { console.error(err); process.exit(1); });
