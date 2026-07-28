'use strict';
/**
 * DALL'OMOLOGAZIONE ALLE VERSIONI — il pezzo che mancava a Safety Gate.
 *
 * Un'allerta europea individua i veicoli colpiti col numero di omologazione, e finora
 * quel numero restava una stringa da guardare: `safety-gate.js` lo scrive nel suo
 * commento — "un annuncio non porta l'omologazione", quindi il semaforo si fermava alla
 * famiglia. Il catalogo omologazioni dell'RDW quel numero lo conosce e lo apre.
 *
 * VERIFICATO PRIMA DI SCRIVERE UNA RIGA, su omologazioni vere prese dalle allerte:
 *   18 su 18 trovate nel catalogo RDW, tutte con un nome commerciale
 *   Audi     e1*2007/46*1801  → 28 nomi (A6 Avant, A7 Sportback, A6 Allroad…)
 *   Porsche  e13*2007/46*0900 →  9 nomi (Cayenne, E-Hybrid, GTS, S, Turbo GT…)
 *   Harley   e4*168/2013*00062→ 26 nomi (Street Bob 114, Fat Boy 114…)
 *
 * DUE RICHIESTE, SEMPRE. Le omologazioni grosse hanno decine di migliaia di righe —
 * quella Audi ne ha 36.806 — e scaricarle vorrebbe dire quaranta richieste. Si chiede al
 * server di RAGGRUPPARE: due query aggregate rispondono in meno di un secondo qualunque
 * sia la dimensione. E' la differenza fra una cosa che si puo' fare a schermo e una che no.
 *
 * QUELLO CHE NON DICE, e va scritto accanto ai numeri:
 *  - i nomi sono quelli del mercato OLANDESE. Un modello venduto in Italia con un altro
 *    nome commerciale compare col suo, e non e' un errore;
 *  - la potenza copre solo le versioni a combustione: per le elettriche l'RDW la mette in
 *    un altro campo, quindi li' si dice quante sono e non quanto spingono;
 *  - l'omologazione identifica il TIPO, che puo' portare piu' modelli commerciali. Un
 *    numero di un'allerta "Audi Q8" puo' aprirsi su Q7: e' giusto cosi', e' lo stesso tipo.
 *
 * Licenza RDW: dominio pubblico. Nessuna chiave.
 */
const https = require('https');

const HOST = 'opendata.rdw.nl';
const NOMI = 'x5v3-sewk';        // TGK Handelsbenaming Fabrikant: omologazione → nome commerciale
const ENERGIA = 'gr7t-qfnb';     // TGK Energiebron Uitvoering: alimentazione e potenza per versione
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1';
const TIMEOUT = 20000;

// I codici alimentazione dell'RDW, sciolti in italiano. Insieme chiuso: quelli che non
// conosco restano com'e' scritto invece di sparire.
const CARBURANTE = { B: 'Benzina', D: 'Diesel', E: 'Elettrico', L: 'GPL', G: 'Metano',
  N: 'Metano', H: 'Idrogeno', W: 'Etanolo', C: 'CNG', A: 'Alcol' };

const cache = new Map();                  // base → { ts, dati }
const TTL = 12 * 60 * 60 * 1000;          // il catalogo cambia di rado: mezza giornata basta
const MAX = 200;

function getJson(percorso) {
  return new Promise((res, rej) => {
    const req = https.get({ host: HOST, path: percorso, headers: { 'user-agent': UA, accept: 'application/json' } }, r => {
      let d = ''; r.setEncoding('utf8');
      r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode !== 200) return rej(new Error('RDW HTTP ' + r.statusCode));
        try { res(JSON.parse(d)); } catch (_) { rej(new Error('RDW: risposta non-JSON')); }
      });
    });
    req.on('error', e => rej(new Error(e.message)));
    req.setTimeout(TIMEOUT, () => req.destroy(new Error('timeout')));
  });
}

/**
 * Da come lo scrive Safety Gate a come lo scrive l'RDW.
 *
 *   "e4*168/2013*00131*01-*04 (RA1)"  →  "e4*168/2013*00131"
 *   "e1*2007/46*1801*"                →  "e1*2007/46*1801"
 *
 * Il codice fra parentesi e' del costruttore, non dell'omologazione. L'estensione finale
 * (*01, *04) e' una revisione dello stesso tipo: si cerca sulla BASE, se no una revisione
 * diversa da quella citata nell'allerta non verrebbe trovata — e sono lo stesso veicolo.
 * Misurato sull'archivio: 2.825 numeri distinti, di cui 913 senza forma canonica piena.
 */
function base(s) {
  const t = String(s || '').replace(/\([^)]*\)/g, ' ').trim();
  const m = t.match(/^(e\d+\s*\*\s*[\d/]+\s*\*\s*\d+)/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

const cv = x => { const k = parseFloat(x); return Number.isFinite(k) && k > 0 ? Math.round(k * 1.36) : null; };

/** Le versioni di un'omologazione: nomi commerciali, alimentazioni, potenze. */
async function versioni(omologazione) {
  const b = base(omologazione);
  if (!b) return { ok: false, motivo: 'numero di omologazione non riconosciuto' };

  const hit = cache.get(b);
  if (hit && Date.now() - hit.ts < TTL) { cache.delete(b); cache.set(b, hit); return hit.dati; }

  // `starts_with` e non `=`: l'allerta cita una revisione, il catalogo le ha tutte.
  const dove = encodeURIComponent(`starts_with(typegoedkeuringsnummer, '${b.replace(/'/g, "''")}')`);
  const sel1 = encodeURIComponent('handelsbenamingfabrikant, count(distinct codeuitvoeringtgk) as versioni');
  const sel2 = encodeURIComponent('codeenergiebron, count(distinct codeuitvoeringtgk) as versioni, min(maximumnettovermogenogr) as kwmin, max(maximumnettovermogenogr) as kwmax');

  let nomi = [], energia = [];
  try {
    [nomi, energia] = await Promise.all([
      getJson(`/resource/${NOMI}.json?$select=${sel1}&$where=${dove}&$group=${encodeURIComponent('handelsbenamingfabrikant')}&$order=${encodeURIComponent('versioni desc')}&$limit=60`),
      getJson(`/resource/${ENERGIA}.json?$select=${sel2}&$where=${dove}&$group=${encodeURIComponent('codeenergiebron')}&$limit=20`),
    ]);
  } catch (e) {
    return { ok: false, motivo: e.message };   // niente cache sugli errori: si riprova
  }

  const dati = {
    ok: true,
    omologazione: b,
    nomi: (Array.isArray(nomi) ? nomi : [])
      .filter(x => x.handelsbenamingfabrikant)
      .map(x => ({ nome: x.handelsbenamingfabrikant, versioni: parseInt(x.versioni, 10) || 0 })),
    alimentazioni: (Array.isArray(energia) ? energia : [])
      .filter(x => x.codeenergiebron)
      .map(x => ({
        nome: CARBURANTE[x.codeenergiebron] || x.codeenergiebron,
        versioni: parseInt(x.versioni, 10) || 0,
        // Sulle elettriche questo campo e' vuoto: si risponde null invece di uno zero
        // che a schermo sembrerebbe "zero cavalli".
        cvMin: cv(x.kwmin), cvMax: cv(x.kwmax),
      })),
    fonte: 'RDW — catalogo omologazioni UE',
  };
  dati.totaleVersioni = dati.nomi.reduce((n, x) => n + x.versioni, 0);

  cache.set(b, { ts: Date.now(), dati });
  if (cache.size > MAX) cache.delete(cache.keys().next().value);
  return dati;
}

module.exports = { versioni, _base: base };
