'use strict';
/**
 * LE MARCHE GEMELLE DEL MENU — due strade, la stessa lista.
 *
 * Il proprietario (2026-08-08): «posso scrivere sia Marca: Piaggio, Modello: Vespa 125,
 * sia Marca: Vespa, Modello: 125 — ma sotto Piaggio c'e' la Vespa 125 GTS e sotto Vespa
 * no». Misurato sull'intero menu: 13 coppie di marche si spartiscono gli stessi veicoli
 * (56 modelli Vespa offerti solo da Piaggio, 5 Scarabeo solo da Aprilia, 3 Alpine solo da
 * Renault…). Il difetto non e' nella RICERCA — il ponte degli ospiti la risolve — ma nel
 * MENU: la force-select non offriva la voce, quindi la ricerca giusta non si poteva
 * nemmeno chiedere.
 *
 * Le coppie stanno in data/menu-gemelli.json, curate a mano con la prova: la parentela
 * fra marche non si deduce dai nomi («Indiana» e' un modello Ducati, non la Indian;
 * «Megane» non e' una Mega). Questo modulo fa solo l'unione: al menu di `marca` aggiunge
 * i modelli di `da` che portano il prefisso (senza prefisso), e con `inversa` il
 * contrario (col prefisso davanti). Le voci aggiunte tengono i campi originali
 * (mmmvAutoscout, slugMotoIt): Autoscout interroga per id come prima, Subito passa dal
 * ponte degli ospiti o dalla famiglia nativa.
 *
 * Doppioni: chiave senza parentesi — «160 GS» e «Vespa 160 GS (VSB1)» sono la stessa
 * voce, e la tendina e' una force-select dove i doppioni sono gia' stati un difetto (94,
 * chiusi con `norm`). File assente o illeggibile → nessuna unione, menu come prima.
 */
const { norm } = require('./scrapers/brand-match');

let VOCI = null;
function voci() {
  if (VOCI) return VOCI;
  VOCI = { auto: [], moto: [] };
  try {
    const j = require('../data/menu-gemelli.json');
    for (const t of ['auto', 'moto']) VOCI[t] = ((j.voci || {})[t] || []).filter(v => v && v.marca && v.da && v.prefisso);
  } catch (e) { console.warn('[menu-gemelli] file non letto: ' + e.message); }
  return VOCI;
}

// La chiave dei doppioni: niente parentesi («(VSB1)» e' un codice, non un altro veicolo).
const chiave = s => norm(String(s).replace(/\([^)]*\)/g, ' '));
const scappa = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** I campi che il menu serve: gli stessi della rotta, cosi' le fonti funzionano uguali. */
const campi = (m, nome) => ({
  nome,
  sites: m.sites || [],
  mmmvAutoscout: m.mmmvAutoscout || '',
  kindAS: m.kindAS || '',
  slugMotoIt: m.slugMotoIt || '',
});

/**
 * I modelli da AGGIUNGERE al menu di `marca` per il tipo dato. `modelli` sono quelli gia'
 * in lista (per i doppioni), `modelsData` e' il catalogo del server (data/models.json).
 */
function unisciGemelli(tipo, marca, modelli, modelsData) {
  const t = tipo === 'moto' ? 'moto' : 'auto';
  const nm = norm(marca);
  const presenti = new Set(modelli.map(m => chiave(m.nome)));
  const aggiunte = [];
  const modellsDi = nome => {
    const marche = modelsData[t] || {};
    const k = marche[nome] ? nome : Object.keys(marche).find(x => norm(x) === norm(nome));
    return (k && marche[k].models) || [];
  };
  for (const v of voci()[t]) {
    // il prefisso va preteso su un confine («Alpine A310» si', «Alpina B3» mai)
    const re = new RegExp('^' + scappa(v.prefisso) + '[\\s-]+', 'i');
    // Il doppione ha DUE forme: il menu Scarabeo scrive «Scarabeo 125», Aprilia pure —
    // spogliato diventa «125», che con la chiave sola sembrava nuovo. Stessa voce, due
    // grafie: si confrontano entrambe, e chi entra le occupa entrambe.
    const doppione = nudo => presenti.has(chiave(nudo)) || presenti.has(chiave(v.prefisso + ' ' + nudo));
    const occupa = nudo => { presenti.add(chiave(nudo)); presenti.add(chiave(v.prefisso + ' ' + nudo)); };
    if (norm(v.marca) === nm) {
      // il menu della gemella «piccola» offre anche i modelli col prefisso, senza prefisso
      for (const m of modellsDi(v.da)) {
        if (!re.test(m.nome)) continue;
        const nudo = String(m.nome).replace(re, '').trim();
        if (!nudo || doppione(nudo)) continue;
        occupa(nudo);
        aggiunte.push(campi(m, nudo));
      }
    } else if (v.inversa && norm(v.da) === nm) {
      // e la «grande» offre anche i soli-della-piccola, col prefisso davanti
      for (const m of modellsDi(v.marca)) {
        const nudo = String(m.nome).replace(re, '').trim();
        if (!nudo || doppione(nudo)) continue;
        occupa(nudo);
        aggiunte.push(campi(m, re.test(m.nome) ? String(m.nome) : `${v.prefisso} ${m.nome}`));
      }
    }
  }
  return aggiunte;
}

/**
 * LE MARCHE CHE NON STANNO IN TENDINA (`"tendina": "nascondi"`). Decisione del
 * proprietario (2026-08-08) sul caso Vespa: «Solo Piaggio, Vespa sparisce» — la voce esce
 * dall'elenco marche, i suoi modelli vivono nella gemella (l'unione inversa li porta gia'
 * tutti), e chi digita il nome nascosto va accompagnato sulla gemella: per questo accanto
 * all'elenco dei nascosti c'e' quello dei SINONIMI da dare all'autocompletamento.
 * I link costruiti con la marca nascosta continuano a funzionare: la risoluzione (ponte degli
 * ospiti) non guarda la tendina.
 */
function marcheNascoste(tipo) {
  const t = tipo === 'moto' ? 'moto' : 'auto';
  return new Set(voci()[t].filter(v => v.tendina === 'nascondi').map(v => v.marca));
}

/** [{da, a}]: chi digita `da` in tendina deve trovare `a` («vespa» → Piaggio). */
function sinonimiTendina(tipo) {
  const t = tipo === 'moto' ? 'moto' : 'auto';
  return voci()[t].filter(v => v.tendina === 'nascondi').map(v => ({ da: v.marca, a: v.da }));
}

module.exports = { unisciGemelli, marcheNascoste, sinonimiTendina, _chiave: chiave };
