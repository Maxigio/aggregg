'use strict';
/**
 * Rigenera data/brand-aliases.json dall'UNIONE di:
 *   - i 14 gruppi gia' curati a mano nel file (che NON si perdono mai)
 *   - le relazioni `stessa` di data/ponte-marche.json
 *
 * UNIONE, mai sostituzione: un gruppo presente prima e assente dopo sarebbe una perdita
 * silenziosa di conoscenza curata a mano. Alla fine si CONTROLLA che ogni vecchio gruppo
 * sia ancora dentro uno nuovo, e se non lo e' si esce senza scrivere.
 *
 * `distribuisce` e `distinta` NON entrano: quel file sa dire solo "sono lo stesso".
 *
 * Raggruppamento TRANSITIVO: KL↔KL Motors e KL Motors↔Kl devono diventare un gruppo di tre.
 */
const fs = require('fs');
const R = '/Volumes/MAIN/BananaChePrezzi-main';
const norm = require(R + '/backend/scrapers/brand-match.js').norm;
const S = require(R + '/data/subito-catalogo.json');
const M = require(R + '/data/motoit-catalogo.json');
const A = require(R + '/data/models.json');
const VECCHIO = require(R + '/data/brand-aliases.json');
const P = require(R + '/data/ponte-marche.json');

// quanti modelli ha un nome, per scegliere il canonico (il piu' ricco)
const peso = { auto: new Map(), moto: new Map() };
for (const b of Object.values(S.auto)) peso.auto.set(norm(b.nome), Object.keys(b.modelli || {}).length);
for (const b of Object.values(S.moto)) peso.moto.set(norm(b.nome), Object.keys(b.modelli || {}).length);
for (const [n, b] of Object.entries(A.auto)) peso.auto.set(norm(n), Math.max(peso.auto.get(norm(n)) || 0, b.models.length));
for (const [n, b] of Object.entries(A.moto)) peso.moto.set(norm(n), Math.max(peso.moto.get(norm(n)) || 0, b.models.length));
for (const b of Object.values(M.marche)) peso.moto.set(norm(b.nome), Math.max(peso.moto.get(norm(b.nome)) || 0, Object.keys(b.modelli || {}).length));

// ── union-find sui nomi normalizzati ────────────────────────────────────────
function unisci(coppie) {
  const padre = new Map();
  const trova = x => { while (padre.get(x) !== x) { padre.set(x, padre.get(padre.get(x))); x = padre.get(x); } return x; };
  const agg = x => { if (!padre.has(x)) padre.set(x, x); };
  for (const [a, b] of coppie) { agg(a); agg(b); const ra = trova(a), rb = trova(b); if (ra !== rb) padre.set(ra, rb); }
  const gruppi = new Map();
  for (const x of padre.keys()) { const r = trova(x); if (!gruppi.has(r)) gruppi.set(r, []); gruppi.get(r).push(x); }
  return [...gruppi.values()];
}

const fuori = { _note: VECCHIO._note };
const controlli = [];
for (const tipo of ['auto', 'moto']) {
  const coppie = [], nomeVero = new Map();          // norm → grafia da mostrare
  const ricorda = s => { const k = norm(s); if (!nomeVero.has(k)) nomeVero.set(k, s); return k; };
  // 1) i gruppi gia' curati a mano
  for (const g of (VECCHIO[tipo] || [])) {
    const k = g.map(ricorda);
    for (let i = 1; i < k.length; i++) coppie.push([k[0], k[i]]);
  }
  // 2) le `stessa` del ponte
  for (const x of P.voci[tipo]) {
    if (x.relazione !== 'stessa') continue;
    coppie.push([ricorda(x.a.nome), ricorda(x.b.nome)]);
  }
  const gruppi = unisci(coppie).map(g => {
    // canonico = il nome col maggior numero di modelli
    const ord = g.map(k => ({ k, n: peso[tipo].get(k) || 0 })).sort((a, b) => b.n - a.n);
    return ord.map(x => nomeVero.get(x.k));
  }).sort((a, b) => a[0].localeCompare(b[0]));
  fuori[tipo] = gruppi;

  // ── CONTROLLO: ogni vecchio gruppo dev'essere dentro uno nuovo ────────────
  for (const g of (VECCHIO[tipo] || [])) {
    const k = g.map(norm);
    const dentro = gruppi.some(ng => { const s = new Set(ng.map(norm)); return k.every(x => s.has(x)); });
    if (!dentro) controlli.push(tipo + ': PERSO il gruppo ' + JSON.stringify(g));
  }
}

if (controlli.length) {
  console.error('CONTROLLO FALLITO — non scrivo niente:');
  controlli.forEach(x => console.error('  ' + x));
  process.exit(1);
}

for (const tipo of ['auto', 'moto'])
  console.log(tipo + ': ' + (VECCHIO[tipo] || []).length + ' gruppi → ' + fuori[tipo].length);
console.log('\nnuovi gruppi (piu di 2 nomi o assenti prima):');
for (const tipo of ['auto', 'moto']) for (const g of fuori[tipo]) {
  const era = (VECCHIO[tipo] || []).some(v => new Set(v.map(norm)).has(norm(g[0])));
  if (!era || g.length > 2) console.log('  ' + tipo + '  ' + JSON.stringify(g));
}

const F = R + '/data/brand-aliases.json';
fs.copyFileSync(F, F + '.prima-del-ponte');
fs.writeFileSync(F, JSON.stringify(fuori, null, 2) + '\n');
console.log('\nbackup: ' + F + '.prima-del-ponte');
console.log('scritto ' + F);
