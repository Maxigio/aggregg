'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const LIMITE_OUTPUT = 1024 * 1024;
const LIMITE_PIANO = 16 * LIMITE_OUTPUT, MAX_SNAPSHOT = 10000, BATCH_RETENTION = 1000;

function percorsoReale(percorso) {
  let corrente = path.isAbsolute(percorso) ? percorso : process.cwd() + path.sep + percorso;
  const mancanti = [];
  for (;;) {
    try { fs.lstatSync(corrente); }
    catch (e) {
      if (e.code !== 'ENOENT' || path.dirname(corrente) === corrente) throw e;
      mancanti.unshift(path.basename(corrente)); corrente = path.dirname(corrente);
      continue;
    }
    return path.join(fs.realpathSync.native(corrente), ...mancanti);
  }
}

function verificaSeparazione(ambiente) {
  const repo = ambiente.RESTIC_REPOSITORY;
  const locale = repo.startsWith('local:') ? repo.slice(6)
    : path.isAbsolute(repo) || !repo.includes(':') || repo.startsWith('../') ? repo : null;
  if (locale === null) return;
  // Il backend locale restic pulisce il percorso prima di aprire i file del repo.
  const relativo = path.relative(percorsoReale(path.resolve(locale)), percorsoReale(ambiente.RESTIC_PASSWORD_FILE));
  if (!relativo.startsWith('..' + path.sep) && relativo !== '..') throw new Error('backup_non_configurato');
}

// Il chiamante passa un ambiente dedicato: nessuna lettura automatica dei .env.
// stdout/stderr restic possono contenere percorsi e configurazione: non esporli.
function creaRestic({ binario, ambiente, spawnProcesso = spawn }) {
  if (typeof binario !== 'string' || !binario.startsWith('/') || !ambiente?.RESTIC_REPOSITORY
      || !ambiente.RESTIC_PASSWORD_FILE) throw new Error('backup_non_configurato');
  if (ambiente.RESTIC_PASSWORD || ambiente.RESTIC_PASSWORD_COMMAND || ambiente.RESTIC_REPOSITORY_FILE) {
    throw new Error('backup_non_configurato');
  }
  if (typeof ambiente.RESTIC_REPOSITORY !== 'string' || typeof ambiente.RESTIC_PASSWORD_FILE !== 'string'
      || !path.isAbsolute(ambiente.RESTIC_PASSWORD_FILE)) throw new Error('backup_non_configurato');
  const env = { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC', ...ambiente };
  // Risolvi anche gli alias e i genitori esistenti di un repository nuovo.
  // Ricontrolla prima di ogni comando: un symlink può cambiare dopo il setup.
  try { verificaSeparazione(env); } catch { throw new Error('backup_non_configurato'); }
  const esegui = (args, input, limiteOutput = LIMITE_OUTPUT) => new Promise((resolve, reject) => {
    let child;
    try { verificaSeparazione(env); } catch { return reject(new Error('backup_non_configurato')); }
    try { child = spawnProcesso(binario, ['--no-cache', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return reject(new Error('backup_non_disponibile')); }
    let output = Buffer.alloc(limiteOutput), byte = 0, troppo = false, discoveryIncompleta = false;
    const interrompi = () => {
      if (troppo) return;
      troppo = true; output = undefined; child.kill('SIGTERM');
    };
    const timer = setTimeout(interrompi, 120000);
    const escalation = setTimeout(() => child.kill('SIGKILL'), 125000);
    child.stdout.on('data', b => {
      if (troppo) return;
      if (b.length > limiteOutput - byte) interrompi();
      else { b.copy(output, byte); byte += b.length; }
    });
    // snapshots può ignorare copie illeggibili e terminare con exit 0.
    // Non interpretare quella lista parziale come indice affidabile. Qualsiasi
    // diagnostica interrompe SOLO discovery, senza conservarne il contenuto.
    child.stderr.on('data', b => { if (args[0] === 'snapshots' && b.length) discoveryIncompleta = true; });
    child.stdin.on('error', () => {});
    child.once('error', () => {
      troppo = true; output = undefined;
      clearTimeout(timer); clearTimeout(escalation); reject(new Error('backup_non_disponibile'));
    });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(escalation);
      if (code !== 0 || troppo || discoveryIncompleta) { output = undefined; return reject(new Error('backup_non_disponibile')); }
      resolve(output.toString('utf8', 0, byte)); output = undefined;
    });
    child.stdin.end(input);
  });
  const json = async (args, limiteOutput) => {
    try { return JSON.parse(await esegui(args, undefined, limiteOutput)); }
    catch { throw new Error('backup_non_disponibile'); }
  };
  const filename = categoria => categoria === 'journal' ? 'operazioni.json'
    : categoria === 'recovery' ? 'recovery.json' : 'database.dump';
  const categoriaValida = categoria => {
    if (!['journal', 'database'].includes(categoria)) throw new Error('backup_input_non_valido');
  };
  async function copiaFile(contenuto, categoria, { data } = {}) {
    if (!Buffer.isBuffer(contenuto)) throw new Error('backup_input_non_valido');
    if (data !== undefined && (typeof data !== 'string' || !Number.isFinite(Date.parse(data))
        || new Date(data).toISOString() !== data || Date.parse(data) > Date.now())) {
      throw new Error('backup_input_non_valido');
    }
    const output = await esegui(['backup', '--json', '--stdin', '--stdin-filename',
      filename(categoria), '--host', 'amr-centro', '--tag', categoria,
      '--group-by', 'host,paths,tags', ...(data ? ['--time', data.slice(0,19).replace('T',' ')] : [])], contenuto);
    let summary;
    try { summary = output.trim().split('\n').map(v => JSON.parse(v))
      .find(v => v.message_type === 'summary'); }
    catch { throw new Error('backup_non_disponibile'); }
    if (!/^[a-f0-9]{64}$/.test(summary?.snapshot_id || '')) throw new Error('backup_non_disponibile');
    return { snapshot: summary.snapshot_id };
  }
  const repo = {
    async identita() {
      const config = await json(['cat', 'config']);
      if (!/^[a-f0-9]{64}$/.test(config?.id || '')) throw new Error('backup_non_disponibile');
      return config.id;
    },
    async inizializza() { await esegui(['init']); return { ok: true }; },
    async copia(contenuto, categoria, { data } = {}) {
      categoriaValida(categoria);
      return copiaFile(contenuto, categoria, { data });
    },
    // Categoria separata: nessuna discovery "latest" o retention implicita.
    async copiaIndice(contenuto) {
      if (!Buffer.isBuffer(contenuto) || !contenuto.length || contenuto.length > LIMITE_PIANO) {
        throw new Error('backup_input_non_valido');
      }
      return copiaFile(contenuto, 'recovery');
    },
    async leggiIndice(snapshot) {
      if (!/^[a-f0-9]{64}$/.test(snapshot || '')) throw new Error('backup_input_non_valido');
      return Buffer.from(await esegui(['dump', snapshot, '/recovery.json'], undefined, LIMITE_PIANO), 'utf8');
    },
    async verifica() { await esegui(['check', '--read-data']); return { ok: true }; },
    // Indice del repository, non dell'outbox perduta. Non restituire utenti,
    // percorsi o configurazione del processo che ha creato gli snapshot.
    async elenca(categoria) {
      categoriaValida(categoria);
      const snapshots = await json(['snapshots', '--json', '--host', 'amr-centro',
        '--path', '/' + filename(categoria), '--tag', categoria], LIMITE_PIANO);
      if (!Array.isArray(snapshots) || snapshots.length > MAX_SNAPSHOT
          || snapshots.some(s => !s || !/^[a-f0-9]{64}$/.test(s.id || '')
            || s.hostname !== 'amr-centro' || s.paths?.length !== 1 || s.paths[0] !== '/' + filename(categoria)
            || s.tags?.length !== 1 || s.tags[0] !== categoria || !Number.isFinite(Date.parse(s.time)))
          || new Set(snapshots.map(s => s.id)).size !== snapshots.length) {
        throw new Error('backup_indice_non_valido');
      }
      return snapshots.map(({ id, time }) => ({ id, time }));
    },
    // Il journal resta in memoria: nessun file JSON decifrato di appoggio.
    async leggiJournal(snapshot) {
      if (!/^[a-f0-9]{64}$/.test(snapshot || '')) throw new Error('backup_input_non_valido');
      return json(['dump', snapshot, '/operazioni.json'], 16384);
    },
    // Default non distruttivo. Il piano resta interno: niente percorsi/config in API.
    // Eliminazione solo di ID approvati dal dry-run, mai lifecycle dello storage.
    async retention(categoria, { dryRun = true, snapshot } = {}) {
      categoriaValida(categoria);
      if (typeof dryRun !== 'boolean' || !/^[a-f0-9]{64}$/.test(snapshot || '')) {
        throw new Error('backup_input_non_valido');
      }
      const gruppi = await json(['forget', '--json', '--dry-run', '--host', 'amr-centro',
        '--path', '/' + filename(categoria), '--tag', categoria, '--group-by', 'host,paths,tags',
        ...(categoria === 'journal' ? ['--keep-within', '90d', '--keep-last', '1'] : ['--keep-daily', '14'])], LIMITE_PIANO);
      if (!Array.isArray(gruppi)) throw new Error('backup_retention_non_sicura');
      let totale = 0;
      for (const gruppo of gruppi) {
        if (!Array.isArray(gruppo?.keep) || (gruppo.remove != null && !Array.isArray(gruppo.remove))) {
          throw new Error('backup_retention_non_sicura');
        }
        totale += gruppo.keep.length + (gruppo.remove?.length || 0);
        if (totale > MAX_SNAPSHOT) throw new Error('backup_retention_non_sicura');
      }
      const kept = [], removed = [];
      for (const gruppo of gruppi) {
        kept.push(...gruppo.keep); removed.push(...(gruppo.remove || []));
      }
      const tutti = [...kept, ...removed];
      if (!tutti.some(s => s?.id === snapshot) || tutti.some(s => !s || !/^[a-f0-9]{64}$/.test(s.id || '')
          || s.hostname !== 'amr-centro' || s.paths?.length !== 1 || s.paths[0] !== '/' + filename(categoria)
          || s.tags?.length !== 1 || s.tags[0] !== categoria || !Number.isFinite(Date.parse(s.time)))
          || new Set(tutti.map(s => s.id)).size !== tutti.length) {
        throw new Error('backup_retention_non_sicura');
      }
      if (categoria === 'journal') {
        const soglia = Math.max(...tutti.map(s => Date.parse(s.time))) - 90 * 86400000;
        if (removed.some(s => Date.parse(s.time) >= soglia)) throw new Error('backup_retention_non_sicura');
      } else {
        const giorni = [...new Set(tutti.map(s => new Date(s.time).toISOString().slice(0, 10)))].sort().reverse().slice(0, 14);
        if (giorni.some(g => !kept.some(s => new Date(s.time).toISOString().startsWith(g)))) {
          throw new Error('backup_retention_non_sicura');
        }
      }
      // Proteggi la copia dell'operazione in lavorazione solo dopo aver verificato
      // il piano originale: non aggirare i vincoli di categoria o di retention.
      const protetta = removed.findIndex(s => s.id === snapshot);
      if (protetta !== -1) kept.push(...removed.splice(protetta, 1));
      if (!dryRun) {
        await repo.verifica();
        for (let i = 0; i < removed.length; i += BATCH_RETENTION) {
          await esegui(['forget', ...removed.slice(i, i + BATCH_RETENTION).map(s => s.id)]);
        }
        // Il pending resta aperto se prune fallisce: sul retry remove può essere già vuoto.
        await esegui(['prune']);
      }
      return { dryRun, conservate: kept.length, eliminate: dryRun ? 0 : removed.length, eliminabili: removed.length };
    },
    async ripristina(snapshot, directory) {
      if (!/^[a-f0-9]{64}$/.test(snapshot || '') || typeof directory !== 'string'
          || !path.isAbsolute(directory)) {
        throw new Error('backup_input_non_valido');
      }
      // Directory nuova privata: niente sovrascrittura del database vivo.
      let destinazione;
      try {
        destinazione = fs.mkdtempSync(path.join(directory, 'amr-restore-'));
        await esegui(['restore', snapshot, '--target', destinazione, '--verify']);
        return destinazione;
      } catch {
        const errore = new Error('backup_non_disponibile');
        if (destinazione) try {
          // Il restore può modificare i permessi della radice temporanea privata.
          fs.chmodSync(destinazione, 0o700);
          fs.rmSync(destinazione, { recursive: true, force: true });
        } catch { errore.cleanupIncompleto = true; }
        throw errore;
      }
    },
  };
  return repo;
}
module.exports = { creaRestic };
