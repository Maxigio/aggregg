'use strict';
/**
 * IL GIRO DI CHI CHIEDE DI ENTRARE, provato sui modi in cui si prende l'account di un altro.
 *
 * Le prove interessanti non sono "la registrazione funziona": sono le finestre fra un passo e
 * l'altro. Fra la richiesta e il consumo del link passano giorni, e in mezzo il mondo cambia —
 * il nome viene preso da qualcun altro, il link viene aperto due volte, il proprietario clicca
 * due volte, un backup vecchio riporta in vita un invito gia' usato.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

process.env.AMR_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-log-reg-'));
process.env.USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-reg-'));

const auth = require('../backend/auth');
const dbmod = require('../backend/utenti-db');
const reg = require('../backend/registrazioni');

const ADMIN = 'proprie8';

/** Ogni prova riparte da un magazzino vuoto e da un elenco di persone vuoto. */
function daCapo() {
  dbmod.chiudi();
  const p = dbmod.percorso();
  for (const f of [p, p + '-wal', p + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* non c'era */ } }
  auth.setPassword(ADMIN);
  for (const x of auth.persone()) auth.togliPersona(x.id);
}

test('registrazione: si chiede senza password, e il nome resta prenotato', () => {
  daCapo();
  const r = reg.chiedi({ nome: '  Mario   Rossi ', email: 'mario@esempio.it', ip: '10.0.0.1' });
  assert.strictEqual(r.persona, 'mario-rossi');
  assert.strictEqual(r.nome, 'Mario Rossi', 'gli spazi doppi si stringono: il nome e\' quello che si legge');

  // Fino all'approvazione non esiste NIENTE di suo: nessuna credenziale da nessuna parte.
  assert.deepStrictEqual(auth.persone(), []);

  // Lo stesso nome, in qualunque grafia, non ottiene una seconda richiesta viva.
  for (const g of ['Mario Rossi', 'MARIO.ROSSI', 'Marió Rossì', 'mario_rossi']) {
    assert.throws(() => reg.chiedi({ nome: g, email: 'altro@esempio.it' }), e => e.code === 'RICHIESTA_GIA_VIVA', g);
  }
  assert.strictEqual(reg.viveContate(), 1);
});

test('registrazione: quello che si rifiuta subito', () => {
  daCapo();
  const no = (dati, code) => assert.throws(() => reg.chiedi(dati), e => e.code === code, JSON.stringify(dati));
  no({ nome: '', email: 'a@b.it' }, 'NOME_MANCANTE');
  no({ nome: '   ', email: 'a@b.it' }, 'NOME_MANCANTE');
  no({ nome: '???', email: 'a@b.it' }, 'NOME_VUOTO');
  no({ nome: 'Owner', email: 'a@b.it' }, 'NOME_RISERVATO');
  no({ nome: 'démo', email: 'a@b.it' }, 'NOME_RISERVATO');
  no({ nome: 'x'.repeat(reg.NOME_MAX + 1), email: 'a@b.it' }, 'NOME_LUNGO');
  for (const m of ['', 'niente', 'a@b', 'a b@c.it', 'a@@b.it', 'x'.repeat(200) + '@b.it']) {
    no({ nome: 'Tizio Uno', email: m }, 'EMAIL_NON_VALIDA');
  }
  // E chi e' gia' dentro non si "ri-registra" sopra se stesso.
  auth.setPersona('Anna Bianchi', 'annaseg1', 'demo');
  no({ nome: 'Anna Bianchi', email: 'anna@esempio.it' }, 'NOME_OCCUPATO');
});

test('invito: il link nasce all\'approvazione, vale una volta sola, e il token non si rilegge', () => {
  daCapo();
  const r = reg.chiedi({ nome: 'Chiara Verdi', email: 'chiara@esempio.it' });
  const inv = reg.approva(r.id);
  assert.ok(inv.token && inv.token.length >= 40);

  // Nel database c'e' solo l'impronta: chi legge il file non puo' entrare con quello che trova.
  const db = dbmod.richiedi();
  const riga = db.prepare('SELECT token FROM inviti WHERE richiesta=?').get(r.id);
  assert.strictEqual(riga.token, reg.impronta(inv.token));
  assert.notStrictEqual(riga.token, inv.token, 'il token in chiaro non deve stare nel database');

  assert.deepStrictEqual(reg.guarda(inv.token).valido, true);
  assert.strictEqual(reg.guarda('token-inventato').motivo, 'sconosciuto');

  const nata = reg.consuma(inv.token, 'chiarapw1');
  assert.deepStrictEqual([nata.id, nata.ruolo], ['chiara-verdi', 'demo']);
  assert.ok(auth.verifica('chiarapw1'), 'da adesso entra');
  assert.strictEqual(auth.persone().find(p => p.id === 'chiara-verdi').origine, 'web');

  // Una volta sola: il secondo giro non deve ricreare la persona (ricrearla rigenererebbe il
  // secret e butterebbe fuori tutti quanti).
  assert.throws(() => reg.consuma(inv.token, 'altrapw12'), e => e.code === 'INVITO_USATO');
  assert.strictEqual(reg.guarda(inv.token).motivo, 'gia-usato');
  assert.ok(auth.verifica('chiarapw1'), 'la password scelta dalla persona deve essere ancora la sua');
});

test('invito: due clic su Approva non fanno due link vivi', () => {
  daCapo();
  const r = reg.chiedi({ nome: 'Dario Blu', email: 'dario@esempio.it' });
  reg.approva(r.id);
  assert.throws(() => reg.approva(r.id), e => e.code === 'RICHIESTA_NON_IN_ATTESA');
  const n = dbmod.richiedi().prepare('SELECT COUNT(*) AS n FROM inviti WHERE richiesta=? AND usato_il IS NULL').get(r.id).n;
  assert.strictEqual(Number(n), 1, 'due inviti vivi per la stessa persona: il secondo si prenderebbe l\'account del primo');
});

test('invito: se il nome viene preso NEL FRATTEMPO, il link non lo sovrascrive', () => {
  daCapo();
  const r = reg.chiedi({ nome: 'Elena Neri', email: 'elena@esempio.it' });
  const inv = reg.approva(r.id);

  // Il proprietario aggiunge la vera Elena dal .env mentre il link e' ancora in giro.
  auth.setPersona('Elena Neri', 'elenavera1', 'demo');

  assert.throws(() => reg.consuma(inv.token, 'impostore1'), e => e.code === 'NOME_OCCUPATO');
  assert.ok(auth.verifica('elenavera1'), 'la password della persona vera doveva restare valida');
  assert.strictEqual(auth.verifica('impostore1'), null);
  // Il link non e' bruciato: l'errore e' della persona, non del link.
  assert.strictEqual(reg.guarda(inv.token).valido, true);
});

test('invito: una password gia\' di qualcun altro non passa, e il link resta buono', () => {
  daCapo();
  auth.setPersona('Anna Bianchi', 'annaseg1', 'demo');
  const r = reg.chiedi({ nome: 'Franco Gialli', email: 'franco@esempio.it' });
  const inv = reg.approva(r.id);

  assert.throws(() => reg.consuma(inv.token, 'annaseg1'), e => e.code === 'PASSWORD_OCCUPATA');
  assert.throws(() => reg.consuma(inv.token, ADMIN), e => e.code === 'PASSWORD_OCCUPATA');
  assert.throws(() => reg.consuma(inv.token, 'corta'), /minimo/);
  assert.strictEqual(reg.guarda(inv.token).valido, true, 'il link non si brucia per una password sbagliata');
  assert.doesNotThrow(() => reg.consuma(inv.token, 'francogp1'));
});

test('scadenze: il link morto restituisce il nome, la richiesta dimenticata si chiude', () => {
  daCapo();
  const r = reg.chiedi({ nome: 'Gino Viola', email: 'gino@esempio.it' });
  const inv = reg.approva(r.id);

  const dopo = Date.now() + reg.INVITO_TTL + 1000;
  assert.strictEqual(reg.guarda(inv.token, dopo).motivo, 'scaduto');
  assert.throws(() => reg.consuma(inv.token, 'ginopw12', dopo), e => e.code === 'INVITO_SCADUTO');

  // La purga riporta la richiesta in attesa: il proprietario rifa' il link invece di trovarsi un
  // nome bloccato per sempre da un invito morto.
  reg.purga(dopo);
  const vive = reg.elenco();
  assert.strictEqual(vive.length, 1);
  assert.strictEqual(vive[0].stato, 'attesa');
  const inv2 = reg.approva(vive[0].id);
  assert.notStrictEqual(inv2.token, inv.token, 'il link nuovo dev\'essere un altro link');
  assert.strictEqual(reg.guarda(inv.token).motivo, 'sconosciuto', 'il vecchio non deve piu\' esistere');

  // E una richiesta che nessuno guarda per sette giorni si chiude e libera il nome.
  reg.purga(Date.now() + reg.RICHIESTA_TTL + reg.INVITO_TTL + 2000);
  assert.deepStrictEqual(reg.elenco(), []);
  assert.doesNotThrow(() => reg.chiedi({ nome: 'Gino Viola', email: 'gino@esempio.it' }));
});

test('pannello: il doppione si vede, perche\' il conto lo fa la macchina', () => {
  daCapo();
  auth.setPersona('Mario Rossi', 'mariorossi1', 'demo');
  // Chi chiede si e' scritto con gli accenti: a occhio, in mezzo a venti righe, non e' un doppione.
  const db = dbmod.richiedi();
  const t = Date.now();
  db.prepare('INSERT INTO richieste (persona, nome, email, ip, creata_il, scade_il, stato) VALUES (?,?,?,?,?,?,\'attesa\')')
    .run('mario-rossi', 'Marió Rossì', 'altro@esempio.it', null, t, t + reg.RICHIESTA_TTL);

  const [riga] = reg.elenco();
  assert.strictEqual(riga.collide, true, 'il pannello deve dire che quel nome cadrebbe su una persona che esiste');
  assert.strictEqual(riga.persona, 'mario-rossi');
  assert.throws(() => reg.approva(riga.id), e => e.code === 'NOME_OCCUPATO');
});

test('rifiuto: il link gia\' emesso muore col rifiuto', () => {
  daCapo();
  const r = reg.chiedi({ nome: 'Ivan Rosa', email: 'ivan@esempio.it' });
  const inv = reg.approva(r.id);
  reg.rifiuta(r.id, 'non lo conosco');
  assert.strictEqual(reg.guarda(inv.token).motivo, 'sconosciuto');
  assert.throws(() => reg.consuma(inv.token, 'ivanpw123'), e => e.code === 'INVITO_SCONOSCIUTO');
  assert.deepStrictEqual(reg.elenco(), [], 'una rifiutata non e\' piu\' viva');
  assert.doesNotThrow(() => reg.chiedi({ nome: 'Ivan Rosa', email: 'ivan@esempio.it' }), 'e il nome torna libero');
});

test('coda: il tetto vale sulle vive, e le vive scadono da sole', () => {
  daCapo();
  const db = dbmod.richiedi();
  const t = Date.now();
  const ins = db.prepare('INSERT INTO richieste (persona, nome, email, ip, creata_il, scade_il, stato) VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < reg.MAX_VIVE; i++) ins.run(`tizio-${i}`, `Tizio ${i}`, `t${i}@esempio.it`, null, t, t + reg.RICHIESTA_TTL, 'attesa');
  assert.strictEqual(reg.viveContate(), reg.MAX_VIVE);
  assert.throws(() => reg.chiedi({ nome: 'Uno Ancora', email: 'u@esempio.it' }), e => e.code === 'CODA_PIENA');

  // Se la coda restasse piena per sempre, riempirla sarebbe il modo piu' economico di impedire a
  // chiunque altro di registrarsi. Passata la settimana, si svuota da sola.
  db.prepare('UPDATE richieste SET scade_il=?').run(t - 1);
  reg.purga();
  assert.strictEqual(reg.viveContate(), 0);
  assert.doesNotThrow(() => reg.chiedi({ nome: 'Uno Ancora', email: 'u@esempio.it' }));
});

// ── Il registro, e la revoca ─────────────────────────────────────────────────

test('registro: i due gesti che lasciano una credenziale permanente vengono scritti', () => {
  daCapo();
  const r = reg.chiedi({ nome: 'Livia Neri', email: 'livia@esempio.it', ip: '10.0.0.7' });
  const inv = reg.approva(r.id);
  reg.consuma(inv.token, 'liviapw12');

  const righe = dbmod.registro(10);
  assert.deepStrictEqual(righe.map(x => x.evento), ['account-creato', 'approvata', 'richiesta'],
    'dalla piu\' recente: la nascita dell\'account, l\'approvazione, la richiesta');
  assert.ok(righe.every(x => x.nome === 'Livia Neri'));

  // IL TOKEN NON DEVE STARE NEL REGISTRO. Se ci finisse, chi legge il registro potrebbe usarlo:
  // sarebbe un secondo posto da cui rubare un accesso, ed e' esattamente quello che si evita
  // conservando del token la sola impronta.
  const tutto = JSON.stringify(righe);
  assert.ok(!tutto.includes(inv.token), 'il token in chiaro e\' finito nel registro');
  assert.ok(!tutto.includes(reg.impronta(inv.token)), 'nemmeno la sua impronta serve li\' dentro');
});

test('registro: anche il rifiuto e la revoca lasciano traccia', () => {
  daCapo();
  const a = reg.chiedi({ nome: 'Mara Blu', email: 'mara@esempio.it' });
  reg.rifiuta(a.id, 'non la conosco');

  const b = reg.chiedi({ nome: 'Nadia Verdi', email: 'nadia@esempio.it' });
  reg.consuma(reg.approva(b.id).token, 'nadiapw123');
  assert.ok(auth.verifica('nadiapw123'), 'partenza: Nadia entra');

  const tolta = reg.revoca('Nadia Verdi');
  assert.strictEqual(tolta.id, 'nadia-verdi');
  assert.strictEqual(auth.verifica('nadiapw123'), null, 'revocata vuol dire che non entra piu\'');

  const eventi = dbmod.registro(20).map(x => x.evento);
  assert.ok(eventi.includes('rifiutata'), 'il rifiuto non e\' stato annotato');
  assert.ok(eventi.includes('revocata'), 'la revoca non e\' stata annotata');
  // Revocare toglie l'ACCESSO, non i dati.
  assert.strictEqual(reg.revoca('nessuno-cosi'), null, 'revocare chi non c\'e\' non inventa una riga');
});
