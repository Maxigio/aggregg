'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { creaAccountProva } = require('../backend/nodi/account-prova');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = 1800000000000;
  const identita = [
    { id: 'owner', admin: true, mfa: true }, { id: 'ownerNoMfa', admin: true },
    { id: 'rA' }, { id: 'rB' }, { id: 'a' }, { id: 'b' }, { id: 'c' },
    { id: 'nonVerificata', verificata: false }, { id: 'disattiva', attiva: false },
    ...Array.from({length: 12}, (_, i) => ({id: 'nuovo' + i})),
  ].map(p => ({ verificata: true, email: p.id + '@amr.invalid', ...p }));
  const account = creaAccountProva({ db, identita, ora: () => now });
  const login = id => account.sessione(id);
  const owner = login('owner');
  for (const [id, referente, moduli] of [['A','rA',['auto','moto']], ['B','rB',['moto']]]) {
    account.creaAzienda(owner, { id, referente, moduli, scadenza: now + 365 * 86400000 });
  }
  return { db, account, owner, login, now: () => now, avanza: ms => { now += ms; },
    entra: (ref, id) => {
      const i = account.invita(login(ref), { email: id + '@amr.invalid' });
      account.accetta(login(id), {token: i.token});
      return login(id);
    } };
}
const codice = (fn, expected) => assert.throws(fn, e => e.codice === expected);

test('account: identità corrente, email verificata, moduli distinti e nessuna azienda scelta dal cliente', t => {
  const f = fixture(t);
  assert.deepEqual(f.account.contesto(f.login('rA'), {tipo:'auto'}).moduli, ['auto','moto']);
  codice(() => f.account.contesto(f.login('rB'), {tipo:'auto'}), 'modulo_non_autorizzato');
  codice(() => f.account.contesto(f.login('rA'), {azienda:'B'}), 'azienda_non_autorizzata');
  for (const id of ['nonVerificata', 'disattiva']) codice(() => f.login(id), 'identita_non_autorizzata');
  codice(() => f.login('__proto__'), 'identita_non_autorizzata');
  codice(() => f.account.contesto({persona:'rA',epoca:123}), 'identita_non_autorizzata');
});

test('account: scadenza esatta, sospensione e perdita del modulo non usano permessi precedenti', t => {
  const f = fixture(t), s = f.login('rA');
  f.account.configuraAzienda(f.owner, { id:'A', scadenza:f.now(), moduli:['auto','moto'], attiva:true });
  codice(() => f.account.contesto(s), 'azienda_non_autorizzata');
  f.account.configuraAzienda(f.owner, { id:'A', scadenza:f.now()+100, moduli:['moto'], attiva:true });
  codice(() => f.account.contesto(s,{tipo:'auto'}), 'modulo_non_autorizzato');
  f.account.configuraAzienda(f.owner, { id:'A', scadenza:f.now()+100, moduli:['moto'], attiva:false });
  codice(() => f.account.contesto(s), 'azienda_non_autorizzata');
});

test('account: tre posti inclusi referente e pending; accettazione converte la prenotazione', t => {
  const f = fixture(t), s = f.login('rA');
  const a = f.account.invita(s, {email:'a@amr.invalid'});
  f.account.invita(s, {email:'b@amr.invalid'});
  codice(() => f.account.invita(s,{email:'c@amr.invalid'}), 'quota_persone');
  f.account.accetta(f.login('a'), {token:a.token});
  codice(() => f.account.invita(s,{email:'c@amr.invalid'}), 'quota_persone');
  assert.equal(f.db.prepare("SELECT count(*) n FROM membri_prova WHERE azienda='A'").get().n, 2);
  assert.equal(f.db.prepare("SELECT count(*) n FROM inviti_prova WHERE azienda='A' AND stato='pending'").get().n, 1);
});

test('account: invito monouso, destinatario esatto, nessun token grezzo nel database', t => {
  const f=fixture(t), i=f.account.invita(f.login('rA'),{email:'a@amr.invalid'});
  codice(()=>f.account.accetta(f.login('b'),{token:i.token}), 'invito_non_valido');
  f.account.accetta(f.login('a'),{token:i.token});
  codice(()=>f.account.accetta(f.login('a'),{token:i.token}), 'invito_non_valido');
  const rows=f.db.prepare('SELECT * FROM inviti_prova').all();
  assert.equal(JSON.stringify(rows).includes(i.token),false);
});

test('account: invito scade dopo sette giorni e restituisce il posto anche senza manutenzione', t => {
  const f=fixture(t), s=f.login('rA');
  const i=f.account.invita(s,{email:'a@amr.invalid'});
  f.account.invita(s,{email:'b@amr.invalid'});
  f.avanza(7*86400000);
  codice(()=>f.account.accetta(f.login('a'),{token:i.token}),'invito_non_valido');
  f.account.invita(s,{email:'c@amr.invalid'});
  assert.equal(f.db.prepare("SELECT count(*) n FROM inviti_prova WHERE stato='pending'").get().n,1);
});

test('account: revoca invito e rifiuto quando azienda scaduta', t => {
  const f=fixture(t), s=f.login('rA');
  const i=f.account.invita(s,{email:'a@amr.invalid'});
  f.account.revocaInvito(s,{id:i.id});
  codice(()=>f.account.accetta(f.login('a'),{token:i.token}), 'invito_non_valido');
  const j=f.account.invita(s,{email:'a@amr.invalid'});
  f.account.configuraAzienda(f.owner,{id:'A',scadenza:f.now(),moduli:['moto'],attiva:true});
  codice(()=>f.account.accetta(f.login('a'),{token:j.token}),'azienda_non_autorizzata');
});

test('account: appartenenza unica anche accettando inviti di aziende diverse', t => {
  const f=fixture(t);
  const a=f.account.invita(f.login('rA'),{email:'a@amr.invalid'});
  const b=f.account.invita(f.login('rB'),{email:'a@amr.invalid'});
  f.account.accetta(f.login('a'),{token:a.token});
  codice(()=>f.account.accetta(f.login('a'),{token:b.token}),'appartenenza_esistente');
  assert.equal(f.account.contesto(f.login('a')).azienda,'A');
});

test('account: collega non amministra, referente non revoca se stesso o un membro altrui', t => {
  const f=fixture(t), a=f.entra('rA','a'), b=f.entra('rB','b');
  codice(()=>f.account.invita(a,{email:'c@amr.invalid'}),'referente_richiesto');
  codice(()=>f.account.revoca(a,{persona:'rA'}),'referente_richiesto');
  codice(()=>f.account.revoca(f.login('rA'),{persona:'rA'}),'referente_non_revocabile');
  codice(()=>f.account.revoca(f.login('rA'),{persona:'b'}),'membro_non_trovato');
  assert.equal(f.account.contesto(b).azienda,'B');
});

test('account: revoca invalida tutte le sessioni e reinvito non resuscita quelle vecchie', t => {
  const f=fixture(t), old=f.entra('rA','a');
  f.account.revoca(f.login('rA'),{persona:'a'});
  codice(()=>f.account.contesto(old),'identita_non_autorizzata');
  const fresh=f.entra('rA','a');
  assert.equal(f.account.contesto(fresh).azienda,'A');
  codice(()=>f.account.contesto(old),'identita_non_autorizzata');
});

test('account: cambio referente soltanto owner con MFA, ruolo precedente declassato e quota invariata', t => {
  const f=fixture(t), a=f.entra('rA','a');
  codice(()=>f.account.cambiaReferente(f.login('rA'),{azienda:'A',persona:'a'}),'admin_mfa_richiesta');
  codice(()=>f.account.cambiaReferente(f.login('ownerNoMfa'),{azienda:'A',persona:'a'}),'admin_mfa_richiesta');
  codice(()=>f.account.cambiaReferente(f.owner,{azienda:'A',persona:'rB'}),'referente_non_valido');
  f.account.cambiaReferente(f.owner,{azienda:'A',persona:'a'});
  assert.equal(f.account.contesto(a).referente,true);
  assert.equal(f.account.contesto(f.login('rA')).referente,false);
  codice(()=>f.account.invita(f.login('rA'),{email:'c@amr.invalid'}),'referente_richiesto');
  assert.equal(f.db.prepare("SELECT count(*) n FROM membri_prova WHERE azienda='A'").get().n,2);
});

test('account: dieci aziende e trenta posti clienti, owner escluso e rollback su input invalido', t => {
  const f=fixture(t);
  for(let i=0;i<8;i++) f.account.creaAzienda(f.owner,{id:'X'+i,referente:'nuovo'+i,scadenza:f.now()+100,moduli:['moto']});
  codice(()=>f.account.creaAzienda(f.owner,{id:'troppa',referente:'nuovo8',scadenza:f.now()+100,moduli:['moto']}),'quota_aziende');
  assert.equal(f.db.prepare('SELECT count(*) n FROM aziende_prova').get().n,10);
  assert.equal(f.db.prepare("SELECT count(*) n FROM membri_prova WHERE persona='owner'").get().n,0);
  codice(()=>f.account.configuraAzienda(f.owner,{id:'A',scadenza:f.now()+100,moduli:['ricambi'],attiva:true}),'moduli_non_validi');
  assert.deepEqual(f.account.contesto(f.login('rA')).moduli,['auto','moto']);
});

module.exports = { fixture };

test('account: MFA attivata dopo login non promuove la sessione precedente; disattivazione invalida Admin',t=>{
  const f=fixture(t), old=f.login('ownerNoMfa');
  f.db.prepare("UPDATE persone_prova SET mfa=1 WHERE id='ownerNoMfa'").run();
  codice(()=>f.account.contesto(old,{admin:true}),'admin_mfa_richiesta');
  const fresh=f.login('ownerNoMfa');assert.equal(f.account.contesto(fresh,{admin:true}).admin,true);
  f.db.prepare("UPDATE persone_prova SET mfa=0 WHERE id='ownerNoMfa'").run();
  codice(()=>f.account.contesto(fresh,{admin:true}),'admin_mfa_richiesta');
});
