'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');

// Il chiamante passa un ambiente dedicato: nessuna lettura automatica dei .env.
// stdout/stderr restic possono contenere percorsi e configurazione: non esporli.
function creaRestic({ binario, ambiente, spawnProcesso = spawn }) {
  if (typeof binario !== 'string' || !binario.startsWith('/') || !ambiente?.RESTIC_REPOSITORY
      || !ambiente.RESTIC_PASSWORD_FILE) throw new Error('backup_non_configurato');
  const env = { PATH: process.env.PATH, LANG: 'C', ...ambiente };
  const esegui = (args, input) => new Promise((resolve, reject) => {
    const child = spawnProcesso(binario, ['--no-cache', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', troppo = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    const escalation = setTimeout(() => child.kill('SIGKILL'), 125000);
    child.stdout.on('data', b => {
      if (Buffer.byteLength(output) + b.length > 1024 * 1024) {
        troppo = true; child.kill('SIGTERM');
      } else output += b.toString('utf8');
    });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); clearTimeout(escalation); reject(new Error('backup_non_disponibile')); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(escalation);
      if (code !== 0 || troppo) return reject(new Error('backup_non_disponibile'));
      resolve(output);
    });
    child.stdin.end(input);
  });
  return {
    async inizializza() { await esegui(['init']); return { ok: true }; },
    async copia(contenuto, categoria) {
      if (!['journal', 'database'].includes(categoria) || !Buffer.isBuffer(contenuto)) {
        throw new Error('backup_input_non_valido');
      }
      const output = await esegui(['backup', '--json', '--stdin', '--stdin-filename',
        categoria === 'journal' ? 'operazioni.json' : 'database.dump', '--host', 'amr-centro',
        '--tag', categoria], contenuto);
      let summary;
      try { summary = output.trim().split('\n').map(v => JSON.parse(v))
        .find(v => v.message_type === 'summary'); }
      catch { throw new Error('backup_non_disponibile'); }
      if (!/^[a-f0-9]{64}$/.test(summary?.snapshot_id || '')) throw new Error('backup_non_disponibile');
      return { snapshot: summary.snapshot_id };
    },
    async verifica() { await esegui(['check', '--read-data']); return { ok: true }; },
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
}
module.exports = { creaRestic };
