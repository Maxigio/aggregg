#!/usr/bin/env node
'use strict';
/**
 * LA GUIDA, MONTATA DAL CODICE CHE DESCRIVE.
 *
 * Il testo sta in `docs/guida/*.md` e lo scrive una persona. Tutto il resto — quali modi
 * esistono, quali filtri, quali ordinamenti, quali fonti e cosa sanno — NON si ricopia a
 * mano: si legge dalle stesse sorgenti che l'app usa per funzionare. Una guida che ricopia
 * invecchia in silenzio; una guida che legge no.
 *
 * Tre comandi dentro il markdown, ognuno una riga che comincia con `::`
 *
 *   ::elenco modi|filtri|ordinamenti|fonti
 *        Una tabella costruita al momento. `modi`, `filtri` e `ordinamenti` escono da
 *        frontend/index.html (lo stesso file che il browser riceve); `fonti` esce da
 *        backend/fonti-route.js, dove ogni fonte dichiara gia' cosa sa e cosa non sa.
 *
 *   ::componente <selettore>
 *        Il pezzo VERO dell'app, estratto da index.html e reso inerte. Non uno screenshot:
 *        lo stesso HTML, con lo stesso style.css. Se cambia la grafica cambia anche qui,
 *        da solo. Gli id vengono tolti (due elementi con lo stesso id sulla stessa pagina
 *        rompono sia il CSS sia chi cerca per id) e i campi disattivati.
 *
 *   ::provalo <parametri> | <etichetta>
 *        Un link che apre l'app con la ricerca gia' impostata: applyUrlParams() la fa
 *        partire da sola. Non un esempio da guardare, uno da premere.
 *
 *   ::parliamone <domanda>
 *        L'invito a scrivere. Il numero WhatsApp arriva dal link gia' presente in
 *        index.html, non dal markdown: sta in un posto solo e cambia in un posto solo.
 *
 * La build gira all'avvio del server e si rifa' se un file cambia (vedi server.js).
 */
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const cheerio = require('cheerio');
const { frontendSourceSync, JS_FILES } = require('./build-frontend');

const RADICE = path.join(__dirname, '..');
const DIR_MD = path.join(RADICE, 'docs', 'guida');
const INDEX_HTML = path.join(RADICE, 'frontend', 'index.html');
const MODELLO = path.join(RADICE, 'frontend', 'guida.html');

/** Il testo diventa testo, sempre: quello che arriva da un .md non deve poter iniettare tag. */
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ─── Le sorgenti da cui la guida legge ──────────────────────────────────────

/** index.html caricato una volta per build: tutti gli elenchi vengono da qui. */
function leggiIndex() { return cheerio.load(fs.readFileSync(INDEX_HTML, 'utf8')); }

function elencoModi($) {
  const righe = $('#modeToggle .mode-btn').map((_, el) => {
    const b = $(el);
    return { chiave: b.attr('data-mode'), nome: b.text().trim() };
  }).get();
  return tabella(['Bottone', 'Nome interno'], righe.map(r => [r.nome, `<code>${esc(r.chiave)}</code>`]));
}

/**
 * SOLO i filtri avanzati. Prima c'erano dentro anche marca, modello, versione e targa, e la
 * tabella finiva sotto il titolo "Restringere" — due righe dopo aver scritto che la targa non
 * filtra niente. Quei quattro campi hanno gia' il loro pezzo mostrato accanto al testo.
 */
function elencoFiltri($) {
  const righe = [];
  $('#advancedFilters .adv-field').each((_, el) => {
    const f = $(el);
    const campo = f.find('input,select').first();
    righe.push([`<code>${esc(campo.attr('id'))}</code>`, esc(f.find('span').first().text().trim())]);
  });
  return tabella(['Campo', 'Cosa chiede'], righe);
}

/**
 * I TRE SITI da cui arrivano gli annunci. Sono un'altra cosa dalle fonti dati degli ADD ON
 * (`::elenco fonti`), e confonderle e' esattamente l'errore che c'era qui: sotto "Da dove
 * arrivano gli annunci" comparivano le etichette dei pneumatici.
 * La verita' sta in FONTE_LABEL, dentro app.js: e' la stessa mappa che scrive il nome della
 * fonte su ogni riga di risultato.
 */
function elencoSiti() {
  const src = frontendSourceSync().js;
  const m = src.match(/const FONTE_LABEL\s*=\s*\{([^}]*)\}/);
  if (!m) {
    return '<p class="guida-manca">Non trovo <code>FONTE_LABEL</code> in <code>frontend/app.js</code>: l\'elenco dei siti non si può generare.</p>';
  }
  const righe = [...m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map(x => [esc(x[2]), `<code>${esc(x[1])}</code>`]);
  return tabella(['Sito', 'Come si chiama nei conteggi'], righe);
}

function elencoOrdinamenti($) {
  // `.each` e non `.map().get()`: cheerio APPIATTISCE gli array tornati da map, quindi una
  // riga di due celle diventava due righe di una cella e la tabella usciva sfasata.
  const righe = [];
  $('#sortMobile option').each((_, el) => {
    const o = $(el);
    righe.push([esc(o.text().trim()), `<code>${esc(o.attr('value'))}</code>`]);
  });
  return tabella(['Voce', 'Valore'], righe);
}

/**
 * Le fonti si raccontano da sole. `sa` e `nonSa` sono gia' scritti in italiano piano dentro
 * fonti-route.js: ricopiarli qui vorrebbe dire tenerne due versioni e sbagliarne una.
 * Le fonti `nascosta` restano fuori: non hanno una voce nell'app, non ne hanno una qui.
 */
function elencoFonti() {
  let FONTI;
  try { ({ FONTI } = require('../backend/fonti-route')); } catch (_) { FONTI = null; }
  if (!FONTI) {
    return '<p class="guida-manca">L\'elenco delle fonti non è disponibile: <code>backend/fonti-route.js</code> non espone <code>FONTI</code>.</p>';
  }
  const righe = Object.entries(FONTI)
    .filter(([, f]) => f && !f.nascosta)
    .map(([, f]) => [
      `<strong>${esc(f.nome)}</strong><br><span class="guida-sotto">${esc(f.dettaglio)}</span>`,
      esc(f.sa || '—'),
      esc(f.nonSa || '—'),
    ]);
  return tabella(['Fonte', 'Cosa sa', 'Cosa non sa'], righe);
}

const tabella = (intestazioni, righe) => righe.length
  ? `<div class="guida-tabella"><table><thead><tr>${intestazioni.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${righe.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : '<p class="guida-manca">Niente da elencare.</p>';

const ELENCHI = {
  modi: $ => elencoModi($),
  filtri: $ => elencoFiltri($),
  ordinamenti: $ => elencoOrdinamenti($),
  siti: () => elencoSiti(),      // i tre siti degli annunci
  fonti: () => elencoFonti(),    // le fonti dati degli ADD ON: altra cosa
};

// ─── I pezzi veri dell'app ──────────────────────────────────────────────────

/**
 * QUELLO CHE IL JAVASCRIPT DISEGNA A RUNTIME.
 *
 * Meta' della barra dei risultati, nel sorgente, e' fatta di contenitori VUOTI: il conteggio,
 * i chip di Raggruppa, il cursore del prezzo e il menu Prezzi li riempie app.js quando arrivano
 * i dati. Estraendo l'HTML statico si otteneva una barra a buchi — e mancava proprio il menu
 * Prezzi, che la guida cita per nome.
 *
 * Qui i buchi si riempiono dalle stesse sorgenti dell'app: FACET_DIMS per i chip, e la
 * funzione `priceMenuHTML` di app.js ESEGUITA davvero (e' un template puro: dipende solo dal
 * suo argomento e da pricing.js, che in node si carica). Il cursore del prezzo lo disegna
 * la sua libreria, sulla pagina della guida: vedi guida.html.
 */
function appJs() { return frontendSourceSync().js; }

function chipRaggruppa() {
  const m = appJs().match(/const FACET_DIMS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return null;
  const voci = [...m[1].matchAll(/\['([^']*)',\s*'([^']+)'\]/g)];
  if (!voci.length) return null;
  return voci.map(([, dim, lab]) =>
    `<button type="button" class="facet-chip${dim === '' ? ' active' : ''}" data-dim="${esc(dim)}">${esc(lab)}</button>`).join('')
    + '<button type="button" class="facet-chip" data-iva="1">Solo IVA esposta <b>12</b></button>';
}

/** Il menu Prezzi, disegnato dalla funzione vera invece che ricopiato. */
function menuPrezzi() {
  try {
    const src = appJs();
    const i = src.indexOf('function priceMenuHTML(');
    if (i < 0) return null;
    const corpo = src.slice(i, src.indexOf('\n}', i) + 2);
    const { priceAdjActive, PRICE_DEFAULT } = require('../frontend/pricing.js');
    // eslint-disable-next-line no-new-func -- e' il nostro sorgente, letto dal repo
    const f = new Function('priceAdjActive', `${corpo}\nreturn priceMenuHTML;`)(priceAdjActive);
    // 'v' come nell'app: e' il namespace dei veicoli, e la riga "Passaggio" esiste solo per
    // quello. Con un namespace inventato il menu usciva di una riga piu' corto del vero.
    return f(PRICE_DEFAULT, 'v');
  } catch (_) { return null; }
}

/** Il testo del conteggio: la parola la dice app.js, il numero e' un esempio. */
function conteggio() {
  const m = appJs().match(/resultsCount\.textContent\s*=\s*`\$\{[^}]+\}\s*(\w+)`/);
  return m ? `128 ${m[1]}` : null;
}

const RIEMPIMENTI = { resultsCount: conteggio, facetChips: chipRaggruppa, priceMenuV: menuPrezzi };

/**
 * Estrae un elemento da index.html, lo riempie dov'e' vuoto e lo rende inerte.
 *
 * Inerte davvero, non solo i campi: `pointer-events: none` in CSS. Disabilitare input e bottoni
 * non bastava — `<summary>` non e' ne' l'uno ne' l'altro, quindi "Colonne ▾" restava cliccabile,
 * e il menu che si apriva (posizione assoluta) veniva tagliato dall'`overflow` del riquadro.
 * Le tendine qui si mostrano APERTE e in linea: in una guida il contenuto di un menu e' la cosa
 * da vedere, non il gesto per aprirlo.
 *
 * Il `d-none` si toglie SOLO alla radice. Toglierlo anche ai discendenti mostrava roba che
 * nell'app resta nascosta finche' non serve: l'elenco vuoto dell'autocompletamento delle marche,
 * il bottone "Verifica →" della targa, e tutti e tre gli input dei Ricambi insieme invece di
 * quello del modo scelto.
 *
 * Gli `id` diventano `data-era`: due elementi con lo stesso id sulla stessa pagina rompono il
 * CSS e ogni ricerca per id, ma l'identita' serve — e' cosi' che la guida sa dove mettere il
 * cursore del prezzo.
 */
function componente($, selettore) {
  const el = $(selettore).first();
  if (!el.length) {
    return `<p class="guida-manca">Il pezzo <code>${esc(selettore)}</code> non esiste più in <code>frontend/index.html</code>.</p>`;
  }
  const copia = $(el.clone());

  // 1. i buchi che riempie il JS
  for (const [id, gen] of Object.entries(RIEMPIMENTI)) {
    const buco = copia.find(`#${id}`).addBack(`#${id}`);
    if (!buco.length || buco.html().trim()) continue;
    const contenuto = gen();
    if (contenuto) buco.html(contenuto);
  }

  // 2. inerte
  copia.find('input,select,textarea,button').addBack('input,select,textarea,button')
    .attr('disabled', 'disabled').attr('tabindex', '-1');
  copia.find('details').addBack('details').attr('open', 'open');

  // 3. visibile solo alla radice
  copia.removeClass('d-none');
  if (/display\s*:\s*none/.test(copia.attr('style') || '')) copia.removeAttr('style');

  // 4. identita' senza collisioni
  copia.find('[id]').addBack('[id]').each((_, e) => {
    const n = $(e); n.attr('data-era', n.attr('id')); n.removeAttr('id');
  });
  return `<div class="guida-pezzo" aria-hidden="true">${$.html(copia)}</div>`;
}

// ─── Il "parliamone" ────────────────────────────────────────────────────────

/**
 * `::parliamone Vuoi vedere più dati partendo dalla targa?`
 *
 * L'invito a scrivere. Il numero NON si scrive nel markdown: si legge dal link WhatsApp che
 * sta gia' in `frontend/index.html`. Scritto a mano finirebbe in undici file, e il giorno che
 * cambia ne resterebbero dieci col numero vecchio — con l'aggravante che nessuno se ne
 * accorge, perche' un link sbagliato si apre lo stesso.
 */
function parliamone($, testo) {
  const href = $('a[href*="wa.me"]').first().attr('href');
  if (!href) {
    return '<p class="guida-manca">Non trovo nessun link <code>wa.me</code> in <code>frontend/index.html</code>: l\'invito a scrivere non ha un numero.</p>';
  }
  const t = String(testo || '').trim();
  return `<p class="guida-parliamone"><a href="${esc(href)}" target="_blank" rel="noopener">`
    + (t ? `${esc(t)} ` : '')
    + '<strong>Parliamone →</strong></a></p>';
}

// ─── Il "provalo" ───────────────────────────────────────────────────────────

/**
 * `::provalo tipo=auto&marca=BMW&modello=320d | Cerca le BMW 320d`
 *
 * Diventa un link a `/?...`: applyUrlParams() riempie i campi e, se la marca e' valida,
 * lancia la ricerca da sola. Niente da costruire, esiste gia'.
 */
function provalo(resto) {
  const [query, etichetta] = String(resto).split('|').map(s => s.trim());
  if (!query) return '<p class="guida-manca">::provalo senza parametri.</p>';
  const testo = etichetta || 'Provalo';
  return `<p class="guida-provalo"><a href="/?${esc(query)}" target="_blank" rel="noopener">▶ ${esc(testo)}</a></p>`;
}

// ─── Montaggio ──────────────────────────────────────────────────────────────

/** Applica i comandi `::` riga per riga. Fuori da un blocco di codice, altrimenti si mostra. */
function espandi(md, $) {
  let dentroCodice = false;
  return md.split('\n').map(riga => {
    if (/^\s*```/.test(riga)) { dentroCodice = !dentroCodice; return riga; }
    if (dentroCodice) return riga;
    const m = riga.match(/^::(\w+)\s*(.*)$/);
    if (!m) return riga;
    const [, comando, resto] = m;
    if (comando === 'elenco') {
      const gen = ELENCHI[resto.trim()];
      return gen ? gen($) : `<p class="guida-manca">Elenco sconosciuto: <code>${esc(resto)}</code>.</p>`;
    }
    if (comando === 'componente') return componente($, resto.trim());
    if (comando === 'provalo') return provalo(resto);
    if (comando === 'parliamone') return parliamone($, resto);
    return `<p class="guida-manca">Comando sconosciuto: <code>::${esc(comando)}</code>.</p>`;
  }).join('\n');
}

/** I file in ordine di nome: `01-…md`, `02-…md`. Il numero decide la posizione, non l'alfabeto. */
function fileSezioni() {
  if (!fs.existsSync(DIR_MD)) return [];
  return fs.readdirSync(DIR_MD).filter(f => f.endsWith('.md')).sort()
    .map(f => path.join(DIR_MD, f));
}

/** L'ancora di una sezione: dal nome del file, senza numero ed estensione. */
const ancora = file => path.basename(file, '.md').replace(/^\d+[-_]?/, '');

function buildGuidaSync() {
  const $ = leggiIndex();
  const sezioni = fileSezioni().map(file => {
    const md = fs.readFileSync(file, 'utf8');
    // Il titolo e' il primo `# ` del file: l'indice non si scrive due volte.
    const titolo = (md.match(/^#\s+(.+)$/m) || [, path.basename(file, '.md')])[1].trim();
    const corpo = marked.parse(espandi(md, $), { mangle: false, headerIds: false });
    return { id: ancora(file), titolo, corpo };
  });

  const indice = sezioni.map((s, i) =>
    `<li><a href="#${esc(s.id)}"><span class="guida-num">${i + 1}</span>${esc(s.titolo)}</a></li>`).join('');
  const corpo = sezioni.map(s =>
    `<section class="guida-sezione" id="${esc(s.id)}">${s.corpo}</section>`).join('\n');

  const modello = fs.readFileSync(MODELLO, 'utf8');
  const html = modello.replace('<!--INDICE-->', indice).replace('<!--CORPO-->', corpo);
  // La versione e' il contenuto: cambia il testo, cambia l'ETag, il browser riscarica.
  const ver = require('crypto').createHash('sha256').update(html).digest('hex').slice(0, 12);
  return { html, ver, sezioni: sezioni.length };
}

/** La firma dei sorgenti: una modifica a qualunque file deve rifare la Guida. */
function mtimeGuida() {
  // app.js e' un sorgente VERO della Guida (priceMenuHTML, elenchi): senza di lui nel
  // timbro, cambiare il frontend lasciava in giro la pagina vecchia — pure con un 304.
  const files = [...fileSezioni(), INDEX_HTML, MODELLO, ...JS_FILES];
  return files.map(f => {
    try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; }
    catch (_) { return 'assente'; }
  }).join('|');
}

module.exports = { buildGuidaSync, mtimeGuida, espandi, componente, provalo, parliamone, ELENCHI };

if (require.main === module) {
  const { ver, sezioni, html } = buildGuidaSync();
  console.log(`Guida montata: ${sezioni} sezioni, ${html.length} byte, versione ${ver}`);
}
