#!/usr/bin/env node
'use strict';
/**
 * IL MOZZO: un albero a TRE livelli, e ogni fonte ci si aggancia dichiarando a che livello sta
 * DA LEI. Genera data/catalogo-livelli.json.
 *
 *   1  marca      Ford                  Mini                    Ducati
 *   2  modello    Fiesta                Cooper D Countryman     Monster 696
 *   3  versione   1.2i 16V 5 porte      1.6 ALL4                696 ABS
 *
 * Su Mini il modello NON e' "Mini": marca e modello uguali non vogliono dire niente, ed e' quello
 * che usciva finche' il nome canonico lo ricavavo solo da Subito. Li' il modello lo nomina
 * Autoscout, e Subito lo scrive dentro la versione — vedi il Passo 0.
 *
 * LA GENERAZIONE NON E' UN LIVELLO. Ci ero cascato: Subito chiama i suoi modelli "Fiesta 6ª
 * serie", "Fiesta 7ª serie", e avevo letto quei quattro id come un piano intermedio fra Fiesta e
 * la versione. Non lo sono: sono quattro modi di nominare LO STESSO livello, con la generazione
 * appiccicata all'etichetta. Lo dice Moto.it, che e' la fonte piu' pulita che abbiamo:
 *
 *   MODELLO  C 400 GT
 *    versione  C 400 GT (2019 - 20) · C 400 GT (2021 - 24) · C 400 GT (2025 - 26)
 *
 * tre versioni con lo stesso nome e tre intervalli di anni: la generazione e' un ATTRIBUTO
 * (gli anni), non un piano.
 *
 * IL PUNTO DIFFICILE, ed e' il motivo per cui questo file esiste: IL LIVELLO NON E' UNA
 * PROPRIETA' DELLA COSA, E' UNA PROPRIETA' DELLA FONTE.
 *
 *   "Cooper D"  per Autoscout e' un MODELLO, con id suo (modelIdAS=19744)
 *               per Subito e' una VERSIONE, dentro il modello "Mini 3ª serie (R56)"
 *
 * Nessuna delle due sbaglia: si sono organizzate diversamente. Misurato sulle marche raccolte,
 * su 1.616 voci giudicabili un TERZO non concorda fra le due fonti. Quindi qui non si decide
 * chi ha ragione: ogni riferimento porta con se' `livelloFonte`, cioe' a che altezza sta da lei.
 * Senza quel campo, un giorno si chiede ad Autoscout la versione "Cooper D" e lui non la trova,
 * perche' per lui e' un modello.
 *
 * STESSO NODO ANCHE QUANDO LE FONTI DISSENTONO. Un annuncio Autoscout con modello "Cooper D" e
 * uno Subito con modello "Mini 3ª serie" + versione "Cooper D" sono la stessa automobile, e il
 * concessionario le deve vedere insieme: finiscono sotto lo stesso nodo, col salto di piano
 * scritto accanto.
 *
 * NON INVENTA NIENTE. Dove manca l'informazione per collocare qualcosa, resta dov'e' con
 * `daRivedere` e si conta nel riepilogo. Meglio un albero con buchi dichiarati che uno pieno di
 * nodi indovinati.
 *
 * Uso:  node scripts/build-catalogo-livelli.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const RADICE = path.join(__dirname, '..');
const bm = require(path.join(RADICE, 'backend', 'scrapers', 'brand-match'));
const norm = bm.norm;
const leggi = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(RADICE, 'data', f), 'utf8')); } catch (_) { return d; } };

const MODELS = leggi('models.json', { auto: {}, moto: {} });
const GRUPPI = leggi('model-groups.json', { auto: {}, moto: {} });
const SUBITO = leggi('subito-modelli.json', { auto: {}, moto: {} });
const SUBITO_KO = leggi('subito-modelli-da-rivedere.json', { auto: [], moto: [] });
const OUT = path.join(RADICE, 'data', 'catalogo-livelli.json');

/** La generazione che Subito appiccica in coda: "Fiesta 6ª serie" → "Fiesta". */
// Una sola implementazione, condivisa col runtime: prima questo script e quello gemello
// ne avevano una a testa, e la copia che girava in produzione era la piu' debole delle tre.
const { senzaGenerazione } = require('../backend/nomi-modello');

/** Gli anni dichiarati dentro un'etichetta: "(2021 - 24)", "'13-'25", "01-08". Attributo, non livello. */
function anniDa(nome) {
  const m = String(nome || '').match(/'?((?:19|20)?\d{2})\s*[-–]+>?\s*'?((?:19|20)?\d{2})?/);
  if (!m) return null;
  const pieno = a => (a == null ? null : (Number(a) > 99 ? Number(a) : Number(a) + (Number(a) > 50 ? 1900 : 2000)));
  const da = pieno(m[1]), a = pieno(m[2]);
  return da ? { da, a: a || null } : null;
}

/** Il testo con dentro il nome, a PAROLA INTERA: "Mini 1.6 Cooper D" contiene "Cooper D". */
const parole = s => ' ' + String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const contiene = (testo, nome) => parole(testo).includes(parole(nome));

// ─── Costruzione ─────────────────────────────────────────────────────────────
const conta = {
  marche: 0, modelli: 0, versioni: 0,
  saltoDiPiano: 0,          // modello per una fonte, versione per un'altra
  soloAutoscout: 0, soloSubito: 0, condivisi: 0,
  nomeDegenere: 0, degenereSenzaAggancio: 0,   // Subito nomina il modello come la marca (Mini)
  saltoAltroModello: 0,
  daRivedere: 0,
};

function costruisci(tipo) {
  const fuori = {};
  const subitoTipo = SUBITO[tipo] || {};
  const gruppiTipo = GRUPPI[tipo] || {};

  for (const [marca, e] of Object.entries(MODELS[tipo] || {})) {
    conta.marche++;
    const modelli = {};                       // nome canonico → nodo modello

    /** Il nodo modello, creato alla prima richiesta. */
    const nodoModello = nome => (modelli[nome] || (modelli[nome] = {
      fonti: { autoscout: [], subito: [], motoit: [] },
      versioni: {},
    }));

    // ── Passo 0. I modelli secondo AUTOSCOUT vengono creati per primi, perche' su certe marche
    //    sono gli UNICI a nominare il modello. Su Mini, Subito chiama il suo livello 2
    //    "Mini 3ª serie": togliendo la generazione resta "Mini", che e' la MARCA — cioe' Subito
    //    il modello non lo nomina affatto. Li' il nome ce l'ha solo Autoscout ("Cooper D",
    //    "Cooper S Countryman"), e sta scritto dentro la stringa di versione di Subito
    //    ("Mini 1.6 Cooper D Countryman"). Chi nomina, nomina: non si inventa un nodo "Mini"
    //    dentro la marca Mini, che non vuol dire niente.
    const perNomeAS = new Map();
    for (const m of (e.models || [])) {
      const n = nodoModello(m.nome);
      n.fonti.autoscout.push({
        id: m.modelIdAS || null, nome: m.nome, livelloFonte: 'modello',
        mmmv: m.mmmvAutoscout || null, lineId: m.modelLineIdAS || null,
      });
      if (m.slugMotoIt) n.fonti.motoit.push({ slug: m.slugMotoIt, nome: m.nome, livelloFonte: 'modello' });
      perNomeAS.set(norm(m.nome), m.nome);
    }
    // I nomi Autoscout dal piu' lungo al piu' corto: "Cooper D Countryman" prima di "Cooper D",
    // o dentro una versione si aggancerebbe sempre il piu' generico.
    const nomiAS = (e.models || []).map(m => m.nome).sort((a, b) => b.length - a.length);

    // ── Passo 1. I modelli secondo SUBITO: il nome senza generazione e' il nome canonico,
    //    e ogni id Subito che ci finisce sotto porta i suoi anni come attributo.
    const subitoQui = [];
    for (const [id, s] of Object.entries(subitoTipo)) {
      if (norm(s.marca) === norm(marca)) subitoQui.push({ id, ...s, daRivedere: false });
    }
    for (const x of (SUBITO_KO[tipo] || [])) {
      if (norm(x.marca) === norm(marca)) subitoQui.push({ ...x, daRivedere: true });
    }
    for (const s of subitoQui) {
      const canonico = senzaGenerazione(s.nome) || s.nome;
      // Il nome degenera nella marca: Subito qui il modello non lo nomina. Le sue versioni si
      // appendono al modello AUTOSCOUT che sta scritto dentro la stringa di versione.
      const degenere = norm(canonico) === norm(marca);
      if (degenere) {
        conta.nomeDegenere++;
        for (const [vid, v] of Object.entries(s.versioni || {})) {
          const hit = nomiAS.find(x => contiene(v.nome, x));
          const dove = hit ? nodoModello(hit) : nodoModello(canonico);   // senza aggancio resta li', marcato
          if (!hit) conta.degenereSenzaAggancio++;
          const vn = dove.versioni[v.nome] || (dove.versioni[v.nome] = { fonti: { autoscout: [], subito: [], motoit: [] }, anni: anniDa(v.nome) });
          vn.fonti.subito.push({
            id: vid, nome: v.nome, livelloFonte: 'versione', annunci: v.annunci || 0,
            sottoModelloSubito: { id: s.id, nome: s.nome, anni: anniDa(s.nome) },
            ...(hit ? {} : { daRivedere: true }),
          });
          conta.versioni++;
        }
        continue;
      }
      const n = nodoModello(canonico);
      n.fonti.subito.push({
        id: s.id, nome: s.nome, livelloFonte: 'modello',
        anni: anniDa(s.nome), annunci: s.annunci || 0,
        ...(s.daRivedere ? { daRivedere: true } : {}),
      });
      if (s.daRivedere) conta.daRivedere++;
      // ── Le VERSIONI che Subito porta sotto quel modello.
      for (const [vid, v] of Object.entries(s.versioni || {})) {
        const nomeV = v.nome;
        const vn = n.versioni[nomeV] || (n.versioni[nomeV] = { fonti: { autoscout: [], subito: [], motoit: [] }, anni: anniDa(nomeV) });
        vn.fonti.subito.push({ id: vid, nome: nomeV, livelloFonte: 'versione', annunci: v.annunci || 0 });
        conta.versioni++;
      }
    }

    // ── Passo 2. Il SALTO DI PIANO. Un modello Autoscout che compare anche dentro una versione
    //    di Subito e' la stessa cosa vista a due altezze diverse: si annota sulla versione, senza
    //    togliere il nodo modello — le due fonti restano interrogabili ognuna al suo livello.
    for (const [nomeMod, n] of Object.entries(modelli)) {
      for (const [nomeV, vn] of Object.entries(n.versioni)) {
        if (vn.fonti.autoscout.length) continue;
        // IL PIU' LUNGO CHE CI STA DENTRO, senza escludere niente. `nomiAS` e' gia' ordinato dal
        // piu' lungo, quindi il primo che combacia e' quello giusto:
        //   "Mini 1.6 16V Cooper D"     → Cooper D (19744), non Cooper (16603)
        //   "Mini 2.0 Cooper S Clubman" → Cooper S Clubman (20005)
        // Avevo provato a escludere i candidati contenuti nel nome del modello, per non agganciare
        // "Cooper" sotto il nodo "Cooper D". Era sbagliato due volte: Cooper e Cooper D sono due
        // auto diverse — benzina e diesel — non lo stesso nome scritto piu' corto; e soprattutto
        // il difetto vero era che ESCLUDEVO la risposta giusta, cioe' "Cooper D" stesso, e mi
        // restava in mano il primo candidato sbagliato.
        const hit = nomiAS.find(x => contiene(nomeV, x));
        if (!hit) continue;
        const m = (e.models || []).find(y => y.nome === hit);
        // Due casi, e vanno distinti perche' vogliono dire cose diverse:
        //   - il piu' lungo E' il nodo in cui siamo → Autoscout conferma questo modello, e lo
        //     tratta come modello mentre Subito lo tratta come versione. E' il caso normale.
        //   - il piu' lungo e' un ALTRO modello → la versione Subito nomina un modello diverso
        //     da quello sotto cui sta ("156" con dentro "Sportwagon"). Va guardato.
        const suo = norm(hit) === norm(nomeMod);
        vn.fonti.autoscout.push({
          id: m.modelIdAS || null, nome: hit, livelloFonte: 'modello',
          saltoDiPiano: 'per Autoscout e\' un modello, per Subito una versione',
          ...(suo ? {} : { altroModello: 'la versione nomina un modello diverso dal nodo: ' + nomeMod }),
        });
        conta.saltoDiPiano++;
        if (!suo) conta.saltoAltroModello++;
      }
    }
    for (const [nome, n] of Object.entries(modelli)) {
      if (n.fonti.autoscout.length && n.fonti.subito.length) conta.condivisi++;
      else if (n.fonti.autoscout.length) conta.soloAutoscout++;
    }

    // ── Passo 3. I gruppi curati a mano (BMW, Mercedes) restano come ALIAS di ricerca, non
    //    come livello: "Serie 3" e' il nome canonico che raccoglie 316/318/320, e quelli sono
    //    versioni per noi anche se Autoscout li chiama modelli. Si dichiara e basta.
    const alias = {};
    for (const [serie, membri] of Object.entries(gruppiTipo[marca] || {})) alias[serie] = membri;

    conta.modelli += Object.keys(modelli).length;
    for (const n of Object.values(modelli)) if (!n.fonti.autoscout.length && n.fonti.subito.length) conta.soloSubito++;
    for (const n of Object.values(modelli)) conta.versioniNodi = (conta.versioniNodi || 0) + Object.keys(n.versioni).length;

    fuori[marca] = {
      fonti: {
        autoscout: e.autoscout ? { makeId: e.autoscout.makeId, slug: e.autoscout.slugAS, annunci: e.autoscout.totalAnnunci } : null,
        motoit: e.motoit ? { brandSlug: e.motoit.brandSlug } : null,
        subito: subitoQui.length ? { visto: true } : null,
      },
      siti: e.sites || [],
      ...(Object.keys(alias).length ? { aliasRicerca: alias } : {}),
      modelli,
    };
  }
  return fuori;
}

const albero = { auto: costruisci('auto'), moto: costruisci('moto') };

// ─── Guardie ─────────────────────────────────────────────────────────────────
const attesi = Object.keys(MODELS.auto || {}).length + Object.keys(MODELS.moto || {}).length;
if (conta.marche !== attesi) throw new Error(`marche ${conta.marche} contro ${attesi} attese: non scrivo`);
if (!conta.modelli) throw new Error('nessun modello: non scrivo');

const fuori = {
  generatedAt: new Date().toISOString(),
  livelli: ['marca', 'modello', 'versione'],
  nota: 'Tre livelli. La generazione NON e\' un livello: e\' il campo `anni`. Ogni riferimento a '
    + 'una fonte porta `livelloFonte`, cioe\' a che livello quella cosa sta PER QUELLA FONTE: '
    + '"Cooper D" e\' un modello per Autoscout e una versione per Subito, e finiscono comunque '
    + 'nello stesso nodo con `saltoDiPiano` scritto accanto. `aliasRicerca` sono i gruppi curati '
    + '(Serie 3 → 316/318/320): servono a cercare, non sono un piano dell\'albero.',
  conta,
  auto: albero.auto,
  moto: albero.moto,
};

console.log('marche ' + conta.marche + ' · modelli ' + conta.modelli + ' · versioni ' + conta.versioni);
console.log('  concordi fra Autoscout e Subito  ' + conta.condivisi);
console.log('  SALTO DI PIANO (modello AS = versione Subito)  ' + conta.saltoDiPiano + ' · di cui verso un ALTRO modello ' + conta.saltoAltroModello);
console.log('  solo Autoscout ' + conta.soloAutoscout + ' · solo Subito ' + conta.soloSubito);
console.log('  nome Subito degenere (== marca) ' + conta.nomeDegenere + ' · di cui senza aggancio Autoscout ' + conta.degenereSenzaAggancio);
console.log('  id Subito ancora da rivedere ' + conta.daRivedere);

if (process.argv.includes('--dry')) { console.log('--dry: niente scritto'); process.exit(0); }
fs.writeFileSync(OUT, JSON.stringify(fuori, null, 1) + '\n');
console.log('scritto ' + path.relative(RADICE, OUT));
