'use strict';
/**
 * F6 — Rilevamento doppioni watch-list (ADVISORY). Coppie STESSO tipo+brand dove
 * un modello si sovrappone all'altro → gonfiano il ri-crawl (richieste extra +
 * stesso url upsertato da 2 target). Euristica PARZIALE (non esaustiva): mai
 * auto-elimina, solo segnala. Pura/testabile, niente DB.
 */
let modelGroups = { auto: {}, moto: {} };
try { modelGroups = require('../data/model-groups.json'); } catch (_) { /* opzionale */ }

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Membri di una serie commerciale (es. BMW "Serie 3" → ["316","320",…]) o null.
function lookupModelGroup(tipo, brandName, modelText) {
  const brands = modelGroups[tipo];
  if (!brands || !brandName) return null;
  const g = brands[brandName];
  if (!g) return null;
  const q = norm(modelText);
  if (!q) return null;
  for (const [serie, membri] of Object.entries(g)) if (norm(serie) === q) return membri;
  return null;
}

// Ritorna coppie {a:{id,marca,modello}, b:{…}, reason:'substring'|'serie'}.
function findOverlaps(targets) {
  const pairs = [];
  const list = Array.isArray(targets) ? targets : [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.tipo !== b.tipo || norm(a.marca) !== norm(b.marca)) continue;
      const na = norm(a.modello), nb = norm(b.modello);
      if (!na || !nb || na === nb) continue;
      let reason = null;
      if (na.includes(nb) || nb.includes(na)) reason = 'substring';
      if (!reason) {
        // serie ⊇ membro: membri nudi ("320"), il target può avere il suffisso
        // motore ("320d") → match per PREFISSO (membro ≥3 char, prefisso del target).
        const memberHits = (group, target) => group && group.some(m => { const nm = norm(m); return nm.length >= 3 && target.startsWith(nm); });
        if (memberHits(lookupModelGroup(a.tipo, a.marca, a.modello), nb)) reason = 'serie';
        else if (memberHits(lookupModelGroup(b.tipo, b.marca, b.modello), na)) reason = 'serie';
      }
      if (reason) pairs.push({
        a: { id: a.id, marca: a.marca, modello: a.modello },
        b: { id: b.id, marca: b.marca, modello: b.modello }, reason,
      });
    }
  }
  return pairs;
}

module.exports = { findOverlaps, _norm: norm, _lookupModelGroup: lookupModelGroup };
