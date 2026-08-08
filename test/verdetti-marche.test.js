'use strict';
/**
 * IL PRESIDIO DEL CASO VESPA — la regola, non la pezza.
 *
 * Il difetto (2026-08-08): 4.093 nomi del menu non risolvevano NEMMENO LA MARCA su Subito
 * e cadevano a testo libero senza che nessuno se ne accorgesse — Vespa compresa, le cui 75
 * famiglie vivono sotto PIAGGIO. Tre giri di analisi automatica non l'avevano visto perche'
 * si misurava il perimetro dei fix, non il fenomeno.
 *
 * La regola che questo file difende ESEGUENDO il codice (niente regex sul sorgente):
 * ogni marca del menu o risolve la marca su Subito, o ha un VERDETTO esplicito in
 * data/verdetti-marche-subito.json (ospite | rinominata | assorbita | rebadge | pseudo |
 * assente | ignota), con la sua prova. Una marca nuova senza verdetto = questo test rosso
 * = il caso Vespa non puo' piu' passare inosservato.
 */
const test = require('node:test');
const assert = require('node:assert');
const { risolviNodo } = require('../backend/scrapers/subito-nodo');
const models = require('../data/models.json');
const verdetti = require('../data/verdetti-marche-subito.json');
const ponte = require('../data/ponte-marche-ospiti.json');

const VERDETTI_VALIDI = new Set(['ospite', 'rinominata', 'assorbita', 'rebadge', 'pseudo', 'assente', 'ignota']);

test('ogni marca del menu risolve su Subito o ha un verdetto — il test che mancava a Vespa', () => {
  const buchi = [];
  for (const tipo of ['auto', 'moto']) {
    for (const marca of Object.keys(models[tipo])) {
      const risolta = !!risolviNodo(tipo, marca, '');
      const voce = (verdetti[tipo] || {})[marca];
      if (!risolta && !voce) buchi.push(`${tipo} ${marca}`);
      if (voce) {
        assert.ok(VERDETTI_VALIDI.has(voce.verdetto), `${tipo} ${marca}: verdetto sconosciuto "${voce.verdetto}"`);
        assert.ok(voce.prova && voce.prova.length > 10, `${tipo} ${marca}: verdetto senza prova`);
      }
    }
  }
  assert.deepStrictEqual(buchi, [], 'marche senza risoluzione E senza verdetto: ' + buchi.join(', '));
});

test('il ponte degli ospiti funziona sul catalogo VERO: ogni voce risolve almeno un nome del menu', () => {
  for (const tipo of ['auto', 'moto']) {
    for (const [marca, voce] of Object.entries(ponte[tipo] || {})) {
      // l'ospitante deve esistere come marca
      const host = risolviNodo(tipo, voce.ospite, '');
      assert.ok(host && host.marcaId, `${marca}: l'ospite "${voce.ospite}" non risolve su Subito`);
      // e almeno un modello del menu della marca ospitata deve raggiungere una famiglia:
      // una voce che non aggancia niente e' una riga morta che nessuno rileggera' mai
      const nomi = ((models[tipo] || {})[marca] || {}).models || [];
      const agganciati = nomi.filter(m => {
        const r = risolviNodo(tipo, marca, m.nome);
        return r && r.famigliaId && /^ospite \(/.test(r.come);
      });
      assert.ok(agganciati.length >= 1, `${marca} sotto ${voce.ospite}: nessun nome del menu aggancia una famiglia`);
    }
  }
});

test('ospite: mai la marca sola, mai un id quasi giusto, un salto solo', () => {
  // modello ignoto dentro l'ospite → null (testo libero), non la marca dell'ospitante
  assert.strictEqual(risolviNodo('moto', 'Vespa', 'Modello Che Non Esiste'), null);
  // marca ospitata senza modello → null: sotto Piaggio ci sono 75 famiglie Vespa E tutto il resto
  assert.strictEqual(risolviNodo('moto', 'Vespa', ''), null);
  // il caso guida, sul catalogo vero
  const r = risolviNodo('moto', 'Vespa', '125 GTS');
  assert.ok(r && r.famigliaId, 'Vespa 125 GTS deve risolvere');
  assert.match(r.come, /^ospite \(Vespa sotto /);
});

test('i refutati NON stanno nel ponte: i cloni e gli omonimi restano fuori', () => {
  // Skyteam fa CLONI delle Honda: mappare mostrerebbe l'originale al posto del clone.
  // REX RS 125 e' uno scooter omonimo della sportiva Aprilia. Se qualcuno li aggiunge,
  // questo test glielo chiede a voce alta.
  for (const rifiutata of ['Skyteam', 'REX', 'E.-ATV', 'Dangel']) {
    for (const tipo of ['auto', 'moto']) {
      assert.ok(!(ponte[tipo] || {})[rifiutata], `${rifiutata} e' refutata: non puo' stare nel ponte (${tipo})`);
    }
  }
  assert.strictEqual(risolviNodo('moto', 'Skyteam', 'Monkey 125'), null, 'il clone non deve mappare sull\'originale');
});

test('pseudo-marche: la categoria non e\' una marca, e Subito non si interroga (decisione 2026-08-08)', () => {
  const { marcaPseudo } = require('../backend/scrapers/subito-nodo');
  // le tre ereditate da Autoscout nel catalogo auto + le sorelle moto trovate dai verdetti
  for (const [tipo, marca] of [['auto', 'Oldtimer'], ['auto', 'Caravans-Wohnm'], ['auto', 'Trucks-Lkw'],
                               ['moto', 'Trike'], ['moto', 'Pocket Bike'], ['moto', 'Chinabike']]) {
    assert.strictEqual(marcaPseudo(tipo, marca), true, `${marca} deve essere pseudo`);
  }
  // una marca vera non deve MAI finire nel ramo pseudo: sarebbe una fonte spenta in silenzio
  for (const [tipo, marca] of [['auto', 'Fiat'], ['moto', 'Vespa'], ['moto', 'Ducati']]) {
    assert.strictEqual(marcaPseudo(tipo, marca), false, `${marca} non e' pseudo`);
  }
});

test('cio\' che sites dichiara deve essere raggiungibile — il test che avrebbe trovato Talaria', () => {
  // Moto.it: ogni marca con 'motoit' in sites risolve uno slug (harvest ∪ catalogo ∪ aggiunte).
  // Talaria dichiarava motoit con 5 slug-modello validi, ma lo slug marca ('talaria-moto')
  // non stava in nessun file: la scheda diceva «marca non su Moto.it» coi dati in casa.
  const { resolveMotoitSlug } = require('../backend/scrapers/motoit-brands');
  const senzaSlug = [];
  for (const [marca, v] of Object.entries(models.moto)) {
    if (!(v.sites || []).includes('motoit')) continue;
    if (!resolveMotoitSlug(marca)) senzaSlug.push(marca);
  }
  assert.deepStrictEqual(senzaSlug, [], 'marche dichiarate motoit senza slug: ' + senzaSlug.join(', '));

  // Gemello AS24: ogni modello che dichiara 'autoscout' raggiunge un id. La query usa
  // mmmvAutoscout (misurato: modelIdAS non e' consumato da nessuno a runtime — il Diavel
  // V4 senza modelIdAS ma con mmmv e' un non-difetto, ed e' esattamente questo il motivo).
  const orfani = [];
  for (const tipo of ['auto', 'moto']) {
    for (const [marca, v] of Object.entries(models[tipo])) {
      for (const m of (v.models || [])) {
        if (!(m.sites || []).includes('autoscout')) continue;
        if (!m.mmmvAutoscout && !(v.autoscout && v.autoscout.makeId)) orfani.push(`${marca} ${m.nome}`);
      }
    }
  }
  assert.deepStrictEqual(orfani, [], 'modelli dichiarati autoscout senza alcun id: ' + orfani.join(', '));
});

/**
 * IL RAMO DELLE PAROLE COI RESTI NUMERICI, provato con un indice iniettato: ogni caso qui
 * sotto e' uno letto per davvero durante la misura, compresi i falsi che la regola esclude.
 */
const INDICE_PROVA = {
  auto: {},
  moto: {
    Piaggio: {
      id: '1', famiglie: [
        { id: 'a', nome: 'Vespa 125 Primavera', gen: [] },
        { id: 'b', nome: 'Vespa 50 Primavera', gen: [] },
        { id: 'c', nome: 'Vespa Primavera Elettrica 45', gen: [] },
        { id: 'd', nome: 'Vespa Elettrica', gen: [] },
        { id: 'e', nome: 'Vespa 125 GTS', gen: [] },
      ],
    },
    BMW: {
      id: '2', famiglie: [
        { id: 'f', nome: 'R 1200 R', gen: [] },
        { id: 'g', nome: 'R 1200 GS', gen: [] },
        { id: 'h', nome: 'R 60/5', gen: [] },
      ],
    },
  },
};

test('parole: il nome girato trova la famiglia («GTS 125» → «Vespa 125 GTS»)', () => {
  const r = risolviNodo('moto', 'Piaggio', 'Vespa GTS 125', { indice: INDICE_PROVA });
  assert.ok(r && r.famigliaNome === 'Vespa 125 GTS', 'atteso Vespa 125 GTS, avuto ' + (r && r.famigliaNome));
});

test('parole: la linea prende le cilindrate (resti numerici) E le varianti del prefisso, in unione', () => {
  const r = risolviNodo('moto', 'Piaggio', 'Vespa Primavera', { indice: INDICE_PROVA });
  assert.ok(r, 'Primavera deve risolvere');
  const nomi = new Set([r.famigliaNome, ...(r.generazioni || []).map(() => null)]);
  // le due classiche (parole: resto numerico) + l'Elettrica (prefisso), non di meno
  assert.strictEqual((r.famigliaIds || []).length, 3, 'attese 3 famiglie (125, 50, Elettrica 45), avute ' + (r.famigliaIds || []).length);
  void nomi;
});

test('parole: il resto NON numerico e\' un altro modello e resta fuori («Elettrica» non prende le Primavera)', () => {
  const r = risolviNodo('moto', 'Piaggio', 'Vespa Elettrica', { indice: INDICE_PROVA });
  assert.ok(r && r.famigliaNome === 'Vespa Elettrica');
  assert.strictEqual((r.famigliaIds || []).length, 1, 'Vespa Elettrica soltanto: Primavera Elettrica e\' un\'altra moto');
});

test('parole: il multinsieme conta le ripetizioni («R 1200 R» non prende «R 1200 GS»)', () => {
  const r = risolviNodo('moto', 'BMW', 'R 1200 R', { indice: INDICE_PROVA });
  assert.ok(r && r.famigliaNome === 'R 1200 R');
  assert.strictEqual((r.famigliaIds || []).length, 1, 'la seconda R va trovata anche lei: GS fuori');
});

test('parole: soli token monocarattere non agganciano («R 5» non e\' la «R 60/5»)', () => {
  const r = risolviNodo('moto', 'BMW', 'R 5', { indice: INDICE_PROVA });
  assert.ok(!r || !r.famigliaId, 'R 5 deve restare senza famiglia (marca sola o null), avuto ' + (r && r.famigliaNome));
});
