'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { valida, compatibile, hashCataloghi, hashCodice, listaCataloghi, validaArtefatto,
  verificaArtefatto, listaCodice, CATALOGHI } = require('../backend/nodi/compatibilita-nodo');
const { prepara } = require('../scripts/prepara-release-nodi');
const { preparaContesto } = require('../scripts/prepara-contesto-centro');
const manifest = () => ({ protocollo: 1, release: 'a'.repeat(40), codice: 'b'.repeat(64), cataloghi: 'c'.repeat(64) });
test('nodi: protocollo, release, codice e cataloghi devono coincidere', () => {
  const m = manifest(); assert.deepEqual(valida(m), m); assert.ok(compatibile(m, { ...m, altra: true }));
  for (const [campo, v] of [['protocollo',999],['release','d'.repeat(40)],['codice','d'.repeat(64)],['cataloghi','d'.repeat(64)]]) {
    assert.equal(compatibile(m, { ...m, [campo]:v }), false);
  }
  for (const v of [null,{}, { ...m, release:'../data/auth.json' }]) assert.equal(compatibile(m,v),false);
});
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-artefatto-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const files=new Map();
  function scrivi(nome,contenuto) {
    const buffer=Buffer.from(contenuto);files.set(nome,buffer);
    fs.mkdirSync(path.dirname(path.join(dir,nome)),{recursive:true});fs.writeFileSync(path.join(dir,nome),buffer);
  }
  for(const nome of CATALOGHI)scrivi('data/'+nome,'{}');
  for(const nome of ['versioni/auto/1.json','versioni/moto/1.json','versioni/auto/nested/2.json'])scrivi('data/'+nome,'{"pubblico":true}');
  for(const nome of ['worker.js','compatibilita-nodo.js'])scrivi('backend/nodi/'+nome,
    fs.readFileSync(path.join(__dirname,'../backend/nodi',nome)));
  scrivi('backend/nodi/operazioni.js','module.exports={};');scrivi('package.json','{}');scrivi('package-lock.json','{}');
  for(const nome of ['frontend/prova.js','pagine/prova.html','scripts/prova.js'])scrivi(nome,'// fixture');
  scrivi('scripts/docker/centro.Dockerfile',fs.readFileSync(path.join(__dirname,'../scripts/docker/centro.Dockerfile')));
  const calls=[];let head='a'.repeat(40),catturato;
  const git=(_bin,args)=>{
    calls.push(args);
    if(args[0]==='rev-parse'){catturato=head;head='b'.repeat(40);return catturato+'\n';}
    if(args[0]==='ls-tree') {
      assert.equal(args[3],catturato);assert.equal(args[2],'-z');
      const ambito=args.slice(args.indexOf('--')+1);
      return [...files.keys()].filter(n=>ambito.some(a=>n===a||n.startsWith(a+'/'))).sort()
        .map(n=>'100644 blob '+'1'.repeat(40)+'\t'+n+'\0').join('');
    }
    assert.equal(args[0],'show');assert.ok(args[1].startsWith(catturato+':'));
    return files.get(args[1].slice(41));
  };
  const artefatto=prepara({radice:dir,git});
  return {dir,files,scrivi,calls,artefatto,git};
}
test('require CommonJS: file senza estensione aggiunto precede operazioni.js, manifest invariato respinto',t=>{
  const f=fixture(t),modulo=path.join(fs.realpathSync(f.dir),'backend/nodi/operazioni');
  assert.equal(require.resolve(modulo+'.js'),modulo+'.js');
  f.scrivi('backend/nodi/operazioni',"module.exports='aggiunto';");
  t.after(()=>{delete require.cache[modulo];});
  assert.equal(require.resolve(modulo),modulo);assert.equal(require(modulo),'aggiunto');
  // Il vecchio gate avrebbe verificato lo stesso hash dei soli file elencati.
  assert.equal(hashCodice(f.dir,f.artefatto.inventario.codice),f.artefatto.codice);
  assert.throws(()=>verificaArtefatto(f.artefatto,f.dir),/codice_release_incompatibile/);
});
test('createRequire: package backend prevale sul package root e il gate lo respinge senza leggere contenuti',t=>{
  const f=fixture(t),radice=fs.realpathSync(f.dir),{createRequire}=require('node:module');
  f.scrivi('node_modules/pacchetto-prova/index.js',"module.exports='A';");
  f.scrivi('backend/node_modules/pacchetto-prova/index.js',"module.exports='B';");
  const root=createRequire(path.join(radice,'package.json')),backend=createRequire(path.join(radice,'backend/nodi/worker.js'));
  t.after(()=>{delete require.cache[root.resolve('pacchetto-prova')];delete require.cache[backend.resolve('pacchetto-prova')];});
  assert.equal(root('pacchetto-prova'),'A');assert.equal(backend('pacchetto-prova'),'B');
  assert.equal(hashCodice(f.dir,f.artefatto.inventario.codice),f.artefatto.codice);
  assert.throws(()=>verificaArtefatto(f.artefatto,f.dir),/codice_non_leggibile/);
  const originale=fs.readFileSync;let letture=0;
  try {
    fs.readFileSync=()=>{letture++;assert.fail('il gate deve respingere il package nested prima di leggere contenuti');};
    assert.throws(()=>verificaArtefatto(f.artefatto,f.dir),/codice_non_leggibile/);
    assert.equal(letture,0);
  } finally {fs.readFileSync=originale;}
});
test('codice: elenco completo senza lettura contenuti estranei; node_modules solo root escluso',t=>{
  const f=fixture(t);
  f.scrivi('node_modules/esterna/index.js','sintetico');
  const originale=fs.readFileSync;let letture=0;
  try {
    fs.readFileSync=()=>{letture++;assert.fail('il confronto nomi deve precedere ogni lettura di contenuti');};
    assert.deepEqual(listaCodice(f.dir),f.artefatto.inventario.codice);
    f.scrivi('scripts/residuo.js.tmp','sintetico');
    assert.throws(()=>verificaArtefatto(f.artefatto,f.dir),/codice_release_incompatibile/);
    assert.equal(letture,0);
  } finally {fs.readFileSync=originale;}
});
test('codice: aggiunte in ogni root, nomi invalidi e symlink fuori inventario bloccano il gate',async t=>{
  for(const [nome,modifica]of [
    ...['backend','frontend','pagine','scripts'].map(root=>['file aggiunto '+root,f=>f.scrivi(root+'/nested/residuo','sintetico')]),
    ['residuo nascosto',f=>f.scrivi('backend/.DS_Store','sintetico')],
    ['directory invalida anche vuota',f=>fs.mkdirSync(path.join(f.dir,'scripts/.residuo'))],
    ['symlink aggiunto',f=>fs.symlinkSync('operazioni.js',path.join(f.dir,'backend/nodi/operazioni'))],
    ['symlink directory aggiunta',f=>fs.symlinkSync('nodi',path.join(f.dir,'backend/residuo'))],
    ['symlink node_modules interno',f=>fs.symlinkSync('nodi',path.join(f.dir,'backend/node_modules'))],
    ['root codice symlink',f=>{fs.renameSync(path.join(f.dir,'frontend'),path.join(f.dir,'frontend-originale'));fs.symlinkSync('frontend-originale',path.join(f.dir,'frontend'));}],
  ])await t.test(nome,st=>{const f=fixture(st);modifica(f);assert.throws(()=>verificaArtefatto(f.artefatto,f.dir));});
});
test('cataloghi pubblici: nuovi bridge, versioni ricorsive e relativi; niente file personali',t=>{
  const f=fixture(t),lette=[],directory=path.join(f.dir,'data');
  // Questi file sintetici NON appartengono alla whitelist.
  f.scrivi('data/auth.json','privato');f.scrivi('data/cache.json','privato');
  const a=hashCataloghi(directory,file=>{lette.push(path.relative(directory,file));return fs.readFileSync(file);});
  assert.deepEqual(lette,f.artefatto.inventario.cataloghi);
  for(const n of ['as24-modelli.json','comune-sigla.json','versioni/auto/nested/2.json'])assert.ok(lette.includes(n));
  assert.ok(!lette.some(n=>/auth|cache/.test(n)));
  f.scrivi('data/versioni/moto/1.json','{"cambiato":true}');assert.notEqual(a,hashCataloghi(directory));
  assert.throws(()=>hashCataloghi(directory,()=>{throw Object.assign(new Error('privato'),{code:'EACCES'});}),/cataloghi_non_leggibili/);
  fs.rmSync(path.join(directory,'models.json'));assert.throws(()=>hashCataloghi(directory),/cataloghi_non_leggibili/);
});
test('builder: uno SHA catturato anche se HEAD/checkout cambiano; nessuna lettura fuori scope',t=>{
  const f=fixture(t);assert.equal(f.artefatto.release,'a'.repeat(40));
  assert.equal(f.calls.filter(c=>c[0]==='rev-parse').length,1);
  assert.ok(f.calls.every(c=>['rev-parse','ls-tree','show'].includes(c[0])));
  assert.ok(f.calls.filter(c=>c[0]==='show').every(c=>!c[1].includes('auth.json')));
  assert.deepEqual(valida(f.artefatto),verificaArtefatto(f.artefatto,f.dir));
  assert.equal(f.artefatto.codice,hashCodice(f.dir,f.artefatto.inventario.codice));
  fs.writeFileSync(path.join(f.dir,'backend/nodi/worker.js'),'checkout modificato');
  const nuovo=prepara({radice:f.dir,git:f.git});assert.equal(nuovo.codice,f.artefatto.codice);
  assert.throws(()=>verificaArtefatto(nuovo,f.dir),/codice_release_incompatibile/);
});
test('contesto Docker: solo blob pubblici, ricetta del commit e file locali ignorati',t=>{
  const f=fixture(t),parent=fs.mkdtempSync(path.join(os.tmpdir(),'amr-parent-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  fs.writeFileSync(path.join(f.dir,'package.json'),'checkout non distribuito');
  fs.writeFileSync(path.join(f.dir,'.env'),'dato sintetico privato');
  fs.writeFileSync(path.join(f.dir,'data/auth.json'),'dato sintetico privato');
  const {directory,manifest}=preparaContesto({radice:f.dir,genitore:parent,git:f.git});
  assert.deepEqual(verificaArtefatto(manifest,directory),{
    protocollo:manifest.protocollo,release:manifest.release,codice:manifest.codice,cataloghi:manifest.cataloghi});
  assert.equal(fs.readFileSync(path.join(directory,'package.json'),'utf8'),'{}');
  assert.equal(fs.readFileSync(path.join(directory,'Dockerfile'),'utf8'),
    fs.readFileSync(path.join(directory,'scripts/docker/centro.Dockerfile'),'utf8'));
  assert.equal(fs.existsSync(path.join(directory,'.env')),false);
  assert.equal(fs.existsSync(path.join(directory,'data/auth.json')),false);
  assert.ok(f.calls.filter(c=>c[0]==='show').every(c=>!c[1].includes('.env')&&!c[1].includes('auth.json')));
  if(process.platform!=='win32')assert.equal(fs.statSync(directory).mode&0o777,0o700);
});
test('contesto Docker: drift durante la copia fallisce e pulisce soltanto la directory posseduta',t=>{
  const f=fixture(t),parent=fs.mkdtempSync(path.join(os.tmpdir(),'amr-parent-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  fs.writeFileSync(path.join(parent,'preservare'),'non toccare');
  let copie=0;
  const git=(bin,args,opt)=>{
    const buffer=f.git(bin,args,opt);
    if(args[0]==='show'&&args[1].endsWith(':package.json')&&++copie===2)return Buffer.from('{"drift":true}');
    return buffer;
  };
  assert.throws(()=>preparaContesto({radice:f.dir,genitore:parent,git}),/contesto_centro_non_preparato/);
  assert.deepEqual(fs.readdirSync(parent),['preservare']);
});
test('inventario: percorsi assoluti/traversal/privati, duplicati e incompletezza rifiutati prima dei blob',t=>{
  const f=fixture(t);
  for(const nome of ['/etc/passwd','../data/auth.json','backend/../data/auth.json','backend//x.js',
    'backend/./x.js','backend\\x.js','backend/.env','backend/node_modules/x.js','data/auth.json','backend/x\0.js']) {
    const inv={...f.artefatto.inventario,codice:[...f.artefatto.inventario.codice,nome].sort()};
    assert.throws(()=>validaArtefatto({...f.artefatto,inventario:inv}),/inventario_release/);
  }
  for(const inv of [{...f.artefatto.inventario,codice:[]},
    {...f.artefatto.inventario,codice:[...f.artefatto.inventario.codice].reverse()},
    {...f.artefatto.inventario,codice:[...f.artefatto.inventario.codice,f.artefatto.inventario.codice.at(-1)]},
    {...f.artefatto.inventario,cataloghi:['models.json']},
    {...f.artefatto.inventario,cataloghi:[...f.artefatto.inventario.cataloghi,'versioni/auto/../../auth.json'].sort()}]) {
    assert.throws(()=>validaArtefatto({...f.artefatto,inventario:inv}),/inventario_release/);
  }
  assert.throws(()=>validaArtefatto(valida(f.artefatto)),/inventario_release/);
  let blob=false;
  const git=(_bin,args)=>args[0]==='show'?(blob=true,Buffer.from('vietato')):
    args[0]==='ls-tree'?('120000 blob '+'1'.repeat(40)+'\tbackend/link.js\0'): 'a'.repeat(40);
  assert.throws(()=>prepara({git}),/percorso_release_non_valido/);assert.equal(blob,false);
});
test('artefatto: alterazioni, rimozioni e nuovi cataloghi nested impediscono il gate',async t=>{
  for(const [nome,modifica]of [
    ['codice alterato',f=>fs.appendFileSync(path.join(f.dir,'backend/nodi/worker.js'),'// drift')],
    ['codice mancante',f=>fs.rmSync(path.join(f.dir,'backend/nodi/worker.js'))],
    ['lock alterato',f=>fs.appendFileSync(path.join(f.dir,'package-lock.json'),' ')],
    ['catalogo flat alterato',f=>f.scrivi('data/as24-modelli.json','{"diverso":1}')],
    ['catalogo flat mancante',f=>fs.rmSync(path.join(f.dir,'data/comune-sigla.json'))],
    ['catalogo nested alterato',f=>f.scrivi('data/versioni/auto/nested/2.json','{"diverso":1}')],
    ['catalogo nested mancante',f=>fs.rmSync(path.join(f.dir,'data/versioni/auto/nested/2.json'))],
    ['cartella cataloghi mancante',f=>fs.rmSync(path.join(f.dir,'data/versioni/moto'),{recursive:true})],
    ['catalogo nested aggiunto',f=>f.scrivi('data/versioni/moto/nested/extra.json','{}')],
    ['file codice symlink',f=>{fs.rmSync(path.join(f.dir,'backend/nodi/worker.js'));fs.symlinkSync('operazioni.js',path.join(f.dir,'backend/nodi/worker.js'));}],
    ['genitore codice symlink',f=>{fs.renameSync(path.join(f.dir,'backend/nodi'),path.join(f.dir,'backend/reali'));fs.symlinkSync('reali',path.join(f.dir,'backend/nodi'));}],
    ['catalogo symlink',f=>{fs.rmSync(path.join(f.dir,'data/as24-modelli.json'));fs.symlinkSync('models.json',path.join(f.dir,'data/as24-modelli.json'));}],
    ['cartella cataloghi symlink',f=>{fs.rmSync(path.join(f.dir,'data/versioni/moto'),{recursive:true});fs.symlinkSync('auto',path.join(f.dir,'data/versioni/moto'));}],
    ['radice data symlink',f=>{fs.renameSync(path.join(f.dir,'data'),path.join(f.dir,'pubblici'));fs.symlinkSync('pubblici',path.join(f.dir,'data'));}],
  ])await t.test(nome,st=>{const f=fixture(st);modifica(f);assert.throws(()=>verificaArtefatto(f.artefatto,f.dir));});
});
test('worker: verifica filesystem senza Git prima di importare operazioni o contattare il centro; wire solo quattro campi',async t=>{
  const vm=require('node:vm'),{EventEmitter}=require('node:events');
  for(const alterazione of ['nessuna','modificato','aggiunto','package-nested'])await t.test(alterazione==='nessuna'?'artefatto esatto registrato':'drift '+alterazione+' blocca startup',async st=>{
    const f=fixture(st),file=path.join(f.dir,'release.json'),proc=new EventEmitter(),modulo={exports:{}};
    fs.writeFileSync(file,JSON.stringify(f.artefatto));
    if(alterazione==='modificato')fs.appendFileSync(path.join(f.dir,'backend/nodi/worker.js'),'// drift');
    if(alterazione==='aggiunto')f.scrivi('backend/nodi/operazioni',"module.exports='aggiunto';");
    if(alterazione==='package-nested')f.scrivi('backend/node_modules/pacchetto-prova/index.js',"module.exports='B';");
    proc.env={AMR_CENTRO_URL:'https://amr.invalid',AMR_NODO_ID:'locale',AMR_NODI_TOKEN:'sintetico',AMR_NODI_RELEASE_FILE:file};
    let imports=0,requests=0;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../backend/nodi/worker.js'),'utf8'),{
      module:modulo,process:proc,__dirname:path.join(f.dir,'backend/nodi'),URL,AbortController,AbortSignal,performance,
      setTimeout,clearTimeout,setInterval,clearInterval,
      require:n=>{
        if(n==='./operazioni'){imports++;return{statoFonti:()=>({}),esegui:()=>assert.fail('nessun job previsto')};}
        if(n==='../annullo')return{};
        if(n==='./compatibilita-nodo')return require('../backend/nodi/compatibilita-nodo');
        assert.ok(['node:crypto','node:fs','node:path'].includes(n),'nessun Git/child_process necessario');return require(n);
      },fetch:async(url,opt)=>{
        requests++;assert.equal(opt.redirect,'error');
        if(opt.method==='POST') {
          assert.deepEqual(Object.keys(JSON.parse(opt.body).compatibilita).sort(),['cataloghi','codice','protocollo','release']);
          if(url.endsWith('/heartbeat'))proc.emit('SIGTERM');
        }
        return{ok:true,json:async()=>({epoca:'centro',boot:null,compatibilita:valida(f.artefatto)})};
      },
    });
    if(alterazione!=='nessuna'){await assert.rejects(modulo.exports.avvia(),alterazione==='package-nested'?/codice_non_leggibile/:/codice_release_incompatibile/);assert.equal(imports,0);assert.equal(requests,0);}
    else{await modulo.exports.avvia();assert.equal(imports,1);assert.equal(requests,3);}
  });
});

test('centro: legacy e release diverse rifiutati prima di assegnare, ripristino solo con release esatta', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-compat-centro-'));
  const centro=require('../backend/nodi/centro').creaCentro({directory:dir,tokens:{locale:'t'.repeat(64)},compatibilita:manifest()});
  const server=require('node:http').createServer(centro.app).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  t.after(async()=>{centro.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const origine='http://127.0.0.1:'+server.address().port;
  let bootHeaders={};
  const call=(route,body)=>fetch(origine+'/_nodo/'+route,{method:body?'POST':'GET',headers:{
    'x-amr-node-id':'locale','x-amr-node-token':'t'.repeat(64),...bootHeaders,
    ...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const h={id:'locale',revisione:'imac-1',fonti:{subito:{fermo:false},autoscout:{fermo:false}},occupato:false};
  assert.equal((await call('heartbeat',h)).status,409); assert.equal(centro.nodi.size,0);
  const c=await (await call('registrazione')).json(); assert.deepEqual(c.compatibilita,manifest());
  const boot=require('node:crypto').randomUUID();
  for(const [k,value] of [['protocollo',999],['release','d'.repeat(40)],['codice','d'.repeat(64)],['cataloghi','d'.repeat(64)]]) {
    assert.equal((await call('registrazione',{epoca:c.epoca,boot,precedente:null,compatibilita:{...manifest(),[k]:value}})).status,409);
    assert.equal(centro.nodi.size,0);
  }
  assert.equal((await call('registrazione',{epoca:c.epoca,boot,precedente:null,compatibilita:manifest()})).status,200);
  bootHeaders={'x-amr-node-boot':boot,'x-amr-center-epoch':c.epoca};
  assert.equal((await call('heartbeat',{...h,sequenza:1,compatibilita:manifest()})).status,200);
  assert.equal((await call('poll?id=locale')).status,204);
  assert.equal((await call('heartbeat',{...h,sequenza:2,compatibilita:{...manifest(),protocollo:999}})).status,409);
  assert.equal((await call('poll?id=locale')).status,409);
  assert.equal((await call('heartbeat',{...h,sequenza:3,compatibilita:manifest()})).status,200);
  assert.equal((await call('poll?id=locale')).status,204);
  assert.equal(centro.lavori.size,0);
});

test('worker: protocollo sconosciuto non interroga gli scraper e riferisce 409',async()=>{
  const vm=require('node:vm'),{EventEmitter}=require('node:events');
  const proc=new EventEmitter();proc.env={AMR_CENTRO_URL:'http://127.0.0.1:1234',AMR_NODO_ID:'locale',AMR_NODI_TOKEN:'sintetico'};
  let eseguiti=0,esito;const modulo={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../backend/nodi/worker.js'),'utf8'),{
    module:modulo,process:proc,URL,AbortController,AbortSignal,performance,setTimeout,clearTimeout,setInterval,clearInterval,
    require:n=>n==='node:crypto'?require(n):n==='./operazioni'?{statoFonti:()=>({}),esegui:async()=>{eseguiti++;}}:{dentro:(_s,fn)=>fn()},
    fetch:async(url,opt)=>{
      assert.equal(opt.redirect,'error');
      if(url.endsWith('/registrazione'))return{ok:true,json:async()=>({epoca:'centro',boot:null})};
      if(url.includes('/poll'))return{ok:true,status:200,json:async()=>({versioneProtocollo:999,idLavoro:'prova',tentativo:1})};
      if(url.endsWith('/esito')){esito=JSON.parse(opt.body).esito;proc.emit('SIGTERM');}
      return{ok:true};
    },
  });
  await modulo.exports.avvia();assert.equal(eseguiti,0);assert.equal(esito.status,409);
});
