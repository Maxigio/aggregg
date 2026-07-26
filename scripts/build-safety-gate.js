'use strict';
/**
 * Archivio dei richiami veicolo → data/safety-gate.json.
 *
 * PERCHE' UNO SCRIPT. L'endpoint della Commissione non ha una ricerca per categoria: per avere i
 * soli veicoli bisogna scaricare i report SETTIMANALI e filtrare in casa. Sono 1.108 report dal
 * 2005, uno ogni venerdi'. A 1,5 secondi l'uno l'archivio intero e' mezz'ora di richieste: si fa
 * una volta, poi il mantenimento e' un report a settimana.
 *
 * Uso:
 *   node scripts/build-safety-gate.js                 ultimi 3 anni (predefinito)
 *   node scripts/build-safety-gate.js --anni 10       finestra piu' profonda
 *   node scripts/build-safety-gate.js --tutto         tutto l'archivio dal 2005 (~30 minuti)
 *   node scripts/build-safety-gate.js --aggiorna      solo i report non ancora scaricati
 *   node scripts/build-safety-gate.js --dry           non scrive niente
 *
 * `--aggiorna` e' quello da mettere in cron: legge il file esistente, scarica solo i report nuovi
 * e li unisce, senza rifare il lavoro gia' fatto.
 */
const fs = require('fs');
const path = require('path');
const sg = require('../backend/scrapers/safety-gate');

const OUT = path.join(__dirname, '..', 'data', 'safety-gate.json');
const arg = (nome, def) => {
  const i = process.argv.indexOf('--' + nome);
  return i < 0 ? def : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
};

(async () => {
  const dry = process.argv.includes('--dry');
  const tutto = process.argv.includes('--tutto');
  const aggiorna = process.argv.includes('--aggiorna');
  const anni = Number(arg('anni', 3)) || 3;

  const esistente = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { return null; } })();
  if (aggiorna && !esistente) throw new Error('--aggiorna ma data/safety-gate.json non esiste: lancia prima una costruzione piena');

  const elenco = await sg.elenco();
  console.log('[safety-gate] report pubblicati: ' + elenco.length + ' (dal ' + Math.min(...elenco.map(r => r.anno)) + ')');

  const limite = new Date().getFullYear() - anni + 1;
  const gia = new Set(aggiorna ? (esistente.reportLetti || []) : []);
  const daFare = elenco
    .filter(r => (tutto || aggiorna ? true : r.anno >= limite))
    .filter(r => !gia.has(r.id));

  if (!daFare.length) { console.log('[safety-gate] niente di nuovo da scaricare.'); return; }
  console.log('[safety-gate] da scaricare: ' + daFare.length + ' report'
    + (tutto ? ' (tutto l\'archivio)' : aggiorna ? ' (solo i nuovi)' : ' (ultimi ' + anni + ' anni)')
    + ' — circa ' + Math.ceil(daFare.length * 1.6 / 60) + ' minuti');

  const allerte = aggiorna ? esistente.allerte.slice() : [];
  const letti = aggiorna ? (esistente.reportLetti || []).slice() : [];
  let falliti = 0;
  for (let i = 0; i < daFare.length; i++) {
    const r = daFare[i];
    try {
      const v = await sg.report(r.id);
      for (const a of v) allerte.push({ ...a, reportRef: r.reference, dataReport: r.data, anno: r.anno });
      letti.push(r.id);
    } catch (e) {
      falliti++;
      console.warn('[safety-gate] ' + r.reference + ' KO: ' + e.message);
      if (e.kind === 'blocked') { console.warn('[safety-gate] fonte in pausa: mi fermo qui e salvo quello che ho.'); break; }
    }
    if ((i + 1) % 25 === 0) console.log('  … ' + (i + 1) + '/' + daFare.length + ' report, ' + allerte.length + ' allerte veicolo');
  }

  // Deduplica sul numero di caso: lo stesso richiamo puo' comparire in un report e nel suo addendum.
  const perCaso = new Map();
  for (const a of allerte) if (a.caso && !perCaso.has(a.caso)) perCaso.set(a.caso, a);
  const finali = [...perCaso.values()].sort((a, b) => String(b.caso).localeCompare(String(a.caso)));

  const marche = {};
  for (const a of finali) if (a.marca) marche[a.marca] = (marche[a.marca] || 0) + 1;
  const conOmologazione = finali.filter(a => a.haOmologazione).length;
  console.log('[safety-gate] allerte veicolo: ' + finali.length
    + ' · marche distinte: ' + Object.keys(marche).length
    + ' · con omologazione vera: ' + conOmologazione + ' (' + Math.round(100 * conOmologazione / (finali.length || 1)) + '%)');
  console.log('[safety-gate] report falliti: ' + falliti);

  // Stessa filosofia delle altre guardie: meglio non riscrivere che riscrivere un archivio monco.
  if (!finali.length) throw new Error('zero allerte veicolo: il filtro di categoria o il parsing sono rotti, file NON riscritto');
  if (esistente && finali.length < esistente.allerte.length * 0.9) {
    throw new Error(`le allerte sono scese da ${esistente.allerte.length} a ${finali.length}: qualcosa si e' rotto, file NON riscritto`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    fonte: {
      nome: 'Safety Gate — sistema di allerta rapida della Commissione Europea per i prodotti pericolosi',
      portale: 'https://ec.europa.eu/safety-gate-alerts/screen/search',
      licenza: 'dato pubblico della Commissione Europea',
    },
    avvertenza: 'L\'allerta individua i veicoli colpiti tramite il numero di omologazione europea o un intervallo di telaio: nessuno dei due e\' presente in un annuncio. Questo archivio dice se su un MODELLO risulta un richiamo, non se il singolo esemplare e\' coinvolto.',
    reportLetti: letti,
    marche: Object.entries(marche).sort((a, b) => b[1] - a[1]).map(([nome, n]) => ({ nome, allerte: n })),
    allerte: finali,
  };
  if (dry) { console.log('[safety-gate] --dry: niente scritto'); return; }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log('[safety-gate] scritto ' + OUT + ' (' + (fs.statSync(OUT).size / 1024 / 1024).toFixed(1) + ' MB)');
})().catch(e => { console.error('[safety-gate] FATAL', e.message); process.exit(1); });
