'use strict';

const salute = require('../fonti-salute');
const { lookupBrand } = require('../catalogo-ricerca');
const { risolviNodo } = require('../scrapers/subito-nodo');
const versioneMoto = require('../scrapers/motoit-versione');
const SCENARI = require('./sonde-scenari');
const formato = () => Object.assign(new Error('sonda: catalogo o risposta incompatibile'),
  { code: 'FONTE_FORMATO', kind: 'error' });

function parametri(fonte) {
  const p = { ...SCENARI[fonte] };
  if (!p.tipo) throw formato();
  const b = lookupBrand(p.tipo, p.marca)?.entry;
  const modello = b?.models?.find(m => m.nome === p.modello);
  if (fonte === 'subito') {
    p.subitoNodo = risolviNodo(p.tipo, p.marca, p.modello);
    if (p.subitoNodo?.famigliaIds?.length !== 1) throw formato();
    p.subitoVersioneTesto = p.versione;
  } else if (fonte === 'autoscout') {
    if (!modello?.mmmvAutoscout) throw formato();
    p.mmmvAutoscout = modello.mmmvAutoscout;
    p.autoscoutVersionText = p.versione;
  } else {
    // Solo catalogo locale: risolvere Rally non deve generare chiamate di menu.
    p.motoitBrandSlug = b?.motoit?.brandSlug;
    const cat = require('../../data/motoit-catalogo.json');
    const voce = (cat.marche || cat)[p.motoitBrandSlug]?.modelli;
    const coppia = Object.entries(voce || {}).find(([, m]) => m.nome === p.modello);
    if (!coppia) throw formato();
    p.motoitModelSlug = coppia[0];
    const bikes = Object.entries(coppia[1].versioni || {}).map(([code, v]) => ({ code, name: v.nome }));
    const versioni = versioneMoto.risolvi(bikes, p.versione, p).versioni;
    if (!versioni.length) throw formato();
    if (versioni.length === 1) p.motoitBikeCode = versioni[0].code;
    else p.motoitSlugAmmessi = new Set(versioni.map(v => v.slug));
  }
  return p;
}

async function eseguiSonda(fonte) {
  if (!Object.hasOwn(SCENARI, fonte)) return { status: 400, body: { codice: 'sonda_non_valida' } };
  try {
    await salute.sonda(fonte, async () => {
      const p = parametri(fonte);
      const scraper = require({ subito: '../scrapers/subito-api', autoscout: '../scrapers/autoscout-graphql',
        moto: '../scrapers/motoit' }[fonte]);
      // Una pagina, senza cache di retry né recupero «Altro modello».
      const r = await scraper(p, { maxPages: 1, fetta: 0, withMeta: true,
        senzaRecupero: true, sort: 'priceasc', sonda: true });
      if (r.sospetto || r.parzialeRete) throw formato();
      // Le righe e il body restano transitori: alla diagnostica arriva solo l'esito.
    });
    const f = salute.fermo(fonte);
    return { status: f.fermo ? 503 : 200, body: { fonte, stato: f.intervento ? 'intervento' : f.fermo ? 'pausa' : 'ok',
      proveFatte: f.proveFatte || 0, intervento: f.intervento || null } };
  } catch (e) {
    const f = salute.fermo(fonte);
    return { status: 502, body: { fonte, stato: f.intervento ? 'intervento' : 'errore',
      http: Number.isInteger(e.status) ? e.status : null,
      proveFatte: f.proveFatte || 0, intervento: f.intervento || null } };
  }
}

module.exports = { SCENARI, parametri, eseguiSonda };
