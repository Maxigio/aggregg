'use strict';
/**
 * IL PONTE DEI SOTTO-MODELLI (data/ponte-sottomodelli.json + backend/scrapers/subito-nodo.js)
 * — presidio che ESEGUE il risolutore, coi casi veri e coi refutati.
 *
 * Il file e' nato dal dossier del 2026-08-08: 454 candidati marca-sola letti uno a uno,
 * 422 accettati con prova, i refutati scritti. Qui si pretende che:
 *  1. OGNI voce del file risolva davvero (famiglia nell'indice, come dichiarato);
 *  2. i casi-pilota portino la famiglia GIUSTA (non una quasi giusta);
 *  3. i refutati NON risolvano: il giorno che uno risolve, qualcosa e' cambiato e va riletto;
 *  4. l'esatto nativo resti sopra il ponte (Vespa 125 GTS non passa dal file).
 */
const test = require('node:test');
const assert = require('node:assert');
const { risolviNodo } = require('../backend/scrapers/subito-nodo');
const ponte = require('../data/ponte-sottomodelli.json');

test('ogni voce del ponte risolve, con le famiglie del file e il come dichiarato', () => {
  let n = 0;
  for (const tipo of ['auto', 'moto']) {
    for (const [marca, voci] of Object.entries(ponte[tipo] || {})) {
      for (const [nome, v] of Object.entries(voci)) {
        const r = risolviNodo(tipo, marca, nome);
        assert.ok(r && r.famigliaId, `${tipo}/${marca}/${nome}: non risolve`);
        assert.ok(/^sotto-modello/.test(r.come), `${tipo}/${marca}/${nome}: come=«${r.come}», atteso sotto-modello`);
        assert.strictEqual((r.famigliaIds || []).length, v.famiglie.length,
          `${tipo}/${marca}/${nome}: ${r.famigliaIds.length} famiglie invece di ${v.famiglie.length}`);
        assert.strictEqual(r.famigliaNome, v.famiglie[0], `${tipo}/${marca}/${nome}: famiglia «${r.famigliaNome}»`);
        if (v.testo) assert.strictEqual(r.testo, v.testo, `${tipo}/${marca}/${nome}: testo`);
        assert.ok(v.prova && v.quando, `${tipo}/${marca}/${nome}: voce senza prova o data`);
        n++;
      }
    }
  }
  assert.ok(n >= 400, `attese >=400 voci, lette ${n}`);
});

test('i casi-pilota: 318, V 220, Cooper, V-Strom, Primavera — le famiglie giuste', () => {
  const r318 = risolviNodo('auto', 'BMW', '318');
  assert.strictEqual(r318.famigliaNome, 'Serie 3');
  assert.strictEqual(r318.testo, '318', 'il testo restringe la ricerca alla sigla');
  // V 220: il ramo parola-intera agganciava «Classe S (W/V220)» — il codice telaio.
  // Il ponte deve vincere su quell'euristica.
  const rV = risolviNodo('auto', 'Mercedes-Benz', 'V 220');
  assert.strictEqual(rV.famigliaNome, 'Classe V', `V 220 → «${rV.famigliaNome}» (${rV.come})`);
  // Cooper: non solo l'elettrica «Mini Cooper AE» — unione con la famiglia «Mini»
  const rC = risolviNodo('auto', 'Mini', 'Cooper');
  assert.strictEqual(rC.famigliaNome, 'Mini');
  assert.strictEqual((rC.famigliaIds || []).length, 2, 'Cooper = benzina + elettrica');
  assert.ok(/^sotto-modello/.test(risolviNodo('moto', 'Suzuki', 'V-Strom 650').come));
  assert.strictEqual((risolviNodo('moto', 'Piaggio', 'Primavera').famigliaIds || []).length, 5);
});

test('i refutati NON risolvono: un id quasi giusto e\' peggio del testo libero', () => {
  for (const [tipo, marca, nome] of [
    ['auto', 'Alfa Romeo', '1750'],      // il catalogo aggancerebbe il MOTORE 1750 TBi della 159
    ['auto', 'Fiat', '124 Coupè'],       // la famiglia «Coupé» e' la Coupé del '93
    ['auto', 'Fiat', '1100'],            // il motore 1100 della Panda
    ['moto', 'Piaggio', 'Si'],           // il ciclomotore Si vs versioni «S i.e.» dei Beverly
    ['moto', 'MV Agusta', '98'],         // ambigua: la 98 del '46 vs la Superveloce «98»
    ['moto', 'Honda', 'CR 125'],         // la famiglia «@ 125» (scooter @) aggancerebbe qualsiasi 125
  ]) {
    const r = risolviNodo(tipo, marca, nome);
    assert.ok(!r || !r.famigliaId, `${marca}/${nome}: risolve «${r && r.famigliaNome}» (${r && r.come}) — refutato che e' tornato vivo, va riletto`);
  }
});

test('l\'esatto nativo resta sopra il ponte, e la tendina eredita il ponte', () => {
  assert.strictEqual(risolviNodo('moto', 'Piaggio', 'Vespa 125 GTS').come, 'famiglia');
  const { versioniDi } = require('../backend/versioni-menu');
  const v = versioniDi('auto', 'BMW', '318');
  assert.ok(v.length >= 10, 'attese le versioni 318 via ponte: ' + v.length);
  // i trim estratti dopo il marcatore CV non ripetono la sigla («Msport»): il divieto
  // vero e' sulle SORELLE — niente 316/320/330 nella tendina della 318
  assert.ok(!v.some(x => /\b(?:316|320|323|325|328|330|335|340)(?=[a-z]|\b)/i.test(x)),
    'la 318 non deve suggerire le sorelle: ' + v.filter(x => /\b(?:316|320|325|330)/.test(x)).slice(0, 3).join(' | '));
});
