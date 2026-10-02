'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { applicaJournal } = require('../backend/nodi/ripristino-journal');
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clone = v => structuredClone(v);
function journal() {
  return { versione: 1, sequenza: '12', dominio: 'colleghi', operazione: id(100), tipo: 'revoca',
    confermata_il: '2026-10-02T12:00:00.123456+00:00', attore: id(1), destinatario: id(3), invito: null,
    azienda: { id: 'sintetica', nome: 'Officina sintetica', attiva: true, moduli: ['moto','auto'],
      scadenza: '2028-01-01T00:00:00Z', referente: id(2),
      accettata_il: '2026-01-01T00:00:00Z', attivata_il: '2026-01-02T00:00:00Z' },
    persone: [{ id: id(3), attiva: true, epoca: 7, membro: false },
      { id: id(2), attiva: true, epoca: 5, membro: true }] };
}

// Stato in memoria, nessuna connessione o credenziale. Il mock conserva lo
// snapshot della transazione e permette guasti anche al COMMIT/ROLLBACK.
function database() {
  let stato = {
    auth: new Set([id(1),id(2),id(3),id(4)]),
    persone: new Map([[id(1),{id:id(1),attiva:true,admin:true,epoca:20}],
      [id(2),{id:id(2),attiva:true,admin:false,epoca:9}],
      [id(3),{id:id(3),attiva:true,admin:false,epoca:2}],
      [id(4),{id:id(4),attiva:true,admin:false,epoca:11}]]),
    aziende: new Map([['sintetica',{...journal().azienda,scadenza:'2027-01-01T00:00:00Z'}]]),
    membri: new Map([[id(2),'sintetica'],[id(3),'sintetica'],[id(4),'sintetica']]),
    operazioni: new Map(), sequenze: new Map(),
    dumpSequenze: new Map([['sintetica','10']]), watermarkTabella: true,
  };
  let precedente;
  const chiamate = [];
  const client = { prima: null, guasto: null, async query(text, values = []) {
    const sql = text.replace(/\s+/g, ' ').trim();
    chiamate.push({sql,values:clone(values)});
    if (client.prima) await client.prima(sql, values);
    if (client.guasto) { const e = client.guasto(sql); if (e) throw e; }
    if (sql === 'BEGIN') { assert.equal(precedente,undefined); precedente=clone(stato); }
    else if (sql === 'COMMIT') { assert.ok(precedente); precedente=undefined; }
    else if (sql === 'ROLLBACK') { assert.ok(precedente);stato=precedente;precedente=undefined; }
    else if (/^SET |^SELECT pg_advisory|^CREATE SCHEMA|^LOCK TABLE/.test(sql)) {}
    else if (sql.startsWith('SELECT impronta,stato')) return {rows:stato.operazioni.has(values[0])?[stato.operazioni.get(values[0])]:[]};
    else if (sql.startsWith('SELECT sequenza::text FROM amr_backup.aziende_sequenza')) {
      if (!stato.watermarkTabella) throw Object.assign(new Error('tabella assente'),{code:'42P01'});
      return {rows:stato.dumpSequenze.has(values[0])?[{sequenza:stato.dumpSequenze.get(values[0])}]:[]};
    } else if (sql.startsWith('SELECT sequenza')) return {rows:stato.sequenze.has(values[0])?[{sequenza:stato.sequenze.get(values[0])}]:[]};
    else if (sql.startsWith('SELECT id FROM amr_ripristino.operazioni')) return {rows:[...stato.operazioni.values()].filter(p=>p.azienda===values[0]&&p.sequenza===values[1])};
    else if (sql.startsWith('SELECT id FROM amr_accessi.aziende')) return {rows:stato.aziende.has(values[0])?[{id:values[0]}]:[]};
    else if (sql.startsWith('SELECT id FROM auth.users')) return {rows:values[0].filter(p=>stato.auth.has(p)).map(id=>({id}))};
    else if (sql.startsWith('SELECT id,admin')) return {rows:values[0].filter(p=>stato.persone.has(p)).map(p=>stato.persone.get(p))};
    else if (sql.startsWith('SELECT persona,azienda')) return {rows:values[0].filter(p=>stato.membri.has(p)).map(persona=>({persona,azienda:stato.membri.get(persona)}))};
    else if (sql.startsWith('INSERT INTO amr_accessi.persone')) {
      const [id,attiva,epoca]=values,p=stato.persone.get(id);
      stato.persone.set(id,{id,attiva,admin:p?.admin??false,epoca:Math.max(p?.epoca??0,epoca)});
    } else if (sql.startsWith('UPDATE amr_accessi.aziende') || sql.startsWith('INSERT INTO amr_accessi.aziende')) {
      const [id,nome,attiva,moduli,scadenza,referente,accettata_il,attivata_il]=values;
      if (sql.startsWith('UPDATE')&&!stato.aziende.has(id)) return {rowCount:0,rows:[]};
      stato.aziende.set(id,{id,nome,attiva,moduli,scadenza,referente,accettata_il,attivata_il});
    } else if (sql.startsWith('DELETE FROM amr_accessi.membri')) {
      for(const [persona,azienda]of stato.membri)if(azienda===values[0])stato.membri.delete(persona);
    } else if (sql.startsWith('INSERT INTO amr_accessi.membri')) {
      assert.equal(stato.membri.has(values[0]),false);stato.membri.set(values[0],values[1]);
    } else if (sql.startsWith('INSERT INTO amr_ripristino.aziende')) stato.sequenze.set(values[0],values[1]);
    else if (sql.startsWith('INSERT INTO amr_ripristino.operazioni')) {
      const [id,azienda,sequenza,impronta,statoOp,json]=values;
      assert.equal(stato.operazioni.has(id),false);
      stato.operazioni.set(id,{id,azienda,sequenza,impronta,stato:statoOp,journal:JSON.parse(json)});
    } else assert.fail('SQL non previsto dal mock: '+sql);
    return {rowCount:1,rows:[]};
  }};
  return {client,chiamate,get stato(){return stato;}};
}
const scrittureCommerciali = d => d.chiamate.filter(c=>/^(INSERT INTO|UPDATE|DELETE FROM) amr_accessi/.test(c.sql));
const codice = v => e => e.codice===v && e.message===v && e.manuale===true;

if (require.main === module) {

test('journal offline: snapshot atomico, audit privato e massima epoca; nessun ruolo o Auth restaurato',async()=>{
  const d=database(),j=journal();
  assert.deepEqual(await applicaJournal({client:d.client,journal:j}),{stato:'applicato',giaEseguita:false});
  assert.deepEqual([...d.stato.membri],[[id(2),'sintetica']]);
  assert.equal(d.stato.persone.get(id(2)).epoca,9);assert.equal(d.stato.persone.get(id(3)).epoca,7);
  assert.deepEqual(d.stato.persone.get(id(1)),{id:id(1),attiva:true,admin:true,epoca:20});
  assert.equal(d.stato.persone.get(id(4)).epoca,11);
  assert.equal(d.stato.sequenze.get('sintetica'),'12');
  const op=d.stato.operazioni.get(j.operazione);
  assert.match(op.impronta,/^[a-f0-9]{64}$/);assert.equal(op.journal.confermata_il,'2026-10-02T12:00:00.123456Z');
  assert.equal(d.chiamate[0].sql,'BEGIN');assert.equal(d.chiamate.at(-1).sql,'COMMIT');
  const ddl=d.chiamate.find(c=>c.sql.startsWith('CREATE SCHEMA')).sql;
  assert.match(ddl,/REVOKE ALL ON SCHEMA amr_ripristino FROM PUBLIC/);
  assert.match(ddl,/REVOKE ALL ON ALL TABLES IN SCHEMA amr_ripristino FROM PUBLIC/);
  assert.ok(d.chiamate.some(c=>c.sql==='SET CONSTRAINTS ALL DEFERRED'));
  assert.ok(d.chiamate.every(c=>!/^\s*(INSERT INTO|UPDATE|DELETE FROM) auth\./.test(c.sql)));
  assert.ok(scrittureCommerciali(d).every(c=>!/(admin\s*=|inviti|operazioni)/.test(c.sql)));
  assert.ok(!d.chiamate.some(c=>c.sql.startsWith('INSERT INTO amr_accessi.aziende')));
});

test('journal: stesso op e fingerprint no-op anche dopo snapshot successivi, ordine JSON irrilevante',async()=>{
  const d=database(),j=journal();await applicaJournal({client:d.client,journal:j});
  const dopo=clone(j);dopo.operazione=id(101);dopo.sequenza='13';dopo.azienda.nome='Snapshot successivo';
  await applicaJournal({client:d.client,journal:dopo});const n=scrittureCommerciali(d).length;
  j.persone.reverse();j.azienda.moduli.reverse();j.confermata_il='2026-10-02T13:00:00.123456+01:00';
  const diversoOrdine=Object.fromEntries(Object.entries(j).reverse());
  assert.deepEqual(await applicaJournal({client:d.client,journal:diversoOrdine}),{stato:'applicato',giaEseguita:true});
  assert.equal(scrittureCommerciali(d).length,n);assert.equal(d.stato.aziende.get('sintetica').nome,'Snapshot successivo');
});

test('journal: op UUID riusato con payload diverso rifiutato; microsecondi inclusi nel fingerprint',async()=>{
  for(const cambia of [j=>{j.azienda.nome='Diversa';},j=>{j.confermata_il='2026-10-02T12:00:00.123457Z';},j=>{j.dominio='aziende';j.tipo='rinnova';}]){
    const d=database(),j=journal();await applicaJournal({client:d.client,journal:j});const prima=clone(d.stato);
    cambia(j);await assert.rejects(applicaJournal({client:d.client,journal:j}),codice('ripristino_operazione_in_conflitto'));
    assert.deepEqual(d.stato,prima);assert.equal(d.chiamate.at(-1).sql,'ROLLBACK');
  }
});

test('journal: vecchio snapshot dopo nuovo è solo audit superato, senza regressione; sequenze per azienda',async()=>{
  const d=database(),j=journal();await applicaJournal({client:d.client,journal:j});
  const vecchio=clone(j);vecchio.operazione=id(101);vecchio.sequenza='11';vecchio.azienda.attiva=false;vecchio.persone[0].epoca=1;
  const n=scrittureCommerciali(d).length;
  assert.deepEqual(await applicaJournal({client:d.client,journal:vecchio}),{stato:'superato',giaEseguita:false});
  assert.equal(scrittureCommerciali(d).length,n);assert.equal(d.stato.aziende.get('sintetica').attiva,true);
  assert.equal(d.stato.sequenze.get('sintetica'),'12');assert.equal(d.stato.persone.get(id(3)).epoca,7);
  assert.deepEqual(await applicaJournal({client:d.client,journal:vecchio}),{stato:'superato',giaEseguita:true});
  const altra=clone(j);altra.operazione=id(102);altra.sequenza='1';altra.azienda.id='altra';altra.azienda.nome='Altra sintetica';
  altra.azienda.attiva=false;altra.azienda.referente=null;altra.azienda.accettata_il=null;altra.azienda.attivata_il=null;altra.persone=[];altra.destinatario=null;
  assert.equal((await applicaJournal({client:d.client,journal:altra})).stato,'applicato');
  assert.equal(d.stato.sequenze.get('altra'),'1');
});

test('journal: stessa sequenza con op diverso confligge anche se già superata',async()=>{
  const d=database(),j=journal();await applicaJournal({client:d.client,journal:j});
  const old=clone(j);old.operazione=id(101);old.sequenza='9';await applicaJournal({client:d.client,journal:old});
  for(const seq of ['12','9']){const v=clone(j);v.operazione=id(102);v.sequenza=seq;
    await assert.rejects(applicaJournal({client:d.client,journal:v}),codice('ripristino_sequenza_in_conflitto'));}
  assert.equal(d.stato.operazioni.size,2);
});

test('journal: dump già più recente protegge dal primo replay vecchio, prima ancora dell’audit offline',async()=>{
  const d=database(),j=journal();j.sequenza='9';j.azienda.attiva=false;j.persone[0].epoca=1;
  const prima=clone(d.stato.aziende),persone=clone(d.stato.persone);
  assert.deepEqual(await applicaJournal({client:d.client,journal:j}),{stato:'superato',giaEseguita:false});
  assert.equal(scrittureCommerciali(d).length,0);assert.deepEqual(d.stato.aziende,prima);assert.deepEqual(d.stato.persone,persone);
  assert.equal(d.stato.sequenze.get('sintetica'),'10');
});

test('journal: record al watermark del dump superato, fingerprint dei retry comunque verificato',async()=>{
  const d=database(),j=journal();j.sequenza='10';
  assert.deepEqual(await applicaJournal({client:d.client,journal:j}),{stato:'superato',giaEseguita:false});
  assert.equal(scrittureCommerciali(d).length,0);assert.equal(d.stato.operazioni.get(j.operazione).stato,'superato');
  assert.deepEqual(await applicaJournal({client:d.client,journal:j}),{stato:'superato',giaEseguita:true});
  j.azienda.nome='Collisione';await assert.rejects(applicaJournal({client:d.client,journal:j}),codice('ripristino_operazione_in_conflitto'));
});

test('Kant: dump con membro revocato e audit vuoto, journal vecchio non lo riaggiunge anche senza Auth',async()=>{
  const d=database(),j=journal();j.sequenza='9';j.persone[0].membro=true;j.persone[0].epoca=0;
  d.stato.membri.delete(id(3));d.stato.persone.get(id(3)).epoca=7;d.stato.auth.delete(id(3));
  assert.equal(d.stato.operazioni.size,0);assert.equal(d.stato.sequenze.size,0);
  assert.equal((await applicaJournal({client:d.client,journal:j})).stato,'superato');
  assert.equal(d.stato.membri.has(id(3)),false);assert.equal(d.stato.persone.get(id(3)).epoca,7);
  assert.equal(scrittureCommerciali(d).length,0);
  assert.ok(!d.chiamate.some(c=>/outbox|auth\.users/.test(c.sql)));
});

test('journal: dump senza checkpoint verificabile o con journal legacy richiede riconciliazione manuale',async()=>{
  for(const prepara of [d=>{d.stato.dumpSequenze.clear();},d=>{d.stato.watermarkTabella=false;},
    d=>{d.stato.dumpSequenze.set('sintetica','non-valida');}]){
    const d=database();prepara(d);const prima=clone(d.stato);
    await assert.rejects(applicaJournal({client:d.client,journal:journal()}),codice('ripristino_base_non_verificabile'));
    assert.deepEqual(d.stato,prima);assert.equal(scrittureCommerciali(d).length,0);
  }
});

test('journal: bigint esatto fino al massimo PG, numeri JS non sicuri rifiutati prima di SQL',async()=>{
  const d=database(),j=journal();j.sequenza='9223372036854775807';
  await applicaJournal({client:d.client,journal:j});assert.equal(d.stato.sequenze.get('sintetica'),j.sequenza);
  const old=clone(j);old.sequenza='9223372036854775806';old.operazione=id(101);
  assert.equal((await applicaJournal({client:d.client,journal:old})).stato,'superato');
  for(const seq of [0,1,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'0','01','9223372036854775808',{},null]){
    const altro=database();j.sequenza=seq;await assert.rejects(applicaJournal({client:altro.client,journal:j}),codice('ripristino_journal_non_valido'));
    assert.equal(altro.chiamate.length,0);
  }
});

test('journal: identità Auth mancanti richiedono intervento manuale senza creare utenti',async()=>{
  for(const persona of [id(1),id(2),id(3),id(4)]){
    const d=database(),j=journal();j.invito={id:id(500),stato:'accettato',scadenza:'2026-01-08T00:00:00Z',persona:id(4)};
    d.stato.auth.delete(persona);const prima=clone(d.stato);
    await assert.rejects(applicaJournal({client:d.client,journal:j}),codice('ripristino_identita_mancante'));
    assert.deepEqual(d.stato,prima);assert.equal(d.stato.operazioni.size,0);assert.equal(scrittureCommerciali(d).length,0);
  }
});

test('journal: persona commerciale assente con Auth presente creata con Admin false',async()=>{
  const d=database(),j=journal();d.stato.persone.delete(id(3));d.stato.membri.delete(id(3));
  await applicaJournal({client:d.client,journal:j});
  assert.deepEqual(d.stato.persone.get(id(3)),{id:id(3),attiva:true,epoca:7,admin:false});
});

test('journal: appartenenza a un’altra azienda confligge anche per un destinatario rimosso',async()=>{
  for(const persona of [id(2),id(3)]){
    const d=database();d.stato.membri.set(persona,'altra');const prima=clone(d.stato);
    await assert.rejects(applicaJournal({client:d.client,journal:journal()}),codice('ripristino_appartenenza_in_conflitto'));
    assert.deepEqual(d.stato,prima);assert.equal(scrittureCommerciali(d).length,0);
  }
});

test('journal: Admin esistente non diventa membro; trasferimento referente interno consentito',async()=>{
  const d=database();d.stato.persone.get(id(2)).admin=true;const prima=clone(d.stato);
  await assert.rejects(applicaJournal({client:d.client,journal:journal()}),codice('ripristino_appartenenza_in_conflitto'));
  assert.deepEqual(d.stato,prima);
  const altro=database(),j=journal();j.tipo='cambia_referente';j.azienda.referente=id(3);j.persone[0].membro=true;
  await applicaJournal({client:altro.client,journal:j});assert.equal(altro.stato.aziende.get('sintetica').referente,id(3));
  assert.equal(altro.stato.membri.get(id(2)),'sintetica');assert.equal(altro.stato.membri.get(id(3)),'sintetica');
});

test('journal: nuova azienda ripristinata senza usare le funzioni live o creare inviti',async()=>{
  const d=database(),j=journal();d.stato.aziende.clear();d.stato.membri.clear();d.stato.dumpSequenze.clear();
  j.dominio='aziende';j.tipo='attiva';j.invito={id:id(500),stato:'accettato',scadenza:'2026-01-08T00:00:00Z',persona:id(2)};
  await applicaJournal({client:d.client,journal:j});
  assert.equal(d.stato.aziende.size,1);assert.deepEqual(d.stato.operazioni.get(j.operazione).journal.invito,{...j.invito,scadenza:'2026-01-08T00:00:00.000000Z'});
  assert.equal(d.chiamate.filter(c=>c.sql.startsWith('INSERT INTO amr_accessi.aziende')).length,1);
  assert.ok(scrittureCommerciali(d).every(c=>!/(?:inviti|operazioni|scrivi)/.test(c.sql)));
  j.operazione=id(101);j.sequenza='13';
  await applicaJournal({client:d.client,journal:j});
  assert.equal(d.stato.sequenze.get('sintetica'),'13');assert.equal(d.stato.dumpSequenze.has('sintetica'),false);
});

test('journal: watermark richiesto anche per retry già auditato; monotonicità anche dopo nuovi dump',async()=>{
  const d=database(),j=journal();await applicaJournal({client:d.client,journal:j});
  d.stato.watermarkTabella=false;
  await assert.rejects(applicaJournal({client:d.client,journal:j}),codice('ripristino_base_non_verificabile'));
  d.stato.watermarkTabella=true;d.stato.dumpSequenze.set('sintetica','15');
  assert.deepEqual(await applicaJournal({client:d.client,journal:j}),{stato:'superato',giaEseguita:true});
  const altro=clone(j);altro.operazione=id(102);altro.sequenza='14';
  assert.equal((await applicaJournal({client:d.client,journal:altro})).stato,'superato');
  assert.equal(d.stato.sequenze.get('sintetica'),'15');
  assert.ok(d.chiamate.every(c=>!/(INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE).*amr_backup\.aziende_sequenza/.test(c.sql)));
});

test('journal: ogni valore è parametrizzato, nome con apostrofi non diventa SQL',async()=>{
  const d=database(),j=journal();j.azienda.nome="Officina O'Brien; SELECT 42";
  await applicaJournal({client:d.client,journal:j});
  assert.ok(d.chiamate.every(c=>!c.sql.includes(j.azienda.nome)&&!c.sql.includes(j.operazione)));
  assert.equal(d.stato.aziende.get('sintetica').nome,j.azienda.nome);
  assert.ok(d.chiamate.some(c=>c.values.includes(j.azienda.nome)));
});

test('journal: errori durante scrittura e vincoli al COMMIT fanno rollback completo senza dettagli SQL',async()=>{
  for(const fase of ['INSERT INTO amr_accessi.membri','COMMIT']){
    const d=database(),prima=clone(d.stato);
    d.client.guasto=sql=>sql.startsWith(fase)?Object.assign(new Error('dettaglio SQL privato'),{code:'23503'}):null;
    await assert.rejects(applicaJournal({client:d.client,journal:journal()}),codice('ripristino_vincolo_in_conflitto'));
    assert.deepEqual(d.stato,prima);assert.equal(d.chiamate.at(-1).sql,'ROLLBACK');
    d.client.guasto=null;assert.equal((await applicaJournal({client:d.client,journal:journal()})).stato,'applicato');
  }
});

test('journal: rollback fallito rende il client inutilizzabile senza retry implicito',async()=>{
  const d=database();d.client.guasto=sql=>sql==='COMMIT'||sql==='ROLLBACK'?new Error('errore privato'):null;
  await assert.rejects(applicaJournal({client:d.client,journal:journal()}),codice('ripristino_rollback_non_disponibile'));
  const n=d.chiamate.length;await assert.rejects(applicaJournal({client:d.client,journal:journal()}),codice('ripristino_client_non_utilizzabile'));
  assert.equal(d.chiamate.length,n);
});

test('journal: allowlist stretta, niente campi Admin, email, token o payload liberi prima di SQL',async()=>{
  const mutazioni=[j=>{j.versione=2;},j=>{j.dominio='auth';},j=>{j.dominio=new String('aziende');},j=>{j.tipo='esegui_sql';},
    j=>{j.email='campo vietato';},j=>{j.azienda.token='campo vietato';},j=>{j.persone[0].admin=true;},
    j=>{j.persone[0].epoca=2147483648;},j=>{j.persone[0].membro=1;},j=>{j.persone.push(clone(j.persone[0]));},
    j=>{j.azienda.referente=id(4);},j=>{j.operazione={toString:()=>id(100)};},j=>{j.attore='non-uuid';},
    j=>{j.azienda.moduli=['moto','moto'];},j=>{j.azienda.moduli=['cloud'];},j=>{j.azienda.attiva='true';},
    j=>{j.azienda.nome=' nome ';},j=>{j.azienda.id='sintetica;';},j=>{delete j.destinatario;},j=>{j.persone={};},
    j=>{j.invito={id:id(500),stato:'pending',scadenza:'2026-01-08T00:00:00Z',persona:id(3)};}];
  for(const muta of mutazioni){const d=database(),j=journal();muta(j);
    await assert.rejects(applicaJournal({client:d.client,journal:j}),codice('ripristino_journal_non_valido'));assert.equal(d.chiamate.length,0);}
  for(const j of [null,[],{}]){const d=database();await assert.rejects(applicaJournal({client:d.client,journal:j}),codice('ripristino_journal_non_valido'));assert.equal(d.chiamate.length,0);}
});

test('journal: date reali, finite con timezone, ordine aziendale e dimensione massima validati',async()=>{
  const date=['2026-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-00-01T00:00:00Z','2026-01-00T00:00:00Z',
    '2026-01-01T24:00:00Z','2026-01-01T00:60:00Z','2026-01-01T00:00:00+16:00','2026-01-01T00:00:00',
    'infinity','2026-01-01T00:00:00.1234567Z'];
  for(const data of date){const d=database(),j=journal();j.confermata_il=data;
    await assert.rejects(applicaJournal({client:d.client,journal:j}),codice('ripristino_journal_non_valido'));assert.equal(d.chiamate.length,0);}
  const d=database(),j=journal();j.azienda.scadenza=j.azienda.attivata_il;
  await assert.rejects(applicaJournal({client:d.client,journal:j}),codice('ripristino_journal_non_valido'));
  const enorme=journal();enorme.persone.push(...Array.from({length:300},(_,i)=>({id:id(i+1000),attiva:true,epoca:0,membro:false})));
  await assert.rejects(applicaJournal({client:d.client,journal:enorme}),codice('ripristino_journal_non_valido'));assert.equal(d.chiamate.length,0);
});

test('journal: nessuna intercalazione di transazioni sullo stesso client o mutazione tardiva del payload',async()=>{
  const d=database(),j=journal();let completa;
  d.client.prima=sql=>sql==='BEGIN'?new Promise(r=>{completa=r;}):null;
  const avvio=applicaJournal({client:d.client,journal:j});assert.ok(completa);
  await assert.rejects(applicaJournal({client:d.client,journal:j}),codice('ripristino_client_occupato'));
  j.azienda.nome='Modificata durante await';j.persone[1].membro=false;j.azienda.moduli.length=0;
  completa();await avvio;
  assert.equal(d.stato.aziende.get('sintetica').nome,'Officina sintetica');assert.equal(d.stato.membri.get(id(2)),'sintetica');
  assert.equal(d.chiamate.filter(c=>c.sql==='BEGIN').length,1);assert.equal(d.chiamate.filter(c=>c.sql==='COMMIT').length,1);
});

test('journal: errori di client e database sanitizzati, nessuna gestione delle connessioni esterna',async()=>{
  for(const client of [undefined,{}, {query:1}])await assert.rejects(applicaJournal({client,journal:journal()}),codice('ripristino_client_non_valido'));
  const d=database();d.client.guasto=sql=>sql==='BEGIN'?new Error('errore PG privato'):null;
  await assert.rejects(applicaJournal({client:d.client,journal:journal()}),codice('ripristino_non_disponibile'));
  assert.equal(d.chiamate.length,1);
});

}

// MAIN invoca questa regression sul DB appena ripristinato e separato, prima
// di qualsiasi replay. Nessuna connessione/env/Auth inventata. Il prune è solo
// della fixture; richiede un dump che contenga già la revoca e il suo watermark.
async function provaJournalAntecedenteDump({client,journal:vecchio,personaRevocata}) {
  assert.equal(vecchio.persone.some(p=>p.id===personaRevocata&&p.membro),true);
  const azienda=vecchio.azienda.id;
  const audit=(await client.query("SELECT to_regclass('amr_ripristino.operazioni') AS tabella")).rows[0].tabella;
  if(audit)assert.equal((await client.query('SELECT count(*)::int n FROM amr_ripristino.operazioni')).rows[0].n,0);
  const watermark=(await client.query('SELECT sequenza::text FROM amr_backup.aziende_sequenza WHERE azienda=$1',[azienda])).rows[0].sequenza;
  assert.ok(BigInt(vecchio.sequenza)<=BigInt(watermark));
  const leggi=async()=>({
    azienda:(await client.query(`SELECT id,nome,attiva,moduli,scadenza,referente,accettata_il,attivata_il
      FROM amr_accessi.aziende WHERE id=$1`,[azienda])).rows,
    membri:(await client.query('SELECT persona,azienda FROM amr_accessi.membri WHERE azienda=$1 ORDER BY persona',[azienda])).rows,
    persone:(await client.query('SELECT id,attiva,admin,epoca FROM amr_accessi.persone WHERE id=ANY($1::uuid[]) ORDER BY id',
      [vecchio.persone.map(p=>p.id)])).rows,
  });
  const prima=await leggi();assert.equal(prima.membri.some(p=>p.persona===personaRevocata),false);
  await client.query("DELETE FROM amr_backup.outbox WHERE categoria='journal' AND journal->'azienda'->>'id'=$1",[azienda]);
  assert.equal((await client.query("SELECT count(*)::int n FROM amr_backup.outbox WHERE categoria='journal' AND journal->'azienda'->>'id'=$1",[azienda])).rows[0].n,0);
  assert.deepEqual(await applicaJournal({client,journal:vecchio}),{stato:'superato',giaEseguita:false});
  assert.deepEqual(await leggi(),prima);
  assert.deepEqual(await applicaJournal({client,journal:vecchio}),{stato:'superato',giaEseguita:true});
  assert.deepEqual(await leggi(),prima);
  assert.equal((await client.query('SELECT sequenza::text FROM amr_backup.aziende_sequenza WHERE azienda=$1',[azienda])).rows[0].sequenza,watermark);
  assert.equal((await client.query('SELECT sequenza::text FROM amr_ripristino.aziende WHERE azienda=$1',[azienda])).rows[0].sequenza,watermark);
  // Verifica la revoca PUBLIC effettiva dei nuovi oggetti, senza assumere ACL mock.
  const pubblico=(await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE n.nspname='amr_ripristino' AND c.relkind='r' AND a.grantee=0
    UNION ALL SELECT 1 FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='amr_ripristino' AND a.grantee=0) AS accessibile`)).rows[0].accessibile;
  assert.equal(pubblico,false);
  return 'PG: dump con revoca, audit vuoto e outbox pruned; journal vecchio superato senza ripristinare membership o epoca; retry e ACL PUBLIC verificati';
}

module.exports={provaJournalAntecedenteDump};
