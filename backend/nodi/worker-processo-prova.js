'use strict';
const fs = require('node:fs'), path = require('node:path');

// Processo figlio del collaudo: niente ambiente Auth/SMTP o credenziali AMR ereditate.
function avviaWorker({ origine, token, directory, spawn = require('node:child_process').spawn }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origine) || typeof token !== 'string' || token.length < 32
      || typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('configurazione worker non valida');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_EXTRA_CA_CERTS']
    .filter(k => process.env[k] != null).map(k => [k, process.env[k]]));
  const processo = spawn(process.execPath, [path.join(__dirname, 'worker.js')], {
    cwd: path.join(__dirname, '../..'), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...env,
      AMR_CENTRO_URL: origine, AMR_NODO_ID: 'locale', AMR_NODI_TOKEN: token,
      USER_DATA_PATH: directory, AMR_LOG_DIR: directory }
  });
  let terminato = false;
  processo.once('error', () => { terminato = true; });
  processo.once('exit', () => { terminato = true; });
  return { processo, get terminato() { return terminato; }, close: async () => {
    if (terminato) return;
    await new Promise(resolve => {
      const finito = () => { clearTimeout(timer); processo.off('exit', finito); processo.off('error', finito); resolve(); };
      const timer = setTimeout(() => { processo.kill('SIGKILL'); }, 5000);
      processo.once('exit', finito); processo.once('error', finito);
      processo.kill('SIGTERM');
    });
  } };
}
module.exports = { avviaWorker };
