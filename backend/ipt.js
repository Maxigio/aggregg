'use strict';
/**
 * IPT — Imposta Provinciale di Trascrizione: quanto costa passare un veicolo, per provincia.
 *
 * Serve a un OPERATORE, non a un privato: la stessa auto costa centinaia di euro in più o in
 * meno secondo la provincia, e le regole che spostano davvero i soldi sono quelle
 * professionali (passaggi consecutivi, atti con IVA, veicoli speciali).
 *
 * Dati in data/ipt-province.json, rigenerabili con scripts/build-ipt-province.js dalle
 * pagine ACI. Tutto ciò che è qui è stato VERIFICATO sulla fonte; ciò che non lo è viene
 * dichiarato come non calcolabile invece di essere stimato:
 *  - imposta di bollo: ACI la dichiara "importo variabile" → non è nel totale;
 *  - motocicli: l'esenzione IPT non è stata trovata sulle pagine ACI lette → non si calcola;
 *  - veicoli storici: riduzione prevista (art. 63 L. 342/00) ma importo non verificato.
 * Meglio dire "non lo so" che mettere in bocca al programma un numero inventato su una spesa vera.
 */
const T = require('../data/ipt-province.json');

const arrotonda = n => Math.round(n * 100) / 100;

/**
 * @param {object} p
 * @param {string} p.provincia   sigla (es. "MI")
 * @param {number} p.kW          potenza del veicolo
 * @param {string} [p.tipo]      'auto' | 'autobus' | 'moto'
 * @param {boolean} [p.ivaEsposta]  atto soggetto a IVA (vendita con fattura) — conta a Torino
 * @param {boolean} [p.speciale]    specialità sulla carta di circolazione → un quarto
 * @param {boolean} [p.consecutiva] passaggio consecutivo nello stesso giorno, non l'ultimo
 */
function calcola(p) {
  const pv = String((p && p.provincia) || '').toUpperCase();
  const kW = Number((p && p.kW) || 0);
  const tipo = (p && p.tipo) || 'auto';
  const avvisi = [];
  const fonte = { maggiorazioni: T.fonti.maggiorazioni, tariffe: T.fonti.tariffe, aggiornato: T.generatedAt };

  if (!(pv in T.maggiorazioni)) return { ok: false, motivo: 'provincia sconosciuta', fonte };
  if (tipo === 'moto') {
    return { ok: false, motivo: 'IPT moto non calcolabile: esenzione non verificata su fonte ACI', fonte,
      avvisi: ['Per i motocicli l\'esenzione IPT è prevista da norma statale ma non l\'abbiamo verificata sulle pagine ACI: non mostriamo un importo.'] };
  }
  if (!isFinite(kW) || kW <= 0) return { ok: false, motivo: 'potenza in kW mancante', fonte };

  // ── tariffa base (tabella allegata al D.M. 435/1998) ──
  const base = tipo === 'autobus'
    ? (kW <= 110 ? T.tariffe.autobusFino110Kw : kW * T.tariffe.autobusOltre110PerKw)
    : (kW <= 53 ? T.tariffe.autoFino53Kw : kW * T.tariffe.autoOltre53PerKw);

  // ── maggiorazione provinciale, con l'eccezione di Torino (IVA sì/no) ──
  let pct = T.maggiorazioni[pv];
  const ecc = T.eccezioni[pv];
  if (ecc && ecc.ivaEsposta != null && ecc.senzaIva != null) {
    pct = p.ivaEsposta ? ecc.ivaEsposta : ecc.senzaIva;
    avvisi.push(ecc.nota);
  } else if (ecc && ecc.nota) {
    avvisi.push(ecc.nota + ' — se il veicolo ricade in quei casi, l\'importo è inferiore.');
  }

  let ipt = base * (1 + pct / 100);
  const passaggi = [`tariffa base ${arrotonda(base)} € (${tipo === 'autobus' ? 'autobus/trattore' : 'autoveicolo'} ${kW} kW)`,
    `maggiorazione ${pv} ${pct}% → ${arrotonda(ipt)} €`];

  if (p.speciale) { ipt = ipt / 4; passaggi.push(`veicolo speciale: un quarto → ${arrotonda(ipt)} €`); avvisi.push(T.regole.speciali); }
  if (p.consecutiva) { ipt = 0; passaggi.push('passaggio consecutivo non finale: IPT non dovuta'); avvisi.push(T.regole.consecutivi); }

  const emolumenti = T.emolumentiAci;
  return {
    ok: true, provincia: pv, kW, tipo, maggiorazione: pct,
    ipt: arrotonda(ipt), emolumenti, totaleNoto: arrotonda(ipt + emolumenti),
    nonIncluso: T.nonIncluso, dettaglio: passaggi, avvisi, fonte,
  };
}

// Confronto rapido tra province: quanto cambia la stessa pratica sul territorio.
function confronta(kW, sigle, opt) {
  return (sigle && sigle.length ? sigle : Object.keys(T.maggiorazioni))
    .map(pv => calcola({ ...(opt || {}), provincia: pv, kW }))
    .filter(r => r.ok)
    .sort((a, b) => a.totaleNoto - b.totaleNoto);
}

module.exports = { calcola, confronta, tabella: T };
