'use strict';
// F50 quick-fix qualità — normalizzazione campi per analisi di mercato pulita.

// carburante grezzo (25+ etichette per-fonte) → set canonico.
const CARB = new Map();
const add = (canon, ...raws) => raws.forEach(r => CARB.set(r, canon));
add('Benzina', 'benzina', 'benzina 91', 'super 95', 'super e10 95', 'benzina e10 91', 'benzina 2t', 'super plus 98', 'super plus e10 98');
add('Diesel', 'diesel', 'biodiesel');
add('GPL', 'gpl', 'gas di petrolio liquefatto');
add('Metano', 'metano', 'gas naturale h');
add('Elettrica', 'elettrica', 'motore elettrico');
add('Ibrida', 'ibrida', 'elettrica/benzina', 'elettrica/diesel', 'mild hybrid benzina',
  'mild hybrid diesel', 'full hybrid benzina', 'full hybrid diesel', 'phev - ibrido plug-in benzina',
  'phev - ibrido plug-in diesel');

function normCarburante(v) {
  if (v == null || v === '') return null;
  return CARB.get(String(v).trim().toLowerCase()) || 'Altro';
}

// outlier numerici (mis-parse alla fonte) → null se fuori range plausibile.
function clampCv(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 1 && n <= 1500 ? n : null; }
function clampCc(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 50 && n <= 9000 ? n : null; }

module.exports = { normCarburante, clampCv, clampCc };
