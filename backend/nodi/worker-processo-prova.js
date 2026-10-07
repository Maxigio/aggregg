'use strict';
const fs = require('node:fs'), path = require('node:path');

// Processo figlio del collaudo: niente ambiente Auth/SMTP o credenziali AMR ereditate.
function avviaWorker({ origine, token, directory, spawn = require('node:child_process').spawn }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origine) || typeof token !== 'string' || token.length < 32
      || typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('configurazione worker non valida');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_EXTRA_CA_CERTS']
    .filter(k => process.env[k] != null).map(k => [k, process.env[k]]));
  return require('./worker-supervisore').supervisiona({ file: path.join(__dirname, 'worker.js'),
    cwd: path.join(__dirname, '../..'), spawn, env: { ...env,
      AMR_CENTRO_URL: origine, AMR_NODO_ID: 'locale', AMR_NODI_TOKEN: token,
      USER_DATA_PATH: directory, AMR_LOG_DIR: directory }
  });
}
module.exports = { avviaWorker };
