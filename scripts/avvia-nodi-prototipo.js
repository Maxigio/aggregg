'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const radice = path.join(__dirname, '..');
const directory = path.join(os.tmpdir(), 'amr-nodi-prototipo');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const tokens = { 'imac-reale': crypto.randomBytes(32).toString('hex'),
  'imac-simulato': crypto.randomBytes(32).toString('hex') };
const port = Number(process.env.AMR_CENTRO_PORT || 47360);
const baseEnv = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','NODE_EXTRA_CA_CERTS']
  .filter(k => process.env[k] != null).map(k => [k, process.env[k]]));
const env = { ...baseEnv, USER_DATA_PATH: directory, AMR_LOG_DIR: directory,
  AMR_NODI_DATA_DIR: directory, AMR_NODI_TOKENS: JSON.stringify(tokens), AMR_CENTRO_PORT: String(port),
  AMR_CENTRO_URL: `http://127.0.0.1:${port}` };
const figli = [];
function avvia(file, extra = {}) {
  if (extra.AMR_NODO_ID) fs.mkdirSync(path.join(directory, extra.AMR_NODO_ID), { recursive: true, mode: 0o700 });
  const p = spawn(process.execPath, [path.join(radice, file)], {
    cwd: radice, env: { ...env, ...extra,
      ...(extra.AMR_NODO_ID ? { USER_DATA_PATH: path.join(directory, extra.AMR_NODO_ID) } : {}) },
    stdio: 'inherit',
  });
  figli.push(p);
  p.on('exit', code => { if (code && !chiudendo) termina(); });
}
let chiudendo = false;
function termina() { if (chiudendo) return; chiudendo = true; for (const p of figli) p.kill('SIGTERM'); }
process.on('SIGINT', termina);
process.on('SIGTERM', termina);
avvia('backend/nodi/centro.js');
setTimeout(() => avvia('backend/nodi/worker.js', { AMR_NODO_ID: 'imac-reale', AMR_NODI_TOKEN: tokens['imac-reale'], AMR_NODI_TOKENS: '' }), 400);
setTimeout(() => avvia('backend/nodi/worker.js', { AMR_NODO_ID: 'imac-simulato', AMR_NODO_SIMULATO: '1',
  AMR_NODI_TOKEN: tokens['imac-simulato'], AMR_NODI_TOKENS: '' }), 500);
console.log(`Centro di prova: http://127.0.0.1:${port} · dati temporanei: ${directory}`);
