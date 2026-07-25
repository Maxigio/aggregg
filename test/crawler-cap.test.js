'use strict';
// M-C/2 — capForTarget PURO (profondità per-run). No rete, no DB: testa SOLO il clamp
// 'full'(9999)→tetto di sicurezza e il fallback F13. Difende l'anti-runaway: se un
// regress togliesse Math.min, un :run full crawlerebbe 9999 pagine e qui si rompe.
const { test } = require('node:test');
const assert = require('node:assert');
const { _capForTarget: cap } = require('../backend/crawler');

// stesse default del crawler (env non settato nei test)
const FULL = parseInt(process.env.CRAWLER_PAGES_FULL || '200', 10) || 200;
const DEEP = parseInt(process.env.CRAWLER_PAGES || '10', 10);
const DEEPMAX = parseInt(process.env.CRAWLER_PAGES_MAX || '30', 10);

test('capForTarget: maxPages clampato al tetto di sicurezza (full=9999 → FULL)', () => {
  assert.strictEqual(cap({ maxPages: 9999 }), FULL, "'full' clampa al safety cap");
  assert.strictEqual(cap({ maxPages: FULL + 100 }), FULL, 'sopra il tetto → tetto');
  assert.strictEqual(cap({ maxPages: 5 }), 5, 'sotto il tetto → passa intatto');
  assert.ok(cap({ maxPages: 9999 }) < 9999, 'mai 9999 pagine (anti-runaway)');
});

test('capForTarget: senza maxPages → default F13 (esteso se troncò)', () => {
  assert.strictEqual(cap({}), DEEP, 'nessun override → cap medio');
  assert.strictEqual(cap({ last_truncated: true }), DEEPMAX, 'troncò → cap esteso');
  assert.strictEqual(cap({ maxPages: 0 }), DEEP, '0 è falsy → default (NON zero pagine)');
});

// ── titleMatchesModel: guard anti-rumore su Subito (free-text) ────────────────
// Difende il fix del 2026-07-25: i token si ricavano dal nome GREZZO. Prima si
// splittava DOPO norm(), che ha già tolto i separatori → lo split non spezzava mai
// e il guard pretendeva il nome intero attaccato, scartando annunci veri (misurato:
// -80% sui risultati corretti di "Serie 3", -26% su "800MT").
const { _titleMatchesModel: matches } = require('../backend/crawler');

test('titleMatchesModel: modello multi-parola con token in ordine diverso → TIENE', () => {
  assert.ok(matches('Honda CRF 1000 L Africa Twin', 'Africa Twin CRF 1000L'));   // era scartato
  assert.ok(matches('Honda Africa Twin CRF 1000L ABS', 'Africa Twin CRF 1000L'));
  assert.ok(matches('BMW 1200 GS', 'R 1200 GS'));                                 // era scartato ("r1200gs")
  assert.ok(matches('BMW R1200GS Adventure', 'R 1200 GS'));
});

test('titleMatchesModel: accenti appianati, non trattati da separatore', () => {
  assert.ok(matches('Yamaha Tenere 700 Rally', 'Ténéré 700'));
  assert.ok(matches('Yamaha Ténéré 700', 'Tenere 700'));
});

test('titleMatchesModel: scarta ancora gli annunci di un altro modello', () => {
  assert.ok(!matches('Ducati Panigale V4', 'Monster 937'));
  assert.ok(!matches('Honda Hornet 600', 'Africa Twin CRF 1000L'));   // manca ogni token
});

test('titleMatchesModel: token mancante → scarta (serve TUTTI i token)', () => {
  assert.ok(!matches('Honda Africa Twin', 'Africa Twin CRF 1000L'));   // niente crf/1000l
});

test('titleMatchesModel: modelli mono-token invariati rispetto a prima', () => {
  assert.ok(matches('CFMOTO 800 MT Explore', '800MT'));
  assert.ok(!matches('CFMOTO MTX800', '800MT'));    // confine cifra/lettera NON spezzato: scelta prudente
  assert.ok(matches('Volkswagen Golf GTI', 'Golf'));
  assert.ok(matches('Mercedes SLK 200', '200'));    // rumore preesistente di Subito, non introdotto dal fix
});

test('titleMatchesModel: modello vuoto o di 1 carattere → nessun filtro (non azzerare la pesca)', () => {
  assert.ok(matches('Qualsiasi titolo', ''));
  assert.ok(matches('Qualsiasi titolo', 'X'));      // token len<2 scartato → nessun token → passa
  assert.ok(matches('Qualsiasi titolo', null));
});
