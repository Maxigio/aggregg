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
 *   esito: 'una' | 'ambigua' | 'nessuna' | 'senza-indice'
 */
function risolviVersione(indice, annuncio) {
  const vm = (indice && indice.versioniMotoit) || [];
  if (!vm.length) return { esito: 'senza-indice', versioni: [], perche: 'nessuna versione Moto.it per questo modello' };

  const anno = Number(annuncio && annuncio.anno) || null;
  const conAnni = vm.filter(v => v.anni);

  // 1) l'ANNO: e' il taglio principale di Moto.it, quindi si usa per primo.
  let c = vm, perche = 'nessun anno nell\'annuncio: nessun filtro applicato';
  if (anno && conAnni.length) {
    const dentro = conAnni.filter(v => anno >= v.anni.da && anno <= v.anni.a);
    if (dentro.length) { c = dentro; perche = 'anno ' + anno + ' dentro il periodo'; }
    else {
      // immatricolato dopo l'ultimo periodo noto: capita con le giacenze. Si tiene l'ultima
      // versione, dichiarando che e' un ripiego e non una corrispondenza.
      const max = Math.max(...conAnni.map(v => v.anni.a));
      if (anno > max) { c = conAnni.filter(v => v.anni.a === max); perche = 'anno ' + anno + ' oltre l\'ultimo periodo noto (' + max + '): presa l\'ultima'; }
      else return { esito: 'nessuna', versioni: [], perche: 'anno ' + anno + ' in nessun periodo' };
    }
  }
  if (c.length === 1) return { esito: 'una', versioni: c, perche };

  // 2) la VARIANTE, e solo dopo: "ABS", "Pure", "Moto Cage". Match piu' LUNGO, a parola
  //    intera. Il confronto senza confini di parola aggancia "s" a qualunque testo — errore
  //    gia' fatto e gia' pagato.
  const parole = ' ' + String(annuncio && annuncio.versione || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const conVar = c.filter(v => {
    if (!v.variante) return false;
    const q = ' ' + String(v.variante).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    // UNA lettera basta: "R", "S". Il confronto e' fra spazi, quindi " r " trova solo la
    // parola `r` isolata, non la r dentro un'altra parola. Una soglia a due caratteri qui
    // buttava via le varianti sportive — misurato: 7 errori su 8 nella prova sul campo.
    return q.trim().length >= 1 && parole.includes(q);
  });
  if (conVar.length) {
    const max = Math.max(...conVar.map(v => norm(v.variante).length));
    const vinti = conVar.filter(v => norm(v.variante).length === max);
    if (vinti.length === 1) return { esito: 'una', versioni: vinti, perche: perche + ' + variante "' + vinti[0].variante + '"' };
    return { esito: 'ambigua', versioni: vinti, perche: perche + ' + piu\' varianti uguali' };
  }

  // 3) nessuna variante riconosciuta: se c'e' una versione BASE, e' lei.
  const base = c.filter(v => !v.variante);
  if (base.length === 1) return { esito: 'una', versioni: base, perche: perche + ' + nessuna variante nel testo: versione base' };

  return { esito: 'ambigua', versioni: c, perche: perche + ' + ' + c.length + ' candidate, niente le separa' };
}

module.exports = { risolviVersione, norm };
