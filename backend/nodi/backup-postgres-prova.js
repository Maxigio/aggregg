'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SNAPSHOT = /^[a-f0-9]{64}$/;
const errore = (codice = 'backup_non_disponibile') => Object.assign(new Error(codice), { codice, status: 503 });

// pg_dump consistente, formato custom, solo buffer transitorio limitato.
// Ambiente dedicato dal chiamante: nessun .env, URI/password negli argomenti o log.
function creaDumpPostgres({ binario, ambiente, spawnProcesso = spawn, maxBytes = 64 * 1024 * 1024 }) {
  if (!path.isAbsolute(binario || '') || !ambiente?.PGDATABASE
      || !Number.isSafeInteger(maxBytes) || maxBytes < 5 || maxBytes > 512 * 1024 * 1024
      || Object.keys(ambiente).some(k => !['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSFILE','PGSSLMODE','PGSSLROOTCERT'].includes(k))
      || !/^[a-zA-Z0-9_.-]+$/.test(ambiente.PGDATABASE)) throw errore('backup_non_configurato');
  const env = { PATH: process.env.PATH, LANG: 'C', ...ambiente };
  return () => new Promise((resolve, reject) => {
    let child, size = 0, troppo = false;
    const chunks = [];
    try { child = spawnProcesso(binario, ['--format=custom', '--no-password', '--lock-wait-timeout=10s'],
      { env, stdio: ['ignore','pipe','pipe'] }); }
    catch { return reject(errore()); }
    const timer = setTimeout(() => { troppo = true; child.kill('SIGTERM'); }, 120000);
    const escalation = setTimeout(() => child.kill('SIGKILL'), 125000);
    child.stderr.resume();
    child.stdout.on('data', b => {
      size += b.length;
      if (size > maxBytes) { troppo = true; b.fill(0); child.kill('SIGTERM'); }
      else chunks.push(b);
    });
    const finish = code => {
      clearTimeout(timer); clearTimeout(escalation);
      let data;
      if (code === 0 && !troppo) data = Buffer.concat(chunks);
      for (const b of chunks) b.fill(0);
      if (!data || data.subarray(0, 5).toString('ascii') !== 'PGDMP') {
        data?.fill(0); reject(errore());
      } else resolve(data);
    };
    child.once('error', () => finish(-1));
    child.once('close', finish);
  });
}

// Pool del worker con SOLO amr_backup_esecutore. Un claim per volta evita lease
// che scadono mentre il resto del batch attende. Upload at-least-once: crash tra
// copia e CAS può duplicare snapshot; l'UUID del journal permette deduplicazione.
function creaBackupPostgres({ pool, repositoryJournal, repositoryDatabase, dumpDatabase,
  batch = 8, leaseSecondi = 600, intervalloMs = 30000, applicaRetention = false }) {
  if (typeof pool?.query !== 'function' || !Number.isInteger(batch) || batch < 1 || batch > 32
      || !Number.isInteger(leaseSecondi) || leaseSecondi < 60 || leaseSecondi > 3600
      || !Number.isInteger(intervalloMs) || intervalloMs < 10 || intervalloMs > 3600000
      || typeof applicaRetention !== 'boolean') throw errore('backup_non_configurato');
  const repos = { journal: repositoryJournal, database: repositoryDatabase };
  const idsNoti = {};
  let attivo = false, timer, segnale, inCorso, fermaBatch = false;
  const sql = async (funzione, args = [], cast = []) => {
    try {
      const r = await pool.query(`SELECT amr_backup.${funzione}(${args.map((_, i) => '$' + (i + 1) + '::' + cast[i]).join(',')}) AS risultato`, args);
      if (!r.rows?.length) throw errore();
      return r.rows[0].risultato;
    } catch { throw errore(); }
  };
  async function eseguiBatch() {
    let completate = 0, fallite = 0;
    try {
      await sql('programma_database');
      const categorie = ['journal','database'];
      const identita = await Promise.allSettled(categorie.map(async categoria => {
        if (!repos[categoria]) throw errore('backup_non_configurato');
        const id = await repos[categoria].identita();
        if (!SNAPSHOT.test(id || '')) throw errore();
        idsNoti[categoria] = id;
      }));
      const coincidenti = idsNoti.journal && idsNoti.journal === idsNoti.database;
      const disponibili = {};
      for (let i = 0; i < categorie.length; i++) {
        disponibili[categorie[i]] = identita[i].status === 'fulfilled' && !coincidenti;
      }
      await sql('configura', [disponibili.journal && disponibili.database && typeof dumpDatabase === 'function',applicaRetention], ['boolean','boolean']);
      for (let i = 0; i < batch; i++) {
        if (fermaBatch) break;
        const job = await sql('claim', [leaseSecondi], ['integer']);
        if (!job) break;
        let data;
        try {
          if (!repos[job.categoria] || (job.categoria === 'database' && typeof dumpDatabase !== 'function')) {
            throw errore('backup_non_configurato');
          }
          if (!disponibili[job.categoria]) throw errore();
          if (!repos[job.categoria] || !UUID.test(job.lease)) throw errore();
          if (job.categoria === 'journal') {
            // Il payload è l'allowlist SQL immutabile catturata al commit.
            data = Buffer.from(JSON.stringify(job.journal));
            if (data.length > 16384) throw errore();
          } else data = await dumpDatabase();
          if (!Buffer.isBuffer(data) || !data.length) throw errore();
          const copia = await repos[job.categoria].copia(data, job.categoria,
            job.categoria === 'journal' ? { data: new Date(job.journal.confermata_il).toISOString() } : {});
          if (!SNAPSHOT.test(copia?.snapshot || '')) throw errore();
          const ok = await sql('completa', [job.id, job.lease, copia.snapshot], ['text','uuid','text']);
          if (ok) completate++;
        } catch (e) {
          fallite++;
          await sql('fallisce', [job.id, job.lease, e?.codice === 'backup_non_configurato'
            ? 'backup_non_configurato' : 'backup_non_disponibile'], ['text','uuid','text']);
        } finally { data?.fill?.(0); }
      }
      for (const { categoria, snapshot } of await sql('retention_pending')) {
        let erroreRetention = false;
        try {
          if (!disponibili[categoria]) throw errore();
          await repos[categoria].retention(categoria, { dryRun: !applicaRetention, snapshot });
        }
        catch { erroreRetention = true; }
        await sql('esito_retention', [categoria, snapshot, erroreRetention], ['text','text','boolean']);
        if (applicaRetention && categoria === 'journal' && !erroreRetention) await sql('pulisci');
      }
      return { ok: true, completate, fallite };
    } catch { return { ok: false, completate, fallite, codice: 'backup_non_disponibile' }; }
  }
  function drain() {
    if (!inCorso) {
      fermaBatch = false;
      inCorso = eseguiBatch().finally(() => { inCorso = null; });
    }
    return inCorso;
  }
  // Chiamare dopo ogni operazione confermata o da LISTEN amr_backup_operazione.
  // Il chiamante non attende il backup nella transazione/risposta commerciale.
  function segnalaOperazione() {
    if (!attivo || segnale) return;
    segnale = setImmediate(() => { segnale = null; void drain(); });
    segnale.unref();
  }
  return { drain, segnalaOperazione,
    start() {
      if (attivo) return;
      attivo = true;
      timer = setInterval(segnalaOperazione, intervalloMs); timer.unref(); segnalaOperazione();
    },
    async stop() {
      attivo = false; fermaBatch = true; clearInterval(timer); clearImmediate(segnale); segnale = null;
      if (inCorso) await inCorso;
    },
  };
}

// Il pool deve avere connectionTimeoutMillis/statement_timeout finiti e almeno
// due posti: uno per LISTEN, uno per i job. Non legge dati né avvia il worker.
// Una connessione/timer per listener, backoff 250ms..30s, polling del worker come
// fallback. Chiusura idempotente: termina il job in corso, senza prendere altri.
async function collegaNotificheBackup({ pool, worker }) {
  if (typeof pool?.connect !== 'function' || typeof worker?.segnalaOperazione !== 'function'
      || typeof worker?.stop !== 'function') throw errore('backup_non_configurato');
  let chiuso = false, client, connessione, timer, chiusura, ritardo = 250;
  const ignoraErrore = () => {};
  const notifica = n => {
    if (!chiuso && n?.channel === 'amr_backup_operazione') {
      try { worker.segnalaOperazione(); } catch { /* polling resta attivo */ }
    }
  };
  function scollega(c, distruggi) {
    c.removeListener('notification',notifica);
    c.removeListener('error',persa); c.removeListener('end',persa);
    if (distruggi) c.on('error',ignoraErrore); // evento tardivo del socket distrutto
    try { c.release(distruggi); } catch {}
  }
  function riprova() {
    if (chiuso || timer) return;
    timer = setTimeout(() => { timer = null; void collega(); },ritardo);
    timer.unref(); ritardo = Math.min(30000,ritardo*2);
  }
  function persa() {
    if (client) { const c = client; client = null; scollega(c,true); }
    riprova();
  }
  function collega() {
    if (chiuso || connessione || client) return connessione;
    connessione = (async () => {
      let c;
      try {
        c = await pool.connect();
        if (chiuso) { scollega(c,true); return; }
        client = c;
        c.on('error',persa); c.on('end',persa); c.on('notification',notifica);
        await c.query('LISTEN amr_backup_operazione');
        if (chiuso || client !== c) return;
        ritardo = 250;
        // Copre i commit avvenuti durante la connessione/riconnessione.
        worker.segnalaOperazione();
      } catch {
        if (c && client === c) { client = null; scollega(c,true); }
        riprova();
      }
    })().finally(() => { connessione = null; if (!chiuso && !client) riprova(); });
    return connessione;
  }
  await collega();
  return { close() {
    if (!chiusura) {
      chiuso = true; clearTimeout(timer); timer = null;
      chiusura = (async () => {
        if (connessione) await connessione;
        if (client) {
          const c = client; client = null;
          c.removeListener('notification',notifica);
          let distruggi = false;
          try { await c.query('UNLISTEN amr_backup_operazione'); } catch { distruggi = true; }
          scollega(c,distruggi);
        }
        await worker.stop();
      })();
    }
    return chiusura;
  } };
}

// Pool distinto del processo web: ruolo amr_aziende_scrittore, senza claim/dump.
function creaStatoBackup({ pool }) {
  if (typeof pool?.query !== 'function') throw errore('backup_non_configurato');
  const esegui = async (funzione, s) => {
    if (!UUID.test(s?.persona || '') || s?.mfa !== true || !Number.isInteger(s.epoca)
        || s.epoca < 0 || s.epoca > 2147483647) {
      throw Object.assign(new Error('accesso_non_autorizzato'), { codice: 'accesso_non_autorizzato', status: 403 });
    }
    try {
      const r = await pool.query(`SELECT amr_backup.${funzione}($1::uuid,$2::integer,$3::boolean) AS risultato`, [s.persona,s.epoca,true]);
      if (!r.rows?.[0]?.risultato) throw errore();
      return r.rows[0].risultato;
    } catch (e) {
      if (e?.code === 'P0001' && ['accesso_non_autorizzato','sessione_revocata'].includes(e.message)) {
        throw Object.assign(new Error(e.message), { codice: e.message, status: 403 });
      }
      throw errore();
    }
  };
  return { stato: s => esegui('stato', s), riprova: s => esegui('riprova_admin', s) };
}
module.exports = { creaBackupPostgres, creaDumpPostgres, creaStatoBackup, collegaNotificheBackup };
