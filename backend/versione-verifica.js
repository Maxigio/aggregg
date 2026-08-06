'use strict';
/**
 * LA VERSIONE LA VERIFICHIAMO NOI, UGUALE PER TUTTE LE FONTI.
 *
 * Prima decideva ogni fonte per conto suo, e non decidevano la stessa cosa. Misurato su 36
 * osservazioni (8 modelli, due forme della stessa intenzione):
 *
 *   Autoscout  100% di precisione, 16 casi su 16 — filtra sul CAMPO versione, nativo
 *   Subito     mediana 82%, MAI 100% — filtra sul TITOLO scritto dal venditore (`q=`)
 *   Moto.it    100% o 0% — o traduce il testo in un codice, o lascia perdere in silenzio
 *
 * Non e' che una fonte sia fatta male: e' che la stessa richiesta viene applicata a tre dati
 * diversi, e uno solo dei tre e' quello che il veicolo dichiara di essere. Da qui nasceva
 * l'impurita': in una lista mista un annuncio su cinque della colonna Subito non porta la
 * versione chiesta, e niente lo distingue dagli altri.
 *
 * Qui il controllo e' uno solo e guarda cio' che l'ANNUNCIO dichiara di se'. La query alla
 * fonte resta — costa poco e restringe — ma smette di essere quella che decide. Una fonte che
 * ha ignorato la versione si scopre da sola: i suoi annunci non passano.
 *
 * DUE LIVELLI, e il secondo copre esattamente il buco del primo.
 *   1. il CAMPO dichiarato. Misurato: 89% degli annunci Subito, 100% di Moto.it.
 *   2. il TITOLO, ma SOLO dove il campo manca o dice "Altro allestimento" — l'11% restante.
 *      Li' l'informazione c'e' davvero ("Golf 2.0 TSI GTI Edition 50 DSG" con campo
 *      "Altro allestimento"). Cercare nel titolo di TUTTI e' invece proprio il gesto che
 *      produceva la sporcizia.
 *
 * Gli attributi tecnici (potenza, cilindrata, cambio) restano fuori, e non per pigrizia:
 * servirebbero su Subito, dove pero' la cilindrata e' dichiarata sullo 0% degli annunci e i
 * CV sul 54%, mentre il nome-versione porta i CV nel 29% dei casi — copertura reale attorno a
 * un caso su sei. Su Autoscout coprirebbero molto, ma li' la precisione e' gia' 100%.
 */

/** I segnaposto con cui un venditore dice "non te lo dico". Non sono versioni. */
const SEGNAPOSTO = /^(altro|altr[oa]\s+(allestimento|modello|versione)|non\s+dichiarat\w*|n\.?d\.?)$/i;

/**
 * Testo → parole confrontabili. I numeri con la virgola decimale restano interi ("2.0" e'
 * una parola sola, non "2" e "0"): sono meta' dei nomi-versione italiani, e spezzarli
 * farebbe combaciare "2.0" con qualunque annuncio che contenga un 2 e uno 0.
 */
function parole(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.]+/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^\.+|\.+$/g, ''))
    .filter(t => t.length >= 2 || /^\d$/.test(t));
}

/** Il campo dichiarato, o null se il venditore ha scelto "altro". */
function dichiarata(annuncio) {
  for (const c of [annuncio && annuncio.variante, annuncio && annuncio.versione]) {
    const v = String(c == null ? '' : c).trim();
    if (v && !SEGNAPOSTO.test(v)) return v;
  }
  return null;
}

/**
 * L'esito, per UN annuncio.
 *   'confermata'  quello che l'annuncio dichiara contiene la versione chiesta
 *   'smentita'    dichiara qualcosa, e non e' quella
 *   'ignota'      non dichiara niente e il titolo non aiuta: non si puo' dire
 *
 * @returns {{esito:'confermata'|'smentita'|'ignota', dove:'campo'|'titolo'|null}}
 */
function verifica(annuncio, richiesta) {
  const cercate = parole(richiesta);
  if (!cercate.length) return { esito: 'confermata', dove: null };   // niente chiesto, niente da smentire

  const campo = dichiarata(annuncio);
  if (campo) {
    const dentro = new Set(parole(campo));
    return { esito: cercate.every(p => dentro.has(p)) ? 'confermata' : 'smentita', dove: 'campo' };
  }

  // Il campo dice "altro": l'informazione, se c'e', sta nel titolo. Solo qui.
  const titolo = String((annuncio && annuncio.titolo) || '').trim();
  if (!titolo) return { esito: 'ignota', dove: null };
  const dentro = new Set(parole(titolo));
  return { esito: cercate.every(p => dentro.has(p)) ? 'confermata' : 'smentita', dove: 'titolo' };
}

/**
 * Marca una lista intera. NON toglie niente: chi guarda decide, e il totale resta onesto.
 * Togliere qui vorrebbe dire che il browser non puo' piu' rimetterli, e la riga
 * "mostrali" non avrebbe cosa mostrare.
 */
function marca(risultati, richiesta) {
  const conto = { confermata: 0, smentita: 0, ignota: 0 };
  const perFonte = {};
  for (const r of risultati || []) {
    const v = verifica(r, richiesta);
    r.versioneEsito = v.esito;
    r.versioneDove = v.dove;
    conto[v.esito]++;
    const f = perFonte[r.fonte] || (perFonte[r.fonte] = { confermata: 0, smentita: 0, ignota: 0 });
    f[v.esito]++;
  }
  return { conto, perFonte };
}

module.exports = { verifica, marca, parole, dichiarata, SEGNAPOSTO };
