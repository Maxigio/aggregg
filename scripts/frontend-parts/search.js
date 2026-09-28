
// ─── Raggruppamento ──────────────────────────────────────────────────────────
/**
 * IL MODELLO CHE L'ANNUNCIO DICHIARA — non uno indovinato dal titolo.
 *
 * Qui c'era `clusterModello(titolo)`: prendeva la prima parola con una lettera e la prima
 * con una cifra. Misurato su 200 Volkswagen veri, ne usciva questo:
 *   "volkswagen 1"    38 annunci — la Golf 1.2, la Golf 1.0 e la Passat 1.6 nello stesso mucchio
 *   "volkswagen 5p"   32 annunci — le cinque porte
 *   "volkswagen 2013"  6 annunci — l'anno
 * Settanta gruppi con etichette che non esistono da nessuna parte, scritte in minuscolo e
 * senza accenti perche' erano token, non nomi.
 *
 * Il modello lo dichiarano 198 annunci su 200, e sono gli stessi nomi che usa il resto
 * dell'app (`modelloAnnuncio`, gia' regola per scheda, gomme e liquidita'). Le generazioni
 * restano distinte — "Golf" e "Golf 7ª serie" sono due gruppi — perche' e' quello che la
 * fonte dichiara, e unirle vorrebbe dire decidere noi al posto sua. Quarantasei gruppi, coi
 * nomi veri. Chi non lo dichiara finisce in "Modello non dichiarato": due su duecento.
 */
function modelloGruppo(r) {
  return modelloAnnuncio(r) || 'Modello non dichiarato';
}
function bucketKm(km) {
  if (km == null) return 'Km non indicati';
  if (km < 50000) return '< 50.000 km';
  if (km < 100000) return '50.000 – 100.000 km';
  if (km < 150000) return '100.000 – 150.000 km';
  if (km < 200000) return '150.000 – 200.000 km';
  return '> 200.000 km';
}
function bucketAnno(anno) {
  if (anno == null) return 'Anno non indicato';
  if (anno >= 2020) return 'Dal 2020';
  if (anno >= 2015) return '2015 – 2019';
  if (anno >= 2010) return '2010 – 2014';
  if (anno >= 2000) return '2000 – 2009';
  return 'Prima del 2000';
}
function groupKeyFn(dim) {
  switch (dim) {
    case 'fonte':      return r => FONTE_LABEL[r.fonte] || r.fonte;
    case 'carburante': return r => r.carburante || 'Carburante non indicato';
    case 'km':         return r => bucketKm(r.km);
    case 'anno':       return r => bucketAnno(r.anno);
    case 'provincia':  return r => r.provincia || 'Zona non indicata';
    case 'modello':    return modelloGruppo;
    default:           return null;
  }
}
function groupResults(results, dim) {
  const keyFn = groupKeyFn(dim);
  if (!keyFn) return null;
  const map = new Map();
  for (const r of results) { const k = keyFn(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); }
  const groups = [...map.entries()].map(([key, items]) => {
    const prezzi = items.map(i => i.prezzo).filter(p => p != null && p > 0);
    return { key, items, minPrezzo: prezzi.length ? Math.min(...prezzi) : null };
  });
  groups.sort((a, b) => (a.minPrezzo ?? Infinity) - (b.minPrezzo ?? Infinity));
  return groups;
}

/**
 * I RAGGRUPPAMENTI, gli stessi per auto e moto — e non e' una svista, e' una misura.
 *
 * "Carburante" sulle moto e' quasi morto (sono tutte benzina) e la CILINDRATA, che su una
 * moto e' il primo dato che si guarda, qui non c'e'. La correzione sembrava ovvia: scambiare
 * i due chip quando si guardano moto. Provata sui dati veri, non si puo' fare — misurato su
 * una ricerca Yamaha MT-07, 239 annunci:
 *
 *   Subito     100 annunci → cilindrata dichiarata su   0
 *   Autoscout  100 annunci → cilindrata dichiarata su  40
 *   Moto.it     39 annunci → cilindrata dichiarata su   0
 *
 * Un chip "Cilindrata" farebbe un gruppo "non indicata" da 199 su 239: peggio del chip morto
 * che sostituisce. E il campo `tipo` non arriva da NESSUNA fonte (0 su 239), quindi nemmeno
 * si potrebbe decidere dai risultati se mostrarlo.
 *
 * Prima viene il dato: la cilindrata Subito e Moto.it la scrivono nel titolo ("MT-07 689"),
 * e va letta li' — e' un lavoro sugli scraper, non sui chip. Fino ad allora questi restano.
 */
const FACET_DIMS = [
  ['', 'Nessuno'], ['modello', 'Modello'], ['fonte', 'Fonte'],
  ['carburante', 'Carburante'], ['anno', 'Anno'], ['km', 'Km'], ['provincia', 'Provincia'],
];
function renderFacetChips() {
  if (!facetChipsEl) return;
  facetChipsEl.innerHTML = FACET_DIMS.map(([dim, label]) =>
    `<button type="button" class="facet-chip${dim === groupDim ? ' active' : ''}" data-dim="${dim}">${label}</button>`).join('')
    // QUANTI SONO, scritto nel chip. Misurato su annunci veri: su cento Golf usate Autoscout
    // ne dichiara zero con IVA esposta e cento in margine, Subito venticinque in margine e
    // settantacinque che non lo dicono. Senza il numero davanti, chi clicca vede una lista
    // vuota e pensa che il filtro sia rotto: cosi' invece sa prima di premere.
    + (() => {
        const n = (currentResults || []).filter(r => r.ivaEsposta === true).length;
        const dis = n === 0 && !soloIva ? ' facet-chip-vuoto' : '';
        return `<button type="button" class="facet-chip${soloIva ? ' active' : ''}${dis}" data-iva="1"`
          + ` title="Solo annunci con IVA esposta: quelli su cui l'imposta la scarichi. In questa ricerca sono ${n}.">Solo IVA esposta <b>${n}</b></button>`;
      })();
}

// ─── Modi di ricerca ──────────────────────────────────────────────────────────
function selectPrimary(mode) {
  const primary = mode === 'moto' ? 'moto' : 'auto';
  document.querySelectorAll('#modeToggle .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === primary));
  const radio = document.getElementById(primary === 'moto' ? 'tipoMoto' : 'tipoAuto');
  if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
  try {
    localStorage.setItem('amrModoTipo', currentTipo());
  } catch (_) {}
  sincronizzaFiltriAuto(currentTipo());
  btnCerca.textContent = 'Cerca';
  modelloSelect.placeholder =
    currentTipo() === 'moto' ? 'Modello — es. MT-07 (opzionale)' : 'Modello — es. 318d (opzionale)';
}

function scaricaPdf(payload) {
  return fetch('/api/report-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(async r => {
    if (r.ok) return r.blob();
    const d = await r.json().catch(() => ({}));
    throw new Error(typeof d.error === 'string' ? d.error : 'HTTP ' + r.status);
  })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: payload.nome || 'automotoradar.pdf' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })
    .catch(e => { console.error('[pdf]', e); showError('PDF non generato: ' + e.message); });
}

// ─── Ricerca ──────────────────────────────────────────────────────────────────
let searchGen = 0;   // review: token di generazione — solo la ricerca PIÙ RECENTE applica i risultati
/**
 * "CARICA ALTRI ANNUNCI" — la fetta successiva, chiesta quando la chiedi tu.
 *
 * NON e' una pagina 2 che sostituisce la 1, ed e' una scelta, non una scorciatoia:
 * l'app ordina per prezzo e FONDE tre fonti, quindi la fetta successiva di Subito puo'
 * contenere un'auto piu' economica dell'ultima di Autoscout. Con le pagine vedresti un
 * prezzo piu' basso DOPO uno piu' alto; aggiungendo e riordinando l'ordine resta vero.
 *
 * Il bottone compare solo se una fonte ha ancora roba: il totale ce l'abbiamo dalle
 * risposte, quindi non si tira a indovinare.
 */
let fettaPresa = 0;            // ultima fetta caricata (0 = la prima ricerca)
const MAX_FETTE = 50;          // stesso tetto di parseSearchParams: oltre il server ripeterebbe la fetta 50
let caricandoAltri = false;
let paginaErrore = null;
let paginaRetryTimer = null;
let paginaSubitoInSospeso = null; // solo righe normalizzate della pagina nativa riuscita
let paginaFontiInSospeso = null; // porzioni complete della sola pagina da riprovare

function fontiConAltri() {
  const s = lastSources || {};
  return ['subito', 'autoscout', 'moto'].filter(f => {
    const x = s[f];
    return x && (x.status === 'ok' || x.status === 'empty') && x.hasMore === true;
  });
}
function altriDisponibili() { return fontiConAltri().length > 0; }
// Quanti ne abbiamo gia' presi da quella fonte, contando tutte le fette caricate.
function presiDa(fonte) {
  return currentResults.filter(r => r.fonte === fonte).length;
}

// Il retry conserva solo la pagina incompleta, non un archivio delle ricerche.
// Le colonne complete restano qui anche se la pausa supera il TTL della cache server.
function completaPagina(data, fonti, fetta) {
  const attesa = paginaFontiInSospeso;
  if (attesa) {
    data.risultati = attesa.risultati.concat(data.risultati);
    data.sources = { ...data.sources, ...attesa.sources };
  }
  const fallita = s => s && (s.status === 'error' || s.status === 'timeout' || s.parzialeRete
    || (s.status === 'skipped' && s.pausa?.fermo));
  if (paginaSubitoInSospeso && !fallita(data.sources.subito)) {
    const p = paginaSubitoInSospeso;
    const s = data.sources.subito;
    data.risultati = p.risultati.concat(data.risultati);
    data.sources.subito = { ...s, status: p.risultati.length ? 'ok' : s.status,
      count: p.risultati.length + (s.count || 0), totale: p.source.totale ?? s.totale,
      mainNextStart: p.source.mainNextStart,
      hasMore: p.source.mainNextStart != null || s.recuperoNextStart != null };
    paginaSubitoInSospeso = null;
  }
  const cadute = (attesa?.fonti || fonti).filter(f => fallita(data.sources[f]));
  if (cadute.length) {
    const s = data.sources.subito;
    if (!paginaSubitoInSospeso && fonti.includes('subito')
        && s?.parzialeRete && s.errori?.some(e => e.fase === 'recupero')) {
      paginaSubitoInSospeso = { risultati: data.risultati.filter(r => r.fonte === 'subito'),
        source: s, recuperoStart: s.recuperoNextStart };
    }
    const complete = Object.fromEntries(Object.entries(data.sources).filter(([, s]) =>
      (s.status === 'ok' || s.status === 'empty') && !fallita(s)));
    paginaFontiInSospeso = { fetta, fonti: attesa?.fonti || fonti, sources: complete,
      risultati: data.risultati.filter(r => complete[r.fonte]) };
    const fonte = cadute.map(f => FONTE_LABEL[f] || f).join(' e ');
    const stati = cadute.map(f => data.sources[f]);
    const errori = cadute.flatMap(f => {
      const s = data.sources[f];
      return (Array.isArray(s.errori) && s.errori.length ? s.errori
        : [{ http: s.erroreHttp, tipo: s.erroreTipo }]).map(e => ({ ...e, fonte: f }));
    });
    const bloccata = stati.find(s => s.erroreHttp === 429 || s.pausa?.fermo
      || (Array.isArray(s.errori) && s.errori.some(e => e.http === 429)));
    const troppoGrande = stati.some(s => s.erroreCodice === 'SUBITO_BODY_TOO_LARGE'
      || s.erroreCodice === 'AS24_BODY_TOO_LARGE' || s.erroreCodice === 'MOTO_BODY_TOO_LARGE');
    const definitiva = errori.some(e => e.http === 403 || e.tipo === 'auth' || e.tipo === 'error');
    const transitoria = errori.every(e => e.tipo === 'transient' || e.http >= 500)
      || stati.every(s => s.status === 'timeout');
    const riprovabile = !definitiva && (!!bloccata || transitoria);
    const fino = bloccata && Number(bloccata.pausa?.fino);
    const dopo = bloccata
      ? (Number.isSafeInteger(fino) && fino > Date.now() && fino < 8640000000000000 ? fino : Date.now() + 60000)
      : Date.now() + 15000;
    const motivo = troppoGrande ? 'risposta della fonte oltre il limite di dimensione'
      : errori.some(e => e.http === 403) ? 'accesso rifiutato dalla fonte (403)'
      : errori.some(e => e.tipo === 'auth') ? 'accesso alla fonte non valido (401)'
        : definitiva ? 'risposta della fonte non leggibile'
          : errori.some(e => e.http === 429) ? 'la fonte ha limitato le richieste (429)'
            : bloccata ? 'la fonte è ancora in pausa' : 'errore di rete temporaneo';
    const elenco = errori.filter(e => Number.isInteger(e.http)).map(e =>
      `${FONTE_LABEL[e.fonte] || e.fonte}${Number.isInteger(e.famiglia) ? ` famiglia ${e.famiglia}` : ''}: HTTP ${e.http}`).join('; ');
    paginaErrore = { testo: `${fonte}: pagina non completata (${motivo}).${elenco ? ` Errori: ${elenco}.` : ''} Nessun nuovo annuncio è stato aggiunto.${riprovabile && bloccata ? ` Riprova dal ${new Date(dopo).toLocaleString('it-IT')}.` : riprovabile ? ' Riprova fra 15 secondi.' : ''}`,
      riprovabile,
      dopo };
    renderSourceStatus(); toast(paginaErrore.testo); return false;
  }
  paginaFontiInSospeso = null;
  return true;
}

// L'identità appartiene alla fonte; il titolo (e quindi la URL) può cambiare fra clic.
// La prima copia mantiene prezzi e avvisi già mostrati, senza fondere annunci distinti.
function annunciUnici(righe) {
  const visti = new Set();
  return righe.filter(r => {
    if (!r?.url) return false;
    const id = (typeof r.id === 'string' || typeof r.id === 'number') && String(r.id).trim();
    const k = JSON.stringify([r.fonte, id ? 'id' : 'url', id || r.url]);
    if (visti.has(k)) return false;
    visti.add(k); return true;
  });
}

async function caricaAltri() {
  if (caricandoAltri || fettaPresa >= MAX_FETTE || !lastSearchParams || (paginaErrore &&
      (!paginaErrore.riprovabile || Date.now() < paginaErrore.dopo))) return;
  const fonti = paginaFontiInSospeso
    ? paginaFontiInSospeso.fonti.filter(f => !paginaFontiInSospeso.sources[f]) : fontiConAltri();
  const fetta = paginaFontiInSospeso?.fetta ?? fettaPresa + 1;
  if (!fonti.length) return;
  caricandoAltri = true; renderAltriBtn();
  const myGen = searchGen;
  try {
    const q = new URLSearchParams({ ...lastSearchParams, fetta: String(fetta), fonti: fonti.join(',') });
    const subito = lastSources?.subito;
    if (fonti.includes('subito') && subito && 'mainNextStart' in subito && 'recuperoNextStart' in subito) {
      q.set('subitoMainStart', String(paginaSubitoInSospeso ? -1 : subito.mainNextStart ?? -1));
      q.set('subitoRecuperoStart', String(paginaSubitoInSospeso
        ? paginaSubitoInSospeso.recuperoStart : subito.recuperoNextStart ?? -1));
    }
    const res = await fetch(`/api/search?${q}`);
    const data = await res.json();
    if (myGen !== searchGen) return;         // una ricerca nuova ha preso il posto
    if (!res.ok) {
      const limiteBreve = res.status === 429 && Number.isFinite(data.riprovaFra) && !data.riprovaDomani;
      paginaErrore = { testo: data.error || 'Il server non ha completato la pagina.',
        riprovabile: res.status >= 500 || limiteBreve,
        dopo: Date.now() + (limiteBreve ? data.riprovaFra * 1000 : 15000) };
      renderSourceStatus(); toast(paginaErrore.testo); return;
    }
    if (!Array.isArray(data.risultati) || !data.sources ||
        !['subito', 'autoscout', 'moto'].every(f => data.sources[f]?.status)) {
      paginaErrore = { testo: 'La risposta del server non descrive tutte le fonti: pagina non aggiunta.',
        riprovabile: false, dopo: 0 };
      renderSourceStatus(); toast(paginaErrore.testo); return;
    }
    if (!completaPagina(data, fonti, fetta)) return;
    paginaErrore = null;
    fettaPresa = fetta;
    const uniti = annunciUnici(currentResults.concat(data.risultati || []));
    const nuovi = uniti.slice(currentResults.length);
    if (!nuovi.length) {
      lastSources = fondiTotali(data.sources);
      renderSourceStatus();
      toast(altriDisponibili() ? 'Nessun annuncio nuovo in questa pagina; puoi continuare.' : 'Non ci sono altri annunci');
      return;
    }
    // IL CURSORE VA RIFATTO. Il suo BINARIO (non solo le maniglie) era calcolato sui prezzi
    // della PRIMA fetta soltanto, e renderResults filtra su quel binario: ogni annuncio nuovo
    // fuori da quella finestra spariva in silenzio, e l'utente non poteva nemmeno allargarlo.
    // Nel caso peggiore — una fonte sola, ordinata per prezzo crescente — la fetta successiva
    // e' per costruzione tutta sopra il massimo: 100 annunci scaricati, uno solo a schermo.
    const stretta = manigliePrezzoStrette();
    currentResults = currentResults.concat(nuovi);
    lastSources = fondiTotali(data.sources);
    renderSourceStatus();
    initPrezzoSlider(currentResults, stretta);
    if (!prezzoSliderInstance) renderResults(currentResults);   // niente cursore → disegna qui
    const fuori = stretta ? nuovi.filter(r => r.prezzo != null && (r.prezzo < stretta[0] || r.prezzo > stretta[1])).length : 0;
    toast([`Aggiunti ${nuovi.length} annunci`,
      fuori ? `${fuori} fuori dal filtro prezzo` : null,
    ].filter(Boolean).join(' · '));
  } catch (_) {
    if (myGen !== searchGen) return;
    paginaErrore = { testo: 'Impossibile contattare il server. La pagina è rimasta invariata.',
      riprovabile: true, dopo: Date.now() + 15000 };
    renderSourceStatus(); toast(paginaErrore.testo);
  } finally { caricandoAltri = false; renderAltriBtn(); }
}

// I conteggi per fonte devono contare TUTTE le fette, non l'ultima: il totale della
// fonte invece resta quello che dichiara lei.
function fondiTotali(nuove) {
  const out = {};
  for (const f of ['subito', 'autoscout', 'moto']) {
    const vecchia = (lastSources || {})[f] || null;
    const n = (nuove || {})[f] || null;
    if (!vecchia && !n) continue;
    // Una fetta vuota non cancella gli annunci gia' mostrati da questa fonte.
    if (vecchia && (vecchia.status === 'ok' || vecchia.status === 'empty')
        && n && (n.status === 'empty' || n.status === 'skipped')) {
      out[f] = { ...vecchia, ...(n.status === 'empty' ? n : {}),
        status: n.status === 'skipped' ? vecchia.status : presiDa(f) ? 'ok' : 'empty', count: presiDa(f),
        allargato: n.allargato || vecchia.allargato || null,
        hasMore: n.status === 'empty' ? n.hasMore ?? false : vecchia.hasMore,
        ...(f === 'subito' && n.status === 'empty'
          ? { mainNextStart: n.mainNextStart ?? null, recuperoNextStart: n.recuperoNextStart ?? null }
          : {}),
        pausa: n.pausa || vecchia.pausa };
      continue;
    }
    out[f] = { ...(vecchia || {}), ...(n || {}), count: presiDa(f),
               totale: (n && n.totale != null) ? n.totale : (vecchia && vecchia.totale),
               // L'avviso di allargamento vale per gli annunci a schermo, non per l'ultima
               // fetta: se resta anche una riga allargata, l'avviso deve restare con lei.
               allargato: (n && n.allargato) || (vecchia && vecchia.allargato) || null,
               reason: vecchia?.parzialeRete && n && !n.parzialeRete ? n.reason || null
                 : (n && n.reason) || (vecchia && vecchia.reason) || null };
  }
  return out;
}

function renderAltriBtn() {
  const el = document.getElementById('caricaAltri');
  if (!el) return;
  if (paginaRetryTimer) { clearTimeout(paginaRetryTimer); paginaRetryTimer = null; }
  const alLimite = fettaPresa >= MAX_FETTE && altriDisponibili();
  const mostra = searchActive && (alLimite || (paginaErrore ? paginaErrore.riprovabile : altriDisponibili()));
  el.classList.toggle('d-none', !mostra);
  const b = el.querySelector('button');
  if (b) {
    const attesa = paginaErrore && Date.now() < paginaErrore.dopo;
    b.disabled = caricandoAltri || !!attesa || alLimite;
    b.textContent = alLimite ? 'Limite di pagine raggiunto'
      : caricandoAltri ? 'Carico…' : paginaErrore ? 'Riprova questa pagina' : 'Carica altro';
    if (attesa) paginaRetryTimer = setTimeout(renderAltriBtn, Math.min(paginaErrore.dopo - Date.now() + 100, 2147483647));
  }
}

async function doSearch() {
  const tipo = currentTipo();
  const brand = matchedBrand();
  if (!brand) { showError('Scegli una marca dalla lista prima di cercare.'); return; }
  const marca = brand.nome;

  const modelloLibero = document.getElementById('modello').value.trim();
  const modelloScelto = selectedModel && selectedModel._marca === marca && acn(selectedModel.nome) === acn(modelloLibero);
  const scelta = sceltaVersione(versioneInput?.value, modelloScelto);
  if (scelta.errore) {
    showError(scelta.errore);
    (versioneInput?.value.trim() ? modelloSelect : versioneInput)?.focus();
    return;
  }
  const params = {
    tipo, marca, modello: modelloLibero,
    prezzoMin: document.getElementById('prezzoMin').value,
    prezzoMax: document.getElementById('prezzoMax').value,
    annoMin:   document.getElementById('annoMin').value,
    annoMax:   document.getElementById('annoMax').value,
    kmMin:     document.getElementById('kmMin').value,
    kmMax:     document.getElementById('kmMax').value,
    raggio:    document.getElementById('raggio').value,   // solo AS24, ignorato senza regione (server default 100)
  };
  if (regioneSelect.value) params.regione = regioneSelect.value;
  // F43 — modello strutturato: se l'utente ha SCELTO un modello (force-select) per
  // questa marca, manda gli ID esatti → niente fuzzy lato server.
  if (modelloScelto) {
    if (selectedModel.mmmvAutoscout) params.mmmvAutoscout = selectedModel.mmmvAutoscout;
    const motoSlug = selectedModel._familySlug || selectedModel.slugMotoIt;   // famiglia risolta (Lazy-T2) o slug diretto
    if (motoSlug) params.motoitModelSlug = motoSlug;
  }
  // Una versione specifica passa com'e' stata scritta: Subito la mette in `q=`,
  // AutoScout24 nel campo testuale nativo e Moto.it prova a tradurla nel suo catalogo.
  // «Nessuna Versione» non deve diventare una parola nella richiesta alle fonti.
  if (scelta.versione) params.versione = scelta.versione;
  // I filtri avanzati delle auto: il server li ignora sulle moto, ma non glieli mandiamo
  // nemmeno — un parametro che viaggia e non fa niente e' un parametro che un giorno
  // qualcuno legge e crede applicato.
  if (tipo === 'auto') Object.assign(params, filtriAutoScelti());
  Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
  closeMatrix();   // le spunte restano (attraversano i contesti), il pannello aperto no
  // `has-results` NON si mette qui: quattro righe piu' sotto `hideResults()` la toglie —
  // sempre, in tutti i rami — quindi in Auto/Moto il body non l'ha avuta mai, nemmeno dopo la
  // prima ricerca. Effetto: la barra di ricerca restava alta un'intera schermata (misurato:
  // 670px invece di 158 su un viewport da 900) e lo sfondo dello stato-vuoto restava in
  // filigrana dietro i risultati. Si mette quando i risultati ci sono davvero.
  document.body.dataset.tipo = tipo;

  // ORDINE OBBLIGATO: `hideResults()` azzera il contesto (vedi `resetContesto`) e brucia il
  // token, quindi TUTTO cio' che descrive questa ricerca si scrive DOPO — senno' lo
  // cancellava il reset — e il token di QUESTA ricerca si prende per ultimo, senno' la
  // ricerca scarterebbe se stessa.
  showLoading(); hideResults();
  lastSearchParams = { ...params };
  // Liquidita per la marca cercata: alimenta il segno accanto a ogni annuncio. Solo auto
  // (le moto non hanno il dato) e solo con una marca: una richiesta per ricerca, cachata.
  // Il ramo negativo lo fa gia' `resetContesto`: senza, i dati della marca AUTO precedente
  // restavano e finivano accanto a una moto — "Fiat 500: 94.618 passaggi" su una Honda CB 500.
  if (params.tipo !== 'moto' && params.marca) liqCarica(params.marca, params.modello, params.tipo);
  visibleCols = colsDefault(params);   // il default della ricerca, piu' preciso di quello a vuoto
  syncColMenu();
  const myGen = ++searchGen;   // review: se ne parte un'altra mentre questa è in volo, la stantia si scarta
  try {
    const res = await fetch(`/api/search?${new URLSearchParams(params)}`);
    const data = await res.json();
    if (myGen !== searchGen) return;   // una ricerca più recente ha già preso il posto → non sovrascrivere
    if (!res.ok) { showError(data.error || 'Errore durante la ricerca.'); return; }

    searchActive = true;
    // La ricerca e' andata: la pagina smette di vestirsi da schermo vuoto (barra compatta,
    // niente sfondo). Anche a zero risultati — perche' a quel punto la risposta e' il pannello
    // "nessun annuncio", non la schermata di partenza.
    document.body.classList.add('has-results');
    fettaPresa = 0;                      // ricerca nuova: si riparte dalla prima fetta
    paginaErrore = null;
    paginaSubitoInSospeso = null;
    paginaFontiInSospeso = null;
    lastSources = data.sources || null;
    let pubblicabile = true;
    if (Object.values(data.sources || {}).some(s => s?.parzialeRete)) {
      const fonti = ['subito', 'autoscout', 'moto'].filter(f => data.sources[f]
        && (data.sources[f].status !== 'skipped' || data.sources[f].pausa?.fermo));
      pubblicabile = completaPagina(data, fonti, 0);
    }
    if (pubblicabile) currentResults = annunciUnici(data.risultati || []);
    for (const [f, stato] of Object.entries(lastSources || {})) stato.count = presiDa(f);
    renderSourceStatus();


    initPrezzoSlider(currentResults);
    if (!prezzoSliderInstance) renderResults(currentResults);
    // La scheda tecnica non parte piu' con la ricerca: vive dentro l'annuncio e la chiedi
    // tu da li'. L'azzeramento e' gia' passato da `resetContesto` (via hideResults), che e'
    // l'unico punto: qui una seconda copia poteva solo divergere.
    if (currentResults.length > 0) resultsToolbar.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    if (myGen === searchGen) showError('Impossibile contattare il server. Assicurati che sia avviato con "npm start".');
  } finally { if (myGen === searchGen) hideLoading(); }
}

// ─── Slider prezzo ──────────────────────────────────────────────────────────
/** Le maniglie sono state mosse a mano? (cioe' non stanno agli estremi del binario) */
function manigliePrezzoStrette() {
  if (!prezzoSliderInstance) return null;
  const [a, b] = prezzoSliderInstance.get().map(Number);
  const [gMin, gMax] = sliderGlobalBounds;
  return (a > gMin || b < gMax) ? [a, b] : null;
}

function initPrezzoSlider(results, mantieni = null) {
  if (prezzoSliderInstance) { try { prezzoSliderInstance.destroy(); } catch (_) {} prezzoSliderInstance = null; }
  prezzoSliderEl.innerHTML = '';
  document.getElementById('sliderLabelMin').textContent = '';
  document.getElementById('sliderLabelMax').textContent = '';
  const prices = results.map(r => r.prezzo).filter(p => p != null && p > 0);
  if (prices.length < 2) return;
  const minP = Math.floor(Math.min(...prices) / 100) * 100;
  const maxP = Math.ceil(Math.max(...prices) / 100) * 100;
  if (minP === maxP) return;
  sliderGlobalBounds = [minP, maxP];
  // `mantieni` lo passa solo "Carica altri": il BINARIO si allarga sui prezzi di tutto lo
  // scaricato, ma la stretta fatta a mano resta dov'era invece di essere buttata via.
  const da = mantieni ? Math.max(minP, Math.min(maxP, mantieni[0])) : minP;
  const a  = mantieni ? Math.max(minP, Math.min(maxP, mantieni[1])) : maxP;
  prezzoSliderInstance = noUiSlider.create(prezzoSliderEl, {
    start: [da, a], connect: true, range: { min: minP, max: maxP }, step: 100,
    format: { to: v => Math.round(v), from: v => Number(v) },
  });
  prezzoSliderInstance.on('update', ([sMin, sMax]) => {
    document.getElementById('sliderLabelMin').textContent = eurRound(vPricing(Number(sMin)).finale);
    document.getElementById('sliderLabelMax').textContent = eurRound(vPricing(Number(sMax)).finale);
    renderResults(currentResults);
  });
}

// ─── Ordinamento ──────────────────────────────────────────────────────────────
function setSort(key) {
  if (sortState.key === key) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  else sortState = { key, dir: key === 'prezzo' || key === 'km' ? 'asc' : 'desc' };
  if (sortMobile) sortMobile.value = `${sortState.key}_${sortState.dir}`;
  renderResults(currentResults);
}
function sortResults(results) {
  const { key, dir } = sortState;
  const mul = dir === 'asc' ? 1 : -1;
  const hi = dir === 'asc' ? Infinity : -Infinity;
  return results.sort((a, b) => mul * (((a[key] ?? hi) - (b[key] ?? hi))));
}
