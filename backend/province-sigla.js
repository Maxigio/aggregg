'use strict';
/**
 * Da una localita' scritta come capita alla SIGLA della provincia.
 *
 * Le tre fonti dell'usato non si mettono d'accordo: Moto.it manda la sigla ("BS"), Subito il
 * nome della provincia ("Genova"), AutoScout il COMUNE ("Gussago"). backend/ipt.js pero'
 * lavora solo per sigla, quindi senza questa traduzione il passaggio di proprieta' non si puo'
 * calcolare a partire da un annuncio.
 *
 * Si prova in ordine di affidabilita' e si dichiara sempre da dove viene la risposta: un
 * comune omonimo di un'altra provincia darebbe un importo sbagliato senza che nessuno se ne
 * accorga, quindi i comuni ambigui sono stati scartati a monte (scripts/build-comune-sigla.js)
 * e qui si torna null invece di tirare a indovinare.
 */
const T = require('../data/comune-sigla.json');
const PROVINCE = require('../data/province.json');

const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * @param {string} testo  "BS" | "Genova" | "Gussago" | "Brescia (BS)" | "Gussago - Brescia - BS"
 * @param {string} [cap]  CAP, se la fonte lo manda (AutoScout lo fa)
 * @returns {{sigla:string, via:string}|null}  via = 'sigla'|'parentesi'|'coda'|'provincia'|'cap'|'comune'|'cap+comune'
 *
 * Torna null anche quando due indizi si CONTRADDICONO (il CAP dice una provincia e il nome del
 * comune un'altra): in quel caso il dato di partenza e' sbagliato, e scegliere il piu' comodo
 * significherebbe firmare un importo su una provincia inventata.
 */
function risolvi(testo, cap) {
  const raw = String(testo == null ? '' : testo).trim();
  const z = String(cap == null ? '' : cap).trim();
  const daCap = (/^\d{5}$/.test(z) && T.cap[z]) || null;
  const conferma = sig => (daCap && daCap !== sig ? null : sig);   // il CAP smentisce? non si indovina

  // 1) e' gia' una sigla
  if (/^[A-Za-z]{2}$/.test(raw) && PROVINCE[raw.toUpperCase()]) {
    const sig = conferma(raw.toUpperCase());
    return sig ? { sigla: sig, via: 'sigla' } : null;
  }

  // 2) "Brescia (BS)" — la sigla tra parentesi vince sul resto
  const par = raw.match(/\(\s*([A-Za-z]{2})\s*\)/);
  if (par && PROVINCE[par[1].toUpperCase()]) {
    const sig = conferma(par[1].toUpperCase());
    return sig ? { sigla: sig, via: 'parentesi' } : null;
  }

  // 3) "Gussago - Brescia - BS": AutoScout puo' mandare la forma composta, la coda e' la sigla
  const pezzi = raw.split(/\s+-\s+/).map(x => x.trim()).filter(Boolean);
  if (pezzi.length > 1) {
    const ultimo = pezzi[pezzi.length - 1];
    if (/^[A-Za-z]{2}$/.test(ultimo) && PROVINCE[ultimo.toUpperCase()]) {
      const sig = conferma(ultimo.toUpperCase());
      return sig ? { sigla: sig, via: 'coda' } : null;
    }
  }

  const parti = pezzi.length ? pezzi : [raw];

  // 4) nome di provincia
  for (const p of parti) {
    const sig = T.nomi[norm(p)];
    if (sig) return conferma(sig) ? { sigla: sig, via: 'provincia' } : null;
  }

  // 5) nome di comune, incrociato col CAP: se concordano si dice; se litigano si tace.
  //    Il nome del comune e' l'indizio piu' forte (il CAP di un annuncio puo' essere quello
  //    della sede del venditore), quindi non lo si scavalca: lo si verifica.
  for (const p of parti) {
    const sig = T.comuni[norm(p)];
    if (!sig) continue;
    if (daCap && daCap !== sig) return null;
    return { sigla: sig, via: daCap ? 'cap+comune' : 'comune' };
  }

  // 6) resta il solo CAP: e' l'ultima spiaggia, non la prima scelta.
  if (daCap) return { sigla: daCap, via: 'cap' };
  return null;
}

// 1 CV = 735,49875 W. La conversione resta una STIMA: l'IPT si calcola sui kW del libretto,
// che sono un valore dichiarato e arrotondato, non il risultato di questa moltiplicazione.
const CV_IN_KW = 0.73549875;
const kwDaCv = cv => (Number(cv) > 0 ? Number(cv) * CV_IN_KW : null);

module.exports = { risolvi, kwDaCv, CV_IN_KW, tabella: T };
