#!/usr/bin/env node
'use strict';
/**
 * PONTE Subito → catalogo: genera data/subito-modelli.json.
 *
 * PERCHE' ESISTE. Ogni annuncio Subito porta una tripletta con codici stabili — feature `/car`
 * per le auto, `/bike` per le moto:
 *
 *   /car  = 000083:ALFA ROMEO · 004426:Giulia (2016) · 114487:Giulia 2.2 Turbodiesel 150 CV AT8
 *   /bike = 000040:Ducati     · 001464:Monster 696   · 000000:Altro allestimento
 *
 * Quel codice di mezzo e' l'unica cosa affidabile che abbiamo per dire QUALE modello e' un
 * annuncio. Misurato su 4.000 annunci veri: l'id c'e' sul 100% degli annunci, mentre il NOME
 * spesso non somiglia nemmeno a quello che l'utente digita — chi cerca "320" riceve annunci il
 * cui modello Subito si chiama "Serie 3 (E90/91)", e su 100 annunci nessuno contiene "320".
 * Agganciare per nome e' impossibile; agganciare per id e' una tabella.
 *
 * COSA FA. Raccoglie gli id Subito dagli annunci veri e li aggancia a data/models.json, che porta
 * gia' l'id Autoscout (`modelIdAS`). Quattro livelli di fiducia, dal piu' sicuro al meno:
 *
 *   esatto      il nome Subito e' identico a quello del nostro catalogo
 *   generazione lo diventa togliendo la generazione che Subito appiccica in coda
 *               ("Classe A (W177)", "Golf 7ª serie", "Macan 1ªs. '13-'25", "Serie 3 (E90/91)")
 *   gruppo      lo aggancia data/model-groups.json, che mappa "Serie 3" sui suoi trim
 *   --          niente: finisce in data/subito-modelli-da-rivedere.json e lo decide una persona
 *
 * Misurato al primo giro, 20 marche pari al 62% del mercato auto e al 56% del moto:
 *   MOTO  398 id su 398 agganciati esatti — il ponte c'era gia', a costo zero.
 *   AUTO  402 id: 21% esatti, 47% dopo la generazione, 11% via gruppi, 21% da decidere.
 *
 * NON INDOVINA MAI. Niente prefissi, niente somiglianze: o il nome combacia dopo aver tolto un
 * suffisso che Subito ha aggiunto lui, o la riga va nella lista da rivedere col numero di annunci
 * accanto, cosi' si lavora dalle piu' pesanti in giu'.
 *
 * RIESEGUIBILE. Le decisioni prese a mano NON si perdono: una riga con `via: "mano"` viene
 * ricopiata com'e'. Le altre si ricalcolano. Il file non si riscrive mai a meta': se il raccolto
 * torna molto piu' povero del solito lo script si ferma senza toccare niente.
 *
 * Uso:
 *   node scripts/build-subito-modelli.js                 le marche che valgono di piu' (default)
 *   node scripts/build-subito-modelli.js --tutte         tutte quelle con almeno 200 annunci
 *   node scripts/build-subito-modelli.js --marche Fiat,BMW
 *   node scripts/build-subito-modelli.js --dry           non scrive
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const RADICE = path.join(__dirname, '..');
const bm = require(path.join(RADICE, 'backend', 'scrapers', 'brand-match'));
const MODELS = require(path.join(RADICE, 'data', 'models.json'));
const GRUPPI = (() => { try { return require(path.join(RADICE, 'data', 'model-groups.json')); } catch (_) { return { auto: {}, moto: {} }; } })();

const OUT = path.join(RADICE, 'data', 'subito-modelli.json');
const OUT_KO = path.join(RADICE, 'data', 'subito-modelli-da-rivedere.json');

const HOST = 'hades.subito.it';
const CAT = { auto: 2, moto: 3 };
const PAUSA_MS = 3000;              // la fonte serve anche l'app: si va piano
const PER_PAGINA = 100;
const norm = bm.norm;

// ─── Rete ────────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(percorso) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: HOST, path: percorso, headers: { 'User-Agent': UA, Accept: 'application/json' } }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429) return reject(new Error('bloccati (HTTP ' + res.statusCode + '): fermarsi'));
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(s)); } catch (_) { reject(new Error('risposta non JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

/**
 * Gli annunci di una marca. Due ordinamenti e non uno: per rilevanza arrivano i modelli recenti,
 * per prezzo crescente quelli vecchi. Misurato: con un solo ordinamento si perde meta' dei
 * modelli storici, che sono proprio quelli con i nomi strani.
 */
async function annunciDi(tipo, marca) {
  const fuori = [];
  for (const sort of ['', '&sort=priceasc']) {
    const j = await get(`/v1/search/items?c=${CAT[tipo]}&t=s&q=${encodeURIComponent(marca)}&lim=${PER_PAGINA}${sort}`);
    fuori.push(...(j.ads || []));
    await sleep(PAUSA_MS);
  }
  return fuori;
}

// ─── Lettura degli id ────────────────────────────────────────────────────────
/**
 * La generazione che Subito appiccica in coda al nome del modello. Quattro forme, tutte
 * verificate sui dati veri; si tolgono solo quelle, niente di piu'.
 */
// Una sola implementazione, condivisa col runtime: prima questo script e quello gemello
// ne avevano una a testa, e la copia che girava in produzione era la piu' debole delle tre.
const { senzaGenerazione } = require('../backend/nomi-modello');

/**
 * La marca ripetuta in testa al modello: Subito scrive "Mazda2", il nostro catalogo "2".
 * E' l'unica delle regole provate che nella verifica per collisioni non ne ha create NESSUNA:
 * non accorpa modelli diversi, toglie solo un prefisso che e' gia' la marca. Le altre tre che
 * avevo provato (serie da codice, prefisso di lettere, classe) producevano solo famiglie —
 * ogni aggancio nuovo era un modello schiacciato su un altro — e sono state buttate.
 */
function senzaMarca(nomeNudo, marca) {
  const nm = norm(marca), q = norm(nomeNudo);
  return nm && q.startsWith(nm) && q.length > nm.length ? q.slice(nm.length) : null;
}

/**
 * Unione di due mappe di versioni, col conteggio annunci al MASSIMO visto.
 * Le versioni si accumulano come gli id: un campione che non ripesca una versione non vuol dire
 * che quella versione non esista piu'.
 */
function unisciVersioni(vecchie, nuove) {
  const out = { ...(vecchie || {}) };
  for (const [k, v] of Object.entries(nuove || {})) {
    out[k] = { nome: v.nome, annunci: Math.max(v.annunci || 0, (out[k] && out[k].annunci) || 0) };
  }
  return out;
}

/**
 * Gli id di una marca dagli annunci, TUTTI E DUE i livelli che Subito porta:
 *   values[1] = modello   values[2] = versione
 *
 * La versione si prende nello stesso giro perche' non costa NIENTE: gli annunci sono gia'
 * scaricati e values[2] e' li' dentro. Prima la buttavamo via, e per riprenderla ci voleva un
 * secondo raccolto identico al primo — misurato su 6.000 annunci: 5.242 versioni, gratis.
 */
function idDa(ads, tipo, marca) {
  const uri = tipo === 'auto' ? '/car' : '/bike';
  const alias = bm.loadAliasMap(tipo)[norm(marca)] || [marca];
  const suoi = new Set([norm(marca), ...alias.map(norm)]);
  const fuori = new Map();
  let fuoriMarca = 0, senzaId = 0, senzaVersione = 0;
  for (const ad of ads) {
    const f = (ad.features || []).find(x => x.uri === uri);
    const v = (f && f.values) || [];
    if (!v[1] || v[1].key === '000000') { senzaId++; continue; }
    // La ricerca Subito e' a TESTO LIBERO e pesca anche altre marche: cercando "Volkswagen"
    // tornano XC60, Stelvio e 500L. Senza questo filtro si confronterebbero i modelli di una
    // marca contro il catalogo di un'altra, e il "non agganciato" sarebbe garantito.
    if (!v[0] || !suoi.has(norm(v[0].value))) { fuoriMarca++; continue; }
    const k = v[1].key;
    if (!fuori.has(k)) fuori.set(k, { nome: v[1].value, annunci: 0, versioni: {} });
    const voce = fuori.get(k);
    voce.annunci++;
    // 000000 = "Altro allestimento": non e' una versione, e' l'assenza di versione.
    if (!v[2] || v[2].key === '000000') { senzaVersione++; continue; }
    const vv = voce.versioni[v[2].key] || (voce.versioni[v[2].key] = { nome: v[2].value, annunci: 0 });
    vv.annunci++;
  }
  return { id: fuori, fuoriMarca, senzaId, senzaVersione };
}

// ─── Aggancio ────────────────────────────────────────────────────────────────
/** Dove va a finire un id Subito, e per quale via. `null` = da rivedere. */
function aggancia(tipo, marca, nomeSubito) {
  const e = (MODELS[tipo] || {})[marca];
  if (!e) return null;
  const perNome = new Map((e.models || []).map(m => [norm(m.nome), m]));
  const esatto = perNome.get(norm(nomeSubito));
  if (esatto) return { modello: esatto.nome, modelIdAS: esatto.modelIdAS || null, via: 'esatto' };
  const nudo = senzaGenerazione(nomeSubito);
  const gen = perNome.get(norm(nudo));
  if (gen) return { modello: gen.nome, modelIdAS: gen.modelIdAS || null, via: 'generazione' };
  const sm = senzaMarca(nudo, marca);
  const m = sm && perNome.get(sm);
  if (m) return { modello: m.nome, modelIdAS: m.modelIdAS || null, via: 'marcaInTesta' };
  // I gruppi-serie: "Serie 3" non e' una voce di catalogo, e' l'insieme dei suoi trim.
  const gruppi = ((GRUPPI[tipo] || {})[marca]) || {};
  for (const [serie, membri] of Object.entries(gruppi)) {
    if (norm(serie) !== norm(nudo)) continue;
    return { modello: serie, membri, modelIdAS: null, via: 'gruppo' };
  }
  return null;
}

// ─── Marche da interrogare ───────────────────────────────────────────────────
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

function marcheDaFare() {
  const scelte = arg('marche', null);
  if (scelte) {
    const v = scelte.split(',').map(s => s.trim()).filter(Boolean);
    return ['auto', 'moto'].flatMap(t => v.filter(m => (MODELS[t] || {})[m]).map(m => [t, m]));
  }
  const soglia = process.argv.includes('--tutte') ? 200 : 1500;
  const fuori = [];
  for (const tipo of ['auto', 'moto']) {
    for (const [nome, e] of Object.entries(MODELS[tipo] || {})) {
      const n = (e.autoscout && e.autoscout.totalAnnunci) || 0;
      if (n >= soglia) fuori.push([tipo, nome, n]);
    }
  }
  // Dalle piu' pesanti in giu': se il raccolto si interrompe, si e' preso il grosso.
  return fuori.sort((a, b) => b[2] - a[2]).map(([t, m]) => [t, m]);
}

// ─── Corpo ───────────────────────────────────────────────────────────────────
(async () => {
  const dry = process.argv.includes('--dry');
  const prima = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { return null; } })();
  const primaKO = (() => { try { return JSON.parse(fs.readFileSync(OUT_KO, 'utf8')); } catch (_) { return null; } })();
  const tavola = { auto: {}, moto: {} };
  const rivedere = { auto: new Map(), moto: new Map() };

  /**
   * LA TABELLA SI ACCUMULA, non si rifa' da zero.
   *
   * Il raccolto e' un CAMPIONE: ogni giro Subito restituisce annunci diversi, quindi id diversi.
   * Rifacendo la tabella da capo, un id visto ieri e non oggi spariva — misurato fra due giri a
   * dieci minuti di distanza: 15 id persi e 54 nuovi, su nessuno dei quali era cambiato niente.
   * Ma un id di Subito e' un fatto stabile: averlo visto una volta basta, non vederlo oggi non
   * lo cancella. Accumulando, ogni riesecuzione puo' solo migliorare la tabella.
   *
   * L'aggancio pero' si RICALCOLA anche sulle righe vecchie: cosi' una regola corretta oggi
   * sistema pure gli id raccolti mesi fa, senza doverli riprendere dalla rete.
   */
  let ereditati = 0, aMano = 0;
  for (const tipo of ['auto', 'moto']) {
    for (const [id, v] of Object.entries((prima && prima[tipo]) || {})) {
      if (!v) continue;
      if (v.via === 'mano') { tavola[tipo][id] = v; aMano++; continue; }
      const a = aggancia(tipo, v.marca, v.nome);
      if (a) tavola[tipo][id] = { ...v, ...a, versioni: v.versioni || {} };
      else rivedere[tipo].set(id, { id, nome: v.nome, marca: v.marca, annunci: v.annunci || 0, nudo: senzaGenerazione(v.nome) });
      ereditati++;
    }
    // Anche i "da rivedere" si portano avanti: sono id veri, e vanno riprovati con le regole
    // di oggi invece di sparire dalla lista appena un campione non li ripesca.
    for (const x of ((primaKO && primaKO[tipo]) || [])) {
      if (tavola[tipo][x.id] || rivedere[tipo].has(x.id)) continue;
      const a = aggancia(tipo, x.marca, x.nome);
      if (a) { tavola[tipo][x.id] = { nome: x.nome, marca: x.marca, ...a, annunci: x.annunci || 0 }; ereditati++; }
      else rivedere[tipo].set(x.id, x);
    }
  }
  if (ereditati || aMano) {
    console.log('[subito-modelli] ereditati dal giro precedente: ' + ereditati
      + ' id (di cui decisi a mano: ' + aMano + ') · ancora da rivedere: '
      + (rivedere.auto.size + rivedere.moto.size));
  }

  const lista = marcheDaFare();
  console.log('[subito-modelli] marche da interrogare: ' + lista.length + ' — circa '
    + Math.ceil(lista.length * 2 * (PAUSA_MS / 1000) / 60) + ' minuti');

  const conta = { esatto: 0, generazione: 0, marcaInTesta: 0, gruppo: 0, rivedere: 0 };
  let marcheFatte = 0, marcheKO = 0;

  for (const [tipo, marca] of lista) {
    let ads;
    try { ads = await annunciDi(tipo, marca); }
    catch (e) {
      marcheKO++;
      console.warn('  ! ' + tipo + ' ' + marca + ': ' + e.message);
      if (/bloccati/.test(e.message)) { console.warn('[subito-modelli] la fonte ci ha bloccati: mi fermo qui.'); break; }
      continue;
    }
    const { id, fuoriMarca } = idDa(ads, tipo, marca);
    marcheFatte++;
    const q = { esatto: 0, generazione: 0, marcaInTesta: 0, gruppo: 0, rivedere: 0 };
    for (const [codice, v] of id) {
      // Una decisione a mano vince sempre sul ricalcolo.
      if (tavola[tipo][codice] && tavola[tipo][codice].via === 'mano') continue;
      const a = aggancia(tipo, marca, v.nome);
      if (a) {
        // `annunci` e' il MASSIMO visto: e' una misura di quanto pesa quel modello, e un
        // campione sfortunato non deve far sembrare piccolo qualcosa che piccolo non e'.
        const vecchio = tavola[tipo][codice];
        tavola[tipo][codice] = { nome: v.nome, marca, ...a,
          annunci: Math.max(v.annunci, (vecchio && vecchio.annunci) || 0),
          // Le versioni si UNISCONO fra un giro e l'altro, come gli id: un campione che non
          // ripesca una versione non vuol dire che quella versione non esista piu'.
          versioni: unisciVersioni(vecchio && vecchio.versioni, v.versioni) };
        rivedere[tipo].delete(codice);
        conta[a.via]++; q[a.via]++;
      } else {
        const vecchio = rivedere[tipo].get(codice);
        rivedere[tipo].set(codice, { id: codice, nome: v.nome, marca,
          annunci: Math.max(v.annunci, (vecchio && vecchio.annunci) || 0),
          versioni: unisciVersioni(vecchio && vecchio.versioni, v.versioni),
          nudo: senzaGenerazione(v.nome) });
        conta.rivedere++; q.rivedere++;
      }
    }
    console.log(`  ${(tipo + ' ' + marca).padEnd(24)} id=${String(id.size).padStart(3)}`
      + ` · esatto ${String(q.esatto).padStart(3)} · generaz. ${String(q.generazione).padStart(3)}`
      + ` · marca ${String(q.marcaInTesta).padStart(2)} · gruppo ${String(q.gruppo).padStart(2)}`
      + ` · da rivedere ${String(q.rivedere).padStart(3)} · versioni ${[...id.values()].reduce((a, x) => a + Object.keys(x.versioni || {}).length, 0)}`);
  }

  // ─── Guardie: meglio non scrivere che scrivere una tabella monca ───────────
  if (!marcheFatte) throw new Error('nessuna marca interrogata: non scrivo niente');
  const nuovi = Object.keys(tavola.auto).length + Object.keys(tavola.moto).length;
  const vecchi = prima ? Object.keys(prima.auto || {}).length + Object.keys(prima.moto || {}).length : 0;
  // Accumulando, la tabella non puo' rimpicciolire: se succede e' un difetto del codice, non un
  // campione sfortunato, e va visto subito invece di essere scritto sul disco.
  if (nuovi < vecchi) {
    throw new Error(`la tabella si e' RIMPICCIOLITA: ${nuovi} id contro ${vecchi}. `
      + 'Accumulando non puo\' succedere: c\'e\' un difetto. Non scrivo niente.');
  }

  const fuori = {
    generatedAt: new Date().toISOString(),
    fonte: 'hades.subito.it — feature /car (auto) e /bike (moto) degli annunci',
    nota: 'Da un id modello Subito alla voce di data/models.json, che porta l\'id Autoscout. '
      + 'via: esatto | generazione (tolto il suffisso che Subito aggiunge) | marcaInTesta ("Mazda2" -> "2") | gruppo (model-groups.json) | mano (deciso da una persona: non si ricalcola).',
    marcheInterrogate: marcheFatte,
    conta,
    auto: tavola.auto,
    moto: tavola.moto,
  };
  const fuoriKO = {
    generatedAt: fuori.generatedAt,
    nota: 'Id Subito senza una voce corrispondente, ordinati per annunci: si lavora dai piu\' pesanti in giu\'. '
      + 'Per deciderne uno, aggiungilo a data/subito-modelli.json con via:"mano" — le riesecuzioni non lo toccano.',
    auto: [...rivedere.auto.values()].sort((a, b) => b.annunci - a.annunci),
    moto: [...rivedere.moto.values()].sort((a, b) => b.annunci - a.annunci),
  };

  console.log('\n[subito-modelli] ' + nuovi + ' id agganciati · '
    + Object.entries(conta).map(([k, v]) => k + ' ' + v).join(' · ')
    + (marcheKO ? ' · marche non riuscite ' + marcheKO : ''));

  if (dry) { console.log('[subito-modelli] --dry: niente scritto'); return; }
  fs.writeFileSync(OUT, JSON.stringify(fuori, null, 1) + '\n');
  fs.writeFileSync(OUT_KO, JSON.stringify(fuoriKO, null, 1) + '\n');
  console.log('[subito-modelli] scritti ' + path.relative(RADICE, OUT) + ' e ' + path.relative(RADICE, OUT_KO));
})().catch(e => { console.error('[subito-modelli] ' + e.message); process.exit(1); });
