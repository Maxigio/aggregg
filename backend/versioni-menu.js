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
 * LA REGOLA DEL FILTRO (campagna V, 2026-08-08): la famiglia Subito e' spesso PIU' LARGA
 * del nome del menu («CLA 200» e «CLA 180» sono entrambe famiglia «CLA»), e la tendina che
 * raccoglieva l'intera famiglia mischiava i fratelli — difetto indicato a mano dal
 * proprietario. Le versioni si filtrano col NOME, secondo la cascata misurata e letta
 * caso per caso su tutti i 4.482 nomi risolti con versioni (misura-filtro-versioni.js):
 *
 *  1. nome ≡ famiglia — il risolutore l'ha certificato (come famiglia/ponte), o i token
 *     del nome stanno tutti nella famiglia («Tourneo» ⊂ «Tourneo Custom»), o le squash
 *     coincidono/si prefissano coi confini («BB 3»≡«BB3», «CRF 1000» ⊂ «CRF1000L Africa
 *     Twin») → TUTTA la famiglia: il nome non aggiunge specificita'.
 *  2. TESTA: versioni che INIZIANO col nome, confronto sulla stringa schiacciata coi
 *     confini di taglioValido — «cla200» prende «CLA 200 d» e non «CLA 2000»; «rs3»
 *     prende anche «RS 3 SPB» scritto staccato; «x2m» prende «X2 M35i» e NON i trim
 *     «M Sport» (che il residuo avrebbe pescato: letto in negativo).
 *  3. GENERAZIONE (solo come=generazione, e solo se filtra davvero): gli id generazione
 *     dell'indice sono gli id modello del catalogo (verificato su e-C4/Q7 e-tron); il
 *     ripiego per chi non ha versioni di testa — i sei codici Porsche 964..997 filtrano
 *     la famiglia 911 alla generazione giusta. MAI prima della testa: «S1» risolve la
 *     generazione «A1/S1», secchio misto da 231 versioni, ma ha 2 versioni «S1 …».
 *  4. RESIDUO: i token che il nome aggiunge alla famiglia, tutti presenti come token
 *     della versione ovunque stiano — «595 Competizione» trova le 8 Competizione in coda;
 *     le sigle moto ([R], [S], [T120], [8,Ball]) sono i veri sotto-modelli (lette tutte:
 *     zero assurdi). In piu' il residuo INCOLLATO: «NC700S» = famiglia «NC 700» + resto
 *     «s», cercato come token esatto (mai prefisso: «s» non deve prendere «Sport»).
 *  5. Niente appiglio → NIENTE suggerimenti: la variante non e' nel catalogo (SL 380,
 *     ES 300, TM «2T») e proporre i trim dei fratelli e' esattamente il difetto CLA.
 *     Tendina vuota dichiarata qui, campo testo libero puro.
 *
 * «Altro allestimento» (id 000000) e' il segnaposto del venditore muto: non si suggerisce.
 * La famiglia si trova con risolviNodo — lo stesso risolutore della ricerca, ponte degli
 * ospiti compreso. Modello che non risolve una famiglia → lista vuota.
 */
const { risolviNodo } = require('./scrapers/subito-nodo');
const { norm, taglioValido } = require('./scrapers/brand-match');

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
const tokDi = s => spazi(s).split(' ').filter(Boolean);
const squash = s => tokDi(s).join('');
const contaTok = xs => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) || 0) + 1); return m; };
const dentroTok = (a, b) => { for (const [x, n] of a) if ((b.get(x) || 0) < n) return false; return true; };
const diffTok = (a, b) => { const out = []; for (const [x, n] of a) { const d = n - (b.get(x) || 0); for (let i = 0; i < d; i++) out.push(x); } return out; };

/** La versione (schiacciata) inizia col nome (schiacciato), col confine di taglioValido. */
const iniziaCol = (sqNome, vRaw, sqV) => {
  if (!sqV.startsWith(sqNome)) return false;
  return sqV.length === sqNome.length || taglioValido(vRaw, sqV, sqNome);
};

/**
 * VIA LA TESTA CHE RIPETE IL NOME: cammina sulle parole vere finche' la squash accumulata
 * copre la testa. La parola a cavallo («M35i» per testa «x2m») resta intera: porta il
 * pezzo che distingue.
 */
function tagliaTestaSquash(vRaw, sqTesta) {
  const parole = String(vRaw).trim().split(/\s+/);
  let acc = '';
  for (let i = 0; i < parole.length; i++) {
    acc += squash(parole[i]);
    if (acc.length >= sqTesta.length) {
      if (!acc.startsWith(sqTesta)) return null;
      if (acc.length === sqTesta.length) return parole.slice(i + 1).join(' ').trim();
      return parole.slice(i).join(' ').trim();
    }
  }
  return null;
}

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
  // le porte non sono un allestimento, in nessuna delle due grafie: «5p. GTD» e
  // «5 porte Titanium» devono dare «GTD» e «Titanium»
  s = s.replace(/^(?:\d\s*(?:p\.?|porte)\s+)+/i, '').replace(/^\d\s*(?:p\.?|porte)$/i, '').trim();
  return s;
}

// i `come` con cui il risolutore CERTIFICA che il nome e' la famiglia stessa: esatta,
// nome doppio, o il ponte dei rinominati (RXV 450 → RXV 4.5: stesso mezzo, nome nuovo)
const COME_NOME_E_FAMIGLIA = /^(?:famiglia\b|ponte \(nome rinominato\))/;

/**
 * I suggerimenti per la tendina: gli allestimenti distinti delle versioni DEL NOME
 * (filtrate con la cascata), ordinati per frequenza e poi per nome.
 */
function versioniDi(tipo, marca, modello) {
  const t = tipo === 'moto' ? 'moto' : 'auto';
  const nodo = risolviNodo(t, marca, modello);
  if (!nodo || !nodo.famigliaId) return [];
  const m = catalogo()[t].get(String(nodo.marcaId));
  if (!m) return [];
  const famIds = new Set((nodo.famigliaIds || [nodo.famigliaId]).map(String));
  const genIds = new Set((nodo.generazioni || []).map(g => String(g.id)));

  // PRIMA PASSATA: le versioni della famiglia, coi loro modelli di catalogo e i nomi
  // delle famiglie risolte (per il confronto nome↔famiglia)
  const voci = [];                 // { raw, sq, tok, testaMod, testaFam, inGen }
  const famNomi = new Map();       // famId → nome famiglia di catalogo
  for (const [modId, mod] of Object.entries(m.modelli || {})) {
    // AUTO: il catalogo scende alla generazione, che porta `famigliaId`; MOTO: il modello
    // E' la famiglia (fotocopia misurata 4.605/4.605), quindi si confronta l'id stesso.
    const fid = t === 'auto' ? String(mod.famigliaId || '') : String(modId);
    if (!famIds.has(fid)) continue;
    famNomi.set(fid, t === 'auto' ? (mod.famiglia || '') : (mod.nome || ''));
    const testaMod = spazi(mod.nome || '');
    const testaFam = spazi(mod.famiglia || '');
    for (const [vid, vnome] of Object.entries(mod.versioni || {})) {
      if (vid === '000000') continue;                    // «Altro allestimento»
      const raw = String(vnome).trim();
      voci.push({ raw, sq: squash(raw), tok: tokDi(raw), testaMod, testaFam, inGen: genIds.has(String(modId)) });
    }
  }
  if (!voci.length) return [];

  // LA CASCATA: si prova ogni forma del nome («Ceed SW / cee'd SW» sono alternative,
  // il residuo della coppia intera e' spazzatura) e vince la regola piu' alta.
  const fTs = [...famNomi.values()].map(tokDi);
  const forme = String(modello).split('/').map(s => s.trim()).filter(Boolean);
  if (!forme.length) forme.push(String(modello));
  const sqFamPrincipale = squash(nodo.famigliaNome || '');
  let scelta = null;               // { rango, tenute (indici), testaSq | null }
  for (const forma of forme) {
    const nT = tokDi(forma), cnT = contaTok(nT), sqNome = squash(forma);
    let cand = null;
    if (COME_NOME_E_FAMIGLIA.test(nodo.come || '')
      || fTs.some(fT => dentroTok(cnT, contaTok(fT)))
      || [...famNomi.values()].some(f => {
        const sqF = squash(f);
        return sqF === sqNome || (sqF.startsWith(sqNome) && taglioValido(f, sqF, sqNome));
      })) {
      cand = { rango: 0, tenute: voci.map((_, i) => i), testaSq: null };
    }
    if (!cand) {
      const testa = voci.map((v, i) => iniziaCol(sqNome, v.raw, v.sq) ? i : -1).filter(i => i >= 0);
      if (testa.length) cand = { rango: 1, tenute: testa, testaSq: sqNome };
    }
    if (!cand && nodo.come === 'generazione') {
      const gen = voci.map((v, i) => v.inGen ? i : -1).filter(i => i >= 0);
      // solo se filtra davvero: la generazione-secchio («PS 300/350») che tiene tutto
      // non e' un filtro, e il residuo sotto puo' fare di meglio
      if (gen.length && gen.length < voci.length) cand = { rango: 2, tenute: gen, testaSq: null };
    }
    if (!cand) {
      const residuo = diffTok(cnT, contaTok(tokDi(nodo.famigliaNome || '')));
      if (residuo.length) {
        const cr = contaTok(residuo);
        const prese = voci.map((v, i) => dentroTok(cr, contaTok(v.tok)) ? i : -1).filter(i => i >= 0);
        if (prese.length) cand = { rango: 3, tenute: prese, testaSq: null };
      }
    }
    if (!cand && sqNome.startsWith(sqFamPrincipale) && sqNome.length > sqFamPrincipale.length
      && taglioValido(forma, sqNome, sqFamPrincipale)) {
      // il residuo INCOLLATO: «NC700S» = «NC 700» + «s», token esatto e basta
      const resto = sqNome.slice(sqFamPrincipale.length);
      const prese = voci.map((v, i) => v.tok.includes(resto) ? i : -1).filter(i => i >= 0);
      if (prese.length) cand = { rango: 4, tenute: prese, testaSq: null };
    }
    if (cand && (!scelta || cand.rango < scelta.rango)) scelta = cand;
  }
  // niente appiglio: la variante non sta nel catalogo — tendina vuota, non i fratelli
  if (!scelta) return [];

  const conta = new Map();        // norm(allestimento) → { nome, n }
  const intere = new Map();       // il RIPIEGO: versioni intere (senza testa)
  for (const i of scelta.tenute) {
    const { raw, testaMod, testaFam } = voci[i];
    let v = raw;
    // via la testa: quella del NOME quando il filtro e' di testa (cosi' «CLA 200 d
    // Automatic» suggerisce «d Automatic», che accodato a modello «CLA 200» non
    // raddoppia il 200), altrimenti quella del modello/famiglia di catalogo com'era.
    if (scelta.testaSq) {
      const dopo = tagliaTestaSquash(raw, scelta.testaSq);
      if (dopo !== null) v = dopo;
    } else {
      const sv = spazi(v);
      // Il taglio cammina sulle PAROLE VERE consumando i token normalizzati: «X-Bow» e'
      // UNA parola che vale DUE token (x, bow) — contando le parole normalizzate si
      // mangiava anche l'allestimento («X-Bow GT-XR» perdeva pure GT-XR).
      for (const testa of [testaMod, testaFam]) {
        if (!testa || !sv.startsWith(testa + ' ')) continue;
        const parole = v.split(/\s+/);
        let daConsumare = testa.split(' ');
        let consumate = 0;
        for (const w of parole) {
          const tw = spazi(w).split(' ').filter(Boolean);
          if (!tw.length || tw.length > daConsumare.length || !tw.every((x, j) => x === daConsumare[j])) break;
          daConsumare = daConsumare.slice(tw.length);
          consumate++;
          if (!daConsumare.length) break;
        }
        if (!daConsumare.length) { v = parole.slice(consumate).join(' ').trim(); break; }
      }
    }
    // il ripiego si raccoglie SEMPRE: se nessun allestimento sopravvive, meglio le
    // versioni intere che una tendina vuota
    const kIntera = norm(v);
    if (v && kIntera && !intere.has(kIntera)) intere.set(kIntera, { nome: v, n: 1 });
    const a = allestimentoDaVersione(v);
    if (!a) continue;
    const k = norm(a);
    if (!k) continue;
    const voce = conta.get(k);
    if (voce) voce.n++;
    else conta.set(k, { nome: a, n: 1 });
  }
  /**
   * IL RIPIEGO DELLE FAMIGLIE SOLO-MOTORE. La potatura del «motore-e-basta» svuotava la
   * tendina per il 23,5% delle famiglie risolte (misurato: 598 su 2.549 — X-Bow, i-MiEV,
   * 125 STX…), e una tendina sparita e' peggio di una verbosa: se non resta nessun
   * allestimento si suggeriscono le versioni intere, che si digitano comunque.
   */
  const fonte = conta.size ? conta : intere;
  return [...fonte.values()]
    .sort((x, y) => y.n - x.n || x.nome.localeCompare(y.nome, 'it'))
    .map(x => x.nome);
}

module.exports = { versioniDi };
