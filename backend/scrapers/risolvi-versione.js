'use strict';
/**
 * Da un annuncio alla VERSIONE di Moto.it — cioe' alla scheda tecnica giusta.
 *
 * Funzione PURA: prende dati, restituisce dati. Nessuna rete, nessun file letto qui dentro
 * (l'indice arriva da fuori). Cosi' si prova in millisecondi e si sbaglia una volta sola.
 *
 * PERCHE' SERVE. Subito e Moto.it tagliano le versioni su assi diversi: Subito per
 * allestimento e senza anni, Moto.it per anni con la variante dentro il nome. Nessun
 * collegamento fisso puo' bastare — misurato, solo il 29% delle versioni Subito trova una
 * variante uguale. Ma l'annuncio porta l'ANNO, e con quello si chiude: il solo anno lascia
 * una sola versione nel 54,1% dei casi, l'anno con la variante arriva all'88%.
 *
 * COSA GLI SERVE: la voce dell'indice deve portare `marca` e `subito.nome`. Senza, le parole
 * del titolo (che contiene sempre marca e modello) risultano tutte estranee e ogni risposta
 * scivola su 'ripiego'. E' prudente, non sbagliato — ma degrada la copertura in silenzio.
 *
 * COSA NON FA: non sceglie mai fra pari. Se restano due candidati lo dice, perche' mostrare
 * la scheda sbagliata e' peggio che non mostrarne nessuna — chi legge non ha modo di
 * accorgersene.
 */

/** minuscolo, senza accenti, solo lettere e cifre. Locale: questo modulo non dipende da altri. */
const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/**
 * @param {object} indice  la voce di data/ponte-versioni.json per questo modello
 * @param {object} annuncio {anno, versione} — `versione` e' il nome dell'allestimento come lo
 *                 scrive la fonte di partenza (Subito), oppure il titolo dell'annuncio.
 * @returns {{esito:string, versioni:Array, perche:string}}
 *   esito: 'una' | 'ripiego' | 'ambigua' | 'nessuna' | 'senza-indice'
 *     `ripiego` = una risposta c'e', ma nasce da un'esclusione, non da una corrispondenza.
 *     Chi la usa deve mostrarla come tale: e' la differenza fra "e' questa" e "dovrebbe
 *     essere questa". Prima questi casi uscivano come 'una', cioe' come certezze.
 */
function risolviVersione(indice, annuncio) {
  const vm = (indice && indice.versioniMotoit) || [];
  if (!vm.length) return { esito: 'senza-indice', versioni: [], perche: 'nessuna versione Moto.it per questo modello' };

  const anno = Number(annuncio && annuncio.anno) || null;
  const conAnni = vm.filter(v => v.anni);

  // 1) l'ANNO: e' il taglio principale di Moto.it, quindi si usa per primo.
  // Le versioni SENZA periodo non sono escludibili dall'anno: non sappiamo quando siano
  // state prodotte, quindi restano sempre candidate. Filtrarle via era una perdita
  // silenziosa — una K 1100 LT SE (senza anni in catalogo) spariva e usciva la LT liscia
  // con esito 'una', cioe' dichiarata certa.
  const senzaAnni = vm.filter(v => !v.anni);
  let c = vm, perche = 'nessun anno nell\'annuncio: nessun filtro applicato';
  // `ripiego` = siamo arrivati alle candidate per esclusione, non per corrispondenza. Chi
  // legge questo esito NON preseleziona: mostra la griglia e lascia scegliere.
  let ripiego = false;
  if (anno && conAnni.length) {
    const dentro = conAnni.filter(v => anno >= v.anni.da && anno <= v.anni.a);
    if (dentro.length) { c = dentro.concat(senzaAnni); perche = 'anno ' + anno + ' dentro il periodo'; }
    else {
      // immatricolato dopo l'ultimo periodo noto: capita con le giacenze. Si tiene l'ultima
      // versione, dichiarando che e' un ripiego e non una corrispondenza.
      const max = Math.max(...conAnni.map(v => v.anni.a));
      const min = Math.min(...conAnni.map(v => v.anni.da));
      // NON SI INDOVINA. Prima qui si teneva l'ultima versione conosciuta e la si presentava
      // come una corrispondenza: la scheda si apriva gia' scelta, con potenza, peso e consumi
      // di un'annata diversa da quella dell'annuncio, e senza nessun segno che fosse un ripiego.
      // Se il catalogo non arriva a quell'anno, la risposta onesta e' "scegli tu": si portano
      // le candidate e si dichiara perche', la griglia resta aperta.
      if (anno > max) { c = conAnni.filter(v => v.anni.a === max).concat(senzaAnni); ripiego = true; perche = 'anno ' + anno + ' oltre l\'ultimo periodo noto (' + max + '): il catalogo non arriva a quest\'anno, scegli tu'; }
      // gemello del caso sopra: un annuncio piu' VECCHIO del primo periodo noto. Prima
      // usciva 'nessuna' anche quando c'erano versioni senza periodo che lo coprivano.
      else if (anno < min && senzaAnni.length) { c = senzaAnni; perche = 'anno ' + anno + ' prima del primo periodo noto (' + min + '): restano le versioni senza periodo'; }
      else if (senzaAnni.length) c = senzaAnni;
      else return { esito: 'nessuna', versioni: [], perche: 'anno ' + anno + ' in nessun periodo' };
    }
  }
  // Anche con UNA sola candidata: se ci siamo arrivati per esclusione non e' una risposta,
  // e' la cosa piu' vicina che abbiamo. Si dichiara 'ripiego' e la scelta resta a chi guarda.
  if (c.length === 1) return { esito: ripiego ? 'ripiego' : 'una', versioni: c, perche };

  // 2) la VARIANTE, e solo dopo: "ABS", "Pure", "Moto Cage". Match piu' LUNGO, a parola
  //    intera. Il confronto senza confini di parola aggancia "s" a qualunque testo — errore
  //    gia' fatto e gia' pagato.
  const spezza = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
  const paroleAnnuncio = new Set(spezza(annuncio && annuncio.versione));
  const conVar = c.filter(v => {
    if (!v.variante) return false;
    const q = spezza(v.variante);
    // INSIEME di parole, non sottostringa: "Scrambler 50th Anniversary" contiene sia
    // "Scrambler" sia "Anniversary" ma non di fila, e col confronto per sottostringa
    // vinceva la Scrambler liscia. Una lettera sola va bene ("R", "S"): sono parole
    // intere, quindi non agganciano la r dentro "Scrambler".
    return q.length > 0 && q.every(w => paroleAnnuncio.has(w));
  });
  if (conVar.length) {
    // vince chi copre PIU' PAROLE dell'annuncio: "Scrambler Anniversary" batte "Scrambler"
    const quante = v => spezza(v.variante).length;
    const max = Math.max(...conVar.map(quante));
    const vinti = conVar.filter(v => quante(v) === max);
    if (vinti.length === 1) return { esito: 'una', versioni: vinti, perche: perche + ' + variante "' + vinti[0].variante + '"' };
    return { esito: 'ambigua', versioni: vinti, perche: perche + ' + piu\' varianti uguali' };
  }

  // 3) nessuna variante riconosciuta: se c'e' una versione BASE, e' lei.
  const base = c.filter(v => !v.variante);
  if (base.length === 1) {
    // Se nel testo ci sono parole che NON appartengono al modello ne' a nessuna variante
    // nota, l'annuncio parla di un allestimento che Moto.it non ha: la base e' un ripiego,
    // non una corrispondenza. Dichiararlo 'una' faceva passare per certa la scheda della
    // Indian Scout uscente su un annuncio di Scout Rogue.
    const noteVarianti = new Set(c.flatMap(v => spezza(v.variante)));
    // il nome del MODELLO e quello della MARCA stanno nel titolo di ogni annuncio e non
    // sono allestimenti: senza escluderli, "Yamaha MT-07" diventerebbe un ripiego perche'
    // "yamaha" non e' una variante.
    const noteModello = new Set([
      ...spezza(indice && indice.subito && indice.subito.nome),
      ...spezza(indice && indice.marca),
      ...c.flatMap(v => spezza(String(v.nome).replace(/\([^)]*\)\s*$/, ''))),
    ]);
    const estranee = [...paroleAnnuncio].filter(w => !noteVarianti.has(w) && !noteModello.has(w) && !/^\d+$/.test(w));
    if (estranee.length) return { esito: 'ripiego', versioni: base, perche: perche + ' + nel testo ci sono parole che nessuna variante spiega (' + estranee.slice(0, 3).join(', ') + '): la base e un ripiego' };
    return { esito: 'una', versioni: base, perche: perche + ' + nessuna variante nel testo: versione base' };
  }

  return { esito: 'ambigua', versioni: c, perche: perche + ' + ' + c.length + ' candidate, niente le separa' };
}

module.exports = { risolviVersione, norm };
