'use strict';
/**
 * La salute delle fonti. Sostituisce le due suite Postgres cancellate il 2026-08-17
 * (`health-repo.test.js`, `health-backoff.test.js`), che per la parte interessante erano SALTATE
 * quando `DATABASE_URL_TEST` non c'era — cioe' quasi sempre. Con SQLite su file temporaneo non
 * c'e' niente da saltare: girano tutte, ogni volta.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const salute = require('../backend/fonti-salute');

/**
 * Ogni prova in una cartella sua: niente stato che passa da un test all'altro.
 *
 * Regge sia le funzioni normali sia quelle asincrone. Col `try/finally` secco la pulizia
 * scattava appena `fn` RESTITUIVA la promessa — cioe' prima che il suo corpo girasse — e le due
 * prove asincrone giravano con la cartella gia' rimessa a posto.
 */
function conCartella(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-fonti-'));
  const prima = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  salute._reset();
  const pulisci = () => {
    salute._reset();
    if (prima == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = prima;
  };
  let esito;
  try { esito = fn(dir); }
  catch (e) { pulisci(); throw e; }
  if (esito && typeof esito.then === 'function') return esito.then(v => { pulisci(); return v; }, e => { pulisci(); throw e; });
  pulisci();
  return esito;
}

const err = (msg, status, kind) => Object.assign(new Error(msg), { status, kind });

// ─── classifica: gli stessi casi che difendeva la versione Postgres ──────────────────────────
test('classifica: senza errore, il conteggio decide fra ok e vuoto', () => {
  assert.strictEqual(salute.classifica(null, 5), 'ok');
  assert.strictEqual(salute.classifica(null, 0), 'vuoto');
});

test('classifica: il genere taggato dallo scraper vince sullo status', () => {
  assert.strictEqual(salute.classifica(err('x', 429, 'blocked')), 'bloccato');
  assert.strictEqual(salute.classifica(err('x', 401, 'auth')), 'auth');
  assert.strictEqual(salute.classifica(err('x', 500, 'transient')), 'transitorio');
});

test('classifica: senza genere si legge lo status', () => {
  assert.strictEqual(salute.classifica({ status: 403, message: '' }), 'bloccato');
  assert.strictEqual(salute.classifica({ status: 429, message: '' }), 'bloccato');
  assert.strictEqual(salute.classifica({ status: 401, message: '' }), 'auth');
  assert.strictEqual(salute.classifica({ status: 503, message: '' }), 'transitorio');
});

test('classifica: ultima spiaggia, il messaggio', () => {
  assert.strictEqual(salute.classifica(new Error('Subito hades: body non-JSON (blocco?)')), 'bloccato');
  assert.strictEqual(salute.classifica(new Error('timeout')), 'transitorio');
  assert.strictEqual(salute.classifica(new Error('AS24 GraphQL errors: boom')), 'errore');
});

// ─── il freno ────────────────────────────────────────────────────────────────────────────────
test('UN blocco solo NON ferma la fonte: servono due prove', () => {
  conCartella(() => {
    salute.registra('subito', { errore: err('403', 403) });
    assert.strictEqual(salute.fermo('subito').fermo, false,
      'un singolo 403 spegnerebbe la fonte per TUTTI gli utenti: troppo poco per fermarsi');
    salute.registra('subito', { errore: err('403', 403) });
    assert.strictEqual(salute.fermo('subito').fermo, true, 'due di fila invece si');
  });
});

test('una risposta buona in mezzo azzera il conto', () => {
  conCartella(() => {
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { conteggio: 12 });          // ok
    salute.registra('subito', { errore: err('403', 403) });
    assert.strictEqual(salute.fermo('subito').fermo, false,
      'il blocco prima e quello dopo non sono "due di fila"');
  });
});

test('la fonte torna interrogabile appena arriva una risposta buona', () => {
  conCartella(() => {
    salute.registra('as24', { errore: err('429', 429) });
    salute.registra('as24', { errore: err('429', 429) });
    assert.strictEqual(salute.fermo('as24').fermo, true);
    salute.registra('as24', { conteggio: 3 });
    assert.strictEqual(salute.fermo('as24').fermo, false, 'un esito ok toglie la pausa');
  });
});

test('la pausa parte corta e si allunga solo se ricapita', () => {
  conCartella(() => {
    const stop = () => {
      salute.registra('motoit', { errore: err('403', 403) });
      salute.registra('motoit', { errore: err('403', 403) });
      return salute.fermo('motoit').fino - Date.now();
    };
    const prima = stop();
    assert.ok(prima <= salute.FINESTRE[0] + 1000, `la prima pausa deve essere la piu' corta, era ${prima}`);
    salute.registra('motoit', { conteggio: 1 });           // esce dalla pausa
    const seconda = stop();
    assert.ok(seconda > prima, `la seconda pausa deve essere piu' lunga (${seconda} vs ${prima})`);
  });
});

test('la scala si scorda: dopo mesi di pace un doppio 403 vale 15 minuti, non sei ore', () => {
  conCartella(dir => {
    const stop = () => {
      salute.registra('subito', { errore: err('403', 403) });
      salute.registra('subito', { errore: err('403', 403) });
      return salute.fermo('subito').fino - Date.now();
    };
    stop();
    salute.registra('subito', { conteggio: 1 });
    stop();
    salute.registra('subito', { conteggio: 1 });
    assert.ok(stop() > salute.FINESTRE[1], 'tre pause attaccate devono arrivare al gradino lungo');

    // Mesi dopo, processo nuovo: sul disco `stop_fatti` e' ancora quello, la pausa e' finita da
    // un pezzo. `fermo()` PRIMA di `registra()` com'e' l'ordine vero in server.js (`runSearch`
    // chiede la pausa di tutte e tre le fonti prima di lanciarle): senza, la riga nascerebbe
    // vuota in memoria e il valore del disco non rientrerebbe mai — la prova non proverebbe.
    salute._reset();
    const d = new DatabaseSync(path.join(dir, 'amr-fonti.db'));
    d.prepare('UPDATE salute SET ferma_fino_a = NULL, aggiornata_il = ? WHERE fonte = ?')
      .run(Date.now() - 90 * 24 * 60 * 60 * 1000, 'subito');
    d.close();
    assert.strictEqual(salute.fermo('subito').fermo, false, 'la pausa di mesi fa e\' finita');

    const dopo = stop();
    assert.ok(dopo <= salute.FINESTRE[0] + 1000,
      `un singhiozzo dopo mesi di pace non puo' spegnere la fonte per sei ore (era ${dopo})`);
  });
});

test('auth non ferma niente: e\' una sessione da rinnovare, non un ban', () => {
  conCartella(() => {
    for (let i = 0; i < 5; i++) salute.registra('subito', { errore: err('401', 401) });
    assert.strictEqual(salute.fermo('subito').fermo, false,
      'fermarsi ore per una sessione scaduta e\' un autogol: basta rinnovarla');
  });
});

test('i vuoti di fila rendono la fonte sospetta ma NON la fermano', () => {
  conCartella(() => {
    for (let i = 0; i < salute.VUOTI_SOSPETTI; i++) salute.registra('as24', { conteggio: 0 });
    const s = salute.stato();
    assert.ok(s.sospette.includes('as24'), 'un blocco morbido risponde 200 con zero risultati: va dichiarato');
    assert.strictEqual(salute.fermo('as24').fermo, false, 'ma vuoto molto spesso e\' vuoto davvero');
  });
});

test('fallimenti ripetuti non-blocco → degradata, e si vede', () => {
  conCartella(() => {
    for (let i = 0; i < salute.DEGRADO_A; i++) salute.registra('as24', { errore: err('timeout') });
    const s = salute.stato();
    assert.ok(s.degradate.includes('as24'));
    assert.strictEqual(s.ok, false, 'il quadro d\'insieme non puo\' dire "tutto bene"');
    assert.strictEqual(salute.fermo('as24').fermo, false, 'ma una rete che singhiozza non e\' un ban');
  });
});

// ─── il disco ────────────────────────────────────────────────────────────────────────────────
test('la pausa sopravvive a un riavvio', () => {
  conCartella(() => {
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { errore: err('403', 403) });
    assert.strictEqual(salute.fermo('subito').fermo, true);
    salute._reset();                                        // come un riavvio del processo
    assert.strictEqual(salute.fermo('subito').fermo, true, 'riavviare non deve cancellare il freno');
  });
});

test('una scadenza gia\' passata sul disco non ferma piu\' nessuno', () => {
  conCartella(dir => {
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { errore: err('403', 403) });
    salute._reset();
    const d = new DatabaseSync(path.join(dir, 'amr-fonti.db'));
    d.prepare('UPDATE salute SET ferma_fino_a = ? WHERE fonte = ?').run(Date.now() - 1000, 'subito');
    d.close();
    assert.strictEqual(salute.fermo('subito').fermo, false,
      'la finestra scade da sola: senza, una fonte bloccata resterebbe bloccata per sempre');
  });
});

test('una scadenza assurda nel futuro viene tagliata, non creduta', () => {
  conCartella(dir => {
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { errore: err('403', 403) });
    salute._reset();
    const dieciAnni = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    const d = new DatabaseSync(path.join(dir, 'amr-fonti.db'));
    d.prepare('UPDATE salute SET ferma_fino_a = ? WHERE fonte = ?').run(dieciAnni, 'subito');
    d.close();
    const f = salute.fermo('subito');
    assert.strictEqual(f.fermo, true);
    assert.ok(f.fino <= Date.now() + salute.FINESTRA_MAX + 1000,
      'un orologio che salta o un backup vecchio non devono poter mettere in pausa per anni');
  });
});

test('se il posto non c\'e\', si lavora in memoria E lo si dichiara', () => {
  const prima = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = path.join(os.tmpdir(), 'amr-non-esiste-' + process.pid);
  salute._reset();
  try {
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { errore: err('403', 403) });
    assert.strictEqual(salute.fermo('subito').fermo, true,
      'il freno deve funzionare lo stesso: e\' in memoria');
    assert.ok(salute.stato().guasto, 'ma il guasto va detto, non intuito');
  } finally {
    salute._reset();
    if (prima == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = prima;
  }
});

test('azzera toglie il freno a mano', () => {
  conCartella(() => {
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { errore: err('403', 403) });
    assert.strictEqual(salute.fermo('subito').fermo, true);
    salute.azzera('subito');
    assert.strictEqual(salute.fermo('subito').fermo, false);
  });
});

test('azzera toglie anche la scala, non solo la pausa in corso', () => {
  conCartella(() => {
    const stop = () => {
      salute.registra('subito', { errore: err('403', 403) });
      salute.registra('subito', { errore: err('403', 403) });
      return salute.fermo('subito').fino - Date.now();
    };
    stop();
    salute.azzera('subito');
    const dopo = stop();
    assert.ok(dopo <= salute.FINESTRE[0] + 1000,
      `tolto il freno a mano, il blocco dopo deve ripartire dal gradino corto (era ${dopo})`);
  });
});

// ─── il presidio: qui dentro non entrano dati delle persone ──────────────────────────────────
test('la tabella NON puo\' acquistare colonne oltre quelle dichiarate', () => {
  conCartella(dir => {
    // Ci vuole una pausa vera per far nascere il file: leggere non lo crea (e fa bene — un
    // impianto che non ha mai avuto un problema non deve lasciare tracce).
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { errore: err('403', 403) });
    salute._reset();
    const d = new DatabaseSync(path.join(dir, 'amr-fonti.db'));
    const cols = d.prepare('PRAGMA table_info(salute)').all().map(c => c.name).sort();
    d.close();
    assert.deepStrictEqual(cols, [...salute.COLONNE].sort(),
      'salvare qui "la richiesta che ha fallito" metterebbe il testo cercato da una persona in una '
      + 'tabella che nessuno considera personale: se aggiungi una colonna, aggiornala anche in COLONNE '
      + 'e chiediti prima se e\' un dato di qualcuno');
  });
});

// ─── Il collegamento alle tre fonti vive ─────────────────────────────────────────────────────
const os2 = require('node:os');
process.env.AMR_LOG_DIR = process.env.AMR_LOG_DIR || fs.mkdtempSync(path.join(os2.tmpdir(), 'amr-log-'));
const srv = require('../backend/server');   // richiesto come modulo: non si mette in ascolto

const fallito = () => { throw Object.assign(new Error('403'), { status: 403, kind: 'blocked' }); };

test('runSource registra SOLO se gli si dice quale fonte e\'', async () => {
  await conCartella(async () => {
    // Senza chiave: e' cosi' che lo chiamano le prove. Se registrasse lo stesso, una prova
    // metterebbe in pausa una fonte vera nell'archivio di chi sviluppa.
    await srv._runSource(fallito, 500, 'Finta');
    await srv._runSource(fallito, 500, 'Finta');
    assert.strictEqual(salute.fermo('autoscout').fermo, false, 'senza chiave non deve registrare niente');

    await srv._runSource(fallito, 500, 'Autoscout24', 'autoscout');
    await srv._runSource(fallito, 500, 'Autoscout24', 'autoscout');
    assert.strictEqual(salute.fermo('autoscout').fermo, true, 'con la chiave, due respinte di fila fermano la fonte');
  });
});

test('una risposta buona da runSource toglie la pausa', async () => {
  await conCartella(async () => {
    await srv._runSource(fallito, 500, 'Moto.it', 'moto');
    await srv._runSource(fallito, 500, 'Moto.it', 'moto');
    assert.strictEqual(salute.fermo('moto').fermo, true);
    await srv._runSource(async () => ({ items: [{ url: 'x' }], total: 1 }), 500, 'Moto.it', 'moto');
    assert.strictEqual(salute.fermo('moto').fermo, false);
  });
});

test('una respinta PARZIALE di Autoscout arriva al freno col suo genere', async () => {
  await conCartella(async () => {
    // Qualche pagina/grafia respinta e altre no: prima usciva il solo `parziale`, cioe' una
    // stringa, e runSource registrava `errore: null` con item > 0 — un 'ok', che AZZERA i colpi.
    // In un regime di respinta parziale sostenuta il blocco non veniva contato mai nemmeno una
    // volta: AS24 respingeva due terzi delle richieste a ogni giro e non andava mai in pausa.
    const parzialmenteRespinta = async () => ({
      items: [{ url: 'a' }, { url: 'b' }], total: null,
      parziale: '2/3 grafie AS24 fallite: AS24 GraphQL HTTP 403',
      bloccoParziale: Object.assign(new Error('AS24 ha respinto 2 grafie su 3'), { kind: 'blocked', status: 403 }),
    });
    const primo = await srv._runSource(parzialmenteRespinta, 500, 'Autoscout24', 'autoscout');
    assert.strictEqual(primo.status, 'ok', 'gli annunci superstiti ci sono: la colonna non si spegne');
    assert.match(String(primo.reason), /grafie AS24 fallite/, 'e la nota parziale resta dov\'era');
    assert.strictEqual(salute.fermo('autoscout').fermo, false, 'una respinta sola non ferma niente');
    await srv._runSource(parzialmenteRespinta, 500, 'Autoscout24', 'autoscout');
    assert.strictEqual(salute.fermo('autoscout').fermo, true,
      'due respinte parziali di fila devono fermare la fonte come due respinte piene');

    // Controprova: un elenco monco SENZA respinta (pagina caduta per timeout/markup) non e' un
    // blocco. Se anche questo frenasse, un singhiozzo qualsiasi toglierebbe la fonte per ore.
    salute.azzera('autoscout');
    const soloMonco = async () => ({ items: [{ url: 'a' }], total: null,
      parziale: '1 pagine su 3 non si sono lasciate leggere da Autoscout', bloccoParziale: null });
    await srv._runSource(soloMonco, 500, 'Autoscout24', 'autoscout');
    await srv._runSource(soloMonco, 500, 'Autoscout24', 'autoscout');
    assert.strictEqual(salute.fermo('autoscout').fermo, false,
      'un elenco monco senza respinta non e\' un blocco: non deve mettere in pausa la fonte');
  });
});

test('il motivo della pausa e\' la STESSA stringa che il frontend sa tradurre', () => {
  // Il frontend mappa `reason` → etichetta con una tabella a chiavi esatte. Se qualcuno cambia
  // la costante in backend e non la tabella, a schermo esce la stringa grezza e nessuno se ne
  // accorge finche' non capita davvero un blocco.
  const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const riga = app.split('\n').find(l => l.includes('SKIP_REASON_TXT = {'));
  assert.ok(riga, 'SKIP_REASON_TXT deve esistere in frontend/app.js');
  assert.ok(riga.includes(`'${salute.MOTIVO_PAUSA}'`),
    `frontend/app.js non conosce il motivo "${salute.MOTIVO_PAUSA}": l'etichetta uscirebbe grezza`);
});

test('azzera funziona anche su un processo appena avviato, e dice quante ne ha tolte', () => {
  conCartella(() => {
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { errore: err('403', 403) });
    salute._reset();                    // processo nuovo: la memoria e' vuota, lo stato sta sul disco

    // Senza caricare il disco, `azzera` non trovava niente da togliere — e rispondeva lo stesso
    // "fatto". Trovato collaudando a mano: il comando diceva "pausa tolta" e la pausa restava.
    assert.strictEqual(salute.azzera('subito'), 1, 'deve dichiarare di averne toccata UNA');
    assert.strictEqual(salute.fermo('subito').fermo, false, 'e la pausa deve essere davvero sparita');

    assert.strictEqual(salute.azzera('mai-vista'), 0,
      'e su una fonte che non c\'e\' deve dire zero, non fingere');
  });
});

// ─── Le due regressioni trovate dalla revisione del 2026-08-22 ───────────────────────────────
test('salva() non sovrascrive la pausa appena decisa coi valori del disco', () => {
  // Il file esisteva gia' (pausa messa e tolta). Processo nuovo: nessuna lettura, due blocchi.
  // `salva` apriva il file e il caricamento RISCRIVEVA la riga in memoria coi valori vecchi del
  // disco (ferma_fino_a: null), poi persisteva quelli. Il log diceva "ferma per 15 min" e la
  // fonte NON era ferma.
  conCartella(dir => {
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { errore: err('403', 403) });
    salute.azzera('subito');
    salute._reset();
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { errore: err('403', 403) });
    assert.strictEqual(salute.fermo('subito').fermo, true, 'in memoria la pausa deve esserci');
    const d = new DatabaseSync(path.join(dir, 'amr-fonti.db'));
    const r = d.prepare('SELECT ferma_fino_a FROM salute WHERE fonte = ?').get('subito');
    d.close();
    assert.ok(r && r.ferma_fino_a, 'e sul disco deve essere stata SCRITTA, non annullata dal caricamento');
  });
});

test('una scadenza assurda viene tagliata E riscritta: la pausa finisce davvero', () => {
  // Prima il taglio era calcolato a ogni lettura e mai scritto: "fra sei ore", per sempre.
  conCartella(dir => {
    salute.registra('subito', { errore: err('403', 403) });
    salute.registra('subito', { errore: err('403', 403) });
    salute._reset();
    const dieciAnni = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    let d = new DatabaseSync(path.join(dir, 'amr-fonti.db'));
    d.prepare('UPDATE salute SET ferma_fino_a = ? WHERE fonte = ?').run(dieciAnni, 'subito');
    d.close();
    salute.fermo('subito');                                       // processo nuovo: legge e taglia
    d = new DatabaseSync(path.join(dir, 'amr-fonti.db'));
    const r = d.prepare('SELECT ferma_fino_a FROM salute WHERE fonte = ?').get('subito');
    d.close();
    assert.ok(Number(r.ferma_fino_a) <= Date.now() + salute.FINESTRA_MAX + 1000,
      'il valore sul DISCO deve essere quello tagliato: senno\' al riavvio si riparte da dieci anni');
  });
});
