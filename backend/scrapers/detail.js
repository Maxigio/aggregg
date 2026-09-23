/**
 * Arricchimento ON-CLICK: fetch della pagina-dettaglio annuncio → spec extra
 * (cambio, potenza CV, cilindrata, proprietari, allestimento). Best-effort:
 * campi null se assenti/non estraibili.
 *
 * Sicurezza (anti-SSRF): solo https + hostname in ALLOWED, ri-validato DOPO ogni
 * redirect (il fetch ne segue ≤5). Un link malevolo in un annuncio non può far
 * fetchare risorse interne.
 *
 * Cache per-URL (TTL 12h) con cap LRU + dedup richieste in-flight.
 */
const https = require('https');
const salute = require('../fonti-salute');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ALLOWED = new Set([
  'www.subito.it', 'subito.it',
  'www.autoscout24.it', 'autoscout24.it',
  'www.moto.it', 'moto.it',
]);
const TTL_MS    = 12 * 60 * 60 * 1000;
// La vita breve per il risultato SOSPETTO: era l'unica cache del repo senza. Stesso valore
// che usano motornet e autoit-rilevamenti, e stesso motivo di `ttlCorto` in cache-disco.
const VUOTO_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE = 500;
const cache    = new Map();   // url → { ts, data }
const inflight = new Map();   // url → Promise

function hostOk(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && ALLOWED.has(x.hostname); }
  catch (_) { return false; }
}

// Fetch con cap redirect + ri-validazione hostname AD OGNI hop (anti-SSRF).
async function fetchText(url, hops = 0) {
  if (hops > 5) throw new Error('too many redirects');
  if (!hostOk(url)) throw new Error('host not allowed');
  const fonte = fonteFromUrl(url);
  return salute.richiesta(fonte, () => new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9' } }, res => {
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('risposta interrotta')));
      res.on('close', () => { if (!res.complete) reject(new Error('risposta incompleta')); });
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchText(next, hops + 1).then(resolve, reject);   // hostOk ri-controllato nel prossimo giro
      }
      if (res.statusCode !== 200) {
        const errore = salute.erroreHttp(fonte, res.statusCode, res.headers);
        res.resume();
        return reject(errore);
      }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
  }));
}

const EMPTY = { cambio: null, potenzaCv: null, cilindrata: null, proprietari: null, allestimento: null, revisione: null };
const stripTags = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const toInt = s => { if (s == null) return null; const n = parseInt(String(s).replace(/[.\s]/g, ''), 10); return isNaN(n) ? null : n; };

// ─── Autoscout24: __NEXT_DATA__ ricco (rawPowerInHp, rawDisplacementInCCM, …) ──
function parseAutoscout(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  const json = m ? m[1] : html;
  const num = re => { const x = json.match(re); return x ? parseInt(x[1], 10) : null; };
  let cambio = null;
  const g = json.match(/"transmissionType"\s*:\s*\{[^}]*"formatted"\s*:\s*"([^"]+)"/)
         || json.match(/"transmissionType"\s*:\s*"([^"]+)"/)
         || json.match(/"gearbox"\s*:\s*"([^"]+)"/);
  if (g) cambio = g[1];
  return {
    cambio,
    potenzaCv:   num(/"rawPowerInHp"\s*:\s*(\d+)/),
    cilindrata:  num(/"rawDisplacementInCCM"\s*:\s*(\d+)/),
    proprietari: num(/"noOfPreviousOwners"\s*:\s*(\d+)/),
    allestimento: null,
    revisione:   null,
  };
}

// Foto annuncio Moto.it dalla pagina-dettaglio. Le foto-annuncio hanno filename
// `image.jpg` OPPURE numerico-trattino (es. `010407553-7559-332.jpg`, tipico degli
// annunci dealer/premium — spesso quelli col video); le immagini editoriali/chrome
// hanno slug alfabetici (`ducati-logo`, `v4-hp`, `me1-6415`) o path `SQUARE/` →
// escluse. Cover da og:image (sempre la copertina), poi la galleria. Dedup per <id>,
// cap 10. Hotlink verificato (no-referer → 200); `?format=webp&width=N` = thumb leggera.
function motoitImages(html) {
  const out = []; const seen = new Set();
  const push = (id, base) => {
    if (seen.has(id) || out.length >= 10) return;
    seen.add(id);
    out.push({ thumb: `${base}?format=webp&width=300`, full: `${base}?format=webp&width=1200` });
  };
  // Cover: og:image è SEMPRE la copertina dell'annuncio, qualunque sia il filename.
  const og = html.match(/og:image"\s*content="(https:\/\/cdn-img\.moto\.it\/images\/(\d+)\/[^"?]+\.(?:jpe?g|webp))/i);
  if (og) push(og[2], og[1]);   // base senza query (il match si ferma prima di "?")
  // Galleria: tieni SOLO le foto-annuncio (filename `image` o numerico-trattino),
  // scartando gli slug editoriali e i crop `SQUARE/`.
  const re = /https:\/\/cdn-img\.moto\.it\/images\/(\d+)\/([^"'\\ )?]+?)\.(?:jpe?g|webp)/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    const path = m[2];
    if (/(?:^|\/)SQUARE(?:\/|$)/i.test(path)) continue;     // crop editoriali
    const fname = path.split('/').pop();
    if (!/^(?:image|[\d-]+)$/i.test(fname)) continue;       // scarta slug editoriali
    push(m[1], m[0]);   // m[0] = URL fino all'estensione (niente query)
  }
  return out;
}

// Le entita' HTML che compaiono davvero in queste pagine. Senza, "dell&#039;acquirente"
// finisce a schermo com'e' scritto. Le accentate ci sono perche' un "Sì" scritto
// `S&igrave;` non verrebbe riconosciuto come un sì, e la bandierina risulterebbe assente
// invece che vera — cioe' il tipo di errore che non fa rumore.
const ENTITA = [[/&#0?39;|&apos;/g, "'"], [/&quot;/g, '"'], [/&nbsp;/g, ' '],
  [/&lt;/g, '<'], [/&gt;/g, '>'], [/&agrave;/g, 'à'], [/&egrave;/g, 'è'], [/&eacute;/g, 'é'],
  [/&igrave;/g, 'ì'], [/&ograve;/g, 'ò'], [/&ugrave;/g, 'ù'], [/&amp;/g, '&']];
const deEntStr = s => ENTITA.reduce((acc, [re, ch]) => acc.replace(re, ch), String(s == null ? '' : s));
const deEnt = s => (s == null ? null : (deEntStr(s).trim() || null));

const MESI_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

// ─── Moto.it: scheda testuale (tag-strip + label→valore) + foto ───────────────
/**
 * QUELLO CHE LA PAGINA DICE E NON LEGGEVAMO. Stessa richiesta di prima: e' la
 * pagina-annuncio che l'app scarica gia' quando si apre il pannello di un annuncio
 * Moto.it. Prendevamo quattro campi su una dozzina.
 *
 * DUE COSE VALGONO PIU' DELLE ALTRE:
 *  - la DATA DI INSERIMENTO. Su Moto.it `posted_at` era null, quindi per un annuncio
 *    Moto.it non si poteva dire da quanto e' in vendita. La pagina la scrive per esteso
 *    ("inserito il 15 luglio 2026 ore 00:10").
 *  - il "tipo offerta": dice CHI PAGA il passaggio di proprieta'. E' una voce da
 *    centinaia di euro che cambia il prezzo vero e non sta in nessun altro campo.
 *
 * Le bandierine (incidentata, depotenziata, uso pista, ABS…) si cercano SOLO dentro il
 * blocco della scheda: "Abs" da solo compare anche nella scheda tecnica del modello piu'
 * in basso, e la' vorrebbe dire un'altra cosa.
 *
 * NON si prende il "Referente: <nome>": e' il nome di una persona, non serve a niente qui.
 */
function parseMotoit(html) {
  const t = stripTags(html);
  const grab = re => { const x = t.match(re); return x ? x[1] : null; };

  const i = t.indexOf('Tipo offerta');
  const blocco = i >= 0 ? deEntStr(t.slice(i, i + 600)) : '';
  // `\b` dopo "Sì" NON funziona: `ì` non e' un carattere-parola per le regex, quindi fra
  // "ì" e lo spazio non c'e' confine di parola e il match fallisce. Su una pagina con
  // "Sì" la bandierina risultava assente invece che vera. Qui si chiede invece che dopo
  // non ci sia un'altra lettera, che e' quello che si voleva dire.
  const flag = et => { const m = blocco.match(new RegExp(et + '\\s+(S[iì]|No)(?![\\p{L}\\d])', 'iu')); return m ? /^s/i.test(m[1]) : null; };
  const campo = (et, fine) => deEnt((blocco.match(new RegExp(et + '\\s+(.{3,80}?)\\s+(?:' + fine + ')', 'i')) || [])[1]);

  // "15 luglio 2026 ore 00:10" → ISO. Il mese e' una parola italiana, non un numero.
  const ins = t.match(/Annuncio nr\.\s*(\d+)\s+inserito il\s+(\d{1,2})\s+(\p{L}+)\s+(\d{4})(?:\s+ore\s+(\d{1,2})[:.](\d{2}))?/iu);
  let inserito = null;
  if (ins) {
    const mIdx = MESI_IT.indexOf(String(ins[3]).toLowerCase());
    if (mIdx >= 0) {
      const p2 = n => String(n).padStart(2, '0');
      inserito = `${ins[4]}-${p2(mIdx + 1)}-${p2(ins[2])}T${p2(ins[5] || 0)}:${p2(ins[6] || 0)}:00`;
    }
  }

  const sel = html.match(/class="mseller-name"[\s\S]{0,300}?href="(https:\/\/dealer\.moto\.it\/[^"]+)"[^>]*>\s*([^<]{2,60}?)\s*</i);

  return {
    // UNA parola, non "fino a venti caratteri con spazi": quella regex leggeva
    // "automatico Y" perche' dopo il valore comincia il nome della marca.
    cambio:       grab(/Cambio\s+([A-Za-zàèéìòù]{3,20})/i),
    potenzaCv:    toInt(grab(/Potenza\s+([\d.,]+)\s*(?:cv|hp)/i)),
    cilindrata:   toInt(grab(/Cilindrata\s+([\d.]+)\s*c\.?\s*c/i)),
    proprietari:  toInt(grab(/Proprietari precedenti\s+(\d+)/i)),
    allestimento: null,
    revisione:    null,
    immagini:     motoitImages(html),

    tipoOfferta:  campo('Tipo offerta', 'Garanzia|Incidentata|Depotenziata|Solo uso'),
    garanzia:     campo('Garanzia', 'Incidentata|Depotenziata|Solo uso'),
    incidentata:  flag('Incidentata'),
    depotenziata: flag('Depotenziata'),
    usoPista:     flag('Solo uso pista'),
    abs:          flag('Abs'),
    special:      flag('Special'),
    elettrica:    flag('Elettrica'),

    posted_at:    inserito,
    numeroAnnuncio: ins ? ins[1] : null,
    comune:       deEnt(grab(/Luogo\s+([A-Za-zÀ-ÿ' ]{2,40}\([A-Z]{2}\))/)),

    // Il venditore con il link alla sua VETRINA: e' l'aggancio che mancava per mettere
    // Moto.it fra le fonti della sezione Competitor (l'API di ricerca non filtra per
    // venditore, la pagina-annuncio invece dice qual e').
    venditoreNome: sel ? deEnt(sel[2]) : null,
    vetrinaUrl:    sel ? sel[1] : null,
    venditoreAnnunciPubblicati: toInt(grab(/Annunci pubblicati\s+([\d.]+)/i)),
    venditoreAnnunciOnline:     toInt(grab(/Annunci online\s+([\d.]+)/i)),
    venditoreDal:               toInt(grab(/Utente di Moto\.it dal\s+(\d{4})/i)),
  };
}

// ─── Subito: best-effort __NEXT_DATA__ features (spesso DataDome blocca → EMPTY)
function parseSubito(html) {
  try {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return { ...EMPTY };
    const j = JSON.parse(m[1]);
    const f = {};
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o.features)) for (const ft of o.features) {
        if (ft && ft.uri) f[ft.uri] = ft.values?.[0]?.value ?? ft.values?.[0]?.key ?? null;
      }
      for (const k in o) walk(o[k]);
    };
    walk(j);
    return {
      cambio:       f['/gearbox'] || null,
      potenzaCv:    toInt(f['/horse_power'] || f['/power']),
      cilindrata:   toInt(f['/engine_displacement'] || f['/cubic_capacity']),
      proprietari:  null,
      allestimento: f['/version'] || null,
      revisione:    null,
    };
  } catch (_) { return { ...EMPTY }; }
}

const PARSERS = { autoscout: parseAutoscout, moto: parseMotoit, subito: parseSubito };
function fonteFromUrl(u) {
  try {
    const h = new URL(u).hostname;
    if (/(^|\.)autoscout24\.it$/i.test(h)) return 'autoscout';
    if (/(^|\.)moto\.it$/i.test(h))       return 'moto';
    if (/(^|\.)subito\.it$/i.test(h))     return 'subito';
  } catch (_) {}
  return null;
}

// Il parser ha riconosciuto QUALCOSA? Un oggetto con tutti i campi nulli e le liste vuote
// significa che la pagina non si e' lasciata leggere: non che l'annuncio non dichiari niente.
const senzaNiente = d => !d || !Object.values(d).some(v => v != null && !(Array.isArray(v) && !v.length));

/** Spec extra per un annuncio, o null se host non valido/parser assente. */
async function getDetail(url) {
  if (!hostOk(url)) throw new Error('host not allowed');
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < (hit.ttl || TTL_MS)) { cache.delete(url); cache.set(url, hit); return hit.data; }  // LRU touch
  if (inflight.has(url)) return inflight.get(url);

  const p = salute.richiesta(fonteFromUrl(url), async () => {
    const parser = PARSERS[fonteFromUrl(url)];
    if (!parser) return null;
    const html = await fetchText(url);
    const data = parser(html) || { ...EMPTY };
    /**
     * UNA PAGINA CHE NON DICE NIENTE NON E' UN ANNUNCIO SENZA DATI.
     *
     * I parser non lanciano mai: se il blocco "Tipo offerta" non c'e' — pagina di
     * transizione, manutenzione, o il giorno in cui la fonte cambia impaginazione — tornano
     * l'oggetto con tutti i campi a null, e nessuno guardava dentro. Quel vuoto finiva in
     * cache per DODICI ORE, con il client che scriveva `_enriched = true`: da li' in poi,
     * per mezza giornata, quell'annuncio risultava "gia' arricchito, non ha altro da dire".
     * Ora il vuoto vale poco e si riprova presto, come fanno tutte le altre cache del repo.
     */
    const nulla = senzaNiente(data);
    if (nulla && salute.fermo(fonteFromUrl(url)).verifica) {
      // Il vuoto best-effort resta lecito fuori dalla verifica. Durante la
      // ripartenza non dimostra che la fonte sia di nuovo leggibile.
      throw Object.assign(new Error('Verifica della fonte non riuscita: nessun dato del dettaglio riconosciuto. La fonte resta in pausa.'),
        { code: 'FONTE_IN_PAUSA', fonte: fonteFromUrl(url), kind: 'error' });
    }
    cache.set(url, { ts: Date.now(), data, ttl: nulla ? VUOTO_TTL_MS : TTL_MS });
    if (nulla) console.warn(`[detail] ${String(url).slice(0, 70)}: pagina letta ma nessun campo riconosciuto (markup cambiato?) — cache breve`);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);  // evict oldest
    return data;
  }).catch(e => {
    console.warn(`[detail] ${String(url).slice(0, 70)}: ${e.message}`);
    if (e.status === 429 || e.code === 'FONTE_IN_PAUSA') throw e;
    return null;   // best-effort: la UI mostra "dettagli non disponibili"
  }).finally(() => { inflight.delete(url); });
  inflight.set(url, p);
  return p;
}

module.exports = { getDetail, fonteFromUrl, _hostOk: hostOk, _motoitImages: motoitImages, _parseMotoit: parseMotoit, _senzaNiente: senzaNiente, _VUOTO_TTL_MS: VUOTO_TTL_MS };
