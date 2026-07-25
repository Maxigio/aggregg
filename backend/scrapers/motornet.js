'use strict';
/**
 * Scraper Motornet (Eurotax Italia — Sanguinetti Editore) via il suo webservice REST.
 *
 * PERCHE' ESISTE — il dato che nessun'altra fonte ci da':
 *  - `kw` DICHIARATI per allestimento. Oggi l'IPT del passaggio di proprieta' gira su kW
 *    STIMATI dai CV (backend/province-sigla.js): con i kW veri l'importo smette di essere
 *    una stima, e sopra/sotto i 53 kW la tariffa cambia di categoria.
 *  - `prezzoListino` del nuovo → l'ancora per ragionare sulla svalutazione.
 *  - nomi allestimento COME LI SCRIVE UN ITALIANO ("Giulia 2.2 t Sprint 160cv auto"):
 *    e' esattamente la grafia degli annunci, il nostro problema storico di accoppiamento.
 *  - `codiceEurotax`, `cavalliFiscali`, `neoPatentati`, Euro, CO2, consumi NEDC+WLTP.
 *
 * STATO LEGALE, DETTO CHIARO E NON NASCOSTO IN UN COMMENTO A CASO:
 *  https://webservice.motornet.it/robots.txt dice `User-agent: * / Disallow: /`, e il sito
 *  riserva ogni riproduzione (art. 65 L. 633/1941). Questo modulo esiste per la DEMO LOCALE
 *  del proprietario, su decisione esplicita del proprietario dopo che il divieto gli e' stato
 *  riportato. NON va in un prodotto distribuito: per quello serve la licenza, che Motornet
 *  vende ("Prodotti per Professionisti").
 *  Per questo il modulo e' SPENTO se non lo si accende a mano (AMR_MOTORNET=1) e la cache ha
 *  un TTL lungo: il listino cambia una volta al mese (`dataListino`), quindi una richiesta al
 *  giorno per modello e' comunque piu' del necessario.
 *
 * Superficie API verificata a mano il 2026-07-25 (intercettata dal sito, non indovinata):
 *   GET /nuovo/auto/marche                                            → {marche:[{acronimo,nome,logo}]}
 *   GET /nuovo/auto/modelli/priv?codice_marca=ALF&anno=2026&group_modello_breve_carr=true
 *   GET /nuovo/auto/versione?codice_modello=2213&id_modello_breve_carr=2213
 *   GET /nuovo/auto/dettaglio/priv?codice_motornet=ALF7148&adm=false   → 143 campi
 *   GET /nuovo/auto/accessori?codice_eurotax=1149474&anno=2026&mese=7
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const { kindForStatus, fail } = require('./utils');   // classificazione salute crawler (F1.5)

const HOST = 'webservice.motornet.it';
const BASE = '/api/v2_0/rest/proxy';
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'motornet-cache.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;   // il listino e' mensile: una settimana di cache e' generosa
const TIMEOUT_MS = 12000;
const PAUSA_MS = 1500;                    // minimo tra due richieste: mai raffiche
const UA = 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';

// Interruttore: spento se non lo accendi. Un modulo che non deve finire in produzione non
// deve poter partire per distrazione.
const ATTIVO = process.env.AMR_MOTORNET === '1';

const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  origin: 'https://www.motornet.it',
  referer: 'https://www.motornet.it/',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'user-agent': UA,
};

// ─── Rete: host bloccato, una richiesta alla volta, freno su blocco ──────────
// Host fisso e nessun redirect seguito: il path arriva da noi, non da una risposta, quindi
// non c'e' modo di farci chiamare un host altrui (SSRF).
let ultima = 0;
let bloccatoFino = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(pathQ) {
  if (!ATTIVO) throw fail('motornet spento (AMR_MOTORNET=1 per accenderlo)', { kind: 'error' });
  if (Date.now() < bloccatoFino) throw fail('in pausa dopo un blocco', { kind: 'blocked' });
  const attesa = PAUSA_MS - (Date.now() - ultima);
  if (attesa > 0) await sleep(attesa);
  ultima = Date.now();

  const { status, body } = await new Promise((resolve, reject) => {
    const req = https.get({ host: HOST, path: pathQ, headers: HEADERS }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
  });

  if (status === 403 || status === 429) {
    bloccatoFino = Date.now() + 30 * 60 * 1000;   // mezz'ora di silenzio: non si insiste mai
    throw fail('bloccati (HTTP ' + status + '), pausa 30 min', { status, kind: 'blocked' });
  }
  if (status !== 200) throw fail('HTTP ' + status, { status, kind: kindForStatus(status) });
  try { return JSON.parse(body); } catch (_) { throw fail('risposta non JSON', { status, kind: 'error' }); }
}

// ─── Cache su disco: e' il freno principale, non un'ottimizzazione ───────────
let memo = null;
function leggi() {
  if (memo) return memo;
  try { memo = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { memo = { voci: {} }; }
  if (!memo.voci) memo.voci = {};
  return memo;
}
function scrivi() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(leggi())); } catch (_) {}
}
const inVolo = new Map();
// Una chiave = una risposta. Scaduta ma presente: si serve comunque se la rete fallisce,
// perche' un listino della settimana scorsa e' meglio di nessun listino.
async function conCache(chiave, produci) {
  const c = leggi();
  const v = c.voci[chiave];
  if (v && Date.now() - v.t < TTL_MS) return v.d;
  if (inVolo.has(chiave)) return inVolo.get(chiave);
  const p = (async () => {
    try {
      const d = await produci();
      // Stesso ragionamento di autoit-rilevamenti.js: un elenco vuoto non e' un dato, e' un
      // intoppo. Si serve lo stesso, ma scade fra 15 minuti invece che fra 7 giorni. Misurato:
      // "modelli|JAG" era finito in cache vuoto e sarebbe rimasto tale fino al 1 agosto.
      const vuoto = Array.isArray(d) ? !d.length : !d;
      c.voci[chiave] = { t: vuoto ? Date.now() - TTL_MS + 15 * 60 * 1000 : Date.now(), d };
      scrivi();
      return d;
    } catch (e) {
      if (v) { console.warn('[motornet] ' + chiave + ' KO (' + e.message + '): servo la cache vecchia'); return v.d; }
      throw e;
    } finally { inVolo.delete(chiave); }
  })();
  inVolo.set(chiave, p);
  return p;
}

const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// ─── Livello 1: le tre chiamate grezze ───────────────────────────────────────
const marche = () => conCache('marche', async () =>
  ((await getJson(`${BASE}/nuovo/auto/marche`)).marche || [])
    .map(m => ({ acronimo: m.acronimo, nome: m.nome, logo: m.logo || null })));

const modelli = acronimo => conCache('modelli|' + acronimo, async () => {
  const anno = new Date().getFullYear();
  const q = `codice_marca=${encodeURIComponent(acronimo)}&anno=${anno}&group_modello_breve_carr=true`;
  return ((await getJson(`${BASE}/nuovo/auto/modelli/priv?${q}`)).modelli || []).map(m => ({
    // `modelloBreveCarrozzeria.id` e' il codice che serve per chiedere gli allestimenti
    codiceModello: (m.modelloBreveCarrozzeria && m.modelloBreveCarrozzeria.id) || null,
    nome: (m.modelloBreveCarrozzeria && m.modelloBreveCarrozzeria.descrizione) || m.modello || null,
    gamma: (m.gammaModello && m.gammaModello.descrizione) || null,
    storico: (m.gruppoStorico && m.gruppoStorico.descrizione) || null,
    inizio: m.inizioProduzione || null,
    fine: m.fineProduzione || null,
  })).filter(m => m.codiceModello && m.nome);
});

// Gli allestimenti di un modello: UNA chiamata e dentro c'e' tutto quello che ci serve,
// kW compresi. E' la chiamata che rende utile questa fonte.
const versioni = codiceModello => conCache('versioni|' + codiceModello, async () => {
  const q = `get_img_modello=true&get_img_versione=true&codice_modello=${encodeURIComponent(codiceModello)}`
    + `&id_modello_breve_carr=${encodeURIComponent(codiceModello)}`;
  const r = await getJson(`${BASE}/nuovo/auto/versione?${q}`);
  return {
    modello: r.nomeModello || null,
    foto: r.fotoModello || null,
    versioni: (r.versioni || []).map(v => ({
      nome: v.nome || null,
      breve: v.descrizioneBreve || null,
      codiceEurotax: v.codiceEurotax || null,
      codiceMotornet: v.codiceMotornet || null,
      prezzoListino: v.prezzoListino != null ? Number(v.prezzoListino) : null,
      dataListino: v.dataListino || null,
      kw: v.kw != null ? Number(v.kw) : null,          // ← il motivo di tutto questo modulo
      cavalli: v.cavalli != null ? Number(v.cavalli) : null,
      cilindrata: v.cilindrata != null ? Number(v.cilindrata) : null,
      alimentazione: (v.alimentazione && v.alimentazione.descrizione) || null,
      euro: v.euro || null,
      co2: v.co2 || null,
      consumoCombinato: v.consumoCombinato != null ? Number(v.consumoCombinato) : null,
      porte: v.porte != null ? Number(v.porte) : null,
      posti: v.postiMin != null ? Number(v.postiMin) : null,
      lunghezza: v.lunghezza != null ? Number(v.lunghezza) : null,
      bagagliaio: v.bagagliaioMin != null ? Number(v.bagagliaioMin) : null,
      serbatoio: v.serbatoioLitri != null ? Number(v.serbatoioLitri) : null,
      da: v.da || null, a: v.a || null,
      immagini: (v.immagini || []).map(i => i.url).filter(Boolean),
    })),
  };
});

// Scheda completa di un allestimento (143 campi): si chiede solo per la versione scelta,
// non per tutte. Qui prendiamo i campi che il resto dell'app sa usare davvero.
const dettaglio = codiceMotornet => conCache('dettaglio|' + codiceMotornet, async () => {
  const r = await getJson(`${BASE}/nuovo/auto/dettaglio/priv?codice_motornet=${encodeURIComponent(codiceMotornet)}&adm=false`);
  const m = r.modello || {};
  const d = x => (x && x.descrizione) || null;
  return {
    marca: d(m.marca), modello: m.modello || null, allestimento: m.allestimento || null,
    codiceEurotax: m.codiceEurotax || null, codiceMotornet: m.codiceMotornet || null,
    prezzoListino: m.prezzoListino != null ? Number(m.prezzoListino) : null,
    kw: m.kw != null ? Number(m.kw) : null,
    cavalliFiscali: m.cavalliFiscali != null ? Number(m.cavalliFiscali) : null,
    cilindrata: m.cilindrata != null ? Number(m.cilindrata) : null,
    alimentazione: d(m.alimentazione), cambio: d(m.cambio), nomeCambio: m.nomeCambio || null,
    marce: m.descrizioneMarce || null, trazione: d(m.trazione),
    carrozzeria: d(m.tipo), segmento: d(m.segmento), categoria: d(m.categoria),
    euro: m.euro || null, emissioniCo2: m.emissioniCo2 || null,
    consumoUrbano: m.consumoUrbano, consumoExtraurbano: m.consumoExtraurbano, consumoMedio: m.consumoMedio,
    porte: m.porte != null ? Number(m.porte) : null, posti: m.posti != null ? Number(m.posti) : null,
    neoPatentati: m.neoPatentati === true,
    inizioProduzione: m.inizioProduzione || null, fineProduzione: m.fineProduzione || null,
    wltp: (m.wltp && m.wltp.wltp) || null,
    fonte: 'Motornet.it (Eurotax Italia)',
    url: m.modelloBreveCarrozzeria && m.modelloBreveCarrozzeria.id && m.codiceMotornet
      ? `https://www.motornet.it/auto/scheda-modello/modello/${m.modelloBreveCarrozzeria.id}/allestimento/${m.codiceMotornet}`
      : null,
  };
});

// Accessori di un allestimento: di serie e a pagamento, con i prezzi di listino e — voce
// preziosa per chi compra usato — la SVALUTAZIONE che Motornet attribuisce a ogni optional.
// La risposta grezza e' grossa (116 KB per una Giulia) e piena di campi che non usiamo
// (formule di inclusione/esclusione, id interni): si tiene il minimo utile e si raggruppa per
// macrogruppo, che e' l'unico ordinamento sensato per leggerli.
const accessori = codiceEurotax => conCache('accessori|' + codiceEurotax, async () => {
  const d = new Date();
  const q = `codice_eurotax=${encodeURIComponent(codiceEurotax)}&anno=${d.getFullYear()}&mese=${d.getMonth() + 1}`;
  const r = await getJson(`${BASE}/nuovo/auto/accessori?${q}`);
  const voci = [];
  for (const [chiave, lista] of Object.entries(r || {})) {
    if (!Array.isArray(lista)) continue;
    for (const a2 of lista) {
      const nome = a2.descrizione || a2.descrizioneBreve || a2.descrizioneNormalizzata;
      if (!nome) continue;
      const sv = a2.svalutazione || {};
      voci.push({
        nome: String(nome).trim(),
        gruppo: a2.macrogruppo || a2.descrizioneEquipaggiamento || 'Altro',
        diSerie: (a2.codiceGruppo === 'S') || /di serie/i.test(a2.descrizioneGruppo || '') || chiave === 'serie',
        prezzo: Number(a2.prezzoListino || a2.prezzo) > 0 ? Number(a2.prezzoListino || a2.prezzo) : null,
        // quanto ne resta sull'usato secondo Motornet: se manca, non si stima
        svalutato: Number(sv.prezzoSvalutato) > 0 ? Number(sv.prezzoSvalutato) : null,
      });
    }
  }
  // Stessa voce puo' arrivare piu' volte (gruppi diversi): si tiene una riga per nome+gruppo.
  const visti = new Set();
  const unici = voci.filter(v => { const k = v.gruppo + '|' + v.nome; if (visti.has(k)) return false; visti.add(k); return true; });
  const serie = unici.filter(v => v.diSerie);
  const optional = unici.filter(v => !v.diSerie);
  const gruppi = [...new Set(unici.map(v => v.gruppo))].sort();
  return {
    serie, optional, gruppi,
    totaleOptional: optional.reduce((t, v) => t + (v.prezzo || 0), 0) || null,
    fonte: 'Motornet.it (Eurotax Italia)',
  };
});

// ─── Livello 2: quello che chiama l'app ──────────────────────────────────────
// Da marca+modello scritti come li scrive un utente agli allestimenti con i kW.
// L'accoppiamento del nome e' volutamente prudente: esatto, poi prefisso, poi
// sottoinsieme di parole. Nessun match → null, MAI il modello piu' somigliante a caso
// (un kW sbagliato qui diventa un importo di passaggio sbagliato).
// DECISIONE PURA: da un elenco di modelli del listino a quelli che valgono per la ricerca.
// Pura di proposito: e' la parte che sbaglia, e va provata senza rete (test/motornet.test.js).
function scegliModelli(lista, modelloCercato) {
  const nmod = norm(modelloCercato);
  if (!nmod) return null;
  const cand = (lista || []).map(x => ({ ...x, n: norm(x.nome) })).filter(x => x.n);

  const esatto = cand.find(x => x.n === nmod);
  if (esatto) return { modelli: [esatto], come: 'esatto' };

  // Un modello del listino si spezza in carrozzerie ("Serie 3 Berlina", "Serie 3 Touring",
  // "Serie 3 M Berlina"): chi cerca "Serie 3" le vuole tutte, non una a caso. Si uniscono, e
  // se poi i kW per una data potenza discordano si torna null da se'.
  const varianti = cand.filter(x => x.n.startsWith(nmod + ' '));
  if (varianti.length) return { modelli: varianti, come: varianti.length > 1 ? 'varianti' : 'prefisso' };

  // Il contrario: cercato "Panda 4x4", in listino c'e' "Panda" → il piu' lungo contenuto
  const dentro = cand.filter(x => nmod.startsWith(x.n + ' ')).sort((a, b) => b.n.length - a.n.length);
  if (dentro.length) return { modelli: [dentro[0]], come: 'contenuto' };

  const parole = new Set(nmod.split(' ').filter(Boolean));
  const sub = cand.filter(x => x.n.split(' ').every(p => parole.has(p)));
  if (sub.length) return { modelli: sub, come: 'parole' };
  return null;
}

// DECISIONE PURA: dagli allestimenti ai kW per una data potenza in CV.
// Nessun allestimento con quei CV, oppure kW discordanti tra allestimenti con gli stessi CV
// → null. Un kW sbagliato qui e' un importo di passaggio sbagliato.
function kwPerCavalli(versioni, cavalli) {
  const cv = Number(cavalli);
  if (!(cv >= 1)) return null;
  const pari = (versioni || []).filter(v => Number(v.kw) > 0 && Number(v.cavalli) === cv);
  if (!pari.length) return null;
  const kws = [...new Set(pari.map(v => Number(v.kw)))];
  if (kws.length > 1) return null;
  const listini = pari.map(v => Number(v.prezzoListino)).filter(x => x > 0);
  return {
    kw: kws[0], cavalli: cv,
    versioni: pari.map(v => v.nome).filter(Boolean),
    listinoMin: listini.length ? Math.min(...listini) : null,
  };
}

async function trovaModello(marca, modello) {
  const nm = norm(marca);
  if (!nm) return null;
  const ms = await marche();
  const m = ms.find(x => norm(x.nome) === nm) || ms.find(x => norm(x.nome).startsWith(nm));
  if (!m) return null;
  const scelta = scegliModelli(await modelli(m.acronimo), modello);
  return scelta ? { marca: m, ...scelta } : null;
}

/**
 * @returns {Promise<{ok:true, marca, modello, come, versioni:[]}|{ok:false, motivo:string}>}
 */
async function cerca(marca, modello) {
  if (!ATTIVO) return { ok: false, motivo: 'fonte Motornet non attiva' };
  try {
    const t = await trovaModello(marca, modello);
    if (!t) return { ok: false, motivo: 'modello non trovato nel listino del nuovo Motornet' };
    const parti = [];
    for (const mo of t.modelli) parti.push({ mo, v: await versioni(mo.codiceModello) });
    const tutte = parti.flatMap(p => p.v.versioni.map(v => ({ ...v, modello: p.mo.nome })));
    if (!tutte.length) return { ok: false, motivo: 'nessun allestimento per questo modello' };
    return {
      ok: true, marca: t.marca.nome,
      modello: t.modelli.map(x => x.nome).join(' / '),
      come: t.come,
      codiceModello: t.modelli[0].codiceModello,
      versioni: tutte,
      foto: (parti.find(p => p.v.foto) || { v: {} }).v.foto || null,
      fonte: 'Motornet.it (Eurotax Italia)',
      url: `https://www.motornet.it/auto/scheda-modello/modello/${t.modelli[0].codiceModello}`,
    };
  } catch (e) {
    return { ok: false, motivo: e.message, kind: e.kind || 'error' };
  }
}

/**
 * kW UFFICIALI per un annuncio. E' il motivo per cui questa fonte esiste.
 *
 * L'aggancio NON passa dal nome della versione — quello e' fragile e ci ha gia' fatto
 * perdere tempo altrove. Passa dai CAVALLI, che l'annuncio dichiara sempre (Subito e
 * AutoScout mandano `potenzaCv`) e che nel listino sono una colonna: cercare 160 cv nella
 * tabella della Giulia da' 118 kW esatti, senza moltiplicazioni.
 *
 * Se piu' allestimenti hanno gli stessi CV ma kW diversi (motori diversi, stessa potenza
 * commerciale) NON si scelgono a caso: si torna null. Un kW sbagliato qui diventa un
 * importo di passaggio di proprieta' sbagliato.
 *
 * @returns {Promise<{kw:number, cavalli:number, versioni:string[], fonte:string, url:string}|null>}
 */
async function kwDaCavalli(marca, modello, cavalli) {
  const r = await cerca(marca, modello);
  if (!r.ok) return null;
  const k = kwPerCavalli(r.versioni, cavalli);
  return k ? { ...k, fonte: r.fonte, url: r.url } : null;
}

/** Istante (ms) fino al quale la fonte e' in pausa dopo un blocco; 0 se e' libera. */
const pausaFinoA = () => (Date.now() < bloccatoFino ? bloccatoFino : 0);

module.exports = {
  ATTIVO, cerca, kwDaCavalli, marche, modelli, versioni, dettaglio, accessori, trovaModello,
  pausaFinoA,
  scegliModelli, kwPerCavalli,          // pure: testabili senza rete
  _norm: norm, _CACHE_FILE: CACHE_FILE,
};
