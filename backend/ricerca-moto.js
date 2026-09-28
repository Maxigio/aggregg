'use strict';

const { resolveMotoitSlug } = require('./scrapers/motoit-brands');
const { famiglieMotoit, getModelBikes, correggiModelSlug } = require('./scrapers/motoit-models');
const motoitVersione = require('./scrapers/motoit-versione');
const { resolveAs24Narrowing, as24Spellings, norm } = require('./scrapers/brand-match');

async function preparaModello(params, brandEntry, modelEntry, richiestaMoto) {
  if (params.tipo !== 'moto') return;
  if (!params.motoitBrandSlug) {
    params.motoitBrandSlug = brandEntry?.motoit?.brandSlug || resolveMotoitSlug(params.marca) || null;
  }
  if (!params.motoitModelSlug && modelEntry?.slugMotoIt) {
    params.motoitModelSlug = correggiModelSlug(modelEntry.slugMotoIt);
  }
  if (richiestaMoto && !params.motoitModelSlug && params.motoitBrandSlug && params.modello) {
    try {
      params.motoitModelSlug = await famiglieMotoit(params.motoitBrandSlug, params.modello, { rilancia: true }) || null;
    } catch (_) {
      params.motoitModelloKoRete = true;
    }
  }
}

function preparaAutoscout(params, brandEntry, asMakeId) {
  if (params.tipo !== 'moto' || !params.modello || params.mmmvAutoscout) return;
  const nar = resolveAs24Narrowing(brandEntry?.models, params.modello, asMakeId);
  params.autoscoutMmmv = nar.mmmv;
  params.autoscoutVersionText = nar.versionText;
  params.autoscoutSpellings = as24Spellings(params.modello);
  params.as24Padre = nar.padre;
  params.as24Fratelli = nar.padre
    ? (brandEntry?.models || []).map(m => m.nome).filter(n =>
        norm(n).startsWith(norm(nar.padre)) && norm(n) !== norm(params.modello)
        && !norm(params.modello).startsWith(norm(n)))
    : null;
  console.log(`[server] AS24 fase1 "${params.marca} ${params.modello}": mmmv=${nar.mmmv}${nar.padre ? ` (padre "${nar.padre}")` : ' (brand-only)'} + grafie ${JSON.stringify(params.autoscoutSpellings)}`);
}

async function preparaVersione(params, richiestaMoto) {
  if (richiestaMoto && params.versione && params.tipo === 'moto'
      && params.motoitBrandSlug && params.motoitModelSlug && !params.motoitBikeCode) {
    try {
      const fam = String(params.motoitModelSlug).split(',').map(s => s.trim()).filter(Boolean);
      const TETTO_FAM = 12;
      if (fam.length > TETTO_FAM) {
        params.motoitVersioneElencoMonco = `"${params.modello}" aggancia ${fam.length} famiglie su Moto.it (oltre ${TETTO_FAM}): il filtro versione non si applica a questa fonte, si cerca largo`;
        console.log(`[server] Moto.it: ${params.motoitVersioneElencoMonco}`);
        throw new Error(`troppe famiglie (${fam.length}) per risolvere la versione`);
      }
      let famigliKo = 0;
      const bikes = (await Promise.all(fam.map(s =>
        getModelBikes(params.motoitBrandSlug, s, { rilancia: true }).catch(() => { famigliKo++; return []; })
      ))).flat();
      if (famigliKo) {
        params.motoitVersioneElencoMonco = famigliKo >= fam.length
          ? 'il menu versioni di Moto.it non ha risposto: il filtro versione non e\' stato applicato a questa fonte'
          : `${famigliKo} famiglie su ${fam.length} non hanno risposto: l'elenco versioni di Moto.it e' incompleto`;
        params.motoitVersioneKoRete = true;
        console.warn(`[server] Moto.it: ${params.motoitVersioneElencoMonco}`);
      }
      const r = motoitVersione.risolvi(bikes, params.versione, { marca: params.marca, modello: params.modello });
      if (r.versioni.length === 1) {
        params.motoitBikeCode = r.versioni[0].code;
        console.log(`[server] Moto.it: "${params.versione}" → bike=${r.versioni[0].code} ("${r.versioni[0].nome}")`);
      } else if (r.versioni.length > 1) {
        params.motoitSlugAmmessi = new Set(r.versioni.map(v => v.slug));
        console.log(`[server] Moto.it: "${params.versione}" → ${r.versioni.length} versioni, filtro sullo slug dell'annuncio`);
      } else {
        console.log(`[server] Moto.it: "${params.versione}" non e' nel suo catalogo → nessun filtro versione`);
      }
      if (r.scartate.length) {
        params.motoitVersioneScartate = r.scartate.slice();
        console.log(`[server] Moto.it: parole ignorate ${JSON.stringify(r.scartate)}`);
      }
    } catch (e) {
      console.warn('[server] Moto.it versione non risolta: ' + e.message);
    }
  } else if (params.versione && params.tipo === 'moto' && params.motoitBrandSlug && !params.motoitModelSlug && !params.motoitBikeCode) {
    params.motoitVersioneElencoMonco = `il modello non ha un codice su Moto.it: la ricerca su questa fonte e' larga e la versione "${params.versione}" non la filtra (righe da verificare)`;
    console.log(`[server] Moto.it: ${params.motoitVersioneElencoMonco}`);
  }
}

function dichiaraRisultati(params, risultati, versioneChiesta) {
  for (const r of risultati) {
    if (r.fonte !== 'moto' || r.dichiarazione) continue;
    if (!params.motoitModelSlug) r.dichiarazione = 'senza-modello';
    else if (params.motoitBikeCode || (params.motoitSlugAmmessi && params.motoitSlugAmmessi.size)) {
      r.dichiarazione = (params.motoitVersioneScartate && params.motoitVersioneScartate.length)
        ? 'versione-non-verificata' : 'esatto';
    } else if (versioneChiesta) r.dichiarazione = 'versione-non-verificata';
    else r.dichiarazione = r.variante ? 'esatto' : 'senza-versione';
  }
}

module.exports = { preparaModello, preparaAutoscout, preparaVersione, dichiaraRisultati };
