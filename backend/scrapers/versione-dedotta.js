'use strict';
/**
 * LA VERSIONE CHE IL VENDITORE NON HA DICHIARATO, letta da quello che ha scritto.
 *
 * Su Subito la versione e' un menu con un id di catalogo. Nel 13% degli annunci quel menu
 * resta vuoto — ma la versione il venditore l'ha scritta lo stesso, nel titolo o nel corpo,
 * a parole sue. Il dato c'e', non sta dove lo cerchiamo.
 *
 * IL VOCABOLARIO E' CHIUSO. Le uniche risposte possibili sono le versioni che Subito stessa
 * ha in catalogo per QUEL modello e QUELLA generazione (l'annuncio la dichiara sempre).
 * Non si inventa un nome mai visto: si riconosce, o si tace.
 *
 * PERCHE' NON BASTA CERCARE IL NOME NEL TESTO. Provato: funziona nell'8,5% dei casi.
 *   annuncio   Volkswagen Golf 1.0 eTSI 81kW EVO Life DSG
 *   catalogo   Golf 1.5 eTSI 150 CV EVO ACT DSG 1st Edition Style
 * Le informazioni ci sono quasi tutte, in un altro ordine, coi kW al posto dei CV. Un
 * confronto fra stringhe vede due testi diversi e si ferma.
 *
 * SI RIBALTA LA DIFFICOLTA'. Un nome-versione e' fatto quasi tutto di cose che l'annuncio
 * gia' dichiara altrove, in forma strutturata:
 *
 *   Golf   1.5   eTSI   150 CV   DSG     5 porte   Style
 *          cc    carb.  potenza  cambio  porte     ← l'unica cosa nuova
 *
 * Quindi si parsa il CATALOGO, che e' pulito e non cambia, e il testo serve solo per
 * l'allestimento. Le parole d'allestimento per modello sono poche: contate su tutti i
 * 2.689 modelli auto, la MEDIANA E' SETTE. Non e' linguaggio naturale, e' una lista corta.
 *
 * DUE LIVELLI, E IL TERZO E' STATO BUTTATO. Misurato su 6.472 annunci che la versione la
 * dichiarano — nascosta, dedotta, riconfrontata:
 *
 *   esatta         il nome completo del catalogo e' scritto nel testo   1,9% sbagliato
 *   allestimento   restano piu' versioni, tutte lo stesso allestimento  8,2% sbagliato
 *   [buttato]      i vincoli lasciano UNA sola versione                15,6% sbagliato
 *
 * IL TERZO ERA QUELLO A CUI AVEVO PENSATO PER PRIMO, e la misura l'ha bocciato. Il motivo
 * si vede solo misurando sul profilo giusto: chi non dichiara la versione non dichiara
 * neanche il resto — la potenza c'e' nell'88% degli annunci completi e solo nel 33% di
 * quelli col buco. Rifatta la prova TOGLIENDO LA POTENZA A TUTTI, cioe' nelle condizioni
 * in cui quel livello dovrebbe davvero lavorare, l'errore sale al 25%: un caso su quattro
 * e' un'altra auto. Senza il vincolo piu' selettivo l'esclusione lascia in piedi troppe
 * candidate, e la scelta finale e' un tiro a indovinare travestito da deduzione.
 * Gli altri due non si muovono: 'esatta' non usa la potenza, quindi non ne sente la
 * mancanza, e 'allestimento' afferma cosi' poco che regge (9,6%).
 *
 * COSA CONTA COME SBAGLIO. "320d Touring" contro "320d Efficient Dynamics Business
 * Advantage" non e' un'altra auto: e' la stessa detta con meno parole. Diventa uno sbaglio
 * quando si afferma qualcosa che il vero contraddice — noi "Sport", il catalogo
 * "Business Advantage".
 *
 * CHI LA USA DEVE DIRE CHE E' DEDOTTA. La differenza fra "e' questa" e "dovrebbe essere
 * questa" e' tutta li', e chi legge non ha modo di accorgersene da solo.
 *
 * FUNZIONE PURA: niente rete, niente file letti qui dentro. Il catalogo arriva da fuori
 * (backend/scrapers/versioni-unificate.js lo tiene gia' in cache per marca). Stessa forma
 * di risolvi-versione.js, che fa il lavoro gemello sulle moto, e per la stessa ragione:
 * una funzione pura si prova in millisecondi e la si sbaglia una volta sola.
 */

const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  // La virgola decimale italiana diventa punto PRIMA della pulizia: "1,9 TDI" usciva
  // "1 9 tdi" e i rami [.,] scritti apposta per accoglierla erano codice morto — la
  // deduzione scendeva da «esatta» ad «allestimento», affermando una compatibilita'
  // falsa («3 versioni compatibili», fra cui una 1.6 e una 2.0) su una cilindrata
  // che l'annuncio dichiarava.
  .replace(/(\d),(\d)/g, '$1.$2')
  .replace(/[^a-z0-9.&+]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * LE FAMIGLIE DI TOKEN, ricavate contando le frequenze sugli 8.641 token distinti del
 * catalogo, non a naso. Quello che finisce qui dentro NON e' allestimento: e' un attributo
 * che l'annuncio dichiara gia' per conto suo, oppure rumore tecnico.
 */
const DIESEL = /^(tdi|bitdi|dci|hdi|tdci|cdi|bluehdi|bluetec|cdti|mjt|jtd|jtdm|jtdm2|td|dt|dtec|turbodiesel|dpf|fap|ecoblue|crdi|ddis|multijet|diesel|d)$/;
const BENZINA = /^(tsi|etsi|tfsi|fsi|mpi|thp|puretech|ecoboost|ecoflex|vti|vvti|benzina|tce|vvt|gdi|mzr|vtec|multiair|firefly|twinair|i|ie)$/;
const GPL = /^(gpl|gpltech|easypower|lpg)$/;
const METANO = /^(metano|tgi|cng|bipower|natural|bifuel)$/;
const IBRIDO = /^(hybrid|hybrid4|mhev|phev|ehybrid|hev|ibrida|mild)$/;
const ELETTRICO = /^(elettrica|elettrico|ev|bev)$/;
const CAMBIO_AUTO = /^(dsg|aut\.?|automatic|automatica|automatico|tronic|geartronic|tiptronic|multitronic|steptronic|edc|dct|cvt|at|at6|at8|at9|eat6|eat8|tct|powershift|dkg|pdk|amt|robotizzato|sequenziale)$/;
const CARROZZERIA = /^(sw|s\.w\.|wagon|variant|touring|avant|sportback|spb|coupe|cabrio|cabriolet|berlina|hatchback|van|combi|furgone|cabinato|cassonato|monovolume|suv|station)$/;
// `turbo` sta QUI e non fra le benzine: un turbodiesel e' turbo, e marcarlo benzina
// escludeva le versioni diesel giuste. Il turbo non dice niente sul carburante.
// `s` NON sta qui: "S line" e "S Design" sono allestimenti veri, e togliendo la S
// restava "line", che da sola aggancerebbe anche una R-Line. Una "s" isolata non fa
// danno: i tratti sotto i tre caratteri vengono scartati comunque.
const TECNICO = /^(cat|cv|kw|v|\d+v|\d+cv|\d+kw|porte|porta|p|pc|pl|pm|tn|tm|n1|s&s|start&stop|e|posti|km|turbo|tech|bi|4x4|awd|4wd|fwd|rwd|quattro|4matic|xdrive|4motion|hpt|scr|act|evo|blue|bluemotion|blueefficiency|efficiency|dynamics)$/;

/**
 * LE FRASI, sciolte prima dei token. "Natural Power" e' il metano: se si guardassero le
 * due parole separate, `natural` verrebbe riconosciuto e `power` resterebbe li' a fare
 * l'allestimento. Stesso discorso per "Plug In" e "Mild Hybrid".
 *
 * E la classe di emissione se ne va del tutto: "Euro 5" e "E5" non sono allestimenti, e
 * quel campo l'annuncio lo dichiara per conto suo (`classeEmissioni`). Erano 1.864
 * occorrenze nel catalogo, e producevano risposte come "Panda 1.2 Dynamic Euro 5".
 *
 * La normalizzazione ha gia' trasformato i trattini in spazi: qui si scrive "gpl tech",
 * non "gpl-tech", altrimenti la regola non combacia mai.
 */
const FRASI = [
  [/\bnatural power\b/g, ' metano '],
  [/\bg tron\b/g, ' metano '],
  [/\bbi fuel\b/g, ' metano '],
  [/\bplug in\b/g, ' hybrid '],
  [/\bmild hybrid\b/g, ' hybrid '],
  [/\bfull hybrid\b/g, ' hybrid '],
  [/\be tech\b/g, ' hybrid '],
  [/\bgpl tech\b/g, ' gpl '],
  [/\beuro ?[2-6]\+?(?![a-z0-9])/g, ' '],
  [/\be[2-6]\+?(?![a-z0-9])/g, ' '],
];
const sciogliFrasi = n => FRASI.reduce((s, [re, con]) => s.replace(re, con), ' ' + n + ' ').replace(/\s+/g, ' ').trim();

const numerico = t => /^[0-9]+([.,][0-9]+)?$/.test(t) || /^\d+p\.?$/.test(t);

/**
 * Un nome di catalogo sciolto nei suoi pezzi: da una parte gli attributi tecnici, dall'altra
 * le parole che restano — che sono l'allestimento.
 *
 * `modelloTok` sono le parole del nome-modello ("Golf", "Serie 3"): vanno tolte, altrimenti
 * "Golf" conterebbe come allestimento e comparirebbe in ogni titolo.
 */
function parsaNome(nome, modelloTok) {
  const n = sciogliFrasi(norm(nome));
  const out = { nome, nNorm: n, senzaModello: '', cc: null, cv: null, porte: null, carb: null, auto: false, trims: [] };
  if (!n) return out;
  // Il catalogo ripete il nome del modello davanti ("Golf 1.6 5p. Highline"), il venditore
  // quasi mai: si tiene anche la forma senza, per il confronto col testo.
  out.senzaModello = n.split(' ').filter(t => !modelloTok.has(t)).join(' ');

  const mcc = n.match(/\b([0-9])[.,]([0-9])\b/);
  if (mcc) out.cc = Number(mcc[1] + '.' + mcc[2]);
  const mcv = n.match(/\b(\d{2,3})\s*cv\b/);
  if (mcv) out.cv = Number(mcv[1]);
  const mp = n.match(/\b([2-7])\s*(?:p\.?|porte|porta)\b/);
  if (mp) out.porte = Number(mp[1]);

  // Le parole d'allestimento restano ATTACCATE come le scrive il catalogo ("s line",
  // "1st edition"): spezzarle in parole sciolte farebbe combaciare "line" con qualunque
  // cosa. Ogni tratto contiguo di parole non-tecniche diventa una voce.
  const tratto = [];
  const chiudi = () => { if (tratto.length) { out.trims.push(tratto.join(' ')); tratto.length = 0; } };
  for (const t of n.split(' ')) {
    if (!t) continue;
    if (modelloTok.has(t)) { chiudi(); continue; }
    if (numerico(t)) { chiudi(); continue; }
    if (ELETTRICO.test(t)) { out.carb = 'elettrico'; chiudi(); continue; }
    if (IBRIDO.test(t)) { if (!out.carb) out.carb = 'ibrido'; chiudi(); continue; }
    if (GPL.test(t)) { out.carb = 'gpl'; chiudi(); continue; }
    if (METANO.test(t)) { out.carb = 'metano'; chiudi(); continue; }
    if (DIESEL.test(t)) { if (!out.carb) out.carb = 'diesel'; chiudi(); continue; }
    if (BENZINA.test(t)) { if (!out.carb) out.carb = 'benzina'; chiudi(); continue; }
    if (CAMBIO_AUTO.test(t)) { out.auto = true; chiudi(); continue; }
    if (CARROZZERIA.test(t) || TECNICO.test(t)) { chiudi(); continue; }
    tratto.push(t);
  }
  chiudi();
  out.trims = out.trims.filter(x => x.length >= 3);
  return out;
}

/**
 * L'allestimento com'e' SCRITTO nel catalogo, non come l'ha ridotto la normalizzazione:
 * "S line" e "GTI", non "s line" e "gti". Il confronto gira sulla forma normalizzata, ma
 * quello che finisce sotto gli occhi di chi legge deve essere il nome vero.
 * Si cerca una volta sola, sulla risposta — non su ogni candidata.
 */
function comeScritto(nome, trim) {
  const re = new RegExp(trim.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^A-Za-z0-9]+'), 'i');
  const m = String(nome).normalize('NFD').replace(/[̀-ͯ]/g, '').match(re);
  return m ? m[0] : trim;
}

/** I nomi del catalogo, pronti da confrontare. Il chiamante la chiama una volta per modello. */
function preparaVersioni(nomi, modelloNome) {
  const mt = new Set(norm(modelloNome).split(' ')
    .filter(t => t.length >= 2 && t !== 'serie' && !/^\d+a$/.test(t)));
  return (nomi || []).filter(Boolean).map(x => parsaNome(x, mt)).filter(v => v.nNorm);
}

/** Il carburante come lo scrive Subito → la famiglia. */
function famigliaCarburante(s) {
  const t = norm(s);
  if (!t) return null;
  if (/elettric/.test(t)) return 'elettrico';
  if (/gpl/.test(t)) return 'gpl';
  if (/metano/.test(t)) return 'metano';
  if (/hybrid|ibrid/.test(t)) return /diesel/.test(t) ? 'ibrido-diesel' : 'ibrido';
  if (/diesel/.test(t)) return 'diesel';
  if (/benzina/.test(t)) return 'benzina';
  return null;
}

/**
 * I DUE CARBURANTI SI ESCLUDONO? Solo quando si escludono davvero.
 * Un mild hybrid benzina sta benissimo su una versione che il catalogo chiama solo "TSI":
 * l'ibrido leggero il catalogo di Subito non lo marca. Quindi si esclude solo fra cose
 * che non possono stare insieme — un diesel non e' un benzina, un elettrico non e' altro.
 */
function carburanteIncompatibile(annuncio, versione) {
  if (!annuncio || !versione) return false;
  const base = annuncio === 'ibrido-diesel' ? 'diesel' : annuncio === 'ibrido' ? 'benzina' : annuncio;
  if (annuncio === 'elettrico' || versione === 'elettrico') return annuncio !== versione;
  if (versione === 'ibrido') return base !== 'benzina' && base !== 'diesel';
  const g = x => (x === 'gpl' || x === 'metano') ? x : (x === 'diesel' ? 'diesel' : 'benzina');
  return g(base) !== g(versione);
}

/** Dall'annuncio nostro (shape mapAd) ai soli campi che servono qui. */
function datiAnnuncio(m) {
  const porte = m && m.porte ? String(m.porte).split('/').map(Number).filter(Number.isFinite) : null;
  const cambio = norm(m && m.cambio);
  return {
    cv: Number.isFinite(m && m.potenzaCv) ? m.potenzaCv : null,
    porte: porte && porte.length ? porte : null,
    carb: famigliaCarburante(m && m.carburante),
    auto: cambio ? (/manuale/.test(cambio) ? false : /autom|sequen/.test(cambio) ? true : null) : null,
    // Stesso trattamento del catalogo, frasi comprese: due normalizzazioni diverse sui due
    // lati vorrebbero dire che il confronto esatto non combacia mai.
    testo: sciogliFrasi(norm([(m && m.titolo) || '', (m && m.descrizione) || ''].join(' '))),
    // Il TITOLO da solo. Il corpo e' lungo in media 1.000 caratteri di prosa, e una
    // parola sola d'allestimento pescata li' dentro non e' un segnale: "sport" compare
    // in "assetto sport", "nuova" e "fire" sono parole italiane. Il nome INTERO trovato
    // nel corpo invece regge, perche' e' una coincidenza che non capita.
    titolo: sciogliFrasi(norm((m && m.titolo) || '')),
  };
}

/**
 * @param {Array}  versioni  uscita di preparaVersioni() per marca+generazione dell'annuncio
 * @param {object} ann       uscita di datiAnnuncio()
 * @returns {{esito:'esatta',versione:string,perche:string}
 *          |{esito:'allestimento',allestimento:string,quante:number,perche:string}
 *          |null}
 */
function deduci(versioni, ann) {
  if (!versioni || !versioni.length || !ann || !ann.testo) return null;
  const testo = ' ' + ann.testo + ' ';
  const titolo = ' ' + (ann.titolo || '') + ' ';

  /**
   * 1. IL NOME E' SCRITTO PER INTERO. Questo livello non deduce niente: legge. Vince il
   * piu' lungo, perche' il catalogo annida i nomi ("320d" dentro "320d Sport") e fermarsi
   * al primo vorrebbe dire rispondere sempre la versione base.
   *
   * DOVE si legge, pero', cambia quanto vale. Nel TITOLO qualunque nome e' un segnale: il
   * titolo e' corto e scritto apposta. Nel CORPO — mille caratteri di prosa — lo e' solo
   * un nome che porta un allestimento: "A3 2.0 TDI" si trova nel corpo di ogni annuncio di
   * un 2.0 TDI, e spacciarlo per "la versione e' scritta nell'annuncio" e' dichiarare una
   * certezza che nessuno ha verificato. Visto dal vivo su tre A3 di fila.
   */
  const combacia = dove => v =>
    (v.nNorm.length >= 5 && dove.includes(' ' + v.nNorm + ' '))
    || (v.senzaModello.length >= 5 && dove.includes(' ' + v.senzaModello + ' '));
  const nelTitolo = combacia(titolo), nelTesto = combacia(testo);
  const scritte = versioni.filter(v => nelTitolo(v) || (v.trims.length && nelTesto(v)));
  if (scritte.length) {
    scritte.sort((a, b) => b.nNorm.length - a.nNorm.length);
    return { esito: 'esatta', versione: scritte[0].nome,
             perche: 'il nome della versione e\' scritto nell\'annuncio' };
  }

  /**
   * 2. SI TOLGONO LE VERSIONI CHE L'ANNUNCIO CONTRADDICE. Non e' una scelta, e'
   * un'esclusione: 5 porte dichiarate mandano fuori le 3 porte, e cosi' via. La cilindrata
   * si legge dal testo perche' Subito NON la espone sulle auto (verificato: zero occorrenze
   * del campo 'Cilindrata' su 200 annunci auto; sulle moto invece c'e').
   */
  const mcc = ann.testo.match(/\b([0-9])[.,]([0-9])\b/);
  const cc = mcc ? Number(mcc[1] + '.' + mcc[2]) : null;
  const vivi = versioni.filter(v => {
    if (cc != null && v.cc != null && Math.abs(v.cc - cc) > 0.001) return false;
    if (ann.cv != null && v.cv != null && Math.abs(v.cv - ann.cv) > 2) return false;
    if (ann.porte && v.porte != null && !ann.porte.includes(v.porte)) return false;
    if (carburanteIncompatibile(ann.carb, v.carb)) return false;
    if (ann.auto === false && v.auto) return false;
    return true;
  });
  if (!vivi.length) return null;

  /**
   * 3. L'ALLESTIMENTO, e solo quello. Se fra le versioni rimaste il testo nomina UNA sola
   * parola d'allestimento e ce l'hanno tutte, quella si puo' dire. Non si dice quale delle
   * quattro Lounge: si dice che e' una Lounge, che e' molto piu' di "versione n.d.".
   *
   * La versione singola sopravvissuta NON viene dichiarata come tale: e' il livello
   * bocciato dalla misura (25% sbagliato quando manca la potenza). Se porta un
   * allestimento riconosciuto nel testo esce di qui, come affermazione piu' debole.
   */
  const trovati = new Set();
  for (const v of vivi) for (const t of v.trims) if (titolo.includes(' ' + t + ' ')) trovati.add(t);
  /**
   * LA SIGLA DEL MOTORE NON E' UN ALLESTIMENTO, E IL CATALOGO LO DICE DA SOLO.
   *
   * "320d Touring Futura" porta due parole — `320d` e `futura` — e la regola qui sotto
   * taceva, perdendo la risposta giusta. Serviva un modo di riconoscere la sigla senza
   * indovinarla dalla forma: e' il POSTO in cui sta. Subito apre il nome della versione con
   * la motorizzazione ("320d cat Touring MSport", "118d 5p. Sport"), l'allestimento no.
   *
   * Misurato su 797 annunci veri di 8 modelli (BMW Serie 1/3/5, Golf, Panda, A3, Giulietta,
   * Focus): 122 parole-sigla su 122 aprono il nome, 44 parole-allestimento su 44 quasi mai
   * (3 eccezioni, di cui "fire" che il motore Fiat lo e' davvero). Contro le versioni
   * dichiarate dagli annunci: 190 risposte → 196, giuste 172 → 178, sbagliate 18 → 18,
   * nessuna risposta persa.
   *
   * Vale solo quando c'e' un'alternativa: se la sigla e' l'unica parola trovata resta lei,
   * altrimenti si perderebbero anche le sigle che sono davvero il nome della versione (RS3).
   */
  const apreIlNome = t => {
    const conT = vivi.filter(v => v.trims.includes(t));
    if (!conT.length) return false;
    const primo = nome => { for (const w of norm(nome).split(' ')) { if (!w) continue; if (/^\d+([.,]\d+)?$/.test(w)) continue; return w; } return null; };
    return conT.filter(v => primo(v.nome) === t).length / conT.length > 0.8;
  };
  let cand = [...trovati];
  if (cand.length > 1) {
    const veri = cand.filter(t => !apreIlNome(t));
    if (veri.length) cand = veri;
  }
  // Due parole d'allestimento diverse nello stesso testo vogliono dire che non si sta
  // leggendo l'allestimento: si sta leggendo la prosa del venditore.
  if (cand.length !== 1) return null;
  const trim = cand[0];
  const conTrim = vivi.filter(v => v.trims.includes(trim));
  if (!conTrim.length) return null;
  const etichetta = comeScritto(conTrim[0].nome, trim);
  /**
   * E SI DICE COS'E'. Quando la parola rimasta e' quella che apre il nome di catalogo, e'
   * la MOTORIZZAZIONE, non l'allestimento — misurato: 118 delle 147 risposte su 797 annunci
   * veri erano "320d", "118d", "330d" stampate sotto la parola "Allestimento". Il dato e'
   * giusto (Subito la versione la chiama proprio cosi'), a mentire era l'etichetta.
   */
  return { esito: 'allestimento', allestimento: etichetta, quante: conTrim.length,
           cosa: apreIlNome(trim) ? 'motorizzazione' : 'allestimento',
           perche: conTrim.length === 1
             ? 'unica versione compatibile con quello che l\'annuncio dichiara'
             : conTrim.length + ' versioni compatibili, tutte ' + etichetta };
}

module.exports = { preparaVersioni, deduci, datiAnnuncio, _parsaNome: parsaNome, _norm: norm };
