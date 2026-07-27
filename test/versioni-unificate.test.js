'use strict';
// La lista versioni unita dalle due fonti. Niente rete: legge i file su disco.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { versioniDi, quante, _nomeDi } = require('../backend/scrapers/versioni-unificate');
const { risolviNodo } = require('../backend/scrapers/subito-nodo');

const DIR = path.join(__dirname, '..', 'data', 'versioni');

test('MT-07: le versioni di Subito E i periodi di Moto.it, niente perso', () => {
  const n = risolviNodo('moto', 'Yamaha', 'MT-07');
  const g = versioniDi('moto', n.marcaId, n.generazioni);
  assert.equal(g.length, 1);
  const v = g[0].versioni;
  const nomi = v.map(x => x.nome);
  assert.ok(nomi.includes('ABS'), 'l\'allestimento di Subito');
  assert.ok(nomi.includes('Pure'));
  assert.ok(nomi.some(x => /^MT-07 \(2017 - 18\)$/.test(x)), 'il periodo della base, che sta solo su Moto.it');
  assert.ok(v.length >= 16, 'sedici voci misurate: 11 Subito + 5 periodi Moto.it');
});

test('dove il ponte aggancia, la voce porta entrambe le fonti e gli anni', () => {
  const n = risolviNodo('moto', 'Yamaha', 'MT-07');
  const abs = versioniDi('moto', n.marcaId, n.generazioni)[0].versioni.find(x => x.nome === 'ABS');
  assert.deepEqual(abs.fonti, ['subito', 'motoit']);
  assert.equal(abs.subito, '005267');
  assert.ok(Array.isArray(abs.motoit) && abs.motoit.length);
  assert.deepEqual(abs.anni, { da: 2014, a: 2016 });
  assert.ok(abs.nomi.length >= 2, 'i nomi di entrambe le fonti servono per il confronto col testo degli annunci');
});

test('le versioni restano sotto la loro generazione, non appiattite', () => {
  const n = risolviNodo('auto', 'BMW', 'Serie 3');
  const g = versioniDi('auto', n.marcaId, n.generazioni);
  assert.ok(g.length >= 8, 'la Serie 3 ha nove serie su Subito');
  assert.ok(g.some(x => /E46/.test(x.nome)));
  assert.ok(g.every(x => x.versioni.length > 0));
});

test('NESSUNA auto porta versioni di Moto.it (gli id-modello si ripetono fra i tipi)', () => {
  let voci = 0;
  for (const f of fs.readdirSync(path.join(DIR, 'auto'))) {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, 'auto', f), 'utf8'));
    for (const l of Object.values(j)) for (const v of l) {
      voci++;
      assert.ok(!v.motoit, 'auto/' + f + ': versione Moto.it attaccata a un\'auto');
    }
  }
  assert.ok(voci > 100000, 'controllate tutte le voci auto, non un campione: ' + voci);
});

test('"Altro allestimento" non e\' una versione e non compare', () => {
  const n = risolviNodo('auto', 'Alfa Romeo', 'Giulia');
  const v = versioniDi('auto', n.marcaId, n.generazioni)[0].versioni;
  assert.ok(!v.some(x => x.id === 's000000' || /altro allestimento/i.test(x.nome)));
});

test('i nomi non sono stati toccati: sono quelli esatti della fonte', () => {
  const n = risolviNodo('auto', 'Alfa Romeo', 'Giulia');
  const v = versioniDi('auto', n.marcaId, n.generazioni)[0].versioni;
  assert.ok(v.some(x => x.nome === 'Giulia 2.9 V6 Bi-Turbo Quadrifoglio'),
    'il prefisso col nome del modello resta: manipolare i nomi ci e\' gia\' costato troppo');
});

test('marca o modello che non esistono → lista vuota, mai un errore', () => {
  assert.deepEqual(versioniDi('auto', '999999', [{ id: 'x', nome: 'y' }]), []);
  assert.deepEqual(versioniDi('moto', '', []), []);
  assert.equal(quante('auto', '999999', []), 0);
});

test('le versioni per slug Moto.it coprono i modelli che Subito non risolve', () => {
  const { versioniMotoit } = require('../backend/scrapers/versioni-unificate');
  const v = versioniMotoit('yamaha', 'mt-07');
  assert.ok(v.length >= 9, 'le nove versioni del catalogo');
  assert.ok(v.every(x => x.fonti.length === 1 && x.fonti[0] === 'motoit'));
  assert.ok(v.some(x => /MT-07 ABS/.test(x.nome)));
});

test('gli id gia\' presenti non si duplicano', () => {
  const { versioniMotoit } = require('../backend/scrapers/versioni-unificate');
  const tutte = versioniMotoit('yamaha', 'mt-07');
  const meno = versioniMotoit('yamaha', 'mt-07', new Set([tutte[0].motoit[0]]));
  assert.equal(meno.length, tutte.length - 1);
});

test('anche per slug, le entita HTML non arrivano a schermo', () => {
  const { versioniMotoit } = require('../backend/scrapers/versioni-unificate');
  const v = versioniMotoit('betamotor', 'tempo-50');
  assert.ok(v.length, 'il modello esiste in catalogo');
  assert.equal(v.filter(x => /&[a-z#0-9]+;/i.test(x.nome)).length, 0);
});

test('slug che non esiste → lista vuota, mai un errore', () => {
  const { versioniMotoit } = require('../backend/scrapers/versioni-unificate');
  assert.deepEqual(versioniMotoit('yamaha', 'modello-inventato'), []);
  assert.deepEqual(versioniMotoit('', 'mt-07'), []);
  assert.deepEqual(versioniMotoit('marca-inventata', 'mt-07'), []);
});

test('il nome mostrato: Subito se c\'e\', altrimenti Moto.it', () => {
  assert.equal(_nomeDi({ subito: { nome: 'ABS' }, motoit: [{ nome: 'MT-07 ABS (2014 - 16)' }] }), 'ABS');
  assert.equal(_nomeDi({ motoit: [{ nome: 'MT-07 (2017 - 18)' }] }), 'MT-07 (2017 - 18)');
  assert.equal(_nomeDi({}), '');
});
