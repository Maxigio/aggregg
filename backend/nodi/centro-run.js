'use strict';
const fs = require('node:fs');

// Entry remoto separato: avvio esplicito, nessuna migrazione o attivazione cloud.
async function creaServizio(config, { Pool = require('pg').Pool,
  verificaRelease = require('./compatibilita-nodo').verificaArtefatto } = {}) {
  const manifest = verificaRelease(JSON.parse(fs.readFileSync(config.releaseFile,'utf8')),
    require('node:path').join(__dirname,'..','..'));
  const { creaCentro } = require('./centro');
  const pools = [];
  let centro, accessi, aziendeRoute, colleghiRoute, copie, notifiche, chiusura;
  function close() {
    return chiusura ||= (async () => {
      centro?.close(); accessi?.close(); aziendeRoute?.close(); colleghiRoute?.close();
      try { await notifiche?.close(); } finally {
        try { await copie?.stop(); } finally { await Promise.allSettled(pools.map(p=>p.end())); }
      }
    })();
  }
  try {
    for (const nome of ['lettura','commerciale','backup']) {
      const p = new Pool(config.pools[nome]); p.on('error',()=>{}); pools.push(p);
    }
    const [reader,writer,backup] = pools;
    const client = require('./nhost-auth-client').creaClient({base:config.auth,origineAuth:new URL(config.auth).origin});
    const identita = require('./accessi-postgres-prova').creaAccessiPostgres({pool:reader});
    const aziende = require('./aziende-postgres-prova').creaAziendePostgres({pool:writer});
    const colleghi = require('./colleghi-postgres-prova').creaColleghiPostgres({pool:writer});
    const backupApi = require('./backup-postgres-prova');
    // Repository remoto non configurato senza un gate storage separato: avviso persistente.
    copie = backupApi.creaBackupPostgres({pool:backup});
    const trasporto = {origine:config.origine,proxyAttendibili:config.proxy};
    centro = creaCentro({tokens:config.tokens,directory:config.directory,compatibilita:manifest,
      inviaIncidente: require('./betterstack').creaInvio({ url: config.webhookIncidenti }),
      proprietarioId:config.proprietarioId,
      trasporto,timeoutRicercaMs:config.timeoutRicercaMs,maxPersona:config.maxPersona,maxTotale:config.maxTotale,
      inizializzaAccessi:app=>{
        accessi=require('./login-nhost-prova').mount(app,{client,origine:config.origine,
          trasporto,identita,cookiePath:'/'});
        aziendeRoute=require('./aziende-prova-route').mount(app,{account:aziende,accessi,client,
          origine:config.origine,trasporto});
        colleghiRoute=require('./colleghi-prova-route').mount(app,{account:colleghi,accessi,client,
          origine:config.origine,trasporto});
        require('./backup-prova-route').mount(app,{backup:backupApi.creaStatoBackup({pool:writer}),
          accessi,origine:config.origine,trasporto,segnalaOperazione:copie.segnalaOperazione});
        return accessi;
      }});
    copie.start();
    notifiche=await backupApi.collegaNotificheBackup({pool:backup,worker:copie});
    // Autenticazione e schema vengono verificati separatamente nello staging.
    return {centro,app:centro.app,close};
  } catch {
    await close(); throw new Error('centro_run_non_avviato');
  }
}
if (require.main===module) {
  let servizio, server, chiusura, interrotto=false;
  const chiudi=()=>chiusura ||= (async()=>{
    server?.close(); server?.closeAllConnections(); await servizio?.close();
  })();
  const segnale=()=>{ interrotto=true; if(servizio) void chiudi(); };
  process.once('SIGTERM',segnale); process.once('SIGINT',segnale);
  (async()=>{
    // Versione scelta da provare sul candidato; non basta package.json >=20.
    if(Number(process.versions.node.split('.')[0])!==24)throw new Error('centro_run_richiede_node24');
    const config=require('./config-centro-run').configura(process.env);
    servizio=await creaServizio(config);
    if(interrotto) { await chiudi(); return; }
    server=require('node:http').createServer(servizio.app);
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'0.0.0.0',resolve);});
    if(interrotto) { await chiudi(); return; }
    console.log('Centro AMR avviato con configurazione HTTPS esplicita.');
  })().catch(async()=>{await chiudi();console.error('Centro AMR non avviato: verificare configurazione e runtime.');process.exitCode=1;});
}
module.exports={creaServizio};
