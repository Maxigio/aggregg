'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { creaTrasporto } = require('../../backend/nodi/trasporto-prova');
const MAX = 64 * 1024 * 1024;
const FILE = ['database.dump', 'globals.sql', 'lavori-prototipo.db', 'manifest.json'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const proxyDaEnv = value => (value || '').split(',').map(ip => ip.trim()).filter(Boolean);

// AbortError può precedere l'uscita del child: il cleanup attende sempre close.
function eseguiComando(bin,args,options) {
  let child;
  const promessa=new Promise((resolve,reject)=>{
    let risultato,chiuso=false;
    const finisci=()=>{if(chiuso&&risultato)risultato.error?reject(risultato.error):resolve(risultato);};
    child=execFile(bin,args,options,(error,stdout)=>{risultato={error,stdout};finisci();});
    child.once('close',()=>{chiuso=true;finisci();});
  });
  promessa.child=child;return promessa;
}

// Strumento di manutenzione, non una rotta AMR: nessun percorso o SQL arriva dal client.
async function preparaCopia({ directory = '/var/lib/amr', temporanei = '/dev/shm', pg,
  esegui = eseguiComando, signal, release, tempoMs = 120000, apriSnapshot = snapshotPostgres } = {}) {
  if (!Number.isSafeInteger(tempoMs) || tempoMs <= 0 || tempoMs > 120000) throw new Error('deadline_non_valida');
  const inizio = new Date().toISOString(), acquisizione = crypto.randomUUID();
  const fine = performance.now() + tempoMs;
  const env = { PATH: '/usr/lib/postgresql/18/bin:/usr/bin:/bin', LANG: 'C',
    PGHOST: pg.host, PGPORT: '5432', PGUSER: pg.user, PGDATABASE: pg.database,
    ...(pg.password ? { PGPASSWORD: pg.password } : {}), PGCONNECT_TIMEOUT: '10',
    PGPASSFILE:'/dev/null', HOME:'/nonexistent',
    PGOPTIONS: '-c role=postgres -c default_transaction_read_only=on -c statement_timeout=120000' };
  const comando = async (bin, args, extra = {}) => {
    const residuo = Math.floor(fine - performance.now());
    if (residuo <= 0) throw new Error('backup_deadline');
    const r = await esegui(bin, args, { env, encoding: null, maxBuffer: MAX,
      timeout: residuo, killSignal: 'SIGKILL', signal, ...extra });
    return r.stdout;
  };
  let temp, volume, snapshot, risultato, errore, fase = 'metadati_iniziali';
  const contenuti = [];
  try {
    snapshot = await apriSnapshot(pg, { signal, tempoMs });
    const prima = snapshot.metadati;
    if (!/^18\./.test(prima.versione) || prima.pool_attivi !== 0 || prima.session_user !== pg.user
        || prima.current_user !== 'postgres' || prima.read_only !== true
        || !/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+$/.test(snapshot.id)) throw new Error('centro_non_fermo');
    fase = 'sqlite';
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('volume_non_privato');
    const nomi = fs.readdirSync(directory);
    if (!nomi.includes('lavori-prototipo.db') || nomi.some(n => ![
      'lavori-prototipo.db', 'lavori-prototipo.db-wal', 'lavori-prototipo.db-shm',
      'lavori-prototipo.db-journal', 'lost+found'].includes(n))) throw new Error('volume_non_atteso');
    const fileDb = path.join(directory, 'lavori-prototipo.db'), statDb = fs.lstatSync(fileDb);
    if (!statDb.isFile() || statDb.isSymbolicLink() || statDb.size > MAX) throw new Error('database_non_atteso');
    temp = fs.mkdtempSync(path.join(temporanei, 'amr-backup-')); fs.chmodSync(temp, 0o700);
    // Un processo separato rende cancellabile anche l'attesa nativa di SQLite.
    const programma = "const {DatabaseSync,backup}=require('node:sqlite');let db;"
      + "(async()=>{db=new DatabaseSync(process.argv[1],{readOnly:true});await backup(db,process.argv[2]);})()"
      + ".finally(()=>db?.close()).catch(()=>{process.exitCode=1;});";
    await comando(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', programma,
      fileDb, path.join(temp, FILE[2])], { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    const copia = new DatabaseSync(path.join(temp, FILE[2]), { readOnly: true });
    let sqlite;
    try {
      if (copia.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('sqlite_non_integro');
      sqlite = Object.fromEntries(['lavori','eventi','sospensioni','token_revocati']
        .map(t => [t, copia.prepare('SELECT count(*) AS n FROM ' + t).get().n]));
    } finally { copia.close(); }
    fase = 'dump';
    const dump = await comando('/usr/lib/postgresql/18/bin/pg_dump', ['--no-password', '--format=custom',
      '--lock-wait-timeout=10s', '--snapshot=' + snapshot.id]);
    contenuti.push(dump);
    if (dump.subarray(0,5).toString('ascii') !== 'PGDMP') throw new Error('dump_non_atteso');
    fase = 'globals';
    const globals = await comando('/usr/lib/postgresql/18/bin/pg_dumpall',
      ['--no-password', '--globals-only', '--no-role-passwords']); contenuti.push(globals);
    fs.writeFileSync(path.join(temp, FILE[0]), dump, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(temp, FILE[1]), globals, { mode: 0o600, flag: 'wx' });
    const impronte = Object.fromEntries(FILE.slice(0,3).map(n => {
      const b = fs.readFileSync(path.join(temp,n));
      try { return [n, { byte: b.length, sha256: sha(b) }]; } finally { b.fill(0); }
    }));
    fs.writeFileSync(path.join(temp, FILE[3]), JSON.stringify({ versione: 1, acquisizione, release,
      inizio, fine: new Date().toISOString(), postgres: prima, sqlite, file: impronte }), { mode: 0o600, flag: 'wx' });
    volume = fs.readFileSync(path.join(temp,FILE[2]));
    fase = 'archivio';
    const postgres = await comando('/usr/bin/tar', ['--format=ustar', '-C', temp, '-cf', '-', FILE[0], FILE[1], FILE[3]],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    risultato = { postgres, volume };
  } catch {
    errore = Object.assign(new Error('backup_non_confermato'), { fase });
  } finally {
    contenuti.forEach(b => b.fill(0)); env.PGPASSWORD = '';
    try { await snapshot?.chiudi(); } catch { errore = Object.assign(new Error('backup_non_confermato'), { fase:'cleanup' }); }
    try { if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
    catch { errore = Object.assign(new Error('backup_non_confermato'), { fase:'cleanup' }); }
  }
  if (errore) { volume?.fill(0); risultato?.postgres.fill(0); throw errore; }
  return risultato;
}

// Il dump importa lo stesso snapshot dei conteggi; Auth può continuare a scrivere.
async function snapshotPostgres(pg, { signal, tempoMs }) {
  const client = new (require('pg').Client)({ host:pg.host, port:5432, user:pg.user,
    database:pg.database, password:()=>{if(pg.password)return pg.password;throw new Error('password_non_autorizzata');},
    ssl:false, connectionTimeoutMillis:10000,
    query_timeout:tempoMs, options:'-c role=postgres -c default_transaction_read_only=on -c statement_timeout=' + tempoMs });
  client.on('error',()=>{});
  let chiusura;
  const chiudi = () => chiusura ||= client.end();
  const interrompi = () => { void chiudi().catch(()=>{}); };
  const timer = setTimeout(interrompi,tempoMs);
  signal?.addEventListener('abort',interrompi,{once:true});
  const termina = async () => { clearTimeout(timer);signal?.removeEventListener('abort',interrompi);await chiudi(); };
  try {
    signal?.throwIfAborted(); await client.connect(); signal?.throwIfAborted();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const r = await client.query("SELECT pg_export_snapshot() AS id,jsonb_build_object('versione',current_setting('server_version'),"
      + "'database',current_database(),'bootstrap',(SELECT rolname FROM pg_roles WHERE oid=10),'session_user',session_user,'current_user',current_user,"
      + "'read_only',current_setting('transaction_read_only')='on','utenti_auth',(SELECT count(*) FROM auth.users),"
      + "'aziende',(SELECT count(*) FROM amr_accessi.aziende),'pool_attivi',(SELECT count(*) FROM pg_stat_activity "
      + "WHERE usename IN ('amr_gateway','amr_commerciale','amr_copie'))) AS metadati");
    return { ...r.rows[0], chiudi:termina };
  } catch { await termina();throw new Error('snapshot_non_confermato'); }
}

function creaServer({ origine, proxy, tokenHash, scadenza, prepara, ora = () => Date.now(), segnala = () => {} }) {
  if (!/^[a-f0-9]{64}$/.test(tokenHash || '') || !Number.isSafeInteger(scadenza)
      || scadenza <= ora() || scadenza - ora() > 20 * 60000) throw new Error('backup_config_non_valida');
  const trasporto = creaTrasporto({ origine, proxy }), atteso = Buffer.from(tokenHash, 'hex');
  let copia = null, richiesta = null, chiuso = false;
  const controller = new AbortController();
  const server = require('node:http').createServer((req,res) => {
    res.set = (n,v) => { res.setHeader(n,v); return res; };
    res.sendStatus = code => { res.statusCode = code; res.end(); };
    res.setHeader('Cache-Control', 'no-store');
    if (chiuso || ora() >= scadenza) return res.sendStatus(503);
    if (req.url === '/healthz' && ['GET','HEAD'].includes(req.method)) { res.end('ok'); return; }
    trasporto.verificaTrasporto(req,res,() => {
      const categoria = req.url === '/backup/postgres' ? 'postgres' : req.url === '/backup/volume' ? 'volume' : null;
      if (req.method !== 'GET' || !categoria || req.headers.origin !== undefined
          || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) !== 0) {
        return res.sendStatus(403);
      }
      const header = req.headers.authorization;
      const duplicati = req.rawHeaders.filter((_,i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization').length;
      if (duplicati !== 1 || typeof header !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(header)
          || !crypto.timingSafeEqual(Buffer.from(sha(header.slice(7)), 'hex'), atteso)) return res.sendStatus(401);
      // Una sola acquisizione; il retry del download riusa la copia, non ripete i dump.
      richiesta ||= Promise.resolve().then(() => prepara({ signal: controller.signal })).then(b => {
        if (chiuso || !b || Object.keys(b).length !== 2
            || ['postgres','volume'].some(n => !Buffer.isBuffer(b[n]) || b[n].length > MAX)) {
          for (const n of ['postgres','volume']) if (Buffer.isBuffer(b?.[n])) b[n].fill(0);
          throw new Error('backup_non_atteso');
        }
        copia = b; return b;
      }).catch(e => {
        segnala(['metadati_iniziali','sqlite','dump','globals','archivio','cleanup'].includes(e?.fase) ? e.fase : 'acquisizione');
        throw new Error('backup_non_confermato');
      });
      void richiesta.then(bundle => {
        if (chiuso || res.destroyed || ora() >= scadenza) return res.sendStatus(503);
        const b = bundle[categoria];
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', b.length);
        res.setHeader('X-AMR-Backup-SHA256', sha(b));
        res.end(b);
      }, () => res.sendStatus(503));
    });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  const chiudi = () => {
    chiuso = true; controller.abort(); server.close(); server.closeAllConnections();
    for (const b of Object.values(copia || {})) b.fill(0);
  };
  return { server, chiudi };
}

if (require.main === module) {
  let servizio;
  try {
    if (process.getuid() !== 1000 || Number(process.versions.node.split('.')[0]) !== 24) throw new Error('runtime_non_atteso');
    const env = process.env;
    if (!/^[a-f0-9]{40}$/.test(env.AMR_BACKUP_RELEASE || '') || !fs.readFileSync('/proc/self/mountinfo','utf8')
      .split('\n').some(r => r.split(' ')[4] === '/var/lib/amr') || !fs.readFileSync('/proc/self/mountinfo','utf8')
      .split('\n').some(r => r.split(' ')[4] === '/dev/shm' && r.includes(' - tmpfs '))) throw new Error('mount_non_atteso');
    // Il ruolo amministrativo del provider viene verificato prima della manutenzione.
    // Nessun ruolo runtime AMR, password aggiunta o apertura pubblica di PostgreSQL.
    const pg = { host: 'postgres-service', user: 'nhost_admin', database: env.AMR_BACKUP_DATABASE };
    if (!/^[a-z0-9]{20}$/.test(pg.database || '')) throw new Error('pg_non_configurato');
    const scadenza = Number(env.AMR_BACKUP_SCADENZA);
    servizio = creaServer({ origine: env.AMR_BACKUP_ORIGINE, proxy: proxyDaEnv(env.AMR_BACKUP_PROXY),
      tokenHash: env.AMR_BACKUP_TOKEN_SHA256, scadenza,
      segnala: fase => console.error('Backup non confermato: ' + fase),
      prepara: ({ signal }) => preparaCopia({ pg, signal, release: env.AMR_BACKUP_RELEASE }) });
    servizio.server.listen(3000,'0.0.0.0',() => console.log('Manutenzione backup pronta.'));
    servizio.server.once('error',() => { servizio.chiudi(); process.exitCode = 1; });
    const timer = setTimeout(() => servizio.chiudi(), scadenza - Date.now()); timer.unref();
    process.once('SIGTERM',servizio.chiudi); process.once('SIGINT',servizio.chiudi);
  } catch { servizio?.chiudi(); console.error('Manutenzione backup non avviata.'); process.exitCode = 1; }
}
module.exports = { preparaCopia, creaServer, eseguiComando, proxyDaEnv, MAX, FILE, sha };
