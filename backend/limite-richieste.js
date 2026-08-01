'use strict';
/**
 * IL LIMITATORE DELLE RICHIESTE, uno solo.
 *
 * Era la stessa funzione copiata in SETTE file — prove, scheda-veicolo, fonti, richiami,
 * competitor, ricambi, segnalazioni — diversa solo per il tetto e per il nome. E tutte e
 * sette avevano lo stesso difetto: il timestamp si segnava PRIMA del confronto, quindi anche
 * una richiesta GIA' RIFIUTATA finiva nella finestra. Chi insisteva allungava il proprio
 * blocco all'infinito: con un client che ritenta ogni secondo la finestra non si svuotava
 * mai, e la sezione restava chiusa finche' non ci si fermava — cosa che nessuno fa, perche'
 * quando qualcosa non risponde si riprova.
 *
 * Il codice del competitor lo sapeva gia' e ci girava attorno con una variabile apposta
 * (`esaurito`, per non richiamare il limitatore in un ciclo su un gruppo di vetrine): il
 * lavoro che quella variabile faceva a mano lo fa questo modulo per tutti.
 *
 * A cosa serve un limitatore QUI. AMR e' uno strumento interno usato da poche persone: non
 * deve punire chi clicca, deve impedire che un ciclo impazzito si faccia bloccare da una
 * fonte. Quindi il tetto e' fisso — N richieste per finestra, sempre — e chi e' gia' fermo
 * non paga: passata la finestra riparte, esattamente come chi non ha insistito.
 *
 * E chi viene fermato deve sapere QUANDO puo' riprovare. Il numero c'e' gia' — e' il piu'
 * vecchio dei timestamp vivi — e prima lo diceva solo il competitor.
 */

/**
 * @param {object} opt
 *   `max`       quante richieste per finestra
 *   `finestra`  durata della finestra in ms (default 60s)
 *   `cosa`      come si chiama cio' che si sta contando, per il messaggio ('richieste')
 *   `maxChiavi` quante chiavi tenere in memoria prima di fare pulizia (default 5000)
 * @returns {{consuma:function, stato:function, messaggio:function}}
 */
function crea(opt = {}) {
  const max = opt.max || 20;
  const finestra = opt.finestra || 60 * 1000;
  const cosa = opt.cosa || 'richieste';
  const maxChiavi = opt.maxChiavi || 5000;
  const hits = new Map();

  /** Solo GUARDARE: non addebita niente. Serve anche a dire quanto resta prima di fermarsi. */
  function stato(chiave) {
    const ora = Date.now();
    const v = (hits.get(chiave) || []).filter(t => ora - t < finestra);
    // La mappa si pulisce da sola man mano che si legge: una chiave la cui finestra e' finita
    // non ha piu' niente da dire. Prima si aspettava le 5000 chiavi e poi si faceva
    // `hits.clear()`, che azzera il conto A TUTTI — compreso chi non c'entrava niente.
    if (v.length) hits.set(chiave, v); else hits.delete(chiave);
    const restanti = Math.max(0, max - v.length);
    // Quando si libera un posto: quando il piu' VECCHIO dei timestamp vivi esce dalla finestra.
    const attesa = restanti > 0 ? 0 : Math.max(1, Math.ceil((finestra - (ora - v[0])) / 1000));
    return { ok: restanti > 0, restanti, attesa, max };
  }

  /** Chiedere un posto. Se non c'e', NON si addebita niente: insistere non allunga il blocco. */
  function consuma(chiave) {
    const s = stato(chiave);
    if (!s.ok) return s;
    const v = hits.get(chiave) || [];
    v.push(Date.now());
    hits.set(chiave, v);
    if (hits.size > maxChiavi) {
      const ora = Date.now();
      for (const [k, ts] of hits) if (!ts.length || ora - ts[ts.length - 1] >= finestra) hits.delete(k);
    }
    return { ok: true, restanti: s.restanti - 1, attesa: 0, max };
  }

  /** Il messaggio da mettere nel 429: dice cosa e' successo E quando si puo' riprovare. */
  function messaggio(s, testa) {
    const quando = s.attesa >= 120
      ? `fra ${Math.ceil(s.attesa / 60)} minuti`
      : (s.attesa > 1 ? `fra ${s.attesa} secondi` : 'fra un secondo');
    return `${testa || `Troppe ${cosa}: sono ${max} ogni ${finestra >= 120000 ? finestra / 60000 + ' minuti' : finestra / 1000 + ' secondi'}.`} Riprova ${quando}.`;
  }

  return { consuma, stato, messaggio, max, finestra };
}

module.exports = { crea };
