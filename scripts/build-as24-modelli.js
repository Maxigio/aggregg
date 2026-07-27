#!/usr/bin/env node
'use strict';
/**
 * COSTRUISCE data/as24-modelli.json — i codici-modello Autoscout per ogni nodo Subito.
 *
 * E' il ponte che finalmente parla agli scraper. `data/ponte-modelli.json` pesa 5,5 MB
 * perche' porta la prova di ogni aggancio; qui servono solo i codici, e il file scende
 * a poche centinaia di KB.
 *
 * PERCHE' SERVE. Oggi l'app cerca il modello Autoscout dentro models.json col matcher
 * condiviso. Quando non lo trova scende a livello MARCA e restringe filtrando i titoli:
 * per "Beta R-12" mostra 100 annunci, 100 di un altro modello. Il ponte ha il codice
 * per 220 famiglie in piu' (89 auto, 131 moto) e ne ha PIU' D'UNO per 47, dove il
 * livello non combacia — "Serie 3" su Subito e' UNA voce, su Autoscout sono undici
 * modelli (315, 316, 318, 320, 323, 324, 325, 328, 330, 335, 340).
 *
 * Autoscout accetta piu' modelli nella STESSA query (verificato: 316+318+320 torna un
 * misto dei tre), quindi la traduzione non costa richieste.
 *
 * NON SOSTITUISCE quello che l'app trova gia': server.js unisce i due insiemi. Un
 * codice in piu' non puo' peggiorare, un codice al posto di un altro si'.
 *
 * Uso:  node scripts/build-as24-modelli.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const P = JSON.parse(fs.readFileSync(path.join(R, 'data', 'ponte-modelli.json'), 'utf8'));
const OUT = path.join(R, 'data', 'as24-modelli.json');
const dry = process.argv.includes('--dry');

const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

const fuori = { generatoIl: new Date().toISOString(), fonte: 'data/ponte-modelli.json', conta: {}, auto: {}, moto: {} };

for (const rel of P.relazioni) {
  if (rel.da !== 'subito' || rel.a !== 'autoscout') continue;
  for (const v of rel.voci) {
    // Solo i codici col MODELLO valorizzato: "13|||" e' brand-only, che l'app sa gia' fare.
    const codici = [...new Set(v.a.map(x => x.mmmv).filter(m => m && String(m).split('|')[1]))];
    if (!codici.length) continue;
    const marca = norm(v.marca), fam = norm(v.da.nome);
    if (!marca || !fam) continue;
    const perMarca = fuori[rel.tipo][marca] || (fuori[rel.tipo][marca] = {});
    // Nomi che normalizzano uguale (Ka / Ka+): si UNISCONO invece di sovrascriversi.
    perMarca[fam] = [...new Set([...(perMarca[fam] || []), ...codici])];
  }
}

const errori = [];
for (const tipo of ['auto', 'moto']) {
  let marche = 0, nodi = 0, codici = 0, multi = 0;
  for (const fam of Object.values(fuori[tipo])) {
    marche++;
    for (const c of Object.values(fam)) { nodi++; codici += c.length; if (c.length > 1) multi++; }
  }
  fuori.conta[tipo] = { marche, nodi, codici, multi };
  if (!nodi) errori.push(tipo + ': nessun nodo — il ponte non ha la relazione subito→autoscout?');
  // ogni codice deve avere la forma make|model|…
  for (const fam of Object.values(fuori[tipo])) for (const c of Object.values(fam)) for (const m of c) {
    const p = String(m).split('|');
    if (!p[0] || !p[1]) { errori.push(tipo + ': codice malformato ' + m); break; }
  }
}
if (errori.length) {
  console.error('INDICE NON SCRITTO — controlli falliti:');
  for (const e of errori.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}

const testo = JSON.stringify(fuori);
for (const tipo of ['auto', 'moto']) {
  const c = fuori.conta[tipo];
  console.log(`${tipo}  marche ${c.marche} · nodi ${c.nodi} · codici ${c.codici} · nodi con PIU di un modello ${c.multi}`);
}
console.log('peso ' + (testo.length / 1024).toFixed(0) + ' KB (ponte-modelli: ' + (fs.statSync(path.join(R, 'data', 'ponte-modelli.json')).size / 1024 / 1024).toFixed(1) + ' MB)');
if (dry) { console.log('--dry: non scritto'); process.exit(0); }
fs.writeFileSync(OUT, testo);
console.log('scritto ' + path.relative(R, OUT));
