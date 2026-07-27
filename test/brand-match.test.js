'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeResolver, makeModelResolver } = require('../backend/scrapers/brand-match');

test('makeResolver: match esatto-normalizzato (case/accenti)', () => {
  const r = makeResolver([{ name: 'BMW', value: 'BMW' }, { name: 'Citroën', value: 'Citroen' }]);
  assert.strictEqual(r('bmw'), 'BMW');
  assert.strictEqual(r('Citroen'), 'Citroen');   // accento normalizzato
});

test('makeResolver: NIENTE contenimento (no falsi match cross-brand)', () => {
  const r = makeResolver([{ name: 'Marshal Moto', value: 'Marshal' }, { name: 'Arctic Cat', value: 'Arctic' }]);
  assert.strictEqual(r('Mars'), null);   // "Mars" NON deve risolvere "Marshal"
  assert.strictEqual(r('Arc'), null);    // "Arc" NON deve risolvere "Arctic Cat"
});

test('makeResolver: alias risolve alla canonica (forma storica a stringa)', () => {
  const r = makeResolver([{ name: 'Betamotor', value: 'Betamotor' }], { alias: { beta: 'Betamotor' } });
  assert.strictEqual(r('Beta'), 'Betamotor');
  assert.strictEqual(r('betamotor'), 'Betamotor');
});

// Il caso vero, che prima falliva: il gruppo ha per canonico un nome che la FONTE non usa.
// ["Beta","Betamotor"] con l'elenco di Moto.it che contiene solo "Betamotor": cercare la sola
// canonica dava null, e con essa spariva la scheda tecnica di quella marca.
test('makeResolver: prova TUTTE le grafie del gruppo, non solo la canonica', () => {
  const gruppo = ['Beta', 'Betamotor'];
  const r = makeResolver([{ name: 'Betamotor', value: 'slug-betamotor' }],
    { alias: { beta: gruppo, betamotor: gruppo } });
  assert.strictEqual(r('Beta'), 'slug-betamotor', 'la canonica non e\' fra i candidati: si prova l\'altra grafia');
  assert.strictEqual(r('Betamotor'), 'slug-betamotor');
  assert.strictEqual(r('Betamotoro'), null, 'una grafia inventata resta senza risposta');
});

test('loadAliasMap: torna il gruppo intero, e i gruppi reali risolvono sulla lista Moto.it', () => {
  const { loadAliasMap } = require('../backend/scrapers/brand-match');
  const m = loadAliasMap('moto');
  assert.ok(Array.isArray(m.beta), 'la mappa deve dare il gruppo, non una stringa');
  assert.strictEqual(m.beta[0], 'Beta', 'il canonico resta il primo del gruppo');

  // Regressione misurata il 2026-07-25: 8 gruppi su 10 non risolvevano su Moto.it.
  const { resolveMotoitSlug } = require('../backend/scrapers/motoit-brands');
  const attesi = {
    Beta: 'betamotor', Fantic: 'fantic-motor', 'Can-Am': 'can-am-brp', Keeway: 'keeway-motor',
    Mash: 'mash-italia', Mondial: 'fb-mondial', Benda: 'benda-motorcycles', Brixton: 'brixton-motorcycles',
  };
  for (const [nome, slug] of Object.entries(attesi)) {
    assert.strictEqual(resolveMotoitSlug(nome), slug, `${nome} non risolve piu'`);
  }
  assert.strictEqual(resolveMotoitSlug('Honda'), 'honda', 'le marche senza alias non devono cambiare');
  assert.strictEqual(resolveMotoitSlug('Marca Finta'), null, 'e una marca inesistente resta null');
});

test('makeModelResolver: esatto + prefix bidirezionale', () => {
  const r = makeModelResolver([{ name: '320', value: 'm320' }, { name: 'Alp 4.0', value: 'alp40' }]);
  assert.strictEqual(r('320'), 'm320');          // esatto
  assert.strictEqual(r('320d'), 'm320');         // prefix (query più lunga)
  assert.strictEqual(r('alp 4.0'), 'alp40');     // normalizzazione punteggiatura/spazi
  assert.strictEqual(r('zz'), null);             // <3 char / nessun match
});

/**
 * REGRESSIONE. L'alias veniva consultato PRIMA della corrispondenza esatta, quindi un nome
 * che esiste tale e quale veniva dirottato sul capogruppo. In data/models.json alcune marche
 * hanno DUE voci complementari — una coi codici Autoscout, una con gli slug Moto.it — e
 * dirottare significava perdere meta' dei dati:
 *   "KL Motors" (10 modelli con codice AS24) finiva su "Kl" (8 modelli, zero codici)
 *   "Vespa"     (marca a se', makeId 50404)  finiva su "Piaggio"
 * L'alias serve per le grafie che NON esistono fra i candidati, ed e' li' che deve agire.
 */
test('la corrispondenza esatta vince sull alias', () => {
  const candidati = [
    { name: 'Kl', value: 'moto-it' },
    { name: 'KL Motors', value: 'autoscout' },
    { name: 'TM', value: 'tm-autoscout' },
  ];
  const alias = { kl: ['KL', 'KL Motors'], klmotors: ['KL', 'KL Motors'], tmracing: ['TM', 'TM Racing'] };
  const r = makeResolver(candidati, { alias });
  assert.strictEqual(r('KL Motors'), 'autoscout', 'un nome che esiste deve dare se stesso');
  assert.strictEqual(r('Kl'), 'moto-it');
  // e l'alias continua a fare il suo mestiere quando la grafia chiesta non esiste
  assert.strictEqual(r('TM Racing'), 'tm-autoscout');
  assert.strictEqual(r('inesistente'), null);
});
