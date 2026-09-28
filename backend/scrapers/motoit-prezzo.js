'use strict';

// Le card italiane usano il punto per le migliaia e la virgola per i centesimi.
// Non si estraggono cifre da rate o da testo non riconosciuto.
function prezzoMoto(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const suRichiesta = /^(?:t\.?\s*riservata|trattativa riservata|(?:prezzo )?su richiesta)$/i.test(s);
  const cifra = s.replace(/^(?:€|EURO?)\s*/i, '').replace(/\s*(?:€|EURO?)$/i, '');
  const valido = /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(cifra);
  const n = valido ? Number(cifra.replace(/\./g, '').replace(',', '.')) : NaN;
  const prezzo = Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
  return { prezzo, prezzoSuRichiesta: suRichiesta || null,
    prezzoIlleggibile: !!s && !suRichiesta && prezzo === null };
}

function avvisoPrezzi(items) {
  const illeggibili = items.filter(r => r.prezzoIlleggibile).length;
  if (illeggibili) return `${illeggibili} annunci Moto.it hanno un prezzo non leggibile; gli annunci restano consultabili`;
  if (items.length >= 3 && items.every(r => r.prezzo == null && !r.prezzoSuRichiesta)) {
    return `Moto.it: prezzo assente in tutti i ${items.length} annunci; gli annunci restano consultabili`;
  }
  return null;
}

module.exports = { prezzoMoto, avvisoPrezzi };
