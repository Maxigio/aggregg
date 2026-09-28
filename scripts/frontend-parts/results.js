
// ─── Rendering ──────────────────────────────────────────────────────────────
/**
 * LA VERSIONE E' UN FILTRO, e chi non la porta esce dalla lista.
 *
 * Il server MARCA e non toglie: cosi' il totale resta onesto e questi annunci si possono
 * rimettere con un clic. Qui si tolgono, si contano, e si scrive quanti sono — nascondere
 * senza dirlo sarebbe il post-filtro muto che in questa app non si fa.
 *
 * 'ignota' resta dentro: vuol dire che l'annuncio non dichiara niente e il titolo non aiuta,
 * cioe' non lo sappiamo. Toglierlo sarebbe far passare "non lo so" per "non e' quella".
 */
let mostraVersioniSmentite = false;

function rigaVersione(tolti) {
  let el = document.getElementById('avvisoVersione');
  if (!el) {
    el = document.createElement('div');
    el.id = 'avvisoVersione';
    el.className = 'avviso-versione d-none';
    fonteBreakdown?.parentNode?.insertBefore(el, fonteBreakdown);
  }
  if (!tolti) { el.classList.add('d-none'); el.innerHTML = ''; return; }
  el.classList.remove('d-none');
  el.textContent = mostraVersioniSmentite
    ? `${tolti} annunci dichiarano una versione diversa: li stai vedendo. `
    : `Nascosti ${tolti} annunci che dichiarano una versione diversa da quella cercata. `;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'avviso-versione-btn';
  b.textContent = mostraVersioniSmentite ? 'nascondili' : 'mostrali';
  b.addEventListener('click', () => { mostraVersioniSmentite = !mostraVersioniSmentite; renderResults(currentResults); });
  el.appendChild(b);
}

function renderResults(results) {
  nascondiAvvisi(true); // le righe vengono ricreate: il pulsante aperto non esiste piu'
  // Nessuna ricerca attiva: niente toolbar/risultati.
  // La toolbar appare solo dopo una ricerca vera.
  if (!searchActive) {
    resultsToolbar.classList.add('d-none'); compareBar.classList.add('d-none');
    resultsSection.classList.add('d-none'); noResults.classList.add('d-none');
    return;
  }
  let filtered = results.slice();
  // La versione chiesta: chi la smentisce esce, e sotto il conteggio si scrive quanti sono.
  const smentiti = filtered.filter(r => r.versioneEsito === 'smentita').length;
  if (smentiti && !mostraVersioniSmentite) filtered = filtered.filter(r => r.versioneEsito !== 'smentita');
  rigaVersione(smentiti);
  // `ivaEsposta` e' a tre stati: true, false, e null quando la fonte non lo dice. Il filtro
  // tiene SOLO i true — un annuncio che non lo dichiara non e' un annuncio con IVA esposta,
  // e tenerlo dentro renderebbe il filtro una speranza invece di un filtro.
  if (soloIva) filtered = filtered.filter(r => r.ivaEsposta === true);
  if (prezzoSliderInstance) {
    const [sMin, sMax] = prezzoSliderInstance.get().map(Number);
    filtered = filtered.filter(r => r.prezzo == null || (r.prezzo >= sMin && r.prezzo <= sMax));
  }
  const sorted = sortResults([...filtered]);
  ultimiVisti = sorted;              // quello che e' davvero a schermo: lo esportano CSV e PDF
  renderFacetChips();

  resultsToolbar.classList.remove('d-none');
  if (!document.querySelector('#priceMenuV summary')) renderPriceMenuV();   // rete di sicurezza: menu "Prezzo €" popolato quando la toolbar appare
  updateStats();
  targaBtnSync();   // annunci a schermo → il bottone della targa ha dove andare

  if (sorted.length === 0) {
    /**
     * "NESSUN RISULTATO" DEVE DIRE DI CHI E' LA COLPA.
     *
     * Qui compariva sempre "Nessun risultato trovato. Prova a modificare i filtri" — anche
     * quando gli annunci c'erano eccome ed era un filtro NOSTRO a nasconderli tutti.
     * Misurato: una ricerca Golf da 210 annunci in cui nessuno dichiara l'IVA esposta;
     * acceso il chip "Solo IVA esposta", lo schermo si svuota e il pannello dava la colpa
     * al mercato. E' la stessa forma di tutto il resto: una lista vuota per un filtro non
     * e' un piazzale vuoto, e chi guarda deve poter distinguere le due cose.
     */
    const nascosti = (results || []).length;
    const perFiltro = [];
    if (soloIva) perFiltro.push('il filtro «Solo IVA esposta»');
    if (prezzoSliderInstance) {
      const [sMin, sMax] = prezzoSliderInstance.get().map(Number);
      if (results.some(r => r.prezzo != null && (r.prezzo < sMin || r.prezzo > sMax))) perFiltro.push('il cursore dei prezzi');
    }
    const testo = noResults.querySelector('p');
    const nota = noResults.querySelector('p.small');
    if (nascosti > 0 && perFiltro.length && testo) {
      testo.textContent = `Nessuno di questi ${nascosti} annunci passa ${perFiltro.join(' e ')}.`;
      if (nota) nota.textContent = 'Gli annunci ci sono: a nasconderli è un filtro, non la ricerca. Toglilo per rivederli.';
    } else if (testo) {
      testo.textContent = altriDisponibili() ? 'Nessun annuncio in questa pagina.' : 'Nessun risultato trovato.';
      if (nota) nota.textContent = altriDisponibili()
        ? 'La fonte ha altre pagine: puoi continuare la ricerca qui sotto.'
        : 'Prova a modificare i filtri o selezionare una regione più ampia.';
    }
    noResults.classList.remove('d-none'); resultsSection.classList.add('d-none');
    renderAltriBtn();
    return;
  }
  noResults.classList.add('d-none'); resultsSection.classList.remove('d-none');
  resultsCount.textContent = `${sorted.length} risultati`;

  // Lista o schede: cambia solo COME si disegna la stessa fetta di annunci. Il resto
  // (raggruppamento, ordinamento, pannello dell'annuncio, confronto) e' identico
  // — le schede sono righe con la foto grande, non un secondo elenco con regole sue.
  vistaChipsRender();
  const disegna = (items, best) => vista === 'schede'
    ? `<div class="card-grid">${items.map(r => cardHTML(r, best)).join('')}</div>`
    : gridHeadHTML() + `<div class="result-list">${items.map(r => rowHTML(r, best)).join('')}</div>`;
  if (groupDim) {
    const groups = groupResults(sorted, groupDim);
    resultsGrid.innerHTML = groups.map(g => {
      const best = bestUrlSet(g.items);
      return `<div class="result-group">
        <button type="button" class="group-header" aria-expanded="true">
          <span class="group-caret">${icon('chevron')}</span>
          <span class="group-title">${escapeHtml(String(g.key))}</span>
          <span class="group-meta">${g.items.length} annunci${(() => { const gm = vPricing(g.minPrezzo); return gm ? ` · da ${eurRound(gm.finale)}` : ''; })()}</span>
        </button>
        <div class="group-body">${disegna(g.items, best)}</div>
      </div>`;
    }).join('');
  } else {
    resultsGrid.innerHTML = disegna(sorted, bestUrlSet(sorted));
  }
  renderAltriBtn();
}

// ─── Dettagli Moto.it: AL CLIC, non allo scorrimento ──────────────────────────
// La galleria piena e le spec di Moto.it stanno sulla pagina-dettaglio, non nella card della
// ricerca. Fino a ieri un IntersectionObserver le chiedeva mentre scorrevi (fino a 4 in
// parallelo, con 300px di margine): una sola ricerca Yamaha MT-07 — misurata dal vivo, 239
// annunci di cui 39 di Moto.it — faceva partire 39 richieste a Moto.it per annunci che non
// avevi ancora deciso di guardare. E meta' di quel lavoro non si vedeva nemmeno:
// `updateRowThumb` cercava `.result-row`, e la vista predefinita e' quella a SCHEDE
// (`.ann-card`). Decisione del proprietario: i dati mancanti si chiedono APRENDO l'annuncio.
// Chi lo fa e' il pannello di dettaglio (vedi `renderDetail`), che gia' chiamava questa
// funzione. In griglia non si perde niente di visibile: la cover ce l'hanno gia' tutte
// (misurato: 39 su 39), quello che arriva al clic e' la galleria piena e le spec.
async function enrichMotoRow(url) {
  const r = trovaResult(url);
  if (!r || r._enriched) return;   // già arricchita (cover-only NON conta: ha solo 1 foto)
  const myGen = searchGen;
  try {
    const j = await fetch(`/api/detail?url=${encodeURIComponent(url)}`).then(x => x.json());
    if (myGen !== searchGen || !currentResults.includes(r)) return;
    segnalaPausaDettaglio(j);
    if (j.ok && j.detail) {
      // QUANTI CAMPI HA PORTATO DAVVERO. `{ok:true, detail:{...tutto null}}` e' la risposta
      // che il parser da' su una pagina che non ha detto niente: marcandola comunque
      // «arricchita», l'annuncio non veniva PIU' richiesto — nemmeno quando la fonte fosse
      // tornata a rispondere, e il TTL breve del dettaglio diventava inutile.
      let portati = 0;
      Object.keys(j.detail).forEach(k => {
        const v = j.detail[k]; if (v == null) return;
        if (k === 'immagini') { if (Array.isArray(v) && v.length) { r.immagini = v; portati++; } }  // galleria piena rimpiazza la cover
        else if (r[k] == null) { r[k] = v; portati++; }
      });
      if (portati) r._enriched = true;   // solo a merge riuscito: un fetch fallito resta ri-tentabile
    }
  } catch (_) {}
  if (myGen === searchGen && currentResults.includes(r)) updateRowThumb(url);
}
function updateRowThumb(url) {
  // LE DUE VISTE, non una. Qui c'era solo `.result-row`, e la vista predefinita e' quella a
  // SCHEDE (`.ann-card`): la foto appena scaricata da Moto.it non compariva mai, a meno di
  // essere passati alla lista densa. Stesso selettore doppio gia' usato da `refreshRowState`.
  const row = resultsGrid.querySelector(`.result-row[data-url="${CSS.escape(url)}"], .ann-card[data-url="${CSS.escape(url)}"]`);
  if (!row) return;
  const thumb = row.querySelector('.row-thumb'); if (!thumb) return;
  const r = trovaResult(url); const imgs = (r && Array.isArray(r.immagini)) ? r.immagini : [];
  if (imgs.length) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'row-thumb'; btn.title = 'Vedi foto';
    btn.innerHTML = `<img src="${escapeHtml(imgs[0].thumb)}" loading="lazy" referrerpolicy="no-referrer" alt="">`;
    thumb.replaceWith(btn);
  }
}

// Set di URL col prezzo più basso (1 per gruppo/lista) → evidenziazione "best".
/**
 * IL PIU' ECONOMICO SI DICE SOLO SE SI STA CONFRONTANDO LA STESSA COSA.
 *
 * Su una ricerca allargata alla marca in lista ci sono anche annunci di altri modelli: il
 * piu' economico e' quasi sempre uno di quelli, perche' e' un veicolo piu' piccolo. La
 * stella verde li' non segnala un affare, segnala un confronto senza senso — e con la
 * pastiglia «altro modello» sulla stessa riga si contraddicono a vicenda. Con l'insieme
 * misto non si assegna a nessuno: nessuna bugia, e la colonna prezzo resta ordinabile.
 */
/**
 * FUORI BERSAGLIO = una delle DUE marcature, non una sola: quella degli scraper
 * (`dichiarazione`: un altro modello) e quella della verifica versioni (`versioneEsito`:
 * l'annuncio dichiara un'altra versione). Ogni cancello ne conosceva una — e la stella
 * verde finiva sulla Golf 1.6 base che l'app aveva appena marcato «non e' quella
 * versione». Una funzione sola evita verdetti diversi nello stesso elenco.
 */
const fuoriBersaglio = r => !!r && ((r.dichiarazione && r.dichiarazione !== 'esatto' && r.dichiarazione !== 'senza-versione')
  || r.versioneEsito === 'smentita');
function bestUrlSet(items) {
  const misto = items.some(fuoriBersaglio);
  if (misto) return new Set();
  let min = Infinity, url = null;
  for (const r of items) { if (r.prezzo != null && r.prezzo > 0 && r.prezzo < min) { min = r.prezzo; url = r.url; } }
  return new Set(url ? [url] : []);
}

// ─── Colonne griglia (dinamiche) ────────────────────────────────────────────
// Base = sempre presenti. anno/km/carb/cv = opzionali: default dai FILTRI usati
// in ricerca + menu "Colonne". Sotto 1180px carb/cv cadono (overflow); il template
// è inline (vince sulle media-query) → la responsività è in JS (effVisibleCols).
const COLS = [
  { key: 'foto',    w: '120px',         base: true },
  { key: 'veicolo', w: 'minmax(0,1fr)', base: true },
  { key: 'anno',    w: '64px',  num: true, sort: 'anno',      label: 'Anno' },
  { key: 'km',      w: '98px',  num: true, sort: 'km',        label: 'Km' },
  { key: 'carb',    w: '92px',             label: 'Carb.' },
  { key: 'cv',      w: '58px',  num: true, sort: 'potenzaCv', label: 'CV' },
  { key: 'prezzo',  w: '124px', num: true, sort: 'prezzo',    label: 'Prezzo', base: true },
  { key: 'fonte',   w: '96px',  base: true },
  { key: 'azioni',  w: '104px', base: true },
];
const OPTIONAL_COLS = ['anno', 'km', 'carb', 'cv'];
function effVisibleCols() {
  const wide = window.innerWidth >= 1180;   // sotto: niente carb/cv (mobile <860 → stacked CSS)
  return visibleCols.filter(k => wide || (k !== 'carb' && k !== 'cv'));
}
function activeCols() {
  const vis = effVisibleCols();
  return COLS.filter(c => c.base || vis.includes(c.key));
}
function gridTemplate() {
  return activeCols().map(c => c.w).join(' ');
}
function colsFromFilters(p) {
  const v = [];
  if (p && (p.annoMin || p.annoMax)) v.push('anno');
  if (p && (p.kmMin || p.kmMax)) v.push('km');
  return v;
}
/**
 * IL DEFAULT NON E' LO STESSO NELLE DUE VISTE, e non e' una svista.
 *
 * Nella LISTA ogni campo acceso e' una COLONNA in piu': larghezza vera sottratta al
 * titolo, per questo di partenza si accendono solo quelle su cui hai davvero filtrato.
 * Nella SCHEDA sono parole in una riga che va a capo da sola: non costano niente, e
 * partono tutte accese — com'era prima che il menu le comandasse.
 * Se le spunte le hai toccate tu, comandano loro: cambiare vista non te le rimette a posto.
 */
let colsToccate = false;
const colsDefault = params => (vista === 'schede' ? OPTIONAL_COLS.slice() : colsFromFilters(params));
function syncColMenu() {
  document.querySelectorAll('.col-toggle').forEach(cb => { cb.checked = visibleCols.includes(cb.value); });
}

function gridHeadHTML() {
  const caret = key => sortState.key === key ? `<span class="sort-caret">${sortState.dir === 'asc' ? '↑' : '↓'}</span>` : '';
  const cells = activeCols().map(c => {
    if (c.key === 'foto')    return '<span class="gh">Foto</span>';
    if (c.key === 'veicolo') return '<span class="gh">Veicolo</span>';
    if (c.key === 'fonte')   return '<span class="gh">Fonte</span>';
    if (c.key === 'azioni')  return `<span class="gh" style="text-align:right">Azioni</span>`;
    if (c.sort) return `<span class="gh gh-num"><button type="button" class="gh-sort${sortState.key === c.sort ? ' active' : ''}" data-key="${c.sort}">${c.label} ${caret(c.sort)}</button></span>`;
    return `<span class="gh">${c.label}</span>`;
  }).join('');
  return `<div class="grid-head" style="grid-template-columns:${gridTemplate()}">${cells}</div>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Cosa la fonte dichiara di questo annuncio. `esatto` non compare: e' il caso normale,
 * e marcare la normalita' rende invisibile l'eccezione.
 */
const DICHIARAZIONE = {
  'senza-versione': { et: 'versione n.d.', cl: 'med', tit: 'Il venditore non ha indicato la versione: il modello e\' quello giusto, l\'allestimento non e\' dichiarato.' },
  'senza-modello':  { et: 'modello non dichiarato', cl: 'med', tit: 'Il venditore non ha indicato il modello: riconosciuto dal titolo, non dal catalogo.' },
  'altro-modello':  { et: 'altro modello', cl: 'ko',  tit: 'Questa fonte non ha il modello cercato: la ricerca si e\' allargata alla marca e questo e\' un modello diverso.' },
  // Diverso da "versione n.d.": li' e' il venditore a non averla scritta, qui siamo noi
  // a non aver potuto controllare. Su Autoscout la versione e' testo libero, e certe
  // versioni ("320 2 porte") non lasciano un testo da confrontare — la carrozzeria li'
  // sta in un campo numerico. Dirlo "esatto" sarebbe una corrispondenza mai guardata.
  'versione-non-verificata': { et: 'versione non verificata', cl: 'med', tit: 'Il modello e\' quello giusto, ma la versione cercata non si e\' potuta confrontare: potrebbe essere un altro allestimento.' },
};

function corrispondenzaDi(r) {
  if (r.versioneEsito === 'smentita') return { et: 'non e\' quella versione', cl: 'ko' };
  const d = DICHIARAZIONE[r.dichiarazione];
  if (r.versioneEsito === 'ignota' && !['altro-modello', 'senza-modello'].includes(r.dichiarazione))
    return DICHIARAZIONE['versione-non-verificata'];
  return d || { et: 'corrisponde' };
}

/** Gli avvisi della riga si raccolgono in un solo pulsante, separato dal titolo cliccabile. */
function avvisiAnnuncio(item) {
  const out = [];
  if (item.dichiarazione === 'altro-modello')
    out.push({ tipo: 'critico', titolo: 'Altro modello', testo: 'La fonte dichiara un modello diverso da quello cercato.' });
  if (item.dichiarazione === 'senza-modello')
    out.push({ tipo: 'attenzione', titolo: 'Modello non dichiarato', testo: 'Riconosciuto dal titolo, non dal catalogo della fonte.' });
  if (item.versioneEsito === 'smentita')
    out.push({ tipo: 'critico', titolo: 'Versione diversa', testo: 'L’annuncio dichiara una versione diversa da quella cercata.' });
  else if (item.versioneEsito === 'ignota' || item.dichiarazione === 'versione-non-verificata')
    out.push({ tipo: 'attenzione', titolo: 'Versione non verificata', testo: 'I dati dell’annuncio non permettono di confermare la versione cercata.' });
  return out;
}

function avvisiPulsanteHTML(item) {
  const avvisi = avvisiAnnuncio(item);
  if (!avvisi.length) return '';
  const critico = avvisi.some(a => a.tipo === 'critico') ? ' critico' : '';
  return `<button type="button" class="row-act btn-avvisi${critico}" aria-label="Avvisi sull'annuncio: ${avvisi.length}" aria-expanded="false">${icon('alert')}</button>`;
}

let avvisiAperto = null, avvisiFisso = false;
function nascondiAvvisi(forza = false) {
  if (avvisiFisso && !forza) return;
  const pop = document.getElementById('avvisiAnnuncioPopup');
  if (pop) pop.hidden = true;
  if (avvisiAperto) {
    avvisiAperto.setAttribute('aria-expanded', 'false');
    avvisiAperto.removeAttribute('aria-describedby');
  }
  avvisiAperto = null; avvisiFisso = false;
}
function mostraAvvisi(btn, fisso = false) {
  if (avvisiFisso && avvisiAperto === btn && !fisso) return;
  if (avvisiFisso && avvisiAperto !== btn && !fisso) return;
  const item = trovaResult(btn.closest('[data-url]')?.dataset.url);
  const avvisi = item && avvisiAnnuncio(item);
  if (!avvisi?.length) return;
  let pop = document.getElementById('avvisiAnnuncioPopup');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'avvisiAnnuncioPopup'; pop.className = 'ann-avvisi-pop'; pop.setAttribute('role', 'tooltip');
    document.body.appendChild(pop); // fuori dalla scheda e dalla lista: entrambe tagliano l'overflow
  }
  if (avvisiAperto && avvisiAperto !== btn) nascondiAvvisi(true);
  pop.innerHTML = `<strong>Avvisi sull'annuncio</strong>${avvisi.map(a =>
    `<div class="ann-avviso ann-avviso-${a.tipo}"><b>${escapeHtml(a.titolo)}</b><span>${escapeHtml(a.testo)}</span></div>`).join('')}`;
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${r.top > pop.offsetHeight + 12 ? r.top - pop.offsetHeight - 6 : r.bottom + 6}px`;
  btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-describedby', pop.id);
  avvisiAperto = btn; avvisiFisso = fisso;
}
function alternaAvvisi(btn) {
  if (avvisiAperto === btn && avvisiFisso) nascondiAvvisi(true);
  else mostraAvvisi(btn, true);
}

function rowHTML(item, bestSet) {
  const pr = vPricing(item.prezzo, passDi(item), item);
  // "su richiesta" non e' "n/d": il venditore il prezzo ce l'ha, ha scelto di non scriverlo.
  const prezzoStr = pr ? eurRound(pr.finale) : (item.prezzoSuRichiesta ? 'su richiesta' : 'n/d');
  const fonteLabel = FONTE_LABEL[item.fonte] || item.fonte;
  const fonteTag = { subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[item.fonte] || '';
  const urlSafe = /^https?:\/\//i.test(item.url) ? escapeHtml(item.url) : '#';
  const inConfronto = confronto.some(r => stessoAnnuncio(r, item));
  const isBest = bestSet && bestSet.has(item.url);
  const imgs = Array.isArray(item.immagini) ? item.immagini : [];
  // Foto: chi le ha → thumbnail (click=lightbox). Moto.it ha la cover dalla card, la
  // galleria piena arriva aprendo l'annuncio. Il segnaposto NON fa piu' l'animazione di
  // caricamento: adesso che nessuno arricchisce allo scorrimento, quel luccichio prometteva
  // una foto che non stava arrivando. Subito/AS24 senza foto → stesso segnaposto fermo.
  const thumbHTML = imgs.length
    ? `<button type="button" class="row-thumb" title="Vedi foto"><img src="${escapeHtml(imgs[0].thumb)}" loading="lazy" referrerpolicy="no-referrer" alt=""></button>`
    : '<div class="row-thumb noimg" aria-hidden="true"></div>';

  const conc = item.venditore && /conc/i.test(item.venditore);
  const vendBadge = item.venditore ? `<span class="vend-badge vend-${conc ? 'conc' : 'priv'}">${conc ? 'Conc.' : 'Privato'}</span>` : '';
  const avvisiBtn = avvisiPulsanteHTML(item);
  const sub = [item.provincia ? escapeHtml(item.provincia) : '', vendBadge].filter(Boolean).join(' ');
  const ggV = giorniInVendita(item);
  const subM = [item.anno || null, item.km != null ? `${item.km.toLocaleString('it-IT')} km` : null, item.carburante || null, item.potenzaCv != null ? `${item.potenzaCv} CV` : null, ggV != null ? `in vendita da ${ggV} gg` : null, fonteLabel].filter(Boolean).join(' · ');

  const cell = key => {
    switch (key) {
      case 'foto':    return thumbHTML;
      case 'veicolo': return `<div class="row-main">
          <div class="row-titolo" title="Apri annuncio">${escapeHtml(item.titolo)}</div>
          ${item.variante ? `<div class="row-variante">${escapeHtml(item.variante)}</div>` : ''}
          ${sub ? `<div class="row-sub">${sub}</div>` : ''}
          <div class="row-sub-m">${escapeHtml(subM)}${liqBadgeHTML(item)}</div>
        </div>`;
      case 'anno':   return `<div class="row-cell num muted">${item.anno || '—'}</div>`;
      case 'km':     return `<div class="row-cell num muted">${item.km != null ? item.km.toLocaleString('it-IT') : '—'}</div>`;
      case 'carb':   return `<div class="row-cell muted">${item.carburante ? escapeHtml(item.carburante) : '—'}</div>`;
      case 'cv':     return `<div class="row-cell num muted">${item.potenzaCv != null ? item.potenzaCv : '—'}</div>`;
      case 'prezzo': return `<div class="row-prezzo">${prezzoStr}<span class="row-extra">${priceRowExtraHTML(pr, null, notaIva(item))}</span></div>`;
      case 'fonte':  return `<div class="row-fonte"><span class="tag ${fonteTag}">${escapeHtml(fonteLabel)}</span></div>`;
      case 'azioni': return `<div class="row-actions${avvisiBtn ? ' has-alerts' : ''}">
          ${avvisiBtn}
          <button class="row-act btn-info" title="Dettagli e foto">${icon('info')}</button>
          <button class="row-act btn-confronta${inConfronto ? ' attivo' : ''}" title="Aggiungi al confronto">${icon(inConfronto ? 'square-check' : 'square')}</button>
        </div>`;
      default: return '';
    }
  };
  const cells = activeCols().map(c => cell(c.key)).join('');
  // Pannello dettaglio inline (fisarmonica), sibling full-width nella .result-list.
  return `<div class="result-row${isBest ? ' best' : ''}${inConfronto ? ' selected' : ''}" data-url="${urlSafe}" style="grid-template-columns:${gridTemplate()}">${cells}</div>` +
    `<div class="row-detail d-none" data-url="${urlSafe}" data-detail="1"></div>`;
}

function vistaChipsRender() {
  document.querySelectorAll('#vistaChips .facet-chip').forEach(b => b.classList.toggle('active', b.dataset.vista === vista));
  // In vista schede colonne non ce ne sono: le stesse quattro spunte comandano i campi
  // della riga di dati, e il bottone lo dice invece di promettere una cosa che non c'e'.
  const cols = document.querySelector('.tb-cols-group .tb-cols > summary');
  if (cols) cols.textContent = (vista === 'schede' ? 'Campi' : 'Colonne') + ' ▾';
}

/**
 * LA STESSA RIGA, con la foto grande. Non e' un secondo modo di mostrare gli annunci: e'
 * lo stesso, con altre proporzioni. Classi e attributi restano quelli della riga
 * (`data-url`, `.row-thumb`, `.row-titolo`, `.row-actions`, il `.row-detail` fratello),
   * cosi' lightbox, pannello annuncio e confronto funzionano senza sapere che
 * vista e' attiva — e non ci sono due strade da tenere allineate.
 */
function cardHTML(item, bestSet) {
  const pr = vPricing(item.prezzo, passDi(item), item);
  const urlSafe = /^https?:\/\//i.test(item.url) ? escapeHtml(item.url) : '#';
  const imgs = Array.isArray(item.immagini) ? item.immagini : [];
  const foto = imgs.length     // vedi rowHTML: niente luccichio, la foto piena arriva al clic
    ? `<button type="button" class="row-thumb" title="Vedi foto"><img src="${escapeHtml(imgs[0].thumb)}" loading="lazy" referrerpolicy="no-referrer" alt=""></button>`
    : '<div class="row-thumb noimg" aria-hidden="true"></div>';
  const conc = item.venditore && /conc/i.test(item.venditore);
  const ggV = giorniInVendita(item);
  /**
   * LE STESSE SPUNTE DELLA LISTA, qui applicate alla riga di dati sotto il titolo.
   * In vista schede colonne non ce ne sono, ma i campi facoltativi sono gli stessi
   * quattro: il menu comanda le due viste allo stesso modo invece di restare acceso e
   * non fare niente. I giorni in vendita non sono fra i quattro e restano sempre.
   */
  // `visibleCols` e non `effVisibleCols()`: quest'ultima toglie carburante e CV sotto i
  // 1180px perche' le COLONNE della lista hanno larghezze fisse e sfonderebbero. Qui
  // colonne non ce ne sono — la riga di dati va a capo da sola — quindi la spunta vale
  // a qualunque larghezza, senno' sparirebbe senza che nessuno l'abbia tolta.
  const vis = visibleCols;
  const meta = [vis.includes('anno') ? (item.anno || null) : null,
    vis.includes('km') && item.km != null ? `${item.km.toLocaleString('it-IT')} km` : null,
    vis.includes('carb') ? (item.carburante || null) : null,
    vis.includes('cv') && item.potenzaCv != null ? `${item.potenzaCv} CV` : null,
    ggV != null ? `in vendita da ${ggV} gg` : null].filter(Boolean).join(' · ');
  const inConfronto = confronto.some(r => stessoAnnuncio(r, item));
  const avvisiBtn = avvisiPulsanteHTML(item);
  return `<article class="ann-card${bestSet && bestSet.has(item.url) ? ' best' : ''}${inConfronto ? ' selected' : ''}" data-url="${urlSafe}">
      <div class="ann-foto">${foto}</div>
      <div class="ann-corpo">
        <div class="row-titolo" title="Apri annuncio">${escapeHtml(item.titolo)}</div>
        ${item.variante ? `<div class="ann-variante">${escapeHtml(item.variante)}</div>` : ''}
        <div class="ann-meta">${escapeHtml(meta) || '&nbsp;'}</div>
        <div class="ann-riga">
          <span class="tag ${{ subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[item.fonte] || ''}">${escapeHtml(FONTE_LABEL[item.fonte] || item.fonte)}</span>
          ${item.provincia ? `<span class="ann-dove">${escapeHtml(item.provincia)}</span>` : ''}
          ${item.venditore ? `<span class="vend-badge vend-${conc ? 'conc' : 'priv'}">${conc ? 'Conc.' : 'Privato'}</span>` : ''}
        </div>
        <div class="ann-piede">
          <span class="ann-prezzo">${pr ? eurRound(pr.finale) : (item.prezzoSuRichiesta ? 'su richiesta' : 'n/d')}</span>
          <div class="row-actions${avvisiBtn ? ' has-alerts' : ''}">
            ${avvisiBtn}
            <button class="row-act btn-info" title="Dettagli e foto">${icon('info')}</button>
            <button class="row-act btn-confronta${inConfronto ? ' attivo' : ''}" title="Aggiungi al confronto">${icon(inConfronto ? 'square-check' : 'square')}</button>
          </div>
        </div>
      </div>
    </article>` +
    `<div class="row-detail d-none" data-url="${urlSafe}" data-detail="1"></div>`;
}

/**
 * RIDISEGNA SENZA PORTARE VIA QUELLO CHE STAI LEGGENDO.
 *
 * `renderResults` rifa' l'innerHTML della griglia: con lui spariscono i pannelli degli
 * annunci aperti e, dentro, la scheda tecnica — motorizzazione scelta, ADD ON aperto,
 * conto del passaggio gia' fatto. Succedeva a ogni ridimensionamento della finestra e a
 * ogni spunta nel menu dei campi. Qui si segna cosa era aperto, si ridisegna e si riapre:
 * `toggleDetail` passa da `renderDetailInto`, che riaggancia da sola la scheda
 * all'annuncio che la ospita.
 */
function ridisegnaTenendoAperti() {
  const aperti = [...resultsGrid.querySelectorAll('.row-detail:not(.d-none)')].map(d => d.dataset.url);
  const scorrimento = window.scrollY;
  renderResults(currentResults);
  for (const u of aperti) {
    const riga = resultsGrid.querySelector(`.result-row[data-url="${CSS.escape(u)}"], .ann-card[data-url="${CSS.escape(u)}"]`);
    if (riga) toggleDetail(riga);
  }
  window.scrollTo({ top: scorrimento });
}

// ─── Dettaglio inline (ℹ → fisarmonica sotto la riga, niente salto in cima) ────
function toggleDetail(rowEl) {
  const panel = rowEl.nextElementSibling;
  if (!panel || !panel.classList.contains('row-detail')) return;
  const opening = panel.classList.contains('d-none');
  panel.classList.toggle('d-none');
  rowEl.classList.toggle('detail-open', opening);
  if (opening && panel.dataset.loaded !== '1') {
    const r = trovaResult(rowEl.dataset.url);
    if (r) renderDetailInto(panel, r);
  }
}
function detailSpecsHTML(r) {
  const base = [];
  if (r.prezzo != null) { const _pr = vPricing(r.prezzo, passDi(r), r); base.push(['Prezzo', _pr ? eurRound(_pr.finale) : `€ ${r.prezzo.toLocaleString('it-IT')}`]); }
  // Il MESE quando la fonte lo dice (Subito lo dice sempre): fra gennaio e dicembre
  // dello stesso anno ballano dodici mesi di eta'.
  if (r.anno != null)   base.push(['Immatricolazione', r.mese ? `${String(r.mese).padStart(2, '0')}/${r.anno}` : String(r.anno)]);
  if (r.km != null)     base.push(['Km', `${r.km.toLocaleString('it-IT')} km`]);
  if (r.provincia)      base.push(['Provincia', r.provincia]);
  const extra = Object.keys(SPEC_LABELS).map(k => { const v = specVal(k, r[k]); return v ? [SPEC_LABELS[k], v] : null; }).filter(Boolean);
  // Quanto la fonte dichiara su QUESTO annuncio: se la versione manca, o se il modello
  // e' stato riconosciuto dal titolo invece che dal catalogo, si legge qui — non piu' con
  // una chip in mezzo alla riga dei risultati.
  const dich = corrispondenzaDi(r);
  const dett = r.versioneEsito === 'ignota' || r.versioneEsito === 'smentita' || DICHIARAZIONE[r.dichiarazione]
    ? [['Corrispondenza', dich.et]] : [];
  const all = base.concat(extra, versioneDedottaRiga(r), dett, campiNativi(r));
  if (!all.length) return '<span class="spec-empty">Nessun dettaglio aggiuntivo</span>';
  return coppieHTML(all);
}

/**
 * LA VERSIONE DEDOTTA, e si vede che e' dedotta.
 *
 * Il venditore non ha scelto la versione dal menu, ma l'ha scritta nell'annuncio: il
 * backend la riconosce contro il catalogo di Subito (backend/scrapers/versione-dedotta.js).
 * Sta accanto agli altri dati dell'annuncio perche' e' un dato dell'annuncio, non
 * un'integrazione esterna — ma con l'etichetta che dice da dove viene.
 *
 * Due forme, e non valgono uguale: il nome intero quando era scritto per intero, il solo
 * allestimento quando restano piu' versioni compatibili. "e' una Lounge" e' meno di un
 * nome, ma e' molto piu' di "versione n.d.".
 */
function versioneDedottaRiga(r) {
  const d = r && r.versioneDedotta;
  if (!d || r.variante) return [];
  const nota = 'Non l\'ha dichiarata il venditore: e\' riconosciuta nel testo dell\'annuncio contro il catalogo Subito. ' + (d.perche || '');
  if (d.esito === 'esatta') return [['Versione (dedotta)', d.versione, nota]];
  // "320d" e' la MOTORIZZAZIONE, e il catalogo lo dice da solo (e' la parola con cui apre il
  // nome della versione). Il dato resta, l'etichetta smette di chiamarlo allestimento.
  return d.cosa === 'motorizzazione'
    ? [['Motorizzazione (dedotta)', d.allestimento, nota]]
    : [['Allestimento (dedotto)', d.allestimento, nota]];
}

// ─── Quello che le fonti dicevano e non leggevamo ────────────────────────────
/**
 * Le tre fonti mandano molto piu' di quanto la scheda mostrasse. Niente di tutto
 * questo costa una richiesta in piu': Subito e Autoscout lo dicono nella risposta di
 * ricerca, Moto.it nella pagina-annuncio che il pannello scarica gia'.
 *
 * DOVE VANNO, e non e' un dettaglio estetico: questi sono DATI DELL'ANNUNCIO, come la
 * potenza o il venditore, quindi stanno in chiaro nella scheda insieme agli altri. I
 * blocchi da aprire restano solo per le INTEGRAZIONI ESTERNE — il passaggio di proprieta'
 * (tariffe ACI) e cerchi e gomme (Wheel-Size, EPREL) — che costano una richiesta e
 * riguardano dati che l'annuncio non contiene.
 *
 * REGOLA che vale per tutti: un campo assente NON diventa una riga. "Non dichiarato" e
 * "No" sono due cose diverse — un annuncio che non parla di incidenti non e' un annuncio
 * senza incidenti.
 */
// Il terzo elemento e' un titolo facoltativo: serve ai valori che vanno spiegati (una
// versione dedotta non e' una versione dichiarata, e chi legge deve poterlo sapere).
const coppieHTML = coppie => coppie
  .map(([k, v, tit]) => `<div class="det-spec"${tit ? ` title="${escapeHtml(String(tit))}"` : ''}><span class="det-k">${escapeHtml(String(k))}</span><span class="det-v">${escapeHtml(String(v))}</span></div>`)
  .join('');

const siNo = v => (v == null ? null : (v ? 'Sì' : 'No'));
// Raccoglie [etichetta, valore] scartando i valori assenti. `null` sparisce, `false` no.
function righe(...coppie) {
  return coppie.filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]);
}

// Le fasce dei contatti sono quattro, non tre: "VeryMany" e' comparso solo misurando
// 200 annunci (2 volte). Una fascia non tradotta si stamperebbe in inglese.
const CONTATTI_IT = { Zero: 'nessuna', Some: 'qualcuna', Many: 'molte', VeryMany: 'moltissime' };

/**
 * Tutti i campi nativi in una lista sola, nell'ordine in cui servono: prima i soldi,
 * poi lo stato del mezzo, poi il mercato, poi chi vende.
 *
 * DUE regole che non sono cosmetiche:
 *  - l'IVA si mostra solo quando dice qualcosa. Misurato su Subito: il campo compare
 *    anche su 13 annunci PRIVATI su 37, sempre a "No", e su un privato "IVA esposta: No"
 *    non e' un'informazione (un privato non puo' esporla). Su un concessionario invece
 *    il "No" e' informazione vera: vuol dire regime del margine.
 *  - il "non fumatore" si mostra solo se sì: misurati 87 "false" su 100, e quel "No" non
 *    vuol dire fumatore — vuol dire che il venditore non ha spuntato la casella.
 */
function campiNativi(r) {
  const ivaParla = r.ivaEsposta === true || (r.ivaEsposta === false && r.venditore === 'concessionario');
  const val = r.valutazione;
  const scost = (val && r.prezzo != null) ? r.prezzo - val.mediana : null;
  return righe(
    // Fisco e garanzia — per un operatore e' il prezzo VERO, non il cartellino.
    ['IVA esposta', ivaParla ? siNo(r.ivaEsposta) : null],
    ['Imponibile', r.prezzoNetto != null ? `€ ${r.prezzoNetto.toLocaleString('it-IT')}` : null],
    ['Aliquota IVA', r.ivaAliquota != null ? `${r.ivaAliquota}%` : null],
    ['Garanzia', r.garanziaMesi != null ? (r.garanziaMesi > 0 ? `${r.garanziaMesi} mesi` : 'sì, durata non dichiarata') : (r.garanzia || null)],
    ['Trattabile', siNo(r.trattabile)],
    ['Passaggio', r.tipoOfferta || null],          // Moto.it: dice CHI lo paga
    ['Spedizione', siNo(r.spedizione)],
    // Stato e storia
    ['Senza incidenti', siNo(r.senzaIncidenti)],
    ['Incidentata', siNo(r.incidentata)],
    ['Marciante', siNo(r.marciante)],
    ['Revisione fino a', r.revisioneScadenza],
    ['Tagliandi', r.tagliandi],
    ['Ultimo tagliando', r.ultimoTagliando],
    ['Cinghia distribuzione', r.cinghiaData],
    ['Non fumatore', r.nonFumatore === true ? 'Sì' : null],
    ['Depotenziata', siNo(r.depotenziata)],
    ['Solo uso pista', siNo(r.usoPista)],
    ['ABS', siNo(r.abs)],
    ['Mercato d\'origine', r.mercatoOrigine],
    ['Prodotta', r.dataProduzione],
    // Mercato — sono numeri di AUTOSCOUT e l'etichetta lo dice. Il voto 1-6 che allegano
    // NON si mostra: e' una scala di cui non conosciamo la definizione, e riportarla come
    // se la capissimo sarebbe spacciare un'opinione per dato. Lo scostamento invece e' una
    // sottrazione nostra, non un giudizio.
    ['Mediana Autoscout', val ? `€ ${Number(val.mediana).toLocaleString('it-IT')}` : null],
    ['Scostamento', scost != null ? `${scost > 0 ? '+' : ''}${scost.toLocaleString('it-IT')} €` : null],
    ['Richieste di contatto', r.contatti ? (CONTATTI_IT[r.contatti] || String(r.contatti)) : null],
    // DA QUANTO E' FERMO QUESTO MEZZO. E' il numero con cui si tratta, e finora finiva solo
    // dentro una mediana del piazzale. Sta qui, con gli altri dati di mercato.
    ['In vendita da', (() => {
      const g = giorniInVendita(r);
      return g == null ? null : `${g} giorni · dal ${new Date(r.posted_at).toLocaleDateString('it-IT')}`;
    })()],
    // Chi vende. L'etichetta e' "Nome venditore" e non "Venditore" perche' quella e'
    // gia' presa dal TIPO (privato / concessionario): due righe con lo stesso nome e
    // due contenuti diversi si leggono come un errore.
    ['Nome venditore', r.venditoreNome],
    ['Rif. magazzino', r.refVenditore],
    ['Annunci online', r.venditoreAnnunciOnline],
    ['Annunci pubblicati', r.venditoreAnnunciPubblicati],
    ['Su Moto.it dal', r.venditoreDal],
  );
}

/**
 * Optional: la lista che il venditore ha spuntato, raggruppata come la manda Autoscout.
 *
 * CHIUSO di default, come il testo dell'annuncio: e' un dato dell'annuncio, ma su una
 * berlina tedesca ben accessoriata sono ottanta voci, e aperte spingono in fondo tutto
 * quello che viene dopo. Chiuso si vede che c'e' e quanti sono; aperto si leggono.
 */
function optionalHTML(r) {
  const list = Array.isArray(r.optional) ? r.optional.filter(o => o && o.nome) : [];
  if (!list.length) return '';
  const perCat = new Map();
  for (const o of list) {
    const c = o.categoria || 'Altro';
    if (!perCat.has(c)) perCat.set(c, []);
    perCat.get(c).push(o.nome);
  }
  const corpo = [...perCat.entries()].map(([cat, voci]) =>
    `<div class="opt-cat"><span class="opt-cat-t">${escapeHtml(cat)}</span>`
    + `<div class="opt-voci">${voci.map(v => `<span class="opt-v">${escapeHtml(v)}</span>`).join('')}</div></div>`).join('');
  // Stessa forma richiudibile del testo annuncio (miniHTML): la chiave e' per-annuncio,
  // cosi' aprirne uno non apre quello di tutti gli altri.
  return miniHTML('optional:' + r.url, 'Optional', list.length + (list.length === 1 ? ' voce' : ' voci'), corpo);
}

// Il testo dell'annuncio: quello che il venditore ha voluto scrivere. Alto al massimo
// una ventina di righe, poi scorre da solo — non spinge in basso il resto della scheda.
/**
 * Il testo dell'annuncio, richiudibile. E' un dato nativo, quindi sta qui e non fra le
 * integrazioni — ma sono in media mille caratteri di prosa, e aperti spingono in fondo
 * tutto il resto. Chiuso si vede che c'e'; aperto si legge.
 */
function testoHTML(r) {
  if (r.fonte === 'autoscout' && r.venditore !== 'concessionario') return '';
  const d = (r.descrizione || '').trim();
  if (!d) return '';
  return miniHTML('testo:' + r.url, 'Testo dell\'annuncio', d.length + ' caratteri',
    `<div class="det-testo">${escapeHtml(d)}</div>`);
}

function vetrinaHTML(r) {
  return r.vetrinaUrl
    ? `<a class="det-open" href="${escapeHtml(r.vetrinaUrl)}" target="_blank" rel="noopener noreferrer">Vetrina venditore ↗</a>`
    : '';
}
// ── Passaggio di proprieta' del singolo annuncio ─────────────────────────────
// Potenza e localita' sono gia' scritte nell'annuncio: il costo per metterlo a nome proprio
// si puo' calcolare li', senza andare a cercare provincia e kW da un'altra parte. Non parte
// da solo: e' una richiesta al server, e la fa solo chi la vuole.
// Risultato in cache sull'oggetto annuncio (r._pass): riaprire la riga non ricalcola.
//
// DUE cose che sembrano ovvie e non lo sono:
//  - il TIPO di veicolo va preso dalla RICERCA, non dalla fonte dell'annuncio: cercando moto,
//    Subito e AutoScout rispondono con moto, e trattarle come auto darebbe la tariffa
//    autoveicoli su un mezzo per cui l'IPT non e' nemmeno calcolabile;
//  - l'IPT si paga sulla provincia di RESIDENZA di chi intesta (fonte ACI), non su quella
//    dove sta il venditore. Se l'operatore ha scelto la sua provincia si usa quella; la
//    localita' dell'annuncio e' un ripiego, e si dice sempre quale delle due si sta usando.
// IL TIPO LO DICE L'ANNUNCIO. Prendendolo dall'ultima ricerca, nel parco di un
// concessionario — dove una ricerca non c'e' mai stata — una moto riceveva la tariffa
// autoveicoli e usciva un importo credibile per un conto che sulle moto non si fa.
function passTipo(r) {
  const t = (r && r.tipo) || (lastSearchParams || {}).tipo;
  return (t === 'moto' || (r && r.fonte === 'moto')) ? 'moto' : 'auto';
}
/**
 * LA TUA PROVINCIA PER IL PASSAGGIO, che non e' quella del carburante.
 *
 * Erano la stessa preferenza. Cambiare la tendina dentro "Costo carburante" per confrontare
 * il prezzo al litro spostava anche l'IPT: sono 107 province con quattro aliquote
 * (0/20/25/30%), e su un'auto da 90 kW il passaggio va da 343,07 € ad Aosta a 437,89 € a
 * Viterbo — 94,82 € mossi da una tendina che parlava di benzina. Due domande diverse, due
 * preferenze. La prima volta si eredita quella del carburante, cosi' chi l'aveva gia'
 * impostata non si ritrova il bottone "usa la tua provincia" sparito; da li' in poi vivono
 * separate.
 */
const passProvinciaMia = () => {
  try {
    const p = localStorage.getItem('amrPassProvincia');
    if (p != null) return p;
    const eredita = localStorage.getItem('amrCarbProvincia') || '';
    salvaPref('amrPassProvincia', eredita);
    return eredita;
  } catch (_) { return ''; }
};
function passProvincia(r) {
  const mia = passProvinciaMia();
  if (r._passProvAnnuncio) return { testo: r.provincia || '', mia: false };
  return mia ? { testo: mia, mia: true } : { testo: r.provincia || '', mia: false };
}

async function calcolaPassaggio(r, panel) {
  r._pass = { stato: 'carico' };
  // Il blocco vive dentro ADD ON, cioe' dentro la SCHEDA: ridisegnare l'intero pannello
  // dell'annuncio la butterebbe via e la rimonterebbe a ogni ricalcolo. Si ridisegna solo
  // la scheda; se la scheda non e' di questo annuncio, vale il pannello come prima.
  const disegna = () => {
    if (vehHostUrl === r.url) renderVehBody();
    else if (panel && panel._render) panel._render();
  };
  disegna();
  const pv = passProvincia(r);
  const q = new URLSearchParams({ provincia: pv.testo, tipo: passTipo(r) });
  // marca e modello servono al server per cercare i kW DICHIARATI di listino invece di
  // stimarli dai CV: sulla soglia dei 53 kW la differenza e' una categoria di tariffa.
  // Marca e modello di QUESTO annuncio; la ricerca resta solo come rete.
  const sp = lastSearchParams || {};
  const pMarca = r.marca || sp.marca;
  const pModello = r.modello || r.modelloDichiarato || sp.modello;
  if (pMarca) q.set('marca', pMarca);
  if (pModello) q.set('modello', pModello);
  if (r._passStorico) q.set('storico', '1');
  if (!pv.mia) { const z = r.zip || r.cap; if (z) q.set('cap', String(z)); }   // il CAP e' dell'annuncio
  if (r.potenzaCv > 0) q.set('cv', String(r.potenzaCv));
  // L'anno serve al server per NON chiedere i kW al listino del nuovo quando il veicolo e'
  // troppo vecchio perche' quel listino lo abbia ancora (vedi backend/scrapers/motornet.js).
  if (r.anno) q.set('anno', String(r.anno));
  // A Torino un atto con IVA esposta paga il 20% invece del 30%: per un operatore che compra
  // con fattura e' la normalita', quindi la scelta esiste (e vale solo la' — vedi ipt.js).
  if (r._passIva) q.set('ivaEsposta', '1');
  try {
    const d = await fetch('/api/passaggio?' + q.toString()).then(x => x.json());
    r._pass = { stato: 'ok', d, mia: pv.mia };
  } catch (_) { r._pass = { stato: 'ko' }; }
  if (vehHostUrl === r.url) renderVehBody();
  else if (panel && panel.isConnected && panel._render) panel._render();
  aggiornaNoteRiga(r);
}

// Le sotto-note di prezzo di UNA riga, riscritte in loco: il margine netto di quell'annuncio
// cambia appena si conosce il costo della sua pratica. Un renderResults() qui chiuderebbe il
// pannello da cui e' stato chiesto il calcolo.
function aggiornaNoteRiga(r) {
  if (!r || !r.url) return;
  const pr = vPricing(r.prezzo, passDi(r), r);
  resultsGrid.querySelectorAll(`[data-url="${CSS.escape(r.url)}"]`).forEach(el => {
    if (el.dataset.detail) return;
    el.querySelectorAll('.row-extra').forEach(n => { n.innerHTML = priceRowExtraHTML(pr, null, notaIva(r)); });
  });
}

// ─── Sezioni richiudibili dentro le schede ───────────────────────────────────
// Passaggio di proprieta', cerchi e gomme, costo carburante, passaggi del modello: quattro
// blocchi che stavano sempre aperti e riempivano la scheda anche quando non li guardavi.
//
// Sono la stessa cosa, quindi e' una funzione sola: intestazione cliccabile, il DATO che
// conta scritto li' accanto (cosi' non serve aprire per vederlo) e il dettaglio sotto.
//
// Chiuse di default. Quelle che costano rete non partono all'apertura della scheda: e'
// l'apertura della sezione a farle partire — un click invece di due, e nessuna richiesta
// per chi non la apre.
//
// `toggle` NON risale il DOM: i due ascoltatori sono in cattura, altrimenti non arrivano.
const miniAperte = new Set();

function miniHTML(chiave, titolo, meta, corpo, opts = {}) {
  if (!corpo && !opts.carica) return '';
  const aperta = miniAperte.has(chiave);
  return `<details class="mini"${aperta ? ' open' : ''} data-mini="${escapeHtml(chiave)}"${opts.carica ? ` data-carica="${escapeHtml(opts.carica)}"` : ''}>`
    + `<summary class="mini-h"><span class="mini-t">${escapeHtml(titolo)}</span>`
    + (meta ? `<span class="mini-meta">${meta}</span>` : '')
    + '</summary>'
    + `<div class="mini-b">${corpo || ''}</div></details>`;
}

/** tiene memoria di cosa e' aperto, e fa partire il carico alla prima apertura */
function miniToggle(e, ctx) {
  const d = e.target;
  if (!d || !d.classList || !d.classList.contains('mini')) return;
  const k = d.dataset.mini;
  if (d.open) miniAperte.add(k); else miniAperte.delete(k);
  if (!d.open || !d.dataset.carica) return;
  ctx(d.dataset.carica, d);
}

// Il guscio del blocco "Passaggio di proprieta" stava qui: ora il corpo (`passCorpoHTML`)
// e' dentro ADD ON, unito alla statistica del modello — vedi `vehPassaggiHTML`.
// Il bottone dentro compare solo se i dati per calcolare ci sono davvero: senza potenza o
// senza localita' il conto non si fa, e lo si dice invece di mostrare un pulsante che
// fallisce. Le due spunte (storico, IVA) restano raggiungibili SEMPRE, anche quando il
// calcolo non riesce: sono proprio loro a poterlo far riuscire.

function passCorpoHTML(r) {
  const haPot = r.potenzaCv > 0;
  const st = r._pass;
  const opz = passOpzioniHTML(r);
  if (!st) {
    if (!r.provincia && !passProvinciaMia()) return '';
    if (!haPot && !r._passStorico) {
      return `<div class="det-pass-no">Manca la potenza in questo annuncio: il conto non si fa.</div>${opz}`;
    }
    return `<div class="det-pass-no">Calcolo…</div>${opz}`;
  }
  if (st.stato === 'carico') return '<div class="det-pass-no">Calcolo…</div>';
  if (st.stato === 'ko') {
    return `<div class="det-pass-no">Calcolo non riuscito (rete).</div>`
      + `<button type="button" class="det-act btn-passaggio"><span class="ra-txt">Riprova</span></button>${opz}`;
  }
  const d = st.d || {};
  if (!d.ok) return `<div class="det-pass-no">Non calcolabile: ${escapeHtml(d.motivo || 'dati insufficienti')}.</div>`
    + `${passAvvisiHTML(d)}${opz}`;
  const eur = n => Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const loc = d.localita || {};
  // Da quale provincia viene l'importo, e come si passa all'altra: la differenza tra le due
  // sono euro veri (dallo 0% di Bolzano al 30% di quasi tutte le altre).
  const altra = st.mia ? (r.provincia || '') : passProvinciaMia();
  const scambio = altra
    ? ` <button type="button" class="det-pass-alt" data-alt="${st.mia ? 'annuncio' : 'mia'}">usa ${st.mia ? `la provincia dell'annuncio (${escapeHtml(altra)})` : `la tua provincia (${escapeHtml(altra)})`}</button>`
    : '';
  /**
   * SOLO I NUMERI. Qui c'erano cinque righe di prosa attorno a tre cifre: da dove viene la
   * potenza, chi paga l'IPT e su quale residenza, la fonte, cosa non e' incluso. Roba giusta
   * ma spiegata ogni volta a chi il conto lo conosce meglio di noi. Restano l'importo, i due
   * addendi, la provincia con il bottone per cambiarla, e gli avvisi — che non sono prosa:
   * sono condizioni che cambiano quanto paghi.
   */
  return `<div class="det-pass-box">
    <div class="pp-tot"><b>${eur(d.totaleNoto)} €</b><span class="pp-tot-lab">per metterlo a nome tuo</span></div>
    <div class="pp-voci">
      <span class="pp-voce"><em>IPT</em>${eur(d.ipt)} €</span>
      <span class="pp-piu">+</span>
      <span class="pp-voce"><em>emolumenti</em>${eur(d.emolumenti)} €</span>
    </div>
    <div class="det-pass-det">${passProvSelHTML(loc.sigla || '', st.mia)}${scambio}</div>
    ${opz}
    ${passAvvisiHTML(d)}
  </div>`;
}

/**
 * La sigla della provincia da cui viene l'importo: scegliibile quando e' LA TUA, ferma
 * quando e' quella dell'annuncio (quella la decide il venditore, non tu — per cambiarla c'e'
 * il bottone accanto). Prima l'unico modo di dire quale fosse "la tua" era la tendina del
 * carburante, che pero' parla d'altro: separate le due preferenze, serviva un posto per
 * dirlo, ed e' questo — accanto al numero che decide.
 *
 * L'elenco e' quello dell'indice carburanti (le stesse 107 province della tabella IPT): e'
 * gia' scaricato o si scarica da se'. Finche' non c'e', resta la sigla scritta.
 */
function passProvSelHTML(sigla, mia) {
  const prov = (carbIdx && carbIdx.province) ? Object.keys(carbIdx.province).sort() : [];
  if (!mia || !prov.length) {
    if (mia && carbStato === 'mai') loadCarburanti();   // serve l'elenco: si chiede una volta sola
    return `<span class="pp-prov">${escapeHtml(sigla)}</span>`;
  }
  return `<select class="pp-prov pp-prov-sel" aria-label="la tua provincia per il costo del passaggio">`
    + prov.map(x => `<option value="${escapeHtml(x)}"${x === sigla ? ' selected' : ''}>${escapeHtml(x)}</option>`).join('')
    + '</select>';
}

// TUTTI gli avvisi, non solo il primo: sono condizioni verificate su fonte (uso professionale,
// passaggi consecutivi, decadenza dei ventennali) e ognuna puo' cambiare l'importo dovuto.
function passAvvisiHTML(d) {
  const a = (d && d.avvisi) || [];
  if (!a.length) return '';
  return `<div class="det-pass-avviso">${a.map(x => escapeHtml(x)).join('<br>')}</div>`;
}

function passOpzioniHTML(r) {
  const iva = passIvaHTML(r);
  const st = passStoricoHTML(r);
  return (iva || st) ? `<div class="det-pass-opz">${st}${iva}</div>` : '';
}

// La scelta IVA cambia l'importo SOLO a Torino (unica provincia con due aliquote): si mostra
// dove serve, non su tutte le altre 106 dove non cambierebbe nulla.
function passIvaHTML(r) {
  const sig = (r._pass && r._pass.d && r._pass.d.localita && r._pass.d.localita.sigla) || null;
  if (sig !== 'TO' && !r._passIva) return '';
  return `<label class="det-pass-opzv"><input type="checkbox" class="pass-iva-chk"${r._passIva ? ' checked' : ''}> atto con IVA esposta (fattura)</label>`;
}

// La riduzione per veicoli storici (51,65 € auto / 25,82 € moto) vale oltre i 30 anni, e
// l'anno di questo annuncio lo sappiamo: la spunta compare solo dove ha senso. Resta manuale
// perche' la riduzione NON spetta ai veicoli usati nell'attivita' d'impresa: lo sa l'operatore,
// non il programma. Le moto non storiche non sono calcolabili affatto, quindi li' la spunta e'
// l'unica via a un importo: si mostra anche senza anno.
function passStoricoHTML(r) {
  const eta = r.anno > 1900 ? new Date().getFullYear() - r.anno : null;
  // Per le moto la spunta e' l'UNICA strada a un importo (le non storiche non sono
  // calcolabili), quindi si mostra anche senza anno.
  const plausibile = (eta != null && eta >= 30) || (passTipo(r) === 'moto');
  if (!plausibile && !r._passStorico) return '';
  return `<label class="det-pass-opzv"><input type="checkbox" class="pass-storico-chk"${r._passStorico ? ' checked' : ''}>`
    + ` veicolo storico${eta != null ? ` (${eta} anni)` : ' (oltre 30 anni)'}, non usato nell'attivita'</label>`;
}

// ─── Cerchi, gomme e pneumatici, dentro l'annuncio ───────────────────────────
// Wheel-Size vuole marca, modello e anno di UN'AUTO: sono esattamente i dati che un
// annuncio ha per forza. Chiederli di nuovo in un'altra sezione era far ridigitare
// all'utente cio' che l'app gia' sa.
//
// NON PARTE DA SOLA, come il passaggio di proprieta': e' una richiesta in rete, e la fa
// solo chi la vuole. Stessa cosa per l'etichetta europea del pneumatico: la misura
// diventa un bottone, e la ricerca parte se la si preme.
//
// La misura non ha bisogno di essere ripulita: Wheel-Size la scrive "175/65R15" ed EPREL
// accetta quella stringa cosi' com'e' — verificato, 100 pneumatici in risposta.
//
// Il risultato resta sull'oggetto annuncio (r._gomme, r._pneu): riaprire la riga non
// ricarica niente.

/**
 * MARCA E MODELLO DI QUESTO ANNUNCIO, una regola sola per chiunque debba chiedere qualcosa
 * a una fonte esterna a nome di un annuncio (gomme, liquidita', e chi verra').
 *
 * La chiave la dice l'ANNUNCIO, non l'ultima ricerca. Nel parco di un concessionario gli
 * annunci non vengono da una ricerca, e `lastSearchParams` restava quello di prima: aprendo
 * una Fiat Panda dopo aver cercato una BMW 320d, sotto la Panda comparivano cerchi, gomme e
 * pressioni della BMW, attribuiti a lei. Stessa forma gia' usata da passTipo e loadVehScheda.
 */
function coppiaAnnuncio(r) {
  const p = lastSearchParams || {};
  // La MARCA di catalogo vince quando c'e' (doSearch rifiuta una ricerca senza marca a
  // catalogo, quindi in griglia e' sempre valorizzata e canonica); nel parco si spegne e vale
  // quella dell'annuncio. Facendo vincere sempre l'annuncio si peggiorava la griglia normale,
  // dove `r.marca` e' il nome grezzo della fonte e non quello del catalogo.
  const marca = p.marca || (r && r.marca) || '';
  // Il MODELLO invece lo dice l'annuncio: chiedere le misure del modello CERCATO sotto un
  // annuncio marcato "altro modello" significa mostrare i dati di un altro veicolo. Il
  // modello della ricerca vale solo quando la fonte ha confermato che l'annuncio e' quello,
  // ed e' la stessa regola che usa `loadVehScheda`.
  const confermato = !r || !r.dichiarazione || ['esatto', 'senza-versione', 'versione-non-verificata'].includes(r.dichiarazione);
  const modello = modelloAnnuncio(r) || (confermato ? p.modello : '') || '';
  // 'Altro' e' il segnaposto di Subito quando il venditore la marca non l'ha scelta: non e'
  // una marca, e chiederla a una fonte darebbe una risposta a caso o nessuna.
  return { marca: marca === 'Altro' ? '' : marca, modello };
}

/** marca e modello dall'annuncio (vedi `coppiaAnnuncio`), l'anno dall'annuncio. */
function gommeChiave(r) {
  if (passTipo(r) !== 'auto') return null;                    // Wheel-Size qui e' solo auto
  const { marca, modello } = coppiaAnnuncio(r);
  if (!marca || !modello || !r.anno) return null;
  return { marca, modello, anno: r.anno };
}

function gommePneuHTML(r, misura) {
  const st = (r._pneu || {})[misura];
  if (!st) return '';
  if (st.stato === 'carico') return '<div class="gom-pneu"><span class="gom-att">cerco le etichette…</span></div>';
  if (st.stato === 'ko') return '<div class="gom-pneu"><span class="gom-att">etichette non disponibili ora</span></div>';
  const p = st.d || [];
  if (!p.length) return '<div class="gom-pneu"><span class="gom-att">nessun pneumatico registrato con questa misura</span></div>';
  /**
   * IL NUMERO DELL'ARCHIVIO, non quello della pagina che abbiamo chiesto.
   *
   * Qui usciva `p.length`, cioe' quanti ne abbiamo scaricati: la fonte ne manda cento per
   * volta, quindi una misura con quattromila pneumatici registrati diceva "100 pneumatici
   * registrati". EPREL il totale lo dichiara (`totale`), e viaggiava gia' nella risposta.
   */
  const quanti = (st.totale != null && st.totale > p.length) ? st.totale : p.length;
  return '<div class="gom-pneu"><div class="gom-pneu-h">' + quanti.toLocaleString('it-IT')
    + ' pneumatici registrati · etichetta europea EPREL' + (quanti > p.length ? ' · ne mostro ' + Math.min(p.length, 8) : '') + '</div>'
    + p.slice(0, 8).map(x => `<div class="gom-pneu-r"><span class="gom-pneu-m">${escapeHtml([x.marca, x.modello].filter(Boolean).join(' ')).slice(0, 46)}</span>`
        + `<span class="gom-pneu-v">${escapeHtml(x.classeEfficienza || '—')}<em>consumo</em></span>`
        + `<span class="gom-pneu-v">${escapeHtml(x.classeBagnato || '—')}<em>bagnato</em></span>`
        + `<span class="gom-pneu-v">${x.rumoreDb ? escapeHtml(String(x.rumoreDb)) + ' dB' : '—'}<em>rumore</em></span>`
        + (x.neve ? '<span class="gom-pneu-s" title="marcatura 3PMSF">❄︎</span>' : '')
        + '</div>').join('')
    + (p.length > 8 ? `<div class="gom-att">e altri ${p.length - 8} · lista limitata dall'area demo</div>` : '') + '</div>';
}

function gommeHTML(r) {
  const k = gommeChiave(r);
  if (!k) return '';
  const st = r._gomme;
  const calz = (st && st.stato === 'ok') ? ((st.d && st.d.calzate) || []).filter(c => c.misura) : [];
  const misure = new Set(calz.map(c => c.misura));
  const meta = misure.size ? `${misure.size} misure` : '';
  return miniHTML('gom:' + r.url, 'Cerchi e gomme', meta, gommeCorpoHTML(r, k), { carica: 'gomme' });
}

function gommeCorpoHTML(r, k) {
  const st = r._gomme;
  if (!st) return '<div class="gom-att">Cerco cerchi e gomme…</div>';
  if (st.stato === 'carico') return '<div class="gom-att">Cerco cerchi e gomme…</div>';
  if (st.stato === 'ko') return '<div class="gom-att">Fonte non raggiungibile.</div>'
    + '<button type="button" class="det-act btn-gomme"><span class="ra-txt">Riprova</span></button>';
  const d = st.d || {};
  const calz = (d.calzate || []).filter(c => c.misura);
  if (!calz.length) {
    // ZERO MISURE HA DUE CAUSE, E NON SI DICONO CON LA STESSA FRASE. Lo scraper accende
    // `sospetto` quando la pagina ha le generazioni ma nessuna riga leggibile: li' e' il NOSTRO
    // parser a non sapere piu' leggere la tabella, e la frase qui sotto affermerebbe un fatto sul
    // veicolo partendo da un guasto nostro. Un modello che Wheel-Size non ha risponde 404 e
    // finisce nel ramo `ko`: un vuoto con `sospetto` non e' mai «questo mezzo non ha calzate».
    if (d.sospetto) return `<div class="gom-att">Misure non leggibili adesso: ${escapeHtml(d.sospetto)}.</div>`;
    // Wheel-Size mette la misura in chiaro solo sul primo allestimento di ogni generazione:
    // se qui non ce n'e' nessuna, dirlo e' l'unica cosa onesta — un riquadro vuoto no.
    // Il nome che si dice deve essere quello DAVVERO interrogato: il server ripulisce il
    // suffisso di generazione ("Panda 3ª serie" → "Panda"), e scrivere qui il nome grezzo
    // farebbe cercare all'utente un errore dove non c'e'.
    const nome = (d && d.modello) || k.modello;
    return `<div class="gom-att">Nessuna misura in chiaro per ${escapeHtml(k.marca)} ${escapeHtml(nome)} ${k.anno}`
      + ((d.calzate || []).length ? ` (la fonte elenca ${d.calzate.length} allestimenti ma senza misura)` : '') + '.</div>';
  }
  // una riga per MISURA distinta: la stessa gomma torna su piu' allestimenti
  const per = new Map();
  for (const c of calz) {
    if (!per.has(c.misura)) per.set(c.misura, { cerchi: new Set(), press: new Set() });
    if (c.cerchio) per.get(c.misura).cerchi.add(c.cerchio);
    if (c.pressioneAntBar) per.get(c.misura).press.add(c.pressioneAntBar + (c.pressionePostBar ? ' / ' + c.pressionePostBar : '') + ' bar');
  }
  return '<div class="gom"><div class="gom-h"><span class="gom-src">Wheel-Size</span>'
    + '<span class="gom-hint">clicca una misura per l\'etichetta europea</span></div>'
    + [...per.entries()].map(([mis, v]) => `<div class="gom-riga">
        <button type="button" class="gom-mis" data-misura="${escapeHtml(mis)}">${escapeHtml(mis)}</button>
        <span class="gom-det">${escapeHtml([...v.cerchi].slice(0, 3).join(' · '))}${v.press.size ? ' — ' + escapeHtml([...v.press].slice(0, 2).join(' · ')) : ''}</span>
      </div>${gommePneuHTML(r, mis)}`).join('')
    + (d.nota ? `<div class="gom-att">${escapeHtml(d.nota)}</div>` : '') + '</div>';
}

async function caricaGomme(r, pannello) {
  const k = gommeChiave(r); if (!k) return;
  r._gomme = { stato: 'carico' };
  pannello?._render?.();
  try {
    const d = await fetch(`/api/fonti/cerchi/calzate?marca=${encodeURIComponent(k.marca)}`
      + `&modello=${encodeURIComponent(k.modello)}&anno=${encodeURIComponent(k.anno)}`).then(x => x.json());
    r._gomme = d && d.ok !== false ? { stato: 'ok', d } : { stato: 'ko' };
  } catch (_) { r._gomme = { stato: 'ko' }; }
  pannello?._render?.();
}

async function caricaPneumatico(r, misura, pannello) {
  r._pneu = r._pneu || {};
  if (r._pneu[misura]) { delete r._pneu[misura]; pannello?._render?.(); return; }   // secondo click: chiudi
  r._pneu[misura] = { stato: 'carico' };
  pannello?._render?.();
  try {
    const d = await fetch('/api/fonti/pneumatici/cerca?misura=' + encodeURIComponent(misura)).then(x => x.json());
    r._pneu[misura] = (d && d.ok !== false) ? { stato: 'ok', d: d.pneumatici || [], totale: d.totale ?? null } : { stato: 'ko' };
  } catch (_) { r._pneu[misura] = { stato: 'ko' }; }
  pannello?._render?.();
}

/**
 * DA QUANDO E' IN VENDITA QUESTO MEZZO — il singolo, non la mediana del piazzale.
 * Autoscout dichiara la prima pubblicazione; Moto.it la dice nella pagina dell'annuncio e
 * arriva con l'arricchimento della riga. Su Subito no: li' quella data si azzera a ogni
 * rilancio (misurato: 27 auto tutte "pubblicate oggi"), e mostrarla sarebbe un numero falso.
 */
function giorniInVendita(r) {
  if (!r || !r.posted_at || r.fonte === 'subito') return null;
  const g = Math.round((Date.now() - new Date(r.posted_at).getTime()) / 86400000);
  return Number.isFinite(g) && g >= 0 && g < 4000 ? g : null;
}

function renderDetailInto(panel, r) {
  panel.dataset.loaded = '1';
  const renderBody = () => {
    const gallery = (Array.isArray(r.immagini) && r.immagini.length)
      ? `<div class="det-gallery">${r.immagini.slice(0, 8).map(im => `<img src="${escapeHtml(im.thumb)}" loading="lazy" referrerpolicy="no-referrer" alt="">`).join('')}</div>`
      : '';
    const openBtn = /^https?:\/\//i.test(r.url) ? `<a class="det-open" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Apri annuncio ↗</a>` : '';
    // Hub azioni nel pannello (unico accesso su mobile dove la riga non ha bottoni).
    const inConf = confronto.some(x => stessoAnnuncio(x, r));
    const confBtn = `<button type="button" class="det-act btn-confronta${inConf ? ' attivo' : ''}">${icon(inConf ? 'square-check' : 'square')}<span class="ra-txt">${inConf ? 'Nel confronto' : 'Confronta'}</span></button>`;
    panel.innerHTML = `<div class="det-inner">${gallery}<div class="det-specs">${detailSpecsHTML(r)}</div>`
      /**
       * I BLOCCHI RICHIUDIBILI IN GRIGLIA, non in colonna.
       *
       * Optional, testo, passaggio e cerchi erano quattro <div> uno sotto l'altro: su uno
       * schermo largo restavano quattro righe alte una riga, con mezzo pannello vuoto a
       * destra, e per arrivare all'ultimo si scorreva. E' la stessa griglia che l'area
       * ADD ON usa gia' (`auto-fit` a 290px): dove c'e' spazio si affiancano, dove non
       * c'e' tornano in colonna da soli.
       * Da qui in giu' ci sono anche le INTEGRAZIONI ESTERNE: costano una richiesta e non
       * stanno nell'annuncio, quindi restano richiudibili e non partono da sole.
       */
      + `<div class="det-blocchi">${optionalHTML(r)}${testoHTML(r)}`
      + `<div class="det-gomme">${gommeHTML(r)}</div></div>`
      // La vetrina del venditore sono BOTTONI, non un blocco richiudibile: resta fuori
      // dalla griglia, sulla sua riga.
      + `<div class="det-fonte">${vetrinaHTML(r)}</div>`
      // LA SCHEDA TECNICA di QUESTO annuncio: sta qui e non nella ricerca, perche' i
      // vincoli con cui si trova la motorizzazione giusta li dichiara l'annuncio. Pigra:
      // niente parte finche' non premi. Quando si apre e' larga quanto il pannello, quindi
      // resta fuori dalla griglia: dentro finirebbe schiacciata in una colonna da 290px.
      + `<div class="det-scheda">${vehHostUrl === r.url ? '' : '<button type="button" class="det-scheda-apri">Scheda tecnica</button>'}</div>`
      + `<div class="det-foot">${openBtn}${confBtn}</div></div>`;
  };
  panel._render = () => {
    renderBody();
    // Se questo pannello ospitava la scheda, il re-render ha appena buttato via il suo
    // contenitore: si riaggancia e si ridisegna, altrimenti la scheda sparisce al primo
    // ricalcolo del passaggio di proprieta'.
    if (vehHostUrl === r.url) {
      const h = panel.querySelector('.det-scheda');
      if (h) { vehHost = h; renderVehScheda(); }
    }
  };
  // SEMPRE `panel._render()`, mai `renderBody()` da fuori: il solo corpo butta via il
  // contenitore della scheda tecnica senza riagganciarla, e siccome l'annuncio risulta
  // ancora il suo proprietario al posto del bottone resta il vuoto — la scheda spariva e
  // non c'era piu' modo di richiederla.
  panel._render();   // apertura immediata (cover + dati on-search) → niente freeze del click
  // Moto.it: galleria piena + spec dalla pagina-dettaglio. Riusa enrichMotoRow (merge
  // immagini+spec, cache 12h server, aggiorna anche il thumb della riga); poi ri-rende.
  if (r.fonte === 'moto' && !r._enriched && /^https?:/.test(r.url || '')) {
    enrichMotoRow(r.url).then(() => { if (panel.isConnected) panel._render(); });
  }
}

function openAd(url) { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); }

// Il prezzo min/max in toolbar non c'e' piu': ripeteva la prima e l'ultima riga della
// griglia ordinata per prezzo. `updateStats` resta come punto unico da cui chiamare, se
// un giorno torna una statistica che aggiunge qualcosa.
function updateStats() {}
