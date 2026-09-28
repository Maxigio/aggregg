'use strict';
/**
 * LA GUIDA NON RICOPIA: LEGGE.
 *
 * Il valore di /guida non e' che esista, e' che gli elenchi e i pezzi mostrati vengano dalle
 * stesse sorgenti che l'app usa per funzionare. Una guida che ricopia i nomi dei filtri
 * invecchia il giorno dopo e nessuno se ne accorge; una che li legge da index.html no.
 * Questi test difendono quel legame, non il testo.
 *
 * Il testo NON e' sotto test: e' scritto a mano in docs/guida/*.md e cambia spesso. Quello
 * che deve restare vero e' che ogni comando venga espanso, che un comando che punta a
 * qualcosa di sparito lo DICA invece di sparire in silenzio, e che i pezzi estratti siano
 * inerti (id via, campi spenti) — due elementi con lo stesso id sulla stessa pagina
 * rompono il CSS e ogni ricerca per id.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.AMR_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-log-guida-'));

const { test } = require('node:test');
const assert = require('node:assert');
const cheerio = require('cheerio');
const { buildGuidaSync, espandi, componente, provalo, parliamone, ELENCHI } = require('../scripts/build-guida');

const RADICE = path.join(__dirname, '..');
const DIR_MD = path.join(RADICE, 'docs', 'guida');
const sorgente = (...p) => fs.readFileSync(path.join(RADICE, ...p), 'utf8');
const $index = cheerio.load(fs.readFileSync(path.join(RADICE, 'frontend', 'index.html'), 'utf8'));

test('la guida si monta, e ogni comando :: viene espanso', () => {
  const { html, sezioni } = buildGuidaSync();
  assert.ok(sezioni > 0, 'nessuna sezione: docs/guida/ e\' vuota?');
  assert.ok(!/(^|\n)\s*::\w+/.test(html),
    'un comando :: e\' rimasto a schermo come testo: build-guida non lo conosce');
  assert.ok(!html.includes('<!--INDICE-->') && !html.includes('<!--CORPO-->'),
    'i segnaposti del modello non sono stati sostituiti: la pagina uscirebbe vuota');
});

test('una voce di indice per ogni file, nell\'ordine dei numeri', () => {
  const file = fs.readdirSync(DIR_MD).filter(f => f.endsWith('.md')).sort();
  const { html } = buildGuidaSync();
  const $ = cheerio.load(html);
  const voci = $('.guida-indice a').length;
  assert.strictEqual(voci, file.length,
    `${file.length} file in docs/guida ma ${voci} voci nell'indice: un file non compare`);
  // Ogni voce punta a una sezione che esiste davvero: un indice con un link morto e' peggio
  // di un indice corto, perche' promette e non mantiene.
  $('.guida-indice a').each((_, a) => {
    const id = $(a).attr('href').slice(1);
    assert.strictEqual($(`.guida-sezione#${id}`).length, 1, `la voce "${id}" non porta a nessuna sezione`);
  });
});

test('gli elenchi vengono dal codice, non da una copia', () => {
  // I modi: quelli veri sono i bottoni di index.html. Se se ne aggiunge uno, la guida lo
  // deve avere senza che nessuno scriva niente.
  const modi = $index('#modeToggle .mode-btn').map((_, b) => $index(b).attr('data-mode')).get();
  const htmlModi = ELENCHI.modi($index);
  for (const m of modi) {
    assert.ok(htmlModi.includes(`<code>${m}</code>`), `il modo "${m}" esiste nell'app ma non nell'elenco della guida`);
  }

  // I filtri avanzati: stessa storia con i campi.
  const htmlFiltri = ELENCHI.filtri($index);
  $index('#advancedFilters .adv-field input, #advancedFilters .adv-field select').each((_, el) => {
    const id = $index(el).attr('id');
    assert.ok(htmlFiltri.includes(`<code>${id}</code>`), `il filtro "${id}" non compare nella guida`);
  });
  // E SOLO quelli. La targa era finita nell'elenco dei filtri, sotto un titolo che si chiama
  // "Restringere", due righe dopo aver scritto che la targa non restringe niente.
  for (const nonFiltro of ['targaFiltro', 'marca', 'modello', 'versione']) {
    assert.ok(!htmlFiltri.includes(`<code>${nonFiltro}</code>`),
      `"${nonFiltro}" non e' un filtro avanzato e non deve stare nel loro elenco`);
  }

  // Gli ordinamenti escono dalla tendina vera.
  const htmlOrd = ELENCHI.ordinamenti($index);
  $index('#sortMobile option').each((_, o) => {
    assert.ok(htmlOrd.includes(`<code>${$index(o).attr('value')}</code>`),
      `l'ordinamento "${$index(o).attr('value')}" non compare nella guida`);
  });
});

test('i tre siti degli annunci sono un\'altra cosa dalle fonti dati', () => {
  // L'errore che questo test blocca: sotto "Da dove arrivano gli annunci" comparivano le
  // etichette europee dei pneumatici, perche' l'unico elenco disponibile era quello sbagliato.
  const app = require('../scripts/build-frontend').frontendSourceSync().js;
  const m = app.match(/const FONTE_LABEL\s*=\s*\{([^}]*)\}/);
  assert.ok(m, "FONTE_LABEL non e' piu' in app.js: l'elenco dei siti non ha piu' una sorgente");
  const nomi = [...m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map(x => x[2]);
  assert.ok(nomi.length >= 3, 'meno di tre siti: il test non proverebbe niente');

  const siti = ELENCHI.siti();
  for (const n of nomi) assert.ok(siti.includes(n), `il sito "${n}" non compare nell'elenco della guida`);

  // E i due elenchi non devono sovrapporsi: se un giorno tornassero a dire la stessa cosa,
  // vorrebbe dire che uno dei due sta descrivendo l'altro.
  const { FONTI } = require('../backend/fonti-route');
  const fonti = ELENCHI.fonti();
  for (const n of nomi) {
    assert.ok(!fonti.includes(`<strong>${n}</strong>`),
      `"${n}" e' un sito di annunci ma compare fra le fonti dati degli ADD ON`);
  }
  assert.ok(Object.keys(FONTI).length > 0);
});

test('le fonti si raccontano da sole, e quelle nascoste restano fuori', () => {
  const { FONTI } = require('../backend/fonti-route');
  const html = ELENCHI.fonti();
  const visibili = Object.values(FONTI).filter(f => f && !f.nascosta);
  assert.ok(visibili.length > 0, 'nessuna fonte visibile: il test non proverebbe niente');
  for (const f of visibili) {
    assert.ok(html.includes(f.nome), `la fonte "${f.nome}" non compare nella guida`);
  }
  for (const f of Object.values(FONTI).filter(f => f && f.nascosta)) {
    assert.ok(!html.includes(`<strong>${f.nome}</strong>`),
      `"${f.nome}" e' nascosta nell'app ma la guida la elenca`);
  }
  assert.ok(html.includes('Cosa non sa'), 'la colonna dei limiti e\' sparita: e\' la parte piu\' utile');
});

test('un pezzo che non esiste piu\' lo DICE, non sparisce', () => {
  // Il modo peggiore di rompersi: il comando punta a un elemento cancellato, l'espansione
  // torna vuota, e la guida continua a sembrare completa. Deve stonare.
  const html = componente($index, '#questo-non-esiste-piu');
  assert.ok(html.includes('guida-manca'), 'un pezzo mancante deve produrre un avviso visibile');
  assert.ok(html.includes('#questo-non-esiste-piu'), 'l\'avviso deve dire QUALE pezzo manca');

  const ignoto = espandi('::elencoooo qualcosa', $index);
  assert.ok(ignoto.includes('guida-manca'), 'un comando sconosciuto deve produrre un avviso visibile');
  const elencoIgnoto = espandi('::elenco pinguini', $index);
  assert.ok(elencoIgnoto.includes('guida-manca'), 'un elenco inesistente deve produrre un avviso visibile');
});

test('i pezzi estratti sono inerti: niente id, niente campi attivi, niente tendine da aprire', () => {
  const html = componente($index, '#advancedFilters');
  const $ = cheerio.load(html);
  assert.ok($('.guida-pezzo').length === 1, 'il pezzo non e\' incorniciato');
  assert.strictEqual($('[id]').length, 0,
    'un id e\' sopravvissuto: sulla stessa pagina dell\'app farebbe collidere CSS e ricerche per id');
  assert.ok($('[data-era]').length > 0, 'l\'identita\' e\' andata persa: senza data-era la guida non sa dove mettere il cursore del prezzo');
  const campi = $('input, select, textarea, button');
  assert.ok(campi.length > 0, 'il pezzo scelto non ha campi: il test non proverebbe niente');
  campi.each((_, el) => {
    assert.ok($(el).attr('disabled') !== undefined,
      'un campo del pezzo e\' attivo: qualcuno crederebbe di star cercando dalla guida');
  });

  // Le tendine: gia' aperte, e non apribili. `disabled` non copre <summary>, che non e' un
  // campo — "Colonne ▾" restava cliccabile, e il menu che si apriva (posizione assoluta)
  // veniva tagliato dall'overflow del riquadro. Due difese: attributo open nel montaggio,
  // pointer-events nel foglio di stile.
  const barra = cheerio.load(componente($index, '#resultsToolbar'));
  const tendine = barra('details');
  assert.ok(tendine.length > 0, 'la barra non ha piu\' tendine: il test non proverebbe niente');
  tendine.each((_, d) => {
    assert.ok(barra(d).attr('open') !== undefined,
      'una tendina e\' chiusa: nella guida il contenuto di un menu e\' la cosa da vedere');
  });
  const css = require('../scripts/build-frontend').frontendSourceSync().css;
  assert.ok(/\.guida-pezzo\s*>\s*\*\s*\{[^}]*pointer-events:\s*none/.test(css),
    'manca pointer-events:none sul contenuto del pezzo: le tendine tornano cliccabili e sforano dal riquadro');
  assert.ok(/\.guida-pezzo\s+\.tb-cols-menu\s*\{[^}]*position:\s*static/.test(css),
    'il menu delle tendine torna in posizione assoluta: esce dal riquadro e sparisce nell\'overflow');
});

test('il nascosto resta nascosto: si scopre solo la radice', () => {
  // `d-none` si toglieva anche ai discendenti, e comparivano cose che nell'app restano
  // nascoste finche' non servono: l'elenco vuoto dell'autocompletamento delle marche, il
  // bottone "Verifica →" della targa.
  // #versioniRow ne nasconde 2 dal 2026-08-08: al bottone della targa si e' aggiunto
  // l'elenco dell'autocompletamento della versione (#versioneAC), gemello di quelli di
  // marca e modello che stanno nei 2 di .search-fields.
  for (const [sel, quantiNascosti] of [['.search-fields', 2], ['#versioniRow', 2]]) {
    const $ = cheerio.load(componente($index, sel));
    const radice = $('.guida-pezzo').children().first();
    assert.ok(!radice.hasClass('d-none') && !/display\s*:\s*none/.test(radice.attr('style') || ''),
      `${sel}: la radice e' rimasta nascosta, il pezzo non si vedrebbe`);
    const nascosti = $('.d-none').length + $('[style*="display:none"],[style*="display: none"]').length;
    assert.strictEqual(nascosti, quantiNascosti,
      `${sel}: dentro il pezzo dovrebbero restare ${quantiNascosti} elementi nascosti, ne restano ${nascosti}`);
  }
});

test('la barra dei risultati non ha buchi: i contenitori che riempie il JS sono pieni', () => {
  // Meta' di quella barra, nel sorgente, e' fatta di div vuoti che app.js riempie a runtime.
  // Estratta cosi' com'e' usciva a buchi, e mancava il menu Prezzi che la guida cita per nome.
  const $ = cheerio.load(componente($index, '#resultsToolbar'));
  const dentro = s => $(`[data-era="${s}"]`);

  assert.ok(dentro('resultsCount').text().trim(), 'il conteggio e\' vuoto');
  const chip = dentro('facetChips').find('.facet-chip');
  assert.ok(chip.length >= 3, `i chip di Raggruppa sono ${chip.length}: il contenitore e' rimasto vuoto`);

  // I chip devono combaciare con FACET_DIMS, che e' la sorgente vera.
  const app = require('../scripts/build-frontend').frontendSourceSync().js;
  const dims = [...(app.match(/const FACET_DIMS\s*=\s*\[([\s\S]*?)\];/) || [, ''])[1]
    .matchAll(/\['([^']*)',\s*'([^']+)'\]/g)];
  for (const [, , label] of dims) {
    assert.ok(dentro('facetChips').text().includes(label), `il raggruppamento "${label}" non compare fra i chip`);
  }

  // Il menu Prezzi non e' ricopiato: lo disegna la funzione vera di app.js. Con il namespace
  // sbagliato usciva di una riga piu' corto (la riga "Passaggio" esiste solo per i veicoli).
  const righe = dentro('priceMenuV').find('.pm-row');
  assert.ok(righe.length >= 4, `il menu Prezzi ha ${righe.length} righe: manca qualcosa`);
  assert.ok(dentro('priceMenuV').text().includes('Passaggio'),
    'manca la riga "Passaggio": il menu e\' stato disegnato col namespace sbagliato');

  // Il cursore del prezzo lo disegna la sua libreria nella pagina: qui deve restare il posto.
  assert.strictEqual(dentro('prezzoSlider').length, 1, 'il posto del cursore del prezzo e\' sparito');
  const pagina = sorgente('frontend', 'guida.html');
  assert.ok(pagina.includes('nouislider') && pagina.includes('data-era="prezzoSlider"'),
    'guida.html non disegna piu\' il cursore del prezzo: nella barra resterebbe un buco');
});

test('i comandi dentro un blocco di codice restano scritti', () => {
  // La guida deve poter SPIEGARE i propri comandi senza eseguirli.
  const md = ['```', '::elenco modi', '```'].join('\n');
  assert.ok(espandi(md, $index).includes('::elenco modi'),
    'un comando dentro ``` e\' stato eseguito: la guida non puo\' documentare se stessa');
});

test('provalo produce un link all\'app, col testo messo al sicuro', () => {
  const html = provalo('tipo=auto&marca=BMW | Le BMW');
  assert.ok(html.includes('href="/?tipo=auto&amp;marca=BMW"'), 'il link non punta all\'app con i parametri');
  assert.ok(html.includes('Le BMW'), 'l\'etichetta e\' sparita');
  // Il markdown lo scrive una persona, ma resta testo che finisce in una pagina: va escapato
  // come qualunque altro, senza eccezioni "tanto e' roba nostra".
  assert.ok(!provalo('x=1 | <img src=x onerror=alert(1)>').includes('<img'),
    'l\'etichetta finisce nella pagina senza essere messa al sicuro');
});

test('gli inviti a scrivere portano tutti al numero vero, che sta in un posto solo', () => {
  const numero = ($index('a[href*="wa.me"]').first().attr('href') || '');
  assert.ok(numero, "in index.html non c'e' piu' nessun link wa.me: gli inviti a scrivere non hanno un numero");

  const html = parliamone($index, 'Vuoi saperne di più?');
  assert.ok(html.includes(`href="${numero}"`), "l'invito non punta al numero di index.html");
  assert.ok(html.includes('Parliamone'), "manca la parola su cui si clicca");

  // Nella pagina montata: ogni invito, senza eccezioni, va li'.
  const $ = cheerio.load(buildGuidaSync().html);
  const inviti = $('.guida-parliamone a');
  assert.ok(inviti.length > 0, 'nessun invito a scrivere nella guida');
  inviti.each((_, a) => {
    assert.ok(String($(a).attr('href')).includes('wa.me'),
      `un invito porta altrove: ${$(a).attr('href')}`);
  });

  // E il numero NON si scrive nei markdown. Scritto a mano finirebbe in undici file, e il
  // giorno che cambia ne resterebbero dieci col numero vecchio — senza che nulla si rompa.
  const soloCifre = numero.replace(/\D/g, '');
  for (const f of fs.readdirSync(DIR_MD).filter(x => x.endsWith('.md'))) {
    const testo = fs.readFileSync(path.join(DIR_MD, f), 'utf8');
    assert.ok(!testo.includes('wa.me') && !testo.includes(soloCifre),
      `${f} contiene il numero a mano: deve venire da index.html tramite ::parliamone`);
  }

  // La domanda la scrive una persona, ma finisce in una pagina: va messa al sicuro.
  assert.ok(!parliamone($index, '<img src=x onerror=alert(1)>').includes('<img'),
    "il testo dell'invito finisce nella pagina senza essere messo al sicuro");
});

test('i rimandi fra sezioni portano a una sezione che esiste', () => {
  // I rimandi si scrivono come link veri — `[titolo](#ancora)` — e non in corsivo: cosi' si
  // cliccano, e si possono controllare senza indovinare quale corsivo fosse un rimando.
  // I titoli li cambia chi scrive; un rimando rimasto indietro manda il lettore in un punto
  // che non esiste, e il browser non se ne lamenta.
  const $ = cheerio.load(buildGuidaSync().html);
  const ancore = new Set($('.guida-sezione').map((_, s) => $(s).attr('id')).get());
  assert.ok(ancore.size > 1, 'meno di due sezioni: il test non proverebbe niente');

  const rimandi = $('.guida-corpo a[href^="#"]');
  assert.ok(rimandi.length > 0, 'nessun rimando fra sezioni: il test non proverebbe niente');
  rimandi.each((_, a) => {
    const dove = String($(a).attr('href')).slice(1);
    assert.ok(ancore.has(dove),
      `il rimando "${$(a).text()}" punta a #${dove}, che non e' nessuna sezione. Sezioni vere: ${[...ancore].join(' · ')}`);
  });
});

test('/guida sta dietro il login, e il modello grezzo non e\' servito', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  const authFree = src.slice(src.indexOf('const AUTH_FREE'), src.indexOf(']', src.indexOf('const AUTH_FREE')));
  assert.ok(!authFree.includes('/guida'),
    'la guida e\' finita in AUTH_FREE: la mappa completa dell\'app sarebbe leggibile senza password su un server pubblico');
  // La rotta deve coprire ANCHE /guida.html, se no express.static consegna il modello con i
  // segnaposti dentro e la guida appare vuota.
  assert.ok(/app\.get\(\[\s*'\/guida'\s*,\s*'\/guida\.html'\s*\]/.test(src),
    'la rotta non intercetta /guida.html: lo static servirebbe il modello grezzo');
  const modello = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'guida.html'), 'utf8');
  assert.ok(modello.includes('<!--INDICE-->') && modello.includes('<!--CORPO-->'),
    'il modello ha perso i segnaposti: la build non avrebbe dove scrivere');
});
