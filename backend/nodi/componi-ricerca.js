'use strict';

const { FONTI_PAGINA } = require('../ricerca-parametri');
const STATI_COMPLETI = new Set(['ok', 'empty']);

function porzioneCompleta(data, fonte) {
  const stato = data?.sources?.[fonte];
  return Array.isArray(data?.risultati) && stato && STATI_COMPLETI.has(stato.status)
    && !stato.parzialeRete && !stato.parziale && !stato.bloccoParziale;
}

// La risposta del nodo principale resta l'autorita' per le fonti non delegate.
// Una porzione sostituisce la fonte corrispondente, mai l'intera ricerca.
function componiRicerca(principale, sostituzioni = {}) {
  if (!principale || !Array.isArray(principale.risultati) || !principale.sources) {
    throw new TypeError('risposta principale non valida');
  }

  const scelte = {};
  for (const fonte of FONTI_PAGINA) {
    const candidata = sostituzioni[fonte];
    scelte[fonte] = candidata && porzioneCompleta(candidata, fonte) ? candidata : principale;
  }
  const risultati = FONTI_PAGINA.flatMap(fonte =>
    scelte[fonte].risultati.filter(r => r && r.fonte === fonte));
  const sources = { ...principale.sources };
  for (const fonte of FONTI_PAGINA) sources[fonte] = scelte[fonte].sources[fonte];

  const contaVersione = FONTI_PAGINA.some(fonte => scelte[fonte].versioneConto !== null
    && scelte[fonte].versioneConto !== undefined);
  const versioneConto = contaVersione ? { confermata: 0, smentita: 0, ignota: 0 } : null;
  const versionePerFonte = contaVersione ? {} : null;
  if (contaVersione) for (const fonte of FONTI_PAGINA) {
    const conto = scelte[fonte].versionePerFonte?.[fonte];
    if (!conto) continue;
    versionePerFonte[fonte] = { ...conto };
    for (const stato of Object.keys(versioneConto)) versioneConto[stato] += conto[stato] || 0;
  }

  return {
    ...principale,
    risultati,
    totale: risultati.length,
    sources,
    versioneConto,
    versionePerFonte,
    subitoStatus: sources.subito.status,
    subitoReason: sources.subito.reason || null,
  };
}

module.exports = { componiRicerca, porzioneCompleta };
