'use strict';
const FONTI = ['subito', 'autoscout', 'moto'];
const ESITI = ['ok', 'vuoto', 'bloccato', 'auth', 'transitorio', 'errore'];
function statoFonti(salute) {
  const quadro = salute.stato();
  return Object.fromEntries(FONTI.map(fonte => {
    const r = quadro.fonti.find(f => f.fonte === fonte);
    return [fonte, { ...salute.fermo(fonte),
      esito: quadro.guasto ? null : r?.esito ?? null,
      aggiornataIl: quadro.guasto ? null : r?.aggiornataIl ?? null }];
  }));
}
// La proiezione tecnica è separata da archivio, messaggi remoti e dati delle ricerche.
function valide(fonti) {
  return fonti && typeof fonti === 'object' && !Array.isArray(fonti)
    && Object.keys(fonti).every(f => FONTI.includes(f))
    && Object.values(fonti).every(f => f && typeof f === 'object' && !Array.isArray(f)
      && typeof f.fermo === 'boolean'
      && (f.esito === undefined || f.esito === null || ESITI.includes(f.esito))
      && (f.aggiornataIl === undefined || f.aggiornataIl === null || Number.isSafeInteger(f.aggiornataIl) && f.aggiornataIl >= 0));
}
module.exports = { statoFonti, valide };
