'use strict';
/**
 * LE ROTTE DI COMPETITOR — quelle che si possono provare senza rete.
 *
 * `POST /api/competitor/da-annuncio` mette in elenco il venditore di un annuncio partendo
 * dal suo id, che l'annuncio porta gia': niente link da incollare, niente richieste. E'
 * l'unica delle sette che non tocca nessuna fonte, quindi e' anche l'unica che si puo'
 * sorvegliare per davvero.
 *
 * ISOLAMENTO: `filePath()` di competitor.js legge USER_DATA_PATH a OGNI chiamata, quindi
 * basta puntarlo a una cartella temporanea per non sfiorare ne' data/competitor.json ne'
 * quello di produzione. (Lezione imparata a mani nude: una prova scritta senza questa
 * accortezza aveva davvero aggiunto una voce finta all'elenco vero.)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const route = require('../backend/competitor-route');

/** Un finto `app` che tiene gli handler, e le risposte finte per leggerne l'esito. */
function monta() {
  const H = {};
  const app = {
    get: (p, ...h) => { H['GET ' + p] = h[h.length - 1]; },
    post: (p, ...h) => { H['POST ' + p] = h[h.length - 1]; },
    delete: (p, ...h) => { H['DELETE ' + p] = h[h.length - 1]; },
  };
  route.mount(app, { json: (req, res, next) => next() });
  return H;
}
function resFinta() {
  const r = { code: 200, body: null };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.set = () => r;
  return r;
}
/**
 * Esegue un handler in una cartella dati usa-e-getta.
 * Il magazzino si CHIUDE a ogni cambio di cartella: resta aperto sul file di prima, e senza
 * questa riga la prova successiva scriverebbe nella cartella sbagliata.
 */
const dbmod = require('../backend/utenti-db');
async function conCartellaPulita(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-cp-'));
  const prima = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  dbmod.chiudi();
  try { return await fn(); }
  finally {
    dbmod.chiudi();
    if (prima === undefined) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = prima;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('da-annuncio: il venditore entra in elenco col suo id, senza link e senza richieste', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    const res = resFinta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'autoscout', id: '7008', nome: 'Stemar Snc' } }, res);
    assert.strictEqual(res.code, 200);
    const v = res.body.voce;
    assert.strictEqual(v.fonte, 'autoscout');
    assert.strictEqual(v.id, '7008');
    assert.strictEqual(v.nome, 'Stemar Snc');
    // L'anagrafica non la conosciamo: l'annuncio non porta il link della vetrina. Si dice
    // null invece di inventarla, e `schedaLetta` resta true perche' non c'e' niente da rileggere.
    assert.strictEqual(v.url, null);
    assert.strictEqual(v.schedaLetta, true);
    assert.strictEqual(v.daAnnuncio, true, 'com\'e\' entrata in elenco deve restare scritto');
    // E finisce davvero su disco, non solo nella risposta.
    const lista = resFinta();
    H['GET /api/competitor']({}, lista);
    assert.deepStrictEqual(lista.body.voci.map(x => x.fonte + ':' + x.id), ['autoscout:7008']);
  });
});

test('da-annuncio: lo stesso venditore due volte e\' 409, non un doppione', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '105412305', nome: 'FC AUTO SRL' } }, resFinta());
    const due = resFinta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '105412305' } }, due);
    assert.strictEqual(due.code, 409);
    assert.match(due.body.error, /gia'/);
    assert.strictEqual(due.body.voce.nome, 'FC AUTO SRL', 'il 409 rimanda la voce che c\'era gia\'');
    const lista = resFinta();
    H['GET /api/competitor']({}, lista);
    assert.strictEqual(lista.body.voci.length, 1, 'in elenco deve restarne una sola');
  });
});

/**
 * CHI E' GIA' IN ELENCO SI RICONOSCE PRIMA DI CHIEDERLO ALLA FONTE — anche su Moto.it.
 *
 * Qui non si monta una rotta: si ESEGUE il codice vero di frontend/app.js, perche' la
 * guardia sta li'. `vetrinaHTML` offre "Aggiungi" solo a chi in elenco non c'e', e il
 * confronto e' `fonte`+`id`. Per Moto.it quei due campi non c'erano: il confronto era
 * sempre falso, il bottone compariva anche sul concessionario che si stava gia' guardando
 * e ogni clic passava da POST /api/competitor → `risolviVetrina` → una GET vera a
 * dealer.moto.it, per sentirsi poi rispondere 409. Subito e Autoscout la guardia
 * ce l'avevano gia': questa e' la terza fonte.
 */
const APP = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
/** Ritaglia dal sorgente i blocchi chiesti e li esegue con i pochi globali che usano. */
function daApp(blocchi, globali, coda = 'return { competitorDaAnnuncio, vetrinaHTML };') {
  const pezzi = blocchi.map(([da, finoA]) => {
    const i = APP.indexOf(da);
    assert.ok(i > 0, `non trovo piu' \`${da}\` in frontend/app.js`);
    const j = APP.indexOf(finoA, i);
    assert.ok(j > i, `non trovo piu' la fine del blocco \`${da}\``);
    return APP.slice(i, j);
  });
  const chiavi = Object.keys(globali);
  const corpo = pezzi.join('\n') + '\n' + coda;
  return new Function(...chiavi, corpo)(...chiavi.map(k => globali[k]));
}

test('moto: la vetrina gia\' in elenco si riconosce a schermo, senza una richiesta a dealer.moto.it', () => {
  const cpVoci = [
    { fonte: 'moto', id: 'nikomoto', nome: 'Niko Moto', url: 'https://dealer.moto.it/nikomoto' },
    { fonte: 'subito', id: '105412305', nome: 'FC AUTO SRL' },
  ];
  const { competitorDaAnnuncio, vetrinaHTML } = daApp([
    ['function competitorDaAnnuncio(r)', '\n/** Mette il venditore'],
    ['function vetrinaHTML(r)', '\n// ── Passaggio'],
  ], { escapeHtml: s => String(s), cpVoci });

  const moto = {
    fonte: 'moto', venditore: 'concessionario', venditoreNome: 'Niko Moto',
    vetrinaUrl: 'https://dealer.moto.it/nikomoto',
  };
  const cp = competitorDaAnnuncio(moto);
  // L'id di una vetrina Moto.it e' il suo slug: lo stesso che il server salva (motoit-vetrina).
  assert.strictEqual(cp.fonte, 'moto');
  assert.strictEqual(cp.id, 'nikomoto');
  // E si continua ad aggiungere dall'url: e' l'unico campo che POST /api/competitor legge,
  // ed e' quello che sceglie la porta (con l'url non si passa da `da-annuncio`).
  assert.strictEqual(cp.url, 'https://dealer.moto.it/nikomoto');

  assert.match(vetrinaHTML(moto), /det-open-gia/, 'la vetrina in elenco deve dirsi gia\' presa');
  assert.ok(!/btn-competitor/.test(vetrinaHTML(moto)),
    'il bottone su un concessionario gia\' in elenco costa una GET a dealer.moto.it per un 409');
  // Una vetrina che in elenco NON c'e' il bottone lo deve avere ancora.
  const altra = { ...moto, venditoreNome: 'Altro Moto', vetrinaUrl: 'https://dealer.moto.it/altromoto' };
  assert.match(vetrinaHTML(altra), /btn-competitor/);
  // Le sottopagine portano allo stesso slug: `slugVetrina` accetta /Usato, e la voce in
  // elenco e' una sola — il confronto deve cadere sulla stessa chiave.
  assert.strictEqual(competitorDaAnnuncio({ ...moto, vetrinaUrl: 'https://dealer.moto.it/nikomoto/Usato' }).id, 'nikomoto');
  // Un link che non e' una vetrina non inventa un id: nessuna chiave falsa in confronto.
  assert.strictEqual(competitorDaAnnuncio({ ...moto, vetrinaUrl: 'https://www.moto.it/nikomoto' }).id, null);
});

/**
 * REGRESSIONE. Il bottone «vetrina ↗» della scheda era l'unico incondizionato, ma le voci
 * entrate da `da-annuncio` hanno `url: null` per costruzione (l'annuncio porta l'id del
 * venditore, non il link della vetrina): `escapeHtml(null)` da' la stringa "null", e
 * l'href diventava un percorso relativo sull'origine dell'app. Anche qui si esegue il
 * codice vero di frontend/app.js, perche' la guardia sta li'.
 */
test('competitor: la scheda di una voce senza url non mostra il bottone della vetrina', () => {
  const { cpSchedaHTML } = daApp([
    ['function cpSchedaHTML(v)', '\n/**\n * IL PROFILO UNICO'],
  ], {
    escapeHtml: s => String(s),
    cpChiave: v => v.fonte + ':' + v.id,
    cpParchi: {},
    cpApertoId: null,
    cpAperte: new Set(),
    cpUnisciHTML: () => '',
    cpNumeriChiave: () => '',
    cpOrariHTML: () => '',
    miniHTML: () => '',
    FONTE_LABEL: { subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it' },
  }, 'return { cpSchedaHTML };');

  // La voce esatta che POST /api/competitor/da-annuncio scrive su disco.
  const senzaUrl = {
    fonte: 'subito', id: '105412305', nome: 'FC AUTO SRL',
    dove: null, via: null, url: null, schedaLetta: true, daAnnuncio: true,
  };
  const html = cpSchedaHTML(senzaUrl);
  assert.ok(!/href="null"/.test(html), 'un href "null" e\' un percorso relativo sull\'origine dell\'app');
  assert.ok(!/cp-link/.test(html), 'senza url il bottone della vetrina non deve comparire affatto');
  // Le voci da link incollato (e quelle Moto.it) l'url ce l'hanno: il bottone resta.
  const conUrl = { ...senzaUrl, url: 'https://www.subito.it/concessionari/fc-auto-srl' };
  assert.match(cpSchedaHTML(conUrl), /class="cp-btn cp-link" href="https:\/\/www\.subito\.it\/concessionari\/fc-auto-srl"/);
});

test('da-annuncio: fonte e id sono controllati, e senza nome se ne mette uno leggibile', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    // Moto.it non passa di qui: la sua vetrina e' un link, e la porta di sempre lo risolve.
    for (const body of [{ fonte: 'moto', id: '7008' }, { fonte: '', id: '7008' }, { fonte: 'pippo', id: '1' }]) {
      const r = resFinta();
      await H['POST /api/competitor/da-annuncio']({ body }, r);
      assert.strictEqual(r.code, 400, `fonte "${body.fonte}" doveva essere rifiutata`);
    }
    // L'id finisce in una chiave e in una query: si accettano solo cifre.
    for (const id of ['abc', "1' or 1=1", '../../etc', '', '1234567890123456']) {
      const r = resFinta();
      await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id } }, r);
      assert.strictEqual(r.code, 400, `id ${JSON.stringify(id)} doveva essere rifiutato`);
    }
    // Senza nome non si scrive "undefined": si mette qualcosa che si legge.
    const senzaNome = resFinta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '999' } }, senzaNome);
    assert.strictEqual(senzaNome.code, 200);
    assert.match(senzaNome.body.voce.nome, /Venditore Subito 999/);
  });
});

/**
 * REGRESSIONE. A file corrotto leggi() risponde [] — e il primo POST riscriveva il file
 * partendo da quel vuoto, rendendo definitiva una perdita che era ancora recuperabile a
 * mano. Ora chi scrive controlla leggi.ultimoErrore e risponde 503 senza toccare il disco.
 */
test('elenco corrotto: le scritture rispondono 503 e il file resta byte per byte com\'era', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    // Il magazzino, non piu' il vecchio competitor.json: quello resta come archivio e si
    // importa una volta sola. Si chiude prima, perche' il guasto che conta e' quello che si
    // trova all'APERTURA — server riavviato, volume rimontato male.
    const p = dbmod.percorso();
    const rotto = 'questo non e\' un database';
    dbmod.chiudi();
    fs.writeFileSync(p, rotto);
    const r = resFinta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '42', nome: 'X' } }, r);
    assert.strictEqual(r.code, 503);
    assert.strictEqual(r.body.corrotto, true);
    assert.match(r.body.error, /illeggibile/);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), rotto, 'il file corrotto NON va sovrascritto');
    // E chi legge lo viene a sapere: elenco vuoto per guasto ≠ elenco vuoto davvero.
    const lista = resFinta();
    H['GET /api/competitor']({}, lista);
    assert.ok(lista.body.erroreElenco, 'la GET deve dichiarare il guasto');
  });
});

/**
 * REGRESSIONE. Le due rotte di LETTURA del parco affermavano un fatto sull'elenco senza
 * averlo letto: a magazzino illeggibile leggi() risponde [], e la scheda di una vetrina in
 * elenco da mesi rispondeva 404 «non e' nell'elenco», il gruppo 404 «gruppo vuoto». Il
 * guasto restava scritto solo nel log, e per giunta il 404 bugiardo era ADDEBITATO: sei
 * clic bruciavano il budget e dal settimo arrivava un 429 che mascherava il guasto una
 * seconda volta. Le rotte di scrittura quel controllo ce l'avevano gia' (503 + corrotto).
 */
test('parco a magazzino illeggibile: 503 invece di «non e\' nell\'elenco», e senza bruciare il budget', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '7008', nome: 'Sub' } }, resFinta());
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'autoscout', id: '2', nome: 'As' } }, resFinta());
    const unione = resFinta();
    H['POST /api/competitor/:id/gruppo']({ params: { id: 'subito:7008' }, body: { con: 'autoscout:2' } }, unione);
    assert.strictEqual(unione.code, 200);
    const g = unione.body.gruppo;

    // Magazzino sano: una chiave che in elenco non c'e' DEVE restare un 404 (niente rete:
    // la voce non si trova e lo scarico non parte).
    const assente = resFinta();
    await H['GET /api/competitor/:id/parco']({ params: { id: 'subito:999' }, query: {} }, assente);
    assert.strictEqual(assente.code, 404);

    // Ora il magazzino non si apre piu'.
    const p = dbmod.percorso();
    dbmod.chiudi();
    fs.writeFileSync(p, 'questo non e\' un database');

    // Dieci clic: tutti 503. Se il guasto fosse ancora addebitato, dal settimo la risposta
    // diventerebbe 429 — il budget e' sei ogni dieci minuti.
    for (let i = 0; i < 10; i++) {
      const r = resFinta();
      await H['GET /api/competitor/:id/parco']({ params: { id: 'subito:7008' }, query: {} }, r);
      assert.strictEqual(r.code, 503, `clic ${i + 1}: la vetrina e' in elenco, il magazzino e' rotto`);
      assert.strictEqual(r.body.corrotto, true);
      assert.match(r.body.error, /illeggibile/);
    }
    const gruppo = resFinta();
    await H['GET /api/competitor/gruppo/:g/parco']({ params: { g }, query: {} }, gruppo);
    assert.strictEqual(gruppo.code, 503, '«gruppo vuoto» su un gruppo che non si e\' potuto leggere e\' una bugia');
    assert.match(gruppo.body.error, /illeggibile/);
  });
});

/**
 * REGRESSIONE. Le rotte indirizzavano per solo id, ma Subito e Autoscout numerano ognuno
 * per conto suo: con una collisione si serviva il parco del venditore sbagliato e DELETE
 * toglieva due voci. La chiave e' `fonte:id`, la stessa dei POST e della cache.
 */
test('collisione di id fra fonti: la chiave composta indirizza la voce giusta, DELETE ne toglie una', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '7008', nome: 'Sub' } }, resFinta());
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'autoscout', id: '7008', nome: 'As' } }, resFinta());
    // DELETE con la chiave composta toglie SOLO quella voce.
    const del = resFinta();
    H['DELETE /api/competitor/:id']({ params: { id: 'autoscout:7008' } }, del);
    assert.strictEqual(del.code, 200);
    assert.strictEqual(del.body.tolti, 1, 'una voce sola, non tutte quelle con quell\'id');
    const lista = resFinta();
    H['GET /api/competitor']({}, lista);
    assert.deepStrictEqual(lista.body.voci.map(x => x.fonte + ':' + x.id), ['subito:7008']);
  });
});

/**
 * REGRESSIONE, di schermo. `cpTogli` buttava via l'esito della DELETE: a magazzino
 * illeggibile il server risponde 503 e NON scrive, ma la scheda spariva lo stesso dal
 * pannello — e non tornava, perche' `cpApri()` rilegge l'elenco solo `if (!cpVoci)` e
 * `cpChiudi()` non lo azzera. Per tutta la sessione il pannello mostrava un elenco che su
 * disco non esiste. Qui si esegue il `cpTogli` VERO contro la rotta VERA: l'esito non si
 * finge, si subisce.
 */
test('togli: la voce sparisce dallo schermo solo se il server l\'ha davvero tolta', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '7008', nome: 'Sub' } }, resFinta());
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'autoscout', id: '7008', nome: 'As' } }, resFinta());

    let ultimo = null;
    const fetchFinta = async url => {
      const r = resFinta();
      await H['DELETE /api/competitor/:id']({ params: { id: decodeURIComponent(String(url).split('/').pop()) } }, r);
      ultimo = r;
      return { ok: r.code >= 200 && r.code < 300, status: r.code, json: async () => r.body };
    };
    const togliVero = voci => daApp(
      [['async function cpTogli(chiave)', '\n// `toggle` non risale il DOM']],
      {
        fetch: fetchFinta, cpChiave: v => v.fonte + ':' + v.id, cpVoci: voci,
        cpParchi: {}, cpApertoId: null, cpErrore: null, cpRender: () => {}, hideResults: () => {},
      },
      'return { cpTogli, stato: () => ({ cpVoci, cpErrore }) };');

    // Magazzino sano: il server toglie davvero, e lo schermo lo segue.
    const sano = togliVero([{ fonte: 'subito', id: '7008' }, { fonte: 'autoscout', id: '7008' }]);
    await sano.cpTogli('subito:7008');
    assert.strictEqual(ultimo.code, 200);
    assert.deepStrictEqual(sano.stato().cpVoci.map(v => v.fonte), ['autoscout']);
    assert.strictEqual(sano.stato().cpErrore, null);

    // Ora il magazzino non si apre piu': la DELETE risponde 503 e non scrive niente.
    const p = dbmod.percorso();
    dbmod.chiudi();
    fs.writeFileSync(p, 'questo non e\' un database');
    const rotto = togliVero([{ fonte: 'autoscout', id: '7008' }]);
    await rotto.cpTogli('autoscout:7008');
    assert.strictEqual(ultimo.code, 503, 'a magazzino illeggibile la DELETE deve rifiutare');
    assert.strictEqual(rotto.stato().cpVoci.length, 1, 'il server non ha scritto: la voce non puo\' sparire dallo schermo');
    assert.ok(rotto.stato().cpErrore, 'e il perche\' va detto, senno\' il clic sembra riuscito');
  });
});

/**
 * REGRESSIONE. La rilettura della scheda vetrina stava PRIMA del controllo di cache: partiva
 * a ogni chiamata della rotta — anche sul ramo «dalla cache», che il budget non addebita —
 * e siccome `schedaLetta` diventa true solo quando `risolviVetrina` RIESCE, una vetrina
 * chiusa (404) rifaceva quella GET per sempre, fuori da qualunque contatore. Le voci
 * migrate dal vecchio competitor.json sono esattamente di questa forma: url presente,
 * `schedaLetta` assente.
 */
test('scheda non riletta: il tentativo vive dentro uno scarico addebitato, mai sul ramo di cache', async () => {
  let riletture = 0, scarichi = 0;
  const stub = {
    // La forma delle voci migrate: `url` c'e', `schedaLetta` no. E la vetrina non risponde
    // piu', quindi `schedaLetta` non diventera' mai true.
    leggi: () => [{ fonte: 'autoscout', id: '9345705', nome: 'Raineri Massimo', url: 'https://www.autoscout24.it/concessionari/raineri-massimo' }],
    scrivi: v => v,
    risolviVetrina: async () => { riletture++; throw new Error('la pagina risponde 404'); },
    parco: async () => { scarichi++; return { veicoli: [], troncato: false, illeggibili: 0, totaleFonte: null }; },
    aggrega: () => ({ veicoli: 0 }),
  };
  const H = {};
  const app = {
    get: (p, ...h) => { H['GET ' + p] = h[h.length - 1]; },
    post: (p, ...h) => { H['POST ' + p] = h[h.length - 1]; },
    delete: (p, ...h) => { H['DELETE ' + p] = h[h.length - 1]; },
  };
  route.mount(app, { json: (req, res, next) => next(), competitor: stub, clientIp: () => 'ip-test-rilettura' });
  const chiedi = async forza => {
    const r = resFinta();
    await H['GET /api/competitor/:id/parco']({ params: { id: 'autoscout:9345705' }, query: forza ? { forza: '1' } : {} }, r);
    return r;
  };

  // Primo scarico vero: si va in rete comunque, e la rilettura ci prova (una volta sola).
  const primo = await chiedi(true);
  assert.strictEqual(primo.code, 200);
  assert.strictEqual(scarichi, 1);
  assert.strictEqual(riletture, 1, 'la rilettura fa parte dello scarico reale');
  assert.strictEqual(primo.body.daCache, false);

  // Ora la scheda arriva dalla cache: non si addebita niente, quindi non deve partire NIENTE.
  for (let i = 0; i < 5; i++) {
    const r = await chiedi(false);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.daCache, true, 'entro i dieci minuti il parco arriva dalla cache');
  }
  assert.strictEqual(scarichi, 1, 'la cache non deve far ripartire il parco');
  assert.strictEqual(riletture, 1, 'ne\' la GET alla vetrina, che il budget non vede');
  // E il budget e' stato consumato una volta sola: cinque aperture da cache non pagano.
  assert.strictEqual(primo.body.scarichiRestanti, 5);
});

/**
 * REGRESSIONE. La rotta di gruppo scavalcava PARCO_MAX: N scarichi reali per richiesta,
 * nessun addebito, e il doppio clic (la ragione d'esistere del limitatore) non coperto.
 * Ora ogni voce non in cache passa dal budget, e il budget e' condiviso con la rotta singola.
 */
test('rotta di gruppo: gli scarichi passano dal limitatore e si addebitano', async () => {
  const chiamate = [];
  const stub = {
    leggi: () => [
      { fonte: 'subito', id: '1', nome: 'A', gruppo: 'g1', schedaLetta: true },
      { fonte: 'autoscout', id: '2', nome: 'B', gruppo: 'g1', schedaLetta: true },
    ],
    scrivi: v => v,
    parco: async voce => { chiamate.push(voce.fonte + ':' + voce.id); return { veicoli: [], troncato: false, illeggibili: 0, totaleFonte: null }; },
    aggrega: () => ({ veicoli: 0 }),
  };
  const H = {};
  const app = {
    get: (p, ...h) => { H['GET ' + p] = h[h.length - 1]; },
    post: (p, ...h) => { H['POST ' + p] = h[h.length - 1]; },
    delete: (p, ...h) => { H['DELETE ' + p] = h[h.length - 1]; },
  };
  route.mount(app, { json: (req, res, next) => next(), competitor: stub, clientIp: () => 'ip-test-gruppo' });
  // Prima richiesta: 2 voci, 2 scarichi, entrambi addebitati.
  const r1 = resFinta();
  await H['GET /api/competitor/gruppo/:g/parco']({ params: { g: 'g1' }, query: { forza: '1' } }, r1);
  assert.strictEqual(r1.code, 200);
  assert.strictEqual(chiamate.length, 2);
  assert.ok(r1.body.scarichiRestanti < 6, 'gli scarichi di gruppo devono consumare il budget');
  // Si insiste col doppio clic: al giro che sfora il budget la risposta e' 429, non
  // un giro silenzioso di scarichi (budget 6: 2+2+2 ok, il quarto giro rifiuta).
  await H['GET /api/competitor/gruppo/:g/parco']({ params: { g: 'g1' }, query: { forza: '1' } }, resFinta());
  await H['GET /api/competitor/gruppo/:g/parco']({ params: { g: 'g1' }, query: { forza: '1' } }, resFinta());
  const r4 = resFinta();
  await H['GET /api/competitor/gruppo/:g/parco']({ params: { g: 'g1' }, query: { forza: '1' } }, r4);
  assert.strictEqual(r4.code, 429, 'a budget esaurito il gruppo risponde 429 come la rotta singola');
  assert.match(r4.body.error, /Troppi scarichi/);
  assert.strictEqual(chiamate.length, 6, 'oltre il budget non deve partire nessuno scarico reale');
});
