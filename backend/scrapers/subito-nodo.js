'use strict';
/**
 * DAL TESTO DIGITATO AGLI ID DI SUBITO.
 *
 * Fino a oggi la ricerca su Subito e' `q="marca modello"`, testo libero. Misurato sui
 * primi 50 risultati di sei veicoli: 213 su 300 erano il veicolo cercato, il 71%. Su
 * "Audi 80" erano ZERO — il testo "80" pesca dentro "180 CV", "80.000 km", qualsiasi
 * cosa. Con gli id del catalogo: 300 su 300.
 *
 * I DUE LIVELLI NON SONO GLI STESSI PER AUTO E MOTO, e nemmeno i nomi dei parametri.
 * E' l'errore che questa classe di codice fa piu' spesso: stesso concetto, nome diverso
 * per ramo, e chi sbaglia non prende un errore — prende zero risultati, che si legge
 * come "quella fonte non ha niente".
 *
 *   AUTO   cb = marca   cm = FAMIGLIA ("Passat", "Giulia", "Serie 3")
 *   MOTO   bb = marca   bm = MODELLO  ("SV 650", "Bonneville")
 *
 * Sotto la famiglia, le auto hanno la GENERAZIONE ("Passat 5ª serie"), che Subito non
 * sa filtrare: non esiste un parametro, e il suo stesso menu si ferma alla famiglia.
 * Ma ogni annuncio la DICHIARA (misurato: 400 su 400), quindi si filtra leggendo
 * l'annuncio invece di chiederlo alla fonte. Vedi `livelliAnnuncio`.
 *
 * Il matching riusa i risolutori dell'app (brand-match): stessa normalizzazione e
 * stessi alias del resto della ricerca. Un secondo modo di far combaciare i nomi
 * sarebbe un secondo modo di sbagliare.
 */
const path = require('path');
const { makeResolver, makeModelResolver, loadAliasMap, norm, taglioValido } = require('./brand-match');

/**
 * Le equivalenze scritte a mano fra due nomi della stessa moto (data/ponte-rinominati.json).
 * File NUOVO: i cataloghi sorgente non si toccano. Se manca o e' illeggibile il ponte
 * semplicemente non c'e' — nessuna equivalenza inventata, nessun boot rotto.
 */
let PONTE = null;
function ponte() {
  if (PONTE) return PONTE;
  PONTE = new Map();
  try {
    const j = require('../../data/ponte-rinominati.json');
    for (const [tipo, marche] of Object.entries(j)) {
      if (tipo.startsWith('_')) continue;                 // le chiavi di documentazione
      for (const [marca, voci] of Object.entries(marche || {})) {
        for (const v of voci || []) {
          if (!v || !v.cercato || !v.famiglia) continue;
          PONTE.set(`${tipo}|${norm(marca)}|${norm(v.cercato)}`, norm(v.famiglia));
        }
      }
    }
  } catch (e) { console.warn('[subito-nodo] ponte dei rinominati non letto: ' + e.message); }
  return PONTE;
}
const pontePer = (tipo, marcaNome, cercato) => ponte().get(`${tipo}|${norm(marcaNome)}|${cercato}`) || null;

const FILE = path.join(__dirname, '..', '..', 'data', 'subito-indice.json');

let CACHE = null;
/** L'indice si legge alla PRIMA richiesta: chi non cerca su Subito non lo paga. */
function indice(iniettato) {
  if (iniettato) return prepara(iniettato);
  if (CACHE) return CACHE;
  let dati;
  try { dati = require(FILE); }
  catch (e) { console.warn('[subito-nodo] indice assente (' + e.message + ') → si resta a testo libero'); dati = { auto: {}, moto: {} }; }
  CACHE = prepara(dati);
  return CACHE;
}

function prepara(dati) {
  const per = {};
  for (const tipo of ['auto', 'moto']) {
    const marche = dati[tipo] || {};
    per[tipo] = {
      marche,
      risolviMarca: makeResolver(
        Object.entries(marche).map(([nome, m]) => ({ name: nome, value: { nome, ...m } })),
        { alias: loadAliasMap(tipo) }),
    };
  }
  return { per, generatoIl: dati.generatoIl || null };
}

/**
 * (tipo, marca, modello) → gli id con cui interrogare Subito.
 * Ritorna null quando non si e' sicuri: chi chiama resta a testo libero, e lo dichiara.
 * Mai un id "quasi giusto" — un id sbagliato porta annunci di un altro veicolo senza
 * che si veda, che e' peggio del testo libero.
 *
 * @returns {null|{tipo,marcaId,marcaNome,famigliaId,famigliaNome,generazioni,come}}
 */
function risolviNodo(tipo, marca, modello, opts = {}) {
  const t = tipo === 'moto' ? 'moto' : 'auto';
  const ix = indice(opts.indice);
  const q = ix.per[t];
  if (!q) return null;
  const m = q.risolviMarca(marca);
  if (!m || !m.id) return null;

  const base = { tipo: t, marcaId: m.id, marcaNome: m.nome, famigliaId: null, famigliaNome: null, generazioni: [], come: 'marca' };
  if (!modello || !String(modello).trim()) return base;

  const fam = (m.famiglie || []);
  const gen = [];
  for (const f of fam) for (const g of (f.gen || [])) gen.push({ f, g });

  const cercato = norm(modello);
  /**
   * Una o PIU' famiglie. Subito tiene 6 nomi doppi dentro la stessa marca (Ford "Ka"
   * due volte, BMW "Serie 2 Gran Coupé" due volte, Opel "Combo Life" due volte): sono
   * lo stesso veicolo spezzato in due voci, e sceglierne una a caso ne perderebbe meta'.
   * Si portano tutte, e chi interroga Subito le mette in AND-lista dove la fonte lo
   * permette (auto: `cm=a,b` — verificato; moto: la virgola da' 400, quindi la prima).
   */
  const perFamiglie = lista => ({
    ...base,
    famigliaId: lista[0].id,
    famigliaIds: lista.map(f => f.id),
    famigliaNome: lista[0].nome,
    generazioni: lista.flatMap(f => f.gen || []),
    come: lista.length > 1 ? 'famiglia (nome doppio nel catalogo)' : 'famiglia',
  });
  const perFamiglia = f => perFamiglie([f]);
  const perGenerazione = x => ({ ...base, famigliaId: x.f.id, famigliaIds: [x.f.id], famigliaNome: x.f.nome, generazioni: [x.g], come: 'generazione' });

  // IL PIU' e IL PUNTO CONTANO. `norm` butta via ogni simbolo, quindi "Ka+" e "Ka",
  // "Monster 696+" e "Monster 696", "SE 1.25" e "SE 125" diventano la stessa cosa e
  // vince chi capita prima nella lista: si cercherebbe l'altra moto senza che si veda.
  // Prima si prova un confronto che quei due caratteri li tiene.
  const stretta = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9+.]/g, '');
  const cercataStretta = stretta(modello);
  const famStretta = fam.filter(f => stretta(f.nome) === cercataStretta);
  if (famStretta.length) return perFamiglie(famStretta);
  const genStretta = gen.filter(x => stretta(x.g.nome) === cercataStretta);
  if (genStretta.length === 1) return perGenerazione(genStretta[0]);

  // L'ESATTO BATTE IL PREFISSO, e vale su entrambi i livelli. Senza questo,
  // "Passat 5ª serie" aggancia la famiglia "Passat" per prefisso e la generazione
  // non viene mai guardata: si cercherebbero tutte le Passat di ogni serie.
  const famEsatte = fam.filter(f => norm(f.nome) === cercato);
  if (famEsatte.length) return perFamiglie(famEsatte);
  const genEsatta = gen.find(x => norm(x.g.nome) === cercato);
  if (genEsatta) return perGenerazione(genEsatta);

  // PAROLA INTERA dentro un nome composto. Subito impacchetta piu' modelli in una voce
  // sola — "80/90/4000/Cabrio", "300/400" — e li' l'Audi 80 non si trova ne' esatta ne'
  // per prefisso: il risolutore condiviso non fa prefisso sotto i 3 caratteri, e "80" ne
  // ha due. Misurato: cercando "Audi 80" oggi i primi 50 risultati non contengono UNA
  // Audi 80. Qui si guarda se il cercato e' una delle parole del nome, e si accetta solo
  // se una sola voce risponde: due voci con la stessa parola sono un'ambiguita', non una
  // risposta.
  const parole = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
  if (cercato) {
    const perParola = fam.filter(f => parole(f.nome).includes(cercato));
    if (perParola.length === 1) return perFamiglie(perParola);
    const genParola = gen.filter(x => parole(x.g.nome).includes(cercato));
    if (genParola.length === 1) return perGenerazione(genParola[0]);
  }

  /**
   * IL PONTE DEI RINOMINATI, prima del prefisso e dopo tutto cio' che e' esatto.
   *
   * Il confine sui numeri e' giusto («CRF 110» non e' l'Africa Twin CRF1100L) ma separa
   * anche i modelli che hanno DUE NOMI per la stessa moto: «VN 15»/«VN 1500»,
   * «ZR 750»/«ZR 7», le Aprilia con la cilindrata scritta in litri («4.5» = 450 cc).
   * Quelle equivalenze non si deducono, si dichiarano: stanno in data/ponte-rinominati.json,
   * una per una, ognuna col suo perche'. Sta QUI perche' e' una risposta precisa, e le
   * risposte precise vengono prima di quelle larghe.
   */
  const eq = pontePer(t, m.nome, cercato);
  if (eq) {
    const famPonte = fam.filter(f => norm(f.nome) === eq);
    if (famPonte.length) return { ...perFamiglie(famPonte), come: 'ponte (nome rinominato)' };
  }

  // Solo ora il matching largo: prefisso bidirezionale, minimo 3 caratteri — la stessa
  // regola di `makeModelResolver`, che qui non si usa per un motivo preciso: quello a
  // pari merito ne SCEGLIE UNA e le altre le perde in silenzio. "Serie" su BMW aggancia
  // Serie 1, 2, 3, 5…: sceglierne una vorrebbe dire cercare un settimo di quello che
  // l'utente ha chiesto senza dirglielo. Si portano tutte e chi interroga lo dichiara.
  if (cercato.length >= 3) {
    // COL CONFINE di brand-match (82e4d15) — la stessa funzione, non una copia. Senza,
    // 'Pegaso 500' agganciava la famiglia 'Pegaso 50' e i cinquantini passavano da
    // risultati normali: sulle moto la 'generazione' E' la famiglia stessa (4.605 su
    // 4.605 fotocopia), quindi `riconosci` li ACCETTAVA — veicolo sbagliato senza dirlo.
    // I rinominati storici (VN 15/VN 1500, ZR 750/ZR 7) che questo confine sacrifica
    // sono materia da ponte curato, non da prefisso: due numeri diversi restano due moto.
    const pref = fam.filter(f => {
      const n = norm(f.nome);
      if (n.length < 3) return false;
      if (n.startsWith(cercato)) return taglioValido(f.nome, n, cercato);
      if (cercato.startsWith(n)) return taglioValido(modello, cercato, n);
      return false;
    });
    if (pref.length) {
      const n = { ...perFamiglie(pref), come: pref.length > 1 ? 'prefisso (' + pref.length + ' famiglie)' : 'prefisso' };
      /**
       * QUELLO CHE RESTA DEL NOME, tolta la famiglia — e che senza questo si perdeva.
       *
       * Il nostro catalogo scende all'allestimento ("CLA 200", "Golf GTD", "DS 3
       * Crossback"), quello di Subito si ferma alla famiglia ("CLA", "Golf", "DS 3"):
       * cercando una CLA 200 partiva l'id della famiglia e basta, e tornavano tutte le
       * CLA — 180, 220, 250, 45 AMG. Misurato sul catalogo: 237 modelli auto sono piu'
       * stretti della loro famiglia Subito, e il ponte scritto a mano ne copriva 6.
       *
       * Il resto va SOLO alla fonte, dentro `q`: e' un campo diverso da `testo`, che
       * invece e' provato a mano e vale anche per la marcatura. Qui non si marca e non
       * si scarta niente — si chiede a Subito di restringere, e quello che risponde si
       * mostra. Due caratteri minimo: "Fiat 500C" meno "500" fa "c", che non distingue
       * niente e allargherebbe il rumore invece di ridurlo.
       */
      if (pref.length === 1) {
        // Il `norm` condiviso INCOLLA tutto ("CLA 45 AMG" → "cla45amg"), e tagliandolo li'
        // il resto usciva "45amg", che in nessun titolo esiste. Qui serve una
        // normalizzazione che tenga le parole separate, e il confine di parola va preteso:
        // cosi' "Fiat 500C" non produce "c" (non e' "500 C", e' un nome attaccato).
        const spazi = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9]+/g, ' ').trim();
        const mo = spazi(modello), fa = spazi(pref[0].nome);
        const resto = mo.startsWith(fa + ' ') ? mo.slice(fa.length).trim() : '';
        if (resto.length >= 2) n.testoDedotto = resto;
      }
      return n;
    }
    const hg = makeModelResolver(gen.map(x => ({ name: x.g.nome, value: x })))(modello);
    if (hg) return perGenerazione(hg);
  }

  return base;   // marca sola: meglio della marca sbagliata, e chi chiama lo sa
}

/**
 * I livelli che l'ANNUNCIO dichiara di se': marca, modello/generazione, versione.
 *
 * ATTENZIONE al campo `level` di Subito: sul segnaposto "Altro allestimento" scrive
 * `level: 0` con `label: "Versione"`. Filtrando su `level`, ogni annuncio senza
 * versione — il 23% — risulterebbe di un'altra MARCA e verrebbe buttato. Si legge
 * `label`. (Trovato leggendo il dato grezzo, non il documento.)
 */
const ETICHETTA = { Marca: 'marca', Modello: 'modello', Versione: 'versione' };
function livelliAnnuncio(ad) {
  const feats = (ad && ad.features) || {};
  const pack = Object.values(feats).find(f => f && (f.uri === '/car' || f.uri === '/bike'));
  const out = { marca: null, modello: null, versione: null };
  if (!pack) return out;
  for (const v of (pack.values || [])) {
    const k = ETICHETTA[v.label];
    if (k) out[k] = { id: String(v.key), nome: String(v.value) };
  }
  return out;
}

/** "Altro modello"/"Altro allestimento": il venditore non ha dichiarato quel livello. */
const NON_DICHIARATO = '000000';
const dichiarato = liv => !!(liv && liv.id && liv.id !== NON_DICHIARATO);

module.exports = { risolviNodo, livelliAnnuncio, dichiarato, NON_DICHIARATO, _indice: indice, norm };
