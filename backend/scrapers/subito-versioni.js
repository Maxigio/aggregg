'use strict';
/**
 * LE VERSIONI SUBITO CHE DICONO UNA COSA — per id, non per testo.
 *
 * Serve quando la versione scelta viene da un altro catalogo. "GTI" e' una voce sola su
 * Autoscout; su Subito sono 87 versioni diverse ("Golf 2.0 TSI 5p. GTI", "Golf 2.0 cat
 * 5 porte GTI", …) e il suo filtro `cv` accetta UN id solo — verificato in tre modi: la
 * virgola risponde 400, il pipe 400, il parametro ripetuto risponde 200 ma ne considera
 * uno solo (16 annunci invece dei 23 delle tre versioni sommate).
 *
 * Quindi alla fonte va il TESTO, che concentra l'insieme, e qui si tiene chi dichiara una
 * versione che sta nell'INSIEME DEGLI ID. Filtrare per id invece che per testo cambia due
 * cose concrete:
 *   "R" — una lettera sola nel titolo pesca qualsiasi cosa; come id non ha ambiguita'.
 *   la versione dichiarata puo' scrivere il nome in un altro ordine, e l'id no.
 *
 * IL CONFRONTO E' DENTRO UNA FONTE SOLA, ed e' la ragione per cui e' lecito: si guarda se
 * il nome della versione Subito contiene la parola cercata. Non si sta decidendo che due
 * cataloghi diversi parlano dello stesso veicolo — quello lo conferma l'utente.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'data', 'subito-catalogo.json');
let CAT = null;
function catalogo() {
  if (CAT) return CAT;
  try { CAT = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { console.warn('[subito-versioni] catalogo assente: ' + e.message); CAT = { auto: {}, moto: {} }; }
  return CAT;
}

/** parole intere, cifre e lettere separate ("500C" → "500 c"), accenti via. */
const parole = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
  .split(' ').filter(Boolean);

/**
 * Gli id delle versioni di una famiglia il cui NOME contiene tutte le parole cercate.
 *
 * @param {string} tipo         'auto' | 'moto'
 * @param {string} marcaId      id marca Subito
 * @param {Array}  famigliaIds  gli id-famiglia (una famiglia puo' avere piu' voci)
 * @param {string} testo        "GTI", "320d", "Cross"
 * @returns {Set<string>} vuoto se il catalogo non ha niente: chi chiama decide cosa farne
 */
function versioniCheDicono(tipo, marcaId, famigliaIds, testo) {
  const out = new Set();
  const cercate = parole(testo);
  if (!cercate.length || !marcaId) return out;
  const t = tipo === 'moto' ? 'moto' : 'auto';
  const marca = Object.values(catalogo()[t] || {}).find(x => x.id === String(marcaId));
  if (!marca) return out;
  const fam = new Set((famigliaIds || []).map(String));
  for (const [genId, mm] of Object.entries(marca.modelli || {})) {
    if (fam.size && !fam.has(String(mm.famigliaId || genId))) continue;
    for (const [vid, nome] of Object.entries(mm.versioni || {})) {
      const p = ' ' + parole(nome).join(' ') + ' ';
      if (cercate.every(w => p.includes(' ' + w + ' '))) out.add(String(vid));
    }
  }
  return out;
}

/**
 * Le versioni di una famiglia che appartengono a un MODELLO col nome di Autoscout.
 *
 * Su Subito il livello "320" non esiste: sotto "Serie 3" ci sono 1090 versioni e il
 * motore sta scritto nella prima parola del nome ("320d Touring Business", "318i 4
 * porte"). Cercando "BMW 320" il menu le mostrava tutte, comprese le 316 e le 330.
 *
 * Le parole del modello devono comparire ATTACCATE e NELL'ORDINE, ma non per forza in
 * testa: BMW scrive il motore per primo ("320d Touring Business"), Mini lo mette in fondo
 * ("Mini 1.3 cat Cooper Sports Pack"). Ancorare all'inizio dava zero su tutta la Mini.
 *
 * L'ultima parola puo' avere una coda di sole LETTERE: "320" prende 320d, 320i, 320e —
 * non 3200. Le cifre attaccate sarebbero un altro modello, ed e' l'errore che
 * aggancerebbe "1750" a "75".
 */
function versioniDelModello(tipo, marcaId, famigliaIds, modello) {
  const out = new Set();
  const m = parole(modello);
  if (!m.length || !marcaId) return out;
  const t = tipo === 'moto' ? 'moto' : 'auto';
  const marca = Object.values(catalogo()[t] || {}).find(x => x.id === String(marcaId));
  if (!marca) return out;
  const fam = new Set((famigliaIds || []).map(String));
  for (const [genId, mm] of Object.entries(marca.modelli || {})) {
    if (fam.size && !fam.has(String(mm.famigliaId || genId))) continue;
    for (const [vid, nome] of Object.entries(mm.versioni || {})) {
      const p = parole(nome);
      if (p.length < m.length) continue;
      let trovato = false;
      for (let s = 0; s + m.length <= p.length && !trovato; s++) {
        let ok = true;
        for (let i = 0; i < m.length; i++) {
          const a = p[s + i], b = m[i];
          // l'ultima parola tollera una coda di sole lettere; le altre combaciano intere
          if (i === m.length - 1) { if (a !== b && !(a.startsWith(b) && /^[a-z]+$/.test(a.slice(b.length)))) { ok = false; break; } }
          else if (a !== b) { ok = false; break; }
        }
        trovato = ok;
      }
      if (trovato) out.add(String(vid));
    }
  }
  return out;
}

module.exports = { versioniCheDicono, versioniDelModello, _parole: parole };
