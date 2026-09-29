'use strict';

/**
 * LE CORREZIONI DEGLI SLUG-MODELLO (data/motoit-slug-correzioni.json). Il menu porta
 * slug che Moto.it non conosce — 10 Kawasaki coi trattini che il listino non usa
 * (menu kx-250, Moto.it kx250) e la CMX 500 che li' si chiama cmx-500-rebel — e la
 * ricerca rispondeva 404 PER SEMPRE, il menu versioni un corpo nullo scambiato per
 * «modello senza versioni». Misurato in campagna E su tutti i 2.044 slug, verificato
 * dal vivo. La correzione si applica dove lo slug ENTRA (menu servito e parametri di
 * ricerca): i cataloghi in data/ non si toccano. File assente → nessuna correzione.
 */
let correzioni = null;
function correggiModelSlug(slug) {
  if (!slug) return slug;
  if (!correzioni) {
    correzioni = new Map();
    try {
      const j = require('../../data/motoit-slug-correzioni.json');
      for (const v of (j.voci || [])) if (v && v.da && v.a) correzioni.set(String(v.da), String(v.a));
    } catch (e) { console.warn('[motoit-models] correzioni slug non lette: ' + e.message); }
  }
  return correzioni.get(String(slug)) || slug;
}

module.exports = { correggiModelSlug };
