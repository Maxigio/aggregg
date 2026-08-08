'use strict';
/**
 * LE VERSIONI SUGGERIBILI (backend/versioni-menu.js) — eseguite sul catalogo vero.
 * La regola: i suggerimenti sono i nomi-versione della famiglia RISOLTA (stesso
 * risolutore della ricerca, ponte degli ospiti compreso), senza la testa che ripete il
 * modello, senza il segnaposto «Altro allestimento», senza doppioni; famiglia non
 * risolta → lista vuota, mai l'elenco di un altro veicolo.
 */
const test = require('node:test');
const assert = require('node:assert');
const { versioniDi } = require('../backend/versioni-menu');
const { norm } = require('../backend/scrapers/brand-match');

test('si suggerisce l\'ALLESTIMENTO, non la stringa-motore: la coda dopo il marcatore di potenza', () => {
  const v = versioniDi('auto', 'Abarth', '124 Spider');
  assert.ok(v.length >= 3, 'attesi allestimenti per la 124 Spider, avuti ' + v.length);
  assert.ok(v.includes('GT') && v.includes('Scorpione'), 'attesi «GT» e «Scorpione», avuti: ' + v.join(' | '));
  assert.ok(!v.some(x => /^124 Spider/i.test(x)), 'la testa «124 Spider» va tolta');
  assert.ok(!v.some(x => /\d+\s*CV\b/i.test(x)), 'il motore («… 170 CV») non si suggerisce: alle fonti e\' un AND che azzera');
  // e l'ordine e' per frequenza: per la 500 le voci comuni (Lounge, Pop) stanno in cima
  const cinquecento = versioniDi('auto', 'Fiat', '500');
  assert.ok(cinquecento.slice(0, 6).includes('Lounge'), 'atteso «Lounge» in testa alla 500: ' + cinquecento.slice(0, 6).join(' | '));
});

test('il ponte degli ospiti vale anche qui: le versioni della Vespa 125 GTS arrivano da marca Vespa', () => {
  const v = versioniDi('moto', 'Vespa', '125 GTS');
  assert.ok(v.length >= 1, 'attese versioni via ospite');
  assert.ok(v.some(x => /super/i.test(x)), 'attesa una «Super …», avute: ' + v.slice(0, 4).join(' | '));
});

test('niente segnaposto, niente doppioni', () => {
  for (const [t, ma, mo] of [['auto', 'Volkswagen', 'Golf'], ['moto', 'Ducati', 'Monster']]) {
    const v = versioniDi(t, ma, mo);
    assert.ok(v.length > 0, `${ma} ${mo}: attese versioni`);
    assert.ok(!v.some(x => /altro allestimento/i.test(x)), 'il segnaposto non si suggerisce');
    const chiavi = v.map(norm);
    assert.strictEqual(new Set(chiavi).size, chiavi.length, `${ma} ${mo}: doppioni nei suggerimenti`);
  }
});

test('famiglia non risolta → lista vuota, non l\'elenco di un altro veicolo', () => {
  assert.deepStrictEqual(versioniDi('moto', 'Zündapp', 'C 50'), []);
  assert.deepStrictEqual(versioniDi('auto', 'MarcaInventata', 'Boh'), []);
});

/**
 * LA CASCATA DEL FILTRO (campagna V): il nome del menu spesso e' un SOTTO-modello della
 * famiglia Subito, e la tendina che raccoglieva la famiglia intera mischiava i fratelli
 * (difetto CLA 200/CLA 180 indicato a mano dal proprietario). Casi veri, coi falsi esclusi.
 */
test('TESTA: «CLA 200» non mischia i trim della 180, e ognuna ha i suoi', () => {
  const v200 = versioniDi('auto', 'Mercedes-Benz', 'CLA 200');
  const v180 = versioniDi('auto', 'Mercedes-Benz', 'CLA 180');
  assert.ok(v200.length > 0 && v180.length > 0, 'attesi suggerimenti per entrambe');
  assert.ok(!v200.some(x => /\b180\b/.test(x)), 'CLA 200 non deve suggerire roba «180»: ' + v200.filter(x => /\b180\b/.test(x)).slice(0, 3).join(' | '));
  assert.ok(!v180.some(x => /\b(?:200|220|250|45)\b/.test(x)), 'CLA 180 non deve suggerire i fratelli');
  // la testa consumata e' il NOME: accodata a modello «CLA 200» non raddoppia il 200
  assert.ok(!v200.some(x => /^CLA/i.test(x)), 'la testa «CLA …» va tolta dai suggerimenti');
});

test('TESTA schiacciata: «RS3» prende anche «RS 3» scritto staccato, «X2 M» solo le M35i', () => {
  const rs3 = versioniDi('auto', 'Audi', 'RS3');
  assert.ok(rs3.length >= 2 && rs3.length < 20, 'attese poche versioni RS 3, non le 1.294 della famiglia A3: ' + rs3.length);
  const x2m = versioniDi('auto', 'BMW', 'X2 M');
  assert.ok(x2m.length >= 1 && x2m.every(x => /M35i/i.test(x)),
    'X2 M = le M35i, NON i trim «M Sport»/«M Mesh» della X2 normale: ' + x2m.join(' | '));
  // «500C» Fiat: il catalogo scrive «500 C …» — lo schiacciato li aggancia
  const c = versioniDi('auto', 'Fiat', '500C');
  assert.ok(c.length > 0, 'attese le versioni C della 500');
});

test('GENERAZIONE come ripiego: i codici Porsche filtrano la 911, «S1» NON prende il secchio A1/S1', () => {
  const g991 = versioniDi('auto', 'Porsche', '991');
  assert.ok(g991.length > 0 && g991.length < 80, '991 = una generazione della 911, non tutta la famiglia: ' + g991.length);
  const s1 = versioniDi('auto', 'Audi', 'S1');
  assert.ok(s1.length >= 1 && s1.length <= 10,
    'S1 = le versioni «S1 …» di testa, non le 230 del secchio «A1/S1»: ' + s1.length);
  const ec4 = versioniDi('auto', 'Citroën', 'E-C4 Electric');
  assert.ok(ec4.length > 0 && ec4.length < 30, 'E-C4 Electric = la generazione e-C4');
  assert.ok(!ec4.some(x => /16V/i.test(x)), 'niente versioni della C4 vecchia: ' + ec4.filter(x => /16V/i.test(x)).join(' | '));
});

test('RESIDUO: «595 Competizione» trova le Competizione in coda; «NC700S» incollato trova le S', () => {
  const comp = versioniDi('auto', 'Abarth', '595 Competizione');
  assert.ok(comp.length >= 1 && comp.every(x => /competizione/i.test(x)),
    'attese solo Competizione: ' + comp.join(' | '));
  const nc = versioniDi('moto', 'Honda', 'NC700S');
  assert.ok(nc.length >= 1 && nc.every(x => /^S\b/i.test(x)), 'NC700S = le versioni S: ' + nc.join(' | '));
});

test('NIENTE APPIGLIO → tendina vuota: la variante fuori catalogo non eredita i fratelli', () => {
  // SL 380 (anni \'80): la famiglia SL ha 76 versioni moderne, nessuna «380» — proporle
  // e' il difetto CLA. Vuoto onesto, campo testo libero puro.
  assert.deepStrictEqual(versioniDi('auto', 'Mercedes-Benz', 'SL 380'), []);
  assert.deepStrictEqual(versioniDi('auto', 'Lexus', 'ES 300'), []);
});

test('NOME ≡ FAMIGLIA: la famiglia intera resta giusta quando il nome non aggiunge specificita\'', () => {
  // esatta («500» Abarth, con le C dentro: sono la stessa famiglia)
  const a500 = versioniDi('auto', 'Abarth', '500');
  assert.ok(a500.length >= 5, 'famiglia intera per «500»');
  // squash uguale a meno di spazi/trattini («ZT310-R» ≡ «ZT 310 R»)
  assert.ok(versioniDi('moto', 'Zontes', 'ZT310-R').length >= 1, 'ZT310-R ≡ famiglia «ZT 310 R»');
  // nome ⊂ famiglie multiple («Tourneo» copre le Tourneo *): unione, dichiarata dal come
  assert.ok(versioniDi('auto', 'Ford', 'Tourneo').length >= 20, 'unione delle famiglie Tourneo');
});
