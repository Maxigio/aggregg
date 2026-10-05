'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), net = require('node:net');
const { parseArgs } = require('node:util');
const { preparaContesto } = require('../prepara-contesto-centro');
const { valida } = require('../../backend/nodi/compatibilita-nodo');
const { configura } = require('../../backend/nodi/config-centro-run');

const PROGETTO = 'edc82c4c-fbd2-4dca-95c6-664f30f47662';
const SERVIZIO = '40f9c208-5e1b-49ac-afcd-54e56d70de8b';
const REGISTRY = 'registry.eu-central-1.nhost.run/' + SERVIZIO;
const ORIGINE = 'https://fashsekadydbcdkedqqx-3000.svc.eu-central-1.nhost.run';
const AUTH = 'https://muwqbjnpgdfnghdqxvmk.auth.eu-central-1.nhost.run/v1';
const PUBBLICHE = {
  NODE_ENV: 'production', PORT: '3000', AMR_CENTRO_REPLICHE: '1',
  AMR_NODI_RELEASE_FILE: '/opt/amr/release.json', AMR_NODI_DATA_DIR: '/var/lib/amr',
  AMR_NODI_RICERCA_TIMEOUT_MS: '60000', AMR_NODI_RICERCHE_MAX_PERSONA: '2',
  AMR_NODI_RICERCHE_MAX_TOTALE: '60', AMR_PG_HOST: 'postgres-service',
  AMR_PG_PORT: '5432', AMR_PG_RETE_PRIVATA: '1', AMR_PG_LETTURA_USER: 'amr_gateway',
  AMR_PG_COMMERCIALE_USER: 'amr_commerciale', AMR_PG_BACKUP_USER: 'amr_copie',
};
const SEGRETE = ['AMR_NODI_TOKENS', 'AMR_PG_DATABASE', 'AMR_PG_LETTURA_PASSWORD',
  'AMR_PG_COMMERCIALE_PASSWORD', 'AMR_PG_BACKUP_PASSWORD'];
const riferimento = nome => '{{ secrets.' + nome + ' }}';
const errore = () => { throw new Error('pacchetto_staging_non_valido'); };
function chiavi(v, attese) {
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || JSON.stringify(Object.keys(v).sort()) !== JSON.stringify([...attese].sort())) errore();
}
function immagine(v) {
  if (typeof v !== 'string' || !v.startsWith(REGISTRY + '@sha256:')
    || !/^[a-f0-9]{64}$/.test(v.slice((REGISTRY + '@sha256:').length))) errore();
  return v;
}

// Accetta solo lo staging conosciuto e riferimenti, mai valori di credenziali.
// Un nuovo campo richiede una review: ignorarlo perderebbe configurazione al rollback.
function validaStato(stato) {
  chiavi(stato, ['progetto', 'servizio', 'manifest', 'config']);
  if (stato.progetto !== PROGETTO || stato.servizio !== SERVIZIO) errore();
  chiavi(stato.manifest, ['protocollo', 'release', 'codice', 'cataloghi']);
  const manifest = valida(stato.manifest), c = stato.config;
  chiavi(c, ['name', 'command', 'image', 'environment', 'ports', 'resources', 'healthCheck']);
  chiavi(c.image, ['image']); immagine(c.image.image);
  if (c.name !== 'amr-centro-staging' || !Array.isArray(c.command) || c.command.length) errore();
  chiavi(c.resources, ['replicas', 'compute', 'storage']);
  chiavi(c.resources.compute, ['cpu', 'memory']);
  if (c.resources.replicas !== 1 || c.resources.compute.cpu !== 500 || c.resources.compute.memory !== 1024) errore();
  if (!Array.isArray(c.resources.storage) || c.resources.storage.length !== 1) errore();
  const volume = c.resources.storage[0]; chiavi(volume, ['name', 'path', 'capacity']);
  if (volume.name !== 'amr-centro-dati' || volume.path !== '/var/lib/amr' || volume.capacity !== 1) errore();
  if (!Array.isArray(c.ports) || c.ports.length !== 1) errore();
  chiavi(c.ports[0], ['port', 'type', 'publish']);
  if (c.ports[0].port !== 3000 || c.ports[0].type !== 'http' || c.ports[0].publish !== true) errore();
  chiavi(c.healthCheck, ['port', 'initialDelaySeconds', 'probePeriodSeconds']);
  if (c.healthCheck.port !== 3000 || c.healthCheck.initialDelaySeconds !== 30 || c.healthCheck.probePeriodSeconds !== 60) errore();
  const nomi = [...Object.keys(PUBBLICHE), ...SEGRETE, 'AMR_CENTRO_ORIGINE', 'AMR_NHOST_AUTH_URL', 'AMR_CENTRO_PROXY_IP'];
  if (!Array.isArray(c.environment) || c.environment.length !== nomi.length) errore();
  const env = Object.create(null);
  for (const voce of c.environment) {
    chiavi(voce, ['name', 'value']);
    if (!nomi.includes(voce.name) || typeof voce.value !== 'string' || Object.hasOwn(env, voce.name)) errore();
    env[voce.name] = voce.value;
  }
  for (const [nome, value] of Object.entries(PUBBLICHE)) if (env[nome] !== value) errore();
  for (const nome of SEGRETE) if (env[nome] !== riferimento(nome)) errore();
  for (const [nome, value] of [['AMR_CENTRO_ORIGINE', ORIGINE], ['AMR_NHOST_AUTH_URL', AUTH]]) {
    if (env[nome] !== value && env[nome] !== riferimento(nome)) errore();
  }
  const proxy = env.AMR_CENTRO_PROXY_IP;
  if (proxy !== riferimento('AMR_CENTRO_PROXY_IP')
    && (!proxy || proxy.length > 512 || proxy.split(',').some(ip => !net.isIP(ip.trim())))) errore();
  // Riusa la validazione runtime con soli valori sintetici. Non risolve segreti Nhost.
  configura({ ...env, AMR_CENTRO_ORIGINE: ORIGINE, AMR_NHOST_AUTH_URL: AUTH,
    AMR_CENTRO_PROXY_IP: proxy === riferimento('AMR_CENTRO_PROXY_IP') ? '127.0.0.1' : proxy,
    AMR_NODI_TOKENS: JSON.stringify({ sintetico: 'a'.repeat(64) }), AMR_PG_DATABASE: 'postgres',
    ...Object.fromEntries(SEGRETE.filter(n => n.endsWith('_PASSWORD')).map(n => [n, 'sintetico-non-segreto'])) });
  return { ...structuredClone(stato), manifest };
}

// Scrive il solo schema Run ammesso sopra. JSON quoting è usato come stringa
// TOML, mai interpolato in una shell. Non legge .env né esporta segreti risolti.
function toml(c) {
  const valori = obj => Object.entries(obj).map(([k, v]) => k + ' = ' + JSON.stringify(v)).join('\n');
  const sezioni = [['image', c.image], ['resources', { replicas: c.resources.replicas }],
    ['resources.compute', c.resources.compute], ['healthCheck', c.healthCheck]];
  const array = [['environment', c.environment], ['ports', c.ports], ['resources.storage', c.resources.storage]];
  return valori({ name: c.name, command: c.command }) + '\n\n'
    + sezioni.map(([n, v]) => '[' + n + ']\n' + valori(v)).join('\n\n') + '\n\n'
    + array.flatMap(([n, a]) => a.map(v => '[[' + n + ']]\n' + valori(v))).join('\n\n') + '\n';
}
function preparaPiano({ stato, candidato, image }) {
  const precedente = validaStato(stato), nuovo = valida(candidato);
  immagine(image);
  if (nuovo.release === precedente.manifest.release || image === precedente.config.image.image) errore();
  const config = (imm, replicas) => {
    const c = structuredClone(precedente.config); c.image.image = imm; c.resources.replicas = replicas; return c;
  };
  const configurazioni = {
    '01-arresto': config(precedente.config.image.image, 0),
    '02-candidato-fermo': config(image, 0), '03-candidato-avvio': config(image, 1),
    '04-rollback-arresto': config(image, 0), '05-rollback-avvio': structuredClone(precedente.config),
  };
  return { versione: 1, stato: 'preparato_non_distribuito', progetto: PROGETTO, servizio: SERVIZIO,
    precedente, candidato: { manifest: nuovo, image }, configurazioni,
    verificheRemote: ['configurazione_corrente_e_overlay', 'digest_e_manifest_immagine',
      'backup_pg_e_volume_ripristinabili', 'compatibilita_schema_e_stato', 'arresto_processi',
      'identita_volume', 'segreti_e_proxy', 'login_mfa_permessi', 'worker_e_ricerca_simulata'] };
}

function leggiStato(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) errore();
    const bytes = fs.readFileSync(fd); if (bytes.length > 65536) errore();
    return validaStato(JSON.parse(bytes.toString('utf8')));
  } catch { errore(); } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function preparaPacchetto({ stato, image, radice, genitore = os.tmpdir(), git } = {}) {
  // Prima validare l'input; poi creare esclusivamente directory nuove possedute.
  stato = validaStato(stato); immagine(image);
  const contesto = preparaContesto({ radice, genitore, git });
  let directory;
  try {
    const piano = preparaPiano({ stato, candidato: contesto.manifest, image });
    directory = fs.mkdtempSync(path.join(genitore, 'amr-staging-update-')); fs.chmodSync(directory, 0o700);
    const scrivi = (nome, raw) => fs.writeFileSync(path.join(directory, nome), raw, { mode: 0o600, flag: 'wx' });
    const impronte = {};
    for (const [nome, c] of Object.entries(piano.configurazioni)) {
      const raw = toml(c); scrivi(nome + '.toml', raw);
      impronte[nome + '.toml'] = crypto.createHash('sha256').update(raw).digest('hex');
    }
    scrivi('piano.json', JSON.stringify({ ...piano, contesto: contesto.directory, impronte }, null, 2) + '\n');
    return { directory, contesto: contesto.directory, release: piano.candidato.manifest.release,
      image, stato: piano.stato, verificheRemote: piano.verificheRemote };
  } catch {
    // Una rimozione fallita non deve impedire la pulizia dell'altra directory.
    let incompleta = false;
    for (const d of [directory, contesto.directory].filter(Boolean)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { incompleta = true; }
    }
    if (incompleta) throw new Error('pacchetto_staging_pulizia_incompleta');
    errore();
  }
}
if (require.main === module) {
  try {
    const { values, positionals } = parseArgs({ options: { stato: { type: 'string' }, immagine: { type: 'string' } } });
    if (positionals.length || !values.stato || !values.immagine) errore();
    console.log(JSON.stringify(preparaPacchetto({ stato: leggiStato(values.stato), image: values.immagine })));
  } catch (e) {
    console.error(['pacchetto_staging_pulizia_incompleta', 'contesto_centro_pulizia_incompleta'].includes(e.message)
      ? 'Pacchetto non preparato e pulizia temporanea incompleta: verifica le directory amr-staging-update e amr-centro-context. Nessun deploy eseguito.'
      : 'Pacchetto non preparato. Verifica stato non sensibile, commit HEAD e digest staging; nessun deploy eseguito.');
    process.exitCode = 1;
  }
}
module.exports = { PROGETTO, SERVIZIO, REGISTRY, ORIGINE, AUTH, PUBBLICHE, SEGRETE,
  validaStato, preparaPiano, preparaPacchetto, leggiStato, toml };
