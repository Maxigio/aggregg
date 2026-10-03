'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const https = require('node:https'), net = require('node:net');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

// Caricato dal launcher solo su richiesta: nessun main, .env, build o pull.
// Il proxy usa la stessa immagine fidata; legge solo la propria fixture TLS.
const PROXY_TLS = String.raw`
'use strict';
const fs=require('node:fs'),http=require('node:http'),https=require('node:https');
const server=https.createServer({key:fs.readFileSync('/fixture/key.pem'),
  cert:fs.readFileSync('/fixture/cert.pem')},(req,res)=>{
  let upstream;
  const fallisci=()=>{if(!res.headersSent)res.writeHead(502);res.end('fixture non disponibile');};
  try {
    const headers={...req.headers};
    const hop=new Set(['connection','proxy-connection','keep-alive','te','trailer',
      'transfer-encoding','upgrade','proxy-authorization','proxy-authenticate',
      ...String(req.headers.connection||'').toLowerCase().split(',').map(v=>v.trim())]);
    for(const k of Object.keys(headers)) {
      if(hop.has(k)||k==='forwarded'||k==='x-real-ip'||k.startsWith('x-forwarded-'))delete headers[k];
    }
    headers.host=req.headers.host;headers['x-forwarded-proto']='https';
    const auth=req.url==='/v1'||req.url.startsWith('/v1/')||req.url.startsWith('/v1?');
    upstream=http.request({hostname:auth?'mail':'centro',port:auth?4000:3000,
      path:req.url,method:req.method,headers,agent:false},r=>{
      res.writeHead(r.statusCode,r.headers);r.on('error',()=>res.destroy());r.pipe(res);
    });
    upstream.setTimeout(15000,()=>upstream.destroy());
    upstream.on('error',fallisci);req.on('aborted',()=>upstream.destroy());
    res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});req.pipe(upstream);
  }catch{upstream?.destroy();fallisci();}
});
server.requestTimeout=20000;server.headersTimeout=10000;
server.on('clientError',(_e,s)=>s.destroy());
server.listen(4443,'0.0.0.0');
process.once('SIGTERM',()=>{server.close();server.closeAllConnections();});
`;

async function collaudaImmagine({ host, docker, directory, image, readerPassword,
  writerPassword, backupPassword, email, password, totpSecret, persona, referente, sql, signal } = {}) {
  let fase = 'parametri', work, esito, fallimento;
  const risorse = [], collegamenti = [];
  const nonce = crypto.randomBytes(8).toString('hex');
  const rete = 'amr-centro-gate-' + nonce, centro = rete + '-centro', tls = rete + '-tls';
  const ingresso = rete + '-ingresso';
  const volume = rete + '-dati', volumeTls = rete + '-tls-file', label = 'amr.collaudo.immagine';
  let cliEnv;
  // Ogni errore attraversa il guard finale: mai Error/stdout/stderr o cause raw.
  const cli = async (args, cleanup = false, timeout = 30000) => {
    const result = await run('docker', ['--host', host, ...args], {
      env: cliEnv, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      ...(!cleanup && signal ? { signal } : {})
    });
    return result.stdout.trim();
  };
  const controlla = condizione => { if (!condizione) throw new Error('fixture_non_valida'); };
  const pausa = ms => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('annullato'));
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('annullato')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    controlla(typeof host === 'string' && /^unix:\/\/\/[^\r\n\0]+\/amr-auth\/docker\.sock$/.test(host));
    controlla(typeof docker === 'function' && typeof sql === 'function');
    // Un tag locale approvato dal chiamante, senza registry, digest remoto o pull implicito.
    controlla(typeof image === 'string' && /^amr-centro:[a-z0-9][a-z0-9_.-]{0,79}$/.test(image));
    controlla(typeof directory === 'string' && path.isAbsolute(directory) && !/[\r\n\0,]/.test(directory));
    const stat = fs.lstatSync(directory);
    controlla(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
    controlla(typeof process.getuid === 'function' && typeof process.getgid === 'function' && stat.uid === process.getuid());
    for (const valore of [readerPassword,writerPassword,backupPassword]) {
      controlla(typeof valore === 'string' && valore.length >= 16 && valore.length <= 200 && !/[\r\n\0]/.test(valore));
    }
    controlla(typeof email === 'string' && /^[a-zA-Z0-9._%+-]+@amr\.invalid$/.test(email) && email.length <= 254);
    controlla(typeof password === 'string' && password.length >= 15 && password.length <= 50 && !/[\r\n\0]/.test(password));
    controlla(referente && typeof referente.email === 'string'
      && /^[a-zA-Z0-9._%+-]+@amr\.invalid$/.test(referente.email) && referente.email.length <= 254
      && referente.email !== email);
    controlla(typeof referente.password === 'string' && referente.password.length >= 15
      && referente.password.length <= 50 && !/[\r\n\0]/.test(referente.password));
    controlla(typeof totpSecret === 'string' && /^[A-Z2-7]{16,128}={0,6}$/.test(totpSecret));
    controlla(typeof persona === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(persona));
    controlla(!signal || (typeof signal.addEventListener === 'function' && !signal.aborted));
    work = fs.mkdtempSync(path.join(fs.realpathSync(directory), 'centro-immagine-'));
    fs.chmodSync(work, 0o700);
    const dockerConfig = path.join(work, 'docker-config'); fs.mkdirSync(dockerConfig, { mode: 0o700 });
    // Niente ambiente applicativo o configurazione/credenziali Docker dell'utente.
    cliEnv = { PATH: process.env.PATH, LANG: 'C', DOCKER_CONFIG: dockerConfig };

    fase = 'fixture e immagine locale';
    controlla(String(await sql(`SELECT count(*) FROM amr_accessi.persone p JOIN auth.users u ON u.id=p.id
      WHERE p.id='${persona}' AND p.admin AND p.attiva AND u.email_verified AND NOT u.disabled;`)).trim() === '1');
    const imageId = await cli(['image','inspect','--format','{{.Id}}',image]);
    controlla(/^sha256:[a-f0-9]{64}$/.test(imageId));
    const ids = {};
    let progetto;
    for (const servizio of ['postgres','mail']) {
      const id = String(await docker('ps','-q',servizio)).trim();
      controlla(/^[a-f0-9]{64}$/.test(id)); ids[servizio] = id;
      const info = (await cli(['container','inspect','--format',
        '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}',id])).split('|');
      controlla(/^amr-auth-[a-z0-9-]+$/.test(info[0]) && info[1] === servizio);
      if (progetto) controlla(progetto === info[0]); else progetto = info[0];
    }
    controlla(ids.postgres !== ids.mail);

    fase = 'certificato e proxy TLS';
    const fixture = path.join(work, 'tls'); fs.mkdirSync(fixture, { mode: 0o700 });
    const cert = path.join(fixture, 'cert.pem'), key = path.join(fixture, 'key.pem');
    const openssl = path.join(fixture, 'openssl.cnf');
    fs.writeFileSync(openssl, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n'
      + '[dn]\nCN=tls\n[ext]\nsubjectAltName=DNS:tls,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n'
      + 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n', { mode: 0o600, flag: 'wx' });
    await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',openssl,
      '-keyout',key,'-out',cert],{ env:{PATH:process.env.PATH,LANG:'C'}, timeout:15000,
      maxBuffer:65536, killSignal:'SIGKILL', ...(signal ? {signal} : {}) });
    fs.chmodSync(key,0o600);fs.chmodSync(cert,0o644);
    fs.writeFileSync(path.join(fixture,'proxy.js'),PROXY_TLS,{mode:0o600,flag:'wx'});
    const ca = fs.readFileSync(cert);
    // Registrare anche i tentativi: un timeout CLI può seguire una creazione riuscita.
    risorse.push(['network',rete]);
    await cli(['network','create','--internal','--label',label+'='+nonce,rete]);
    // Una rete internal non pubblica porte: solo il proxy entra nel bridge di ingresso.
    risorse.push(['network',ingresso]);
    await cli(['network','create','--label',label+'='+nonce,ingresso]);
    for (const servizio of ['postgres','mail']) {
      collegamenti.push(ids[servizio]);
      await cli(['network','connect','--alias',servizio,rete,ids[servizio]]);
    }
    risorse.push(['volume',volume]);
    await cli(['volume','create','--label',label+'='+nonce,volume]);
    risorse.push(['volume',volumeTls]);
    await cli(['volume','create','--label',label+'='+nonce,volumeTls]);
    const limiti = ['--pull','never','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
      '--pids-limit','128','--cpus','1','--memory','512m','--log-driver','none','--label',label+'='+nonce];
    risorse.push(['container',tls]);
    await cli(['create','--name',tls,...limiti,'--network',ingresso,
      '--user',process.getuid()+':'+process.getgid(),'--publish','127.0.0.1::4443',
      '--mount','type=volume,src='+volumeTls+',dst=/fixture','--entrypoint','node',imageId,'/fixture/proxy.js']);
    // Docker può vivere in una VM senza condividere il TMPDIR dell'host.
    // cp trasferisce solo questi file sintetici, preservando l'owner della fixture.
    await cli(['cp','-a',fixture+'/.',tls+':/fixture']);
    await cli(['network','connect','--alias','tls',rete,tls]);
    await cli(['start',tls]);
    const porta = async (nome,interna) => {
      const address = await cli(['port',nome,String(interna)]);
      controlla(/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(address));
      const p = Number(address.split(':')[1]);controlla(p <= 65535);return p;
    };
    const tlsPort = await porta(tls,4443), origine = 'https://127.0.0.1:'+tlsPort;
    const proxyIP = await cli(['container','inspect','--format',
      '{{(index .NetworkSettings.Networks "'+rete+'").IPAddress}}',tls]);
    controlla(net.isIP(proxyIP) === 4);

    fase = 'avvio centro con configurazione esplicita';
    // Due nodi permettono prove indipendenti: sospensione e revoca del token.
    const tokens = { locale:crypto.randomBytes(32).toString('hex'), revocabile:crypto.randomBytes(32).toString('hex') };
    const ambiente = { NODE_ENV:'production', PORT:'3000', NODE_EXTRA_CA_CERTS:'/var/lib/amr/fixture-ca.pem',
      AMR_NODI_RELEASE_FILE:'/opt/amr/release.json', AMR_NODI_DATA_DIR:'/var/lib/amr',
      AMR_CENTRO_ORIGINE:origine, AMR_NHOST_AUTH_URL:'https://tls:4443/v1', AMR_CENTRO_PROXY_IP:proxyIP,
      AMR_CENTRO_REPLICHE:'1', AMR_NODI_TOKENS:JSON.stringify(tokens),
      AMR_PG_HOST:'postgres',AMR_PG_PORT:'5432',AMR_PG_DATABASE:'postgres',AMR_PG_RETE_PRIVATA:'1',
      AMR_PG_LETTURA_USER:'amr_gateway',AMR_PG_LETTURA_PASSWORD:readerPassword,
      AMR_PG_COMMERCIALE_USER:'amr_commerciale',AMR_PG_COMMERCIALE_PASSWORD:writerPassword,
      AMR_PG_BACKUP_USER:'amr_copie',AMR_PG_BACKUP_PASSWORD:backupPassword,
      AMR_PROVA_COMMERCIALE:'fixture-immagine' };
    const envFile = path.join(work,'runtime.env');
    fs.writeFileSync(envFile,Object.entries(ambiente).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600,flag:'wx'});
    risorse.push(['container',centro]);
    await cli(['create','--name',centro,...limiti,'--network',rete,'--user','1000:1000','--network-alias','centro',
      '--env-file',envFile,
      '--mount','type=volume,src='+volume+',dst=/var/lib/amr',imageId]);
    await cli(['cp',cert,centro+':/var/lib/amr/fixture-ca.pem']);
    await cli(['start',centro]);
    const request = (route,{method='GET',body,cookie,headers={},diretto=false,nodo=false}={}) => {
      if(diretto) {
        controlla(method==='GET' && body===undefined && cookie===undefined
          && ['/healthz','/api/admin'].includes(route));
        // Simula una sonda interna e un chiamante non fidato senza esporre il backend.
        const prova="const http=require('node:http');const req=http.get({hostname:'127.0.0.1',port:3000,path:"
          +JSON.stringify(route)+",headers:"+JSON.stringify(headers)+",agent:false},res=>{let raw='';"
          +"res.on('error',()=>process.exit(1));res.on('data',b=>{raw+=b;if(raw.length>8192)req.destroy();});"
          +"res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,raw})));});"
          +"req.setTimeout(5000,()=>req.destroy());req.on('error',()=>process.exit(1));";
        return cli(['exec',centro,'node','-e',prova]).then(JSON.parse);
      }
      return new Promise((resolve,reject)=>{
      const content = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const timeout = AbortSignal.timeout(12000);
      const combined = signal ? AbortSignal.any([signal,timeout]) : timeout;
      const h = { host:new URL(origine).host,
        ...(content ? {'content-type':'application/json','content-length':content.length,
          ...(!nodo ? {origin:origine} : {})} : {}),...(cookie ? {cookie} : {}),...headers };
      const req = https.request({hostname:'127.0.0.1',port:tlsPort,
        path:route,method,headers:h,agent:false,signal:combined,
        ca,rejectUnauthorized:true},res=>{
        let size=0;const chunks=[];
        res.on('error',reject);res.on('data',b=>{size+=b.length;
          if(size>2*1024*1024)req.destroy(new Error('risposta_fixture_eccessiva'));else chunks.push(b);});
        res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,raw:Buffer.concat(chunks).toString('utf8')}));
      });
      req.on('error',reject);req.end(content);
      });
    };
    const json = res => JSON.parse(res.raw);
    const attendi = async (fn,limite=60000) => {
      const fino = Date.now()+limite;
      do {
        if (signal?.aborted) throw new Error('annullato');
        try { if (await fn()) return; } catch { if(signal?.aborted)throw new Error('annullato'); }
        await pausa(200);
      } while(Date.now()<fino);
      throw new Error('fixture_non_pronta');
    };
    await attendi(async()=>{const r=await request('/healthz',{diretto:true});return r.status===200&&r.raw==='ok';});
    const verifica = "const fs=require('node:fs');if(process.env.AMR_PROVA_COMMERCIALE!=='fixture-immagine')throw Error('fixture');"
      + "const m=require('/opt/amr/backend/nodi/compatibilita-nodo').verificaArtefatto(JSON.parse(fs.readFileSync('/opt/amr/release.json','utf8')),'/opt/amr');process.stdout.write(JSON.stringify(m));";
    const manifest = JSON.parse(await cli(['exec',centro,'node','-e',verifica]));
    const wire = require('../backend/nodi/compatibilita-nodo').valida(manifest);
    assert.deepEqual(Object.keys(manifest).sort(),['cataloghi','codice','protocollo','release']);
    await attendi(async()=>{const r=await request('/api/test/config');return r.status===200&&json(r).accesso==='nhost';});
    assert.equal(await cli(['network','inspect','--format','{{.Internal}}|{{len .Containers}}',rete]),'true|4');
    assert.equal(await cli(['network','inspect','--format','{{.Internal}}|{{len .Containers}}',ingresso]),'false|1');
    assert.equal(await cli(['port',centro]),'');
    const volumeCentro = () => cli(['container','inspect','--format',
      '{{range .Mounts}}{{if eq .Destination "/var/lib/amr"}}{{.Name}}{{end}}{{end}}',centro]);
    assert.equal(await volumeCentro(),volume);

    fase = 'guard HTTPS, UI e API senza sessione';
    assert.equal((await request('/api/admin',{diretto:true,headers:{host:new URL(origine).host,'x-forwarded-proto':'https'}})).status,403);
    for (const route of ['/','/prototipo.js','/prototipo.css','/prototipo-backup.js','/api/auth/pagina',
      '/api/auth/pagina.js','/api/auth/aziende/pagina.js','/api/auth/colleghi/pagina.js']) {
      assert.equal((await request(route)).status,200);
    }
    // Il proxy deve sovrascrivere gli header inoltrati anche se il client li falsifica.
    assert.equal((await request('/',{headers:{forwarded:'for=192.0.2.1;proto=http',
      'x-forwarded-proto':'http','x-forwarded-host':'evil.invalid','x-forwarded-for':'192.0.2.1'}})).status,200);
    assert.equal((await request('/api/admin')).status,401);
    assert.equal((await request('/api/auth/backup/stato')).status,401);
    assert.equal((await request('/api/test/login',{method:'POST',body:{azienda:'aziendaA'}})).status,404);

    fase = 'password e MFA reali attraverso HTTPS';
    const login = async (credenziali={email,password},admin=true) => {
      const jar=new Map();
      const aggiorna = res => {
        const cookies=res.headers['set-cookie'];controlla(Array.isArray(cookies)&&cookies.length>0);
        for(const value of cookies) {
          assert.match(value,/;\s*Secure(?:;|$)/i);assert.match(value,/;\s*HttpOnly(?:;|$)/i);
          assert.match(value,/;\s*SameSite=Strict(?:;|$)/i);assert.match(value,/;\s*Path=\/(?:;|$)/i);
          const m=/^(amr_[a-z_]+)=([^;]*)/.exec(value);controlla(m);
          controlla(m[2]===''||/^[a-f0-9]{64}$/.test(m[2]));
          if(m[2])jar.set(m[1],m[2]);else jar.delete(m[1]);
        }
      };
      const cookie=()=>[...jar].map(([k,v])=>k+'='+v).join('; ');
      const bootstrap=await request('/api/auth/me');
      assert.equal(bootstrap.status,401);aggiorna(bootstrap);
      controlla(jar.has('amr_accesso_prova'));
      const challenge=await request('/api/auth/login',{method:'POST',
        body:{email:credenziali.email,password:credenziali.password},cookie:cookie()});
      assert.equal(challenge.status,200);aggiorna(challenge);
      if(admin) {
        assert.deepEqual(json(challenge),{mfa:true});
        controlla(jar.has('amr_mfa_prova')&&jar.has('amr_accesso_prova')&&!jar.has('amr_sessione_prova'));
        assert.equal((await request('/api/auth/me',{cookie:cookie()})).status,401);
        const otp=require('./collauda-nhost-locale').totp(totpSecret);
        const finale=await request('/api/auth/mfa',{method:'POST',body:{otp},cookie:cookie()});
        assert.equal(finale.status,200);assert.deepEqual(json(finale),{ok:true});aggiorna(finale);
      } else assert.deepEqual(json(challenge),{ok:true});
      controlla(jar.has('amr_sessione_prova')&&!jar.has('amr_mfa_prova'));
      const me=await request('/api/auth/me',{cookie:cookie()});assert.equal(me.status,200);
      const identita=json(me);
      assert.match(identita.persona,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
      assert.equal(identita.admin,admin);assert.equal(identita.mfa,admin);
      if(admin)assert.equal(identita.persona,persona);else assert.notEqual(identita.persona,persona);
      return {cookie:cookie(),identita};
    };
    let cookieAdmin=(await login()).cookie;
    assert.equal((await request('/api/admin',{cookie:cookieAdmin})).status,200);
    assert.equal((await request('/api/search?tipo=moto&marca=Yamaha',{cookie:cookieAdmin})).status,403);
    const backup = async () => {
      const r=await request('/api/auth/backup/stato',{cookie:cookieAdmin});assert.equal(r.status,200);
      const d=json(r);assert.deepEqual(Object.keys(d).sort(),
        ['avviso','configurato','database','journal','operazioniPreesistenti','retentionApplicata']);
      assert.equal(d.configurato,false);assert.equal(d.avviso,true);assert.equal(d.retentionApplicata,false);
      assert.equal(d.journal.stato,'non_configurato');assert.equal(d.database.stato,'non_configurato');
      assert.equal(d.database.errore,'backup_non_configurato');
    };
    await backup();

    fase = 'registrazione worker e compatibilità del manifest';
    const boots={},sequenze={};let epoca;
    const node = (id,route,body,extra={}) => request(route,{nodo:true,method:body===undefined?'GET':'POST',body,
      headers:{'x-amr-node-id':id,'x-amr-node-token':tokens[id],
        ...(boots[id]?{'x-amr-node-boot':boots[id],'x-amr-center-epoch':epoca}:{}),...extra}});
    const heartbeat = async id => {
      // Solo la fixture locale è eleggibile come primario: il lavoro viene
      // completato a mano qui sotto, senza avviare worker o scraper.
      const r=await node(id,'/_nodo/heartbeat',{id,sequenza:++sequenze[id],compatibilita:wire,
        revisione:wire.release,occupato:false,simulato:id!=='locale',
        fonti:{subito:{fermo:false},autoscout:{fermo:false},moto:{fermo:false}}});
      assert.equal(r.status,200);assert.deepEqual(json(r),{ok:true});
    };
    const registra = async id => {
      const r=await node(id,'/_nodo/registrazione');assert.equal(r.status,200);
      const d=json(r);controlla(/^[a-f0-9-]{36}$/.test(d.epoca));assert.deepEqual(d.compatibilita,wire);
      if(epoca)assert.equal(d.epoca,epoca);else epoca=d.epoca;
      const boot=crypto.randomUUID();
      const registrazione={epoca,boot,precedente:d.boot,compatibilita:wire};
      assert.equal((await node(id,'/_nodo/registrazione',registrazione)).status,200);
      boots[id]=boot;sequenze[id]=0;await heartbeat(id);
    };
    const iniziale=await node('locale','/_nodo/registrazione');assert.equal(iniziale.status,200);
    const primo=json(iniziale);
    assert.equal((await node('locale','/_nodo/registrazione',{
      epoca:primo.epoca,boot:crypto.randomUUID(),precedente:primo.boot,
      compatibilita:{...wire,cataloghi:wire.cataloghi==='a'.repeat(64)?'b'.repeat(64):'a'.repeat(64)}})).status,409);
    assert.equal((await node('locale','/_nodo/registrazione',undefined,{'x-amr-node-token':crypto.randomBytes(32).toString('hex')})).status,401);
    await registra('locale');await registra('revocabile');

    fase = 'referente HTTPS, modulo Moto e risultato sintetico Subito';
    const accessoReferente=await login(referente,false),cookieReferente=accessoReferente.cookie;
    const identitaReferente=accessoReferente.identita;
    assert.equal(identitaReferente.aziendaValida,true);assert.deepEqual(identitaReferente.moduli,['moto']);
    assert.match(identitaReferente.azienda,/^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal((await request('/api/admin',{cookie:cookieReferente})).status,403);
    assert.equal((await request('/api/auth/backup/stato',{cookie:cookieReferente})).status,403);
    assert.equal((await request('/api/search?tipo=auto&marca=Fiat',{cookie:cookieReferente})).status,403);
    await heartbeat('locale');
    const ricerca=request('/api/search?tipo=moto&marca=Yamaha&modello=MT-07&fetta=0&fonti=subito',
      {cookie:cookieReferente});
    // Proteggere anche il fallimento prima dell'await finale, senza stampare payload.
    ricerca.catch(()=>{});
    let lavoro;
    await attendi(async()=>{
      await heartbeat('locale');
      const r=await node('locale','/_nodo/poll?id=locale');
      if(r.status===204)return false;
      assert.equal(r.status,200);lavoro=json(r);return true;
    },8000);
    assert.equal(lavoro.versioneProtocollo,1);assert.equal(lavoro.tentativo,1);
    assert.match(lavoro.idLavoro,/^[a-f0-9-]{36}$/);
    assert.equal(lavoro.azienda,identitaReferente.azienda);assert.equal(lavoro.operazione,'ricerca');
    assert.equal(lavoro.input.tipo,'moto');assert.equal(lavoro.input.fonti,'subito');
    const sintetico={risultati:[{id:'fixture-immagine-subito',fonte:'subito',
      url:'https://www.subito.it/moto-e-scooter/fixture-amr-immagine-000000001.htm'}],totale:1,
      sources:{subito:{status:'ok',count:1},autoscout:{status:'skipped',count:0},moto:{status:'skipped',count:0}}};
    const consegna={id:'locale',idLavoro:lavoro.idLavoro,tentativo:lavoro.tentativo,
      durataMs:0,esito:{status:200,body:sintetico}};
    const conferma=await node('locale','/_nodo/esito',consegna);
    assert.equal(conferma.status,200);assert.deepEqual(json(conferma),{ok:true});
    const risposta=await ricerca;assert.equal(risposta.status,200);
    const risultato=json(risposta);assert.equal(risultato.totale,1);assert.equal(risultato.risultati.length,1);
    const record=risultato.risultati[0];
    for(const campo of ['id','fonte','url'])assert.equal(record[campo],sintetico.risultati[0][campo]);
    assert.equal(typeof record.accessoDettagli,'string');controlla(record.accessoDettagli.length>0);
    assert.deepEqual(risultato.sources,sintetico.sources);
    const statoLavori=await request('/api/admin',{cookie:cookieAdmin});assert.equal(statoLavori.status,200);
    const stato=json(statoLavori),traccia=stato.lavori.find(l=>l.id===lavoro.idLavoro);
    controlla(traccia);assert.equal(traccia.stato,'concluso');assert.equal(traccia.http,200);
    assert.equal(traccia.azienda,identitaReferente.azienda);assert.equal(traccia.nodo,'locale');
    assert.equal(traccia.byte_risposta,Buffer.byteLength(JSON.stringify(consegna)));
    assert.equal(stato.lavoriAttivi,0);
    await heartbeat('locale');

    fase = 'sospensione manuale e revoca del token via Admin';
    const admin = (route,body) => request(route,{cookie:cookieAdmin,method:'POST',body,headers:{'x-amr-local-admin':'1'}});
    assert.equal((await admin('/api/admin/nodi/locale',{sospeso:true})).status,200);
    assert.equal((await node('locale','/_nodo/poll?id=locale')).status,204);
    assert.equal((await admin('/api/admin/nodi/revocabile/revoca-token',{})).status,200);
    assert.equal((await node('revocabile','/_nodo/registrazione')).status,401);

    fase = 'SIGTERM, stesso volume SQLite e sessioni invalidate';
    const precedenteCookie=cookieAdmin,precedenteEpoca=epoca;
    await cli(['stop','--signal','SIGTERM','--time','25',centro],false,45000);
    assert.equal(await cli(['container','inspect','--format','{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Running}}',centro]),'0|false|false');
    await cli(['start',centro]);
    await attendi(async()=>{const r=await request('/healthz',{diretto:true});return r.status===200&&r.raw==='ok';});
    assert.equal(await volumeCentro(),volume);
    assert.equal((await request('/api/auth/me',{cookie:precedenteCookie})).status,401);
    assert.equal((await request('/api/admin',{cookie:precedenteCookie})).status,401);
    assert.equal((await request('/api/auth/me',{cookie:cookieReferente})).status,401);
    assert.equal((await node('revocabile','/_nodo/registrazione')).status,401);
    cookieAdmin=(await login()).cookie;epoca=undefined;delete boots.locale;
    await registra('locale');assert.notEqual(epoca,precedenteEpoca);
    assert.equal((await node('locale','/_nodo/poll?id=locale')).status,204);
    const persistito=await request('/api/admin',{cookie:cookieAdmin});assert.equal(persistito.status,200);
    const dati=json(persistito);controlla(dati.nodi.some(n=>n.id==='locale'&&n.sospeso===true));
    controlla(dati.eventi.some(e=>e.nodo==='locale'&&e.codice==='sospensione_aggiunta'));
    controlla(dati.eventi.some(e=>e.nodo==='revocabile'&&e.codice==='credenziale_revocata'));
    await backup();
    esito='Immagine centro locale: artefatto e HTTPS/MFA verificati, Auto negato e ricerca Moto/Subito sintetica con byte wire; SIGTERM 0, volume persistente, sospensione/revoca conservate e vecchie sessioni negate.';
  } catch (e) {
    fallimento=new Error('Collaudo immagine centro interrotto nella fase: '+fase+(signal?.aborted?' (annullato)':''));
    fallimento.faseGate = fase;
    // Estrarre solo il punto nel nostro file, mai messaggio, path o stack raw.
    for (const frame of typeof e?.stack === 'string' ? e.stack.split('\n') : []) {
      if (!/^\s+at /.test(frame)) continue;
      const punto = /[/\\](collauda-centro-immagine-locale\.js:[1-9]\d{0,6}:[1-9]\d{0,4})\)?$/.exec(frame);
      if (punto) { fallimento.puntoGate = punto[1]; break; }
    }
    if (typeof e?.actual === 'number' && Number.isFinite(e.actual)
        && typeof e?.expected === 'number' && Number.isFinite(e.expected)) {
      fallimento.confrontoGate = { actual:e.actual, expected:e.expected };
    }
    if (typeof e?.code === 'string' && /^(?:[A-Z][A-Z_]{0,19}|[A-Z0-9]{5})$/.test(e.code)) {
      fallimento.codeGate = e.code;
    }
  } finally {
    let pulita=true;
    // Non riusare signal annullato per la pulizia. Nessun down, prune o stop altrui.
    const posseduta = async (tipo,nome) => {
      const elenco=await cli(tipo==='container'?['ps','-a','--filter','label='+label+'='+nonce,'--format','{{.Names}}']
        :[tipo,'ls','--filter','label='+label+'='+nonce,'--format','{{.Name}}'],true);
      return elenco.split('\n').includes(nome);
    };
    for(const [tipo,nome] of risorse.filter(r=>r[0]==='container').reverse()) {
      try {if(await posseduta(tipo,nome))await cli(['rm','--force',nome],true);}catch{pulita=false;}
    }
    for(const [,nome] of risorse.filter(r=>r[0]==='network').reverse()) {
      try {
        if(await posseduta('network',nome)) {
          const members=JSON.parse(await cli(['network','inspect','--format','{{json .Containers}}',nome],true))||{};
          for(const id of collegamenti)if(Object.hasOwn(members,id)) {
            try{await cli(['network','disconnect',nome,id],true);}catch{pulita=false;}
          }
          await cli(['network','rm',nome],true);
        }
      }catch{pulita=false;}
    }
    for(const [tipo,nome] of risorse.filter(r=>r[0]==='volume')) {
      try {if(await posseduta(tipo,nome))await cli(['volume','rm',nome],true);}catch{pulita=false;}
    }
    if(work) {
      if(pulita) {try{fs.rmSync(work,{recursive:true,force:true});}catch{pulita=false;}}
      if(!pulita) {
        console.error('Pulizia della fixture immagine incompleta; temporanei protetti conservati: '+work);
        fallimento ||= new Error('Collaudo immagine centro: pulizia incompleta');
        fallimento.conservaTemporanei = true;
      }
    }
  }
  if(fallimento)throw fallimento;
  return esito;
}

module.exports = { collaudaImmagine };
