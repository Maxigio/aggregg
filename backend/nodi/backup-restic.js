'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const LIMITE_OUTPUT = 1024 * 1024;
const LIMITE_PIANO = 16 * LIMITE_OUTPUT, MAX_SNAPSHOT = 10000, BATCH_RETENTION = 1000;

// Il chiamante passa un ambiente dedicato: nessuna lettura automatica dei .env.
// stdout/stderr restic possono contenere percorsi e configurazione: non esporli.
function creaRestic({ binario, ambiente, spawnProcesso = spawn }) {
  if (typeof binario !== 'string' || !binario.startsWith('/') || !ambiente?.RESTIC_REPOSITORY
      || !ambiente.RESTIC_PASSWORD_FILE) throw new Error('backup_non_configurato');
  if (ambiente.RESTIC_PASSWORD || ambiente.RESTIC_PASSWORD_COMMAND || ambiente.RESTIC_REPOSITORY_FILE) {
    throw new Error('backup_non_configurato');
  }
  if (!path.isAbsolute(ambiente.RESTIC_PASSWORD_FILE)) throw new Error('backup_non_configurato');
  if (path.isAbsolute(ambiente.RESTIC_REPOSITORY)) {
    const relativo = path.relative(path.resolve(ambiente.RESTIC_REPOSITORY), path.resolve(ambiente.RESTIC_PASSWORD_FILE));
    if (!relativo.startsWith('..' + path.sep) && relativo !== '..') throw new Error('backup_non_configurato');
  }
  const env = { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC', ...ambiente };
  const esegui = (args, input, limiteOutput = LIMITE_OUTPUT) => new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcesso(binario, ['--no-cache', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return reject(new Error('backup_non_disponibile')); }
    let output = Buffer.alloc(limiteOutput), byte = 0, troppo = false;
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
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.once('error', () => {
      troppo = true; output = undefined;
      clearTimeout(timer); clearTimeout(escalation); reject(new Error('backup_non_disponibile'));
    });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(escalation);
      if (code !== 0 || troppo) { output = undefined; return reject(new Error('backup_non_disponibile')); }
      resolve(output.toString('utf8', 0, byte)); output = undefined;
    });
    child.stdin.end(input);
  });
  const json = async (args, limiteOutput) => {
    try { return JSON.parse(await esegui(args, undefined, limiteOutput)); }
    catch { throw new Error('backup_non_disponibile'); }
  };
  const filename = categoria => categoria === 'journal' ? 'operazioni.json' : 'database.dump';
  const categoriaValida = categoria => {
    if (!['journal', 'database'].includes(categoria)) throw new Error('backup_input_non_valido');
  };
  const repo = {
    async identita() {
      const config = await json(['cat', 'config']);
      if (!/^[a-f0-9]{64}$/.test(config?.id || '')) throw new Error('backup_non_disponibile');
      return config.id;
    },
    async inizializza() { await esegui(['init']); return { ok: true }; },
    async copia(contenuto, categoria, { data } = {}) {
      if (!['journal', 'database'].includes(categoria) || !Buffer.isBuffer(contenuto)) {
        throw new Error('backup_input_non_valido');
      }
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
    },
    async verifica() { await esegui(['check', '--read-data']); return { ok: true }; },
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
      if (!kept.some(s => s?.id === snapshot) || tutti.some(s => !s || !/^[a-f0-9]{64}$/.test(s.id || '')
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
      if (!dryRun && removed.length) {
        await repo.verifica();
        // ponytail: massimo 10 batch, prune ripetuto; prune unico richiede retry persistente dedicato.
        for (let i = 0; i < removed.length; i += BATCH_RETENTION) {
          await esegui(['forget', '--prune', ...removed.slice(i, i + BATCH_RETENTION).map(s => s.id)]);
        }
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
        if (destinazione) fs.rmSync(destinazione, { recursive: true, force: true });
        throw new Error('backup_non_disponibile');
      }
    },
  };
  return repo;
}
module.exports = { creaRestic };
