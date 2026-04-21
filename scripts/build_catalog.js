/**
 * Ricostruisce data/models.json da zero usando Subito come fonte unica.
 * Copre sia auto che moto.
 * Usa Playwright per bypassare Akamai WAF.
 *
 * Output: data/models.json  { auto: {...}, moto: {...} }
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');

const BROWSER_EXE = path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe');

// ─── Marche auto (nomi esatti come Subito li lista, tutto maiuscolo) ───────────
const AUTO_BRANDS = new Set([
  'ABARTH','ALFA ROMEO','ALPINE','ASTON MARTIN','AUDI','BENTLEY','BMW',
  'BYD','CHEVROLET','CITROEN','CUPRA','DACIA','DS','FERRARI',
  'FIAT','FORD','HONDA','HYUNDAI','INFINITI','JAGUAR','JEEP',
  'KIA','LAMBORGHINI','LANCIA','LAND ROVER','LEXUS','MASERATI','MAZDA',
  'MERCEDES','MG','MINI','MITSUBISHI','NISSAN','OPEL','PEUGEOT',
  'POLESTAR','PORSCHE','RENAULT','ROLLS ROYCE','SEAT','SKODA','SMART',
  'SUBARU','SUZUKI','TESLA','TOYOTA','VOLKSWAGEN','VOLVO',
]);

// ─── Marche moto (nomi esatti come Subito li lista) ───────────────────────────
const MOTO_BRANDS = new Set([
  'Aprilia','Benelli','Beta','BMW','CFMOTO','Ducati','Fantic','Gas Gas',
  'Harley-Davidson','Honda','Husqvarna','Indian','Kawasaki','KTM',
  'Kymco','Moto Guzzi','MV Agusta','Piaggio','Royal Enfield',
  'Sherco','Suzuki','Sym','Triumph','Yamaha','Zero Motorcycles',
]);

// Nome display per auto (Subito usa maiuscolo, noi vogliamo title case)
const AUTO_DISPLAY = {
  'MERCEDES':    'Mercedes-Benz',
  'DS':          'DS Automobiles',
  'ROLLS ROYCE': 'Rolls-Royce',
  'CITROEN':     'Citroën',
  'MG':          'MG',
  'BYD':         'BYD',
  'BMW':         'BMW',
};

function autoDisplayName(value) {
  if (AUTO_DISPLAY[value]) return AUTO_DISPLAY[value];
  return value.split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function toSlug(str) {
  return String(str).toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[àá]/g, 'a').replace(/[èé]/g, 'e')
    .replace(/[ìí]/g, 'i').replace(/[òó]/g, 'o').replace(/[ùú]/g, 'u')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(page, url) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  if (!res || res.status() !== 200) throw new Error(`HTTP ${res?.status()} → ${url}`);
  const text = await page.content();
  const match = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)
              || text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const raw = (match ? match[1] : text)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  return JSON.parse(raw);
}

async function fetchModels(page, baseUrl, brandKey, { delay = 200, labelField = 'group_label', storeKey = false } = {}) {
  await sleep(delay);
  const data = await fetchJson(page, `${baseUrl}/${brandKey}/models`);
  const models = data.values || [];
  const seen = new Set();
  const result = [];
  for (const m of models) {
    const label = m[labelField];
    if (!label || label === 'Altro modello' || label === 'Altro') continue;
    if (seen.has(label)) continue;
    seen.add(label);
    const entry = { nome: label, slugSubito: toSlug(label) };
    if (storeKey) entry.subitoKey = m.key;
    result.push(entry);
  }
  return result;
}

(async () => {
  console.log('Avvio Chrome headless...');
  const browser = await chromium.launch({
    executablePath: BROWSER_EXE,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
    extraHTTPHeaders: { Accept: 'application/json', Origin: 'https://www.subito.it', Referer: 'https://www.subito.it/' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();

  const result = { auto: {}, moto: {} };

  // ── AUTO ────────────────────────────────────────────────────────────────────
  console.log('\n=== AUTO ===');
  const autoBrandsData = await fetchJson(page, 'https://hades.subito.it/v1/values/cars/brands');
  const allAutoBrands  = autoBrandsData.values || autoBrandsData;
  const autoBrands     = allAutoBrands.filter(b => AUTO_BRANDS.has(b.value));
  console.log(`Marche auto: ${autoBrands.length} / ${allAutoBrands.length} totali`);

  for (let i = 0; i < autoBrands.length; i++) {
    const brand = autoBrands[i];
    const nome  = autoDisplayName(brand.value);
    process.stdout.write(`  [${i+1}/${autoBrands.length}] ${nome}... `);
    try {
      const models = await fetchModels(page, 'https://hades.subito.it/v1/values/cars/brands', brand.key);
      result.auto[nome] = models;
      console.log(models.length + ' modelli');
    } catch(e) {
      console.log('ERRORE: ' + e.message);
    }
  }

  // ── MOTO ────────────────────────────────────────────────────────────────────
  console.log('\n=== MOTO ===');
  const motoBrandsData = await fetchJson(page, 'https://hades.subito.it/v1/values/motorbikes/brands');
  const allMotoBrands  = motoBrandsData.values || motoBrandsData;
  const motoBrands     = allMotoBrands.filter(b => MOTO_BRANDS.has(b.value));
  console.log(`Marche moto: ${motoBrands.length} / ${allMotoBrands.length} totali`);

  for (let i = 0; i < motoBrands.length; i++) {
    const brand = motoBrands[i];
    const nome  = brand.value; // Subito moto usa già title case
    process.stdout.write(`  [${i+1}/${motoBrands.length}] ${nome}... `);
    try {
      const models = await fetchModels(page, 'https://hades.subito.it/v1/values/motorbikes/brands', brand.key, { labelField: 'value', storeKey: true });
      result.moto[nome] = { brandKey: brand.key, models };
      console.log(models.length + ' modelli');
    } catch(e) {
      console.log('ERRORE: ' + e.message);
    }
  }

  await browser.close();

  // ── Salva ────────────────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, '../data/models.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  const totAuto = Object.values(result.auto).reduce((a, v) => a + v.length, 0);
  const totMoto = Object.values(result.moto).reduce((a, v) => a + v.models.length, 0);
  console.log(`\n✓ data/models.json salvato`);
  console.log(`  Auto: ${Object.keys(result.auto).length} marche, ${totAuto} modelli`);
  console.log(`  Moto: ${Object.keys(result.moto).length} marche, ${totMoto} modelli`);

  // Verifica spot-check
  console.log('\nFord:', result.auto['Ford']?.map(m => m.nome).join(', '));
  const yamaha = result.moto['Yamaha'];
  console.log('Yamaha brandKey:', yamaha?.brandKey);
  console.log('Yamaha (prime 3):', yamaha?.models.slice(0,3).map(m => m.nome + '[' + m.subitoKey + ']').join(', '));

})().catch(e => { console.error('\nERRORE FATALE:', e.message); process.exit(1); });
