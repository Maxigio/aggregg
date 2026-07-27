'use strict';
/**
 * PONTE MODELLI → data/ponte-modelli.json (FILE NUOVO. I cataloghi non si toccano.)
 *
 * Quattro relazioni: auto subito↔autoscout, moto subito↔autoscout, moto subito↔motoit,
 * moto autoscout↔motoit.
 *
 * LIVELLI DIVERSI, perche' le fonti li mettono diversi:
 *   AUTO   il nodo Subito e' la FAMIGLIA (99,9% dichiarata dalla fonte), non il modello:
 *          "Fiesta" e' la famiglia, "Fiesta 3ª serie" una sua generazione. Le generazioni
 *          restano dentro la voce: sara' l'anno dell'annuncio a sceglierne una.
 *   MOTO   Subito non ha famiglia: modello contro modello.
 *
 * GRADI, ognuno con la sua prova:
 *   identico    stesso nome normalizzato, uno solo da entrambe le parti
 *   grossolano  N nostri → 1 loro. NON e' un errore: la fonte di destinazione e' meno
 *               granulare (TM "MX 85" e "SMX 85" stanno entrambe sotto Autoscout "85").
 *               E' la risposta giusta a "dove cerco", e il dettaglio si recupera un piano sotto.
 *   fine        1 nostro → N loro: la destinazione e' PIU' granulare. Si tengono tutti.
 *   probabile   un solo candidato per parole/prefisso, con i numeri concordi
 *   assente     nessun candidato: quella fonte non ce l'ha
 *
 * MAI un grado senza prova, e i conti devono tornare (controllo in fondo).
 */
const fs = require('fs');
const R = '/Volumes/MAIN/BananaChePrezzi-main';
const norm = require(R + '/backend/scrapers/brand-match.js').norm;
const S = require(R + '/data/subito-catalogo.json');
const M = require(R + '/data/motoit-catalogo.json');
const A = require(R + '/data/models.json');
const AL = require(R + '/data/brand-aliases.json');
const PM = require(R + '/data/ponte-marche.json');

/**
 * `distribuisce`: RedMoto vende Honda. Restano marche separate — deciso dal proprietario —
 * ma i VEICOLI sono gli stessi, quindi i modelli del distributore vanno confrontati con
 * quelli della casa madre. Senza questo, i 46 modelli di RedMoto, Suzuki Valenti e Honda
 * Dall'Ara sparivano dal ponte in silenzio: non agganciati e nemmeno dichiarati assenti,
 * perche' il costruttore salta le marche che dall'altra parte non esistono.
 * La madre e' quella col catalogo piu' grande: un distributore non e' piu' grande della casa.
 */
const MADRE = { auto: new Map(), moto: new Map() };
for (const tipo of ['auto', 'moto']) {
  const quanti = n => {
    let t = 0;
    for (const b of Object.values(S[tipo])) if (norm(b.nome) === norm(n)) t = Math.max(t, Object.keys(b.modelli || {}).length);
    for (const [nm, b] of Object.entries(A[tipo])) if (norm(nm) === norm(n)) t = Math.max(t, b.models.length);
    return t;
  };
  for (const v of (PM.voci[tipo] || [])) {
    if (v.relazione !== 'distribuisce') continue;
    const madre = quanti(v.a.nome) >= quanti(v.b.nome) ? v.a.nome : v.b.nome;
    const figlio = madre === v.a.nome ? v.b.nome : v.a.nome;
    MADRE[tipo].set(norm(figlio), norm(madre));
  }
}

const capo = { auto: new Map(), moto: new Map() };
for (const t of ['auto', 'moto']) for (const g of (AL[t] || [])) for (const x of g) capo[t].set(norm(x), norm(g[0]));
const K = (t, s) => capo[t].get(norm(s)) || norm(s);

/**
 * Parole di un nome. Si taglia sui separatori E fra lettere e cifre: senza il secondo taglio
 * "F250" resta una parola sola e non incontra mai "250"+"F", e "Dino GT4" non riconosce
 * "GT"+"4". Verificato: 7 errori su 11 nascevano da qui.
 */
const tok = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
  .split(/[^a-z0-9]+/).filter(Boolean);
/** stesse parole, ordine diverso: "TY 125" e "125 TY" sono lo stesso nome. */
const stesseParole = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const sub = (a, b) => a.length && a.length < b.length && a.every(x => b.includes(x));
const numeri = s => new Set((String(s).match(/\d{2,}/g) || []));
function numeriLitigano(a, b) {
  const na = numeri(a), nb = numeri(b);
  if (!na.size || !nb.size) return false;
  for (const x of na) if (nb.has(x)) return false;
  return true;
}

/** nodi di una fonte, raggruppati per marca canonica. Per le auto Subito il nodo e' la famiglia. */
let scartatiPerDoppione = 0;      // doppioni tolti dall'ULTIMA chiamata a nodi()
function nodi(tipo, fonte) {
  scartatiPerDoppione = 0;
  const out = new Map();
  const agg = (marca, v) => { const k = K(tipo, marca); if (!out.has(k)) out.set(k, []); out.get(k).push(v); };
  if (fonte === 'subito') {
    for (const b of Object.values(S[tipo])) {
      if (tipo === 'auto') {
        const fam = new Map();
        for (const [mid, m] of Object.entries(b.modelli || {})) {
          const fid = m.famigliaId || mid, fnome = m.famiglia || m.nome;
          if (!fam.has(fid)) fam.set(fid, { id: fid, nome: fnome, marcaId: b.id, generazioni: [] });
          fam.get(fid).generazioni.push({ id: mid, nome: m.nome, versioni: Object.keys(m.versioni || {}).length });
        }
        for (const f of fam.values()) agg(b.nome, f);
      } else for (const [mid, m] of Object.entries(b.modelli || {}))
        agg(b.nome, { id: mid, nome: m.nome, marcaId: b.id, versioni: Object.keys(m.versioni || {}).length });
    }
  } else if (fonte === 'autoscout') {
    for (const [nm, b] of Object.entries(A[tipo])) for (const m of b.models)
      agg(nm, { id: m.modelIdAS != null ? String(m.modelIdAS) : null, nome: m.nome, mmmv: m.mmmvAutoscout || null });
  } else {
    for (const b of Object.values(M.marche)) for (const [slug, m] of Object.entries(b.modelli || {}))
      agg(b.nome, { id: slug, nome: m.nome, chiave: m.chiave, versioni: Object.keys(m.versioni || {}).length });
  }
  /**
   * Dopo la fusione delle marche due nodi possono avere lo STESSO nome: Nissan e Nissan
   * Spagna portano ciascuna il proprio "Altro modello", Piaggio e Vespa la stessa "Vespa
   * Elettrica". Ne resta uno solo — il piu' ricco — altrimenti lo stesso veicolo verrebbe
   * agganciato due volte e i conti direbbero il falso.
   */
  const peso = x => (x.generazioni ? x.generazioni.length : 0) + (x.versioni || 0) + (x.id ? 1 : 0);
  for (const [k, lista] of out) {
    const perNome = new Map();
    for (const v of lista) {
      const n = norm(v.nome);
      const gia = perNome.get(n);
      if (!gia || peso(v) > peso(gia)) perNome.set(n, v);
    }
    if (perNome.size !== lista.length) { scartatiPerDoppione += lista.length - perNome.size; out.set(k, [...perNome.values()]); }
  }
  return out;
}

/**
 * ECCEZIONI verificate a mano il 27 luglio, dopo che 12 revisori hanno passato uno per uno
 * i 544 agganci probabili. Sono i casi in cui due nomi si somigliano davvero ma indicano
 * veicoli diversi: nessuna regola puo' distinguerli, perche' la differenza non e' nel nome.
 * `a: null` vuol dire "quella fonte non ce l'ha", ed e' una risposta, non una rinuncia.
 */
const ECCEZIONI = [
  { tipo: 'auto', da: 'subito', a: 'autoscout', marca: 'ferrari', nome: '849 Testarossa', verso: null,
    perche: 'la Testarossa in catalogo e\' quella storica (1984-96); la 849 e\' del 2025, altra vettura' },
  { tipo: 'auto', da: 'subito', a: 'autoscout', marca: 'ferrari', nome: 'Daytona SP3', verso: null,
    perche: 'la Daytona in catalogo e\' la 365 GTB/4; la SP3 e\' una serie speciale del 2022, altra vettura' },
  { tipo: 'moto', da: 'subito', a: 'motoit', marca: 'piaggio', nome: 'Vespa 50 S (V5SA1)', verso: null,
    perche: 'la sigla telaio V5SA1 e\' la 50 S d\'epoca; "S 50" nel catalogo di arrivo e\' la S moderna' },
  { tipo: 'moto', da: 'subito', a: 'motoit', marca: 'sym', nome: 'Maxsym TL 500', verso: null,
    perche: 'il TL e\' il tre ruote basculante: "Maxsym 500" e\' il due ruote, e il "Maxsym TL 508" '
      + 'esiste gia\' su entrambe le fonti ed e\' agganciato al suo omonimo' },
];
const eccezioneDi = (tipo, fa, fb, marca, nome) => ECCEZIONI.find(e =>
  e.tipo === tipo && e.da === fa && e.a === fb && e.marca === marca && e.nome === nome);
const eccezioniUsate = new Set();

const RELAZIONI = [['auto', 'subito', 'autoscout'], ['moto', 'subito', 'autoscout'],
                   ['moto', 'subito', 'motoit'], ['moto', 'autoscout', 'motoit']];

const fuori = {
  generatoIl: new Date().toISOString(),
  nota: 'Ponte a livello MODELLO. Costruito dai cataloghi senza modificarli. Ogni voce porta il '
    + 'grado e la prova. `grossolano` non e\' un errore: la fonte di arrivo e\' meno granulare, '
    + 'e piu\' nostri nodi finiscono legittimamente sullo stesso loro nodo.',
  gradi: {
    identico: 'stesso nome, uno solo da entrambe le parti',
    grossolano: 'piu\' nostri nodi → un loro nodo (loro meno granulari)',
    fine: 'un nostro nodo → piu\' loro nodi (loro piu\' granulari)',
    probabile: 'unico candidato per parole o prefisso, numeri concordi',
    assente: 'nessun candidato in quella fonte',
  },
  relazioni: [],
};

const problemi = [];
for (const [tipo, fa, fb] of RELAZIONI) {
  // l'ordine conta: nodi() azzera il contatore, quindi si legge subito dopo la chiamata
  // sull'ORIGINE, che e' quella su cui il conto deve tornare.
  const NA = nodi(tipo, fa);
  const doppioniOrigine = scartatiPerDoppione;
  const NB = nodi(tipo, fb);
  const voci = [], assenti = [];
  const conta = { identico: 0, grossolano: 0, fine: 0, probabile: 0, assente: 0 };
  let marche = 0, nodiTot = 0;
  for (const [marca, listaA] of NA) {
    const viaMadre = !NB.get(marca) && MADRE[tipo].get(marca);
    const listaB = NB.get(marca) || (viaMadre ? NB.get(viaMadre) : null);
    if (!listaB) {
      // marca senza corrispondente: i suoi nodi vanno DICHIARATI assenti, non taciuti.
      for (const a of listaA) { nodiTot++; conta.assente++; assenti.push({ marca, nome: a.nome, id: a.id, perche: 'marca senza corrispondente in ' + fb }); }
      continue;
    }
    marche++;
    const perNome = new Map();
    for (const b of listaB) { const k = norm(b.nome); if (!perNome.has(k)) perNome.set(k, []); perNome.get(k).push(b); }
    // primo giro: candidati
    const grezzi = listaA.map(a => {
      nodiTot++;
      const k = norm(a.nome);
      if (perNome.has(k)) return { a, b: perNome.get(k), come: 'nome identico' };
      const ta = tok(a.nome);
      // stesse parole in ordine diverso = stesso nome, non un candidato fra i tanti
      const riordinati = listaB.filter(b => stesseParole(ta, tok(b.nome)));
      if (riordinati.length) return { a, b: riordinati, come: 'stesse parole, ordine diverso' };
      let cand = listaB.filter(b => !numeriLitigano(a.nome, b.nome)
        && (sub(ta, tok(b.nome)) || sub(tok(b.nome), ta)
            || (k.length >= 3 && norm(b.nome).startsWith(k)) || (norm(b.nome).length >= 3 && k.startsWith(norm(b.nome)))));
      /**
       * Fra piu' candidati validi vince quello che condivide PIU' PAROLE, non il primo che
       * passa il filtro. "Dino 208 GT/4" aveva sia "208" (una parola, per giunta un numero)
       * sia "Dino GT4" (due): la regola vecchia prendeva "208". Verificato su 544 agganci:
       * 7 errori su 11 nascevano tutti qui.
       */
      if (cand.length > 1) {
        const parole = b => tok(b.nome).filter(x => ta.includes(x)).length;
        const alfa = b => tok(b.nome).filter(x => ta.includes(x) && /[a-z]/.test(x)).length;
        const max = Math.max(...cand.map(parole));
        const maxAlfa = Math.max(...cand.map(alfa));
        // se l'origine ha parole vere, un candidato di sole cifre non compete
        const buoni = cand.filter(b => parole(b) === max && (maxAlfa === 0 || alfa(b) === maxAlfa));
        if (buoni.length) cand = buoni;
      }
      return { a, b: cand, come: cand.length ? 'parole o prefisso' : null };
    });
    // secondo giro: quanti nostri puntano allo stesso loro nodo → grossolano
    const quanti = new Map();
    for (const g of grezzi) if (g.b.length === 1) quanti.set(g.b[0].nome, (quanti.get(g.b[0].nome) || 0) + 1);
    for (const g of grezzi) {
      const ecc = eccezioneDi(tipo, fa, fb, marca, g.a.nome);
      if (ecc) {
        eccezioniUsate.add(ecc.nome);
        if (!ecc.verso) { conta.assente++; assenti.push({ marca, nome: g.a.nome, id: g.a.id, perche: ecc.perche, eccezione: true }); continue; }
        const b = listaB.find(x => x.nome === ecc.verso);
        if (!b) { problemi.push('eccezione ' + ecc.nome + ': bersaglio "' + ecc.verso + '" inesistente'); continue; }
        conta.probabile++;
        voci.push({ marca, grado: 'eccezione', prova: 'verificato a mano: ' + ecc.perche,
          da: { fonte: fa, id: g.a.id, nome: g.a.nome }, a: [{ fonte: fb, id: b.id, nome: b.nome }] });
        continue;
      }
      if (!g.b.length) { conta.assente++; assenti.push({ marca, nome: g.a.nome, id: g.a.id }); continue; }
      let grado;
      if (g.b.length > 1) grado = 'fine';
      else if (quanti.get(g.b[0].nome) > 1) grado = 'grossolano';
      else grado = (g.come === 'nome identico' || g.come === 'stesse parole, ordine diverso') ? 'identico' : 'probabile';
      conta[grado]++;
      voci.push({
        marca, grado, ...(viaMadre ? { viaCasaMadre: viaMadre } : {}), prova: g.come + (grado === 'grossolano' ? ' · loro meno granulari: ' + quanti.get(g.b[0].nome) + ' nostri qui' : ''),
        da: { fonte: fa, id: g.a.id, nome: g.a.nome, ...(g.a.generazioni ? { generazioni: g.a.generazioni } : {}) },
        a: g.b.map(b => ({ fonte: fb, id: b.id, nome: b.nome, ...(b.mmmv ? { mmmv: b.mmmv } : {}), ...(b.chiave ? { chiave: b.chiave } : {}) })),
      });
    }
  }
  const somma = Object.values(conta).reduce((s, x) => s + x, 0);
  if (somma !== nodiTot) problemi.push(tipo + ' ' + fa + '→' + fb + ': ' + somma + ' classificati ma ' + nodiTot + ' nodi');
  if (voci.length + conta.assente !== nodiTot) problemi.push(tipo + ' ' + fa + '→' + fb + ': voci+assenti non torna');
  fuori.relazioni.push({ tipo, da: fa, a: fb, marcheInComune: marche, nodiEsaminati: nodiTot,
    nodiScartatiPerDoppione: doppioniOrigine, conta, voci, assenti });
}

// Ogni eccezione decisa a mano DEVE essere stata applicata: se un nome cambia nel catalogo
// e l'eccezione non aggancia piu' niente, va saputo subito, non scoperto fra sei mesi.
for (const e of ECCEZIONI) if (!eccezioniUsate.has(e.nome)) problemi.push('ECCEZIONE MAI APPLICATA: ' + e.marca + ' "' + e.nome + '"');
if (problemi.length) { console.error('CONTI CHE NON TORNANO — non scrivo:'); problemi.forEach(x => console.error('  ' + x)); process.exit(1); }

console.log('relazione'.padEnd(26) + 'marche  nodi  ident.  gross.   fine  probab.  assenti');
for (const r of fuori.relazioni) {
  const c = r.conta;
  console.log((r.tipo + ' ' + r.da + '→' + r.a).padEnd(26)
    + String(r.marcheInComune).padStart(6) + String(r.nodiEsaminati).padStart(6)
    + String(c.identico).padStart(8) + String(c.grossolano).padStart(8) + String(c.fine).padStart(7)
    + String(c.probabile).padStart(9) + String(c.assente).padStart(9));
}
const T = fuori.relazioni.reduce((s, r) => ({
  agganci: s.agganci + r.voci.length, assenti: s.assenti + r.conta.assente,
}), { agganci: 0, assenti: 0 });
console.log('\nagganci scritti: ' + T.agganci + ' · assenti dichiarati: ' + T.assenti);

const F = R + '/data/ponte-modelli.json';
fs.writeFileSync(F, JSON.stringify(fuori, null, 1));
console.log('scritto ' + F + '  (' + (fs.statSync(F).size / 1048576).toFixed(1) + ' MB)');
