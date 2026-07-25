'use strict';
/**
 * Prezzi carburante ufficiali per PROVINCIA — open data MIMIT (Osservaprezzi Carburanti).
 *
 * A cosa serve: incrociati col consumo della scheda tecnica danno il COSTO REALE al km
 * dove vive l'utente, non una media nazionale. Misurato: la stessa auto costa ~2.029 €/anno
 * a Palermo e ~1.988 € a Milano; benzina vs GPL sullo stesso modello sono 1.988 € contro 955 €.
 *
 * Fonte: https://www.mimit.gov.it/it/open-data/elenco-dataset/carburanti-prezzi-praticati-e-anagrafica-degli-impianti
 * Licenza IODL 2.0 → riuso anche commerciale CON ATTRIBUZIONE (la UI deve citare la fonte).
 * robots.txt di mimit.gov.it verificato: /images/ NON è in Disallow.
 *
 * INSIDIE VERIFICATE sui file veri (non ipotesi):
 *  - separatore PIPE "|", non virgola (cambiato dal 10/02/2026);
 *  - riga 1 = "Estrazione del AAAA-MM-GG", riga 2 = intestazione, dati dalla 3ª;
 *  - codifica latin1, non UTF-8;
 *  - ~0,4% delle righe anagrafica ha in Provincia un nome di comune invece della sigla
 *    → si tengono solo le sigle a 2 lettere;
 *  - 58 stringhe-carburante distinte: i premium (Blue Diesel, HVOlution, V-Power, Hi-Q…)
 *    costano più del carburante base, quindi NON si fondono con esso: si quotano solo i
 *    4 carburanti standard, altrimenti la mediana risulterebbe gonfiata;
 *  - GPL e metano hanno pochissimi impianti "self" (Milano: 1 e 4) → per loro si usano
 *    tutti i prezzi, altrimenti la mediana poggia su 1 solo impianto.
 */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const HOST = 'https://www.mimit.gov.it';
const URL_PREZZI = `${HOST}/images/exportCSV/prezzo_alle_8.csv`;
const URL_IMPIANTI = `${HOST}/images/exportCSV/anagrafica_impianti_attivi.csv`;
const FONTE = 'MIMIT — Osservaprezzi Carburanti (IODL 2.0)';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'carburanti-cache.json');
const TTL_MS = 12 * 60 * 60 * 1000;   // i prezzi valgono "alle 8" del giorno: due controlli al giorno bastano
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Solo i 4 carburanti standard. I premium restano fuori di proposito (vedi intestazione).
const FAMIGLIE = { benzina: 'Benzina', gasolio: 'Gasolio', gpl: 'GPL', metano: 'Metano' };
// Famiglie per cui il campione "self" è troppo magro → si usano tutti i prezzi.
const SENZA_SELF = new Set(['gpl', 'metano']);

const isAllowedHost = h => /(^|\.)mimit\.gov\.it$/i.test(String(h || ''));

function scarica(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (_) { return reject(new Error('url non valido')); }
    if (!isAllowedHost(u.hostname)) return reject(new Error('host non consentito'));
    const req = https.get(url, { headers: { 'user-agent': UA, accept: 'text/csv,*/*', 'accept-encoding': 'gzip, deflate' } }, res => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < 5) {
        res.resume();
        let next; try { next = new URL(res.headers.location, url); } catch (_) { return reject(new Error('redirect non valido')); }
        if (!isAllowedHost(next.hostname)) return reject(new Error('redirect fuori host'));
        return resolve(scarica(next.href, redirects + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`http ${code}`)); }
      const chunks = [];
      let s = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') s = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      s.on('data', c => chunks.push(c));
      s.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));   // NON utf8: il file è latin1
      s.on('error', e => reject(e));
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
  });
}

const righe = txt => String(txt || '').split('\n').slice(2).filter(Boolean);   // salta "Estrazione del…" + intestazione

// anagrafica → Map(idImpianto → sigla provincia). Scarta le righe con Provincia sporca.
function parseImpianti(txt) {
  const out = new Map();
  for (const r of righe(txt)) {
    const c = r.split('|');
    if (c.length < 8) continue;
    const id = c[0].trim();
    const pv = (c[7] || '').trim().toUpperCase();
    if (id && /^[A-Z]{2}$/.test(pv)) out.set(id, pv);
  }
  return out;
}

const mediana = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

// prezzi + anagrafica → { aggiornato, fonte, province: { MI: { benzina:{p,n}, … } }, italia: {…} }
function costruisciIndice(txtPrezzi, txtImpianti) {
  const provDi = parseImpianti(txtImpianti);
  const perFam = {};   // famiglia → { self:[], tutti:[] } nazionale
  const perProv = {};  // provincia → famiglia → { self:[], tutti:[] }
  const nome2fam = {};
  for (const [fam, etichetta] of Object.entries(FAMIGLIE)) nome2fam[etichetta.toLowerCase()] = fam;

  for (const r of righe(txtPrezzi)) {
    const c = r.split('|');
    if (c.length < 4) continue;
    const fam = nome2fam[(c[1] || '').trim().toLowerCase()];
    if (!fam) continue;                                  // premium/HVO fuori
    const p = parseFloat(c[2]);
    if (!isFinite(p) || p <= 0 || p > 10) continue;       // scarta valori impossibili
    const self = String(c[3]).trim() === '1';
    const pv = provDi.get(c[0].trim());
    if (!pv) continue;
    (perProv[pv] = perProv[pv] || {});
    const slot = (perProv[pv][fam] = perProv[pv][fam] || { self: [], tutti: [] });
    const nz = (perFam[fam] = perFam[fam] || { self: [], tutti: [] });
    slot.tutti.push(p); nz.tutti.push(p);
    if (self) { slot.self.push(p); nz.self.push(p); }
  }

  const riduci = m => {
    const o = {};
    for (const [fam, v] of Object.entries(m)) {
      // self quando il campione è consistente, altrimenti tutti (GPL/metano hanno pochi self)
      const usaSelf = !SENZA_SELF.has(fam) && v.self.length >= 5;
      const arr = usaSelf ? v.self : v.tutti;
      const med = mediana(arr);
      if (med != null) o[fam] = { p: +med.toFixed(3), n: arr.length, self: usaSelf };
    }
    return o;
  };
  const province = {};
  for (const [pv, m] of Object.entries(perProv)) {
    const r = riduci(m);
    if (Object.keys(r).length) province[pv] = r;
  }
  const estrazione = (String(txtPrezzi).match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  return { aggiornato: estrazione, scaricato: new Date().toISOString(), fonte: FONTE, italia: riduci(perFam), province };
}

let memo = null;
function leggiCache() {
  if (memo && Date.now() - Date.parse(memo.scaricato) < TTL_MS) return memo;
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && j.scaricato && Date.now() - Date.parse(j.scaricato) < TTL_MS) { memo = j; return j; }
    if (j && j.province) memo = j;   // scaduta ma valida: si serve intanto che si aggiorna
  } catch (_) {}
  return null;
}

let inVolo = null;
/**
 * Indice prezzi. Serve la cache se fresca; altrimenti riscarica (una sola volta in
 * parallelo). Se il download fallisce ma esiste una cache vecchia, torna quella: meglio
 * un prezzo di ieri che nessun prezzo.
 */
async function indice() {
  const c = leggiCache();
  if (c && Date.now() - Date.parse(c.scaricato) < TTL_MS) return c;
  if (inVolo) return inVolo;
  inVolo = (async () => {
    try {
      const [p, i] = await Promise.all([scarica(URL_PREZZI), scarica(URL_IMPIANTI)]);
      const idx = costruisciIndice(p, i);
      if (!Object.keys(idx.province).length) throw new Error('indice vuoto');
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify(idx)); } catch (_) {}
      memo = idx;
      return idx;
    } catch (e) {
      console.warn('[carburanti] aggiornamento KO:', e.message);
      return memo || c || null;                     // ripiego sulla cache vecchia
    } finally { inVolo = null; }
  })();
  return inVolo;
}

// "Benzina"/"Gasolio"/"Diesel"/"Ibrida benzina"… → famiglia, o null se non quotabile
// (elettrico: il prezzo dell'energia è un'altra fonte, non la si finge qui).
function famigliaDa(alimentazione) {
  const s = String(alimentazione || '').toLowerCase();
  if (!s) return null;
  if (/elettric|electric/.test(s) && !/ibrid|hybrid/.test(s)) return null;
  if (/gpl|lpg/.test(s)) return 'gpl';
  if (/metano|cng|natural/.test(s)) return 'metano';
  if (/diesel|gasolio/.test(s)) return 'gasolio';
  if (/benzin|petrol|gasoline/.test(s)) return 'benzina';
  return null;
}

// "6.4-7.2 l/100 km" / "5,1 l/100 km" → 6.8 (media del range). null se non è litri.
function consumoDa(valore) {
  const s = String(valore || '');
  if (!/l\s*\/\s*100/i.test(s)) return null;          // kWh/100km (elettriche) → non qui
  const num = s.replace(',', '.').match(/\d+(?:\.\d+)?/g);
  if (!num || !num.length) return null;
  const v = num.slice(0, 2).map(Number).filter(x => x > 0 && x < 60);
  if (!v.length) return null;
  return +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2);
}

module.exports = { indice, costruisciIndice, parseImpianti, famigliaDa, consumoDa, FAMIGLIE, FONTE, _scarica: scarica };
