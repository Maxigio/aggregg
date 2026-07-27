'use strict';
/**
 * PONTE VERSIONI → data/ponte-versioni.json (FILE NUOVO. I cataloghi non si toccano.)
 *
 * PERCHE' HA UNA FORMA DIVERSA dai ponti marche e modelli. Quelli collegano nodo a nodo,
 * una volta per tutte. Qui non si puo', perche' le due fonti tagliano le versioni su assi
 * diversi:
 *   Subito   per ALLESTIMENTO, senza anni      ABS · Pure · Moto Cage · 35kW
 *   Moto.it  per ANNI, con la variante nel nome  MT-07 (2014-16) · MT-07 ABS (2014-16)
 * Misurato: solo il 29% delle versioni Subito trova una variante uguale su Moto.it, mentre
 * il solo filtro dell'anno chiude su UNA versione nel 54,1% dei casi (16.967 prove) e con
 * la variante si arriva all'88% (misurato su annunci Moto.it a verita' nota).
 *
 * Quindi qui si costruisce un INDICE, non una mappa: per ogni modello agganciato si mettono
 * le versioni delle due fonti con tutto cio' che serve a scegliere — la variante estratta e
 * gli anni — e la scelta finale la fa chi ha in mano l'annuncio, che porta l'anno.
 *
 * La variante si ESTRAE, non si indovina: "MT-07 ABS (2014 - 16)" meno il nome del modello
 * e meno gli anni fa "ABS", che e' esattamente cio' che Subito scrive.
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const norm = require(path.join(R, 'backend/scrapers/brand-match.js')).norm;
const S = require(path.join(R, 'data/subito-catalogo.json'));
const M = require(path.join(R, 'data/motoit-catalogo.json'));
const P = require(path.join(R, 'data/ponte-modelli.json'));

/** la marca canonica di un nome, come la calcola il ponte modelli */
const AL2 = require(path.join(R, 'data/brand-aliases.json'));
const capoDi = new Map();
for (const t of ['auto', 'moto']) for (const g of (AL2[t] || [])) for (const x of g) capoDi.set(norm(x), norm(g[0]));
const capoMarca = s => capoDi.get(norm(s)) || norm(s);

const rel = P.relazioni.find(r => r.tipo === 'moto' && r.da === 'subito' && r.a === 'motoit');
if (!rel) { console.error('manca la relazione moto subito→motoit nel ponte modelli'); process.exit(1); }

const subMod = new Map();
for (const b of Object.values(S.moto)) for (const [id, m] of Object.entries(b.modelli || {})) subMod.set(id, { ...m, marca: b.nome });
/**
 * Chiave MARCA|SLUG, non solo slug: su Moto.it 28 slug esistono sotto piu' marche
 * ("mx-125" e' Aprilia E Tm Moto, "scrambler-400" e' Ducati E Mash Italia). Indicizzando
 * per solo slug, 60 voci dell'indice prendevano le versioni — e gli ANNI — di un'altra casa,
 * e risolviVersione filtra proprio sull'anno: rispondeva 'una' con la scheda sbagliata.
 */
const motoMod = new Map();
for (const b of Object.values(M.marche)) for (const [slug, m] of Object.entries(b.modelli || {})) motoMod.set(norm(b.nome) + '|' + slug, m);

/** nome versione meno nome modello meno anni = la variante. Vuota = versione base. */
function variante(nomeVersione, nomeModello) {
  let s = String(nomeVersione).replace(/\([^)]*\)\s*$/, '').trim();
  const nm = norm(nomeModello);
  const parole = s.split(/\s+/);
  for (let i = parole.length; i > 0; i--) {
    if (norm(parole.slice(0, i).join(' ')) === nm) { s = parole.slice(i).join(' '); break; }
  }
  return s.trim();
}

// ── autocontrollo: se l'estrazione si rompe, l'indice non vale niente ────────
(function autotest() {
  const casi = [
    ['MT-07 ABS (2014 - 16)', 'MT-07', 'ABS'],
    ['MT-07 (2021 - 24)', 'MT-07', ''],
    ['Amico 50 Clubman a.e.', 'Amico 50', 'Clubman a.e.'],
    ['Caballero 500 Scrambler Deluxe 4T (2020)', 'Caballero 500', 'Scrambler Deluxe 4T'],
  ];
  for (const [v, m, atteso] of casi) {
    const r = variante(v, m);
    if (r !== atteso) throw new Error('variante rotta: "' + v + '" − "' + m + '" → "' + r + '" invece di "' + atteso + '"');
  }
  console.log('autotest variante: ok');
})();

const fuori = {
  generatoIl: new Date().toISOString(),
  nota: 'INDICE delle versioni, non una mappa fissa: Subito taglia per allestimento e non ha '
    + 'anni, Moto.it taglia per anni. La scelta si fa quando si ha l\'annuncio, che porta l\'anno. '
    + 'Ogni versione Moto.it porta la variante ESTRATTA dal suo nome e il periodo.',
  comeSiUsa: 'dato un annuncio Subito con (modelloId, versioneId, anno): prendi la voce del '
    + 'modello, filtra le versioni Moto.it il cui periodo contiene l\'anno, e fra quelle '
    + 'preferisci chi ha la stessa variante della versione Subito. Una sola → risposta. '
    + 'Piu\' di una → dichiara l\'ambiguita\', non scegliere.',
  copertura: null,
  modelli: [],
};

let conAnni = 0, senzaAnni = 0, varEsatte = 0, versS = 0, versM = 0;
for (const v of rel.voci) {
  const s = subMod.get(v.da.id);
  // la marca del ponte e' la chiave canonica: si prova quella e, se manca, i nomi delle
  // marche Moto.it che ci ricadono. Mai lo slug da solo.
  const ms = v.a.map(x => {
    let m = motoMod.get(v.marca + '|' + x.id);
    if (!m) for (const b of Object.values(M.marche)) {
      if (norm(b.nome) !== v.marca && !(b.modelli || {})[x.id]) continue;
      if (norm(b.nome) === v.marca || (capoMarca(b.nome) === v.marca && (b.modelli || {})[x.id])) { m = b.modelli[x.id]; break; }
    }
    return { slug: x.id, m };
  }).filter(x => x.m);
  if (!s || !ms.length) continue;

  const versioniS = Object.entries(s.versioni || {})
    .map(([id, nome]) => ({ id, nome: String(nome), variante: String(nome), base: id === '000000' }));
  const versioniM = [];
  for (const { slug, m } of ms) for (const [id, vv] of Object.entries(m.versioni || {})) {
    const va = variante(vv.nome, m.nome);
    versioniM.push({ id, modelloSlug: slug, nome: vv.nome, variante: va, base: !va, anni: vv.anni || null });
    if (vv.anni) conAnni++; else senzaAnni++;
  }
  if (!versioniS.length && !versioniM.length) continue;
  versS += versioniS.length; versM += versioniM.length;

  // collegamento per VARIANTE, quando c'e'. Gli anni restano per la scelta a runtime.
  const perVar = new Map();
  for (const x of versioniM) { const k = norm(x.variante); if (!perVar.has(k)) perVar.set(k, []); perVar.get(k).push(x.id); }
  for (const x of versioniS) {
    const k = x.base ? '' : norm(x.nome);
    const c = perVar.get(k);
    if (c) { x.motoit = c; x.come = x.base ? 'versione base' : 'stessa variante'; varEsatte++; }
  }

  fuori.modelli.push({
    marca: s.marca, gradoModello: v.grado,
    subito: { id: v.da.id, nome: v.da.nome, versioni: versioniS },
    motoit: v.a.map(x => x.id),
    versioniMotoit: versioniM,
  });
}

fuori.copertura = {
  modelli: fuori.modelli.length,
  versioniSubito: versS, versioniMotoit: versM,
  versioniSubitoConVariante: varEsatte,
  versioniMotoitConAnni: conAnni, versioniMotoitSenzaAnni: senzaAnni,
  notaMisura: 'il solo filtro anno chiude su una versione nel 54,1% dei casi (16.967 prove '
    + 'modello×anno); con la variante si arriva all\'88% misurato su annunci a verita\' nota',
};

const F = path.join(R, 'data/ponte-versioni.json');
fs.writeFileSync(F, JSON.stringify(fuori, null, 1));
const c = fuori.copertura;
console.log('modelli con versioni indicizzate  ' + c.modelli);
console.log('versioni Subito                   ' + c.versioniSubito + '  di cui agganciate per variante ' + c.versioniSubitoConVariante);
console.log('versioni Moto.it                  ' + c.versioniMotoit + '  con anni ' + c.versioniMotoitConAnni + ' · senza ' + c.versioniMotoitSenzaAnni);
console.log('scritto ' + F + '  (' + (fs.statSync(F).size / 1048576).toFixed(1) + ' MB)');
