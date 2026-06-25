'use strict';
// M-K: split AS24 per superare il tetto di paginazione (~1629/query). Test PURI:
// countQueryString con range anno/prezzo + planBuckets con countFn iniettata (no rete).
const test = require('node:test');
const assert = require('node:assert');
const as24 = require('../backend/scrapers/autoscout-graphql');

test('AS24 _countQueryString: range anno/prezzo appesi (back-compat senza range)', () => {
  // range anno
  assert.equal(
    as24._countQueryString('9|1624||', 'auto', { annoMin: 2016, annoMax: 2020 }),
    'sort=standard&desc=0&ustate=U&atype=C&cy=I&mmm=9|1624|&fregfrom=2016&fregto=2020');
  // range anno + prezzo (anno singolo enorme)
  assert.equal(
    as24._countQueryString('9|1624||', 'auto', { annoMin: 2020, annoMax: 2020, prezzoMin: 0, prezzoMax: 15000 }),
    'sort=standard&desc=0&ustate=U&atype=C&cy=I&mmm=9|1624|&fregfrom=2020&fregto=2020&pricefrom=0&priceto=15000');
  // SENZA range → identico a prima (back-compat con M-J / fetchTotalCount esistente)
  assert.equal(
    as24._countQueryString('9|1624||', 'auto'),
    'sort=standard&desc=0&ustate=U&atype=C&cy=I&mmm=9|1624|');
});

test('AS24 _planBuckets: totale ≤ soglia → una sola sweep piena (niente split)', async () => {
  const countFn = async () => 800;
  const leaves = await as24.planBuckets(countFn, { splitOver: 1500 });
  assert.deepEqual(leaves, [{}]);
});

test('AS24 _planBuckets: count KO (null) → fallback sweep singola', async () => {
  const countFn = async () => null;
  const leaves = await as24.planBuckets(countFn, { splitOver: 1500 });
  assert.deepEqual(leaves, [{}]);
});

test('AS24 _planBuckets: split per anno copre [yMin,yMax] contiguo, ogni bucket ≤ soglia, somma = totale', async () => {
  // fixture tipo Audi A3: 2008-2025, 300/anno = 5400 (> soglia 1500 → deve splittare)
  const perYear = {};
  for (let y = 2008; y <= 2025; y++) perYear[y] = 300;
  const countFn = async ({ annoMin, annoMax, prezzoMin, prezzoMax } = {}) => {
    if (annoMin == null) { let s = 0; for (const y in perYear) s += perYear[y]; return s; } // {} = tutto
    let n = 0;
    for (let y = annoMin; y <= annoMax; y++) n += (perYear[y] || 0);
    if (prezzoMin != null || prezzoMax != null) {            // prezzo uniforme su [0, MAX]
      const lo = prezzoMin || 0, hi = prezzoMax == null ? 1000000 : prezzoMax;
      n = Math.round(n * (hi - lo) / 1000000);
    }
    return n;
  };
  const leaves = await as24.planBuckets(countFn, { splitOver: 1500, yearMin: 2008, yearMax: 2025 });

  for (const lf of leaves) assert.ok((await countFn(lf)) <= 1500, `bucket troppo grande: ${JSON.stringify(lf)}`);

  // qui sono tutti year-bucket (nessun anno singolo > soglia) → copertura contigua, no gap/overlap
  const yb = leaves.map(l => [l.annoMin, l.annoMax]).sort((a, b) => a[0] - b[0]);
  assert.equal(yb[0][0], 2008, 'inizio copertura');
  assert.equal(yb[yb.length - 1][1], 2025, 'fine copertura');
  for (let i = 1; i < yb.length; i++) {
    assert.equal(yb[i][0], yb[i - 1][1] + 1, `gap/overlap tra ${JSON.stringify(yb[i - 1])} e ${JSON.stringify(yb[i])}`);
  }
  let sum = 0; for (const lf of leaves) sum += await countFn(lf);
  assert.equal(sum, 5400, 'somma conteggi = totale (partizione esatta)');
});

test('AS24 _planBuckets: anno singolo enorme → split per PREZZO (ogni foglia ≤ soglia)', async () => {
  // tutto concentrato nel 2024 = 4000, uniforme sul prezzo → year-split non basta → price-split
  const countFn = async ({ annoMin, prezzoMin, prezzoMax } = {}) => {
    if (annoMin == null) return 4000;                       // {} = tutto
    const lo = prezzoMin || 0, hi = prezzoMax == null ? 1000000 : prezzoMax;
    return Math.round(4000 * (hi - lo) / 1000000);          // 2024-only, uniforme su prezzo
  };
  const leaves = await as24.planBuckets(countFn, { splitOver: 1500, yearMin: 2024, yearMax: 2024 });
  for (const lf of leaves) assert.ok((await countFn(lf)) <= 1500, `bucket grande: ${JSON.stringify(lf)}`);
  assert.ok(leaves.some(l => l.prezzoMin != null), 'atteso almeno un bucket split per prezzo');
  // F3 review: la partizione prezzo deve COPRIRE tutto (somma = totale, no buco/overlap) e
  // avere il bucket TOP aperto (prezzoMax=null → cattura > SPLIT_PRICE_MAX).
  assert.ok(leaves.some(l => l.prezzoMax == null), 'atteso un bucket prezzo TOP aperto (>MAX catturato)');
  let psum = 0; for (const lf of leaves) psum += await countFn(lf);
  assert.ok(Math.abs(psum - 4000) <= 5, `somma price-bucket ${psum} ≈ 4000 (partizione esatta)`);
});

test('AS24 planBuckets: l’usato PRE-1985 (modelli d’epoca) NON viene droppato (F1 review)', async () => {
  // fixture con 1970 (epoca) + 2008-2010: col vecchio yMin=1985 le 1970 sparivano dal totale.
  const perYear = { 1970: 1000, 2008: 300, 2009: 300, 2010: 300 };   // totale 1900 > soglia → split
  const total = Object.values(perYear).reduce((a, b) => a + b, 0);
  const countFn = async ({ annoMin, annoMax } = {}) => {
    if (annoMin == null && annoMax == null) return total;            // {} = tutto
    let n = 0;
    for (const y in perYear) {
      const yi = +y;
      if ((annoMin == null || yi >= annoMin) && (annoMax == null || yi <= annoMax)) n += perYear[y];
    }
    return n;
  };
  const leaves = await as24.planBuckets(countFn, { splitOver: 1500 });   // yMin DEFAULT (1900)
  assert.notDeepEqual(leaves, [{}], 'totale > soglia → deve splittare');
  let sum = 0; for (const lf of leaves) sum += await countFn(lf);
  assert.equal(sum, total, 'somma foglie = totale → le 1000 auto del 1970 sono coperte, non droppate');
});
