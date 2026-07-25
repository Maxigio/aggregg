#!/usr/bin/env node
'use strict';
/**
 * Genera data/liquidita-modelli.json: per ogni marca+modello, quanti esemplari circolano in
 * Italia e quanti passano di mano in un anno.
 *
 * A cosa serve a un OPERATORE: è la risposta a "quanto ci metto a rivenderla". Di una Fiat
 * Panda ne cambiano proprietario 260.409 all'anno; di certi modelli 3. A parità di margine
 * teorico, il secondo è un veicolo che resta in piazzale.
 *
 * FONTI — ACI Autoritratto 2025, licenza CC-BY 4.0 (riuso commerciale con attribuzione):
 *  - trasferimenti per fabbrica e tipo (tavole 6 TOTALI e 7 NETTI):
 *    https://aci.gov.it/app/uploads/2026/06/Autoritratto2025_-Usato.xlsx
 *  - parco circolante per fabbrica/tipo/serie al 31/12/2025:
 *    dentro https://aci.gov.it/app/uploads/2026/06/Autoritratto2025_Parco_veicolare.zip
 *    → Circolante_FTS_Autovetture_2025.xlsx
 *
 * NETTI vs TOTALI: i NETTI escludono i passaggi intermedi verso gli operatori, quindi
 * misurano la domanda finale vera; i TOTALI contano ogni formalità. Si salvano entrambi.
 *
 * SOLO AUTOVETTURE: nell'Autoritratto le moto ci sono per cilindrata e provincia, MAI per
 * modello (verificato: tavola 24). Per le moto questo dato non esiste, e non lo si finge.
 *
 * Gli xlsx (12 MB in tutto) NON entrano nel repo: si scaricano in una cartella temporanea,
 * si legge, e si scrive solo il JSON piccolo. Uso: node scripts/build-liquidita.js [--dry]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'data', 'liquidita-modelli.json');
const URL_USATO = 'https://aci.gov.it/app/uploads/2026/06/Autoritratto2025_-Usato.xlsx';
const URL_PARCO = 'https://aci.gov.it/app/uploads/2026/06/Autoritratto2025_Parco_veicolare.zip';
const ANNO = 2025;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function scarica(url, dest, hops = 0) {
  return new Promise((res, rej) => {
    if (hops > 5) return rej(new Error('troppi redirect'));
    if (!/^https:\/\/(www\.)?aci\.gov\.it\//i.test(url)) return rej(new Error('host non consentito'));
    https.get(url, { headers: { 'user-agent': UA, accept: '*/*' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return scarica(new URL(r.headers.location, url).href, dest, hops + 1).then(res, rej); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error(`http ${r.statusCode}`)); }
      const f = fs.createWriteStream(dest);
      r.pipe(f); f.on('finish', () => f.close(() => res(dest))); f.on('error', rej);
    }).on('error', rej);
  });
}

// ── lettore xlsx minimo (uno .xlsx è uno zip di XML): nessuna dipendenza nuova ──
function sharedStrings(dir) {
  try {
    const x = fs.readFileSync(path.join(dir, 'xl/sharedStrings.xml'), 'utf8');
    return [...x.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  } catch (_) { return []; }
}
function righeFoglio(dir, file, ss) {
  const x = fs.readFileSync(path.join(dir, 'xl/worksheets', file), 'utf8');
  const out = [];
  for (const r of x.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const v = (c[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const inline = (c[3].match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      let val = null;
      if (/t="s"/.test(c[2]) && v != null) val = ss[Number(v)] ?? '';
      else if (inline != null) val = inline;
      else if (v != null) val = isNaN(Number(v)) ? v : Number(v);
      if (val !== null && val !== '') cells[c[1]] = val;
    }
    if (Object.keys(cells).length) out.push(cells);
  }
  return out;
}
function fogliPerNome(dir) {
  const wb = fs.readFileSync(path.join(dir, 'xl/workbook.xml'), 'utf8');
  const rel = fs.readFileSync(path.join(dir, 'xl/_rels/workbook.xml.rels'), 'utf8');
  const target = {};
  for (const m of rel.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) target[m[1]] = m[2].replace(/^\/?xl\//, '').replace(/^worksheets\//, '');
  const out = {};
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g)) out[m[1]] = target[m[2]];
  return out;
}
const unzip = (zip, dir) => execFileSync('unzip', ['-o', '-q', zip, '-d', dir], { stdio: 'pipe' });

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const chiave = (marca, modello) => `${norm(marca)}|${norm(modello)}`;

// Legge per POSIZIONE di colonna, non "la prima stringa": molti modelli hanno nome
// NUMERICO (500, 911, 208, 3008) e finiscono in cella come numero, non come testo.
// Con l'euristica sulle stringhe la serie veniva letta come modello e Fiat 500 e
// Porsche 911 restavano senza parco. Colonne: A=Fabbrica, B=Tipo, colVal=il numero.
function leggiCoppie(righe, colVal) {
  const out = new Map();
  for (const c of righe) {
    const marca = c.A == null ? '' : String(c.A).trim();
    const modello = c.B == null ? '' : String(c.B).trim();
    const n = Number(c[colVal]);
    if (!marca || !modello) continue;
    if (/^fabbrica$/i.test(marca) || /totale/i.test(marca) || /^tipo$/i.test(modello)) continue;
    if (!isFinite(n) || n <= 0) continue;
    const k = chiave(marca, modello);
    const pre = out.get(k);
    out.set(k, { marca, modello, n: (pre ? pre.n : 0) + n });              // le serie si sommano
  }
  return out;
}

(async () => {
  const dry = process.argv.includes('--dry');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-liq-'));
  try {
    console.log('[liq] scarico Autoritratto…');
    const fUsato = await scarica(URL_USATO, path.join(tmp, 'usato.xlsx'));
    const fParco = await scarica(URL_PARCO, path.join(tmp, 'parco.zip'));

    // trasferimenti: tavole 6 (TOTALI) e 7 (NETTI) per fabbrica e tipo
    const dU = path.join(tmp, 'u'); fs.mkdirSync(dU); unzip(fUsato, dU);
    const ssU = sharedStrings(dU); const fogliU = fogliPerNome(dU);
    const netti = leggiCoppie(righeFoglio(dU, fogliU['7'], ssU), 'C');
    const totali = leggiCoppie(righeFoglio(dU, fogliU['6'], ssU), 'C');
    console.log(`[liq] trasferimenti: NETTI ${netti.size} modelli, TOTALI ${totali.size}`);

    // parco: Circolante_FTS (fabbrica/tipo/serie) → somma delle serie
    const dP = path.join(tmp, 'p'); fs.mkdirSync(dP); unzip(fParco, dP);
    const xlsFts = fs.readdirSync(dP).find(f => /Circolante_FTS/i.test(f));
    if (!xlsFts) throw new Error('Circolante_FTS non trovato nello zip');
    const dF = path.join(tmp, 'f'); fs.mkdirSync(dF); unzip(path.join(dP, xlsFts), dF);
    const ssF = sharedStrings(dF); const fogliF = fogliPerNome(dF);
    const nomeNaz = Object.keys(fogliF).find(n => /riepilogo nazionale/i.test(n)) || Object.keys(fogliF)[1];
    const parco = leggiCoppie(righeFoglio(dF, fogliF[nomeNaz], ssF), 'D');   // A=Fabbrica B=Tipo C=Serie D=Totale
    console.log(`[liq] parco (foglio "${nomeNaz}"): ${parco.size} modelli`);

    // ── unione ──
    const modelli = {};
    for (const [k, v] of parco) {
      const t = netti.get(k), tt = totali.get(k);
      modelli[k] = {
        marca: v.marca, modello: v.modello, parco: v.n,
        trasferimenti: t ? t.n : null,
        trasferimentiTotali: tt ? tt.n : null,
        ricambio: t && v.n ? +(100 * t.n / v.n).toFixed(1) : null,   // % del parco che cambia mano in un anno
      };
    }
    for (const [k, v] of netti) if (!modelli[k]) modelli[k] = { marca: v.marca, modello: v.modello, parco: null, trasferimenti: v.n, trasferimentiTotali: (totali.get(k) || {}).n ?? null, ricambio: null };

    const conEntrambi = Object.values(modelli).filter(m => m.parco && m.trasferimenti).length;
    console.log(`[liq] modelli totali ${Object.keys(modelli).length}, con parco+trasferimenti ${conEntrambi}`);
    const panda = modelli['fiat|panda'];
    console.log('[liq] controllo Panda:', JSON.stringify(panda));

    const out = {
      generatedAt: new Date().toISOString().slice(0, 10), anno: ANNO,
      fonte: 'ACI Autoritratto 2025 (CC-BY 4.0)',
      fonti: { trasferimenti: URL_USATO, parco: URL_PARCO },
      soloAuto: 'Le moto nell\'Autoritratto esistono solo per cilindrata e provincia, non per modello: per le moto questo dato non c\'è.',
      nazionale: { parco: Object.values(modelli).reduce((a, m) => a + (m.parco || 0), 0), trasferimenti: Object.values(modelli).reduce((a, m) => a + (m.trasferimenti || 0), 0) },
      modelli,
    };
    if (!panda || !panda.parco || !panda.trasferimenti) throw new Error('controllo Panda fallito: la struttura dei file è cambiata');
    if (dry) { console.log('[liq] --dry: niente scritto'); return; }
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log(`[liq] scritto ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error('[liq] FATAL', e.message); process.exit(1); });
