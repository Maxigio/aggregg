'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), { execFileSync, execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { PROGETTO, SERVIZIO, REGISTRY, ORIGINE, AUTH, PUBBLICHE, SEGRETE,
  validaStato, preparaPiano, preparaPacchetto, leggiStato, toml } = require('../scripts/nhost/prepara-aggiornamento-staging');
const { CATALOGHI, verificaArtefatto } = require('../backend/nodi/compatibilita-nodo');
const digest = n => REGISTRY + '@sha256:' + n.repeat(64);
const wire = n => ({ protocollo: 1, release: n.repeat(40), codice: n.repeat(64), cataloghi: n.repeat(64) });
function stato() {
  return { progetto: PROGETTO, servizio: SERVIZIO, manifest: wire('a'), config: {
    name: 'amr-centro-staging', command: [], image: { image: digest('a') },
    environment: Object.entries({ ...PUBBLICHE, ...Object.fromEntries(SEGRETE.map(n => [n, '{{ secrets.' + n + ' }}'])),
      AMR_CENTRO_ORIGINE: ORIGINE, AMR_NHOST_AUTH_URL: AUTH, AMR_CENTRO_PROXY_IP: '10.110.6.3,10.110.4.24',
    }).map(([name, value]) => ({ name, value })), ports: [{ port: 3000, type: 'http', publish: true }],
    resources: { replicas: 1, compute: { cpu: 500, memory: 1024 },
      storage: [{ name: 'amr-centro-dati', path: '/var/lib/amr', capacity: 1 }] },
    healthCheck: { port: 3000, initialDelaySeconds: 30, probePeriodSeconds: 60 },
  } };
}
function temporanea(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-update-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
test('staging: cinque fasi conservano configurazione, volume e riferimenti; rollback identico al precedente', () => {
  const s = stato(), prima = structuredClone(s);
  const p = preparaPiano({ stato: s, candidato: wire('b'), image: digest('b') });
  assert.deepEqual(s, prima);
  assert.equal(p.stato, 'preparato_non_distribuito');
  const attese = [['01-arresto', 'a', 0], ['02-candidato-fermo', 'b', 0], ['03-candidato-avvio', 'b', 1],
    ['04-rollback-arresto', 'b', 0], ['05-rollback-avvio', 'a', 1]];
  for (const [n, d, r] of attese) {
    const c = p.configurazioni[n];
    assert.equal(c.image.image, digest(d)); assert.equal(c.resources.replicas, r);
    const restore = structuredClone(c); restore.image.image = digest('a'); restore.resources.replicas = 1;
    assert.deepEqual(restore, s.config);
  }
  assert.deepEqual(p.configurazioni['05-rollback-avvio'], s.config);
  assert.ok(p.verificheRemote.includes('arresto_processi'));
  assert.ok(p.verificheRemote.includes('compatibilita_schema_e_stato'));
});
test('staging: rifiuta perdita di configurazione, segreti letterali, destinazione diversa e tag mobili', async t => {
  const modificaEnv = (s, nome, value) => { s.config.environment.find(e => e.name === nome).value = value; };
  const casi = [
    ['progetto', s => { s.progetto = '1'.repeat(36); }], ['servizio', s => { s.servizio = '1'.repeat(36); }],
    ['campo nuovo', s => { s.config.restartPolicy = 'always'; }],
    ['override comando', s => { s.config.command = ['node', '-e', 'pericoloso']; }],
    ['volume diverso', s => { s.config.resources.storage[0].name = 'produzione'; }],
    ['volume duplicato', s => { s.config.resources.storage.push(s.config.resources.storage[0]); }],
    ['due repliche', s => { s.config.resources.replicas = 2; }],
    ['porta extra', s => { s.config.ports.push({ port: 5432, type: 'tcp', publish: true }); }],
    ['env duplicata', s => { s.config.environment[0] = s.config.environment[1]; }],
    ['env nuova', s => { s.config.environment[0] = { name: 'TOKEN', value: 'NON-MOSTRARE' }; }],
    ['password letterale', s => modificaEnv(s, 'AMR_PG_LETTURA_PASSWORD', 'NON-MOSTRARE')],
    ['riferimento sbagliato', s => modificaEnv(s, 'AMR_PG_LETTURA_PASSWORD', '{{ secrets.AMR_PG_BACKUP_PASSWORD }}')],
    ['origine estranea', s => modificaEnv(s, 'AMR_CENTRO_ORIGINE', 'https://produzione.invalid')],
    ['proxy CIDR', s => modificaEnv(s, 'AMR_CENTRO_PROXY_IP', '10.0.0.0/8')],
    ['immagine senza digest', s => { s.config.image.image = REGISTRY + ':latest'; }],
  ];
  for (const [n, cambia] of casi) await t.test(n, () => {
    const s = stato(); cambia(s);
    assert.throws(() => validaStato(s), e => e.message === 'pacchetto_staging_non_valido');
  });
  for (const image of [digest('b') + '\n', 'altro.invalid/image@sha256:' + 'b'.repeat(64), REGISTRY + ':b', digest('a')]) {
    assert.throws(() => preparaPiano({ stato: stato(), candidato: wire('b'), image }));
  }
  assert.throws(() => preparaPiano({ stato: stato(), candidato: wire('a'), image: digest('b') }));
});
test('staging: anche origine, auth e proxy possono rimanere riferimenti non risolti', () => {
  const s = stato();
  for (const n of ['AMR_CENTRO_ORIGINE', 'AMR_NHOST_AUTH_URL', 'AMR_CENTRO_PROXY_IP']) {
    s.config.environment.find(e => e.name === n).value = '{{ secrets.' + n + ' }}';
  }
  assert.deepEqual(validaStato(s), s);
  assert.ok(toml(s.config).includes('{{ secrets.AMR_NODI_TOKENS }}'));
});
test('staging: aggiunge un IP alla lista referenziata senza risolverla, preservandola al rollback', () => {
  const s = stato(), voce = s.config.environment.find(e => e.name === 'AMR_CENTRO_PROXY_IP');
  voce.value = '{{ secrets.AMR_CENTRO_PROXY_IP }},10.110.18.147';
  assert.deepEqual(validaStato(s), s);
  const p = preparaPiano({ stato: s, candidato: wire('b'), image: digest('b') });
  for (const c of Object.values(p.configurazioni)) {
    assert.equal(c.environment.find(e => e.name === voce.name).value, voce.value);
  }
  assert.ok(toml(s.config).includes(voce.value));
  for (const value of ['{{ secrets.AMR_CENTRO_PROXY_IP }},',
    '{{ secrets.AMR_CENTRO_PROXY_IP }},10.0.0.0/8',
    '{{ secrets.AMR_CENTRO_PROXY_IP }},{{ secrets.ALTRO }}',
    '{{ secrets.ALTRO }},10.110.18.147',
    '{{ secrets.AMR_CENTRO_PROXY_IP }},10.110.18.147,,127.0.0.1']) {
    voce.value = value;
    assert.throws(() => validaStato(s), /pacchetto_staging_non_valido/);
  }
  const senzaProxy = stato();
  senzaProxy.config.environment = senzaProxy.config.environment.filter(e => e.name !== voce.name);
  senzaProxy.config.environment.push({ name: 'AMR_CENTRO_PROPRIETARIO_ID',
    value: '{{ secrets.AMR_CENTRO_PROPRIETARIO_ID }}' });
  assert.throws(() => validaStato(senzaProxy), /pacchetto_staging_non_valido/);
});
test('staging: ID proprietario opzionale solo come riferimento, preservato al rollback', () => {
  const s = stato(), name = 'AMR_CENTRO_PROPRIETARIO_ID';
  s.config.environment.push({ name, value: '{{ secrets.' + name + ' }}' });
  assert.deepEqual(validaStato(s), s);
  const p = preparaPiano({ stato: s, candidato: wire('b'), image: digest('b') });
  assert.deepEqual(p.configurazioni['05-rollback-avvio'], s.config);
  assert.ok(toml(p.configurazioni['03-candidato-avvio']).includes('{{ secrets.' + name + ' }}'));
  for (const value of ['00000000-0000-4000-8000-000000000001', '{{ secrets.ALTRO }}', '']) {
    s.config.environment.at(-1).value = value;
    assert.throws(() => validaStato(s), /pacchetto_staging_non_valido/);
  }
});
test('staging: legge una sola FD, rifiuta symlink, JSON grande o segreti senza riportarli', t => {
  const dir = temporanea(t), file = path.join(dir, 'stato.json');
  fs.writeFileSync(file, JSON.stringify(stato())); assert.deepEqual(leggiStato(file), stato());
  fs.symlinkSync(file, path.join(dir, 'link.json')); assert.throws(() => leggiStato(path.join(dir, 'link.json')));
  fs.writeFileSync(file, 'x'.repeat(65537)); assert.throws(() => leggiStato(file));
  const s = stato(); s.config.environment[0].value = 'NON-MOSTRARE'; fs.writeFileSync(file, JSON.stringify(s));
  assert.throws(() => leggiStato(file), e => !e.message.includes('NON-MOSTRARE'));
});
// Git sintetico restituisce blob del candidato; il checkout contiene sentinelle
// private e modifiche non committate che non devono entrare nel pacchetto.
function gitFixture(dir) {
  const files = new Map(CATALOGHI.map(n => ['data/' + n, Buffer.from('{}')]));
  for (const n of ['package.json', 'package-lock.json']) files.set(n, Buffer.from('{}'));
  for (const n of ['backend/prova.js', 'frontend/prova.js', 'pagine/prova.html']) files.set(n, Buffer.from('pubblico'));
  for (const n of ['backend/nodi/worker.js', 'backend/nodi/compatibilita-nodo.js']) files.set(n, Buffer.from('pubblico'));
  files.set('scripts/docker/centro.Dockerfile', Buffer.from('FROM scratch\n'));
  fs.mkdirSync(path.join(dir, 'data')); fs.writeFileSync(path.join(dir, '.env'), 'NON-MOSTRARE');
  fs.writeFileSync(path.join(dir, 'data/auth.json'), 'NON-MOSTRARE');
  return (_bin, args) => {
    if (args[0] === 'rev-parse') return 'b'.repeat(40);
    if (args[0] === 'ls-tree') {
      const ambito = args.slice(args.indexOf('--') + 1);
      return [...files.keys()].filter(n => ambito.some(a => n === a || n.startsWith(a + '/')))
        .sort().map(n => '100644 blob ' + 'c'.repeat(40) + '\t' + n + '\0').join('');
    }
    assert.equal(args[0], 'show'); assert.ok(args[1].startsWith('b'.repeat(40) + ':'));
    return files.get(args[1].slice(41));
  };
}
test('staging: pacchetto e contesto da commit; nessun overlay, segreto o mutazione del checkout', t => {
  const parent = temporanea(t), radice = path.join(parent, 'repo'); fs.mkdirSync(radice);
  const git = gitFixture(radice);
  const p = preparaPacchetto({ stato: stato(), image: digest('b'), radice, genitore: parent, git });
  const piano = JSON.parse(fs.readFileSync(path.join(p.directory, 'piano.json')));
  const artefatto = JSON.parse(fs.readFileSync(path.join(p.contesto, 'release.json')));
  assert.deepEqual(verificaArtefatto(artefatto, p.contesto), piano.candidato.manifest);
  assert.equal(artefatto.release, 'b'.repeat(40));
  assert.equal(fs.readFileSync(path.join(radice, '.env'), 'utf8'), 'NON-MOSTRARE');
  assert.equal(fs.existsSync(path.join(p.contesto, '.env')), false);
  assert.equal(fs.existsSync(path.join(p.contesto, 'data/auth.json')), false);
  assert.equal(fs.existsSync(path.join(p.directory, 'nhost')), false);
  assert.equal(fs.statSync(p.directory).mode & 0o777, 0o700);
  for (const [nome, expected] of Object.entries(piano.impronte)) {
    const raw = fs.readFileSync(path.join(p.directory, nome));
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), expected);
    assert.equal(fs.statSync(path.join(p.directory, nome)).mode & 0o777, 0o600);
  }
});
test('staging: fallimento dopo il contesto elimina solo le directory generate', t => {
  const parent = temporanea(t), radice = path.join(parent, 'repo'); fs.mkdirSync(radice);
  const git = gitFixture(radice), s = stato(); s.manifest.release = 'b'.repeat(40);
  fs.writeFileSync(path.join(parent, 'preservare'), 'precedente');
  assert.throws(() => preparaPacchetto({ stato: s, image: digest('b'), radice, genitore: parent, git }));
  assert.deepEqual(fs.readdirSync(parent).sort(), ['preservare', 'repo']);
  assert.equal(fs.readFileSync(path.join(parent, 'preservare'), 'utf8'), 'precedente');
});
test('staging: rimozione del pacchetto fallita non impedisce di rimuovere il contesto', t => {
  const parent = temporanea(t), radice = path.join(parent, 'repo'); fs.mkdirSync(radice);
  const git = gitFixture(radice), write = fs.writeFileSync, rm = fs.rmSync, tentativi = [];
  try {
    fs.writeFileSync = (file, ...args) => {
      if (String(file).endsWith('/piano.json')) throw new Error('scrittura_non_riuscita');
      return write(file, ...args);
    };
    fs.rmSync = (file, ...args) => {
      tentativi.push(path.basename(file));
      if (path.basename(file).startsWith('amr-staging-update-')) throw new Error('rimozione_non_riuscita');
      return rm(file, ...args);
    };
    assert.throws(() => preparaPacchetto({ stato: stato(), image: digest('b'), radice, genitore: parent, git }),
      /pacchetto_staging_pulizia_incompleta/);
  } finally { fs.writeFileSync = write; fs.rmSync = rm; }
  assert.equal(tentativi.length, 2);
  assert.ok(tentativi[0].startsWith('amr-staging-update-')); assert.ok(tentativi[1].startsWith('amr-centro-context-'));
  assert.deepEqual(fs.readdirSync(parent).filter(n => n.startsWith('amr-centro-context-')), []);
  assert.equal(fs.readdirSync(parent).filter(n => n.startsWith('amr-staging-update-')).length, 1);
});
test('contesto: chmod fallito pulisce la directory vuota, cleanup fallito resta esplicito', async t => {
  for (const guastoCleanup of [false, true]) await t.test(guastoCleanup ? 'cleanup fallisce' : 'cleanup riesce', st => {
    const parent = temporanea(st), radice = path.join(parent, 'repo'); fs.mkdirSync(radice);
    const git = gitFixture(radice), chmod = fs.chmodSync, rm = fs.rmSync, tentativi = [];
    try {
      fs.chmodSync = (file, mode) => {
        if (path.basename(file).startsWith('amr-centro-context-')) throw new Error('chmod_non_riuscito');
        return chmod(file, mode);
      };
      fs.rmSync = (file, ...args) => {
        tentativi.push(path.basename(file));
        if (guastoCleanup && path.basename(file).startsWith('amr-centro-context-')) throw new Error('cleanup_non_riuscito');
        return rm(file, ...args);
      };
      assert.throws(() => preparaPacchetto({ stato: stato(), image: digest('b'), radice, genitore: parent, git }),
        new RegExp(guastoCleanup ? 'contesto_centro_pulizia_incompleta' : 'contesto_centro_non_preparato'));
    } finally { fs.chmodSync = chmod; fs.rmSync = rm; }
    assert.equal(tentativi.length, 1);
    assert.equal(fs.readdirSync(parent).filter(n => n.startsWith('amr-centro-context-')).length, guastoCleanup ? 1 : 0);
  });
});
test('staging: CLI non esegue deploy e rifiuta opzioni di esecuzione senza errori raw', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '../scripts/nhost/prepara-aggiornamento-staging.js'),
    '--execute', 'NON-MOSTRARE'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1); assert.equal(r.stdout, '');
  assert.match(r.stderr, /nessun deploy eseguito/); assert.doesNotMatch(r.stderr, /NON-MOSTRARE|Error:|stack/);
});
test('staging: comando completo sul vero HEAD, senza login o ambiente applicativo', {
  skip: process.env.AMR_TEST_STAGING_HEAD !== '1',
}, async t => {
  const dir = temporanea(t), file = path.join(dir, 'stato.json');
  fs.writeFileSync(file, JSON.stringify(stato()), { mode: 0o600 });
  const release = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const r = await promisify(execFile)(process.execPath, [path.join(__dirname, '../scripts/nhost/prepara-aggiornamento-staging.js'),
    '--stato', file, '--immagine', digest('b')], {
    encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL', env: { HOME: dir, TMPDIR: dir, PATH: process.env.PATH },
  });
  assert.equal(r.stderr, ''); const p = JSON.parse(r.stdout);
  assert.equal(p.release, release); assert.equal(p.stato, 'preparato_non_distribuito');
  for (const n of [p.directory, p.contesto]) assert.ok(path.relative(fs.realpathSync(dir), fs.realpathSync(n)).startsWith('amr-'));
  const artifact = JSON.parse(fs.readFileSync(path.join(p.contesto, 'release.json')));
  assert.equal(verificaArtefatto(artifact, p.contesto).release, release);
  assert.equal(fs.existsSync(path.join(p.contesto, '.env')), false);
  assert.equal(fs.existsSync(path.join(p.contesto, 'data/auth.json')), false);
});

// Gate opzionale reale della sintassi: CLI ufficiale, HOME nuovo e valori
// sintetici, nessun service-id, config-pull, credenziale o rete necessaria.
test('staging: TOML di tutte le fasi accettato dalla CLI ufficiale isolata', {
  skip: !process.env.AMR_TEST_NHOST_CLI,
}, t => {
  const dir = temporanea(t), p = preparaPiano({ stato: stato(), candidato: wire('b'), image: digest('b') });
  const secrets = SEGRETE.map(n => n + '=' + JSON.stringify(n === 'AMR_NODI_TOKENS'
    ? JSON.stringify({ sintetico: 'a'.repeat(64) }) : 'sintetico-non-segreto')).join('\n') + '\n';
  fs.mkdirSync(path.join(dir, '.nhost')); fs.mkdirSync(path.join(dir, 'nhost'));
  fs.writeFileSync(path.join(dir, '.secrets'), secrets, { mode: 0o600 });
  for (const [nome, c] of Object.entries(p.configurazioni)) {
    const file = path.join(dir, nome + '.toml'); fs.writeFileSync(file, toml(c));
    execFileSync(process.env.AMR_TEST_NHOST_CLI, ['--root-folder', dir, '--dot-nhost-folder', path.join(dir, '.nhost'),
      '--nhost-folder', path.join(dir, 'nhost'), 'run', 'config-validate', '--config', file], {
      cwd: dir, env: { HOME: dir, PATH: process.env.PATH }, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
});
