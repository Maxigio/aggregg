'use strict';
/**
 * DAL TESTO SCRITTO AL CODICE-VERSIONE DI MOTO.IT.
 *
 * E' l'unica traduzione che il campo versione fa. Subito e Autoscout una ricerca testuale
 * ce l'hanno e ricevono quello che hai scritto; Moto.it vuole un codice opaco (`bike=`),
 * quindi li' il testo va risolto — contro il catalogo di Moto.it, non contro un altro.
 *
 * DUE COSE MISURATE, ed e' il motivo per cui questo file esiste invece di un `indexOf`.
 *
 * 1. I NOMI DI MOTO.IT SI PORTANO DENTRO IL MODELLO E GLI ANNI: "MT-07 ABS (2014 - 16)",
 *    non "ABS". Confrontando il testo cosi' com'e', le parole del modello combaciano da
 *    sole e sembra che abbia riconosciuto una versione quando ha solo ri-riconosciuto il
 *    modello — che avevamo gia' filtrato. Misurato: lasciandocele, lo "zero" scende allo
 *    0,6%, che sembra un successo; togliendole viene 61%, ed e' il numero vero (sei
 *    titoli su dieci un allestimento non lo nominano affatto).
 *
 * 2. L'AND ASSOLUTO SVUOTA. Una parola che quel catalogo non scrive azzera tutto, e a
 *    schermo "nessun risultato" e' indistinguibile da "non esistono moto cosi'". Quindi
 *    la parola che azzererebbe si SCARTA, e si dice quale.
 *
 * PIU' CODICI NON SI POSSONO CHIEDERE — verificato: `bike=a,b` prende il primo e ignora
 * il secondo senza dare errore, `bike=a|b` risponde vuoto. Ma non serve chiederli: Moto.it
 * SPEZZA LA STESSA MOTO PER PERIODO ("MT-07 (2014-16)", "(2017-18)", "(2018-20)",
 * "(2021-24)" sono quattro voci della stessa moto), e ogni annuncio dichiara la propria
 * versione nello slug dell'URL. Quindi:
 *
 *   una sola versione risolta  → si filtra alla fonte con `bike=`
 *   piu' d'una                 → niente `bike=`, e si tengono gli annunci il cui slug sta
 *                                fra quelle risolte. Esatto, e zero richieste in piu'.
 *
 * Non si sceglie mai una versione fra piu' candidate: mostrerebbe una moto diversa da
 * quella chiesta senza che si veda.
 */

const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Parole intere; lettere e cifre restano attaccate dove lo sono ("35kw" → "35kw"). */
const parole = s => norm(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * Lo slug che Moto.it mette nell'URL dell'annuncio, ricavato dal nome della versione.
 *   "MT-07 (2014 - 16)"      → "mt-07-2014-16"
 *   "SH 125 i ABS (2013-17)" → "sh-125-i-abs-2013-17"
 * Verificato sugli URL veri: e' il quarto segmento del percorso.
 */
function slugVersione(nome) {
  return norm(nome).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Lo slug-versione di un URL annuncio Moto.it, o null. */
function slugDaUrl(url) {
  const p = String(url || '').split('?')[0].split('/');
  // …/moto-usate/<marca>/<modello>/<versione>/<id>
  return p.length >= 7 ? p[6] || null : null;
}

/**
 * LA VERSIONE CHE L'ANNUNCIO DICHIARA, letta dal suo URL.
 *
 * Moto.it mette nell'URL `…/moto-usate/<marca>/<modello>/<versione>/<id>`, e la parte
 * `<versione>` e' fatta cosi': il nome del modello, poi le parole della versione, poi il
 * periodo. Forme vere, prese da annunci veri:
 *   cb-500-1993-04                    → nessun nome di versione, periodo 1993–2004
 *   cb-500-s-1997-04                  → "S", 1997–2004
 *   cb-500-x-abs-travel-edition-2015-16 → "X ABS Travel Edition", 2015–2016
 *   cb-500-x-2021                     → "X", 2021
 *
 * Serve perche' l'app scriveva "Il venditore non ha indicato la versione" su annunci che la
 * versione la dichiarano eccome — e due di quelli, "cb-500" e "cb-500-s", sono due moto
 * diverse. Il dato c'era gia' e lo usavamo per FILTRARE: era solo l'etichetta a ignorarlo.
 *
 * @param {string} slug         lo slug-versione (da `slugDaUrl`)
 * @param {string} modelloSlug  lo slug del modello, che si toglie dal davanti; puo' essere
 *                              una LISTA di famiglie separate da virgola (vedi sotto)
 * @returns {string|null} es. "S · 1997–2004", "1993–2004", null se lo slug non si legge
 */
function varianteDaSlug(slug, modelloSlug) {
  const s = String(slug || '').trim();
  if (!s) return null;
  // Il periodo in coda: un ANNO di quattro cifre, e facoltativamente altre due per l'anno di
  // fine. L'anno va preteso: senza il vincolo "19xx/20xx" la cilindrata in coda al nome passa
  // per periodo — misurato sul catalogo, 30 versioni su 12.192 ("YB11 1000" → periodo 1000,
  // "Monster S2R 1000" → 1000), e una cilindrata spacciata per anno di produzione e' un dato
  // inventato. Gli anni veri del catalogo stanno fra il 1973 e il 2027.
  const m = s.match(/-((?:19|20)\d{2})(?:-(\d{2}))?$/);
  const testa = m ? s.slice(0, m.index) : s;
  // L'anno di fine e' a DUE cifre e puo' scavalcare il secolo: "1993-04" e' 1993–2004, non
  // 1993–1904. Si prende il secolo dell'anno d'inizio e, se il conto viene all'indietro, si
  // aggiungono cento anni.
  let periodo = null;
  if (m) {
    if (!m[2]) periodo = m[1];
    else {
      const da = Number(m[1]);
      let a = Math.floor(da / 100) * 100 + Number(m[2]);
      if (a < da) a += 100;
      periodo = `${da}–${a}`;
    }
  }
  /**
   * IL MODELLO PUO' ARRIVARE COME LISTA, e va tolto lo stesso. `famiglieMotoit` risponde con
   * piu' famiglie separate da virgola quando il nome chiesto e' largo ("Scarabeo" →
   * scarabeo-50,scarabeo-125,scarabeo-500): confrontata intera, quella stringa non combacia
   * mai e il nome del modello restava DENTRO la versione — "SCARABEO 500 · 2003–2006" nella
   * colonna dove Subito e Autoscout scrivono la sola versione. E' la trappola descritta in
   * cima a questo file: sembra una versione riconosciuta, ed e' solo il modello.
   * Vince la famiglia PIU' LUNGA che combacia: su "scarabeo-500-s", fra "scarabeo" e
   * "scarabeo-500", il modello e' il secondo.
   */
  const mods = String(modelloSlug || '').split(',').map(s => s.trim()).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let nome = testa;
  let tolto = false;
  for (const mod of mods) {
    if (testa === mod || testa.startsWith(mod + '-')) { nome = testa.slice(mod.length).replace(/^-+/, ''); tolto = true; break; }
  }
  /**
   * E SE NESSUNA FAMIGLIA COMBACIA, il modello resta dentro lo stesso — stessa trappola, altra
   * porta. Due casi veri: la famiglia non c'e' (ricerca allargata alla marca, `modelloSlug`
   * nullo: non c'e' niente da togliere) e la versione non ripete lo slug della sua famiglia —
   * misurate 998 su 12.192 (8,2%): benelli `trk-502` contiene "TRK 502X", bmw
   * `r-1200-gs-adventure` contiene "R 1200 GS", e in colonna uscivano "TRK 502X · 2018–2020"
   * e "R 1200 GS · 2017–2018", cioe' il nome di una MOTO dove Subito e Autoscout scrivono il
   * solo allestimento — accanto, nella stessa lista, alle righe pulite della stessa famiglia.
   * Senza una famiglia che combaci non si sa dove finisce il modello e dove comincia
   * l'allestimento: si dice il solo periodo, che e' certo, e il modello si legge nel titolo.
   */
  if (!tolto) nome = '';
  const parole = nome ? nome.split('-').filter(Boolean).map(w => w.toUpperCase()).join(' ') : '';
  if (parole && periodo) return `${parole} · ${periodo}`;
  return parole || periodo || null;
}

/**
 * @param {Array}  bikes   [{name, code}] da motoit-models.getModelBikes
 * @param {string} testo   quello che l'utente ha scritto
 * @param {object} ctx     {marca, modello} — le loro parole escono dal confronto
 * @returns {{versioni:Array, tenute:Array, scartate:Array}}
 *          `versioni` vuoto = il testo non dice niente che questo catalogo conosca.
 */
function risolvi(bikes, testo, ctx = {}) {
  const out = { versioni: [], tenute: [], scartate: [] };
  const lista = (bikes || []).filter(b => b && b.name && b.code);
  if (!lista.length || !String(testo || '').trim()) return out;

  const via = new Set([...parole(ctx.marca), ...parole(ctx.modello)]);
  const chieste = parole(testo).filter(w => !via.has(w));
  if (!chieste.length) return out;

  const dentro = lista.map(b => ({ b, p: ' ' + parole(b.name).join(' ') + ' ' }));
  let vivi = dentro;
  for (const w of chieste) {
    const prossimi = vivi.filter(x => x.p.includes(' ' + w + ' '));
    if (prossimi.length) { vivi = prossimi; out.tenute.push(w); }
    else out.scartate.push(w);
  }
  if (!out.tenute.length) return out;      // niente riconosciuto: nessun filtro, e si dice

  out.versioni = vivi.map(x => ({ nome: x.b.name, code: x.b.code, slug: slugVersione(x.b.name) }));
  return out;
}

module.exports = { risolvi, slugVersione, slugDaUrl, varianteDaSlug, _parole: parole };
