'use strict';
/**
 * PONTE MARCHE — genera data/ponte-marche.json dai tre cataloghi.
 * Trova le coppie candidate (parole/prefisso), le VERIFICA sui modelli condivisi, e applica
 * le decisioni prese a mano dal proprietario. Un controllo si ferma se una decisione si perde.
 * SOLA LETTURA sui cataloghi.
 *   node scripts/build-ponte-marche.js
 */

const fs = require('fs');
const R = '/Volumes/MAIN/BananaChePrezzi-main';
const norm = require(R + '/backend/scrapers/brand-match.js').norm;
const S = require(R + '/data/subito-catalogo.json');
const M = require(R + '/data/motoit-catalogo.json');
const A = require(R + '/data/models.json');
const ALIAS = require(R + '/data/brand-aliases.json');

const CONFERMATE = [
  ['Vespa', 'Piaggio'],            // detto dal proprietario: su Subito le Vespa stanno sotto Piaggio
  ['TM Racing', 'TM', 'Tm Moto'],  // detto dal proprietario
];
const canon = new Map();
for (const g of (Array.isArray(ALIAS) ? ALIAS : Object.values(ALIAS))) {
  const l = Array.isArray(g) ? g : [g]; const capo = norm(l[0]);
  for (const x of l) canon.set(norm(x), capo);
}
for (const g of CONFERMATE) { const capo = norm(g[0]); for (const x of g) canon.set(norm(x), capo); }
const K = s => canon.get(norm(s)) || norm(s);

const tok = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z0-9]+/).filter(Boolean);
const sub = (a, b) => a.length && a.length < b.length && a.every(x => b.includes(x));

// ── inventari, con i modelli ────────────────────────────────────────────────
const inv = {
  auto: {
    subito: Object.values(S.auto).map(b => ({ nome: b.nome, modelli: Object.values(b.modelli || {}).map(m => m.nome) })),
    autoscout: Object.entries(A.auto).map(([nome, b]) => ({ nome, modelli: b.models.map(m => m.nome) })),
  },
  moto: {
    subito: Object.values(S.moto).map(b => ({ nome: b.nome, modelli: Object.values(b.modelli || {}).map(m => m.nome) })),
    autoscout: Object.entries(A.moto).map(([nome, b]) => ({ nome, modelli: b.models.map(m => m.nome) })),
    motoit: Object.values(M.marche).map(b => ({ nome: b.nome, modelli: Object.values(b.modelli || {}).map(m => m.nome) })),
  },
};

/** nome modello senza la generazione che Subito ci attacca dentro */
const base = s => norm(String(s).replace(/\([^)]*\)/g, '').replace(/\d+[ªa]\s*serie.*/i, ''));


const V = { generatoIl: new Date().toISOString(), auto: [], moto: [] };
for (const tipo of ['auto', 'moto']) {
  const fonti = Object.keys(inv[tipo]);
  const coppie = new Map();
  for (let i = 0; i < fonti.length; i++) for (let j = 0; j < fonti.length; j++) {
    if (i === j) continue;
    for (const a of inv[tipo][fonti[i]]) for (const b of inv[tipo][fonti[j]]) {
      const ka = K(a.nome), kb = K(b.nome);
      if (ka === kb) continue;                       // gia' collegate
      const ta = tok(a.nome), tb = tok(b.nome);
      const perParole = sub(ta, tb) || sub(tb, ta);
      const perPrefisso = (ka.length >= 3 && kb.startsWith(ka)) || (kb.length >= 3 && ka.startsWith(kb));
      if (!perParole && !perPrefisso) continue;
      const id = [fonti[i] + '|' + a.nome, fonti[j] + '|' + b.nome].sort().join(' ==?== ');
      if (coppie.has(id)) continue;
      const sa = new Set(a.modelli.map(base)), sb2 = new Set(b.modelli.map(base));
      const com = [...sa].filter(x => x && x !== 'altromodello' && sb2.has(x));
      coppie.set(id, {
        a: fonti[i] + ':' + a.nome + '(' + a.modelli.length + ')',
        b: fonti[j] + ':' + b.nome + '(' + b.modelli.length + ')',
        comuni: com.length, esempi: com.slice(0, 5),
        come: perParole ? 'parole' : 'prefisso',
      });
    }
  }
  V[tipo] = [...coppie.values()].sort((x, y) => y.comuni - x.comuni);
}


'use strict';
/**
 * PONTE MARCHE — costruisce data/ponte-marche.json (FILE NUOVO, i cataloghi non si toccano).
 *
 * Tre relazioni, non una:
 *   stessa      = e' la stessa marca scritta in modi diversi          → si fondono
 *   distribuisce= marchio commerciale che vende veicoli di un'altra   → NON si fondono, ma i
 *                 modelli puntano alla casa madre (RedMoto vende Honda)
 *   distinta    = somigliano ma non sono la stessa cosa               → mai unire
 *
 * Ogni voce porta la PROVA (modelli in comune) o CHI l'ha decisa.
 */





// ── decisioni del proprietario, 27 luglio ───────────────────────────────────
const DECISO = {
  // stessa marca, deciso a voce
  'moto/Vespa|Piaggio': ['stessa', 'proprietario: su Subito le Vespa stanno sotto Piaggio'],
  'moto/TM Racing|TM': ['stessa', 'proprietario'],
  'moto/TM Racing|Tm Moto': ['stessa', 'proprietario'],
  'AUSTIN ROVER|Austin': ['stessa', 'proprietario: Austin Rover va con Austin'],
  'AUSTIN ROVER|Rover': ['distinta', 'proprietario: va con Austin, non con Rover'],
  // preparatori e importatori: marche separate, ma vendono veicoli della casa madre
  'RedMoto Honda|Honda': ['distribuisce', 'proprietario: preparatori separati'],
  "Honda Dall'Ara|Honda": ['distribuisce', 'proprietario: preparatori separati'],
  'Suzuki Valenti|Suzuki': ['distribuisce', 'proprietario: preparatori separati'],
  // veicoli industriali: separati
  'RENAULT TRUCKS|Renault': ['distinta', 'proprietario: trucks separati'],
  'RENAULT V.I.|Renault': ['distinta', 'proprietario: trucks separati'],
  'MITSUBISHI FUSO|Mitsubishi': ['distinta', 'proprietario: trucks separati'],
  'MITSUBISHI TRUCKS|Mitsubishi': ['distinta', 'proprietario: trucks separati'],
  // le sei con un solo modello in comune, approvate a voce il 27 luglio
  'GAZ AUTOMOBILE|GAZ': ['stessa', 'proprietario'],
  'MICROLINO|Micro': ['stessa', 'proprietario'],
  'NISSAN SPAGNA|Nissan': ['stessa', 'proprietario'],
  'PANTHER|Panther Westwinds': ['stessa', 'proprietario'],
  'WRM Motorcycles|WRM': ['stessa', 'proprietario'],
  'Can-Am|Can-Am Brp': ['stessa', 'proprietario'],
};
const chiaveDec = (a, b) => [a, b].sort().join('|');
const decisioni = new Map();      // chiave coppia → [relazione, perche]
const tipoDi = new Map();         // chiave coppia → 'auto'|'moto' quando dichiarato
for (const [k, v] of Object.entries(DECISO)) {
  const m = k.match(/^(auto|moto)\/(.*)$/);
  const corpo = m ? m[2] : k;
  const kk = chiaveDec(...corpo.split('|'));
  decisioni.set(kk, v);
  if (m) tipoDi.set(kk, m[1]);
}
const usate = new Set();

const nomeDi = s => s.replace(/^[a-z]+:/, '').replace(/\(\d+\)$/, '');
const fonteDi = s => s.split(':')[0];

const fuori = {
  generatoIl: new Date().toISOString(),
  nota: 'Ponte a livello MARCA fra Subito, Autoscout e Moto.it. I cataloghi di origine non sono '
    + 'stati modificati. Ogni voce porta la prova (modelli in comune) o chi l\'ha decisa. '
    + '`distribuisce` = marchi commerciali distinti che vendono veicoli della casa madre: '
    + 'restano separati come marca, ma i loro modelli sono gli stessi veicoli.',
  relazioni: { stessa: 'fondere', distribuisce: 'non fondere, modelli condivisi', distinta: 'mai unire' },
  voci: { auto: [], moto: [] },
};

let n = { stessa: 0, distribuisce: 0, distinta: 0, aperta: 0 };
for (const tipo of ['auto', 'moto']) {
  for (const c of V[tipo]) {
    const na = nomeDi(c.a), nb = nomeDi(c.b);
    const dec = decisioni.get(chiaveDec(na, nb));
    let rel, perche;
    if (dec) { [rel, perche] = dec; usate.add(chiaveDec(na, nb)); }
    else if (c.comuni === 0) { rel = 'distinta'; perche = 'zero modelli in comune'; }
    else if (c.comuni >= 2) { rel = 'stessa'; perche = c.comuni + ' modelli in comune: ' + c.esempi.slice(0, 3).join(', '); }
    else { rel = null; perche = 'un solo modello in comune (' + c.esempi[0] + ') — da decidere'; }
    if (!rel) n.aperta++; else n[rel]++;
    fuori.voci[tipo].push({
      relazione: rel, perche,
      a: { fonte: fonteDi(c.a), nome: na }, b: { fonte: fonteDi(c.b), nome: nb },
      modelliInComune: c.comuni,
    });
  }
}

// Le decisioni prese a voce che NON corrispondono a nessuna coppia candidata (Vespa/Piaggio:
// i nomi non si somigliano, quindi nessuna regola le proporrebbe mai) vanno emesse lo stesso.
// Prima cadevano nel vuoto in silenzio.
for (const [kk, [rel, perche]] of decisioni) {
  if (usate.has(kk)) continue;
  const t = tipoDi.get(kk);
  if (!t) { console.error('DECISIONE SENZA TIPO e senza candidata: ' + kk + ' — non so dove metterla'); process.exit(1); }
  const [x, y] = kk.split('|');
  fuori.voci[t].push({ relazione: rel, perche, a: { fonte: '*', nome: x }, b: { fonte: '*', nome: y }, modelliInComune: null });
  n[rel]++;
}
// CONTROLLO: ogni decisione presa a voce dev'essere finita nel file.
const dentro = new Set([...fuori.voci.auto, ...fuori.voci.moto].map(x => chiaveDec(x.a.nome, x.b.nome)));
const perse = [...decisioni.keys()].filter(k => !dentro.has(k));
if (perse.length) { console.error('DECISIONI PERSE: ' + perse.join(' · ')); process.exit(1); }
console.log('decisioni del proprietario nel file: ' + decisioni.size + '/' + decisioni.size);
console.log('stessa marca      ' + n.stessa);
console.log('distribuisce      ' + n.distribuisce);
console.log('distinta          ' + n.distinta);
console.log('ANCORA APERTE     ' + n.aperta);
console.log('\nle aperte:');
for (const tipo of ['auto', 'moto'])
  fuori.voci[tipo].filter(x => !x.relazione)
    .forEach(x => console.log('  ' + tipo + '  ' + (x.a.fonte + ':' + x.a.nome).padEnd(30) + ' ↔ ' + (x.b.fonte + ':' + x.b.nome).padEnd(28) + ' ' + x.perche));

const F = R + '/data/ponte-marche.json';
fs.writeFileSync(F, JSON.stringify(fuori, null, 1));
console.log('\nscritto ' + F);
