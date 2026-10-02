'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { creaColleghiPostgres } = require('../backend/nodi/colleghi-postgres-prova');
const persona = crypto.randomUUID(), collega = crypto.randomUUID();
const sessione = {persona,epoca:4,mfa:false};
const richiesta = () => ({id:'prova',operazione:crypto.randomUUID()});
test('colleghi: invito parametrizzato, token casuale mai inviato al database',async()=>{
  const chiamate=[];
  const account=creaColleghiPostgres({pool:{query:async(sql,params)=>{
    chiamate.push({sql,params}); return {rows:[{risultato:{giaEseguita:false,tokenDisponibile:true}}]};
  }}});
  const out=await account.invita(sessione,{...richiesta(),email:'Collega@AMR.invalid',admin:true});
  assert.match(out.token,/^[a-f0-9]{64}$/);
  assert.equal(chiamate.length,1); assert.ok(chiamate[0].sql.includes('$9::text'));
  assert.equal(chiamate[0].params[5],'invita'); assert.equal(chiamate[0].params[7],'collega@amr.invalid');
  assert.equal(chiamate[0].params[8],crypto.createHash('sha256').update(out.token).digest('hex'));
  assert.equal(chiamate[0].params.includes(out.token),false);
});
test('colleghi: input e identità malformati non raggiungono SQL',async()=>{
  let chiamate=0;
  const account=creaColleghiPostgres({pool:{query:async()=>{chiamate++;}}});
  const input=richiesta();
  for (const s of [null,{...sessione,epoca:-1},{...sessione,mfa:'true'},{...sessione,persona:'cliente'}]) {
    await assert.rejects(account.invita(s,{...input,email:'c@amr.invalid'}),{codice:'accesso_non_autorizzato'});
  }
  for (const email of ['a@b.invalid\n','a@b.invalid\0','no-email',3,'a'.repeat(255)+'@amr.invalid']) {
    await assert.rejects(account.invita(sessione,{...input,email}),{codice:'input_non_valido'});
  }
  await assert.rejects(account.revoca(sessione,{...input,persona:"'; DELETE FROM membri;--"}),{codice:'input_non_valido'});
  await assert.rejects(account.accetta(persona,{operazione:input.operazione,token:'invalido'}),{codice:'invito_non_valido'});
  await assert.rejects(account.accetta(persona,{token:'a'.repeat(64)}),{codice:'input_non_valido'});
  await assert.rejects(account.elenco(sessione,{id:['prova']}),{codice:'input_non_valido'});
  assert.equal(chiamate,0);
});
test('colleghi: verbi fissi, epoca e MFA provengono dalla sessione server',async()=>{
  const chiamate=[];
  const account=creaColleghiPostgres({pool:{query:async(sql,params)=>{
    chiamate.push({sql,params});return{rows:[{risultato:{ok:true}}]};
  }}});
  const input={...richiesta(),persona:collega,invito:collega,epoca:999,mfa:true,tipo:'invita'};
  await account.revoca(sessione,input); await account.revocaInvito(sessione,input);
  await account.cambiaReferente(sessione,input); await account.elenco(sessione,input);
  assert.deepEqual(chiamate.slice(0,3).map(c=>c.params[5]),['revoca','revoca_invito','cambia_referente']);
  for (const c of chiamate) assert.deepEqual(c.params.slice(0,3),[persona,4,false]);
  for (const c of chiamate.slice(0,3)) assert.deepEqual(c.params.slice(-3),[collega,null,null]);
});
test('colleghi: retry non restituisce un nuovo token, errori SQL depurati',async()=>{
  let risultato={rows:[{risultato:{giaEseguita:true,tokenDisponibile:true}}]};
  const account=creaColleghiPostgres({pool:{query:async()=>{
    if (risultato instanceof Error) throw risultato; return risultato;
  }}});
  const input={...richiesta(),email:'c@amr.invalid'};
  assert.equal(Object.hasOwn(await account.invita(sessione,input),'token'),false);
  risultato=Object.assign(new Error('quota_persone'),{code:'P0001',detail:'contenuto-riservato'});
  await assert.rejects(account.invita(sessione,input),e=>e.codice==='quota_persone' && e.status===409 && !e.detail && !e.cause);
  risultato=Object.assign(new Error('dettaglio-riservato'),{code:'23505'});
  await assert.rejects(account.invita(sessione,input),{message:'operazione_non_disponibile',status:503});
});
test('colleghi: limite delle Promise pendenti, slot recuperato dopo errore',async()=>{
  const attese=[];
  const account=creaColleghiPostgres({pool:{query:()=>new Promise((resolve,reject)=>attese.push({resolve,reject}))}});
  const input=richiesta();
  const lavori=Array.from({length:32},()=>account.elenco(sessione,input).catch(e=>e));
  await assert.rejects(account.elenco(sessione,input),{status:503}); assert.equal(attese.length,32);
  attese[0].reject(new Error('KO')); await lavori[0];
  const nuovo=account.elenco(sessione,input);
  attese.slice(1).forEach(v=>v.resolve({rows:[{risultato:{ok:true}}]}));
  await nuovo; await Promise.all(lavori);
});
