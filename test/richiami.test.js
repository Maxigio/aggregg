'use strict';
/**
 * Richiami di sicurezza (Safety Gate UE).
 *
 * Si difendono tre cose diverse: il PARSING dell'XML della Commissione, l'INTEGRITA' dell'archivio
 * generato, e soprattutto l'ONESTA' della ricerca — che su questa fonte e' il punto delicato,
 * perche' marca e modello sono testo libero e un confronto troppo largo produce falsi allarmi su
 * un dato di sicurezza.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const sg = require('../backend/scrapers/safety-gate');
const rica = require('../backend/richiami-route');

const XML = fs.readFileSync(path.join(__dirname, 'fixtures', 'safety-gate-report.xml'), 'utf8');
const LISTA = fs.readFileSync(path.join(__dirname, 'fixtures', 'safety-gate-lista.xml'), 'utf8');

// ─── Parsing ─────────────────────────────────────────────────────────────────
test('elenco settimanale: si legge la data e si ripulisce l\'URL', () => {
  const e = sg._elencoDaXml(LISTA);
  assert.ok(e.length >= 3);
  assert.match(e[0].reference, /^Report-\d{4}-\d+$/);
  assert.match(e[0].data, /^\d{2}\/\d{2}\/\d{4}$/);
  // Nella lista l'URL finisce con una virgola di troppo: se finisse nell'id, la richiesta fallirebbe.
  for (const r of e) assert.match(r.id, /^\d+$/, 'l\'id deve essere solo cifre');
});

test('dal report si prendono SOLO le allerte veicolo', () => {
  const v = sg._veicoliDaReport(XML, { report: 'x' });
  assert.ok(v.length > 0);
  for (const a of v) assert.match(a.categoria, /veicoli a motore/i);
  // Il report settimanale mescola veicoli, giocattoli, cosmetici, attrezzature: se il filtro
  // saltasse, finirebbero tutti fra i richiami auto. La fixture ne contiene apposta di altre.
  const totali = (XML.match(/<notifications\b/g) || []).length;
  assert.ok(totali > v.length, `la fixture deve contenere anche notifiche NON veicolo (${totali} totali, ${v.length} veicolo)`);
  const altre = [...XML.matchAll(/<category>([\s\S]*?)<\/category>/g)]
    .map(m => sg._cdata(m[1])).filter(c => !/veicoli a motore/i.test(c));
  assert.ok(altre.length >= 1, 'servono categorie diverse per provare il filtro: ' + altre.join(', '));
});

test('una allerta porta tutto quello che la fonte serve', () => {
  const v = sg._veicoliDaReport(XML, { report: 'x' });
  const a = v.find(x => x.marca === 'Kia') || v[0];
  for (const c of ['caso', 'categoria', 'prodotto', 'nome', 'rischio', 'livello', 'difetto', 'misure', 'descrizione', 'paeseNotifica', 'paeseOrigine', 'scheda']) {
    assert.ok(a[c], 'manca il campo ' + c);
  }
  assert.ok(Array.isArray(a.foto), 'le foto sono un elenco');
  assert.ok(Array.isArray(a.modelli) && a.modelli.length, 'i modelli sono spezzati');
  assert.ok(Array.isArray(a.marche), 'anche le marche sono spezzate');
  // Il CDATA va tolto: se restasse, i testi arriverebbero in interfaccia con "<![CDATA[" davanti.
  assert.doesNotMatch(JSON.stringify(a), /CDATA/);
});

test('type_numberOfModel: si distingue l\'omologazione vera dal nome commerciale', () => {
  // E' un campo LIBERO: contiene omologazioni ("e1*2018/858*00039*00*10") accanto a nomi ("K4") e
  // a codici interni. Dirlo permette all'interfaccia di proporre il confronto col libretto solo
  // dove ha senso, invece di far cercare "K4" sulla carta di circolazione.
  const vero = sg._omologazioniDa('e1*2018/858*00039*00*10, e1*2018/858*00040*00*10');
  assert.strictEqual(vero.haOmologazione, true);
  assert.strictEqual(vero.omologazioni.length, 2);
  const falso = sg._omologazioniDa('K4');
  assert.strictEqual(falso.haOmologazione, false);
  assert.deepStrictEqual(falso.tutte, ['K4'], 'il valore grezzo si conserva comunque');
  const misto = sg._omologazioniDa('NXN, NRN, e5*2018/858*00191*01-*03');
  assert.deepStrictEqual(misto.omologazioni, ['e5*2018/858*00191*01-*03']);
  assert.strictEqual(misto.tutte.length, 3);
  assert.strictEqual(sg._omologazioniDa(null).haOmologazione, false);
});

test('il nome porta piu modelli in una riga sola, e si spezzano', () => {
  // Caso reale della fonte: una allerta VW che copre sette modelli separati da virgole e da "+".
  const m = sg._modelliDa('Beetle, New Beetle, EOS + EOS GP, Fox, Golf A6 + Cabrio + Plus');
  assert.ok(m.includes('Beetle') && m.includes('Golf A6') && m.includes('EOS'));
  assert.ok(!m.includes(''), 'niente pezzi vuoti');
  // Gli spazi in testa e in coda della fonte non devono sopravvivere.
  assert.deepStrictEqual(sg._modelliDa(' Ducato NG'), ['Ducato NG']);
  assert.deepStrictEqual(sg._modelliDa(null), []);
});

test('anni di produzione: si tiene la finestra, non il giorno', () => {
  assert.deepStrictEqual(sg._anniDa('29.09.2025 - 05.10.2025'), { da: 2025, a: 2025 });
  assert.deepStrictEqual(sg._anniDa('08.08.2024 - 19.02.2026'), { da: 2024, a: 2026 });
  assert.strictEqual(sg._anniDa(''), null);
  assert.strictEqual(sg._anniDa(null), null);
});

// ─── Ricerca: la parte che deve essere onesta ────────────────────────────────
test('il confronto e a parola INTERA, non a sottostringa', () => {
  // Su un dato di sicurezza un falso positivo e' peggio di un buco: se "Golf" agganciasse
  // "Golfino", il concessionario vedrebbe richiami che non lo riguardano e smetterebbe di fidarsi.
  assert.strictEqual(rica._combacia(['Golf A6', 'Cabrio'], 'Golf'), true);
  assert.strictEqual(rica._combacia(['Golfino'], 'Golf'), false);
  assert.strictEqual(rica._combacia(['Panda'], 'panda'), true, 'maiuscole irrilevanti');
  assert.strictEqual(rica._combacia(['Plus'], 'Golf'), false);
  assert.strictEqual(rica._combacia([], 'Golf'), false);
  assert.strictEqual(rica._combacia(['Golf'], ''), false, 'una ricerca vuota non aggancia tutto');
});

test('la sigla VW e il nome esteso pescano le stesse allerte', () => {
  // Misurato sull'archivio: "VW" 33 volte contro "Volkswagen" 3. Senza equivalenza, cercare per
  // nome esteso ne perdeva 33 su 38.
  assert.strictEqual(rica._combaciaMarca(['VW'], 'Volkswagen'), true);
  assert.strictEqual(rica._combaciaMarca(['Volkswagen'], 'VW'), true);
  assert.strictEqual(rica._combaciaMarca(['Volvo'], 'Volkswagen'), false, 'non si confondono marche diverse');
});

test('il campo marca puo portarne piu di una, e si cercano tutte', () => {
  // "Opel/Vauxhall" e' una voce sola nella fonte ma sono due marche.
  assert.strictEqual(rica._combaciaMarca(['Opel', 'Vauxhall'], 'Vauxhall'), true);
  assert.strictEqual(rica._combaciaMarca(['MAN', 'Neoplan', 'Man'], 'Neoplan'), true);
});

// ─── L'archivio generato ─────────────────────────────────────────────────────
const D = rica._dati;
const seArchivio = { skip: D ? false : 'archivio non costruito (lancia scripts/build-safety-gate.js)' };

test('archivio: allerte con i campi minimi e la fonte citata', seArchivio, () => {
  assert.ok(D.allerte.length > 100, `attese molte allerte, trovate ${D.allerte.length}`);
  assert.ok(D.fonte && D.fonte.portale.startsWith('https://'), 'la fonte va citata col link');
  assert.match(D.avvertenza, /omologazione|telaio/i, 'l\'avvertenza sul limite deve esserci');
  for (const a of D.allerte.slice(0, 50)) {
    assert.ok(a.caso, 'ogni allerta ha un numero di caso');
    assert.match(a.categoria, /veicoli a motore/i);
    assert.ok(a.difetto, 'senza la descrizione del difetto l\'allerta non serve a niente');
  }
  // Il numero di caso e' univoco: la deduplica fra report e addendum deve aver funzionato.
  const casi = D.allerte.map(a => a.caso);
  assert.strictEqual(new Set(casi).size, casi.length, 'casi duplicati nell\'archivio');
});

test('archivio: il numero accanto alla marca e quello che si ottiene cliccandola', seArchivio, () => {
  // Prima l'elenco veniva dal campo grezzo: "Volkswagen" figurava con 3 allerte ma la ricerca ne
  // restituiva 38, perche' le altre stavano sotto "VW". Il conteggio ora esce dalla stessa
  // funzione che serve la ricerca.
  const M = rica._marche;
  assert.ok(M.length > 50);
  const storte = M.filter(x => rica.cerca({ marca: x.nome }).totale !== x.allerte);
  assert.deepStrictEqual(storte, [], 'conteggi che non corrispondono alla ricerca');
});

test('archivio: cercare per modello restringe davvero', seArchivio, () => {
  const marca = rica._marche[0].nome;
  const tutte = rica.cerca({ marca });
  const conModello = rica.cerca({ marca, modello: 'modello-che-non-esiste-xyz' });
  assert.ok(tutte.totale > 0);
  assert.strictEqual(conModello.totale, 0, 'un modello inventato non deve agganciare niente');
});

test('archivio: senza finestra di produzione l\'anno non esclude', seArchivio, () => {
  // L'assenza del dato non e' una prova d'innocenza: se la fonte non dice gli anni, l'allerta
  // resta visibile invece di sparire silenziosamente da una ricerca per anno.
  const senzaAnni = D.allerte.filter(a => !a.anni);
  if (!senzaAnni.length) return;
  const a = senzaAnni[0];
  const r = rica.cerca({ marca: a.marca, anno: 1998 });
  assert.ok(r.allerte.some(x => x.caso === a.caso), 'un\'allerta senza anni non va esclusa');
});

test('ricerca senza archivio: risponde ok:false col motivo, non finge', () => {
  // Se il file non c'e', si dice perche' e come costruirlo invece di restituire zero risultati
  // che sembrerebbero "nessun richiamo".
  if (D) return;
  const r = rica.cerca({ marca: 'Fiat' });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /build-safety-gate/);
});
