#!/usr/bin/env node
'use strict';
/**
 * COSTRUISCE data/versioni/<tipo>/<marcaId>.json — la lista versioni che l'utente vede.
 *
 * UNA LISTA SOLA, non una per fonte: e' il motivo per cui i cataloghi sono stati
 * scaricati e uniti.
 *
 * NON SI PERDE NIENTE, ed e' la regola che conta. Le due fonti tagliano la versione in
 * modi diversi e nessuna e' un sottoinsieme dell'altra:
 *
 *   Subito    "ABS"                          l'allestimento, senza anni
 *   Moto.it   "MT-07 ABS (2014 - 16)"        allestimento + periodo
 *             "MT-07 (2014 - 16)"            la BASE di quel periodo
 *
 * Misurato: delle 14.806 versioni Moto.it, 2.466 si agganciano a una voce Subito,
 * 4.466 sono periodi della base e 7.874 portano un allestimento che Subito NON HA
 * ("AF1 125 Sport Production (1991 - 92)"). Tenere solo la lista Subito avrebbe buttato
 * via 12.340 voci. Quindi: entrano tutte, unite dove il ponte le aggancia, separate
 * dove no.
 *
 * I NOMI NON SI TOCCANO. Niente prefissi tolti, niente ripuliture: ogni volta che
 * abbiamo manipolato i nomi ci e' costato — il "+" buttato da norm, la soglia dei tre
 * caratteri, la sottostringa. Nel dato resta la scritta esatta della fonte; se il menu
 * risulta verboso, si risolve a schermo senza toccare il valore.
 *
 * UN FILE PER MARCA. Tutto insieme sono 12 MB, che diventano 86 MB in memoria per una
 * tendina. Per marca: mediana 1 KB, massimo 1 MB (Ford). Si legge quella che serve.
 *
 * Uso:  node scripts/build-versioni-unificate.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const S = JSON.parse(fs.readFileSync(path.join(R, 'data', 'subito-catalogo.json'), 'utf8'));
const PV = JSON.parse(fs.readFileSync(path.join(R, 'data', 'ponte-versioni.json'), 'utf8'));
const DIR = path.join(R, 'data', 'versioni');
const dry = process.argv.includes('--dry');

const NON_DICHIARATA = '000000';

const ponte = new Map();
for (const m of PV.modelli) ponte.set(String(m.subito.id), m);

const conta = { auto: { marche: 0, modelli: 0, voci: 0, unite: 0, soloSubito: 0, soloMotoit: 0 }, moto: { marche: 0, modelli: 0, voci: 0, unite: 0, soloSubito: 0, soloMotoit: 0 } };
const scritti = [];

for (const tipo of ['auto', 'moto']) {
  for (const b of Object.values(S[tipo] || {})) {
    const perModello = {};
    let modelli = 0;
    for (const [modId, m] of Object.entries(b.modelli || {})) {
      // SOLO PER LE MOTO. Gli id-modello di Subito NON sono unici fra i due tipi:
      // 1.368 sono in comune, e 912 di quelli stanno nel ponte versioni (che e' solo
      // moto). Senza questo controllo una AC Cobra si prendeva le versioni di una
      // Honda CLR 125 City Fly, e l'Alfa Romeo 141 versioni di Harley e Kymco.
      const voce = tipo === 'moto' ? (ponte.get(String(modId)) || null) : null;
      const versM = new Map();
      if (voce) for (const v of voce.versioniMotoit) versM.set(String(v.id), v);
      const dalPonte = new Map();
      if (voce) for (const v of voce.subito.versioni) dalPonte.set(String(v.id), v);

      const lista = [];
      const usateM = new Set();

      // 1) tutte le versioni di Subito, con l'aggancio Moto.it quando c'e'
      for (const [vid, nome] of Object.entries(m.versioni || {})) {
        if (vid === NON_DICHIARATA) continue;          // segnaposto, non una versione
        const p = dalPonte.get(String(vid));
        const ids = (p && p.motoit) || [];
        const mi = ids.map(x => versM.get(String(x))).filter(Boolean);
        mi.forEach(x => usateM.add(String(x.id)));
        const rec = { id: 's' + vid, subito: { id: vid, nome: String(nome) } };
        if (mi.length) {
          rec.motoit = mi.map(x => ({ id: x.id, nome: x.nome, anni: x.anni || null }));
          const an = mi.map(x => x.anni).filter(Boolean);
          if (an.length) rec.anni = { da: Math.min(...an.map(x => x.da)), a: Math.max(...an.map(x => x.a || x.da)) };
          conta[tipo].unite++;
        } else conta[tipo].soloSubito++;
        lista.push(rec);
      }

      // 2) tutte le versioni di Moto.it che nessuna voce Subito ha preso —
      //    i periodi della base E gli allestimenti che Subito non conosce
      if (voce) for (const v of voce.versioniMotoit) {
        if (usateM.has(String(v.id))) continue;
        lista.push({
          id: 'm' + v.id,
          motoit: [{ id: v.id, nome: v.nome, anni: v.anni || null }],
          anni: v.anni || null,
          base: !!v.base,
        });
        conta[tipo].soloMotoit++;
      }

      if (!lista.length) continue;
      perModello[modId] = lista;
      modelli++;
      conta[tipo].voci += lista.length;
    }
    if (!modelli) continue;
    conta[tipo].marche++;
    conta[tipo].modelli += modelli;
    scritti.push({ tipo, marcaId: b.id, marcaNome: b.nome, perModello });
  }
}

// ── controlli: nessuna versione persa, nessuna voce senza nome ───────────────
const errori = [];
for (const tipo of ['auto', 'moto']) {
  let atteseS = 0;
  for (const b of Object.values(S[tipo] || {})) for (const m of Object.values(b.modelli || {})) {
    atteseS += Object.keys(m.versioni || {}).filter(v => v !== NON_DICHIARATA).length;
  }
  const scritteS = conta[tipo].soloSubito + conta[tipo].unite;
  if (scritteS !== atteseS) errori.push(`${tipo}: ${scritteS} versioni Subito scritte contro ${atteseS} nel catalogo`);
}
// Ogni versione Moto.it del ponte deve COMPARIRE da qualche parte. Si conta la
// COPERTURA, non le occorrenze: una versione Subito ("ABS") aggancia legittimamente
// piu' periodi Moto.it, e piu' versioni Subito possono agganciare lo stesso periodo
// (misurati 56 casi). Contare le occorrenze darebbe un numero piu' alto e non
// vorrebbe dire niente: la domanda e' "ne ho persa qualcuna", non "quante volte".
// Nessuna AUTO puo' portare versioni Moto.it: se succede, un id-modello si e' ripetuto
// fra i due tipi e stiamo attaccando una moto a una macchina.
for (const x of scritti) {
  if (x.tipo !== 'auto') continue;
  for (const [modId, l] of Object.entries(x.perModello)) for (const v of l) {
    if (v.motoit) { errori.push(`auto ${x.marcaNome}/${modId}: versione Moto.it "${v.motoit[0].nome}" attaccata a un'auto`); break; }
  }
}

const copertePerModello = new Map();
for (const x of scritti) for (const [modId, l] of Object.entries(x.perModello)) {
  const s = copertePerModello.get(modId) || new Set();
  for (const v of l) for (const mv of (v.motoit || [])) s.add(String(mv.id));
  copertePerModello.set(modId, s);
}
const perse = [];
for (const m of PV.modelli) {
  const s = copertePerModello.get(String(m.subito.id)) || new Set();
  for (const v of m.versioniMotoit) if (!s.has(String(v.id))) perse.push(m.marca + ' ' + m.subito.nome + ' → ' + v.nome);
}
if (perse.length) errori.push(`Moto.it: ${perse.length} versioni NON compaiono nella lista — ${perse.slice(0, 3).join(' | ')}`);
for (const x of scritti) for (const l of Object.values(x.perModello)) for (const v of l) {
  const nome = (v.subito && v.subito.nome) || (v.motoit && v.motoit[0] && v.motoit[0].nome);
  if (!nome || !v.id) { errori.push(`${x.tipo}/${x.marcaId}: voce senza nome o senza id`); break; }
}
if (errori.length) {
  console.error('NON SCRITTO — i conti non tornano:');
  for (const e of errori.slice(0, 8)) console.error('  ' + e);
  process.exit(1);
}

for (const tipo of ['auto', 'moto']) {
  const c = conta[tipo];
  console.log(`${tipo}  marche ${c.marche} · modelli ${c.modelli} · voci ${c.voci}`
    + `  (unite ${c.unite} · solo Subito ${c.soloSubito} · solo Moto.it ${c.soloMotoit})`);
}
let byte = 0, max = { kb: 0 };
for (const x of scritti) { const t = JSON.stringify(x.perModello); byte += t.length; if (t.length / 1024 > max.kb) max = { kb: t.length / 1024, marca: x.marcaNome }; }
console.log(`peso totale ${(byte / 1024 / 1024).toFixed(1)} MB in ${scritti.length} file · il piu' grande ${max.kb.toFixed(0)} KB (${max.marca})`);

if (dry) { console.log('--dry: non scritto'); process.exit(0); }
for (const tipo of ['auto', 'moto']) fs.mkdirSync(path.join(DIR, tipo), { recursive: true });
for (const x of scritti) fs.writeFileSync(path.join(DIR, x.tipo, x.marcaId + '.json'), JSON.stringify(x.perModello));
fs.writeFileSync(path.join(DIR, 'manifesto.json'), JSON.stringify({ generatoIl: new Date().toISOString(), conta, file: scritti.length }));
console.log('scritti in ' + path.relative(R, DIR));
