#!/usr/bin/env node
'use strict';
/**
 * COSTRUISCE data/subito-indice.json — gli id che servono per cercare su Subito.
 *
 * PERCHE' UN FILE A PARTE. data/subito-catalogo.json pesa 7,8 MB perche' contiene
 * 128.917 versioni. Per interrogare la ricerca servono solo marca / famiglia /
 * generazione: 0,34 MB, ventitre' volte meno. Il server lo tiene in memoria senza
 * pagare il resto, e le versioni si leggono altrove quando servono davvero.
 *
 * IL CATALOGO NON SI TOCCA. Questo file e' derivato: si rifa' da zero quando serve,
 * e se sparisce non si perde niente.
 *
 * I DUE LIVELLI, che non sono gli stessi per auto e moto (misurato, non dedotto):
 *   AUTO  marca → FAMIGLIA (param cm)  → generazioni ("Passat 5ª serie")
 *         la famiglia e' cio' che l'utente chiama "modello": Passat, Giulia, Serie 3.
 *   MOTO  marca → MODELLO  (param bm)  → nessun livello sotto: su Subito le moto
 *         non hanno famiglie (misurato: 0 famiglie con piu' di una serie).
 *
 * Uso:  node scripts/build-subito-indice.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const SRC = path.join(R, 'data', 'subito-catalogo.json');
const OUT = path.join(R, 'data', 'subito-indice.json');
const dry = process.argv.includes('--dry');

const S = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const fuori = { generatoIl: new Date().toISOString(), fonte: 'data/subito-catalogo.json', conta: {}, auto: {}, moto: {} };

for (const tipo of ['auto', 'moto']) {
  let marche = 0, famiglie = 0, generazioni = 0;
  for (const b of Object.values(S[tipo] || {})) {
    if (!b || !b.id || !b.nome) continue;
    const fam = new Map();
    for (const [id, m] of Object.entries(b.modelli || {})) {
      // auto: la famiglia dichiarata dal catalogo; moto: il modello E' il livello.
      const fid = tipo === 'auto' ? (m.famigliaId || id) : id;
      const fnome = tipo === 'auto' ? (m.famiglia || m.nome) : m.nome;
      if (!fam.has(fid)) fam.set(fid, { nome: fnome, gen: [] });
      fam.get(fid).gen.push({ id, nome: m.nome });
    }
    if (!fam.size) continue;
    marche++; famiglie += fam.size;
    fuori[tipo][b.nome] = {
      id: b.id,
      famiglie: [...fam].map(([id, x]) => { generazioni += x.gen.length; return { id, nome: x.nome, gen: x.gen }; }),
    };
  }
  fuori.conta[tipo] = { marche, famiglie, generazioni };
}

// ── GUARDIE: se l'indice non rispecchia il catalogo, meglio non scriverlo ──────
const errori = [];
for (const tipo of ['auto', 'moto']) {
  const marcheCat = Object.values(S[tipo] || {}).filter(b => b && b.id && Object.keys(b.modelli || {}).length).length;
  if (fuori.conta[tipo].marche !== marcheCat) errori.push(`${tipo}: ${fuori.conta[tipo].marche} marche nell'indice contro ${marcheCat} nel catalogo`);
  let modCat = 0;
  for (const b of Object.values(S[tipo] || {})) modCat += Object.keys(b.modelli || {}).length;
  if (fuori.conta[tipo].generazioni !== modCat) errori.push(`${tipo}: ${fuori.conta[tipo].generazioni} generazioni nell'indice contro ${modCat} modelli nel catalogo`);
  // moto: una famiglia per modello, sempre (se non e' cosi', l'assunto e' cambiato)
  if (tipo === 'moto' && fuori.conta.moto.famiglie !== fuori.conta.moto.generazioni) {
    errori.push(`moto: ${fuori.conta.moto.famiglie} famiglie contro ${fuori.conta.moto.generazioni} generazioni — le moto NON dovrebbero avere livelli intermedi`);
  }
}
if (errori.length) {
  console.error('INDICE NON SCRITTO — il conto non torna:');
  for (const e of errori) console.error('  ' + e);
  process.exit(1);
}

const testo = JSON.stringify(fuori);
console.log(`auto  marche ${fuori.conta.auto.marche} · famiglie ${fuori.conta.auto.famiglie} · generazioni ${fuori.conta.auto.generazioni}`);
console.log(`moto  marche ${fuori.conta.moto.marche} · modelli ${fuori.conta.moto.famiglie}`);
console.log(`peso  ${(testo.length / 1024 / 1024).toFixed(2)} MB (catalogo: ${(fs.statSync(SRC).size / 1024 / 1024).toFixed(1)} MB)`);
if (dry) { console.log('--dry: non scritto'); process.exit(0); }
fs.writeFileSync(OUT, testo);
console.log('scritto ' + path.relative(R, OUT));
