'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configura, totp } = require('../scripts/collauda-nhost-locale');

test('collaudo Nhost: SIGTERM iniziale cancella avvio e svolge cleanup una sola volta', async () => {
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
  const processo=new EventEmitter(); processo.env={AMR_NHOST_DOCKER_HOST:'unix:///synthetic/amr-auth/docker.sock'};
  const modulo={exports:{}}, calls=[];let abort;
  const source=fs.readFileSync(path.join(__dirname,'../scripts/collauda-nhost-locale.js'),'utf8')
    .replace(/module.exports = \{[^\n]+\};/,
      'module.exports = { collauda };');
  vm.runInNewContext(source,{module:modulo,process:processo,__dirname:path.join(__dirname,'../scripts'),
    AbortController,AbortSignal,Buffer,URL,console:{log(){},error(){}},setTimeout,clearTimeout,
    require:name=>name==='node:fs'?{mkdtempSync:()=>'/synthetic',chmodSync(){},writeFileSync(){},rmSync(){calls.push('rimossa');}}
      :name==='node:util'?{promisify:()=>async(_bin,args,opts)=>{
        if(args.includes('down')){assert.equal(opts.signal,undefined);calls.push('down');return{stdout:''};}
        calls.push('up');return new Promise((_,reject)=>{opts.signal.addEventListener('abort',()=>reject(Error('abort')),{once:true});abort=()=>processo.emit('SIGTERM');});
      }}:require(name)});
  const pending=modulo.exports.collauda();assert.ok(abort);abort();abort();
  await assert.rejects(pending,/Collaudo interrotto/);
  assert.deepEqual(calls,['up','down','rimossa']);assert.equal(processo.listenerCount('SIGTERM'),0);
});

test('collaudo Nhost: soltanto Auth e mail locali sono pubblicati, nessun file host montato', () => {
  const c = configura({ password: 'sintetica', jwt: 'sintetico', admin: 'sintetico' });
  for (const [nome, servizio] of Object.entries(c.services)) {
    assert.ok(!servizio.volumes?.length);
    if (['postgres', 'graphql'].includes(nome)) assert.ok(!servizio.ports?.length);
    for (const porta of servizio.ports || []) assert.match(porta, /^127\.0\.0\.1:0:/);
  }
  assert.deepEqual(c.services.postgres.tmpfs, ['/var/lib/postgresql/data']);
});

test('collaudo Nhost: verifica email, MFA e destinatari SMTP soltanto locali', () => {
  const env = configura({ password: 'sintetica', jwt: 'sintetico', admin: 'sintetico' }).services.auth.environment;
  assert.equal(env.AUTH_EMAIL_SIGNIN_EMAIL_VERIFIED_REQUIRED, 'true');
  assert.equal(env.AUTH_MFA_ENABLED, 'true');
  assert.equal(env.AUTH_ANONYMOUS_USERS_ENABLED, 'false');
  assert.equal(env.AUTH_SMTP_HOST, 'localhost');
  assert.equal(configura({}).services.auth.network_mode, 'service:mail');
  assert.equal(env.AUTH_GRAVATAR_ENABLED, 'false');
  assert.equal(env.AUTH_PASSWORD_HIBP_ENABLED, 'false');
});

test('il generatore TOTP di prova rispetta il vettore RFC 6238 SHA1 a 59 secondi', () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
});

test('posta del collaudo: non decodificare =AF come quoted-printable in un URL 7bit', () => {
  const { corpoMailLocale } = require('../scripts/collauda-nhost-locale');
  const url = 'http://127.0.0.1:5555/verify?codeChallenge=AF' + 'x'.repeat(41);
  for(const encoding of ['7bit','8bit','binary','']) {
    assert.equal(corpoMailLocale({Content:{Body:url,Headers:{'Content-Transfer-Encoding':[encoding]}}}),url);
  }
  const qp = url.replace('=', '=3D').slice(0,40)+'=\r\n'+url.replace('=', '=3D').slice(40);
  assert.equal(corpoMailLocale({Content:{Body:qp,Headers:{'Content-Transfer-Encoding':['quoted-printable']}}}),url);
  assert.equal(corpoMailLocale({Content:{Body:Buffer.from(url).toString('base64'),Headers:{'content-transfer-encoding':['base64']}}}),url);
});


test('collaudo centro PostgreSQL: accesso driver pubblicato solo su loopback e su porta casuale', () => {
  const c = configura({ password:'sintetica', postgresDiretto:true });
  assert.deepEqual(c.services.postgres.ports,['127.0.0.1:0:5432']);
  assert.ok(!c.services.graphql.ports?.length);
});

test('collaudo manuale: file dedicato, password letterale e ambiente del processo invariato', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { credenzialiLocali } = require('../scripts/collauda-nhost-locale');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-env-test-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const file = path.join(dir, '.env');
  const password = 'test # $() collaudo';
  fs.writeFileSync(file, 'AMR_COLLAUDO_EMAIL="prova@amr.invalid"\nAMR_COLLAUDO_PASSWORD="' + password + '"\n', {mode:0o600});
  const prima = {...process.env};
  assert.deepEqual(credenzialiLocali(file), {email:'prova@amr.invalid',password});
  assert.deepEqual({...process.env}, prima);
});

test('collaudo manuale: mancanza, password vuota e chiavi estranee falliscono senza valori nei messaggi', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { credenzialiLocali } = require('../scripts/collauda-nhost-locale');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-env-test-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const file = path.join(dir, '.env');
  assert.throws(() => credenzialiLocali(file), /assente/);
  for (const text of [
    'AMR_COLLAUDO_EMAIL=prova@amr.invalid\nAMR_COLLAUDO_PASSWORD=',
    'AMR_COLLAUDO_EMAIL=<script>@amr.invalid\nAMR_COLLAUDO_PASSWORD=segreto-test-lungo',
    'AMR_COLLAUDO_EMAIL=prova@amr.invalid\nAMR_COLLAUDO_PASSWORD=segreto-test-lungo\nAMR_ADMIN_PASSWORD=non_leggere',
    'AMR_COLLAUDO_EMAIL=prova@amr.invalid\nAMR_COLLAUDO_PASSWORD="prima-riga-valida\nseconda-riga"',
  ]) {
    fs.writeFileSync(file,text,{mode:0o600});
    assert.throws(() => credenzialiLocali(file), e => !e.message.includes('segreto-test') && !e.message.includes('non_leggere'));
  }
});

test('collaudo manuale: file leggibile dagli altri utenti viene rifiutato', {skip:process.platform==='win32'}, t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { credenzialiLocali } = require('../scripts/collauda-nhost-locale');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-env-test-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'.env');
  fs.writeFileSync(file,'AMR_COLLAUDO_EMAIL=prova@amr.invalid\nAMR_COLLAUDO_PASSWORD=solo-test-password',{mode:0o600});
  fs.chmodSync(file,0o644);
  assert.throws(() => credenzialiLocali(file), /permessi 600/);
});
