// Headers che simulano un browser Chrome reale navigando verso un sito italiano.
// I campi sec-fetch-* e sec-ch-ua sono fondamentali per superare i controlli anti-bot
// moderni (es. Cloudflare, Subito) che verificano la "firma" del browser.
const HEADERS = {
  'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language':           'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding':           'gzip, deflate, br',
  'Connection':                'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control':             'max-age=0',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
  'Sec-Fetch-User':            '?1',
  'sec-ch-ua':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile':          '?0',
  'sec-ch-ua-platform':        '"Windows"',
  'DNT':                       '1',
};

// "BMW Serie 3" → "bmw-serie-3"
function toSlug(str) {
  return str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// "€ 6.900" → 6900
function parseEuro(str) {
  if (!str) return null;
  const n = parseInt(str.replace(/[€\s.]/g, '').replace(',', ''), 10);
  return isNaN(n) ? null : n;
}

// "148.000 km" → 148000
function parseKm(str) {
  if (!str) return null;
  const n = parseInt(str.replace(/[\s.km]/gi, ''), 10);
  return isNaN(n) ? null : n;
}

// Estrae il JSON da <script id="__NEXT_DATA__">
function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
  if (!match) return null;
  return JSON.parse(match[1]);
}

// parseInt sicuro: restituisce null se NaN o negativo
function toInt(val) {
  const n = parseInt(val, 10);
  return isNaN(n) || n < 0 ? null : n;
}

// ─── Mapping regione slug → params AS24 ──────────────────────────────────────
// AS24 non ha un filtro "regione amministrativa" in senso stretto: il path
// /lst-*/<brand>/<model>/<Region>%20(Italy) è un alias SEO che attiva il
// filtro lat/lon/zipr (raggio geografico dal centro regione). Serve a ridurre
// il set da scansionare; poi zipToRegione() sul CAP fa il post-filter preciso.
//
// lat/lon = centro amministrativo della regione (o capoluogo).
// zipr = raggio in km replicato dall'UI AS24 stessa (es. Emilia-Romagna
// usa zipr=200). Può includere annunci di regioni confinanti: è il
// comportamento nativo di AS24, accettato consapevolmente (meglio un
// margine di confine che tagliare annunci veri nelle zone periferiche).
const REGION_AS24 = {
  'abruzzo':              { label: "Abruzzo",              lat: 42.3548, lon: 13.3999, zipr: 100 },
  'basilicata':           { label: "Basilicata",           lat: 40.6395, lon: 15.8054, zipr: 100 },
  'calabria':             { label: "Calabria",             lat: 38.9098, lon: 16.5877, zipr: 150 },
  'campania':             { label: "Campania",             lat: 40.8518, lon: 14.2681, zipr: 120 },
  'emilia-romagna':       { label: "Emilia-Romagna",       lat: 44.4949, lon: 11.3426, zipr: 150 },
  'friuli-venezia-giulia':{ label: "Friuli-Venezia Giulia",lat: 45.6495, lon: 13.7768, zipr: 100 },
  'lazio':                { label: "Lazio",                lat: 41.9028, lon: 12.4964, zipr: 120 },
  'liguria':              { label: "Liguria",              lat: 44.4056, lon: 8.9463,  zipr: 100 },
  'lombardia':            { label: "Lombardia",            lat: 45.4642, lon: 9.1895,  zipr: 150 },
  'marche':               { label: "Marche",               lat: 43.6158, lon: 13.5189, zipr: 100 },
  'molise':               { label: "Molise",               lat: 41.5611, lon: 14.6679, zipr: 80  },
  'piemonte':             { label: "Piemonte",             lat: 45.0703, lon: 7.6869,  zipr: 150 },
  'puglia':               { label: "Puglia",               lat: 41.1171, lon: 16.8719, zipr: 150 },
  'sardegna':             { label: "Sardegna",             lat: 39.2238, lon: 9.1217,  zipr: 200 },
  'sicilia':              { label: "Sicilia",              lat: 37.5999, lon: 14.0154, zipr: 200 },
  'toscana':              { label: "Toscana",              lat: 43.7696, lon: 11.2558, zipr: 120 },
  'trentino-alto-adige':  { label: "Trentino-Alto Adige",  lat: 46.0667, lon: 11.1167, zipr: 100 },
  'umbria':               { label: "Umbria",               lat: 43.1107, lon: 12.3908, zipr: 80  },
  'valle-d-aosta':        { label: "Valle d'Aosta",        lat: 45.7369, lon: 7.3208,  zipr: 80  },
  'veneto':               { label: "Veneto",               lat: 45.4408, lon: 12.3155, zipr: 120 },
};

// ─── Risoluzione eseguibile Chromium cross-platform ──────────────────────────
// Playwright scarica Chromium in pw-browsers/chromium-<rev>/<arch-specific>/.
// Il path dell'eseguibile cambia per OS/arch:
//   - Windows x64:          chrome-win64/chrome.exe
//   - macOS Intel (x64):     chrome-mac/Chromium.app/Contents/MacOS/Chromium
//   - macOS Apple Silicon:   chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium
//   - Linux x64:             chrome-linux/chrome
//
// Strategia: cerchiamo la directory pw-browsers/chromium-*/  (qualunque rev)
// e appendiamo il segmento giusto per la piattaforma corrente.
// In un bundle Electron il browser è in resources/pw-browsers/.
function resolveChromiumExecutable(pwBrowsersRoot) {
  const fs   = require('fs');
  const path = require('path');

  if (!fs.existsSync(pwBrowsersRoot)) {
    throw new Error(`pw-browsers non trovato: ${pwBrowsersRoot}`);
  }

  // Trova la directory chromium-<rev> (la prima che vediamo va bene, di
  // solito ce n'è solo una)
  const chromiumDir = fs.readdirSync(pwBrowsersRoot)
    .find(name => /^chromium-\d+$/.test(name));
  if (!chromiumDir) {
    throw new Error(`Nessuna cartella chromium-<rev> in ${pwBrowsersRoot}`);
  }
  const base = path.join(pwBrowsersRoot, chromiumDir);

  const os   = process.platform;
  const arch = process.arch;

  if (os === 'win32') {
    return path.join(base, 'chrome-win64', 'chrome.exe');
  }
  if (os === 'darwin') {
    const dir = arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac';
    return path.join(base, dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
  }
  if (os === 'linux') {
    return path.join(base, 'chrome-linux', 'chrome');
  }
  throw new Error(`Piattaforma non supportata: ${os}/${arch}`);
}

module.exports = {
  HEADERS, toSlug, parseEuro, parseKm, extractNextData, toInt, REGION_AS24,
  resolveChromiumExecutable,
};
