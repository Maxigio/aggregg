'use strict';
/**
 * IL GIRO DELLE ASTE — dal portale del ministero al magazzino locale, una volta al giorno.
 *
 * Perche' una volta al giorno e non a ogni apertura: le aste si pubblicano con settimane di
 * anticipo (per gli immobili la legge impone 45 giorni), quindi il dato cambia lento; e il PVP e'
 * un servizio pubblico, non una fonte commerciale da spremere. Un giro intero costa una trentina
 * di chiamate con la pausa, e restituisce ~620 veicoli vivi in tutta Italia.
 *
 * NON SI GUARDA L'OROLOGIO, SI GUARDA L'ETA' DELL'ULTIMO GIRO. E' il modo di questo repo per non
 * aver bisogno di un cron (stesso stampo del boot-check delle ricerche salvate): se l'ultimo giro
 * riuscito e' piu' vecchio di un giorno se ne fa un altro, e basta. Cosi' funziona uguale sul Mac
 * di casa acceso sempre e su un portatile che si riaccende dopo una settimana.
 */
const pvp = require('./scrapers/pvp');
const db = require('./aste-db');
const { leggi, creaIndice } = require('./aste-lotto');

/** Il ritardo dopo l'avvio, per non competere con gli altri giri di partenza (prewarm, saved). */
const RITARDO_AVVIO_MS = 20000;
/** Ogni quanto ci si sveglia a CONTROLLARE se il giro serve. Il giro vero resta uno al giorno. */
const CONTROLLO_MS = 60 * 60 * 1000;

// ─── L'indice delle marche ───────────────────────────────────────────────────────────────────

let indice = null;

/**
 * Le marche che l'app conosce gia', nella stessa forma in cui le mostra la tendina: il catalogo
 * `models.json` piu' le marche che vivono solo nel catalogo Moto.it. Non si scrive un elenco a
 * mano qui dentro — diverge dal menu il giorno dopo, ed e' proprio l'errore che
 * `/api/brands` documenta (server.js:783-798).
 */
function indiceMarche() {
  if (indice) return indice;
  let models = { auto: {}, moto: {} };
  try { models = require('../data/models.json'); } catch (_) { /* senza catalogo si legge meno, non si rompe */ }
  const moto = new Set(Object.keys(models.moto || {}));
  try {
    const cat = require('../data/motoit-catalogo.json');
    for (const [slug, m] of Object.entries((cat && (cat.marche || cat)) || {})) {
      if (m && Object.keys(m.modelli || {}).length) moto.add(m.nome || slug);
    }
  } catch (_) { /* il catalogo Moto.it e' un di piu': senza, restano le marche di models.json */ }
  indice = creaIndice(Object.keys(models.auto || {}), [...moto]);
  return indice;
}

// ─── Il giro ─────────────────────────────────────────────────────────────────────────────────

/**
 * Un giro solo alla volta, e chi arriva secondo si attacca al primo invece di farne un altro.
 * Stesso stampo della dedup in volo di `runSearch` (server.js:1440): senza, l'avvio automatico e
 * un clic su "aggiorna" partiti insieme farebbero due giri completi sulla stessa fonte.
 */
let inVolo = null;

async function giro({ pausaMs = 400 } = {}) {
  if (inVolo) return inVolo;
  inVolo = (async () => {
    const idx = indiceMarche();
    const id = db.iniziaGiro();
    const conto = { visti: 0, nuovi: 0, spariti: 0 };
    try {
      for (const tipo of Object.keys(pvp.TIPOLOGIE)) {
        // Il tipo gia' commesso da un giro caduto non si riscarica: la sua transazione ha gia'
        // committato, e senza questo salto ogni controllo orario rifaceva da capo anche quello
        // (vedi aste-db.stantioTipo). Dopo un giro riuscito tornano stantii tutti e due.
        if (!db.stantioTipo(tipo)) {
          console.log(`[aste] ${tipo}: gia' a magazzino dal giro caduto, si salta`);
          continue;
        }
        const { lotti, troncato } = await pvp.tutti(tipo, { pausaMs });
        if (troncato) console.warn(`[aste] ${tipo}: paginazione troncata al tetto, l'inventario e' parziale`);
        /**
         * SOLO LE VENDITE FUTURE (decisione del proprietario). Il filtro lo facciamo QUI perche'
         * la fonte non lo fa: il suo `dataVenditaDa` viene accettato e ignorato — misurato,
         * tornano gli stessi lotti col piu' vecchio al 2024. Il 90% dell'archivio e' passato.
         * Il tetto in alto scarta le date assurde: c'e' un lotto datato 2034 con "anno 2088"
         * nella descrizione, perche' il portale non valida quello che i professionisti scrivono.
         */
        const oggi = new Date().toISOString().slice(0, 10);
        const limite = String(new Date().getFullYear() + 5);
        const vivi = lotti
          .map(l => leggi(l, idx, tipo))
          .filter(l => l.dataVendita && l.dataVendita >= oggi && l.dataVendita < limite + '-01-01');
        /**
         * ZERO LOTTI DALLA FONTE NON E' UNA NOTIZIA, E' UN GUASTO. Il portale ne ha 5.758 in
         * archivio (intestazione di pvp.js), e la ricerca glieli chiede per ENUM: basta che il
         * ministero ne rinomini uno (`tipoLotto`, `categoriaLotto`, `categoriaBene`) e la
         * risposta e' un 200 con l'involucro giusto e zero risultati — nessuno lancia. Senza
         * questa guardia `sostituisci` marcherebbe sparito TUTTO l'inventario del tipo e il giro
         * si scriverebbe 'ok': l'area resterebbe vuota, senza avviso e timbrata «aggiornato
         * oggi», fino al giorno dopo. Fallendo invece si tiene quel che c'e' e `stantio()` resta
         * vero, quindi il controllo dell'ora dopo riprova.
         *
         * Si conta il GREZZO della fonte, non `vivi`: un archivio di sole vendite passate e' un
         * inventario vuoto legittimo. E a magazzino vuoto (primo giro) non c'e' niente da
         * difendere, quindi si prosegue.
         */
        if (!lotti.length && db.cerca({ tipo, limite: 1 }).length) {
          throw new Error(`${tipo}: il portale non ha restituito nessun lotto, magazzino non toccato`);
        }
        const r = db.sostituisci(tipo, vivi);
        conto.visti += r.visti; conto.nuovi += r.nuovi; conto.spariti += r.spariti;
        console.log(`[aste] ${tipo}: ${r.visti} vivi su ${lotti.length} in archivio (${r.nuovi} nuovi, ${r.spariti} spariti)`);
      }
      db.potaSpariti();
      db.chiudiGiro(id, { esito: 'ok', ...conto });
      return { ok: true, ...conto };
    } catch (e) {
      // Un giro fallito NON rimanda il prossimo: `stantio()` guarda solo i giri riusciti, quindi
      // al controllo dopo si riprova. Una fonte che non risponde si dichiara e si ritenta.
      try { db.chiudiGiro(id, { esito: 'ko', motivo: e.message }); } catch (_) { /* magazzino rotto: gia' detto */ }
      console.warn('[aste] giro KO:', e.message);
      return { ok: false, motivo: e.message };
    }
  })();
  // `finally` QUI FUORI, non dentro la IIFE: `indiceMarche()` e `db.iniziaGiro()` stanno prima
  // del try, e un loro lancio (magazzino non apribile, SQLITE_BUSY, cartella assente) rifiuta la
  // Promise senza mai passare dal finally interno. `inVolo` resterebbe la rifiutata e ogni giro
  // successivo ripeterebbe il vecchio errore fino al riavvio, anche a guasto passato.
  try { return await inVolo; } finally { inVolo = null; }
}

/** Fa il giro solo se serve. Torna `{ ok, saltato }` — saltato non e' un fallimento. */
async function assicura() {
  if (!db.stantio()) return { ok: true, saltato: true };
  return giro();
}

// ─── L'avvio automatico ──────────────────────────────────────────────────────────────────────

let timer = null;

/**
 * Il primo giro parte poco dopo l'avvio (se serve), poi si controlla ogni ora. Il controllo e'
 * quasi sempre un no-op: e' `stantio()` a decidere, e legge una riga sola dal magazzino.
 */
function avvia() {
  if (timer) return;                       // unica difesa dal doppio avvio, come startKeepAlive
  setTimeout(() => { assicura().catch(e => console.warn('[aste] giro d\'avvio KO:', e.message)); },
    RITARDO_AVVIO_MS).unref?.();
  timer = setInterval(() => { assicura().catch(e => console.warn('[aste] giro KO:', e.message)); },
    CONTROLLO_MS);
  timer.unref?.();                         // senno' il processo non muore mai e i test si appendono
}

function ferma() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  giro, assicura, avvia, ferma, indiceMarche,
  _const: { RITARDO_AVVIO_MS, CONTROLLO_MS },
  _reset: () => { indice = null; inVolo = null; ferma(); },
};
