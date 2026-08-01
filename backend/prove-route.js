'use strict';
/**
 * LE MISURE DELLA REDAZIONE — quello che il costruttore dichiara, provato al banco.
 *
 * Due fonti, un mestiere solo: dire quanto va davvero un mezzo, invece di ripetere la
 * scheda della casa. Vivono dentro l'ADD ON della scheda tecnica dell'annuncio, accanto a
 * richiami, gomme e passaggio di proprieta', perche' e' li' che si guarda un veicolo.
 *
 *   auto → auto.it: velocita' massima REALE, 0-100, 0-400, 0-1000, ripresa 80-120, frenata
 *          100-0 in metri, consumi veri citta'/autostrada/medio. Una richiesta per MARCA
 *          (38 rilevamenti per Volkswagen, misurato), poi il modello si aggancia in locale.
 *   moto → inSella: potenza al banco ALLA RUOTA contro quella dichiarata, dimensioni
 *          misurate, undici voti e la metodologia. L'indice delle 329 prove e' su disco:
 *          cercare non costa niente, e la prova intera si scarica solo quando la si apre.
 *
 * NON SI SCEGLIE MAI FRA PARI. Le prove sono di un allestimento preciso, e i nomi non
 * combaciano con quelli degli annunci: "Kawasaki Z 900" aggancia anche la Z900RS, che e'
 * un'altra moto. Quindi qui si restituiscono le CANDIDATE con il loro titolo e il loro anno,
 * e la scelta la fa chi guarda. Una prova sbagliata presentata come quella giusta sarebbe
 * peggio di nessuna prova: chi legge non ha modo di accorgersene.
 */
const autoit = require('./scrapers/autoit-rilevamenti');
const insella = require('./scrapers/insella-prove');

const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const tok = s => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

const limite = require('./limite-richieste').crea({ max: 20, cosa: 'richieste alle prove' });

/** Le voci il cui nome contiene TUTTI i token del modello. Nessuna scelta, solo il filtro. */
function perModello(voci, modello, campo = 'nome') {
  const q = tok(modello);
  if (!q.length) return voci;
  const dentro = voci.filter(v => { const s = tok(v[campo]); return q.every(w => s.includes(w)); });
  return dentro;
}

function mount(app, deps = {}) {
  // La chiave dei limiti: la PERSONA quando e' entrata, l'indirizzo quando no.
  const chiaveLimite = deps.chiaveLimite || deps.clientIp || (req => req.ip || '');

  /**
   * AUTO — i rilevamenti di auto.it per un modello.
   * Ordinate per vicinanza all'anno dell'annuncio: la prova di un'altra generazione non
   * descrive questa macchina, e metterla in cima sarebbe suggerirla.
   */
  app.get('/api/prove/auto', async (req, res) => {
    const g = limite.consuma(chiaveLimite(req));
    if (!g.ok) return res.status(429).json({ ok: false, error: limite.messaggio(g), riprovaFra: g.attesa, restanti: 0 });
    const { marca, modello, anno } = req.query || {};
    if (!marca) return res.status(400).json({ ok: false, error: 'marca mancante' });
    const pausa = autoit.pausaFinoA();
    if (pausa) return res.json({ ok: false, error: 'fonte in pausa dopo un blocco', bloccataFino: pausa });
    try {
      const marche = await autoit.marche();
      const m = tok(marca);
      const voce = (marche || []).find(x => m.every(w => tok(x.nome).includes(w)));
      if (!voce) return res.json({ ok: true, voci: [], motivo: 'auto.it non ha prove di questa marca' });
      const d = await autoit.rilevamenti(voce.acronimo);
      let voci = perModello((d && d.rilevamenti) || [], modello);
      const y = parseInt(anno, 10) || null;
      if (y) voci = voci.slice().sort((a, b) => Math.abs((a.anno || 0) - y) - Math.abs((b.anno || 0) - y));
      res.json({ ok: true, marca: voce.nome, voci: voci.slice(0, 8), quante: voci.length, fonte: d && d.fonte });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  /** MOTO — le prove di inSella che possono essere di questo modello. Indice su disco. */
  app.get('/api/prove/moto', async (req, res) => {
    const g = limite.consuma(chiaveLimite(req));
    if (!g.ok) return res.status(429).json({ ok: false, error: limite.messaggio(g), riprovaFra: g.attesa, restanti: 0 });
    const { marca, modello } = req.query || {};
    if (!marca || !modello) return res.status(400).json({ ok: false, error: 'marca/modello mancanti' });
    // `indice()` e' una Promise e restituisce direttamente l'ELENCO delle prove (dal file su
    // disco, senza rete). Trattandola come oggetto sincrono le candidate erano sempre zero.
    let prove = [];
    try { prove = await insella.indice() || []; } catch (e) { return res.json({ ok: false, error: e.message }); }
    const m = tok(marca), q = tok(modello);
    const cand = prove.filter(p => {
      const s = tok(p.slug + ' ' + p.titolo);
      return m.every(w => s.includes(w)) && q.every(w => s.includes(w));
    });
    // L'anno sta in coda allo slug: si mostra, non si usa per scegliere.
    res.json({ ok: true, candidate: cand.slice(0, 10).map(p => ({
      slug: p.slug, titolo: p.titolo, categoria: p.categoria || null,
      anno: (String(p.slug).match(/(?:^|-)((?:19|20)\d{2})(?:-|$)/) || [])[1] || null,
    })), quante: cand.length });
  });

  /** MOTO — la prova intera. Una richiesta, e solo quando la si apre. */
  app.get('/api/prove/moto/prova', async (req, res) => {
    const g = limite.consuma(chiaveLimite(req));
    if (!g.ok) return res.status(429).json({ ok: false, error: limite.messaggio(g), riprovaFra: g.attesa, restanti: 0 });
    const slug = String((req.query || {}).slug || '');
    if (!/^[a-z0-9-]{3,120}$/.test(slug)) return res.status(400).json({ ok: false, error: 'slug non valido' });
    const pausa = insella.pausaFinoA();
    if (pausa) return res.json({ ok: false, error: 'fonte in pausa dopo un blocco', bloccataFino: pausa });
    try {
      const p = await insella.prova(slug);
      if (!p) return res.json({ ok: false, error: 'prova non disponibile' });
      res.json({ ok: true, prova: p });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });
}

module.exports = { mount, _perModello: perModello };
