'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { verificaArtefatto } = require('../backend/nodi/compatibilita-nodo');

// Il file privato contiene solo la credenziale del nodo. Non ereditiamo Auth,
// SMTP o .env dell'app; dati e log appartengono esclusivamente al collaudo.
function configura({ file, radice, directory, live = false }) {
  try {
    if (![file, radice, directory].every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let config;
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid() || s.size > 8192) throw new Error();
      config = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
    if (!config || Object.keys(config).some(k => !['centro', 'id', 'token'].includes(k))
        || !/^[a-zA-Z0-9_-]{1,40}$/.test(config.id || '') || !/^[a-f0-9]{64}$/.test(config.token || '')) throw new Error();
    const origine = new URL(config.centro);
    if (origine.protocol !== 'https:' || origine.origin !== config.centro || origine.username || origine.password) throw new Error();
    const releaseFile = path.join(radice, 'release.json');
    const s = fs.lstatSync(releaseFile);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 4 * 1024 * 1024) throw new Error();
    const manifest = verificaArtefatto(JSON.parse(fs.readFileSync(releaseFile, 'utf8')), radice);
    // Una directory nuova evita di riusare cache o dati dell'app. Un percorso
    // preesistente viene rifiutato; non scriviamo nell'artefatto verificato.
    const realRoot = fs.realpathSync(radice), parent = fs.realpathSync(path.dirname(directory));
    const realData = path.join(parent, path.basename(directory));
    if (realData === realRoot || realData.startsWith(realRoot + path.sep)) throw new Error();
    fs.mkdirSync(directory, { mode: 0o700 });
    return { manifest, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
      AMR_CENTRO_URL: config.centro, AMR_NODO_ID: config.id, AMR_NODI_TOKEN: config.token,
      AMR_NODI_RELEASE_FILE: releaseFile, USER_DATA_PATH: directory, AMR_LOG_DIR: path.join(directory, 'log'),
      AMR_NODO_SIMULATO: live ? '0' : '1' } };
  } catch { throw new Error('configurazione_worker_staging_non_valida'); }
}

function avvia(options, spawnProcess = spawn) {
  const { manifest, env } = configura(options);
  const child = spawnProcess(process.execPath, [path.join(options.radice, 'backend/nodi/worker.js')], {
    cwd: options.radice, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let chiusura, terminato = false;
  child.once('exit', () => { terminato = true; });
  child.once('error', () => { terminato = true; });
  const close = () => chiusura ||= new Promise(resolve => {
    if (terminato) return resolve();
    const finito = () => { clearTimeout(timer); child.off('exit', finito); child.off('error', finito); resolve(); };
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', finito); child.once('error', finito); child.kill('SIGTERM');
  });
  return { child, manifest, close };
}
if (require.main === module) {
  let worker;
  try {
    const [file, radice, directory, flag, ...resto] = process.argv.slice(2);
    if (resto.length || (flag !== undefined && flag !== '--live') || Number(process.versions.node.split('.')[0]) !== 24) throw new Error();
    worker = avvia({ file, radice, directory, live: flag === '--live' });
    worker.child.once('spawn', () => console.log(JSON.stringify({ evento: 'processo_worker_avviato',
      simulato: flag !== '--live', release: worker.manifest.release, pid: worker.child.pid })));
    worker.child.once('exit', (code, signal) => {
      console.log(JSON.stringify({ evento: 'processo_worker_terminato', code, signal }));
      process.exitCode = code ?? 1;
    });
    worker.child.once('error', () => { console.error('Worker staging non avviato.'); process.exitCode = 1; });
    for (const segnale of ['SIGINT', 'SIGTERM']) process.once(segnale, () => { void worker.close(); });
  } catch { console.error('Worker staging non avviato: verificare configurazione e artefatto.'); process.exitCode = 1; }
}
module.exports = { configura, avvia };
