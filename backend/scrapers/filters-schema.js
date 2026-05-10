/**
 * Schema dei filtri esposti da ciascuno dei 3 siti (Subito, AS24, Moto.it).
 *
 * Ogni filtro descrive:
 *   - `key`:        identificatore univoco lato app (es. "carburante")
 *   - `label`:      etichetta UI italiana
 *   - `type`:       'select' | 'range' | 'checkbox' | 'tristate'
 *   - `urlParam`:   nome del parametro URL del sito (gli scraper lo usano in buildUrl)
 *   - `values`:     [{ value, label }] per `select`; null per range/checkbox
 *   - `appliesTo`:  ['auto', 'moto'] | ['auto'] | ['moto']
 *
 * Filtri "comuni" (prezzo, anno, km, regione) NON sono qui — sono in
 * "filtri base" universali nel form principale, normalizzati al volo.
 *
 * NOTA: l'inventario è "top 5-8 per sito" (decisione utente B1). Nuovi
 * filtri si aggiungono qui senza toccare il resto della pipeline.
 */

// ─── Subito.it ────────────────────────────────────────────────────────────
// Subito espone i filtri come query params su /annunci-{regione}/vendita/{cat}/
// Param osservati nei link "raffina ricerca": fu, gb, ms, cvs, ag, ec.
// Riferimento: https://hades.subito.it/v1/values/<filterKey> per i valori.
const SUBITO_FILTERS = [
  {
    key: 'tipoAnnuncio',
    label: 'Tipo annuncio',
    type: 'select',
    urlParam: 'a',
    values: [
      { value: 'p', label: 'Privato' },
      { value: 'b', label: 'Concessionario' },
    ],
    appliesTo: ['auto', 'moto'],
  },
  {
    key: 'carburante',
    label: 'Carburante',
    type: 'select',
    urlParam: 'fu',
    // Subito usa codici numerici (verificati su /v1/values/fuel)
    values: [
      { value: '1', label: 'Benzina' },
      { value: '2', label: 'Diesel' },
      { value: '3', label: 'GPL' },
      { value: '4', label: 'Metano' },
      { value: '5', label: 'Ibrida' },
      { value: '6', label: 'Elettrica' },
    ],
    appliesTo: ['auto'],
  },
  {
    key: 'cambio',
    label: 'Cambio',
    type: 'select',
    urlParam: 'gb',
    values: [
      { value: '1', label: 'Manuale' },
      { value: '2', label: 'Automatico' },
    ],
    appliesTo: ['auto'],
  },
  {
    key: 'kmMin',
    label: 'Km minimi',
    type: 'range',
    urlParam: 'ms',
    // Subito usa indici categoria (vedi KM_MAX_TABLE in subito-playwright.js)
    rangeKind: 'kmCategory',
    appliesTo: ['auto', 'moto'],
  },
  {
    key: 'condizione',
    label: 'Condizione',
    type: 'select',
    urlParam: 'cvs',
    values: [
      { value: '1', label: 'Usato' },
      { value: '2', label: 'Nuovo' },
      { value: '3', label: 'Km 0' },
    ],
    appliesTo: ['auto', 'moto'],
  },
];

// ─── Autoscout24 ──────────────────────────────────────────────────────────
// AS24 espone moltissimi filtri via query params. Documentazione (parziale)
// dedotta da analisi URL del frontend AS24 italiano.
const AUTOSCOUT_FILTERS = [
  {
    key: 'carburante',
    label: 'Carburante',
    type: 'select',
    urlParam: 'fuel',
    values: [
      { value: 'B', label: 'Benzina' },
      { value: 'D', label: 'Diesel' },
      { value: 'H', label: 'Ibrida' },
      { value: '2', label: 'Metano (CNG)' },
      { value: 'L', label: 'GPL' },
      { value: 'E', label: 'Elettrica' },
    ],
    appliesTo: ['auto', 'moto'],
  },
  {
    key: 'cambio',
    label: 'Cambio',
    type: 'select',
    urlParam: 'gear',
    values: [
      { value: 'M', label: 'Manuale' },
      { value: 'A', label: 'Automatico' },
      { value: 'S', label: 'Semi-automatico' },
    ],
    appliesTo: ['auto'],
  },
  {
    key: 'carrozzeria',
    label: 'Carrozzeria',
    type: 'select',
    urlParam: 'bt',
    values: [
      { value: '1', label: 'Cabrio' },
      { value: '2', label: 'Berlina' },
      { value: '3', label: 'Coupé' },
      { value: '4', label: 'SUV / Fuoristrada' },
      { value: '5', label: 'Station Wagon' },
      { value: '6', label: 'Furgone' },
      { value: '7', label: 'Monovolume' },
      { value: '8', label: 'Altro' },
    ],
    appliesTo: ['auto'],
  },
  {
    key: 'trazione',
    label: 'Trazione',
    type: 'select',
    urlParam: 'dt',
    values: [
      { value: 'F', label: 'Anteriore' },
      { value: 'R', label: 'Posteriore' },
      { value: '4', label: 'Integrale (4WD)' },
    ],
    appliesTo: ['auto'],
  },
  {
    key: 'potenzaCv',
    label: 'Potenza (CV)',
    type: 'range',
    urlParamFrom: 'powerfrom',
    urlParamTo:   'powerto',
    // AS24 in CV (HP); converte da kW se necessario via &powertype=hp
    rangeKind: 'numeric',
    appliesTo: ['auto', 'moto'],
  },
  {
    key: 'numeroPorte',
    label: 'Porte',
    type: 'select',
    urlParam: 'doorfrom',
    values: [
      { value: '2', label: '2/3 porte' },
      { value: '4', label: '4/5 porte' },
    ],
    appliesTo: ['auto'],
  },
];

// ─── Moto.it ──────────────────────────────────────────────────────────────
// Moto.it /moto-usate/ricerca espone filtri tramite params query.
// Param osservati: brand, model, price_f, price_t, km_f, km_t, year_f,
// year_t, displacement_f, displacement_t, category, region, sort.
const MOTOIT_FILTERS = [
  {
    key: 'cilindrata',
    label: 'Cilindrata (cc)',
    type: 'range',
    urlParamFrom: 'displacement_f',
    urlParamTo:   'displacement_t',
    rangeKind: 'numeric',
    appliesTo: ['moto'],
  },
  {
    key: 'categoria',
    label: 'Categoria moto',
    type: 'select',
    urlParam: 'category',
    values: [
      { value: 'naked',     label: 'Naked' },
      { value: 'sport',     label: 'Sport' },
      { value: 'touring',   label: 'Touring' },
      { value: 'enduro',    label: 'Enduro / Adventure' },
      { value: 'cross',     label: 'Cross' },
      { value: 'cruiser',   label: 'Cruiser / Custom' },
      { value: 'scooter',   label: 'Scooter' },
      { value: 'classica',  label: 'Classica / Vintage' },
      { value: 'altro',     label: 'Altro' },
    ],
    appliesTo: ['moto'],
  },
  {
    key: 'kmMin',
    label: 'Km minimi',
    type: 'range',
    urlParam: 'km_f',
    rangeKind: 'numeric',
    appliesTo: ['moto'],
  },
  {
    key: 'tipoAnnuncio',
    label: 'Tipo annuncio',
    type: 'select',
    urlParam: 'seller',
    values: [
      { value: 'private',  label: 'Privato' },
      { value: 'dealer',   label: 'Concessionario' },
    ],
    appliesTo: ['moto'],
  },
  {
    key: 'condizione',
    label: 'Condizione',
    type: 'select',
    urlParam: 'condition',
    values: [
      { value: 'new',   label: 'Nuovo' },
      { value: 'used',  label: 'Usato' },
    ],
    appliesTo: ['moto'],
  },
];

// ─── Schema unificato per /api/filters ────────────────────────────────────
// L'endpoint restituisce solo i filtri rilevanti per il `tipo` richiesto.
function getSchema(tipo) {
  if (!['auto', 'moto'].includes(tipo)) {
    throw new Error('tipo deve essere "auto" o "moto"');
  }
  const filterFor = (filters) => filters.filter(f => f.appliesTo.includes(tipo));
  return {
    subito:    filterFor(SUBITO_FILTERS),
    autoscout: filterFor(AUTOSCOUT_FILTERS),
    motoit:    tipo === 'moto' ? filterFor(MOTOIT_FILTERS) : [],
  };
}

// ─── Helpers per gli scraper ──────────────────────────────────────────────
// Applica un blob di filtri sito-specifici a una URLSearchParams esistente.
// Il blob è di forma: { keyApp: valoreSelezionato, ... } (es. { carburante: 'D' }).
function applySiteFilters(qs, siteFilters, schemaForSite) {
  if (!siteFilters || typeof siteFilters !== 'object') return qs;
  for (const f of schemaForSite) {
    const val = siteFilters[f.key];
    if (val == null || val === '') continue;
    if (f.type === 'range' && typeof val === 'object') {
      // val = { from, to }
      if (f.urlParamFrom && val.from != null && val.from !== '') {
        qs.set(f.urlParamFrom, String(val.from));
      }
      if (f.urlParamTo && val.to != null && val.to !== '') {
        qs.set(f.urlParamTo, String(val.to));
      }
      if (f.urlParam && val.from != null && val.from !== '' && !f.urlParamFrom) {
        qs.set(f.urlParam, String(val.from));
      }
    } else if (f.urlParam) {
      qs.set(f.urlParam, String(val));
    }
  }
  return qs;
}

module.exports = {
  SUBITO_FILTERS,
  AUTOSCOUT_FILTERS,
  MOTOIT_FILTERS,
  getSchema,
  applySiteFilters,
};
