'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const salute = require('../backend/fonti-salute');
const now = Date.now;
let dir;
afterEach(() => { Date.now = now; salute._reset(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
function ambiente() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-ripartenza-'));
  process.env.USER_DATA_PATH = dir;
  salute._reset();
  let t = 2000000000000;
  Date.now = () => t;
  return { avanti: ms => { t += ms; }, scadi: fonte => { t = salute.fermo(fonte).fino + 1; } };
}
const limite = (fonte, retry) => salute.erroreHttp(fonte, 429, { 'retry-after': retry });

test('il primo 429 ferma soltanto quella fonte e un esito vecchio non riapre', async () => {
  ambiente();
  let finisci;
  const vecchia = salute.richiesta('subito', () => new Promise(r => { finisci = r; }));
  limite('subito');
  let chiamate = 0;
  await assert.rejects(salute.richiesta('subito', async () => { chiamate++; }), { code: 'FONTE_IN_PAUSA' });
  await salute.richiesta('autoscout', async () => { chiamate++; });
  finisci([]); await vecchia;
  salute.registra('subito', { conteggio: 5 });
  assert.equal(salute.fermo('subito').fermo, true);
  assert.equal(chiamate, 1);
});

test('Retry-After: secondi, data HTTP, valori invalidi e pausa lunga sopravvissuta al riavvio', () => {
  ambiente();
  assert.equal(salute.retryDopo('120'), Date.now() + 120000);
  assert.equal(salute.retryDopo(new Date(Date.now() + 120000).toUTCString()), Date.now() + 120000);
  for (const v of [undefined, '', '-1', '1.2', 'Infinity', '1e9', 'tomorrow', '0', '999999999999999999']) assert.equal(salute.retryDopo(v), null, String(v));
  limite('moto', '86400');
  const fine = Date.now() + 86400000;
  assert.equal(salute.fermo('moto').fino, fine);
  salute._reset();
  assert.equal(salute.fermo('moto').fino, fine, 'non tagliare Retry-After a sei ore');
});

test('la scadenza non dichiara disponibilità: ammette una sola verifica, anche con redirect', async () => {
  const tempo = ambiente();
  limite('subito'); tempo.scadi('subito');
  assert.equal(salute.fermo('subito').verifica, true);
  let finisci;
  const p = salute.richiesta('subito', async () => {
    await salute.richiesta('subito', async () => 'redirect consentito');
    return new Promise(r => { finisci = r; });
  });
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(salute.richiesta('subito', async () => assert.fail('seconda verifica')), { code: 'FONTE_IN_PAUSA' });
  finisci([]); await p;
  assert.equal(salute.fermo('subito').fermo, false);
  assert.equal(salute.fermo('subito').verifica, undefined);
});

test('la verifica fallita resta in pausa; un altro 429 aumenta la pausa', async () => {
  const tempo = ambiente();
  limite('autoscout'); tempo.scadi('autoscout');
  await assert.rejects(salute.richiesta('autoscout', async () => { throw limite('autoscout'); }), { status: 429 });
  assert.equal(salute.fermo('autoscout').fino - Date.now(), salute.FINESTRE[1]);
  tempo.scadi('autoscout');
  await assert.rejects(salute.richiesta('autoscout', async () => { throw new Error('JSON non valido'); }), /JSON/);
  assert.equal(salute.fermo('autoscout').fermo, true);
  assert.equal(salute.fermo('autoscout').verifica, false);
});

test('una risposta 429 concorrente impedisce il redirect di una richiesta già partita', async () => {
  ambiente();
  let continua;
  const attesa = new Promise(r => { continua = r; });
  const p = salute.richiesta('subito', async () => {
    await attesa;
    return salute.richiesta('subito', async () => assert.fail('redirect durante blocco'));
  });
  limite('subito'); continua();
  await assert.rejects(p, { code: 'FONTE_IN_PAUSA' });
});

test('nessun traffico periodico e stato di verifica conservato dopo riavvio', async () => {
  const tempo = ambiente();
  limite('moto'); tempo.scadi('moto'); salute._reset();
  assert.equal(salute.fermo('moto').verifica, true);
  assert.match(salute.avvisoPausa('moto'), /prossima richiesta/);
  await salute.richiesta('moto', async () => []);
  salute._reset();
  assert.equal(salute.fermo('moto').fermo, false);
});

test('un database precedente acquista solo la colonna tecnica e conserva la pausa', () => {
  ambiente();
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(salute.percorso());
  d.exec('CREATE TABLE salute (fonte TEXT PRIMARY KEY, esito TEXT NOT NULL, ferma_fino_a INTEGER, stop_fatti INTEGER NOT NULL, aggiornata_il INTEGER NOT NULL)');
  d.prepare('INSERT INTO salute VALUES (?,?,?,?,?)').run('subito', 'bloccato', Date.now() + 120000, 1, Date.now());
  d.close();
  assert.equal(salute.fermo('subito').fermo, true);
  assert.equal(salute.fermo('subito').fino, Date.now() + 120000);
  assert.equal(salute.guasto(), null);
});

test('gli annunci in cache restano intatti ma lo stato della pausa è quello attuale', () => {
  ambiente();
  const dati = { risultati: [{ url: 'https://fonte/1' }], sources: { subito: { status: 'ok', count: 1 } } };
  limite('subito');
  const risposta = salute.conStatoFonti(dati);
  assert.strictEqual(risposta.risultati, dati.risultati);
  assert.equal(risposta.sources.subito.pausa.fermo, true);
  assert.equal(dati.sources.subito.pausa, undefined);
  salute.azzera('subito');
  assert.equal(salute.conStatoFonti(dati).sources.subito.pausa.fermo, false);
});

test('i 403 dopo la pausa salgono di gradino una sola volta, anche con riepilogo esterno', async () => {
  const tempo = ambiente();
  const vietato = () => salute.erroreHttp('subito', 403);
  salute.registra('subito', { errore: vietato() });
  assert.equal(salute.fermo('subito').fermo, false);
  salute.registra('subito', { errore: vietato() });
  assert.equal(salute.fermo('subito').fino - Date.now(), salute.FINESTRE[0]);
  for (const finestra of [salute.FINESTRE[1], salute.FINESTRE[2]]) {
    tempo.scadi('subito');
    const errore = vietato();
    await assert.rejects(salute.richiesta('subito', async () => { throw errore; }), e => e === errore);
    const fine = salute.fermo('subito').fino;
    assert.equal(fine - Date.now(), finestra);
    salute.registra('subito', { errore });
    salute.registra('subito', { errore });
    assert.equal(salute.fermo('subito').fino, fine);
    salute._reset();
    assert.equal(salute.fermo('subito').fino, fine, 'la pausa effettiva sopravvive al riavvio');
  }
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(salute.percorso(), { readOnly: true });
  try { assert.equal(d.prepare("SELECT stop_fatti FROM salute WHERE fonte = 'subito'").get().stop_fatti, 3); }
  finally { d.close(); }
});

test('una sola verifica 403: concorrenti respinti e risposta vecchia riuscita non toglie la nuova pausa', async () => {
  const tempo = ambiente();
  let rispondiVecchia, respingiProva, chiamate = 0;
  const vecchia = salute.richiesta('subito', () => new Promise(r => { rispondiVecchia = r; }));
  limite('subito'); tempo.scadi('subito');
  const verifica = salute.richiesta('subito', () => {
    chiamate++;
    return new Promise((_, r) => { respingiProva = r; });
  });
  await assert.rejects(salute.richiesta('subito', async () => { chiamate++; }), { code: 'FONTE_IN_PAUSA' });
  const errore = salute.erroreHttp('subito', 403);
  respingiProva(errore);
  await assert.rejects(verifica, e => e === errore);
  salute.registra('subito', { errore });
  const fine = salute.fermo('subito').fino;
  assert.equal(fine - Date.now(), salute.FINESTRE[1]);
  rispondiVecchia([]); await vecchia;
  salute.registra('subito', { conteggio: 3 });
  assert.equal(salute.fermo('subito').fino, fine);
  assert.equal(chiamate, 1);
});

test('una verifica 503 o socket fallita conserva la pausa breve senza salire nella scala dei blocchi', async () => {
  const tempo = ambiente();
  limite('subito');
  for (const errore of [salute.erroreHttp('subito', 503), Object.assign(new Error('socket'), { kind: 'transient' })]) {
    tempo.scadi('subito');
    await assert.rejects(salute.richiesta('subito', async () => { throw errore; }), e => e === errore);
    salute.registra('subito', { errore });
    assert.equal(salute.fermo('subito').fino - Date.now(), salute.FINESTRE[0]);
  }
  tempo.scadi('subito');
  await salute.richiesta('subito', async () => []);
  assert.equal(salute.fermo('subito').fino, null);
});
