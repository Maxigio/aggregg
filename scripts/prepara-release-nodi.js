'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { PROTOCOLLO, AMBITO_CODICE, CATALOGHI, CARTELLE_CATALOGHI,
  hashCodice, hashCataloghi, validaArtefatto } = require('../backend/nodi/compatibilita-nodo');

// Produce metadati, non distribuisce file e non avvia servizi o portali.
function prepara({ radice = path.join(__dirname, '..'), git = execFileSync } = {}) {
  const esegui = args => git('git', args, { cwd: radice, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  const release = esegui(['rev-parse','--verify','HEAD^{commit}']);
  if (!/^[a-f0-9]{40}$/.test(release)) throw new Error('release_nodi_non_valida');
  // Tutte le letture usano lo stesso commit immutabile, mai il checkout vivo.
  const elenco = ambito => esegui(['ls-tree','-r','-z',release,'--',...ambito]).split('\0').filter(Boolean).map(riga => {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(riga);
    if (!match) throw new Error('percorso_release_non_valido');
    return match[2];
  }).sort();
  const files = elenco(AMBITO_CODICE);
  const cataloghi = elenco([...CATALOGHI, ...CARTELLE_CATALOGHI].map(n => 'data/' + n))
    .map(n => n.slice(5)).filter(n => n.endsWith('.json'));
  // Validare tutto l'inventario prima di leggere il primo blob.
  const inventario = validaArtefatto({ protocollo: PROTOCOLLO, release,
    codice: '0'.repeat(64), cataloghi: '0'.repeat(64), inventario: { codice: files, cataloghi } }).inventario;
  const blob = nome => git('git', ['show', release + ':' + nome], {
    cwd: radice, encoding: null, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore','pipe','pipe'] });
  return validaArtefatto({ protocollo: PROTOCOLLO, release, inventario,
    codice: hashCodice(null, files, blob),
    cataloghi: hashCataloghi('/data', file => blob('data/' + path.relative('/data', file)), cataloghi) });
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(prepara()) + '\n'); }
  catch { console.error('Release nodi non preparata: controlla il commit e i cataloghi pubblici.'); process.exitCode = 1; }
}
module.exports = { prepara };
