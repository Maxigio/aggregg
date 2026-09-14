'use strict';
/**
 * LEGGERE UN LOTTO D'ASTA — da quello che il PVP dichiara a quello che possiamo mostrare.
 *
 * Il portale non ha campi per marca, modello, anno, chilometri o stato del veicolo: ha
 * `descLotto`, testo libero scritto a mano da un professionista, mediana 93 caratteri una volta
 * tolto il boilerplate. Spesso e' tutto qui: «Motociclo Piaggio Medley». Questo file estrae quel
 * poco che si puo' estrarre CON UNA PROVA, e per tutto il resto tace.
 *
 * LA REGOLA DI QUESTO FILE E' NON INDOVINARE. Se la marca non si riconosce, `marca` resta null e
 * il lotto viene mostrato lo stesso con la sua descrizione: un dato che non c'e' si dichiara.
 * Misurato sui 619 lotti vivi del 2026-09-01: 80-85% con un confronto grezzo, e i buchi erano
 * quasi tutti di normalizzazione (accento di Citroen, spazio di CF Moto, boilerplate incollato
 * senza spazio a «MV Agusta»). Sono quelli che le tre regole qui sotto chiudono.
 */
const { norm, loadAliasMap } = require('./scrapers/brand-match');

/**
 * IL BOILERPLATE INCOLLATO. Il portale concatena la descrizione con una frase di rito SENZA
 * spazio in mezzo: «Motociclo MV AgustaPer visionare la documentazione…». Se non lo si toglie
 * per primo, l'ultima parola vera resta saldata alla prima del rito e nessuna marca combacia
 * piu'. Si taglia sul testo grezzo proprio perche' il confine di parola non c'e'.
 */
const RITI = [
  /Per visionare la documentazione[\s\S]*/i,
  /Per maggiori informazioni[\s\S]*/i,
  /Si invitano le parti interessate[\s\S]*/i,
];

/**
 * LE PIATTAFORME TELEMATICHE. L'80% dei lotti si vende altrove: il PVP e' solo la vetrina che la
 * legge impone, ma per offrire bisogna registrarsi sul portale del gestore. E' la prima cosa che
 * serve sapere per capire se puoi davvero partecipare, quindi si estrae e si mostra.
 */
const PIATTAFORMA = /\b(?:www\.)?((?:gobid|astegiudiziarie|astalegale|doauction|doacution|astemobili|fallcoaste|industrialdiscount|astetelematiche|garavirtuale|realestatediscount|venditegiudiziarie)\.[a-z]{2,3})\b/i;

/**
 * QUANDO UN LOTTO NON E' UN VEICOLO SOLO. Il 13% delle auto e il 27% delle moto sono cumuli
 * («Auto e furgoni», «N. 1433 Scooter e N. 11 E-bike») o interi compendi di liquidazione. Non si
 * nascondono — un blocco di 1.433 scooter puo' interessare — ma non si spacciano per una moto:
 * chi li mostra li marca.
 */
const CUMULATIVO = [
  /\bn\.?\s*\d+\s*(?:scooter|moto|autov|veicol|ciclomotor|automezz|autocarr)/i,
  /\b\d+\s*(?:scooter|motocicli|autovetture|automezzi|autocarri|veicoli|ciclomotori)\b/i,
  /**
   * LA PAROLA NUDA NON CONTA I BENI, e da sola non basta. «Scooter» in italiano e' invariante, e
   * «veicoli», «autovetture», «automezzi» stanno anche nelle chiuse di rito («in allegato
   * condizioni di vendita veicoli») e nei percorsi del gestore: sui 658 lotti in magazzino la
   * parola secca marcava come cumulo 18 veicoli singoli veri, che poi sparivano dal filtro «solo
   * singoli». Serve una SECONDA categoria dopo una congiunzione o un elenco — «scooter e
   * ciclomotore», «Autovetture AUDI, FORD; autocarri FIAT» — e il salto resta dentro un solo
   * periodo perche' il punto chiude la frase e separa i beni dalle condizioni di vendita.
   */
  /\b(?:autocarri|autovetture|automezzi|motocicli|motoveicoli|ciclomotori|scooter|veicoli)\b[^.]{0,80}?(?:[,;]|\be\b|\bed\b|\boltre\s+a\b)\s*(?:n\.?\s*\d+\s+|altri\s+|vari[ei]\s+)?(?:autocarr|autovettur|automezz|motocicl|motoveicol|ciclomotor|scooter|veicol|furgon)/i,
  /\b(?:beni|compendio|lotto unico composto)\b.*\b(?:liquidazione|fallimentare|aziendal)/i,
  /\be\s+(?:furgoni|arredi|attrezzature|macchinari)\b/i,
];

/**
 * Le parole di contorno che DA SOLE non sono mai una marca. Vale solo per il gruppo di UNA
 * parola: «Moto» singola non e' una marca, ma «Moto Morini» e «CF Moto» lo sono, e togliere la
 * parola dalla sequenza prima di comporre i gruppi spezzava proprio quelle due. Il filtro sta
 * quindi al momento del confronto, non della divisione in parole.
 */
const RUMORE = new Set([
  'lotto', 'lotti', 'unico', 'motociclo', 'motoveicolo', 'ciclomotore', 'scooter', 'moto',
  'auto', 'autovettura', 'autoveicolo', 'automobile', 'autocarro', 'marca', 'modello',
  'targato', 'targata', 'telaio', 'vendita', 'del', 'della', 'di', 'da', 'il', 'la', 'lo',
  'un', 'una', 'tipo', 'anno', 'colore', 'euro', 'immatricolato', 'immatricolata', 'n',
  /**
   * Queste sei sono parole ORDINARIE dell'avviso che nel catalogo esistono anche come marca
   * («km come da quadro di accensione», «carrozzeria di colore nero», «asta online», «stock
   * composto da», «mancante solo di sella», «immatricolato per la prima volta»). Senza il
   * filtro la marca viene inventata dal corpo del testo, che e' il contrario della regola in
   * testa al file. Misurate sui 787 lotti in magazzino: 7 marche sbagliate e zero
   * riconoscimenti veri, perche' nessun lotto e' davvero di quelle marche. Il prezzo del
   * filtro e' che un lotto davvero di marca Quadro finirebbe fra i «senza marca»: e' il verso
   * giusto in cui sbagliare, perche' un dato che non c'e' si dichiara e uno sbagliato no.
   */
  'nero', 'quadro', 'stock', 'online', 'solo', 'volta',
]);

/** Toglie il rito e restituisce la parte che descrive davvero il bene. */
function descrizionePulita(desc) {
  let t = String(desc == null ? '' : desc);
  for (const r of RITI) t = t.replace(r, '');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * L'indice delle marche: da ogni forma normalizzata al nome che mostriamo. Si costruisce UNA
 * volta dal catalogo che l'app ha gia' — nessun elenco di marche scritto a mano qui dentro, se
 * no diverge dal menu il giorno dopo.
 */
function creaIndice(marcheAuto = [], marcheMoto = []) {
  const indice = new Map();
  const metti = (chiave, nome, tipo) => {
    const k = norm(chiave);
    // Sotto le tre lettere si pescano falsi ovunque ("DS" dentro "DSG"): quelle marche si
    // riconoscono solo se il catalogo le da' piu' lunghe.
    if (k.length < 3) return;
    const gia = indice.get(k);
    if (gia) { if (!gia.tipi.includes(tipo)) gia.tipi.push(tipo); return; }
    indice.set(k, { nome, tipi: [tipo], parole: String(chiave).trim().split(/\s+/).length });
  };
  /**
   * Le GRAFIE ALTERNATIVE arrivano da data/brand-aliases.json, lo stesso file che usa il
   * resolver delle ricerche: chi scrive un avviso di vendita batte «MERCEDES», non
   * «Mercedes-Benz», e il gruppo curato ci arriva senza inventare una tabella nuova qui.
   * Il nome MOSTRATO resta quello del catalogo, cosi' l'area Aste e la tendina Marche
   * chiamano la stessa marca allo stesso modo.
   */
  const conAlias = (nome, tipo, alias) => {
    metti(nome, nome, tipo);
    const gruppo = alias[norm(nome)];
    if (gruppo) for (const forma of gruppo) metti(forma, nome, tipo);
  };
  const aliasAuto = loadAliasMap('auto');
  const aliasMoto = loadAliasMap('moto');
  for (const m of marcheAuto) conAlias(m, 'auto', aliasAuto);
  for (const m of marcheMoto) conAlias(m, 'moto', aliasMoto);
  return indice;
}

/**
 * La marca dentro una descrizione libera.
 *
 * Si procede per gruppi di parole vicine (fino a tre), normalizzati con la `norm` del progetto —
 * quella che toglie accenti e separatori. Cosi' «CF Moto» trova CFMOTO e «CITROEN» trova
 * Citroen senza tabelle di eccezioni. Vince il gruppo PIU' LUNGO che combacia, se no «Moto
 * Morini» verrebbe letto come «Morini» e «Harley Davidson» come nulla.
 *
 * @returns {{nome: string, tipi: string[]}|null} null significa «non lo so», ed e' una risposta.
 */
function marcaDa(descrizione, indice) {
  const parole = descrizionePulita(descrizione).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let vinta = null;
  for (let i = 0; i < parole.length; i++) {
    for (let n = Math.min(3, parole.length - i); n >= 1; n--) {
      // Una parola sola di contorno non e' una marca; il gruppo lungo che la contiene si'.
      if (n === 1 && RUMORE.has(parole[i].toLowerCase())) continue;
      const gruppo = parole.slice(i, i + n);
      // Incollare le parole vicine serve a «CF Moto» → CFMOTO, ma una parola di UNA lettera non
      // e' mai un pezzo di marca: nessun nome del catalogo ne contiene una. Senza questa guardia
      // «… VENDITA A CURA DEL CUSTODE …» si incolla in «acura» e diventa la marca Acura.
      if (n > 1 && gruppo.some(p => p.length === 1)) continue;
      const trovata = indice.get(norm(gruppo.join('')));
      if (!trovata) continue;
      // Il piu' lungo vince, e a parita' vince il primo incontrato: in queste descrizioni la
      // marca sta quasi sempre all'inizio, dopo «Motociclo»/«Autovettura».
      if (!vinta || trovata.parole > vinta.parole) vinta = trovata;
      break;
    }
  }
  return vinta ? { nome: vinta.nome, tipi: vinta.tipi } : null;
}

/** «08/01/2024» → «2024-01-08». Il PVP mescola i due formati dentro lo stesso oggetto. */
function aIso(d) {
  const s = String(d == null ? '' : d).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Da lotto grezzo del PVP alla riga che teniamo noi.
 *
 * NON entrano qui dentro i `soggetti` del dettaglio: nome, cellulare, email e codice fiscale del
 * referente sono dati personali, pubblicati dal ministero ma non roba da ricopiare in un nostro
 * magazzino. Chi li vuole apre l'annuncio sul portale.
 */
function leggi(grezzo, indice, tipo) {
  const desc = descrizionePulita(grezzo.descLotto);
  const marca = indice ? marcaDa(grezzo.descLotto, indice) : null;
  const ind = grezzo.indirizzo || {};
  const piattaforma = String(grezzo.descLotto || '').match(PIATTAFORMA);
  /**
   * IL SEGNALE BUONO E' STRUTTURATO, non e' la mia regex: `categoriaBene` e' un ARRAY con una
   * voce per bene, quindi piu' di una voce vuol dire piu' di un veicolo — e lo dice la fonte,
   * non un'espressione regolare sul testo. Ne pesca 12 che il testo non tradiva, fra cui un
   * ["AUTOVETTURE" x4]. I due segnali restano tutti e due perche' pescano cose diverse: un
   * lotto con un solo `categoriaBene` puo' comunque dire «N. 1433 Scooter».
   */
  const beni = Array.isArray(grezzo.categoriaBene) ? grezzo.categoriaBene.length : 1;
  /**
   * Il link alla piattaforma porta i nomi delle CATEGORIE del catalogo del gestore
   * («…/Detail/S1049805-Autovetture-Autovettura-Lancia-Y»), non i beni di QUESTO lotto: si toglie
   * prima di cercare il cumulo, se no e' l'URL a decidere al posto della descrizione. Il testo
   * mostrato resta intero: qui si ripulisce solo la copia su cui si misura.
   */
  const testoBeni = desc.replace(/https?:\/\/\S+/gi, ' ');
  return {
    id: grezzo.id,
    tipo,
    descrizione: desc,
    marca: marca ? marca.nome : null,        // null = non riconosciuta, e si dice
    cumulativo: beni > 1 || CUMULATIVO.some(r => r.test(testoBeni)),
    piattaforma: piattaforma ? piattaforma[1].toLowerCase() : null,
    prezzoBase: Number.isFinite(grezzo.prezzoBaseAsta) ? grezzo.prezzoBaseAsta : null,
    offertaMinima: Number.isFinite(grezzo.offertaMinima) ? grezzo.offertaMinima : null,
    rialzoMinimo: Number.isFinite(grezzo.rialzoMinimo) ? grezzo.rialzoMinimo : null,
    dataVendita: aIso(grezzo.dataVendita),
    orarioVendita: grezzo.orarioVendita || null,
    dataPubblicazione: aIso(grezzo.dataPubblicazione),
    citta: ind.citta || null,
    provincia: ind.provincia || null,
    tribunale: grezzo.tribunale || null,
    numeroLotto: grezzo.numeroLotto || null,
    procedura: grezzo.procedura || null,
  };
}

module.exports = { leggi, marcaDa, creaIndice, descrizionePulita, aIso, _re: { CUMULATIVO, PIATTAFORMA, RITI } };
