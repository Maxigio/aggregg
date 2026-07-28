#!/usr/bin/env node
'use strict';
/**
 * CONTROLLA data/ponte-buchi.json — gli agganci Autoscout→Subito che il ponte non
 * copriva, e che ora lo coprono.
 *
 * IL FILE NON SI GENERA DA SOLO, ed e' voluto. Ogni voce e' passata da un test che
 * confronta i TITOLI SCRITTI DAI VENDITORI sulle due fonti, nelle due direzioni, con
 * controlli negativi che devono fallire. Un generatore automatico rifarebbe gli
 * agganci per somiglianza di nome — ed e' esattamente cio' che il test ha bocciato:
 *
 *   Citroen "E-C3"    → C3     Subito  1%    l'elettrica non e' la termica
 *   BMW "Z3 M"        → Z3     Subito  7%    321 CV contro 140
 *   Fiat "500 Abarth" → 500    Subito  0%    160 CV contro 69
 *
 * Sembrano giusti e non lo sono. Per questo si aggiunge a mano, uno alla volta, con la
 * prova allegata: un aggancio sbagliato mette le auto di un altro modello sotto la
 * stessa voce, e non si vede.
 *
 * Questo script verifica che il file sia COERENTE col catalogo — marche, famiglie e
 * codici devono esistere davvero — e che nessuna voce sia senza prova. Va lanciato
 * dopo ogni modifica a mano.
 *
 * Uso:  node scripts/verifica-ponte-buchi.js
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const P = JSON.parse(fs.readFileSync(path.join(R, 'data', 'ponte-buchi.json'), 'utf8'));
const S = JSON.parse(fs.readFileSync(path.join(R, 'data', 'subito-catalogo.json'), 'utf8'));
const A = JSON.parse(fs.readFileSync(path.join(R, 'data', 'models.json'), 'utf8'));
const AS = JSON.parse(fs.readFileSync(path.join(R, 'data', 'as24-modelli.json'), 'utf8'));

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
// come si cerca su Subito, non quanto e' bello l'aggancio:
//   famiglia+testo  il modello Autoscout sta DENTRO la famiglia Subito ("Golf GTI" in
//                   "Golf"): serve il testo alla fonte + il filtro sulla versione.
//   famiglia        la famiglia Subito E' gia' il veicolo ("Scarabeo"): solo gli id,
//                   perche' li' la versione e' l'allestimento e filtrarci ammazza tutto.
const GRADI = new Set(['famiglia', 'famiglia+testo']);
const errori = [];

// gia' coperti dal ponte: una voce qui sarebbe un doppione, non un buco
const nelPonte = new Set();
for (const t of ['auto', 'moto']) for (const fam of Object.values(AS[t] || {}))
  for (const cs of Object.values(fam)) for (const c of cs)
    nelPonte.add(t + '|' + String(c).split('|').slice(0, 2).join('|'));

for (const v of P.voci) {
  const dove = `${v.tipo} ${v.marca} "${v.modelloAs24}"`;

  if (!GRADI.has(v.grado)) errori.push(`${dove}: grado sconosciuto "${v.grado}"`);
  if (!v.prova || !v.prova.titoliSubito) errori.push(`${dove}: manca la prova — nessuna voce entra senza`);
  if (!(v.annunciAs24 > 0)) errori.push(`${dove}: annunci Autoscout mancanti o zero`);

  // il modello Autoscout esiste col suo codice?
  const b = Object.entries(A[v.tipo] || {}).find(([k]) => norm(k) === norm(v.marca));
  const m = b && (b[1].models || []).find(x => x.mmmvAutoscout === v.mmmv);
  if (!m) errori.push(`${dove}: nessun modello Autoscout col codice ${v.mmmv}`);
  else if (norm(m.nome) !== norm(v.modelloAs24)) errori.push(`${dove}: il codice ${v.mmmv} e' di "${m.nome}", non di "${v.modelloAs24}"`);

  // non deve essere gia' nel ponte
  if (nelPonte.has(v.tipo + '|' + String(v.mmmv).split('|').slice(0, 2).join('|'))) {
    errori.push(`${dove}: gia' agganciato dal ponte — questo non e' un buco`);
  }

  // marca e famiglie Subito esistono?
  const marca = Object.values(S[v.tipo] || {}).find(x => x.id === v.subito.marcaId);
  if (!marca) { errori.push(`${dove}: marca Subito ${v.subito.marcaId} inesistente`); continue; }
  if (norm(marca.nome) !== norm(v.marca)) errori.push(`${dove}: la marca Subito ${v.subito.marcaId} e' "${marca.nome}"`);
  const famiglie = new Map();
  for (const [id, mm] of Object.entries(marca.modelli || {})) {
    const fid = mm.famigliaId || id;
    if (!famiglie.has(fid)) famiglie.set(fid, mm.famiglia || mm.nome);
  }
  for (const fid of String(v.subito.famigliaId).split(',')) {
    if (!famiglie.has(fid)) errori.push(`${dove}: famiglia Subito ${fid} inesistente sotto ${marca.nome}`);
  }
  // il token, quando c'e', deve pescare qualcosa
  if (v.subito.versioniCheDicono) {
    const re = new RegExp('(?:^| )' + String(v.subito.versioniCheDicono).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])');
    let quante = 0;
    for (const [id, mm] of Object.entries(marca.modelli || {})) {
      if (!String(v.subito.famigliaId).split(',').includes(mm.famigliaId || id)) continue;
      for (const nome of Object.values(mm.versioni || {})) {
        const t = String(nome).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ');
        if (re.test(t)) quante++;
      }
    }
    if (quante < 5) errori.push(`${dove}: il token "${v.subito.versioniCheDicono}" pesca solo ${quante} versioni`);
  }
}

const perGrado = {};
for (const v of P.voci) perGrado[v.grado] = (perGrado[v.grado] || 0) + 1;
console.log(`agganci ${P.voci.length} · auto ${P.conta.auto} · moto ${P.conta.moto} · annunci Autoscout coperti ${P.conta.annunci}`);
console.log('per grado: ' + Object.entries(perGrado).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(' · '));
if (errori.length) {
  console.error('\nINCOERENZE (' + errori.length + '):');
  for (const e of errori.slice(0, 15)) console.error('  ' + e);
  process.exit(1);
}
console.log('coerente: marche, famiglie e codici esistono, nessun doppione col ponte, ogni voce ha la sua prova.');
