// Prova della rete: si rompe il codice APPOSTA, in modi realistici, e si verifica che i test
// diventino rossi. Ogni mutazione viene annullata subito dopo, ripristinando il file da copia.
const fs = require('fs'), cp = require('child_process');
const REPO = require('path').join(__dirname, '..', '..');

const MUT = [
  { nome: 'norm: smetto di appianare gli accenti',
    file: 'backend/scrapers/brand-match.js',
    da: ".normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')", a: "" },
  { nome: 'alias: torno a provare la sola canonica',
    file: 'backend/scrapers/brand-match.js',
    da: "for (const name of (Array.isArray(a) ? a : [a])) {", a: "for (const name of (Array.isArray(a) ? [a[0]] : [a])) {" },
  { nome: 'prefisso modello: soglia da 3 a 4 caratteri',
    file: 'backend/scrapers/brand-match.js',
    da: "if (q.length >= 3) {", a: "if (q.length >= 4) {" },
  { nome: 'prefisso modello: tolgo il ramo inverso',
    file: 'backend/scrapers/brand-match.js',
    da: "(c.n.startsWith(q) || q.startsWith(c.n))", a: "(c.n.startsWith(q))" },
  { nome: 'versionBase: suffisso solo lettere, non alfanumerico',
    file: 'backend/scrapers/motoit-models.js',
    da: String.raw`/\s*-\s*[A-Za-z0-9]+\s*$/`, a: String.raw`/\s*-\s*[A-Za-z]+\s*$/` },
  { nome: 'versionBase: non tolgo piu\' le parentesi',
    file: 'backend/scrapers/motoit-models.js',
    da: String.raw`.replace(/\([^)]*\)/g, ' ')`, a: `` },
  { nome: 'parseYears: anno finale a 1-4 cifre',
    file: 'backend/scrapers/motoit-models.js',
    da: String.raw`(\d{4})\s*-\s*(\d{2,4})`, a: String.raw`(\d{4})\s*-\s*(\d{1,4})` },
  { nome: 'parseYears: tolgo la ricostruzione del secolo',
    file: 'backend/scrapers/motoit-models.js',
    da: 'if (b < 100) { b = Math.floor(a / 100) * 100 + b; if (b < a) b += 100; }', a: '' },
  { nome: 'pari merito: tolgo il criterio stabile',
    file: 'backend/scrapers/brand-match.js',
    da: "\n          || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)", a: "" },
  { nome: 'lookupModelGroup: confronto senza normalizzare',
    file: 'backend/server.js',
    da: 'function lookupModelGroup(', a: 'function lookupModelGroup_ROTTA(' },
];

const esito = [];
for (const m of MUT) {
  const p = REPO + '/' + m.file;
  const orig = fs.readFileSync(p, 'utf8');
  if (!orig.includes(m.da)) { esito.push([m.nome, 'SALTATA (testo non trovato)']); continue; }
  fs.writeFileSync(p, orig.replace(m.da, m.a));
  // Il segnale e' il CODICE DI USCITA, non i contatori: se un file di test non si carica,
  // node --test stampa lo stack ma dichiara "pass 1, fail 0". I numeri mentono, l'uscita no.
  let out = '', uscita = 0;
  try {
    out = cp.execSync('node --test test/risoluzione-nomi.test.js test/suite-integrita.test.js 2>&1', { cwd: REPO, encoding: 'utf8' });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); uscita = e.status || 1; }
  fs.writeFileSync(p, orig);                       // ripristino immediato
  const fail = Number((out.match(/ℹ fail (\d+)/) || [0, 0])[1]);
  const rotto = uscita !== 0 || fail > 0;
  const perche = fail > 0 ? `${fail} test caduti` : (uscita !== 0 ? 'file non caricabile (uscita ' + uscita + ')' : '');
  esito.push([m.nome, rotto ? `ROSSA (${perche})` : '*** VERDE — LA RETE NON HA VISTO NIENTE ***']);
}

// controllo finale: dopo tutti i ripristini la suite deve essere verde
let fin = '';
let fUsc = 0;
try { fin = cp.execSync('node --test test/risoluzione-nomi.test.js test/suite-integrita.test.js 2>&1', { cwd: REPO, encoding: 'utf8' }); } catch (e) { fin = (e.stdout || ''); fUsc = e.status || 1; }
const fFail = fUsc !== 0 ? 99 : Number((fin.match(/ℹ fail (\d+)/) || [0, 9])[1]);

console.log('\n╔═══ PROVA DELLA RETE ═══');
esito.forEach(([n, e]) => console.log('║ ' + (e.startsWith('ROSSA') ? '✓' : '✗') + ' ' + n.padEnd(46) + e));
console.log('╚═══ dopo i ripristini: ' + (fFail === 0 ? 'suite VERDE, nessun residuo' : '*** ' + fFail + ' FALLIMENTI RESIDUI ***'));
