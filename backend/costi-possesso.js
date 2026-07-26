'use strict';
/**
 * COSTO DI POSSESSO per provincia: quanto costa TENERE un veicolo dove vive chi lo compra.
 *
 * Completa i due lati che l'app gia' copriva: comprarlo (IPT, backend/ipt.js) e muoverlo
 * (carburante per provincia). Dati da data/costi-provincia.json, generato da
 * scripts/build-costi-provincia.js da IVASS (premi r.c. auto effettivamente pagati) e MEF
 * (aliquota dell'imposta deliberata da ogni Provincia).
 *
 * DUE AVVERTENZE che vanno dette all'utente e non nascoste:
 *  - sono statistiche PROVINCIALI su tutte le polizze: non un preventivo per il veicolo in
 *    vendita. Non tengono conto di potenza, eta' del conducente ne' classe di merito — tranne
 *    dove si chiede esplicitamente una classe bonus-malus, che IVASS pubblica a parte;
 *  - sette province non hanno l'aliquota e una non ha i premi, per ragioni della fonte e non
 *    nostre (vedi il campo `assenti` nel JSON). Li' si risponde null, non si stima.
 *
 * La MEDIANA e' il numero da mostrare: la media la tirano in alto le poche polizze carissime
 * (a Milano media 416 contro mediana 355).
 */
const D = require('../data/costi-provincia.json');

const TIPI = new Set(['auto', 'moto', 'ciclomotore']);

/**
 * @param {string} sigla  sigla di provincia ('MI'), come la risolve backend/province-sigla.js
 * @param {string} [tipo] 'auto' | 'moto' | 'ciclomotore' (default 'auto')
 * @returns {object|null} null se la provincia non esiste; i campi mancanti restano null
 */
function cerca(sigla, tipo) {
  const sg = String(sigla || '').toUpperCase().trim();
  const p = D.province[sg];
  if (!p) return null;
  const t = TIPI.has(tipo) ? tipo : 'auto';
  const rc = p[t] || null;
  const assente = a => (D.assenti && D.assenti[a] ? D.assenti[a] : null);
  return {
    provincia: sg,
    tipo: t,
    // Premio r.c.: mediana come valore da mostrare, media e percentili per chi vuole la forchetta.
    rc: rc && rc.mediana != null ? {
      mediana: rc.mediana, medio: rc.medio,
      p10: rc.p10, p25: rc.p25, p75: rc.p75, p90: rc.p90,
      perClasse: rc.perClasse || null,
    } : null,
    rcMotivo: rc && rc.mediana != null ? null
      : (assente('rc') && assente('rc').sigle.includes(sg) ? assente('rc').perche : 'dato non disponibile per questa provincia'),
    // Aliquota dell'imposta provinciale sull'r.c.: e' la sola leva locale sul premio.
    aliquotaRc: p.aliquotaRc,
    aliquotaMotivo: p.aliquotaRc != null ? null
      : (assente('aliquota') && assente('aliquota').sigle.includes(sg) ? assente('aliquota').perche : 'nessuna delibera pubblicata'),
    periodo: D.periodo,
    fonti: D.fonti,
    nota: D.nota,
  };
}

/** Posizione della provincia nella classifica nazionale del premio mediano: 1 = la piu' economica. */
function posizione(sigla, tipo) {
  const t = TIPI.has(tipo) ? tipo : 'auto';
  const scala = Object.entries(D.province)
    .filter(([, p]) => p[t] && p[t].mediana != null)
    .sort((a, b) => a[1][t].mediana - b[1][t].mediana)
    .map(([s]) => s);
  const i = scala.indexOf(String(sigla || '').toUpperCase().trim());
  return i < 0 ? null : { posto: i + 1, su: scala.length };
}

module.exports = { cerca, posizione, dati: D };
