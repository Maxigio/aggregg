/**
 * Matcher di marca/modello condiviso (DRY) — riusato da: lookup catalogo,
 * resolver Moto.it, resolver AS24, risoluzione slug-modello on-demand.
 *
 * BRAND (makeResolver): alias-curati → esatto-normalizzato. NIENTE contenimento
 * (generava falsi match cross-brand: Mars→Marshal, Arc→Arctic Cat). I cross-name
 * veri (Beta=Betamotor) stanno in data/brand-aliases.json, non si "indovinano".
 *
 * MODELLO (makeModelResolver): esatto-normalizzato → prefix bidirezionale.
 * Entro UN solo brand il rischio di falso positivo è basso, e serve un minimo
 * di tolleranza (es. "alp 4.0" ↔ slug "alp-4-0").
 */
const path = require('path');

const norm = s => String(s).toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '');

// ─── Alias brand curati (gruppi di nomi = stesso brand reale) ────────────────
// Ritorna map: norm(qualsiasi-nome-del-gruppo) → nome canonico (primo del gruppo).
function loadAliasMap(tipo) {
  let groups = [];
  try {
    const data = require(path.join(__dirname, '..', '..', 'data', 'brand-aliases.json'));
    groups = (data[tipo] || []).concat(data.all || []);
  } catch (_) {}
  const map = {};
  for (const g of groups) {
    if (!Array.isArray(g) || !g.length) continue;
    const canonical = g[0];
    for (const name of g) map[norm(name)] = canonical;
  }
  return map;
}

/**
 * Resolver BRAND: alias → esatto. candidates: [{name, value}].
 * @param {Object} [opts.alias]  map norm(variante) → nome canonico
 */
function makeResolver(candidates, opts = {}) {
  const alias = opts.alias || {};
  const items = candidates.map(c => ({ n: norm(c.name), value: c.value })).filter(c => c.n);
  const exact = new Map(items.map(c => [c.n, c.value]));
  return function resolve(query) {
    const q = norm(query);
    if (!q) return null;
    if (alias[q]) {
      const ck = norm(alias[q]);
      if (exact.has(ck)) return exact.get(ck);
    }
    return exact.has(q) ? exact.get(q) : null;
  };
}

/**
 * Resolver MODELLO: esatto → prefix bidirezionale (min 3 char). candidates: [{name, value}].
 */
function makeModelResolver(candidates) {
  const items = candidates.map(c => ({ n: norm(c.name), value: c.value })).filter(c => c.n);
  const exact = new Map(items.map(c => [c.n, c.value]));
  return function resolve(query) {
    const q = norm(query);
    if (!q) return null;
    if (exact.has(q)) return exact.get(q);
    if (q.length >= 3) {
      const cont = items.filter(c => c.n.length >= 3 && (c.n.startsWith(q) || q.startsWith(c.n)));
      if (cont.length) {
        cont.sort((a, b) => Math.abs(a.n.length - q.length) - Math.abs(b.n.length - q.length));
        return cont[0].value;
      }
    }
    return null;
  };
}

module.exports = { norm, makeResolver, makeModelResolver, loadAliasMap };
