/**
 * Catalogo modelli/versioni Moto.it dall'**API JSON autorevole** (`api-50`).
 *
 * F43: il sito stesso usa queste API per popolare i menu Marca→Modello→Versione.
 *  - `GET /api-50/market/search/models/<brand>/Used`
 *      → { result:"OK", data:[ { value:"<brand>|<modelSlug>", text:"Modello" } ] }
 *      `value` = ESATTAMENTE il param `model=` del search.
 *  - `GET /api-50/market/search/bikes/<brand>|<model>/Used`
 *      → data:[ { value:"<codice 6char opaco>", text:"Versione (anni) - sigla" } ]
 *      `value` = ESATTAMENTE il param `bike=` (versione/allestimento).
 *
 * Niente più scrape HTML né slug indovinati: si usano i `value` reali dell'API.
 * Cache in-memory 12h per chiave + dedup richieste concorrenti.
 */
const https = require('https');
const { makeModelResolver, confiniDi } = require('./brand-match');
const budget = require('../budget-richieste');        // conta le richieste, non le limita

const BASE = 'https://www.moto.it';
const API  = `${BASE}/api-50/market/search`;
const TTL_MS = 12 * 60 * 60 * 1000;  // 12h

const modelsCache = new Map();   // brandSlug → { ts, models:[{name,slug}] }
const bikesCache  = new Map();   // `${brand}|${model}` → { ts, bikes:[{name,code}] }
const inflight    = new Map();   // chiave → Promise (dedup concorrenti)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// GET JSON con segui-redirect. L'API risponde a GET (verificato) — niente cookie.
function fetchJson(url, hops = 0) {
  // Questi menu hanno cache 12h: quando si contano, e' perche' la cache era fredda.
  budget.conta('motoit', hops ? 'redirect' : 'menu cache-miss');
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'it-IT,it;q=0.9' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : BASE + res.headers.location;
        return fetchJson(next, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('JSON non valido: ' + e.message)); } });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
  });
}

// Cache+dedup generico.
function cached(store, key, ttl, producer) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.ts < ttl) return Promise.resolve(hit.value);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await producer();
      store.set(key, { ts: Date.now(), value });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * IL CATALOGO CHE ABBIAMO SU DISCO, non quello che e' in vendita oggi.
 *
 * `/models/<marca>/Used` e `/bikes/<marca>|<modello>/Used` sono la VISTA MERCATO: danno
 * solo cio' che ha annunci usati adesso. Misurato: Yamaha 163 modelli contro i 231 del
 * catalogo (+42%), Honda 199 contro 284 (+43%), Ducati 121 contro 153 (+26%).
 * `data/motoit-catalogo.json` viene dalle pagine /listino, che sono la lista intera.
 *
 * Gli id sono gli STESSI: verificato che i codici-versione del catalogo coincidono con
 * quelli che l'API mette in `bike=` (MT-07 9 su 9, Monster 821 5 su 5). Se non fosse
 * cosi', il filtro versione smetterebbe di funzionare in silenzio.
 *
 * L'API resta come RIPIEGO per le marche che il catalogo non ha. E dove risponde il
 * catalogo non parte nessuna richiesta: il costo scende.
 */
/**
 * I nomi del catalogo portano entita' HTML DOPPIE — 33 modelli e 128 versioni:
 * `Caff&amp;egrave;nero 125`, `Monster 1200 25&amp;deg; Anniversario`, `C1 125
 * Family&amp;#039;s Friend`. Finora non si vedevano perche' i menu venivano dall'API;
 * passando al catalogo finirebbero a schermo cosi' come sono. Doppie: `&amp;egrave;`
 * diventa `&egrave;` e poi `è`, quindi si decodifica finche' smette di cambiare.
 * Il catalogo NON si tocca: si decodifica in lettura.
 */
const ENT_NOMI = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°',
  laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  euro: '€', pound: '£', reg: '®', copy: '©', trade: '™', middot: '·',
  szlig: 'ß', aelig: 'æ', oslash: 'ø', aring: 'å', ccedil: 'ç', ntilde: 'ñ',
};
const ENT_SEGNI = { grave: '̀', acute: '́', circ: '̂', tilde: '̃', uml: '̈', ring: '̊', cedil: '̧' };
function passataEntita(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (tutto, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : tutto;
    }
    const k = e.toLowerCase();
    if (ENT_NOMI[k]) return ENT_NOMI[k];
    const m = /^([a-z])(grave|acute|circ|tilde|uml|ring|cedil)$/.exec(k);
    if (m) return (e[0] === e[0].toUpperCase() ? m[1].toUpperCase() : m[1]) + ENT_SEGNI[m[2]];
    return tutto;
  });
}
function decodifica(s) {
  let a = String(s == null ? '' : s), b = passataEntita(a), giri = 0;
  while (b !== a && giri++ < 4) { a = b; b = passataEntita(a); }
  return b.normalize('NFC');
}

let CAT = null;
function catalogo() {
  if (CAT) return CAT;
  try { CAT = require('../../data/motoit-catalogo.json'); }
  catch (e) { console.warn('[motoit-models] catalogo assente (' + e.message + ') → si resta sull\'API'); CAT = { marche: {} }; }
  return CAT;
}
const marcaCat = slug => (catalogo().marche || {})[String(slug || '').toLowerCase()] || null;

/**
 * Modelli (famiglie) di una marca: [{name, slug}]. `slug` = parte dopo `<brand>|`.
 * `opts.rilancia` — lo specchio esatto di getModelBikes: chi deve DISTINGUERE «questa
 * marca non ha modelli» da «non sono riuscito a chiederlo» lo passa, e il KO gli arriva
 * come errore invece che come elenco vuoto. Senza, la scheda diceva «il catalogo non ha
 * questo modello» anche su un timeout.
 */
async function getBrandModels(brandSlug, opts = {}) {
  if (!brandSlug) return [];
  const locale = marcaCat(brandSlug);
  if (locale && Object.keys(locale.modelli || {}).length) {
    return Object.entries(locale.modelli)
      .map(([slug, m]) => ({ name: decodifica(m.nome).trim(), slug }))
      .filter(x => x.name && x.slug);
  }
  const p = cached(modelsCache, `m:${brandSlug}`, TTL_MS, async () => {
    try {
      const j = await fetchJson(`${API}/models/${encodeURIComponent(brandSlug)}/Used`);
      const data = (j && j.result === 'OK' && Array.isArray(j.data)) ? j.data : [];
      return data
        .map(d => {
          const value = String(d.value || '');
          const i = value.indexOf('|');
          const slug = i >= 0 ? value.slice(i + 1) : '';
          return slug ? { name: String(d.text || '').trim(), slug } : null;
        })
        .filter(Boolean);
    } catch (e) {
      // L'errore SALE, cosi' `cached` non lo mette in memoria: una lista vuota restituita qui
      // ci sarebbe rimasta dodici ore, e un timeout sarebbe diventato "questa marca non ha
      // modelli" fino a domani. Chi chiama continua a vedere una lista vuota (`.catch` sotto):
      // cambia solo che al prossimo tentativo si riprova davvero.
      console.warn(`[motoit-models] models ${brandSlug}: ${e.message}`);
      throw e;
    }
  });
  return opts.rilancia ? p : p.catch(() => []);
}

/**
 * Versioni di un modello: [{name, code}]. `code` (opaco) = il param `bike=`.
 *
 * `opts.rilancia` serve a chi deve DISTINGUERE "questo modello non ha versioni a catalogo"
 * da "non sono riuscito a chiederlo". Senza, le due cose arrivano nella stessa forma — un
 * elenco vuoto — e a valle un timeout diventava "la versione che hai scritto non esiste".
 */
async function getModelBikes(brandSlug, modelSlug, opts = {}) {
  if (!brandSlug || !modelSlug) return [];
  // Dal catalogo, se quel modello ce l'ha con le versioni dentro. Gli anni non si
  // ricavano piu' dal nome a forza di espressioni regolari: il catalogo li ha gia'.
  const mod = (marcaCat(brandSlug) || { modelli: {} }).modelli[String(modelSlug).toLowerCase()];
  if (mod && Object.keys(mod.versioni || {}).length) {
    return Object.entries(mod.versioni).map(([code, v]) => ({
      name: decodifica(v.nome).trim(),
      code,
      annoMin: (v.anni && v.anni.da) || null,
      annoMax: (v.anni && v.anni.a) || null,
    })).filter(x => x.name);
  }
  const key = `b:${brandSlug}|${modelSlug}`;
  const p = cached(bikesCache, key, TTL_MS, async () => {
    try {
      const j = await fetchJson(`${API}/bikes/${encodeURIComponent(`${brandSlug}|${modelSlug}`)}/Used`);
      const data = (j && j.result === 'OK' && Array.isArray(j.data)) ? j.data : [];
      return data
        .map(d => { if (!d.value) return null; const name = String(d.text || '').trim(); return { name, code: String(d.value), ...parseYears(name) }; })
        .filter(Boolean);
    } catch (e) {
      // Stesso motivo di `models`: un errore di rete non e' un catalogo vuoto da tenere
      // in memoria mezza giornata. Sale per non finire in cache, e si spegne qui.
      console.warn(`[motoit-models] bikes ${brandSlug}|${modelSlug}: ${e.message}`);
      throw e;
    }
  });
  return opts.rilancia ? p : p.catch(() => []);
}

/**
 * Risolve lo slug-modello dal testo. Puo' tornare PIU' SLUG separati da virgola.
 *
 * I tre cataloghi tagliano lo stesso mezzo a livelli diversi: la "Aprilia Scarabeo 500" su
 * Moto.it e' un MODELLO a se', su Autoscout e' modello "Scarabeo" + versione "500", su Subito
 * non esiste. Chi scrive il nome largo ("Scarabeo") su Moto.it aggancia nove famiglie, e prima
 * se ne teneva UNA — la piu' corta, cioe' `scarabeo-50`: il concessionario cercava i 500 e la
 * colonna Moto.it gli mostrava gli scooter 50, senza che niente lo dicesse.
 *
 * Non serve ne' scegliere ne' rinunciare: MISURATO sul sito, `model=` accetta una lista
 * separata da virgola e la tratta in OR — `scarabeo-50` 29 annunci, `scarabeo-125` 4,
 * `scarabeo-500` 8, le tre insieme 41. Regge anche le 284 famiglie Honda in una sola URL
 * (5.334 caratteri, HTTP 200) e il filtro resta applicato: le prime 120 danno 3.410 annunci,
 * le restanti 164 ne danno 1.834, e 3.410 + 1.834 = 5.244 = il totale della marca.
 *
 * Il nome preciso continua a vincere da solo: "Scarabeo 500" e' un match esatto, una famiglia.
 * null = brand-only.
 */
async function famiglieMotoit(brandSlug, modelloText) {
  if (!brandSlug || !modelloText) return null;
  const models = await getBrandModels(brandSlug);
  if (!models.length) return null;
  const nomi = models.map(m => ({ name: m.name, value: m.slug }));
  const q = normN(modelloText);
  // Esatto: una sola famiglia, ed e' quella.
  const esatto = nomi.find(m => normN(m.name) === q);
  if (esatto) return esatto.value;
  // Altrimenti TUTTE le famiglie che iniziano col nome cercato, senza spezzare una cifra
  // ("Scarabeo" prende Scarabeo 50/125/500, "R 1200" non prende R 12000).
  const figlie = nomi.filter(m => q.length >= 3 && normN(m.name).startsWith(q)
    && !/\d/.test(normN(m.name).charAt(q.length) || ''));
  if (figlie.length) return figlie.map(m => m.value).join(',');
  /**
   * ULTIMA SPIAGGIA, MA CON LA STESSA GUARDIA DI SOPRA.
   *
   * Il resolver fuzzy una risposta la da' sempre, e normalizza togliendo OGNI separatore:
   * "CRF 1100" diventa "crf1100", la famiglia "CRF 110" diventa "crf110", il prefisso
   * combacia e la ricerca partiva su `model=honda|crf-110` — minimoto da 110 cc, con ogni
   * riga marcata "versione n.d.", cioe' "il modello e' quello giusto". Il ramo `figlie` qui
   * sopra quella guardia ce l'ha da sempre ("R 1200" non prende R 12000): mancava solo qui.
   *
   * Se dopo la guardia non resta niente si torna null, cioe' si cerca a livello marca — e
   * quel livello il chiamante lo dichiara gia' come 'senza-modello'.
   */
  const resolver = makeModelResolver(nomi);
  const scelto = resolver(modelloText) || null;
  if (!scelto) return null;
  const nome = (nomi.find(m => m.value === scelto) || {}).name || '';
  const nq = normN(nome), qq = q;
  const confineDentroUnNumero = (a, b) => {
    const corto = a.length <= b.length ? a : b, lungo = a.length <= b.length ? b : a;
    if (!corto || !lungo.startsWith(corto)) return false;
    // Il carattere DOPO il prefisso e' una cifra, e anche l'ultimo del prefisso lo e':
    // il taglio cade in mezzo a un numero ("crf110" contro "crf1100").
    return /\d/.test(lungo.charAt(corto.length)) && /\d/.test(corto.charAt(corto.length - 1));
  };
  // Il taglio su un CONFINE DI TOKEN del nome lungo e' una parentela legittima (la regola
  // di brand-match/82e4d15): 'MP3 500' → famiglia 'MP3' e' il padre giusto, e questa
  // guardia — piu' severa della regola — buttava 57 famiglie vere (le 10 MP3, Tuono V4
  // 1100, R 60/5), mandando la ricerca a livello marca: finestra dei piu' economici della
  // marca, e gli MP3 fuori. 'CRF 1100' → 'crf110' resta bloccato: il taglio non cade sul
  // confine crf|1100.
  const nqS = nq.replace(/ /g, ''), qqS = qq.replace(/ /g, '');
  const [corto, lungoRaw] = nqS.length <= qqS.length ? [nqS, modelloText] : [qqS, nome];
  if (confineDentroUnNumero(nqS, qqS) && !confiniDi(lungoRaw).has(corto)) {
    console.warn(`[motoit-models] "${modelloText}" → "${nome}" scartato: il confronto spezza un numero`);
    return null;
  }
  return scelto;
}

/**
 * UNO slug solo — la vecchia risoluzione, invariata.
 * La usa il crawler, che archivia sotto UN nome-modello: dargli una famiglia allargata
 * cambierebbe cosa finisce in `listings`, e quel lato non e' in discussione adesso.
 */
async function resolveMotoitModelSlug(brandSlug, modelloText) {
  if (!brandSlug || !modelloText) return null;
  const models = await getBrandModels(brandSlug);
  if (!models.length) return null;
  const resolver = makeModelResolver(models.map(m => ({ name: m.name, value: m.slug })));
  return resolver(modelloText) || null;
}

// ─── Lazy-T2: risoluzione voce-versione catalogo → famiglia Moto.it + versioni ──
// Es. "Dyna Fat Bob" (catalogo AS24, senza slug Moto.it) → famiglia "Dyna" + le bike
// "Fat Bob (anni)". Deterministico: la famiglia è la sequenza INIZIALE del nome-voce
// (la più lunga che combacia); il match è sul nome COSTRUITO "famiglia + versione",
// così "Sport Glide" non becca per errore la famiglia "Sport" (Sport non ha quel bike).
const normN = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// "Fat Bob (2014-17)" → "Fat Bob"; "1200 Iron (2018-20) - XL1200N" → "1200 Iron".
function versionBase(bikeName) {
  return String(bikeName || '').replace(/\([^)]*\)/g, ' ').replace(/\s*-\s*[A-Za-z0-9]+\s*$/, ' ').replace(/\s+/g, ' ').trim();
}
// "(2014 - 17)"/"(2008-13)"/"(2019)" → {annoMin, annoMax}.
function parseYears(bikeName) {
  const r = String(bikeName || '').match(/\((\d{4})\s*-\s*(\d{2,4})\)/);
  if (r) { const a = +r[1]; let b = +r[2]; if (b < 100) { b = Math.floor(a / 100) * 100 + b; if (b < a) b += 100; } return { annoMin: a, annoMax: b }; }   // "(1998-02)"→2002, "(2008-12)"→2012
  const s = String(bikeName || '').match(/\((\d{4})\)/);
  return s ? { annoMin: +s[1], annoMax: +s[1] } : { annoMin: null, annoMax: null };
}

/** "Dyna Fat Bob" → { familySlug:'dyna', familyName:'Dyna', versions:[{nome,code,annoMin,annoMax}] } | null. */
async function resolveMotoitVersionEntry(brandSlug, entryName) {
  if (!brandSlug || !entryName) return null;
  const families = await getBrandModels(brandSlug);
  const target = normN(entryName);
  // Confine famiglia: spazio ("Dyna Fat Bob") O lettera incollata ("V-Strom 1050SE" = 1050+se),
  // MAI una cifra (no falso "105"→"1050"). `target === nf` PRIMA: su esatto `next` è undefined.
  const cands = families
    .filter(f => {
      const nf = normN(f.name);
      if (!nf) return false;
      if (target === nf) return true;
      if (!target.startsWith(nf)) return false;
      const next = target[nf.length];
      return next === ' ' || /[a-z]/.test(next || '');
    })
    .sort((a, b) => normN(b.name).length - normN(a.name).length);
  for (const fam of cands) {
    const bikes = await getModelBikes(brandSlug, fam.slug);
    const toV = bk => ({ nome: bk.name, code: bk.code, annoMin: bk.annoMin, annoMax: bk.annoMax });
    const versionPart = target.slice(normN(fam.name).length).trim();   // "dyna fat bob" − "dyna" = "fat bob"
    // Voce = famiglia esatta (famiglia Moto.it senza slug nel catalogo) → tutte le sue bike.
    if (!versionPart) {
      if (bikes.length) return { familySlug: fam.slug, familyName: fam.name, versions: bikes.map(toV) };
      continue;
    }
    const versions = [];
    for (const bk of bikes) {
      const base = normN(versionBase(bk.name));
      // forma Harley: bike = sola versione ("1584 Fat Bob"→"fat bob"); forma Suzuki: bike RIPETE la
      // famiglia ("V-Strom 1050SE")→ match sul nome-voce intero (`base === target`).
      const bv = base.replace(/^\d{2,4}\s+/, '');
      if (bv === versionPart || base === target) versions.push(toV(bk));
    }
    if (versions.length) return { familySlug: fam.slug, familyName: fam.name, versions };
  }
  return null;
}

// versionBase e parseYears sono pure e contengono le regole piu' delicate del confine
// famiglia/versione: esposte per poterle sorvegliare con dei test (prefisso _ = interne).
module.exports = { resolveMotoitModelSlug, famiglieMotoit, getBrandModels, getModelBikes, resolveMotoitVersionEntry,
  decodifica,
  _versionBase: versionBase, _parseYears: parseYears };
