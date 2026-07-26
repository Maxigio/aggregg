'use strict';
/**
 * FONTI — l'area che tiene insieme le banche dati aperte che non sono ne' catalogo ne' annunci.
 *
 * Sono quattro cose diverse, ognuna con la sua scheda, ma stanno insieme per un motivo pratico:
 * il proprietario ha chiesto di poterle "consultare e modificare insieme" mentre si capisce quanti
 * dati rendono. Ognuna dichiara da sola cosa sa e cosa non sa.
 *
 *  - territorio   OpenStreetMap: concessionari concorrenti, officine, gommisti, distributori,
 *                 colonnine, centri revisione, zone a basse emissioni. Per regione.
 *  - pneumatici   EPREL, la banca dati UE delle etichette: 293.999 pneumatici con efficienza,
 *                 aderenza sul bagnato, rumore, neve e ghiaccio. Per misura e marca.
 *  - ricambiOe    bilstein partsfinder: da un codice originale a tutti i suoi equivalenti, con
 *                 le misure tecniche del pezzo.
 *  - cerchi       Wheel-Size: calzate, offset e PRESSIONI di gonfiaggio per modello e anno.
 *
 * Ogni fonte va in rete solo quando la si interroga, con la sua cache e la sua pausa. La pausa
 * dopo un blocco si espone come per il catalogo, cosi' l'interfaccia dice quanto manca invece di
 * far sembrare rotta la sezione.
 */
const osm = require('./scrapers/osm-territorio');
const eprel = require('./scrapers/eprel-pneumatici');
const bilstein = require('./scrapers/bilstein-oe');
const wheelsize = require('./scrapers/wheelsize');

const FONTI = {
  territorio: {
    nome: 'Territorio', dettaglio: 'concorrenti, officine, distributori e colonnine — OpenStreetMap',
    scraper: osm,
    sa: 'Dove sono i concessionari che vendono usato nella tua zona, le officine, i gommisti, i distributori e le colonnine.',
    nonSa: 'OSM e\' compilato da volontari: la copertura e\' ottima nelle citta\' e piu\' rada altrove, e un negozio chiuso puo\' restare mappato.',
  },
  pneumatici: {
    nome: 'Pneumatici', dettaglio: 'etichetta europea ufficiale — EPREL, Commissione UE',
    scraper: eprel,
    sa: 'Efficienza, aderenza sul bagnato, rumore in decibel, neve e ghiaccio di ogni pneumatico registrato in Europa.',
    nonSa: 'Non contiene dati di veicolo: nessuna marca auto, nessun modello. Si cerca per misura o per marca del pneumatico.',
  },
  ricambiOe: {
    nome: 'Ricambi OE', dettaglio: 'da un codice originale a tutti i suoi equivalenti — bilstein group',
    scraper: bilstein,
    sa: 'Dato un codice originale, quali altri codici sono lo stesso pezzo, su quali marche monta e che misure ha.',
    nonSa: 'Copre il catalogo di febi, SWAG e Blue Print: un pezzo che nessuno dei tre produce non c\'e\'.',
  },
  cerchi: {
    nome: 'Cerchi e gomme', dettaglio: 'calzate, offset e pressioni per modello — Wheel-Size',
    scraper: wheelsize,
    sa: 'Le calzate omologate con offset, backspace, peso e soprattutto le PRESSIONI di gonfiaggio anteriore e posteriore.',
    nonSa: 'Distanza fori, diametro di centraggio e coppie di serraggio non sono nella pagina, e la misura del pneumatico e\' in chiaro solo su una riga su sette.',
  },
};

function mount(app, deps = {}) {
  const clientIp = deps.clientIp || (req => req.ip || '');
  const hits = new Map();
  const rateOk = ip => {
    const now = Date.now();
    if (hits.size > 5000) hits.clear();
    const v = (hits.get(ip) || []).filter(t => now - t < 60000);
    v.push(now); hits.set(ip, v); return v.length <= 40;
  };

  const via = (percorso, fonte, lavoro) => app.get(percorso, async (req, res) => {
    if (!rateOk(clientIp(req))) return res.status(429).json({ ok: false, motivo: 'Troppe richieste.' });
    try {
      const out = await lavoro(req.query || {});
      res.set('Cache-Control', 'public, max-age=3600');
      res.json({ ok: true, ...out });
    } catch (e) {
      console.warn('[fonti] ' + percorso + ' KO:', e.message);
      const s = FONTI[fonte] && FONTI[fonte].scraper;
      const fino = s && s.pausaFinoA ? s.pausaFinoA() : 0;
      res.json({ ok: false, motivo: e.message, kind: e.kind || 'error', ...(fino ? { bloccataFino: fino } : {}) });
    }
  });

  // L'elenco delle fonti, con quello che ognuna sa e non sa. Niente cache: porta lo stato di pausa.
  app.get('/api/fonti', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true, adesso: Date.now(),
      fonti: Object.entries(FONTI).map(([id, f]) => {
        const fino = f.scraper.pausaFinoA ? f.scraper.pausaFinoA() : 0;
        return { id, nome: f.nome, dettaglio: f.dettaglio, sa: f.sa, nonSa: f.nonSa, ...(fino ? { bloccataFino: fino } : {}) };
      }),
    });
  });

  // ─── Territorio ────────────────────────────────────────────────────────────
  app.get('/api/fonti/territorio/categorie', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({
      ok: true,
      categorie: Object.entries(osm.CATEGORIE).map(([id, c]) => ({ id, nome: c.nome })),
      regioni: Object.keys(osm.REGIONI),
    });
  });
  via('/api/fonti/territorio/conta', 'territorio', q => osm.conta(q.regione || null).then(c => ({ regione: q.regione || null, conteggi: c })));
  via('/api/fonti/territorio/oggetti', 'territorio', async q => {
    if (!q.categoria) return { oggetti: [], motivo: 'categoria mancante' };
    const v = await osm.oggetti(String(q.categoria), q.regione ? String(q.regione) : null);
    return { categoria: q.categoria, regione: q.regione || null, totale: v.length, oggetti: v.slice(0, 3000) };
  });

  // ─── Pneumatici ────────────────────────────────────────────────────────────
  via('/api/fonti/pneumatici/totale', 'pneumatici', () => eprel.totale().then(t => ({ totale: t })));
  via('/api/fonti/pneumatici/cerca', 'pneumatici', q => {
    if (!q.misura && !q.marca) return Promise.resolve({ pneumatici: [], motivo: 'serve almeno una misura o una marca' });
    return eprel.cerca({ misura: q.misura, marca: q.marca, classe: q.classe, pagina: q.pagina });
  });

  // ─── Ricambi OE ────────────────────────────────────────────────────────────
  via('/api/fonti/ricambi-oe/cerca', 'ricambiOe', q => {
    if (!q.codice) return Promise.resolve({ articoli: [], motivo: 'codice mancante' });
    return bilstein.perCodice(String(q.codice), q.tipo);
  });
  via('/api/fonti/ricambi-oe/equivalenti', 'ricambiOe', q => {
    if (!q.codice) return Promise.resolve({ equivalenti: [], motivo: 'codice mancante' });
    return bilstein.equivalenti(String(q.codice), q.tipo);
  });

  // ─── Cerchi e gomme ────────────────────────────────────────────────────────
  via('/api/fonti/cerchi/calzate', 'cerchi', q => {
    if (!q.marca || !q.modello || !q.anno) return Promise.resolve({ calzate: [], motivo: 'servono marca, modello e anno' });
    return wheelsize.calzate(String(q.marca), String(q.modello), String(q.anno));
  });
}

module.exports = { mount, FONTI };
