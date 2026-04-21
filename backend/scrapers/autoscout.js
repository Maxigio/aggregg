const axios = require('axios');
const { HEADERS, toSlug, parseEuro, parseKm, extractNextData } = require('./utils');

const BASE = 'https://www.autoscout24.it';

function buildFilters({ prezzoMin, prezzoMax, annoMin, annoMax, kmMax }) {
  const qs = new URLSearchParams({ cy: 'I' });
  if (prezzoMin != null) qs.set('pricefrom', prezzoMin);
  if (prezzoMax != null) qs.set('priceto',   prezzoMax);
  if (annoMin   != null) qs.set('yearfrom',  annoMin);
  if (annoMax   != null) qs.set('yearto',    annoMax);
  if (kmMax     != null) qs.set('kmto',      kmMax);
  return qs;
}

/**
 * URL per moto con modello specifico.
 * /lst-moto/{marca}/{slugMotoAs} — filtra per modello lato Autoscout.
 * Se il modello non esiste su AS (404), scrapeAutoscout fa fallback all'URL brand.
 */
function buildMotoModelUrl(params) {
  const { marca, slugAutoscout, slugMotoAs } = params;
  const qs = buildFilters(params);
  const marcaSlug = slugAutoscout || toSlug(marca);
  return `${BASE}/lst-moto/${marcaSlug}/${slugMotoAs}?${qs.toString()}`;
}

/** URL brand-level per moto (fallback o ricerca senza modello) */
function buildMotoBrandUrl(params) {
  const { marca, slugAutoscout } = params;
  const qs = buildFilters(params);
  const marcaSlug = slugAutoscout || toSlug(marca);
  return `${BASE}/lst-moto/${marcaSlug}?${qs.toString()}`;
}

/** URL per auto, con eventuale filtro mmmv per modello */
function buildAutoUrl(params) {
  const { marca, mmmvAutoscout, slugAutoscout } = params;
  const qs = buildFilters(params);
  qs.set('atype', 'C');
  const marcaSlug = slugAutoscout || toSlug(marca);
  if (mmmvAutoscout) {
    qs.set('mmmv', mmmvAutoscout);
    return `${BASE}/lst?${qs.toString()}`;
  }
  return `${BASE}/lst/${marcaSlug}?${qs.toString()}`;
}

function detail(vehicleDetails, label) {
  return (vehicleDetails || []).find(d => d.ariaLabel === label)?.data;
}

function parseAnno(vehicleDetails) {
  const data = detail(vehicleDetails, 'Anno');
  if (!data) return null;
  const parts = data.split('/');
  const year = parseInt(parts[parts.length - 1], 10);
  return isNaN(year) ? null : year;
}

function parseProvincia(city) {
  if (!city) return null;
  const match = city.match(/\b([A-Z]{2})\s*$/);
  return match ? match[1] : null;
}

function parseListing(item) {
  if (!item.url) return null;
  const url = `${BASE}${item.url}`;

  const make = item.vehicle?.make || '';
  // modelVersionInput = versione dettagliata (es. "320d Touring Eletta")
  // modelGroup = famiglia (es. "X1")
  // model = nome breve (es. "MT-07")
  let modelPart = item.vehicle?.modelVersionInput
                  || item.vehicle?.modelGroup
                  || item.vehicle?.model
                  || '';
  // Rimuovi il prefisso marca se duplicato (es. "BMW BMW 318D" → "BMW 318D")
  if (make && modelPart.toLowerCase().startsWith(make.toLowerCase())) {
    modelPart = modelPart.slice(make.length).trim();
  }

  return {
    fonte:      'autoscout',
    titolo:     [make, modelPart].filter(Boolean).join(' ') || 'Annuncio senza titolo',
    prezzo:     parseEuro(item.price?.priceFormatted),
    km:         parseKm(detail(item.vehicleDetails, 'Chilometraggio')),
    anno:       parseAnno(item.vehicleDetails),
    carburante: detail(item.vehicleDetails, 'Carburante') || null,
    provincia:  parseProvincia(item.location?.city),
    url,
  };
}

async function fetchUrl(url) {
  return axios.get(url, { headers: HEADERS, maxRedirects: 5, timeout: 12000 });
}

async function scrapeAutoscout(params) {
  let response;

  if (params.tipo === 'moto') {
    if (params.slugMotoAs) {
      // Prova URL modello-specifico; su 404 fallback all'URL brand
      const modelUrl = buildMotoModelUrl(params);
      const brandUrl = buildMotoBrandUrl(params);
      console.log(`[Autoscout] Fetching (moto+modello): ${modelUrl}`);
      try {
        response = await fetchUrl(modelUrl);
      } catch (err) {
        if (err.response?.status === 404) {
          console.log(`[Autoscout] 404 modello, fallback brand: ${brandUrl}`);
          response = await fetchUrl(brandUrl);
        } else {
          throw err;
        }
      }
    } else {
      const brandUrl = buildMotoBrandUrl(params);
      console.log(`[Autoscout] Fetching (moto): ${brandUrl}`);
      response = await fetchUrl(brandUrl);
    }
  } else {
    const autoUrl = buildAutoUrl(params);
    console.log(`[Autoscout] Fetching (auto): ${autoUrl}`);
    response = await fetchUrl(autoUrl);
  }

  const nextData = extractNextData(response.data);
  if (!nextData) throw new Error('Autoscout: struttura pagina non riconosciuta');

  const listings = nextData?.props?.pageProps?.listings;
  if (!Array.isArray(listings)) throw new Error('Autoscout: lista annunci non trovata');

  const risultati = listings.map(parseListing).filter(Boolean);
  console.log(`[Autoscout] Trovati ${risultati.length} annunci`);
  return risultati;
}

module.exports = scrapeAutoscout;
