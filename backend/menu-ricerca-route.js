'use strict';

const { resolveMotoitSlug } = require('./scrapers/motoit-brands');
const { getBrandModels, correggiModelSlug } = require('./scrapers/motoit-models');
const { unisciGemelli, marcheNascoste, sinonimiTendina } = require('./menu-gemelli');
const { versioniDi } = require('./versioni-menu');
const { norm } = require('./scrapers/brand-match');
const modelsData = require('../data/models.json');

function mount(app) {
  app.get('/api/brands', (req, res) => {
    const { tipo } = req.query;
    if (!tipo || !['auto', 'moto'].includes(tipo)) {
      return res.status(400).json({ error: 'tipo deve essere "auto" o "moto"' });
    }
    const brands = modelsData[tipo] || {};
    const lista = Object.entries(brands)
      .map(([nome, b]) => ({
        nome,
        sites:     b.sites || [],
        autoscout: b.autoscout || null,
      }));

    if (tipo === 'moto') {
      const raggiunte = new Set(lista.map(b => resolveMotoitSlug(b.nome)).filter(Boolean));
      let cat = null;
      try { cat = require('../data/motoit-catalogo.json'); } catch (_) { cat = null; }
      for (const [slug, m] of Object.entries((cat && (cat.marche || cat)) || {})) {
        if (raggiunte.has(slug) || !m || !Object.keys(m.modelli || {}).length) continue;
        lista.push({ nome: m.nome || slug, sites: ['motoit'], autoscout: null });
      }
    }

    const nascoste = marcheNascoste(tipo);
    const visibili = lista.filter(b => !nascoste.has(b.nome));
    visibili.sort((a, b) => a.nome.localeCompare(b.nome, 'it', { sensitivity: 'base' }));
    res.json({ brands: visibili, sinonimi: sinonimiTendina(tipo) });
  });

  app.get('/api/models', async (req, res) => {
    const { tipo, marca } = req.query;
    if (!tipo || !['auto', 'moto'].includes(tipo)) {
      return res.status(400).json({ error: 'tipo deve essere "auto" o "moto"' });
    }
    if (!marca || typeof marca !== 'string' || marca.trim().length === 0) {
      return res.status(400).json({ error: 'marca obbligatoria' });
    }
    const entry = modelsData[tipo]?.[marca.trim()];

    const modelli = ((entry && entry.models) || []).map(m => ({
      nome:           m.nome,
      sites:          m.sites || [],
      mmmvAutoscout:  m.mmmvAutoscout  || '',

      slugMotoIt:     correggiModelSlug(m.slugMotoIt || ''),
    }));

    modelli.push(...unisciGemelli(tipo, marca.trim(), modelli, modelsData));
    modelli.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));

    let motoitKo = null;
    if (tipo === 'moto') {
      const brandSlug = (entry && entry.motoit && entry.motoit.brandSlug) || resolveMotoitSlug(marca.trim()) || null;
      if (brandSlug) {
        try {

          const apiModels = await getBrandModels(brandSlug, { rilancia: true,
            soloLocale: req.fontiSospese?.includes('moto') === true });
          const byName = new Map(modelli.map(m => [norm(m.nome), m]));
          for (const am of apiModels) {
            const hit = byName.get(norm(am.name));
            if (hit) { if (!hit.slugMotoIt) hit.slugMotoIt = am.slug; }
            else {
              const nm = { nome: am.name, sites: ['motoit'], mmmvAutoscout: '', slugMotoIt: am.slug };
              modelli.push(nm); byName.set(norm(am.name), nm);
            }
          }
          modelli.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
        } catch (e) { console.warn('[api/models] merge Moto.it KO:', e.message); motoitKo = e.message || 'moto.it non raggiungibile'; }
      }
    }

    res.json({ modelli, sites: (entry && entry.sites) || (tipo === 'moto' ? ['motoit'] : []),
      ...(motoitKo ? { fonteMotoitKo: motoitKo } : {}) });
  });

  app.get('/api/versioni', (req, res) => {
    const tipo = String((req.query || {}).tipo || '');
    const marca = String((req.query || {}).marca || '').trim();
    const modello = String((req.query || {}).modello || '').trim();
    if (!['auto', 'moto'].includes(tipo)) return res.status(400).json({ error: 'tipo deve essere "auto" o "moto"' });
    if (!marca || !modello) return res.status(400).json({ error: 'marca e modello obbligatori' });
    res.json({ versioni: versioniDi(tipo, marca, modello) });
  });
}

module.exports = { mount };
