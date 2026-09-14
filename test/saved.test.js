'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isola la persistenza in una temp dir (saved.js usa USER_DATA_PATH).
process.env.USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-saved-'));
const saved = require('../backend/saved');

// Ogni ricerca salvata ha un padrone: qui e' sempre lo stesso, e le prove che contano
// sull'isolamento fra persone stanno in dati-per-persona.test.js.
const U = 'owner';
const R = (url, prezzo, extra = {}) => ({ url, prezzo, anno: 2018, km: 80000, titolo: 'BMW 320d', ...extra });

test('computeAlerts: primo check (baseline) non genera avvisi', () => {
  const { alerts } = saved.computeAlerts({ seen: {}, alerted: [] }, [R('a', 10000), R('b', 9000)]);
  assert.strictEqual(alerts.length, 0);
});

test('computeAlerts: floor anti-scam scarta il prezzo-spazzatura', () => {
  const search = { seen: { x: 10000 }, alerted: [] };   // seen non-vuoto → non baseline
  const results = [R('x', 10000), R('y', 9500), R('scam', 500)];
  const { alerts } = saved.computeAlerts(search, results);
  assert.ok(!alerts.some(a => a.url === 'scam'), 'lo scam 500 non deve generare avvisi');
});

test('computeAlerts: nuovo con km/anno mancante avvisa lo stesso (fix soppressione permanente)', () => {
  // prima: km/anno null → NIENTE avviso, ma recordCheck lo scriveva in seen → 'nuovo' perso per
  // sempre (Moto.it ha spesso km=null). Ora un annuncio nuovo con prezzo valido avvisa comunque.
  const search = { seen: { x: 10000 }, alerted: [] };   // baseline stabilita → non-baseline
  const noKm = saved.computeAlerts(search, [R('new1', 9000, { km: null })]);
  assert.strictEqual(noKm.alerts.length, 1, 'nuovo con km=null deve avvisare');
  assert.strictEqual(noKm.alerts[0].motivo, 'nuovo');
  const noAnno = saved.computeAlerts(search, [R('new2', 9000, { anno: null })]);
  assert.strictEqual(noAnno.alerts.length, 1, 'nuovo con anno=null deve avvisare');
});

test('computeAlerts: nuovo + calo', () => {
  const search = { seen: { old: 10000 }, alerted: [] };
  const results = [R('old', 9000), R('new1', 9500)];   // old: calo 10000→9000; new1: nuovo
  const { alerts } = saved.computeAlerts(search, results);
  const motivi = Object.fromEntries(alerts.map(a => [a.url, a.motivo]));
  assert.strictEqual(motivi.old, 'calo');
  assert.strictEqual(motivi.new1, 'nuovo');
});

test('computeAlerts: dedup via alerted (niente ri-notifica)', () => {
  const search = { seen: { old: 10000 }, alerted: ['new1|nuovo'] };
  const { alerts } = saved.computeAlerts(search, [R('new1', 9500)]);
  assert.strictEqual(alerts.length, 0);
});

test('fingerprint stabile a parità di risultati, diverso al cambio prezzo', () => {
  const a = saved.fingerprint([R('a', 10000), R('b', 9000)]);
  const b = saved.fingerprint([R('a', 10000), R('b', 9000)]);
  const c = saved.fingerprint([R('a', 10000), R('b', 8000)]);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('CRUD + recordCheck: baseline silenziosa, poi nuovo', () => {
  const s = saved.addSaved(U, { params: { tipo: 'auto', marca: 'BMW' } });
  assert.ok(s.id);
  const base = [R('a', 10000), R('b', 9000), R('c', 9500)];
  assert.strictEqual(saved.recordCheck(U, s.id, base).length, 0, 'baseline = 0 avvisi');
  const next = [...base, R('d', 8800)];
  const al = saved.recordCheck(U, s.id, next);
  assert.deepStrictEqual(al.map(a => a.motivo), ['nuovo']);
  assert.ok(saved.removeSaved(U, s.id));
});

/**
 * REGRESSIONE. Il re-accodamento proteggeva dal taglio FIFO solo gli URL PRESENTI nei
 * risultati del check corrente. Con una fonte in outage (torna [] senza lanciare) i suoi
 * annunci vivi restavano in testa a `seen` e, col cap pieno, venivano sfrattati: al ritorno
 * della fonte `prev` era null e scattava un falso "nuovo" su mezzi in lista da settimane.
 */
test('recordCheck: gli annunci di una fonte MUTA non vengono sfrattati da seen', () => {
  const s = saved.addSaved(U, { label: 'outage', params: { marca: 'BMW' } });
  const subito = 'https://www.subito.it/auto/bmw-320d-roma-1.htm';
  const as24   = 'https://www.autoscout24.it/annunci/bmw-320d-2.html';
  // Baseline: due annunci, uno per fonte.
  saved.recordCheck(U, s.id, [R(subito, 10000), R(as24, 11000)]);
  // Giro successivo: Autoscout e' giu' (nessun risultato suo) e arrivano 900 annunci
  // nuovi da Subito — piu' del cap di 800, quindi il taglio morde davvero.
  const valanga = Array.from({ length: 900 }, (_, i) => R(`https://www.subito.it/auto/x-${i}.htm`, 5000 + i));
  saved.recordCheck(U, s.id, [R(subito, 10000), ...valanga], { fontiMute: ['autoscout'] });
  const dopo = saved.getSaved(U, s.id);
  assert.ok(Object.prototype.hasOwnProperty.call(dopo.seen, as24),
    'l\'annuncio della fonte muta deve restare: non e\' "non visto", e\' "non verificabile"');
  // Senza dichiarare la fonte muta, invece, viene sfrattato: e' il comportamento di prima.
  const s2 = saved.addSaved(U, { label: 'outage2', params: { marca: 'BMW' } });
  saved.recordCheck(U, s2.id, [R(subito, 10000), R(as24, 11000)]);
  saved.recordCheck(U, s2.id, [R(subito, 10000), ...valanga]);
  assert.ok(!Object.prototype.hasOwnProperty.call(saved.getSaved(U, s2.id).seen, as24));
});

/**
 * TETTO PER PERSONA. Il numero di ricerche salvate non aveva nessun cap (a differenza di
 * seen/alerted/alerts, che i loro li hanno DENTRO la ricerca): un ciclo di POST /api/saved
 * faceva crescere il magazzino senza limite, e loadAll — sincrono, chiamato a ogni GET/check
 * e per tutte le persone in /api/saved/altri — bloccava l'event loop dell'intero server.
 */
/**
 * REGRESSIONE. `saveAll` apriva una transazione DEFERITA: leggeva l'elenco e solo dopo scriveva.
 * In WAL, se un'altra connessione committa fra quella lettura e la prima scrittura, SQLite
 * risponde SQLITE_BUSY_SNAPSHOT (517) SENZA passare dal busy handler — `busy_timeout` non
 * interviene e la scrittura muore all'istante. Il secondo scrittore non e' teorico:
 * `scripts/richieste.js --approva/--rifiuta/--revoca` gira via ssh sulla stessa macchina e
 * scrive nel registro dello stesso file, e quello che si perde e' il giro di un check gia'
 * addebitato sul tetto giornaliero.
 *
 * La finestra si centra da sola: `JSON.stringify` della ricerca avviene DENTRO saveAll, fra la
 * SELECT e il primo INSERT, quindi `toJSON` e' il momento esatto in cui l'altro deve scrivere.
 */
test('saveAll: un altro scrittore fra la lettura e la scrittura non fa cadere il salvataggio', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dbmod = require('../backend/utenti-db');
  const utente = 'scrittore-concorrente';
  const altro = new DatabaseSync(dbmod.percorso());
  altro.exec('PRAGMA busy_timeout = 0');   // se il lucchetto e' preso rinuncia subito: la prova non deve durare 3s
  let tentato = false, riuscito = false;
  const params = {
    tipo: 'auto', marca: 'BMW',
    toJSON() {
      if (!tentato) {
        tentato = true;
        try {
          altro.prepare('INSERT INTO registro (quando, evento) VALUES (?,?)').run(Date.now(), 'prova-concorrenza');
          riuscito = true;
        } catch (_) { /* il lucchetto di scrittura e' di chi sta salvando: e' quello che deve succedere */ }
      }
      return { tipo: 'auto', marca: 'BMW' };
    },
  };
  const s = saved.addSaved(utente, { label: 'concorrenza', params });
  altro.close();
  assert.ok(tentato, 'senza una scrittura nella finestra la prova non prova niente');
  assert.ok(!riuscito, 'con BEGIN IMMEDIATE il lucchetto e\' gia\' nostro: l\'altro scrittore aspetta');
  assert.ok(saved.getSaved(utente, s.id), 'la ricerca deve essere finita sul magazzino');
});

test('addSaved: oltre il tetto per persona si rifiuta con TROPPE_RICERCHE', () => {
  const MAX = saved._const.MAX_RICERCHE;
  const utente = 'tetto-test';                    // utente suo: non sporca i conteggi degli altri test
  for (let i = 0; i < MAX; i++) saved.addSaved(utente, { params: { tipo: 'auto', marca: `M${i}` } });
  assert.throws(() => saved.addSaved(utente, { params: { tipo: 'auto', marca: 'Troppa' } }),
    e => e.code === 'TROPPE_RICERCHE');
  // Il tetto non e' un vicolo cieco: tolta una, se ne puo' salvare un'altra.
  const prima = saved.listSaved(utente)[0];
  assert.ok(saved.removeSaved(utente, prima.id));
  const s = saved.addSaved(utente, { params: { tipo: 'auto', marca: 'DiNuovo' } });
  assert.ok(s.id);
  assert.strictEqual(saved.listSaved(utente).length, MAX);
});
