'use strict';
/**
 * Il logger non deve poter riempire il disco. Due difetti veri, costati 52 GB in una
 * notte e il disco pieno:
 *   1. il tetto di 5 MB si controllava SOLO all'apertura del file, quindi un processo
 *      che restava su per ore scriveva senza limite;
 *   2. un EPIPE su stdout (processo orfano, nessuno all'altro capo) veniva registrato
 *      con console.error, che scriveva sulla stessa pipe rotta → un altro EPIPE → un
 *      ciclo infinito a 68 MB al secondo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RADICE = path.join(__dirname, '..');

test('il tetto regge DURANTE la corsa, non solo all\'avvio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amrlog-'));
  const codice = `
    // Questo test verifica la cartella di log DEL LOGGER: deve controllarla lui, quindi
    // toglie l'override che la suite mette per non sporcare il registro operativo vero.
    delete process.env.AMR_LOG_DIR;
    process.env.USER_DATA_PATH = ${JSON.stringify(dir)};
    const lg = require(${JSON.stringify(path.join(RADICE, 'backend', 'logger.js'))});
    const riga = 'x'.repeat(500);
    (async () => {
      for (let b = 0; b < 20; b++) {
        for (let i = 0; i < 1000; i++) lg.info(riga);
        await new Promise(r => setTimeout(r, 40));
      }
      await new Promise(r => setTimeout(r, 500));
    })();
  `;
  try { execFileSync(process.execPath, ['-e', codice], { stdio: 'ignore', timeout: 30000 }); } catch (_) {}
  const d = path.join(dir, 'logs');
  const file = fs.existsSync(d) ? fs.readdirSync(d).map(n => fs.statSync(path.join(d, n)).size) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(file.length, 'il log e\' stato scritto');
  const piuGrande = Math.max(...file) / 1024 / 1024;
  assert.ok(piuGrande <= 6, 'nessun file oltre il tetto: il piu\' grande e\' ' + piuGrande.toFixed(1) + ' MB su ~10 scritti');
});

test('una pipe chiusa non genera un ciclo di log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amrlog-'));
  // stdout mandato a un processo che esce subito: da li' in poi ogni write e' EPIPE
  const codice = `
    // Questo test verifica la cartella di log DEL LOGGER: deve controllarla lui, quindi
    // toglie l'override che la suite mette per non sporcare il registro operativo vero.
    delete process.env.AMR_LOG_DIR;
    process.env.USER_DATA_PATH = ${JSON.stringify(dir)};
    require(${JSON.stringify(path.join(RADICE, 'backend', 'logger.js'))}).install();
    let n = 0;
    const t = setInterval(() => { console.log('riga '.repeat(200)); if (++n > 3000) { clearInterval(t); process.exit(0); } }, 0);
  `;
  try {
    execFileSync('/bin/sh', ['-c', `${process.execPath} -e ${JSON.stringify(codice)} | head -1`],
      { stdio: 'ignore', timeout: 30000 });
  } catch (_) { /* head esce: e' il punto della prova */ }
  await new Promise(r => setTimeout(r, 800));
  const d = path.join(dir, 'logs');
  const totale = fs.existsSync(d)
    ? fs.readdirSync(d).reduce((s, n) => s + fs.statSync(path.join(d, n)).size, 0) / 1024 / 1024 : 0;
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(totale < 12, 'il log resta nei limiti: ' + totale.toFixed(1) + ' MB (col ciclo cresceva di 68 MB al secondo)');
});
