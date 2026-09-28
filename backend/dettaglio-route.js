'use strict';

const { getDetail, fonteFromUrl } = require('./scrapers/detail');
const salute = require('./fonti-salute');

function mount(app, { chiaveLimite }) {
  const limiteDettaglio = require('./limite-richieste').crea({ max: 30, cosa: 'richieste di dettagli alle fonti' });
  app.get('/api/detail', async (req, res) => {
    const url = req.query.url;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url obbligatorio' });
    try {
      const detail = await getDetail(url, { onRequest: () => {
        const gDet = limiteDettaglio.consuma(chiaveLimite(req));
        if (!gDet.ok) throw Object.assign(new Error(limiteDettaglio.messaggio(gDet)),
          { code: 'AMR_DETAIL_LIMIT', riprovaFra: gDet.attesa });
      } });
      if (!detail) return res.json({ ok: false, detail: null });
      const fonte = fonteFromUrl(url);
      res.json({ ok: true, detail, fonte, pausa: salute.fermo(fonte) });
    } catch (e) {
      if (e.code === 'AMR_DETAIL_LIMIT') {
        return res.status(429).json({ ok: false, error: e.message, limiteDettaglio: true, riprovaFra: e.riprovaFra });
      }
      if (e.code === 'DETAIL_BODY_TOO_LARGE') {
        return res.status(502).json({ ok: false, error: e.message, detailTroppoGrande: true, fonte: e.fonte });
      }
      if (e.status === 429 || e.code === 'FONTE_IN_PAUSA') {
        return res.status(502).json({ ok: false, error: e.message, fonte: e.fonte, pausa: salute.fermo(e.fonte) });
      }
      return res.status(400).json({ error: e.message });
    }
  });
}

module.exports = { mount };
