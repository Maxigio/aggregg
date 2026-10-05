'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {prepara}=require('./prepara-release-nodi');
const {verificaArtefatto}=require('../backend/nodi/compatibilita-nodo');

// Materializza solo i blob pubblici di un commit. Il checkout, le credenziali
// locali e i database non sono sorgenti del build context.
function preparaContesto({radice=path.join(__dirname,'..'),genitore=os.tmpdir(),git=execFileSync}={}) {
  const manifest=prepara({radice,git});
  const directory=fs.mkdtempSync(path.join(genitore,'amr-centro-context-'));
  try {
    fs.chmodSync(directory,0o700);
    const nomi=[...manifest.inventario.codice,...manifest.inventario.cataloghi.map(n=>'data/'+n)];
    for(const nome of nomi) {
      const buffer=git('git',['show',manifest.release+':'+nome],{cwd:radice,encoding:null,
        maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
      if(!Buffer.isBuffer(buffer))throw new Error('blob_release_non_valido');
      const file=path.join(directory,nome);fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,buffer,{flag:'wx',mode:0o644});
    }
    // Anche la ricetta deve provenire dal medesimo commit.
    fs.copyFileSync(path.join(directory,'scripts/docker/centro.Dockerfile'),path.join(directory,'Dockerfile'),fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(directory,'release.json'),JSON.stringify(manifest)+'\n',{flag:'wx'});
    fs.writeFileSync(path.join(directory,'.dockerignore'),['**','!Dockerfile','!release.json',
      '!package.json','!package-lock.json',...['backend','frontend','pagine','scripts','data'].flatMap(n=>['!'+n+'/','!'+n+'/**']),
      '**/.env*','**/node_modules','**/.git','**/*.db','**/*.db-*'].join('\n')+'\n',{flag:'wx'});
    verificaArtefatto(manifest,directory);
    return {directory,manifest};
  } catch {
    try {fs.rmSync(directory,{recursive:true,force:true});}
    catch {throw new Error('contesto_centro_pulizia_incompleta');}
    throw new Error('contesto_centro_non_preparato');
  }
}
if(require.main===module) {
  try { const {directory,manifest}=preparaContesto();
    console.log(JSON.stringify({directory,release:manifest.release,codice:manifest.codice,cataloghi:manifest.cataloghi}));
  } catch {console.error('Contesto centro non preparato: verificare commit e inventario.');process.exitCode=1;}
}
module.exports={preparaContesto};
