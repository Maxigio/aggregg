'use strict';
/**
 * Indice delle prove inSella → data/insella-index.json.
 *
 * PERCHE' UN INDICE SU DISCO. Le prove non stanno in una sitemap (quella di insella.it copre news
 * e accessori, non /prova/): l'unico modo di enumerarle e' scorrere le dieci categorie con la loro
 * paginazione, che sono una quarantina di richieste. Farlo a runtime significava lasciare l'utente
 * davanti a "Carico…" per oltre un minuto al primo click. Le altre due fonti-catalogo su disco
 * (auto-data.net e ultimatespecs) funzionano gia' cosi': l'indice si costruisce una volta, la rete
 * si tocca solo per la scheda della singola prova.
 *
 * L'indice porta marca+modello+anno gia' risolti, quindi la navigazione marca → prove e' immediata
 * e non dipende dalla rete.
 *
 * Uso:  node scripts/build-insella-index.js [--dry]
 */
const fs = require('fs');
const path = require('path');
const insella = require('../backend/scrapers/insella-prove');

const OUT = path.join(__dirname, '..', 'data', 'insella-index.json');

(async () => {
  const dry = process.argv.includes('--dry');
  console.log('[insella] scorro le ' + insella._CATEGORIE.length + ' categorie (una richiesta ogni 1,5 s)…');

  const prove = await insella.indice({ forza: true });
  console.log('[insella] prove trovate: ' + prove.length);

  const marche = await insella.marche({ forza: true });
  console.log('[insella] marche con almeno una prova: ' + marche.length);

  // Guardia della stessa famiglia di quella del generatore IPT: meglio non riscrivere che
  // riscrivere un indice monco. Misurato il 2026-07-26: 329 prove e 40 marche. Le soglie stanno
  // sotto con margine — una a 40 esatte sarebbe passata per un pelo e non avrebbe difeso niente.
  if (prove.length < 250) throw new Error(`solo ${prove.length} prove (attese ~330): le categorie o la paginazione sono cambiate, indice NON riscritto`);
  if (marche.length < 30) throw new Error(`solo ${marche.length} marche (attese ~40): la risoluzione marca→prova e' rotta, indice NON riscritto`);
  // La categoria "trial" e' nell'elenco del sito ma non ha prove: se un giorno ne sparissero
  // altre, il conteggio per categoria qui sotto lo mostra invece di nasconderlo.

  const perCategoria = {};
  for (const p of prove) perCategoria[p.categoria] = (perCategoria[p.categoria] || 0) + 1;
  console.log('[insella] per categoria: ' + Object.entries(perCategoria).map(([k, v]) => k + ' ' + v).join(', '));

  const out = {
    generatedAt: new Date().toISOString(),
    fonte: { nome: 'inSella — prove e rilevamenti della redazione', url: 'https://www.insella.it/prova/' },
    categorie: insella._CATEGORIE,
    marche,
    prove,
  };
  if (dry) { console.log('[insella] --dry: niente scritto'); return; }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log('[insella] scritto ' + OUT + ' (' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB)');
})().catch(e => { console.error('[insella] FATAL', e.message); process.exit(1); });
