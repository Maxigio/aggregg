'use strict';
/**
 * COSTI DI POSSESSO PER PROVINCIA — genera data/costi-provincia.json.
 *
 * PERCHE'. L'app sapeva gia' cosa costa COMPRARE un veicolo in una provincia (IPT, D.M. 435/1998)
 * e cosa costa MUOVERLO (carburante, open data MIMIT). Non sapeva cosa costa TENERLO. In Italia
 * l'assicurazione varia fra province piu' del carburante: misurato su questi dati, il premio medio
 * di un'autovettura va da 332 euro ad Aosta a oltre il doppio nelle province piu' care.
 *
 * DUE FONTI UFFICIALI, entrambe aperte e senza registrazione:
 *  1. IVASS — indagine IPER: prezzi dei contratti r.c. auto EFFETTIVAMENTE STIPULATI, non preventivi.
 *     Copre AUTOVETTURE, MOTOCICLI e CICLOMOTORI: serve tutte e due le aree dell'app.
 *  2. MEF / Dipartimento delle Finanze — aliquota dell'IMPOSTA sulle assicurazioni r.c. auto, che
 *     ogni Provincia delibera per conto suo (dal 9% al 16%): e' la parte fiscale del premio.
 *
 * COME SI TROVA IL FILE IVASS, e perche' non si indovina l'URL. Fino a maggio 2025 la rilevazione
 * era MENSILE con un URL prevedibile; dal 2026 e' TRIMESTRALE e il file sta sotto un percorso
 * diverso (comunicazioni-statistiche/<anno>/cs-n-<n>-<anno>/...). Indovinare la data avrebbe
 * ripescato in silenzio un file vecchio di un anno. Quindi si legge l'indice e si seguono i link,
 * che e' l'unica cosa che regge quando la fonte si riorganizza.
 *
 * QUANTO PRENDIAMO. Il fascicolo ha 17 tavole. Si prendono le due che scendono alla provincia:
 *  - A12: media e percentili 5/10/25/50/75/90 per provincia e per tipo di veicolo;
 *  - A16: media per provincia e CLASSE BONUS-MALUS, che e' il numero che un cliente riconosce
 *    ("io sono in prima classe": a Milano un'autovettura in classe 1 paga 366 euro contro i 416
 *    di media e gli 827 di chi sta fra l'11a e la 18a).
 * Le altre 15 tavole (eta', genere, dimensione urbana, variazioni, regione) non scendono alla
 * provincia o non si agganciano a un annuncio: si lasciano alla fonte.
 *
 * NOTA D'USO, da dire e non nascondere: sono statistiche su TUTTE le polizze di quella provincia.
 * Non sono un preventivo per il veicolo in vendita, perche' non tengono conto della potenza ne'
 * del conducente. Servono a dire "qui assicurare costa cosi'", non "questa macchina ti costera' X".
 *
 * Uso:  node scripts/build-costi-provincia.js [--dry]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const RADICE = path.join(__dirname, '..');
const OUT = path.join(RADICE, 'data', 'costi-provincia.json');
const PROVINCE = require(path.join(RADICE, 'data', 'province.json'));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const IVASS = 'https://www.ivass.it';
const INDICE_IPER = IVASS + '/pubblicazioni-e-statistiche/statistiche/rilevazioni-mensili-iper/';
const MEF_CSV = 'https://www.finanze.gov.it/system/modules/it.gov.sogei.tributi.formatters/formatters/exportxls-v2.jsp?t=Tributi';
const PAUSA_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function scarica(url, redirect = 0) {
  return new Promise((risolvi, rifiuta) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9', 'Accept-Encoding': 'gzip' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirect < 5) {
        res.resume();
        return risolvi(scarica(new URL(res.headers.location, url).toString(), redirect + 1));
      }
      const pezzi = [];
      let s = res;
      if ((res.headers['content-encoding'] || '') === 'gzip') s = res.pipe(zlib.createGunzip());
      s.on('data', c => pezzi.push(c));
      s.on('end', () => risolvi({ status: res.statusCode, corpo: Buffer.concat(pezzi) }));
      s.on('error', rifiuta);
    });
    req.on('error', rifiuta);
    req.setTimeout(30000, () => req.destroy(new Error('timeout su ' + url)));
  });
}

/** Segue l'indice IPER fino al foglio di calcolo piu' recente. Torna {url, pagina}. */
async function trovaTavoleIvass() {
  const idx = await scarica(INDICE_IPER);
  if (idx.status !== 200) throw new Error('indice IPER: HTTP ' + idx.status);
  const html = idx.corpo.toString('utf8');
  // Le cartelle-periodo stanno sotto .../<anno>/<periodo>/index.html. Si prende la piu' recente
  // per anno, poi per posizione nella pagina: l'indice elenca il piu' nuovo per primo.
  const periodi = [...html.matchAll(/href="(\/pubblicazioni-e-statistiche\/statistiche\/rilevazioni-mensili-iper\/(\d{4})\/[^"]+\/index\.html)"/g)]
    .map(m => ({ href: m[1], anno: Number(m[2]) }));
  if (!periodi.length) throw new Error('indice IPER: nessuna cartella-periodo trovata (la pagina e\' cambiata)');
  periodi.sort((a, b) => b.anno - a.anno);

  for (const p of periodi.slice(0, 6)) {
    await sleep(PAUSA_MS);
    const r = await scarica(IVASS + p.href);
    if (r.status !== 200) continue;
    const pag = r.corpo.toString('utf8');
    const xlsx = [...pag.matchAll(/href="([^"]+\.xlsx[^"]*)"/gi)].map(m => m[1]);
    if (!xlsx.length) continue;
    const url = new URL(xlsx[0], IVASS + p.href).toString();
    const titolo = (pag.match(/<title>([^<]*)/) || [, ''])[1].trim();
    return { url, pagina: IVASS + p.href, titolo };
  }
  throw new Error('nessun .xlsx trovato nelle ultime cartelle-periodo IPER');
}

// ─── XLSX senza dipendenze: e' uno zip di XML ────────────────────────────────
function apriXlsx(buf) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iper-'));
  fs.writeFileSync(path.join(tmp, 'f.xlsx'), buf);
  execFileSync('unzip', ['-qo', 'f.xlsx'], { cwd: tmp });
  const sp = path.join(tmp, 'xl', 'sharedStrings.xml');
  const condivise = fs.existsSync(sp)
    ? [...fs.readFileSync(sp, 'utf8').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1])
    : [];
  // Il nome del foglio ("tavola_12") va legato al file (sheetN.xml) passando per i rels: l'ordine
  // dei file NON e' l'ordine delle tavole, e sbagliarlo significa leggere la tabella sbagliata.
  const wb = fs.readFileSync(path.join(tmp, 'xl', 'workbook.xml'), 'utf8');
  const rels = fs.readFileSync(path.join(tmp, 'xl', '_rels', 'workbook.xml.rels'), 'utf8');
  const perId = {};
  for (const m of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) perId[m[1]] = m[2].replace(/^\/?xl\//, '');
  const fogli = {};
  for (const m of wb.matchAll(/<sheet name="([^"]+)"[^>]*r:id="([^"]+)"/g)) fogli[m[1]] = perId[m[2]];
  return { tmp, condivise, fogli };
}

/**
 * Righe di una tavola, cercata per NUMERO e non per nome esatto: nello stesso fascicolo IVASS i
 * fogli si chiamano "tavola_01".."tavola_15" e poi "tavola16", "tavola17" — senza underscore.
 * Dipendere dalla grafia significava leggere zero righe e non accorgersene.
 */
function righeDi(x, numeroTavola) {
  const cerca = 'TAVOLA' + String(numeroTavola);
  const chiave = Object.keys(x.fogli).find(n => n.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/TAVOLA0*/, 'TAVOLA') === cerca);
  const f = chiave && x.fogli[chiave];
  if (!f) return [];
  const testo = fs.readFileSync(path.join(x.tmp, 'xl', f), 'utf8');
  return [...testo.matchAll(/<row r="\d+"[^>]*>([\s\S]*?)<\/row>/g)].map(r =>
    [...r[1].matchAll(/<c r="[A-Z]+\d+"([^>]*)>(?:<v>([^<]*)<\/v>)?/g)]
      .map(c => (/t="s"/.test(c[1]) ? x.condivise[+c[2]] : c[2])));
}

// ─── Nomi di provincia → sigla ───────────────────────────────────────────────
// IVASS e MEF usano grafie diverse dalle nostre. Misurato il 2026-07-26: combaciano da sole tutte
// tranne tre, che sono varianti storiche del nome e non errori.
const ALIAS = {
  MONZAEDELLABRIANZA: 'MB', MONZAEBRIANZA: 'MB', MONZABRIANZA: 'MB',
  REGGIODICALABRIA: 'RC', REGGIOCALABRIA: 'RC',
  REGGIONELLEMILIA: 'RE', REGGIOEMILIA: 'RE',
  FORLICESENA: 'FC', PESAROEURBINO: 'PU', PESAROURBINO: 'PU', MASSACARRARA: 'MS',
  VERBANOCUSIOOSSOLA: 'VB', BARLETTAANDRIATRANI: 'BT', SUDSARDEGNA: 'SU',
  VALLEDAOSTA: 'AO', BOLZANOBOZEN: 'BZ',
};

/**
 * Province che le fonti NON coprono per ragioni strutturali, non per un difetto nostro. Verificato
 * il 2026-07-26 elencando i nomi presenti nei due file e sottraendoli alle nostre 107 sigle:
 *  - il CSV MEF elenca le DELIBERE delle Province sull'aliquota r.c. auto. Bolzano e Trento sono
 *    province autonome e Gorizia/Pordenone/Trieste/Udine stanno in una regione a statuto speciale,
 *    dove l'imposta non e' deliberata dalla Provincia; Avellino non ha una delibera di variazione.
 *    Per queste sette l'aliquota resta null, ed e' corretto: non abbiamo un numero, non lo inventiamo.
 *  - IVASS non pubblica Sud Sardegna separatamente (provincia istituita nel 2016).
 * Serve a distinguere "la fonte non ce l'ha" da "il parsing si e' rotto": la seconda deve fermare
 * la riscrittura, la prima no.
 */
const ASSENTI = {
  aliquota: ['AV', 'BZ', 'GO', 'PN', 'TN', 'TS', 'UD'],
  rc: ['SU'],
};
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z]/g, '');
const PER_NOME = {};
for (const [sg, p] of Object.entries(PROVINCE)) PER_NOME[norm(p.nome)] = sg;
const sigla = nome => PER_NOME[norm(nome)] || ALIAS[norm(nome)] || null;

// "Autovetture" / "Motocicli" / "Ciclomotori" → le chiavi che usa l'app.
const TIPO = { AUTOVETTURE: 'auto', MOTOCICLI: 'moto', CICLOMOTORI: 'ciclomotore' };
const tipoDi = s => TIPO[norm(s)] || null;
const numero = v => (v == null || v === '' || isNaN(Number(v)) ? null : Math.round(Number(v) * 10) / 10);

// ─── MEF: CSV windows-1252, separatore ';', campi fra virgolette ─────────────
function leggiMef(buf) {
  const fuori = {};
  const ignorate = [];
  let righe = 0;
  for (const r of buf.toString('latin1').split(/\r?\n/).slice(1)) {
    const campi = [...r.matchAll(/"([^"]*)"/g)].map(m => m[1]);
    if (campi.length < 6) continue;
    righe++;
    const sg = sigla(campi[0]);
    if (!sg) { ignorate.push(campi[0]); continue; }
    const al = Number(String(campi[5]).replace(',', '.'));
    if (Number.isFinite(al)) fuori[sg] = { aliquotaRc: al, delibera: campi[1] || null };
  }
  // Un nome non riconosciuto e' un difetto NOSTRO (manca un alias) e va gridato: se lo si ignora,
  // una provincia sparisce in silenzio dal calcolo.
  if (ignorate.length) throw new Error('province MEF non riconosciute (' + ignorate.length + '): ' + ignorate.join(', ') + ' — aggiungi l\'alias invece di perderle');
  return { fuori, righe };
}

(async () => {
  const dry = process.argv.includes('--dry');

  const tav = await trovaTavoleIvass();
  console.log('[costi] IVASS: ' + tav.titolo);
  console.log('[costi]        ' + tav.url);
  await sleep(PAUSA_MS);
  const xl = await scarica(tav.url);
  if (xl.status !== 200) throw new Error('tavole IVASS: HTTP ' + xl.status);
  const x = apriXlsx(xl.corpo);
  console.log('[costi] tavole nel fascicolo: ' + Object.keys(x.fogli).length);

  // A12 — provincia x tipo veicolo: media e percentili.
  //   0 Rilevazione | 1 Periodo | 2 Provincia | 3 Media | 4 5° | 5 10° | 6 25° | 7 50° | 8 75° | 9 90°
  const perProv = {};
  let periodo = null;
  const nonViste = new Set();
  for (const r of righeDi(x, 12)) {
    const t = tipoDi(r[0]); if (!t) continue;
    const sg = sigla(r[2]); if (!sg) { nonViste.add(r[2]); continue; }
    periodo = periodo || String(r[1] || '').replace(/\s+/g, ' ').trim();
    (perProv[sg] = perProv[sg] || {})[t] = {
      medio: numero(r[3]), p5: numero(r[4]), p10: numero(r[5]),
      p25: numero(r[6]), mediana: numero(r[7]), p75: numero(r[8]), p90: numero(r[9]),
    };
  }
  // A16 — provincia x tipo veicolo x classe bonus-malus: 0 Ril | 1 Per | 2 Prov | 3 Classe | 4 Media | 5 N.
  for (const r of righeDi(x, 16)) {
    const t = tipoDi(r[0]); if (!t) continue;
    const sg = sigla(r[2]); if (!sg) { nonViste.add(r[2]); continue; }
    const v = perProv[sg] && perProv[sg][t];
    if (!v) continue;
    const cl = String(r[3] || '').replace(/^\d+:\s*/, '').trim();
    if (!cl) continue;
    (v.perClasse = v.perClasse || {})[cl] = { medio: numero(r[4]), contratti: numero(r[5]) };
  }
  fs.rmSync(x.tmp, { recursive: true, force: true });
  if (nonViste.size) console.warn('[costi] province IVASS non riconosciute: ' + [...nonViste].join(', '));

  await sleep(PAUSA_MS);
  const rm = await scarica(MEF_CSV);
  if (rm.status !== 200) throw new Error('MEF: HTTP ' + rm.status);
  const { fuori: mef, righe: righeMef } = leggiMef(rm.corpo);

  const province = {};
  for (const sg of Object.keys(PROVINCE)) {
    const rc = perProv[sg] || {};
    province[sg] = {
      auto: rc.auto || null, moto: rc.moto || null, ciclomotore: rc.ciclomotore || null,
      aliquotaRc: (mef[sg] || {}).aliquotaRc ?? null,
    };
  }

  const conAuto = Object.values(province).filter(p => p.auto && p.auto.mediana != null).length;
  const conMoto = Object.values(province).filter(p => p.moto && p.moto.mediana != null).length;
  const conAliq = Object.values(province).filter(p => p.aliquotaRc != null).length;
  const conClassi = Object.values(province).filter(p => p.auto && p.auto.perClasse).length;
  console.log(`[costi] copertura: auto ${conAuto} · moto ${conMoto} · classi bonus-malus ${conClassi} · aliquota ${conAliq} (su 107 province)`);

  // Le guardie difendono dal PARSING ROTTO, non pretendono una copertura che le fonti non hanno:
  // le assenze strutturali sono elencate in ASSENTI e sottratte dall'atteso. Stessa filosofia del
  // generatore IPT: meglio non riscrivere che riscrivere una tabella monca.
  const attesoRc = 107 - ASSENTI.rc.length;
  const attesoAliq = 107 - ASSENTI.aliquota.length;
  if (conAuto < attesoRc) throw new Error(`premio autovetture su ${conAuto} province invece di ${attesoRc}: la tavola A12 e' cambiata, file NON riscritto`);
  if (conMoto < attesoRc) throw new Error(`premio motocicli su ${conMoto} province invece di ${attesoRc}: la tavola A12 e' cambiata, file NON riscritto`);
  if (conClassi < attesoRc) throw new Error(`classi bonus-malus su ${conClassi} province invece di ${attesoRc}: la tavola A16 e' cambiata, file NON riscritto`);
  if (conAliq < attesoAliq) throw new Error(`aliquota su ${conAliq} province invece di ${attesoAliq}: il CSV MEF e' cambiato (${righeMef} righe lette), file NON riscritto`);

  const out = {
    generatedAt: new Date().toISOString(),
    periodo,
    fonti: {
      rc: { nome: 'IVASS — indagine IPER: prezzi dei contratti r.c. auto effettivamente stipulati', pagina: tav.pagina, file: tav.url, licenza: 'riuso consentito con citazione della fonte' },
      aliquota: { nome: 'MEF, Dipartimento delle Finanze — aliquote imposta r.c. auto deliberate dalle Province', url: MEF_CSV },
    },
    nota: 'Statistiche su tutte le polizze della provincia: non sono un preventivo per il singolo veicolo (non tengono conto di potenza, eta e classe di merito del conducente).',
    assenti: {
      aliquota: { sigle: ASSENTI.aliquota, perche: 'province autonome e regione a statuto speciale: l\'imposta non e\' deliberata dalla Provincia. Avellino non ha delibera di variazione.' },
      rc: { sigle: ASSENTI.rc, perche: 'IVASS non pubblica Sud Sardegna separatamente (provincia istituita nel 2016).' },
    },
    province,
  };
  if (dry) { console.log('[costi] --dry: niente scritto'); return; }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log('[costi] scritto ' + OUT);
})().catch(e => { console.error('[costi] FATAL', e.message); process.exit(1); });
