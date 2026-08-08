'use strict';
/**
 * LE VERSIONI SUGGERIBILI PER (marca, modello) — dal catalogo Subito su disco.
 *
 * Richiesta del proprietario (2026-08-08): anche il campo Versione, come Marca e Modello,
 * deve avere la tendina accanto al testo libero. Il testo resta il contratto — quello che
 * scrivi va alle fonti com'e' (Subito e Autoscout in ricerca testuale, Moto.it tradotto) —
 * la tendina SUGGERISCE i nomi che il mercato usa davvero, senza inventare corrispondenze
 * fra cataloghi.
 *
 * La fonte e' data/subito-catalogo.json (marca → modello → versioni), gia' su disco:
 * niente rete, e i nomi sono quelli che i venditori dichiarano («124 Spider 1.4 Turbo
 * MultiAir 170 CV»). Dal nome-versione si toglie la testa che ripete il nome del modello
 * («1.4 Turbo MultiAir 170 CV»): e' la parte che si digita, ed e' quella che restringe.
 * «Altro allestimento» (id 000000) e' il segnaposto del venditore muto: non si suggerisce.
 *
 * La famiglia si trova con risolviNodo — lo stesso risolutore della ricerca, ponte degli
 * ospiti compreso: le versioni della «Vespa 125 GTS» arrivano anche cercando marca Vespa.
 * Modello che non risolve una famiglia → lista vuota: il campo resta testo libero puro,
 * non si spaccia un elenco di un altro veicolo per suggerimento.
 */
const { risolviNodo } = require('./scrapers/subito-nodo');
const { norm } = require('./scrapers/brand-match');

let CAT = null;
function catalogo() {
  if (CAT) return CAT;
  CAT = { auto: new Map(), moto: new Map() };
  try {
    const j = require('../data/subito-catalogo.json');
    for (const t of ['auto', 'moto']) {
      for (const m of Object.values(j[t] || {})) {
        if (m && m.id) CAT[t].set(String(m.id), m);
      }
    }
  } catch (e) { console.warn('[versioni-menu] catalogo non letto: ' + e.message); }
  return CAT;
}

const spazi = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * DALLA STRINGA DI CATALOGO ALLA PARTE CHE SI DIGITA. Le versioni Subito sono
 * motore+allestimento tutto attaccato («2.0 TDI 184 CV 5p. GTD BlueMotion Technology»):
 * suggerite intere erano 1.348 voci per la Golf, quasi uguali fra loro, e sceglierne una
 * mandava TUTTA la stringa nel filtro — che alle fonti e' un AND su ogni parola, cioe'
 * zero risultati. Quello che si digita e' l'ALLESTIMENTO: la coda dopo l'ultimo marcatore
 * di potenza (NNN CV / NNN kW), tolti i token delle porte (3p./5p.). Le versioni senza
 * marcatore (le moto: «Super ABS i.e.», «Pro») restano intere, che gia' si digitano cosi'.
 * Il motore-e-basta (coda vuota) non si suggerisce: non distingue niente.
 */
function allestimentoDaVersione(v) {
  let s = String(v).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = [...s.matchAll(/\b\d{1,4}\s*(?:CV|kW)\b/gi)];
  if (m.length) {
    const ultimo = m[m.length - 1];
    s = s.slice(ultimo.index + ultimo[0].length).trim();
  }
  s = s.replace(/^\d\s*p\.?\s+/i, '').trim();            // «5p. GTD …» → «GTD …»
  return s;
}

/**
 * I suggerimenti per la tendina: gli allestimenti distinti della famiglia risolta,
 * ordinati per frequenza (quante versioni li portano) e poi per nome — cio' che il
 * mercato usa di piu' sta in cima.
 */
function versioniDi(tipo, marca, modello) {
  const t = tipo === 'moto' ? 'moto' : 'auto';
  const nodo = risolviNodo(t, marca, modello);
  if (!nodo || !nodo.famigliaId) return [];
  const m = catalogo()[t].get(String(nodo.marcaId));
  if (!m) return [];
  const famIds = new Set((nodo.famigliaIds || [nodo.famigliaId]).map(String));
  const conta = new Map();   // norm(allestimento) → { nome, n }
  for (const [modId, mod] of Object.entries(m.modelli || {})) {
    // AUTO: il catalogo scende alla generazione, che porta `famigliaId`; MOTO: il modello
    // E' la famiglia (fotocopia misurata 4.605/4.605), quindi si confronta l'id stesso.
    const dentro = t === 'auto' ? famIds.has(String(mod.famigliaId || '')) : famIds.has(String(modId));
    if (!dentro) continue;
    const testaMod = spazi(mod.nome || '');
    const testaFam = spazi(mod.famiglia || '');
    for (const [vid, vnome] of Object.entries(mod.versioni || {})) {
      if (vid === '000000') continue;                    // «Altro allestimento»
      let v = String(vnome).trim();
      const sv = spazi(v);
      // via la testa che ripete il modello (o la famiglia): resta la parte che si digita
      for (const testa of [testaMod, testaFam]) {
        if (testa && sv.startsWith(testa + ' ')) {
          // il taglio va fatto sul testo VERO, non sulla forma normalizzata: si contano
          // le parole della testa e si tolgono altrettante parole dal nome originale
          const nParole = testa.split(' ').length;
          v = v.split(/\s+/).slice(nParole).join(' ').trim();
          break;
        }
      }
      const a = allestimentoDaVersione(v);
      if (!a) continue;
      const k = norm(a);
      if (!k) continue;
      const voce = conta.get(k);
      if (voce) voce.n++;
      else conta.set(k, { nome: a, n: 1 });
    }
  }
  return [...conta.values()]
    .sort((x, y) => y.n - x.n || x.nome.localeCompare(y.nome, 'it'))
    .map(x => x.nome);
}

module.exports = { versioniDi };
