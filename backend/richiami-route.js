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

let D = null;
try { D = require(path.join(__dirname, '..', 'data', 'safety-gate.json')); } catch (_) { D = null; }

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Un modello dell'allerta combacia col testo cercato? Si pretende la parola INTERA, non un pezzo:
 * i nomi nell'archivio sono spezzoni di testo libero ("Plus", "CC", "Cabrio") e una sottostringa
 * qualsiasi farebbe scattare mezzo catalogo. La marca deve gia' combaciare a monte.
 */
function combacia(modelli, cercato) {
  const q = norm(cercato);
  if (!q) return false;
  for (const m of modelli || []) {
    const n = norm(m);
    if (!n) continue;
    if (n === q) return true;
    // "Golf A6" combacia con "Golf"; "Golf" NON combacia con "Golfino".
    const re = new RegExp('(^| )' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)');
    if (re.test(n)) return true;
  }
  return false;
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
  if (modello) a = a.filter(x => combacia(x.modelli, modello));
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
 */
const MARCHE = (() => {
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
})();

function mount(app, deps = {}) {
  const clientIp = deps.clientIp || (req => req.ip || '');
  const hits = new Map();
  const rateOk = ip => {
    const now = Date.now();
    if (hits.size > 5000) hits.clear();
    const v = (hits.get(ip) || []).filter(t => now - t < 60000);
    v.push(now); hits.set(ip, v); return v.length <= 60;
  };

  const via = (percorso, lavoro) => app.get(percorso, (req, res) => {
    if (!rateOk(clientIp(req))) return res.status(429).json({ ok: false, motivo: 'Troppe richieste.' });
    try {
      const out = lavoro(req.query || {});
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
    marche: MARCHE.length,
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
    const m = f ? MARCHE.filter(x => norm(x.nome).includes(f)) : MARCHE;
    return { marche: m, totale: m.length };
  });

  via('/api/richiami/cerca', q => cerca({ marca: q.marca, modello: q.modello, anno: q.anno }));

  // Le ultime allerte pubblicate: e' la vista che serve per tenere d'occhio la settimana.
  via('/api/richiami/ultime', q => {
    if (!D) return { allerte: [], motivo: 'archivio non costruito' };
    const n = Math.min(200, Math.max(1, Number(q.quante) || 50));
    return { allerte: D.allerte.slice(0, n), totale: D.allerte.length };
  });
}

module.exports = { mount, cerca, _combacia: combacia, _combaciaMarca: combaciaMarca, _marche: MARCHE, _dati: D };
