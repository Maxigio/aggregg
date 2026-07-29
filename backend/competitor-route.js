'use strict';
/**
 * Rotte della sezione Competitor.
 *
 *   GET    /api/competitor            l'elenco salvato (nessuna rete)
 *   POST   /api/competitor            { url } → risolve la vetrina e la salva
 *   DELETE /api/competitor/:id        toglie una voce
 *   GET    /api/competitor/:id/parco  scarica il parco e lo aggrega — SU RICHIESTA
 *
 * Il parco NON si scarica all'apertura della sezione: un concessionario grosso costa una
 * richiesta ogni cinquanta veicoli, e aprire una scheda non e' chiedere un aggiornamento.
 * In cache dieci minuti, cosi' riaprire la stessa scheda non ripaga il conto.
 */
const comp = require('./competitor');

const TTL = 10 * 60 * 1000;
const cache = new Map();   // `${fonte}:${id}` → { ts, dati }

function mount(app, deps = {}) {
  const C = deps.competitor || comp;
  // Il body JSON si monta per-rotta in questa app, non globalmente: arriva da server.js.
  const json = deps.json || ((req, res, next) => next());

  app.get('/api/competitor', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, voci: C.leggi() });
  });

  app.post('/api/competitor', json, async (req, res) => {
    const url = (req.body && req.body.url) || (req.query && req.query.url);
    if (!url) return res.status(400).json({ ok: false, error: 'serve il link della vetrina' });
    let voce;
    try { voce = await C.risolviVetrina(String(url)); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const voci = C.leggi();
    const chiave = voce.fonte + ':' + voce.id;
    // Chi reincolla lo stesso link non sta sbagliando: sta chiedendo QUEL parco. Si dice
    // che c'era gia' e si rimanda la voce salvata, cosi' chi chiama puo' aprirla invece di
    // lasciare l'utente davanti a un errore che non gli fa fare niente.
    const gia = voci.find(v => v.fonte + ':' + v.id === chiave);
    if (gia) return res.status(409).json({ ok: false, error: `${voce.nome} e' gia' nell'elenco`, voce: gia });
    // `mio` lo decide chi aggiunge: il proprio parco e' una voce come le altre, ma va
    // distinta, altrimenti nel confronto ci si perde fra i concorrenti.
    voce.mio = !!(req.body && req.body.mio);
    voce.schedaLetta = true;                 // appena letta: non si rilegge al primo parco
    voce.aggiunto = new Date().toISOString();
    voci.push(voce);
    C.scrivi(voci);
    res.json({ ok: true, voce });
  });

  app.delete('/api/competitor/:id', (req, res) => {
    const id = String(req.params.id);
    const voci = C.leggi();
    const restanti = voci.filter(v => String(v.id) !== id);
    if (restanti.length === voci.length) return res.status(404).json({ ok: false, error: 'non e\' nell\'elenco' });
    C.scrivi(restanti);
    res.json({ ok: true, tolti: voci.length - restanti.length });
  });

  app.get('/api/competitor/:id/parco', async (req, res) => {
    const id = String(req.params.id);
    let voce = C.leggi().find(v => String(v.id) === id);
    if (!voce) return res.status(404).json({ ok: false, error: 'non e\' nell\'elenco' });
    // Le vetrine salvate prima avevano tre campi: nome, dove, via. Ora la pagina ne da'
    // molti di piu' (telefoni, orari, valutazione, servizi, logo) e chi ce l'ha gia' in
    // elenco non deve toglierla e rimetterla per vederli: si rilegge una volta sola,
    // quando quel parco lo si scarica comunque.
    if (!voce.schedaLetta) {
      try {
        const fresca = await C.risolviVetrina(voce.url);
        voce = { ...voce, ...fresca, id: voce.id, mio: voce.mio, aggiunto: voce.aggiunto, schedaLetta: true };
        C.scrivi(C.leggi().map(v => (String(v.id) === id ? voce : v)));
      } catch (_) { /* la vetrina non risponde: si va avanti con quello che c'e' */ }
    }
    const k = voce.fonte + ':' + voce.id;
    const hit = cache.get(k);
    const forza = String(req.query.forza || '') === '1';
    if (!forza && hit && Date.now() - hit.ts < TTL) {
      return res.json({ ok: true, ...hit.dati, daCache: true, quando: new Date(hit.ts).toISOString() });
    }
    let p;
    try { p = await C.parco(voce); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
    const dati = {
      voce,
      numeri: C.aggrega(p.veicoli),
      troncato: p.troncato,
      /**
       * L'ANNUNCIO INTERO. Qui c'era una rimappatura a otto campi che buttava via tutto il
       * resto — foto, descrizione, versione, potenza, colore, garanzia, IVA esposta,
       * codice di magazzino — roba che le fonti mandano nella stessa risposta e che
       * avevamo gia' in mano. Il parco di un concessionario si guarda annuncio per
       * annuncio, e con otto campi non si guarda niente.
       */
      veicoli: p.veicoli.map(v => { const { _raw, ...pulito } = v; return pulito; }),
    };
    cache.set(k, { ts: Date.now(), dati });
    // Un annuncio pesa ~3 KB (misurato su Autoscout: 16 annunci, 50 KB, meta' sono gli URL
    // delle foto). Un parco al tetto sono 6 MB: sessanta in cache erano 370 MB di roba che
    // nessuno riguarda. Otto vetrine sono piu' di quante se ne aprano in dieci minuti.
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    res.json({ ok: true, ...dati, daCache: false, quando: new Date().toISOString() });
  });
}

module.exports = { mount };
