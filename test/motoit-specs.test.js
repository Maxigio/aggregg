'use strict';
// Scheda tecnica moto da Moto.it (/listino/). Fixture nella forma reale verificata su 12
// pagine di 5 categorie: 5 tabelle senza titolo, chiavi italiane, "n.d." per i campi assenti,
// numeri in formato italiano (migliaia col punto, decimali con la virgola).
const { test } = require('node:test');
const assert = require('node:assert');
const mis = require('../backend/scrapers/motoit-specs');

const PAGINA = `<html><body>
  <table>
    <tr><td>Marca</td><td>CFMOTO</td></tr>
    <tr><td>Modello</td><td>800MT</td></tr>
    <tr><td>Allestimento</td><td>800MT Explore (2023 - 26)</td></tr>
    <tr><td>Categoria</td><td>Enduro Stradale</td></tr>
    <tr><td>Prezzo</td><td>9.390 €</td></tr>
    <tr><td>Garanzia</td><td>n.d.</td></tr>
  </table>
  <table>
    <tr><td>Cilindrata</td><td>799 cc</td></tr>
    <tr><td>Potenza</td><td>91,2 CV - 67 kW - 9.250 rpm</td></tr>
    <tr><td>Corsa</td><td>65,7 mm</td></tr>
    <tr><td>Peso a secco</td><td>n.d.</td></tr>
    <tr><td>Peso in ordine di marcia</td><td>218 kg</td></tr>
    <tr><td>Interasse</td><td>1.531 mm</td></tr>
    <tr><td>Tipo freno anteriore</td><td>Doppio disco</td></tr>
    <tr><td>Trasmissione finale</td><td>Catena</td></tr>
    <tr><td>Inclinazione cilindri</td><td>-</td></tr>
    <tr><td>Optional</td><td>Radar<br>di serie</td></tr>
  </table>
</body></html>`;

test('parseMotoitSpecs: identità nel head, non tra le specifiche', () => {
  const { head, groups } = mis.parseMotoitSpecs(PAGINA);
  assert.deepStrictEqual(head, { marca: 'CFMOTO', modello: '800MT', allestimento: '800MT Explore (2023 - 26)', categoria: 'Enduro Stradale' });
  const chiavi = groups.flatMap(g => g.rows.map(r => r.k));
  ['Marca', 'Modello', 'Allestimento', 'Categoria'].forEach(k => assert.ok(!chiavi.includes(k), `${k} non deve stare nei gruppi`));
});

test('parseMotoitSpecs: "n.d." e "-" scartati (meglio assente che finto)', () => {
  const chiavi = mis.parseMotoitSpecs(PAGINA).groups.flatMap(g => g.rows.map(r => r.k));
  assert.ok(!chiavi.includes('Garanzia'));
  assert.ok(!chiavi.includes('Peso a secco'));
  assert.ok(!chiavi.includes('Inclinazione cilindri'));
  assert.ok(chiavi.includes('Peso in ordine di marcia'));   // questo ha un valore vero
});

test('parseMotoitSpecs: i 5 gruppi si ricavano classificando le chiavi (l HTML non li nomina)', () => {
  const { groups } = mis.parseMotoitSpecs(PAGINA);
  const g = t => groups.find(x => x.title === t);
  const dentro = (t, k) => (g(t) || { rows: [] }).rows.some(r => r.k === k);
  assert.ok(dentro('Motore', 'Cilindrata'));
  assert.ok(dentro('Prestazioni', 'Potenza'));
  assert.ok(dentro('Dimensioni', 'Interasse'));                              // termine italiano aggiunto
  assert.ok(dentro('Pesi e capacità', 'Peso in ordine di marcia'));
  assert.ok(dentro('Trasmissione, freni, sospensioni', 'Tipo freno anteriore'));   // "freno", non solo "freni"
  assert.ok(dentro('Trasmissione, freni, sospensioni', 'Trasmissione finale'));
  assert.ok(dentro('Generale', 'Prezzo'));                                   // il prezzo di listino è un dato utile
});

test('parseMotoitSpecs: valori multi-riga non fondono le parole', () => {
  const rows = mis.parseMotoitSpecs(PAGINA).groups.flatMap(g => g.rows);
  assert.strictEqual(rows.find(r => r.k === 'Optional').v, 'Radar di serie');
});

test('parseMotoitSpecs: formato italiano preservato (non lo reinterpretiamo)', () => {
  const rows = mis.parseMotoitSpecs(PAGINA).groups.flatMap(g => g.rows);
  assert.strictEqual(rows.find(r => r.k === 'Potenza').v, '91,2 CV - 67 kW - 9.250 rpm');
  assert.strictEqual(rows.find(r => r.k === 'Interasse').v, '1.531 mm');
});

test('specUrl: forma /listino/<marca>/<modello>/<x>/<codice> (il codice basta, il sito redirige)', () => {
  assert.strictEqual(mis.specUrl('cfmoto', '800mt', '0UjUQn'), 'https://www.moto.it/listino/cfmoto/800mt/v/0UjUQn');
});

test('isVuoto: riconosce i non-dati', () => {
  ['n.d.', 'N.D', 'nd', '-', '--', '—', ''].forEach(v => assert.ok(mis.isVuoto(v), `"${v}" è vuoto`));
  ['218 kg', '0', 'n.d. reale?'].forEach(v => assert.ok(!mis.isVuoto(v), `"${v}" NON è vuoto`));
});

test('httpGetText: anti-SSRF, host diverso da moto.it rifiutato', async () => {
  await assert.rejects(() => mis.httpGetText('https://example.com/listino/x'), /host non consentito/);
});
