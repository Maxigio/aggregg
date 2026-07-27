'use strict';
/**
 * CORRISPONDENZE — l'area che risponde a una domanda sola: questo veicolo, sulle altre
 * fonti, cos'e'?
 *
 * Subito, Autoscout24 e Moto.it hanno cataloghi marca/modello/versione diversi e senza
 * nessun identificativo in comune. I tre ponti in data/ponte-*.json li collegano, e ogni
 * collegamento porta con se' il GRADO e la PROVA: chi legge deve poter distinguere un
 * aggancio certo da uno probabile, altrimenti tanto vale non averlo.
 *
 * NON SOSTITUISCE NIENTE. E' un'area a se': la ricerca annunci, la scheda tecnica e il
 * catalogo continuano a funzionare esattamente come prima. Qui si consulta il ponte, non
 * lo si usa per decidere al posto di qualcun altro.
 *
 * MEMORIA. I due file pesano insieme una decina di megabyte e il server ne carica gia'
 * undici all'avvio. Si leggono alla PRIMA richiesta, non al boot: chi non apre l'area non
 * li paga. Una volta letti restano, perche' rileggerli a ogni richiesta costerebbe di piu'.
 */
const fs = require('fs');
const path = require('path');
const { risolviVersione } = require('./scrapers/risolvi-versione');

const DATA = path.join(__dirname, '..', 'data');
const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// ── caricamento pigro ───────────────────────────────────────────────────────
let CACHE = null;
function carica() {
  if (CACHE) return CACHE;
  const leggi = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const modelli = leggi('ponte-modelli.json');
  const versioni = leggi('ponte-versioni.json');
  const marche = leggi('ponte-marche.json');

  /**
   * Indice per (tipo, marca) → i nodi di partenza con i loro agganci, uno per relazione.
   * Il ponte e' scritto per relazione (subito→autoscout, subito→motoit, …); qui si gira
   * per NODO, che e' come lo si consulta: "la Fiesta di Subito, dove sta altrove".
   */
  const perNodo = new Map();          // tipo|marca|nomeNorm → { nome, id, verso: {fonte:[…]} }
  const marcheDi = { auto: new Set(), moto: new Set() };
  for (const r of modelli.relazioni) {
    if (r.da !== 'subito') continue;   // il punto di partenza e' sempre Subito: e' il piu' ricco
    for (const v of r.voci) {
      const k = r.tipo + '|' + v.marca + '|' + norm(v.da.nome);
      if (!perNodo.has(k)) perNodo.set(k, { tipo: r.tipo, marca: v.marca, nome: v.da.nome, id: v.da.id, generazioni: v.da.generazioni || null, verso: {} });
      perNodo.get(k).verso[r.a] = { grado: v.grado, prova: v.prova, viaCasaMadre: v.viaCasaMadre || null, nodi: v.a };
      marcheDi[r.tipo].add(v.marca);
    }
    for (const a of r.assenti) {
      const k = r.tipo + '|' + a.marca + '|' + norm(a.nome);
      if (!perNodo.has(k)) perNodo.set(k, { tipo: r.tipo, marca: a.marca, nome: a.nome, id: a.id, generazioni: null, verso: {} });
      if (!perNodo.get(k).verso[r.a]) perNodo.get(k).verso[r.a] = { grado: 'assente', prova: a.perche || 'nessun candidato in quella fonte', nodi: [] };
      marcheDi[r.tipo].add(a.marca);
    }
  }

  // indice versioni per (marca, modelloId)
  const perVersioni = new Map();
  for (const m of versioni.modelli) perVersioni.set(norm(m.marca) + '|' + m.subito.id, m);

  // nome leggibile della marca: la chiave e' normalizzata, la grafia sta nel ponte marche
  const grafia = new Map();
  for (const tipo of ['auto', 'moto']) for (const v of (marche.voci[tipo] || [])) {
    for (const x of [v.a, v.b]) if (x && x.nome) grafia.set(norm(x.nome), x.nome);
  }

  CACHE = { perNodo, perVersioni, marcheDi, grafia, generatoIl: modelli.generatoIl };
  return CACHE;
}

/** stato leggibile: quanti agganci per grado, per dire all'utente cosa ha in mano */
function riepilogo() {
  const c = carica();
  const per = { auto: {}, moto: {} };
  for (const n of c.perNodo.values()) {
    for (const [fonte, v] of Object.entries(n.verso)) {
      const k = fonte + ':' + v.grado;
      per[n.tipo][k] = (per[n.tipo][k] || 0) + 1;
    }
  }
  return { generatoIl: c.generatoIl, marche: { auto: c.marcheDi.auto.size, moto: c.marcheDi.moto.size }, gradi: per };
}

const GRADI_SPIEGATI = {
  identico: 'stesso nome su entrambe le fonti',
  grossolano: 'la fonte di arrivo e\' meno granulare: piu\' nostri modelli finiscono su quello',
  fine: 'la fonte di arrivo e\' piu\' granulare: il nostro modello ne copre piu\' d\'uno',
  probabile: 'agganciato per somiglianza dei nomi, non per identita\'',
  eccezione: 'deciso a mano dopo verifica',
  assente: 'quella fonte non ha questo modello',
};

function mount(app, opts = {}) {
  const clientIp = opts.clientIp || (req => req.ip);
  const hits = new Map();
  const rateOk = ip => {
    const ora = Date.now(), w = 60000, max = 120;
    const v = (hits.get(ip) || []).filter(t => ora - t < w);
    if (v.length >= max) { hits.set(ip, v); return false; }
    v.push(ora); hits.set(ip, v);
    if (hits.size > 5000) hits.clear();
    return true;
  };
  const via = (rotta, fn) => app.get(rotta, (req, res) => {
    if (!rateOk(clientIp(req))) return res.status(429).json({ ok: false, errore: 'troppe richieste' });
    try {
      res.set('Cache-Control', 'private, max-age=300');
      res.json({ ok: true, ...fn(req.query || {}) });
    } catch (e) {
      console.warn('[ponte] ' + rotta + ': ' + e.message);
      res.status(500).json({ ok: false, errore: e.message });
    }
  });

  /** Cosa c'e' dentro il ponte, per l'intestazione dell'area. */
  via('/api/ponte/stato', () => ({ ...riepilogo(), gradi: undefined, spiegazione: GRADI_SPIEGATI, conta: riepilogo().gradi }));

  /** Le marche che hanno almeno un aggancio, per il menu. */
  via('/api/ponte/marche', q => {
    const c = carica();
    const tipo = q.tipo === 'moto' ? 'moto' : 'auto';
    const marche = [...c.marcheDi[tipo]].map(k => ({ chiave: k, nome: c.grafia.get(k) || k }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
    return { tipo, marche };
  });

  /** I modelli di una marca, ognuno con i suoi agganci e la prova. */
  via('/api/ponte/modelli', q => {
    const c = carica();
    const tipo = q.tipo === 'moto' ? 'moto' : 'auto';
    const marca = norm(q.marca);
    if (!marca) return { tipo, marca: null, modelli: [], motivo: 'marca mancante' };
    const modelli = [];
    for (const n of c.perNodo.values()) {
      if (n.tipo !== tipo || n.marca !== marca) continue;
      modelli.push({
        nome: n.nome, id: n.id,
        generazioni: n.generazioni ? n.generazioni.length : null,
        verso: Object.fromEntries(Object.entries(n.verso).map(([f, v]) => [f, {
          grado: v.grado, prova: v.prova, viaCasaMadre: v.viaCasaMadre,
          nodi: v.nodi.map(x => ({ nome: x.nome, id: x.id, mmmv: x.mmmv || null })),
        }])),
        haVersioni: tipo === 'moto' && c.perVersioni.has(marca + '|' + n.id),
      });
    }
    modelli.sort((a, b) => a.nome.localeCompare(b.nome));
    return { tipo, marca, nomeMarca: c.grafia.get(marca) || marca, modelli };
  });

  /**
   * Da un veicolo alla VERSIONE di Moto.it, cioe' alla sua scheda tecnica.
   * L'esito non e' mai nascosto: `una` e' una risposta, `ripiego` e `ambigua` sono
   * risposte a meta' e vanno mostrate come tali.
   */
  via('/api/ponte/versione', q => {
    const c = carica();
    const marca = norm(q.marca), id = String(q.modelloId || '');
    const voce = c.perVersioni.get(marca + '|' + id);
    if (!voce) return { trovato: false, motivo: 'nessun indice versioni per questo modello' };
    const anno = Number(q.anno) || null;
    const testo = String(q.versione || q.titolo || '');
    const r = risolviVersione(voce, { anno, versione: testo });
    return {
      trovato: true,
      modello: { subito: voce.subito.nome, motoit: voce.motoit },
      versioniSubito: voce.subito.versioni.map(v => ({ id: v.id, nome: v.nome })),
      esito: r.esito, perche: r.perche,
      versioni: r.versioni.map(v => ({
        id: v.id, nome: v.nome, variante: v.variante, anni: v.anni,
        scheda: 'https://www.moto.it/listino/' + (voce.motoit[0] || '') + '/' + (v.modelloSlug || '') + '/' + v.id,
      })),
      tutte: voce.versioniMotoit.length,
    };
  });
}

module.exports = { mount, carica, riepilogo, GRADI_SPIEGATI };
