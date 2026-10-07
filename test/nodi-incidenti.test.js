'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { creaIncidenti } = require('../backend/nodi/incidenti');
const { creaInvio, validaWebhook } = require('../backend/nodi/betterstack');
function fixture(t, invia = null) {
  const db = new DatabaseSync(':memory:'); let now = 100000;
  const crea = () => creaIncidenti({ db, ora: () => now, invia });
  let i = crea(); t.after(() => { i.close(); db.close(); });
  return { db, get i() { return i; }, avanti: ms => { now += ms; },
    riavvia: () => { i.close(); i = crea(); },
    hb: (extra = {}) => i.heartbeat({ id: 'prova', boot: 'boot-a', fonti: {}, ...extra }) };
}
test('incidenti: nodo inattivo, soglia 30 s, flapping e recupero solo dopo 15 s regolari', t => {
  const f = fixture(t); f.hb(); f.avanti(29999); f.i.verifica(); assert.equal(f.i.stato().totale, 0);
  f.avanti(1); f.i.verifica(); const id = f.i.stato().episodi[0].id;
  f.i.verifica(); assert.equal(f.i.stato().totale, 1);
  f.hb(); f.avanti(5000); f.hb(); f.avanti(6000); f.hb(); // Il gap interrompe la stabilità.
  for (let n = 0; n < 2; n++) { f.avanti(5000); f.hb(); }
  assert.equal(f.i.stato().episodi[0].chiuso, null);
  f.avanti(5000); f.hb(); assert.notEqual(f.i.stato().episodi[0].chiuso, null);
  f.avanti(30000); f.i.verifica(); assert.equal(f.i.stato().totale, 2);
  assert.ok(f.i.stato().episodi.some(r => r.id === id));
});
test('incidenti: riavvio preserva ultimo heartbeat e Alert ID, non la stabilità', t => {
  const f = fixture(t); f.hb(); f.avanti(30000); f.i.verifica(); const id = f.i.stato().episodi[0].id;
  f.hb(); f.avanti(5000); f.hb(); f.riavvia();
  for (let n = 0; n < 3; n++) { f.avanti(5000); f.hb(); }
  assert.equal(f.i.stato().episodi[0].chiuso, null);
  f.avanti(5000); f.hb(); assert.equal(f.i.stato().episodi[0].id, id);
  assert.notEqual(f.i.stato().episodi[0].chiuso, null);
});

test('incidenti: rientro fra due controlli non nasconde un gap oltre 30 secondi', t => {
  const f = fixture(t); f.hb(); f.avanti(29800); f.i.verifica();
  f.avanti(400); f.hb(); assert.equal(f.i.stato().totale, 1);
  assert.equal(f.i.stato().episodi[0].chiuso, null);
});

test('incidenti: COMMIT rifiutato della supervisione non interrompe la stabilità osservata', t => {
  const f = fixture(t); f.hb(); f.avanti(30000); f.i.verifica(); f.hb();
  f.avanti(5000); f.hb(); f.avanti(5000); f.hb();
  const exec = f.db.exec.bind(f.db);
  f.db.exec = sql => { if (sql === 'COMMIT') throw new Error('commit sintetico rifiutato'); return exec(sql); };
  assert.throws(() => f.i.transazione(() => f.i.supervisione({ nodo: 'prova', stato: 'fermato' })));
  f.db.exec = exec; f.avanti(5000); f.hb();
  assert.notEqual(f.i.stato().episodi[0].chiuso, null);
});
test('incidenti: fonte sconosciuta/scadenza non chiude; osservazione valida riconcilia esito perso', t => {
  const f = fixture(t);
  f.hb({ fonti: { subito: { fermo: true, aggiornataIl: 10, esito: 'bloccato' } } });
  f.hb(); f.hb({ fonti: { subito: { fermo: false } } });
  f.hb({ fonti: { subito: { fermo: false, esito: 'ok', aggiornataIl: 10 } } });
  assert.equal(f.i.stato().episodi[0].chiuso, null);
  f.riavvia(); f.hb({ fonti: { subito: { fermo: false, esito: 'vuoto', aggiornataIl: 11 } } });
  assert.notEqual(f.i.stato().episodi[0].chiuso, null);
});
test('incidenti: solo stato e fonte assente non provano guasti; offline non genera tre guasti fonte', t => {
  const f = fixture(t); f.hb({ soloStato: true, fonti: { subito: { fermo: true } } });
  assert.equal(f.i.stato().totale, 0);
  f.avanti(30000); f.i.verifica(); assert.deepEqual(f.i.stato().episodi.map(r => r.codice), ['nodo_offline']);
});
test('incidenti: stop e successivo offline sono un solo episodio; comandi intenzionali restano aperti', t => {
  const f = fixture(t); f.hb();
  f.i.transazione(() => f.i.supervisione({ nodo: 'prova', stato: 'fermato' }));
  f.avanti(30000); f.i.verifica(); assert.equal(f.i.stato().totale, 1);
  for (let n = 0; n < 2; n++) f.i.controllo({ codice: 'sospensione', nodo: 'prova', attivo: true });
  for (let n = 0; n < 5; n++) { f.avanti(5000); f.hb(); }
  assert.equal(f.i.stato().episodi.find(r => r.codice === 'sospensione').chiuso, null);
  f.i.controllo({ codice: 'sospensione', nodo: 'prova', attivo: false });
  assert.notEqual(f.i.stato().episodi.find(r => r.codice === 'sospensione').chiuso, null);
});
test('incidenti: un guasto nella creazione del pendente annulla anche il comando', t => {
  const f = fixture(t); f.db.exec('CREATE TABLE controllo(attivo INTEGER); INSERT INTO controllo VALUES(0)');
  f.db.exec("CREATE TRIGGER guasto BEFORE INSERT ON incidenti BEGIN SELECT RAISE(ABORT,'guasto sintetico'); END");
  assert.throws(() => f.i.transazione(() => {
    f.db.exec('UPDATE controllo SET attivo=1'); f.i.controllo({ codice: 'manutenzione', attivo: true });
  }));
  assert.equal(f.db.prepare('SELECT attivo FROM controllo').get().attivo, 0);
  assert.equal(f.i.stato().totale, 0);
});
test('incidenti: invio fuori dal comando, singolo Alert ID, nessun dato cliente e risoluzione ordinata', async t => {
  const inviati = []; const f = fixture(t, async p => { inviati.push(p); return { stato: 'accettato', http: 200 }; });
  f.i.controllo({ codice: 'manutenzione', attivo: true }); assert.equal(inviati.length, 0);
  f.i.controllo({ codice: 'manutenzione', attivo: true });
  await Promise.all([f.i.scarica(), f.i.scarica()]); assert.equal(inviati.length, 1);
  f.i.controllo({ codice: 'manutenzione', attivo: false }); await f.i.scarica();
  assert.deepEqual(inviati.map(p => p.incident.status), ['alert', 'resolved']);
  assert.equal(inviati[0].incident.id, inviati[1].incident.id);
  assert.deepEqual(Object.keys(inviati[0].incident.metadata).sort(), ['aperto', 'chiuso', 'codice', 'fonte', 'nodo']);
  f.i.controllo({ codice: 'manutenzione', attivo: true }); await f.i.scarica();
  assert.notEqual(inviati[0].incident.id, inviati[2].incident.id);
});
test('incidenti: anche sospensione molto breve invia avviso e chiusura', async t => {
  const inviati = []; const f = fixture(t, async p => { inviati.push(p.incident.status); return { stato: 'accettato' }; });
  f.i.controllo({ codice: 'manutenzione', attivo: true });
  f.i.controllo({ codice: 'manutenzione', attivo: false }); await f.i.scarica();
  assert.deepEqual(inviati, ['alert', 'resolved']);
});
test('incidenti: timeout/ack perso non autorizza retry automatico neppure al riavvio', async t => {
  let chiamate = 0; const f = fixture(t, async () => { chiamate++; throw new Error('risposta persa'); });
  f.i.controllo({ codice: 'manutenzione', attivo: true }); await f.i.scarica();
  f.riavvia(); await f.i.scarica(); assert.equal(chiamate, 1);
  assert.equal(f.i.stato().episodi[0].avviso, 'incerto');
});
test('incidenti: crash durante invio e risposta tardiva non usano il DB chiuso', async t => {
  let completa; const f = fixture(t, () => new Promise(r => { completa = r; }));
  f.i.controllo({ codice: 'manutenzione', attivo: true }); const attesa = f.i.scarica();
  assert.equal(f.i.stato().episodi[0].avviso, 'invio'); f.i.close();
  completa({ stato: 'accettato' }); await attesa; f.riavvia();
  assert.equal(f.i.stato().episodi[0].avviso, 'incerto');
});

test('incidenti: riconciliazione manuale di un avviso incerto chiude senza reinviare alert', async t => {
  const inviati = []; let perdi = true;
  const f = fixture(t, async p => {
    inviati.push(p.incident.status); if (perdi) throw new Error('ack perso'); return { stato: 'accettato' };
  });
  f.i.controllo({ codice: 'manutenzione', attivo: true }); await f.i.scarica();
  f.i.controllo({ codice: 'manutenzione', attivo: false }); const r = f.i.stato().episodi[0];
  await f.i.scarica(); assert.deepEqual(inviati, ['alert']);
  f.i.transazione(() => f.i.riconcilia(r.id, 'presente'));
  assert.equal(f.i.stato().episodi[0].avviso, 'riconciliato');
  perdi = false; await f.i.scarica(); assert.deepEqual(inviati, ['alert', 'resolved']);
  assert.equal(f.i.stato().episodi[0].risoluzione, 'accettato');
});

test('incidenti: chiusura già verificata nel provider non manda altri messaggi', async t => {
  const inviati = []; const f = fixture(t, async p => { inviati.push(p); return { stato: 'incerto' }; });
  f.i.controllo({ codice: 'manutenzione', attivo: true }); await f.i.scarica();
  const r = f.i.stato().episodi[0]; assert.throws(() => f.i.riconcilia(r.id, 'risolto'));
  f.i.controllo({ codice: 'manutenzione', attivo: false });
  f.i.transazione(() => f.i.riconcilia(r.id, 'risolto')); await f.i.scarica();
  assert.equal(inviati.length, 1); assert.equal(f.i.stato().episodi[0].risoluzione, 'riconciliata');
});

test('incidenti: riconciliazione ripetuta rifiutata non segnala un guasto SQLite', async t => {
  const f = fixture(t, async () => ({ stato: 'incerto' }));
  f.i.controllo({ codice: 'manutenzione', attivo: true }); await f.i.scarica();
  const id = f.i.stato().episodi[0].id;
  f.i.transazione(() => f.i.riconcilia(id, 'presente'));
  assert.throws(() => f.i.transazione(() => f.i.riconcilia(id, 'presente')), { status: 409 });
  assert.equal(f.i.stato().guasto, null);
});

test('incidenti: schema precedente migra senza perdere episodio o ricevuta', () => {
  const db = new DatabaseSync(':memory:'); let i;
  try {
    db.exec(`CREATE TABLE incidenti (id TEXT PRIMARY KEY, chiave TEXT NOT NULL, codice TEXT NOT NULL,
      nodo TEXT, fonte TEXT, aperto INTEGER NOT NULL, chiuso INTEGER, osservazione INTEGER,
      avviso TEXT NOT NULL, risoluzione TEXT NOT NULL, avviso_http INTEGER, risoluzione_http INTEGER);
      INSERT INTO incidenti VALUES('precedente','manutenzione::','manutenzione',NULL,NULL,10,NULL,NULL,
        'incerto','non_necessaria',NULL,NULL)`);
    i = creaIncidenti({ db, ora: () => 20 });
    i.transazione(() => i.riconcilia('precedente', 'presente'));
    assert.equal(i.stato().totale, 1);
    assert.equal(i.stato().episodi[0].aperto, 10);
    assert.equal(i.stato().episodi[0].avviso, 'riconciliato');
    assert.equal(i.stato().episodi[0].verificato, 20);
  } finally { i?.close(); db.close(); }
});

test('incidenti: retention non elimina mai un esito incerto o un episodio aperto', async t => {
  const f = fixture(t, async () => ({ stato: 'accettato' }));
  f.i.controllo({ codice: 'manutenzione', attivo: true }); await f.i.scarica();
  f.i.controllo({ codice: 'manutenzione', attivo: false }); await f.i.scarica();
  f.i.controllo({ codice: 'sospensione', nodo: 'prova', attivo: true });
  f.db.exec("UPDATE incidenti SET avviso='incerto' WHERE codice='sospensione'");
  f.avanti(8 * 86400000); f.i.controllo({ codice: 'manutenzione', attivo: true });
  assert.equal(f.i.stato().totale, 2);
  assert.equal(f.i.stato().episodi.find(r => r.codice === 'sospensione').avviso, 'incerto');
});
test('incidenti: vecchio episodio globale incerto resta consultabile dopo oltre 30 nuovi episodi', t => {
  const f = fixture(t);
  f.i.controllo({ codice: 'manutenzione', attivo: true });
  const id = f.i.stato().episodi[0].id;
  f.db.prepare("UPDATE incidenti SET avviso='incerto' WHERE id=?").run(id);
  f.i.controllo({ codice: 'manutenzione', attivo: false });
  for (let n = 0; n < 35; n++) { f.avanti(1); f.i.controllo({ codice: 'sospensione', nodo: 'n' + n, attivo: true }); }
  assert.equal(f.i.stato().pagine, 2);
  assert.equal(f.i.stato().episodi.some(r => r.id === id), false);
  assert.equal(f.i.stato(null, 2).episodi.some(r => r.id === id), true);
  assert.equal(f.i.stato('n1', 2).pagina, 1);
  f.i.transazione(() => f.i.riconcilia(id, 'risolto'));
  assert.equal(f.i.stato(null, 2).episodi.find(r => r.id === id).risoluzione, 'riconciliata');
});
test('Better Stack: URL protetta, niente redirect, segreto assente dalla ricevuta, 2xx non è consegna', async () => {
  for (const url of ['http://incidents.betterstack.com/api/v1/incoming-webhook/prova',
    'https://incidents.betterstack.com.evil.test/api/v1/incoming-webhook/prova',
    'https://incidents.betterstack.com/api/v1/incoming-webhook/prova?q=1',
    'https://user@incidents.betterstack.com/api/v1/incoming-webhook/prova']) assert.throws(() => validaWebhook(url));
  let cancellato = false;
  const invia = creaInvio({ url: 'https://incidents.betterstack.com/api/v1/incoming-webhook/sintetico',
    invia: async (_u, opts) => { assert.equal(opts.redirect, 'error'); assert.ok(opts.signal);
      return { ok: true, status: 202, body: { cancel: async () => { cancellato = true; } } }; } });
  assert.deepEqual(await invia({ incident: { id: 'prova' } }), { stato: 'accettato', http: 202 });
  assert.equal(cancellato, true); assert.equal(creaInvio({}), null);
});
test('Better Stack: rifiuto 4xx, 5xx e timeout restano distinti senza messaggi sensibili', async () => {
  const url = 'https://incidents.betterstack.com/api/v1/incoming-webhook/sintetico';
  for (const [status, stato] of [[403, 'fallito'], [429, 'fallito'], [503, 'incerto']]) {
    assert.deepEqual(await creaInvio({ url, invia: async () => ({ ok: false, status }) })({}), { stato, http: status });
  }
  assert.deepEqual(await creaInvio({ url, invia: async () => { throw new Error('segreto'); } })({}),
    { stato: 'incerto', http: null });
});
test('stato fonti: proiezione senza archivio e senza inventare una verifica', () => {
  const { statoFonti, valide } = require('../backend/nodi/stato-fonti-nodo');
  const salute = { fermo: () => ({ fermo: false, motivo: null }),
    stato: () => ({ guasto: null, archivio: 'non trasmettere', fonti: [{ fonte: 'subito', esito: 'ok', aggiornataIl: 12 }] }) };
  const f = statoFonti(salute); assert.equal(f.subito.esito, 'ok'); assert.equal(f.moto.esito, null);
  assert.equal(valide(f), true); assert.equal(JSON.stringify(f).includes('non trasmettere'), false);
  assert.equal(valide({ subito: { fermo: false, esito: 'dato personale' } }), false);
  salute.stato = () => ({ guasto: 'non trasmettere', fonti: [{ fonte: 'subito', esito: 'ok', aggiornataIl: 12 }] });
  assert.equal(statoFonti(salute).subito.esito, null);
});
