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
const { makeResolver, makeModelResolver, loadAliasMap, norm, taglioValido, confiniDi } = require('./brand-match');

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

/**
 * LE PSEUDO-MARCHE (verdetto 'pseudo' in data/verdetti-marche-subito.json): voci del menu
 * ereditate da Autoscout che NON sono marche ma categorie — Oldtimer (275 "modelli" che
 * sono nomi di marca), Caravans-Wohnm, Trucks-Lkw, Trike, Pocket Bike… Su Autoscout
 * funzionano (makeId vero); su Subito la query diventava q="Oldtimer Abarth", che trova
 * nulla e passa per mercato vuoto. Decisione del proprietario (2026-08-08): per queste la
 * fonte NON si interroga, e la colonna lo dichiara. File assente → nessuna pseudo.
 */
let PSEUDO = null;
function marcaPseudo(tipo, marca) {
  if (!PSEUDO) {
    PSEUDO = { auto: new Set(), moto: new Set() };
    try {
      const j = require('../../data/verdetti-marche-subito.json');
      for (const t of ['auto', 'moto']) {
        for (const [nome, v] of Object.entries(j[t] || {})) {
          if (v && v.verdetto === 'pseudo') PSEUDO[t].add(norm(nome));
        }
      }
    } catch (e) { console.warn('[subito-nodo] verdetti delle marche non letti: ' + e.message); }
  }
  return PSEUDO[tipo === 'moto' ? 'moto' : 'auto'].has(norm(marca));
}

/**
 * LE MARCHE OSPITI (data/ponte-marche-ospiti.json): marche del menu che su Subito non
 * esistono come marca — i loro veicoli vivono sotto un'altra (Vespa sotto PIAGGIO, 75
 * famiglie; Bullit sotto il suo nome nuovo, Bluroc). Curato a mano, ogni voce con la sua
 * prova: la parentela fra marche non si deduce dai nomi — Skyteam fa CLONI delle Honda
 * Dax/Monkey e mapparla mostrerebbe l'originale al posto del clone, REX RS 125 e' uno
 * scooter omonimo della sportiva Aprilia. File assente o illeggibile → nessun ospite.
 */
let OSPITI = null;
function ospiti() {
  if (OSPITI) return OSPITI;
  OSPITI = new Map();
  try {
    const j = require('../../data/ponte-marche-ospiti.json');
    for (const [tipo, marche] of Object.entries(j)) {
      if (tipo.startsWith('_')) continue;                 // le chiavi di documentazione
      for (const [marca, v] of Object.entries(marche || {})) {
        if (!v || !v.ospite) continue;
        OSPITI.set(`${tipo}|${norm(marca)}`, { marca: v.ospite, prefisso: v.prefisso || null });
      }
    }
  } catch (e) { console.warn('[subito-nodo] ponte delle marche ospiti non letto: ' + e.message); }
  return OSPITI;
}

/**
 * Il catalogo a TRE livelli di Subito (marca → modello → versione), letto una volta e
 * indicizzato: per ogni marca, i token dei nomi-versione con il modello a cui appartengono.
 * E' la fonte che dichiara la parentela fra un allestimento e la sua famiglia; qui non si
 * deduce niente, si legge. File assente o illeggibile → nessun aggancio, come prima.
 */
const tokDi = s => String(s == null ? '' : s).toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
let CATALOGO = null;
function catalogo() {
  if (CATALOGO) return CATALOGO;
  CATALOGO = { auto: new Map(), moto: new Map() };
  try {
    const j = require('../../data/subito-catalogo.json');
    for (const tipo of ['auto', 'moto']) {
      for (const m of Object.values(j[tipo] || {})) {
        const versioni = [];
        for (const mod of Object.values(m.modelli || {})) {
          for (const vn of Object.values(mod.versioni || {})) versioni.push({ t: tokDi(vn), fam: mod.nome });
        }
        if (versioni.length) CATALOGO[tipo].set(norm(m.nome), versioni);
      }
    }
  } catch (e) { console.warn('[subito-nodo] catalogo a tre livelli non letto: ' + e.message); }
  return CATALOGO;
}

/** La famiglia di cui il nome cercato e' un allestimento, o null se non e' UNA sola. */
function allestimentoDi(tipo, marcaNome, modello, fam) {
  const t = tokDi(modello);
  // Sotto i tre caratteri il nome non distingue: «e» aggancerebbe ogni versione che
  // comincia per «e». E almeno una lettera: un numero nudo e' quasi sempre una cilindrata
  // dentro il nome-versione («1100 45 CV» di una Panda), non un modello.
  if (!t.length || norm(modello).length < 3 || !t.some(x => /[a-z]/.test(x))) return null;
  const versioni = catalogo()[tipo].get(norm(marcaNome));
  if (!versioni) return null;
  const padri = new Set();
  for (const v of versioni) {
    if (v.t.length <= t.length) continue;
    if (t.every((x, i) => v.t[i] === x)) { padri.add(v.fam); if (padri.size > 1) return null; }
  }
  if (padri.size !== 1) return null;
  const nomePadre = norm([...padri][0]);
  // Il modello del catalogo puo' portare la generazione («A3 2ª serie»): l'indice di
  // ricerca la tiene sotto la famiglia, quindi si cerca prima esatto e poi senza.
  return fam.find(f => norm(f.nome) === nomePadre)
      || fam.find(f => (f.gen || []).some(g => norm(g.nome) === nomePadre))
      || null;
}

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
  /**
   * LA MARCA CHE NON C'E' PUO' AVERE UN OSPITE. Se nemmeno la marca si risolve, prima di
   * arrendersi al testo libero si guarda il ponte degli ospiti: il modello si ri-risolve
   * DENTRO la marca ospitante — prima col prefisso davanti («125 GTS» → «Vespa 125 GTS»,
   * perche' cosi' si chiamano le famiglie di Subito sotto PIAGGIO), poi col nome nudo
   * («Cosa 125» combacia gia'). Si esce SOLO con una famiglia: la marca sola dell'ospite
   * non e' una risposta (sotto Piaggio ci sono 75 famiglie Vespa e tutte le altre), e un
   * id quasi giusto e' peggio del testo libero. Un salto solo: l'ospite non ha ospiti.
   * `come` dichiara il passaggio fino allo schermo.
   */
  if (!m || !m.id) {
    if (opts._ospite) return null;
    const voce = ospiti().get(`${t}|${norm(marca)}`);
    const mod = String(modello == null ? '' : modello).trim();
    if (!voce || !mod) return null;
    const tentativi = voce.prefisso ? [`${voce.prefisso} ${mod}`, mod] : [mod];
    for (const nome of tentativi) {
      const dentro = risolviNodo(t, voce.marca, nome, { ...opts, _ospite: true });
      if (dentro && dentro.famigliaId) return { ...dentro, come: `ospite (${marca} sotto ${dentro.marcaNome})` };
    }
    return null;
  }

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

  // LA REGOLA DEL PREFISSO, scritta una volta: la usano il ramo del prefisso qui sotto e
  // l'unione del ramo delle parole qui sopra di lui. COL CONFINE di brand-match (82e4d15)
  // — la stessa funzione, non una copia. Senza, 'Pegaso 500' agganciava la famiglia
  // 'Pegaso 50' e i cinquantini passavano da risultati normali. Per i nomi CORTI (sotto i
  // 3 caratteri) si pretende che il taglio cada su un confine di token del cercato:
  // «X5 | M», «IS | 250» passano; «GT|V», «AX|el», «C1|5» no — e sono proprio i falsi.
  // Misurato: 118 nomi recuperati, zero agganci che tagliano dentro una parola.
  const filtroPrefisso = f => {
    const n = norm(f.nome);
    if (n.length < 2) return false;
    if (n.length < 3 && !confiniDi(modello).has(n)) return false;
    if (n.startsWith(cercato)) return taglioValido(f.nome, n, cercato);
    if (cercato.startsWith(n)) return taglioValido(modello, cercato, n);
    return false;
  };

  /**
   * LE PAROLE TUTTE, COI RESTI NUMERICI — piu' preciso del prefisso, meno dell'esatto.
   *
   * Il prefisso incolla i token e pretende l'ordine: «Primavera» trovava solo le famiglie
   * che COMINCIANO cosi' («Vespa Primavera Elettrica 45») e perdeva le classiche col
   * numero in mezzo («Vespa 125 Primavera») — annunci che esistono, persi. E «GTS 125»
   * non trovava «Vespa 125 GTS», stesso nome girato.
   *
   * La regola: ogni token del cercato sta nel nome della famiglia (MULTINSIEME: la
   * seconda «R» di «R 1200 R» va trovata anche lei, cosi' «R 1200 GS» resta fuori), e i
   * token che alla famiglia AVANZANO devono essere NUMERI puri — la cilindrata della
   * stessa linea («125 Primavera» per «Primavera»), mai un altro modello («Primavera
   * Elettrica» ha il resto 'elettrica' e per il cercato «Elettrica» il resto e'
   * 'primavera': fuori entrambe le direzioni sbagliate). Misurato caso per caso sui 105
   * agganci ospiti: la versione senza multinsieme o senza il vincolo numerico proponeva
   * «R 1200 GS» per «R 1200 R» e le Primavera per «Elettrica».
   *
   * Si UNISCE al prefisso invece di sostituirlo: «Primavera» = le 3 classiche (parole)
   * + le Elettrica (prefisso). Chi interroga porta tutte le famiglie e lo dichiara.
   */
  if (cercato) {
    const tokCercato = parole(modello);
    const conta = xs => { const m2 = new Map(); for (const x of xs) m2.set(x, (m2.get(x) || 0) + 1); return m2; };
    const tq = conta(tokCercato);
    // Tutti token da UN carattere = niente da agganciare: «R 5» combaciava con «R 60/5»
    // (il resto '60' e' numerico, ma LI' il numero e' l'identita' del modello, non la
    // cilindrata della stessa linea). Letto sui casi veri: gli unici falsi erano proprio
    // questi — BMW R 5 → R 60/5, R 6 → R 60/6.
    const soloMonocarattere = tokCercato.length > 0 && tokCercato.every(x => x.length === 1);
    const perParoleNum = (tokCercato.length && !soloMonocarattere) ? fam.filter(f => {
      const tf = conta(parole(f.nome));
      for (const [x, n] of tq) if ((tf.get(x) || 0) < n) return false;
      for (const [x, n] of tf) if (n - (tq.get(x) || 0) > 0 && !/^\d+$/.test(x)) return false;
      return true;
    }) : [];
    if (perParoleNum.length) {
      const ids = new Set(perParoleNum.map(f => f.id));
      const unione = [...perParoleNum, ...(cercato.length >= 3 ? fam.filter(f => !ids.has(f.id) && filtroPrefisso(f)) : [])];
      return { ...perFamiglie(unione), come: unione.length > 1 ? 'parole (' + unione.length + ' famiglie)' : 'parole' };
    }
  }

  // Solo ora il matching largo: prefisso bidirezionale, minimo 3 caratteri — la stessa
  // regola di `makeModelResolver`, che qui non si usa per un motivo preciso: quello a
  // pari merito ne SCEGLIE UNA e le altre le perde in silenzio. "Serie" su BMW aggancia
  // Serie 1, 2, 3, 5…: sceglierne una vorrebbe dire cercare un settimo di quello che
  // l'utente ha chiesto senza dirglielo. Si portano tutte e chi interroga lo dichiara.
  if (cercato.length >= 3) {
    const pref = fam.filter(filtroPrefisso);
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

  /**
   * L'ALLESTIMENTO TROVA LA SUA FAMIGLIA — ultima spiaggia prima della marca sola.
   *
   * Il nostro catalogo scende piu' in basso di quello di Subito: «Mercedes A 190» e' un
   * allestimento della «Classe A», «Audi RS3» una versione della «A3», «Iron 883» una
   * Sportster. Nessuno dei rami sopra li aggancia — non sono esatti, non sono prefissi,
   * non sono rinominati — e finivano a cercare TUTTA la marca: misurato, 130 nomi del
   * menu, di cui 76 Mercedes e 22 Audi sportive.
   *
   * La parentela NON si indovina: la dichiara Subito stessa. Il suo catalogo ha tre
   * livelli (marca → modello → versione) e i nomi-versione cominciano col nome
   * dell'allestimento: se «RS3 2.5 TFSI...» sta sotto il modello «A3 2ª serie», e' Subito
   * a dire che la RS3 e' una A3. Si pretende che i token del nome cercato siano i PRIMI
   * della versione e che il padre sia UNO SOLO: due padri sono un'ambiguita', non una
   * risposta, e si resta sulla marca.
   *
   * Il nome cercato viaggia INTERO come testo (`testo`, non `testoDedotto`): non e' un
   * resto tolto dalla famiglia, e' proprio l'allestimento, e serve a restringere.
   * `come: 'allestimento'` lo dichiara a schermo: chi guarda sa che la famiglia non e'
   * quella che ha scritto.
   */
  const allest = allestimentoDi(t, m.nome, modello, fam);
  if (allest) return { ...perFamiglie([allest]), come: 'allestimento', testo: String(modello).trim() };

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

module.exports = { risolviNodo, livelliAnnuncio, dichiarato, marcaPseudo, NON_DICHIARATO, _indice: indice, norm };
