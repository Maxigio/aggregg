'use strict';
/**
 * LA LISTA VERSIONI, una sola per tutte e tre le fonti.
 *
 * E' il motivo per cui i cataloghi sono stati scaricati e uniti: chi cerca scrive
 * "abs" e vede una voce, non due con due nomi diversi. Il file lo prepara
 * scripts/build-versioni-unificate.js; qui si legge e si serve.
 *
 * UN FILE PER MARCA, letto quando serve. Tutte le versioni insieme sono 12 MB, che
 * diventano 86 MB in memoria — troppo per una tendina. Per marca: mediana 1 KB, il
 * piu' grande 847 KB (Mercedes). Se ne tengono in memoria pochi, i piu' recenti.
 *
 * LA GENERAZIONE E' IL CONTENITORE, non un filtro a parte: su Subito le versioni
 * stanno SOTTO una generazione ("Serie 3 (E46)" → "316i cat 4 porte Attiva"). Qui si
 * restituisce quella struttura invece di appiattirla, cosi' chi mostra la lista puo'
 * dire da dove viene ogni voce senza doverlo indovinare.
 *
 * ATTENZIONE agli id-modello di Subito: NON sono unici fra auto e moto (1.368 in
 * comune). Il tipo fa parte del percorso del file, non e' un dettaglio.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'data', 'versioni');
const TIENI = 8;                  // quante marche restano in memoria
const cache = new Map();          // `${tipo}/${marcaId}` → dati (Map ordinata = LRU)

function perMarca(tipo, marcaId) {
  const t = tipo === 'moto' ? 'moto' : 'auto';
  const id = String(marcaId || '').trim();
  if (!id) return null;
  const k = t + '/' + id;
  if (cache.has(k)) { const v = cache.get(k); cache.delete(k); cache.set(k, v); return v; }   // LRU touch
  let dati = null;
  try { dati = JSON.parse(fs.readFileSync(path.join(DIR, t, id + '.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.warn('[versioni] ' + k + ': ' + e.message); dati = null; }
  cache.set(k, dati);
  while (cache.size > TIENI) cache.delete(cache.keys().next().value);
  return dati;
}

/** Il nome da mostrare: quello di Subito se c'e', altrimenti quello di Moto.it. */
function nomeDi(v) {
  if (v.subito && v.subito.nome) return v.subito.nome;
  if (v.motoit && v.motoit[0]) return v.motoit[0].nome;
  return '';
}

/**
 * Le versioni di un modello, raggruppate per generazione.
 *
 * @param {string} tipo        'auto' | 'moto'
 * @param {string} marcaId     id marca Subito
 * @param {Array}  generazioni [{id, nome}] — i modelli-generazione della famiglia
 * @returns {Array} [{ id, nome, versioni: [{id, nome, fonti, anni, subito, motoit}] }]
 */
function versioniDi(tipo, marcaId, generazioni) {
  const dati = perMarca(tipo, marcaId);
  if (!dati) return [];
  const out = [];
  for (const g of (generazioni || [])) {
    const l = dati[String(g.id)];
    if (!l || !l.length) continue;
    out.push({
      id: g.id,
      nome: g.nome,
      versioni: l.map(v => ({
        id: v.id,
        nome: nomeDi(v),
        // Da dove viene la voce: serve a chi legge per sapere quanto e' coperta.
        // Una versione che sta su entrambe le fonti si filtra su entrambe.
        fonti: [v.subito ? 'subito' : null, v.motoit ? 'motoit' : null].filter(Boolean),
        anni: v.anni || null,
        subito: v.subito ? v.subito.id : null,
        motoit: v.motoit ? v.motoit.map(x => x.id) : null,
        // Il nome COMPLETO di ogni fonte: e' quello che va confrontato col testo degli
        // annunci, non il nome mostrato. Autoscout dichiara la versione solo a parole.
        nomi: [v.subito ? v.subito.nome : null, ...(v.motoit || []).map(x => x.nome)].filter(Boolean),
        base: v.base || false,
      })),
    });
  }
  return out;
}

/** Quante versioni ha una famiglia, senza costruire la lista (per i conteggi). */
function quante(tipo, marcaId, generazioni) {
  const dati = perMarca(tipo, marcaId);
  if (!dati) return 0;
  let n = 0;
  for (const g of (generazioni || [])) n += (dati[String(g.id)] || []).length;
  return n;
}

module.exports = { versioniDi, quante, _perMarca: perMarca, _nomeDi: nomeDi };
