'use strict';
/**
 * model_key + funzioni di bucketizzazione (PURE, testabili).
 *
 * model_key raggruppa annunci comparabili dello stesso veicolo a fasce:
 *   tipo | norm(marca) | norm(modello) | bucketAnno_v1(anno) | bucketKm_v1(km)
 * es. "auto|bmw|320d|2013-2015|100-150k"
 *
 * `tipo` davanti per non collidere auto/moto della stessa marca.
 * Le funzioni bucket sono VERSIONATE (`_v1`): se cambiano i confini delle
 * fasce → bump a `_v2` + migrazione che ricalcola model_key sulle listings
 * (model_key è SALVATO in colonna, non derivato a runtime).
 */

// Normalizzazione coerente con scripts/build-comune-regione.js: lowercase,
// rimuove accenti, comprime non-alfanumerici in trattino.
function norm(s) {
  return String(s == null ? '' : s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Anno → bande di 3 anni ancorate ai multipli di 3 (2013 è divisibile per 3).
// 2015 → "2013-2015", 2016 → "2016-2018". anno mancante → "na".
function bucketAnno_v1(anno) {
  const y = parseInt(anno, 10);
  if (!Number.isFinite(y) || y < 1900 || y > 2100) return 'na';
  const start = y - (y % 3);
  return `${start}-${start + 2}`;
}

// Km → fasce crescenti (in migliaia). Soglie pensate per l'usato:
// 0-15k, 15-30k, 30-50k, 50-75k, 75-100k, 100-150k, 150-200k, 200k+.
// km mancante → "na". km=0 (nuovo/km0) → "0-15k".
const KM_EDGES = [15, 30, 50, 75, 100, 150, 200]; // in migliaia
function bucketKm_v1(km) {
  const k = parseInt(km, 10);
  if (!Number.isFinite(k) || k < 0) return 'na';
  const th = k / 1000;
  let lo = 0;
  for (const edge of KM_EDGES) {
    if (th < edge) return `${lo}-${edge}k`;
    lo = edge;
  }
  return `${lo}k+`; // 200k+
}

// Chiave di raggruppamento. Senza marca+modello → null (chiamante non scrive).
function modelKey(tipo, marca, modello, anno, km) {
  const t = norm(tipo) || 'na';
  const ma = norm(marca);
  const mo = norm(modello);
  if (!ma || !mo) return null;
  return `${t}|${ma}|${mo}|${bucketAnno_v1(anno)}|${bucketKm_v1(km)}`;
}

module.exports = { norm, bucketAnno_v1, bucketKm_v1, modelKey };
