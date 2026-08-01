'use strict';
/**
 * RICHIAMI — area dedicata all'archivio europeo delle allerte di sicurezza (Safety Gate).
 *
 * Area a se' e non una fonte del catalogo, per una ragione di sostanza: il catalogo risponde alla
 * domanda "com'e' fatto questo veicolo", i richiami rispondono a "c'e' qualcosa che non va". Sono
 * due domande diverse e chi le fa e' in due momenti diversi del lavoro.
 *
 * COSA PUO' E COSA NON PUO' DIRE, ripetuto qui perche' e' il punto che l'interfaccia deve rendere
 * evidente: l'allerta individua i veicoli colpiti tramite il numero di omologazione europea o un
 * intervallo di telaio, e un annuncio non porta ne' l'uno ne' l'altro. Questa area dice se su un
 * MODELLO risulta un richiamo, non se il singolo esemplare e' coinvolto.
 *
 * I dati stanno su disco (data/safety-gate.json, da scripts/build-safety-gate.js): l'endpoint
 * della Commissione non ha una ricerca per categoria, quindi filtrare a runtime avrebbe voluto
 * dire scaricare l'archivio a ogni ricerca.
 */
const path = require('path');
const rdw = require('./scrapers/rdw-richiami');   // seconda fonte: campagne RDW per marca+modello
const omo = require('./scrapers/rdw-omologazioni'); // da un'omologazione alle sue versioni

let D = null;
try { D = require(path.join(__dirname, '..', 'data', 'safety-gate.json')); } catch (_) { D = null; }

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Un modello dell'allerta combacia col testo cercato? Si pretende la parola INTERA, non un pezzo:
 * i nomi nell'archivio sono spezzoni di testo libero ("Plus", "CC", "Cabrio") e una sottostringa
 * qualsiasi farebbe scattare mezzo catalogo. La marca deve gia' combaciare a monte.
 */
/**
 * COME IL GEMELLO RDW, che le stesse tre regole le aveva gia'.
 *
 * Qui il confronto era la sola frase intera a parola intera, e su Safety Gate non basta:
 * l'archivio e' testo libero scritto dalle autorita' dei vari Stati, dove la BMW Serie 3
 * compare come "3 series", "3series", "3 Series" e mai come "Serie 3". Misurato: cercando
 * "Serie 3" uscivano 2 allerte BMW su 5-7 presenti.
 *
 * Su un dato di SICUREZZA una campagna che non vedi e' peggio di un'allerta in piu' da
 * scartare a occhio, quindi si adottano le due regole in piu' del gemello — spazi collassati
 * ("Z900" = "Z 900") e insieme di parole ("Serie 3" ⊆ "3 series gran turismo") — e le
 * corrispondenze che arrivano DA QUELLE si dichiarano, invece di passare per esatte.
 *
 * @returns {false|'esatto'|'parole'} come ha combaciato, non solo se ha combaciato.
 */
function combacia(modelli, cercato) {
  const q = norm(cercato);
  if (!q) return false;
  // La regex si compila UNA volta per ricerca, non una per modello: dentro il ciclo erano ~400.000
  // compilazioni per costruire l'elenco marche, cioe' quasi tutti i 296 ms di avvio del modulo.
  // Niente escape dei metacaratteri: norm() ha gia' ridotto la stringa a [a-z0-9 ].
  const re = new RegExp('(^| )' + q + '( |$)');   // "Golf A6" aggancia "Golf"; "Golfino" no.
  /**
   * "SERIES" E' "SERIE". Non e' un'intuizione: e' come l'archivio scrive davvero.
   * Sulle 65 allerte BMW le forme presenti sono `3series`, `3 series`, `3 Series` — e
   * `1 series`, `2series`, `5 series`, `7series`… — mentre noi (e il catalogo italiano)
   * scriviamo "Serie 3". Senza questa equivalenza il confronto per insieme di parole non
   * aggancia niente, perche' "serie" non e' "series".
   */
  // E "3series" attaccato e' "3 series": fra una cifra e una lettera c'e' un confine di
  // parola anche quando lo spazio non c'e' — la stessa cosa che si fa gia' per "Z900".
  const spezza = s => s.replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2').replace(/\s+/g, ' ').trim();
  const inglese = s => spezza(s).replace(/\bseries\b/g, 'serie');
  const qi = inglese(q);
  const paroleQ = qi.split(' ').filter(Boolean);
  let perParole = false;
  for (const m of modelli || []) {
    const n0 = norm(m);
    if (!n0) continue;
    if (n0 === q || re.test(n0)) return 'esatto';
    const n = inglese(n0);
    // "Z900" attaccato contro "Z 900" staccato: stessa moto. Uguaglianza, non contenimento —
    // il contenimento farebbe passare "r12" dentro "gsr125". Vale anche per "3series".
    if (n.replace(/ /g, '') === qi.replace(/ /g, '')) { perParole = true; continue; }
    // Solo in questa direzione (cercate dentro dichiarate): "Serie 3" prende "3 SERIE GRAN
    // TURISMO", mentre "500" non prende "500X", che resta una parola sola e un'altra auto.
    if (paroleQ.length > 1) {
      const paroleT = new Set(n.split(' ').filter(Boolean));
      if (paroleQ.every(p => paroleT.has(p))) { perParole = true; continue; }
    }
  }
  return perParole ? 'parole' : false;
}

/**
 * Sigle che la fonte usa al posto del nome per esteso. Tenuta piccola e costruita SUI DATI, non a
 * intuito: sulle 1.041 allerte del triennio l'unica marca che compare sistematicamente con la
 * sigla e' Volkswagen — "VW" 33 volte contro "Volkswagen" 3, piu' "VW - Volkswagen AG" e
 * "VW – Volkswagen". Senza questa riga, cercare "Volkswagen" ne perdeva 33 su 38.
 * Le altre grafie ("Mercedes- Benz", "BMW.", "OPEL.", "Opel/Vauxhall") le risolve gia' da sole la
 * normalizzazione e lo spezzettamento del campo, quindi non entrano qui.
 */
const SIGLE = { vw: 'volkswagen', volkswagen: 'vw' };

/** La marca cercata combacia con una di quelle dell'allerta? Confronto a parola intera. */
function combaciaMarca(marche, cercata) {
  const q = norm(cercata);
  if (!q) return false;
  const forme = [q, SIGLE[q]].filter(Boolean);
  return forme.some(f => combacia(marche, f));
}

/** Allerte di una marca, opzionalmente ristrette a un modello e a un anno. */
function cerca({ marca, modello, anno } = {}) {
  if (!D) return { ok: false, motivo: 'archivio richiami non costruito: lancia scripts/build-safety-gate.js' };
  let a = D.allerte;
  // Il campo marca e' testo libero e puo' portarne piu' d'una ("Opel/Vauxhall", "MAN/Neoplan, Man"):
  // si confronta contro l'elenco spezzato, non contro la stringa intera.
  if (marca) a = a.filter(x => combaciaMarca(x.marche && x.marche.length ? x.marche : [x.marca], marca));
  // Il COME si porta dietro: una corrispondenza trovata per insieme di parole ("Serie 3"
  // dentro "3 series gran turismo") vale, ma chi guarda deve poter distinguere quelle
  // certe dalle probabili — e' un dato di sicurezza, non un'etichetta di prodotto.
  if (modello) {
    a = a.map(x => { const c = combacia(x.modelli, modello); return c ? (c === 'esatto' ? x : { ...x, modelloPerParole: true }) : null; })
         .filter(Boolean);
  }
  if (anno) {
    const y = Number(anno);
    // Senza finestra di produzione non si esclude: l'assenza del dato non e' una prova d'innocenza.
    a = a.filter(x => !x.anni || (y >= x.anni.da - 1 && y <= x.anni.a + 1));
  }
  return { ok: true, allerte: a, totale: a.length };
}

/**
 * L'elenco delle marche NON si prende dal campo grezzo dell'archivio: quello elenca le grafie cosi'
 * come la fonte le scrive, e il numero accanto al nome non corrisponderebbe a quello che si ottiene
 * cliccandolo. Misurato: "Volkswagen" figurava con 3 allerte, ma la ricerca ne restituisce 38
 * perche' le altre 35 stanno sotto "VW", "VW - Volkswagen AG" e "VW – Volkswagen".
 * Qui il conteggio si calcola con LA STESSA funzione che serve la ricerca, e le voci che pescano
 * esattamente le stesse allerte si fondono in una sola — quella col nome piu' esteso, che e' anche
 * quello che un operatore riconosce.
 *
 * Si costruisce ALLA PRIMA richiesta, non al require: e' un incrocio di 200 candidate per 1.034
 * allerte, e faceva 296 ms di lavoro bloccante prima che il server aprisse la porta — pagati a
 * ogni riavvio, anche da chi i richiami non li apre mai.
 */
let _marche = null;
const MARCHE = () => (_marche || (_marche = costruisciMarche()));
function costruisciMarche() {
  if (!D) return [];
  const candidate = new Map();          // chiave normalizzata → grafia piu' frequente
  for (const a of D.allerte) {
    for (const t of (a.marche && a.marche.length ? a.marche : [a.marca]).filter(Boolean)) {
      const k = norm(t);
      if (!k) continue;
      const v = candidate.get(k) || { forme: {}, k };
      v.forme[t] = (v.forme[t] || 0) + 1;
      candidate.set(k, v);
    }
  }
  const voci = [];
  for (const v of candidate.values()) {
    const trovate = D.allerte.filter(a => combaciaMarca(a.marche && a.marche.length ? a.marche : [a.marca], v.k));
    if (!trovate.length) continue;
    const nome = Object.entries(v.forme).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    voci.push({ nome, allerte: trovate.length, _casi: trovate.map(a => a.caso).sort().join('|') });
  }
  // Due voci che pescano ESATTAMENTE le stesse allerte sono la stessa marca scritta in due modi:
  // resta quella col nome piu' lungo ("Volkswagen" invece di "VW").
  const perInsieme = new Map();
  for (const v of voci.sort((a, b) => b.nome.length - a.nome.length)) {
    if (!perInsieme.has(v._casi)) perInsieme.set(v._casi, v);
  }
  return [...perInsieme.values()]
    .map(({ _casi, ...v }) => v)
    .sort((a, b) => b.allerte - a.allerte || a.nome.localeCompare(b.nome, 'it'));
}

function mount(app, deps = {}) {
  // La chiave dei limiti: la PERSONA quando e' entrata, l'indirizzo quando no.
  const chiaveLimite = deps.chiaveLimite || deps.clientIp || (req => req.ip || '');
  const limite = require('./limite-richieste').crea({ max: 60, cosa: 'richieste agli archivi richiami' });

  // `await` anche sui lavori sincroni: quasi tutte queste rotte leggono un file gia' in
  // memoria e rispondono subito, ma quella delle omologazioni interroga l'RDW. Senza
  // attendere, `{ ...promise }` non spande niente e la risposta usciva vuota con ok:true
  // — il caso peggiore, perche' sembra funzionare.
  const via = (percorso, lavoro) => app.get(percorso, async (req, res) => {
    const g = limite.consuma(chiaveLimite(req));
    if (!g.ok) return res.status(429).json({ ok: false, motivo: limite.messaggio(g), riprovaFra: g.attesa, restanti: 0 });
    try {
      const out = await lavoro(req.query || {});
      res.set('Cache-Control', 'public, max-age=3600');
      res.json({ ok: true, ...out });
    } catch (e) {
      console.warn('[richiami] ' + percorso + ' KO:', e.message);
      res.json({ ok: false, motivo: e.message });
    }
  });

  // Stato dell'archivio: quante allerte, quando e' stato costruito, l'avvertenza da mostrare.
  via('/api/richiami/stato', () => (D ? {
    pronto: true,
    totale: D.allerte.length,
    // Le marche CONSOLIDATE, non le grafie grezze dell'archivio: altrimenti lo stato dice 202
    // e l'elenco sotto ne mostra 198, e chi legge non sa a quale credere.
    marche: MARCHE().length,
    marcheGrezze: D.marche.length,
    reportLetti: (D.reportLetti || []).length,
    generatedAt: D.generatedAt,
    fonte: D.fonte,
    avvertenza: D.avvertenza,
    // Quante allerte portano l'omologazione vera: e' la quota su cui il confronto col libretto
    // e' proponibile. Sul resto il campo contiene un nome commerciale o un codice interno.
    conOmologazione: D.allerte.filter(x => x.haOmologazione).length,
    anni: (() => {
      const c = {};
      for (const a of D.allerte) if (a.anno) c[a.anno] = (c[a.anno] || 0) + 1;
      return c;
    })(),
  } : { pronto: false, motivo: 'archivio non costruito: lancia scripts/build-safety-gate.js' }));

  // Le marche con almeno un'allerta, gia' ordinate per numero.
  via('/api/richiami/marche', q => {
    if (!D) return { marche: [], motivo: 'archivio non costruito' };
    const f = norm(q.filtro || '');
    const tutte = MARCHE();
    const m = f ? tutte.filter(x => norm(x.nome).includes(f)) : tutte;
    return { marche: m, totale: m.length };
  });

  // Il tetto e' lo stesso di /ultime. Senza, una richiesta SENZA filtri rispondeva l'archivio
  // intero — misurato: 1.034 allerte, 1,9 MB — e il limite di 60 al minuto per IP lo moltiplicava
  // per sessanta. `totale` resta il conto vero, cosi' si sa quanto e' rimasto fuori.
  via('/api/richiami/cerca', q => {
    const r = cerca({ marca: q.marca, modello: q.modello, anno: q.anno });
    if (!r.ok) return r;
    const n = Math.min(200, Math.max(1, Number(q.quante) || 200));
    return { ...r, allerte: r.allerte.slice(0, n), mostrate: Math.min(r.totale, n) };
  });

  // Le ultime allerte pubblicate: e' la vista che serve per tenere d'occhio la settimana.
  via('/api/richiami/ultime', q => {
    if (!D) return { allerte: [], motivo: 'archivio non costruito' };
    const n = Math.min(200, Math.max(1, Number(q.quante) || 50));
    return { allerte: D.allerte.slice(0, n), totale: D.allerte.length };
  });

  /**
   * LE CAMPAGNE DI RICHIAMO DELL'RDW — seconda fonte, rotte SEPARATE.
   *
   * Non entrano dentro /api/richiami/cerca e non si sommano ad allerte: sono due archivi
   * con due criteri diversi. Safety Gate individua i veicoli per omologazione o telaio e
   * quindi si ferma alla famiglia; l'RDW lega la campagna a marca e tipo in chiaro e il
   * modello lo confronta davvero. Un totale unico dei due non vorrebbe dire niente, e chi
   * legge deve sapere quale fonte gli sta rispondendo.
   */
  via('/api/richiami/rdw/stato', () => rdw.stato());

  via('/api/richiami/rdw/marche', q => {
    const f = norm(q.filtro || '');
    const tutte = rdw.marche();
    const m = f ? tutte.filter(x => norm(x.nome).includes(f)) : tutte;
    return { marche: m, totale: m.length };
  });

  // Stesso tetto delle altre rotte: senza, una richiesta senza filtri risponderebbe
  // l'archivio intero (4.571 campagne, 3,6 MB) sessanta volte al minuto per IP.
  /**
   * DALL'OMOLOGAZIONE ALLE VERSIONI. E' l'unica strada per passare da "questo MODELLO ha
   * un richiamo" a "queste VERSIONI ce l'hanno": l'allerta europea cita il numero di
   * omologazione, e il catalogo RDW quel numero lo apre.
   *
   * Non parte da sola. La chiama chi apre una singola allerta, non chi cerca: due
   * richieste all'RDW per allerta sarebbero un peso inutile su una lista.
   */
  via('/api/richiami/omologazione', async q => {
    if (!q.n) return { ok: false, motivo: 'manca il numero di omologazione' };
    return omo.versioni(String(q.n));
  });

  via('/api/richiami/rdw/cerca', q => {
    const r = rdw.cerca({ marca: q.marca, modello: q.modello, anno: q.anno });
    if (!r.ok) return r;
    const n = Math.min(200, Math.max(1, Number(q.quante) || 200));
    return { ...r, campagne: r.campagne.slice(0, n), mostrate: Math.min(r.totale, n) };
  });
}

module.exports = {
  mount, cerca, _combacia: combacia, _combaciaMarca: combaciaMarca, _dati: D,
  // getter e non valore: leggerlo costruisce l'elenco, senza obbligare chi non lo legge a pagarlo.
  get _marche() { return MARCHE(); },
};
