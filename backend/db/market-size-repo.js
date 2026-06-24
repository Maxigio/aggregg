'use strict';
/**
 * F50 copertura — append della dimensione di mercato per (target, fonte).
 *
 * record(target, fonte, total): una riga timeseries se `total` è un intero.
 * Best-effort: try/catch + no-op se DB giù o total null → NON deve mai rompere la sweep.
 */
const db = require('./index');

async function record(target, fonte, total) {
  if (!db.isEnabled() || !target || !fonte) return;
  if (!Number.isInteger(total)) return;   // null/assente → niente riga (no rumore)
  try {
    await db.query(
      `INSERT INTO market_size (tipo, marca, modello, fonte, total) VALUES ($1,$2,$3,$4,$5)`,
      [target.tipo || null, target.marca || null, target.modello || null, fonte, total]
    );
  } catch (e) {
    console.error('[market-size] record fallita:', e.message);   // mai propagare
  }
}

module.exports = { record };
