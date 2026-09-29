'use strict';

const filtriAuto = require('./filtri-auto');
const { correggiModelSlug } = require('./scrapers/motoit-slug');
const province = require('../data/province.json');

const FONTI_PAGINA = ['subito', 'autoscout', 'moto'];
const REGIONI_VALIDE = new Set(Object.values(province).map(p => p.regione));
const normReg = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const REGIONE_BY_NORM = new Map([...REGIONI_VALIDE].map(slug => [normReg(slug), slug]));
const canonRegione = s => REGIONE_BY_NORM.get(normReg(s)) || null;

function parseSearchParams(query) {
  const {
    tipo, marca, modello, prezzoMin, prezzoMax, annoMin, annoMax, kmMin, kmMax, regione, raggio,
    mmmvAutoscout, motoitBrandSlug, motoitModelSlug, motoitBikeCode, versione, fetta, fonti,
    subitoMainStart, subitoRecuperoStart,
  } = query;

  const errors = [];
  if (!tipo || !['auto', 'moto'].includes(tipo)) errors.push('tipo deve essere "auto" o "moto"');
  if (!marca || typeof marca !== 'string' || marca.trim().length === 0) errors.push('marca obbligatoria');

  if (modello != null && typeof modello !== 'string') errors.push('modello deve essere una stringa sola');
  if (regione && !canonRegione(regione)) errors.push(`regione non valida: ${regione}`);

  const primaPagina = fetta === '0' || fetta === 0;
  let fontiPagina = null;
  if (fonti != null) {
    const voci = typeof fonti === 'string' ? fonti.split(',') : [];
    if (!(Number(fetta) > 0 || primaPagina) || !voci.length || new Set(voci).size !== voci.length
        || voci.some(f => !FONTI_PAGINA.includes(f))) errors.push('fonti della pagina non valide');
    else fontiPagina = FONTI_PAGINA.filter(f => voci.includes(f)).join(',');
  }
  const cursoriSubito = subitoMainStart !== undefined || subitoRecuperoStart !== undefined;
  const cursoreSubito = v => v === '-1' ? null
    : typeof v === 'string' && /^(?:0|[1-9]\d*)$/.test(v) && Number(v) % 50 === 0
      && Number(v) <= 2500 ? Number(v) : undefined;
  if (cursoriSubito && (!(Number(fetta) > 0 || primaPagina) || !fontiPagina?.split(',').includes('subito')
      || cursoreSubito(subitoMainStart) === undefined
      || cursoreSubito(subitoRecuperoStart) === undefined)) errors.push('cursori Subito non validi');
  if (errors.length) return { errors };

  const toInt = (val) => {
    if (val == null || val === '') return null;
    const n = Number(val);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };

  return {
    params: {
      tipo:             tipo.trim(),
      marca:            marca.trim(),
      modello:          modello ? modello.trim() : '',
      regione:          regione ? (canonRegione(regione) || '') : '',
      prezzoMin:        toInt(prezzoMin),
      prezzoMax:        toInt(prezzoMax),
      annoMin:          toInt(annoMin),
      annoMax:          toInt(annoMax),
      kmMin:            toInt(kmMin),
      kmMax:            toInt(kmMax),
      raggio:           toInt(raggio),

      fetta:            Math.min(50, Math.max(0, toInt(fetta) || 0)),
      fontiPagina,
      subitoMainStart: cursoriSubito ? cursoreSubito(subitoMainStart) : undefined,
      subitoRecuperoStart: cursoriSubito ? cursoreSubito(subitoRecuperoStart) : undefined,
      mmmvAutoscout:    mmmvAutoscout    || null,
      motoitBrandSlug:  motoitBrandSlug  || null,

      motoitModelSlug:  correggiModelSlug(motoitModelSlug || '') || null,
      motoitBikeCode:   motoitBikeCode   || null,

      versione:         versione ? String(versione).trim().slice(0, 80) : null,

      filtriAuto:       tipo.trim() === 'auto' ? filtriAuto.leggiDaQuery(query) : {},
    }
  };
}

module.exports = { parseSearchParams, FONTI_PAGINA };
