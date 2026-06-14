'use strict';
// Integrazione gated su DATABASE_URL_TEST (come listings-repo). Verifica la
// cadenza 1×/giorno: ramp e dueTargets non si ripetono entro ~20h (F1.6).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('watchlist-repo: SKIP — imposta DATABASE_URL_TEST', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const wl = require('../backend/db/watchlist-repo');

const SEED = [
  { tipo: 'auto', marca: 'Fiat', modello: 'Panda' },
  { tipo: 'auto', marca: 'Fiat', modello: '500' },
  { tipo: 'auto', marca: 'Ford', modello: 'Focus' },
];

before(async () => { await db.init(); });
after(async () => { await db.close(); });
beforeEach(async () => {
  await db.query('TRUNCATE watchlist RESTART IDENTITY');
  await wl.insertTargets(SEED);
});

test('activateRamp: max 1×/giorno (2° giro entro 20h → [])', async () => {
  const a1 = await wl.activateRamp(2);
  assert.strictEqual(a1.length, 2);
  const a2 = await wl.activateRamp(2);
  assert.strictEqual(a2.length, 0, 'già rampato in giornata → niente nuove attivazioni');
});

test('activateRamp: dopo ~21h riprende', async () => {
  await wl.activateRamp(2);
  await db.query("UPDATE watchlist SET activated_at = now() - interval '21 hours' WHERE activated_at IS NOT NULL");
  const a = await wl.activateRamp(2);
  assert.strictEqual(a.length, 1, 'resta 1 target spento → attivato');
});

test('dueTargets: salta i target swept <20h, riprende dopo', async () => {
  await wl.activateRamp(3);
  let due = await wl.dueTargets();
  assert.strictEqual(due.length, 3, 'mai swept → tutti due');
  for (const t of due) await wl.markSwept(t.id);
  due = await wl.dueTargets();
  assert.strictEqual(due.length, 0, 'appena swept → nessuno due (no re-sweep in giornata)');
  await db.query("UPDATE watchlist SET last_swept = now() - interval '21 hours'");
  due = await wl.dueTargets();
  assert.strictEqual(due.length, 3, 'dopo 21h → di nuovo due');
});

// NB F5: leaseTarget ora è node-filtered (= leaseDueTarget(dev,'fill')). I SEED
// hanno assigned_node NULL → di proprietà iMac. 'imac' li vede, 'surface' no.
test('leaseTarget(imac): target diversi + completeTarget libera e marca swept', async () => {
  const a = await wl.leaseTarget('imac');
  const b = await wl.leaseTarget('imac');
  assert.ok(a && b);
  assert.notStrictEqual(a.id, b.id, 'lease successivi danno target diversi (no doppioni)');
  await wl.completeTarget(a.id);
  const row = (await db.query('SELECT last_swept, leased_until, activated_at FROM watchlist WHERE id=$1', [a.id])).rows[0];
  assert.ok(row.last_swept, 'completeTarget marca swept');
  assert.strictEqual(row.leased_until, null, 'lease liberato');
  assert.ok(row.activated_at, 'attivato (entra nel daily dell\'iMac)');
});

test('dueTargets(imac) esclude i target attualmente leasati', async () => {
  await wl.activateRamp(3);
  const leased = await wl.leaseTarget('imac');
  const due = await wl.dueTargets('imac');
  assert.ok(!due.some(t => t.id === leased.id), 'iMac non tocca un target con lease vivo');
});

// ─── F5 — partizione statica + mode ─────────────────────────────────────────
test('partizione: surface vede SOLO i suoi target; NULL restano all\'iMac', async () => {
  // assegna 1 target a surface, lascia gli altri NULL (=imac)
  const all = await wl.listAll();
  await wl.updateOne(all[0].id, { assigned_node: 'surface' });
  // surface: fill prende solo il suo
  const sFill = await wl.leaseDueTarget('surface', 'fill');
  assert.ok(sFill, 'surface trova il suo target');
  assert.strictEqual(sFill.id, all[0].id);
  const sFill2 = await wl.leaseDueTarget('surface', 'fill');
  assert.strictEqual(sFill2, null, 'surface ha 1 solo target → poi nulla');
  // imac NON deve vedere il target di surface
  const imacIds = [];
  for (let t; (t = await wl.leaseDueTarget('imac', 'fill')); ) imacIds.push(t.id);
  assert.ok(!imacIds.includes(all[0].id), 'iMac non tocca il target di surface');
  assert.strictEqual(imacIds.length, all.length - 1, 'iMac vede tutti i NULL restanti');
});

test('mode fill vs due: fill=never-swept, due=attivato+stantio', async () => {
  const all = await wl.listAll();
  // tutti NULL=imac. nessuno attivato, nessuno swept.
  // due: richiede activated_at → 0 candidati
  assert.strictEqual(await wl.leaseDueTarget('imac', 'due'), null, 'due senza attivati → niente');
  // fill: never-swept → trova
  const f = await wl.leaseDueTarget('imac', 'fill');
  assert.ok(f, 'fill prende un never-swept');
  await wl.completeTarget(f.id);   // ora swept + activated
  // fill non lo riprende (last_swept non più NULL)
  await db.query('UPDATE watchlist SET leased_until=NULL');   // libera eventuali lease residui per il test
  const stillFill = [];
  for (let t; (t = await wl.leaseDueTarget('imac', 'fill')); ) { stillFill.push(t.id); await wl.completeTarget(t.id); }
  assert.ok(!stillFill.includes(f.id), 'fill non ripesca un target già swept');
  // ora tutti swept+activated; portali a 21h fa → due li ripiglia
  await db.query("UPDATE watchlist SET last_swept = now() - interval '21 hours', leased_until = NULL");
  const d = await wl.leaseDueTarget('imac', 'due');
  assert.ok(d, 'due ripiglia un attivato e stantio >20h');
});

test('CRUD: addOne/updateOne/removeOne', async () => {
  const added = await wl.addOne({ tipo: 'moto', marca: 'Honda', modello: 'SH 125', assigned_node: 'm2' });
  assert.ok(added && added.id, 'addOne ritorna la riga');
  assert.strictEqual(added.assigned_node, 'm2');
  const upd = await wl.updateOne(added.id, { enabled: false });
  assert.strictEqual(upd.enabled, false, 'updateOne spegne');
  assert.strictEqual(upd.assigned_node, 'm2', 'assigned_node invariato se non passato');
  const upd2 = await wl.updateOne(added.id, { assigned_node: null });
  assert.strictEqual(upd2.assigned_node, null, 'null esplicito azzera il nodo (→ iMac)');
  assert.strictEqual(await wl.removeOne(added.id), true);
  assert.strictEqual(await wl.removeOne(added.id), false, 'già rimosso → false');
});

// ─── F8 — assignMany / autoDistribute (qui per evitare race su TRUNCATE watchlist) ──
const SEED9 = [
  { tipo: 'auto', marca: 'Fiat', modello: 'Panda' }, { tipo: 'auto', marca: 'Fiat', modello: '500' },
  { tipo: 'auto', marca: 'VW', modello: 'Golf' }, { tipo: 'auto', marca: 'Ford', modello: 'Focus' },
  { tipo: 'auto', marca: 'Audi', modello: 'A3' }, { tipo: 'auto', marca: 'BMW', modello: 'Serie 1' },
  { tipo: 'moto', marca: 'Honda', modello: 'SH 125' }, { tipo: 'moto', marca: 'Yamaha', modello: 'TMAX' },
  { tipo: 'moto', marca: 'Piaggio', modello: 'Vespa GTS' },
];
async function seed9() { await db.query('TRUNCATE watchlist RESTART IDENTITY'); await wl.insertTargets(SEED9); }

test('assignMany: assegna N target a un nodo; node=null azzera', async () => {
  await seed9();
  const ids = (await wl.listAll()).map(t => t.id).slice(0, 3);
  assert.strictEqual((await wl.assignMany(ids, 'surface')).updated, 3);
  assert.strictEqual((await wl.listAll()).filter(t => t.assigned_node === 'surface').length, 3);
  assert.strictEqual((await wl.assignMany([ids[0]], null)).updated, 1);
  assert.strictEqual((await wl.listAll()).find(t => t.id === ids[0]).assigned_node, null);
});

test('autoDistribute: 9 target su 3 nodi → 3/3/3 con 1 moto ciascuno', async () => {
  await seed9();
  const r = await wl.autoDistribute(['imac', 'surface', 'massimo']);
  assert.strictEqual(r.total, 9);
  assert.deepStrictEqual(Object.fromEntries(r.assignments.map(a => [a.node, a.count])), { imac: 3, surface: 3, massimo: 3 });
  const all = await wl.listAll();
  for (const node of ['imac', 'surface', 'massimo']) {
    assert.strictEqual(all.filter(t => t.assigned_node === node && t.tipo === 'moto').length, 1, `${node}: 1 moto (mix equo)`);
  }
});

test('autoDistribute: subset ids', async () => {
  await seed9();
  const ids = (await wl.listAll()).map(t => t.id).slice(0, 4);
  const r = await wl.autoDistribute(['surface', 'massimo'], ids);
  assert.strictEqual(r.total, 4);
  assert.deepStrictEqual(Object.fromEntries(r.assignments.map(a => [a.node, a.count])), { surface: 2, massimo: 2 });
});
