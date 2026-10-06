'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { creaRetention } = require('../backend/nodi/diagnostica-retention');

function prepara(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE lavori(id TEXT PRIMARY KEY,creato INTEGER,stato TEXT); CREATE TABLE eventi(id INTEGER PRIMARY KEY,ts INTEGER)');
  let adesso = 10 * 86400000;
  t.after(() => db.close());
  const apri = () => creaRetention({ db, ora: () => adesso });
  const riempi = (area, n, tempo = adesso, stato = 'concluso') => {
    const insert = db.prepare(area === 'lavori' ? 'INSERT INTO lavori VALUES(?,?,?)' : 'INSERT INTO eventi(ts) VALUES(?)');
    db.exec('BEGIN');
    for (let i = 0; i < n; i++) area === 'lavori'
      ? insert.run('job-' + i, tempo + i, stato) : insert.run(tempo + i);
    db.exec('COMMIT');
  };
  return { db, apri, riempi, ora: () => adesso, avanza: ms => { adesso += ms; } };
}

test('retention: il cap dichiara entrambi i tagli e li conserva dopo un riavvio', t => {
  const p = prepara(t), prima = p.apri();
  for (const area of ['lavori', 'eventi']) p.riempi(area, 10002);
  prima.pulisci();
  for (const area of ['lavori', 'eventi']) assert.equal(p.db.prepare('SELECT count(*) AS n FROM ' + area).get().n, 10000);
  assert.equal(prima.stato().troncata, true);
  assert.deepEqual(prima.stato().tagli.map(t => [t.area, t.righeUltimoTaglio]), [['eventi', 2], ['lavori', 2]]);
  const seconda = p.apri(); seconda.pulisci();
  assert.deepEqual(seconda.stato(), prima.stato());
  assert.equal(seconda.stato().backup, 'download_manuale');
  assert.equal(JSON.stringify(seconda.stato()).includes('job-'), false);
});

test('retention: il guasto alla scrittura del taglio non cancella storia senza avviso', t => {
  const p = prepara(t), r = p.apri(); r.pulisci();
  p.riempi('lavori', 10001); p.riempi('eventi', 10001);
  p.db.exec("CREATE TEMP TRIGGER fallisce BEFORE INSERT ON diagnostica_tagli WHEN NEW.area='eventi' BEGIN SELECT RAISE(ABORT,'guasto_sintetico'); END");
  assert.throws(() => r.pulisci());
  for (const area of ['lavori', 'eventi']) assert.equal(p.db.prepare('SELECT count(*) AS n FROM ' + area).get().n, 10001);
  assert.equal(r.stato().troncata, false);
  assert.equal(p.db.isTransaction, false);
  p.db.exec('DROP TRIGGER fallisce'); r.pulisci();
  assert.equal(r.stato().troncata, true);
});

test('retention: scadenza ordinaria e taglio del cap restano distinti', t => {
  const p = prepara(t), r = p.apri();
  p.riempi('eventi', 10002, p.ora() - 8 * 86400000);
  r.pulisci();
  assert.equal(p.db.prepare('SELECT count(*) AS n FROM eventi').get().n, 0);
  assert.equal(r.stato().troncata, false);
  p.riempi('eventi', 10001); r.pulisci();
  assert.equal(r.stato().troncata, true);
  p.avanza(7 * 86400000 + 1);
  assert.equal(r.stato().troncata, false);
  r.pulisci();
  assert.equal(p.db.prepare('SELECT count(*) AS n FROM diagnostica_tagli').get().n, 0);
});

test('retention: il cap preserva un lavoro attivo e non inventa un taglio', t => {
  const p = prepara(t), r = p.apri();
  p.riempi('lavori', 10001, p.ora(), 'in_corso');
  r.pulisci();
  assert.equal(p.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 10001);
  assert.equal(r.stato().troncata, false);
  p.db.exec("UPDATE lavori SET stato='concluso' WHERE id='job-0'"); r.pulisci();
  assert.equal(p.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 10000);
  assert.equal(r.stato().tagli[0].righeUltimoTaglio, 1);
});

test('retention: con DB in sola lettura conserva i metadati già confermati', t => {
  const p = prepara(t), r = p.apri(); p.riempi('eventi', 10001); r.pulisci();
  const prima = r.stato();
  p.db.exec('PRAGMA query_only=ON'); assert.throws(() => r.pulisci());
  assert.deepEqual(r.stato(), prima);
  assert.equal(p.db.isTransaction, false);
  p.db.exec('PRAGMA query_only=OFF'); r.pulisci();
  assert.deepEqual(r.stato(), prima);
});

test('retention: un guasto di inizializzazione lascia lo stato sconosciuto, senza fallire nel costruttore', t => {
  const p = prepara(t);
  p.db.exec('PRAGMA query_only=ON');
  let r; assert.doesNotThrow(() => { r = p.apri(); });
  assert.throws(() => r.pulisci());
  assert.equal(r.stato().conosciuta, false);
  assert.equal(r.stato().troncata, null);
  p.db.exec('PRAGMA query_only=OFF'); r.pulisci();
  assert.equal(r.stato().conosciuta, true);
  assert.equal(r.stato().troncata, false);
});

test('retention: dopo restart il taglio confermato resta visibile se la pulizia fallisce', t => {
  const p = prepara(t), r = p.apri(); p.riempi('eventi', 10001); r.pulisci();
  const prima = r.stato();
  p.db.exec("CREATE TEMP TRIGGER fallisce BEFORE DELETE ON eventi BEGIN SELECT RAISE(ABORT,'guasto_sintetico'); END");
  // La pulizia incontra una riga scaduta e il trigger la rifiuta.
  p.db.exec('INSERT INTO eventi(ts) VALUES(0)');
  const nuovo = p.apri(); assert.throws(() => nuovo.pulisci());
  assert.deepEqual(nuovo.stato(), prima);
  assert.equal(p.db.isTransaction, false);
  p.db.exec('DROP TRIGGER fallisce'); nuovo.pulisci();
  assert.deepEqual(nuovo.stato(), prima);
});

test('retention: Admin ed export ricevono l’avviso, senza un nuovo backup sul server', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { creaCentro } = require('../backend/nodi/centro');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-retention-http-'));
  const centro = creaCentro({ directory, tokens: { locale: 'a'.repeat(64) }, adminLocale: true });
  const server = await new Promise(resolve => {
    const s = centro.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    centro.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const prima = fs.readdirSync(directory).sort(), insert = centro.db.prepare("INSERT INTO eventi(ts,livello,codice) VALUES(?,'errore','fonte_errore')");
  centro.db.exec('BEGIN');
  for (let i = 0; i < 10001; i++) insert.run(Date.now());
  centro.db.exec('COMMIT');
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const route of ['/api/admin', '/api/admin/diagnostica', '/api/admin/esporta']) {
    const r = await fetch(base + route); assert.equal(r.status, 200);
    const body = await r.json(); assert.equal(body.diagnostica.storia.troncata, true);
    assert.equal(body.diagnostica.storia.tagli[0].area, 'eventi');
    assert.equal(body.diagnostica.storia.tagli[0].righeUltimoTaglio, 1);
  }
  assert.deepEqual(fs.readdirSync(directory).sort(), prima);
});
