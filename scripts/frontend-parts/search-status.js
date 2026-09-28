
// ─── Stato per-fonte ──────────────────────────────────────────────────────────
const SOURCE_STATUS = {
  ok: { cls: 'src-ok' }, empty: { cls: 'src-muted', txt: 'nessun risultato' },
  skipped: { cls: 'src-muted' }, timeout: { cls: 'src-bad', txt: 'timeout' },
  error: { cls: 'src-bad', txt: 'errore' },
};
// La chiave e' il `reason` che arriva dal server, uguale identico. 'in pausa dopo un blocco'
// lo scrive backend/fonti-salute.js quando la fonte ci ha respinti due volte di fila: non e'
// un guasto nostro e non e' "non disponibile", e' una scelta di non insistere per un po'.
const SKIP_REASON_TXT = { 'solo moto': 'solo moto', 'marca non su Moto.it': 'non disponibile', 'marca non su Autoscout': 'non disponibile', 'in pausa dopo un blocco': 'in pausa' };
let searchAlertTexts = [];
function positionSearchAlertMenu() {
  const menu = searchAlerts?.querySelector('.search-alerts-menu');
  if (!searchAlerts?.open || !menu) return;
  menu.style.transform = '';
  const box = menu.getBoundingClientRect();
  const dx = box.left < 8 ? 8 - box.left : box.right > window.innerWidth - 8 ? window.innerWidth - 8 - box.right : 0;
  menu.style.transform = `translateX(${dx}px)`;
}
function renderSearchAlerts(avvisi) {
  const uguali = avvisi.length === searchAlertTexts.length && avvisi.every((v, i) => v === searchAlertTexts[i]);
  searchAlertTexts = avvisi;
  if (!searchAlerts) return;
  searchAlerts.classList.toggle('d-none', !avvisi.length);
  if (!avvisi.length) { searchAlerts.open = false; searchAlerts.innerHTML = ''; return; }
  if (uguali && searchAlerts.innerHTML) return; // preserva il fuoco mentre un dettaglio si aggiorna
  searchAlerts.innerHTML = `<summary class="tb-btn btn-avvisi" aria-label="Avvisi sulla ricerca: ${avvisi.length}">${icon('alert')} Avvisi sulla ricerca (${avvisi.length})</summary>`
    + `<div class="search-alerts-menu">${avvisi.map((testo, i) => `<div class="search-alert-item"><span>${escapeHtml(testo)}</span><button type="button" class="tb-btn" data-search-alert="${i}" aria-label="Segnala l'avviso ${i + 1} all'assistenza">Segnala</button></div>`).join('')}</div>`;
  if (searchAlerts.open) requestAnimationFrame(positionSearchAlertMenu);
}
function renderSourceStatus() {
  if (!fonteBreakdown) return;
  if (!lastSources) { fonteBreakdown.innerHTML = ''; renderSearchAlerts([]); return; }
  const avvisi = [];
  const aggiungi = testo => { if (testo) avvisi.push(testo); };
  const order = ['subito', 'autoscout', 'moto'];
  fonteBreakdown.innerHTML = order.map(f => {
    const s = lastSources[f]; if (!s) return '';
    const meta = SOURCE_STATUS[s.status] || { cls: 'src-muted' };
    let txt;
    /**
     * DUE NUMERI, NON UNO: quanti ne mostriamo e quanti ne ha la fonte.
     *
     * Il secondo arriva dentro le risposte che gia' leggiamo — `count_all` di Subito,
     * `metadata.totalItems` di Autoscout, il conteggio in pagina di Moto.it — quindi non
     * costa una richiesta. Dice una cosa che prima non si poteva sapere: se la ricerca ha
     * visto tutto o solo la punta. Su "Golf" sono 100 mostrati e 11.610 esistenti.
     *
     * Non e' "quanti ne abbiamo scartati": sono due popolazioni diverse, il totale e'
     * quello del filtro della FONTE, il conteggio e' dopo i NOSTRI filtri. Per questo
     * restano affiancati e non si sottraggono.
     */
    if (s.status === 'ok') {
      txt = `${s.count}`;
      // DI CHI E' QUEL TOTALE. Su Moto.it, quando lo slug del modello non c'e', la ricerca
      // si allarga alla marca e il conteggio in pagina e' quello della marca: scriverlo
      // nudo lo faceva sembrare il bacino del modello che hai chiesto.
      if (s.totale != null && s.totale > s.count) {
        txt += ` <em>di ${Number(s.totale).toLocaleString('it-IT')}${s.totaleLargo ? ' sulla marca' : ''}</em>`;
      }
    }
    else if (s.status === 'skipped') txt = escapeHtml(SKIP_REASON_TXT[s.reason] || s.reason || 'saltato');
    else txt = meta.txt || s.status;
    const dim = s.status === 'ok' ? '' : ' src-dim';
    const totaleIgnoto = f === 'subito' && (s.status === 'ok' || s.status === 'empty') && s.totale == null
      ? ' <span class="src-total-ignoto" tabindex="0" role="img" aria-label="Totale annunci non comunicato da Subito" data-tip="Totale annunci non comunicato da Subito">?</span>'
      : '';
    return `<span class="src ${meta.cls}${dim}">${FONTE_LABEL[f]} <b>${txt}</b>${totaleIgnoto}</span>`;
  }).join('');
  // L'AVVISO DI ALLARGAMENTO. `reason` veniva stampata solo per le fonti 'skipped', ma la frase
  // "nessun X su Autoscout: mostro Y" nasce a status 'ok' — quindi non compariva mai, e si
  // leggevano annunci di un altro modello (o di un altro allestimento) senza nessun segnale.
  // Riga propria sotto le pill, come `.veh-liq-avviso` per la liquidita'.
  const as = lastSources.autoscout;
  if (as && as.allargato && as.reason) {
    aggiungi(as.reason);
  }
  /**
   * IL RISULTATO PARZIALE, che il server calcola e finora buttavamo qui.
   *
   * `parziale` nasce quando una fonte ha risposto solo in parte: su Autoscout perche' alcune
   * grafie del modello sono cadute (succede sulle moto, dove `as24Spellings` ne prova piu'
   * d'una), altrove perche' alcune pagine non si sono lasciate leggere. Il server lo mette in
   * `reason`, ma questa funzione stampava `reason` solo per le fonti 'skipped' e per Autoscout
   * solo insieme a `allargato`: con lo stato 'ok' e nessun allargamento, la frase non
   * compariva mai. A schermo la fonte sembrava aver risposto per intero.
   */
  for (const f of order) {
    const s = lastSources[f];
    aggiungi(fontePausaTesto(FONTE_LABEL[f], s?.pausa)
      || (s?.erroreDettaglio ? `Dettagli ${FONTE_LABEL[f]}: ${s.erroreDettaglio}` : ''));
    if (s && (s.status === 'ok' || s.status === 'error' || s.status === 'empty') && s.parziale && !(f === 'autoscout' && s.allargato)) {
      aggiungi(String(s.parziale));
    }
    if (f === 'subito' && s?.erroreCodice === 'SUBITO_BODY_TOO_LARGE' && !s.parziale) {
      aggiungi('Subito ha inviato una risposta oltre il limite di dimensione. La richiesta è stata interrotta: gli annunci di questa pagina non sono stati letti.');
    }
    if (f === 'moto' && s?.erroreCodice === 'MOTO_BODY_TOO_LARGE' && !s.parziale) {
      aggiungi('Moto.it ha inviato una risposta oltre il limite di dimensione. La richiesta è stata interrotta: gli annunci di questa pagina non sono stati letti.');
    }
    if (f === 'moto' && (s?.status === 'error' || s?.status === 'timeout') && !s.parziale
        && !s.pausa?.fermo && s.erroreCodice !== 'MOTO_BODY_TOO_LARGE') {
      const motivo = s.erroreHttp === 401 ? 'autenticazione rifiutata dalla fonte'
        : s.erroreHttp === 403 || s.erroreHttp === 429 ? `richieste respinte (HTTP ${s.erroreHttp})`
        : s.erroreTipo === 'transient' || s.status === 'timeout' ? 'errore di rete o risposta temporaneamente non disponibile'
        : 'risposta non leggibile';
      aggiungi(`Moto.it: ${motivo}. Gli annunci di questa pagina non sono stati letti.`);
    }
    if (f === 'autoscout' && (s?.status === 'error' || s?.status === 'timeout') && !s.parziale && !s.pausa?.fermo) {
      const motivo = s.erroreCodice === 'AS24_BODY_TOO_LARGE' ? 'risposta oltre il limite di dimensione'
        : s.erroreHttp === 401 ? 'autenticazione rifiutata dalla fonte'
        : s.erroreHttp === 403 || s.erroreHttp === 429 ? `richieste respinte (HTTP ${s.erroreHttp})`
        : s.erroreTipo === 'transient' ? 'errore di rete o risposta temporaneamente non disponibile'
        : 'risposta non leggibile';
      aggiungi(`AutoScout24: ${motivo}. Gli annunci di questa pagina non sono stati letti.`);
    }
    if (f === 'subito' && Array.isArray(s?.errori) && s.errori.length) {
      const righe = s.errori.map(e => {
        const dove = Number.isInteger(e.famiglia) ? `Famiglia ${e.famiglia}` : 'Ricerca';
        const fase = e.fase === 'recupero' ? 'recupero annunci senza modello'
          : Number.isInteger(e.pagina) ? `pagina ${e.pagina}` : 'pagina';
        const esito = e.codice === 'SUBITO_BODY_TOO_LARGE' ? 'risposta oltre il limite di dimensione'
          : Number.isInteger(e.http) ? `HTTP ${e.http}`
          : e.tipo === 'transient' ? 'errore di rete' : 'risposta non leggibile';
        return `${dove}: ${fase} — ${esito}`;
      }).join('; ');
      aggiungi(`Subito: errori delle richieste — ${righe}`);
    }
  }
  // La pagina fallita non entra nella lista: il motivo resta visibile qui e sul pulsante.
  if (paginaErrore) aggiungi(`${paginaErrore.testo}${paginaErrore.riprovabile ? ' Potrai riprovare questa pagina dal pulsante qui sotto.' : ' Per riprendere, avvia una nuova ricerca.'}`);
  // Le parole della versione che Moto.it non conosce vengono ignorate di proposito — un filtro
  // che svuoterebbe l'insieme si scarta — ma finora quel "di proposito" restava in un log del
  // server: a schermo la colonna Moto.it si presentava filtrata come le altre.
  /**
   * SUBITO CERCATO A PAROLE. Quando il modello non sta nel catalogo di Subito la ricerca
   * parte come testo libero, con una precisione misurata del 71% (e zero su nomi corti come
   * "Audi 80", dove "80" pesca dentro "180 CV" e "80.000 km"). Il server lo dichiara da
   * sempre in `come`, e questa funzione non lo leggeva: quella colonna si presentava precisa
   * come le altre due. Niente pastiglia riga per riga — sarebbero tutte — ma una riga qui.
   */
  const sb = lastSources.subito;
  if (sb && sb.come === 'testo libero' && sb.status === 'ok' && sb.count > 0) {
    aggiungi('Ricerca pari alla ricerca a testo libero di Subito. Vuoi gestire le tue ricerche in modo diverso? Parliamone!');
  }
  /**
   * L'ALLESTIMENTO CERCATO DENTRO LA SUA FAMIGLIA, e chi guarda deve saperlo. Il catalogo
   * di Subito si ferma alla famiglia: una «Mercedes A 190» la si chiede come «Classe A»
   * col nome scritto per restringere. E' molto meglio di cercare tutta la Mercedes — che
   * e' quel che succedeva — ma non e' la stessa cosa di un id esatto, e presentarla come
   * tale sarebbe far passare per precisa una ricerca che precisa non e'.
   */
  if (sb && sb.come === 'allestimento' && sb.status === 'ok' && sb.count > 0) {
    aggiungi(`Su Subito questo modello è un allestimento: la ricerca parte dalla famiglia${sb.famigliaNome ? ' «' + sb.famigliaNome + '»' : ''} e si restringe col nome.`);
  }
  /**
   * LA MARCA OSPITE, e chi guarda deve saperlo. Su Subito «Vespa» non esiste come marca:
   * le sue famiglie vivono sotto PIAGGIO, e il ponte degli ospiti (subito-nodo) ce le fa
   * trovare per id. E' la ricerca giusta — prima era testo libero puro — ma la marca a
   * schermo non e' quella digitata, e tacerlo farebbe passare il passaggio per magia.
   */
  if (sb && /^ospite \(/.test(String(sb.come || '')) && sb.status === 'ok' && sb.count > 0) {
    aggiungi(`Su Subito questa marca vive sotto un'altra (${String(sb.come).slice(8, -1)})${sb.famigliaNome ? ': si cerca la famiglia «' + sb.famigliaNome + '»' : ''}.`);
  }
  const mo = lastSources.moto;
  if (mo?.modelloKoRete) {
    aggiungi('Moto.it: il catalogo modelli non è stato letto correttamente. La ricerca è stata allargata alla marca e filtrata sui titoli; riprova per verificare il modello.');
  }
  // Il menu versioni di Moto.it che non ha risposto: il filtro non e' stato applicato (o lo e'
  // stato su un elenco monco), e finora la colonna si presentava filtrata come le altre.
  if (mo && mo.versioneElencoMonco) {
    aggiungi(String(mo.versioneElencoMonco));
  }
  if (mo && mo.versioneIgnorata && mo.versioneIgnorata.length) {
    const p = mo.versioneIgnorata;
    aggiungi(`Moto.it non ha ${p.length === 1 ? 'la parola' : 'le parole'} “${p.join('”, “')}” nel suo catalogo versioni: quella parte del filtro non è stata applicata.`);
  }
  // Il filtro km di Subito e' a fasce, non a numero, su ENTRAMBI i lati: chiedendo un massimo di
  // 200.000 arrivano annunci fino a 249.999, chiedendone un minimo di 22.000 arrivano da 20.000.
  // Ora che la colonna Km mostra il chilometraggio VERO e non il fondo-fascia, quelli si vedono
  // — e senza questa riga sembrerebbero un errore dell'app. Coi numeri tondi non compare nulla.
  const sub = lastSources.subito;
  if (sub && sub.status === 'ok' && sub.count > 0 && (sub.kmFino || sub.kmDa)) {
    const km = n => Number(n).toLocaleString('it-IT');
    const pezzi = [];
    if (sub.kmDa) pezzi.push(`da ${km(sub.kmDa)}`);
    if (sub.kmFino) pezzi.push(`fino a ${km(sub.kmFino)}`);
    aggiungi(`Subito filtra i km a fasce: possono arrivare annunci ${pezzi.join(' e ')} km`);
  }
  renderSearchAlerts(avvisi);
}
function fontePausaHTML(nome, pausa) {
  const testo = fontePausaTesto(nome, pausa);
  return testo ? `<div class="src-avviso">${escapeHtml(testo)}</div>` : '';
}

function fontePausaTesto(nome, pausa) {
  if (!pausa) return '';
  const ora = new Date();
  const fine = Number.isFinite(pausa.fino) && pausa.fino > 0 ? new Date(pausa.fino) : null;
  const valida = fine && Number.isFinite(fine.getTime());
  let testo;
  if (pausa.verifica === true && pausa.fermo === true) {
    testo = `Verifica della disponibilità di ${nome} in corso.`;
  } else if (pausa.verifica === true || (valida && fine <= ora)) {
    testo = `Pausa terminata: la prossima richiesta verificherà se ${nome} è nuovamente disponibile.`;
  } else if (pausa.fermo === true) {
    const quando = valida
      ? fine.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
        + (fine.toDateString() !== ora.toDateString() ? ` del ${fine.toLocaleDateString('it-IT')}` : '')
      : null;
    testo = `Fonte ${nome}: richieste sospese. ` + (quando ? `Potrai riprovare dalle ${quando}; la` : 'La')
      + ' disponibilità sarà verificata alla prossima richiesta.';
  } else return '';
  return testo;
}

// Al massimo un avviso per fonte/stato nel contesto corrente, anche fra dettaglio e confronto.
const avvisiPausaDettaglio = new Map();
function segnalaPausaDettaglio(data) {
  if (typeof data?.ok !== 'boolean' || !data.pausa || !['subito', 'autoscout', 'moto'].includes(data.fonte)) return;
  const f = data.fonte;
  const errore = data.ok ? null : data.error || 'Dettaglio temporaneamente non disponibile.';
  if (lastSources) {
    lastSources[f] = { status: 'error', ...lastSources[f], pausa: data.pausa, erroreDettaglio: errore };
    renderSourceStatus();
  } else {
    const testo = fontePausaTesto(FONTE_LABEL[f], data.pausa) || (errore ? `Dettagli ${FONTE_LABEL[f]}: ${errore}` : '');
    if (!testo) return;
    const stato = JSON.stringify([searchGen, data.pausa.fermo, data.pausa.fino, data.pausa.verifica]);
    if (avvisiPausaDettaglio.get(f) === stato) return;
    avvisiPausaDettaglio.set(f, stato);
    // toast usa textContent: il testo della fonte non diventa HTML.
    toast(testo);
  }
}

// ─── Spec (dettaglio) ────────────────────────────────────────────────────────
const SPEC_LABELS = {
  variante: 'Versione', cambio: 'Cambio', cilindrata: 'Cilindrata', cilindri: 'Cilindri',
  potenzaCv: 'Potenza', carrozzeria: 'Carrozzeria', colore: 'Colore', porte: 'Porte', posti: 'Posti',
  classeEmissioni: 'Classe emissioni', neopatentati: 'Neopatentati', nuovo: 'Condizione', danni: 'Danni',
  venditore: 'Venditore', proprietari: 'Proprietari', allestimento: 'Allestimento', revisione: 'Revisione',
  // Nativi delle fonti, letti da poco: i kW li dichiara Subito (l'IPT ci gira sopra e
  // prima erano stimati dai CV), il resto lo dichiara Autoscout.
  potenzaKw: 'Potenza kW', generazione: 'Generazione', motore: 'Motore',
  tappezzeria: 'Interni', pesoVuoto: 'Peso a vuoto', cerchiPollici: 'Cerchi',
};
function specVal(k, v) {
  if (v == null || v === '') return '';
  if (k === 'potenzaCv') return `${v} CV`;
  if (k === 'potenzaKw') return `${v} kW`;
  if (k === 'pesoVuoto') return `${Number(v).toLocaleString('it-IT')} kg`;
  if (k === 'cerchiPollici') return `${v}"`;
  if (k === 'cilindrata') return `${v} cc`;
  if (k === 'nuovo') return v ? 'Nuovo' : 'Usato';
  if (k === 'danni') return v ? 'Incidentato' : 'Integro';
  if (k === 'neopatentati') return v ? 'Sì' : 'No';
  return String(v);
}
function hasSpec(item) {
  return ['variante', 'cambio', 'cilindrata', 'potenzaCv', 'venditore', 'colore', 'carrozzeria', 'porte', 'posti', 'classeEmissioni', 'proprietari', 'nuovo']
    .some(k => item[k] != null && item[k] !== '');
}

// ─── Lightbox foto ────────────────────────────────────────────────────────────
let lightboxState = null;
function openLightbox(images) {
  closeLightbox();
  let idx = 0;
  const overlay = document.createElement('div');
  overlay.className = 'img-lightbox';
  overlay.innerHTML = `
    <button class="lb-close" aria-label="Chiudi">&times;</button>
    <button class="lb-prev" aria-label="Precedente">&#10094;</button>
    <img class="lb-img" src="" alt="" referrerpolicy="no-referrer">
    <button class="lb-next" aria-label="Successiva">&#10095;</button>
    <div class="lb-count"></div>`;
  const imgEl = overlay.querySelector('.lb-img');
  const countEl = overlay.querySelector('.lb-count');
  const show = () => { imgEl.src = images[idx].full || images[idx].thumb; countEl.textContent = `${idx + 1} / ${images.length}`; };
  const go = d => { idx = (idx + d + images.length) % images.length; show(); };
  overlay.querySelector('.lb-prev').addEventListener('click', e => { e.stopPropagation(); go(-1); });
  overlay.querySelector('.lb-next').addEventListener('click', e => { e.stopPropagation(); go(1); });
  overlay.querySelector('.lb-close').addEventListener('click', closeLightbox);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeLightbox(); });
  const onKey = e => { if (e.key === 'Escape') closeLightbox(); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); };
  document.addEventListener('keydown', onKey);
  let x0 = null;
  overlay.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  overlay.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); x0 = null; }, { passive: true });
  if (images.length < 2) { overlay.querySelector('.lb-prev').style.display = 'none'; overlay.querySelector('.lb-next').style.display = 'none'; }
  document.body.appendChild(overlay);
  lightboxState = { overlay, onKey };
  show();
}
function closeLightbox() {
  if (!lightboxState) return;
  document.removeEventListener('keydown', lightboxState.onKey);
  lightboxState.overlay.remove(); lightboxState = null;
}

// ─── Confronto / matrice ──────────────────────────────────────────────────────
/**
 * DUE OGGETTI SONO LO STESSO ANNUNCIO?
 *
 * Le fonti che un'identita' stabile la dichiarano la mettono in `id`; le altre restano
 * sull'URL. Serve al confronto per riconoscere la stessa riga anche dopo un ridisegno.
 */
const stessoAnnuncio = (a, b) => {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  return a.url === b.url;
};
/** L'annuncio con questo URL, fra quelli che l'app ha in mano adesso. */
function trovaResult(url) {
  return currentResults.find(r => r.url === url) || confronto.find(r => r.url === url) || null;
}
// Aggiorna SOLO i bottoni/stato di un URL (riga + pannello dettaglio) senza re-render
// totale → non collassa il dettaglio aperto né perde lo scroll (flusso mobile).
function refreshRowState(url) {
  const rif = trovaResult(url);
  const inConf = confronto.some(r => stessoAnnuncio(r, rif) || r.url === url);
  // Rimpiazza SOLO l'icona (.ico) e l'eventuale label (.ra-txt) → bottoni icona-soli (riga)
  // e icona+testo (pannello dettaglio) restano coerenti.
  const setBtn = (b, on, onIco, offIco, onTxt, offTxt) => {
    b.classList.toggle('attivo', on);
    const ic = b.querySelector('.ico'); if (ic) ic.outerHTML = icon(on ? onIco : offIco);
    const tx = b.querySelector('.ra-txt'); if (tx) tx.textContent = on ? onTxt : offTxt;
  };
  resultsGrid.querySelectorAll(`[data-url="${CSS.escape(url)}"]`).forEach(el => {
    if (el.classList.contains('result-row')) el.classList.toggle('selected', inConf);
    el.querySelectorAll('.btn-confronta').forEach(b => setBtn(b, inConf, 'square-check', 'square', 'Nel confronto', 'Confronta'));
  });
}
function toggleConfronto(url) {
  const result = trovaResult(url); if (!result) return;
  const rifC = trovaResult(url);
  const idx = confronto.findIndex(r => stessoAnnuncio(r, rifC) || r.url === url);
  if (idx !== -1) confronto.splice(idx, 1);
  else if (confronto.length < COMPARE_CAP) confronto.push(result);
  else { toast(`Massimo ${COMPARE_CAP} annunci a confronto`); return; }
  refreshRowState(url); renderCompareBar();
  if (!cmatrixPanel.classList.contains('d-none') && matrixList.length > 1) openCompareMatrix();
}
function renderCompareBar() {
  if (!compareBar) return;
  compareCount.textContent = confronto.length;
  compareBar.classList.toggle('d-none', confronto.length < 1);
}

// Apri matrice: confronto (N colonne) o singolo dettaglio (1 colonna)
function openCompareMatrix() { matrixList = confronto.slice(); showMatrix(confronto.length > 1 ? 'Confronto annunci' : 'Dettaglio annuncio'); }
function closeMatrix() { cmatrixPanel.classList.add('d-none'); matrixList = []; }
function removeMatrixCol(url) {
  matrixList = matrixList.filter(r => r.url !== url);
  const rifM = trovaResult(url);
  const i = confronto.findIndex(r => stessoAnnuncio(r, rifM) || r.url === url);
  if (i !== -1) { confronto.splice(i, 1); refreshRowState(url); renderCompareBar(); }
  // Chi cambia la lista riscrive l'intestazione che la conta: il titolo lo scriveva solo
  // showMatrix, e «Selezionati: 3» restava accanto a «Confronto annunci (4)».
  cmatrixTitle.textContent = cmatrixTitle.textContent.replace(/\(\d+\)\s*$/, `(${matrixList.length})`);
  if (!matrixList.length) closeMatrix(); else renderMatrix();
}

const MATRIX_ROWS = [
  // Il prezzo del confronto e' il RETTIFICATO, come in griglia e negli export: `fmt`
  // riceve anche la riga intera proprio per questo. La stella del migliore resta sul
  // grezzo (stessa monotonia: finale = base + aggiunte − spese, il vincitore non cambia).
  { key: 'prezzo', label: 'Prezzo', best: 'min', fmt: (v, r) => prezzoEtichetta(r) },
  { key: 'anno', label: 'Anno', best: 'max', fmt: v => v != null ? v : '—' },
  { key: 'km', label: 'Km', best: 'min', fmt: v => v != null ? `${v.toLocaleString('it-IT')} km` : '—' },
  { key: 'carburante', label: 'Carburante', fmt: v => v || '—' },
  { key: 'potenzaCv', label: 'Potenza', best: 'max', fmt: v => v != null ? `${v} CV` : '—' },
  { key: 'cilindrata', label: 'Cilindrata', fmt: v => v != null ? `${v} cc` : '—' },
  { key: 'cambio', label: 'Cambio', fmt: v => v || '—' },
  { key: 'colore', label: 'Colore', fmt: v => v || '—' },
  { key: 'carrozzeria', label: 'Carrozzeria', fmt: v => v || '—' },
  { key: 'venditore', label: 'Venditore', fmt: v => v || '—' },
  { key: 'provincia', label: 'Provincia', fmt: v => v || '—' },
  { key: 'variante', label: 'Versione', fmt: v => v || '—' },
  // La corrispondenza sta nel confronto come sta nella lista e nel PDF: qui piu' che altrove,
  // perche' e' il posto dove si mettono due annunci fianco a fianco per decidere, e finora
  // niente diceva che uno dei due poteva essere un altro modello.
  // «Corrispondenza» legge TUTTI E DUE i canali del fuori-bersaglio: senza il secondo,
  // una riga che l'app aveva marcato «smentita» qui usciva «corrisponde».
  { key: 'dichiarazione', label: 'Corrispondenza', fmt: (v, r) => corrispondenzaDi(r).et },
];
function showMatrix(title) {
  cmatrixTitle.textContent = `${title} (${matrixList.length})`;
  cmatrixPanel.classList.remove('d-none');
  renderMatrix();
  cmatrixPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  enrichMotoSpecs(matrixList);
}
function bestIndexes(vals, mode) {
  const nums = vals.map(v => (typeof v === 'number' ? v : null));
  const valid = nums.filter(v => v != null);
  if (valid.length < 2) return new Set();
  const target = mode === 'min' ? Math.min(...valid) : Math.max(...valid);
  const set = new Set();
  nums.forEach((v, i) => { if (v === target) set.add(i); });
  return set;
}
// Responsive: desktop = matrice trasposta (densa, confronto a colpo d'occhio);
// mobile = una card per veicolo impilata (scroll verticale naturale, leggibile).
function renderMatrix() {
  const list = matrixList;
  const fmtFonte = r => FONTE_LABEL[r.fonte] || r.fonte;
  const fonteTag = r => ({ subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[r.fonte] || '');
  // Indici del valore migliore del set per ogni spec (riusato da tabella e card).
  // Stessa regola della lista: se nel confronto e' finito anche un annuncio di un altro
  // modello, il PREZZO migliore non si assegna — il piu' economico e' quasi sempre quello,
  // perche' e' un altro veicolo. Le altre righe (anno, km, potenza) restano confrontabili.
  const cmMisto = list.some(fuoriBersaglio);
  const bestByRow = MATRIX_ROWS.map(cfg => (cfg.best && !(cmMisto && cfg.key === 'prezzo'))
    ? bestIndexes(list.map(r => r[cfg.key]), cfg.best) : new Set());

  if (window.matchMedia('(max-width: 760px)').matches) {
    const cards = list.map((r, ci) => {
      const thumb = (Array.isArray(r.immagini) && r.immagini[0])
        ? `<img class="cm-card-img" src="${escapeHtml(r.immagini[0].thumb)}" referrerpolicy="no-referrer" alt="">`
        : `<div class="cm-card-img cm-card-noimg">—</div>`;
      const openBtn = /^https?:\/\//i.test(r.url) ? `<a class="cm-open" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Apri ↗</a>` : '';
      const priceBest = bestByRow[0].has(ci);   // MATRIX_ROWS[0] = prezzo
      const price = prezzoEtichetta(r);
      const specs = MATRIX_ROWS.map((cfg, ri) => ({ cfg, ri })).filter(x => x.cfg.key !== 'prezzo').map(({ cfg, ri }) => {
        const best = bestByRow[ri].has(ci);
        return `<div class="cm-card-spec"><span class="cm-card-k">${cfg.label}</span><span class="cm-card-v${best ? ' cm-best' : ''}">${escapeHtml(String(cfg.fmt(r[cfg.key], r)))}${best ? ' <span class="cm-star">★</span>' : ''}</span></div>`;
      }).join('');
      return `<div class="cm-card">
        <div class="cm-card-head">${thumb}<div class="cm-card-tt">
          <span class="tag ${fonteTag(r)}">${escapeHtml(fmtFonte(r))}</span>
          <div class="cm-card-title">${escapeHtml(r.titolo || '')}</div>
          <div class="cm-card-price${priceBest ? ' cm-best' : ''}">${price}${priceBest ? ' ★' : ''}</div>
        </div></div>
        <div class="cm-card-specs">${specs}</div>
        <div class="cm-card-foot">${openBtn}<button class="cm-rm" data-url="${escapeHtml(r.url)}" title="Rimuovi dal confronto">✕ Rimuovi</button></div>
      </div>`;
    }).join('');
    cmatrixBody.innerHTML = `<div class="cmatrix-cards">${cards}</div>`;
    return;
  }

  // DESKTOP: tabella trasposta. Foto in testa; valore migliore in verde; righe con
  // valori diversi evidenziate (label piena), righe tutte-uguali attenuate.
  const head = `<thead><tr><th class="cm-label">Annuncio</th>${list.map(r => {
    const thumb = (Array.isArray(r.immagini) && r.immagini[0]) ? `<img class="cm-thumb" src="${escapeHtml(r.immagini[0].thumb)}" referrerpolicy="no-referrer" alt="">` : `<span class="cm-thumb" style="display:flex;align-items:center;justify-content:center">—</span>`;
    const openBtn = /^https?:\/\//i.test(r.url) ? `<a class="cm-open" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Apri ↗</a>` : '';
    return `<th><div class="cm-colhead">${thumb}<div class="cm-tt"><div class="cm-coltitle">${escapeHtml(r.titolo || '')}</div><div class="cm-colactions">${openBtn}<button class="cm-rm" data-url="${escapeHtml(r.url)}" title="Rimuovi">✕</button></div></div></div></th>`;
  }).join('')}</tr></thead>`;
  const rows = MATRIX_ROWS.map((cfg, ri) => {
    const vals = list.map(r => String(cfg.fmt(r[cfg.key], r)));
    const differ = new Set(vals).size > 1;
    const bestIdx = bestByRow[ri];
    const cells = list.map((_, i) => `<td class="cm-val${bestIdx.has(i) ? ' cm-best' : ''}">${escapeHtml(vals[i])}</td>`).join('');
    return `<tr class="${differ ? 'cm-diff' : 'cm-same'}"><td class="cm-label">${cfg.label}</td>${cells}</tr>`;
  }).join('');
  const fonteRow = `<tr class="cm-same"><td class="cm-label">Fonte</td>${list.map(r => `<td class="cm-val">${escapeHtml(fmtFonte(r))}</td>`).join('')}</tr>`;
  cmatrixBody.innerHTML = `<table class="cmatrix">${head}<tbody>${rows}${fonteRow}</tbody></table>`;
}
// Moto.it: spec piene solo via /api/detail (lazy). Riempie le colonne moto poi ri-rende.
async function enrichMotoSpecs(list) {
  const targets = list.filter(r => r.fonte === 'moto' && !hasSpec(r) && /^https?:/.test(r.url || ''));
  if (!targets.length) return;
  const myGen = searchGen;
  await Promise.all(targets.map(async r => {
    if (r._detailLoaded || r._detailInFlight || Date.now() < (r._detailRetryAt || 0)) return;
    r._detailInFlight = true;
    r._detailRetryAt = Date.now() + 30000;
    try {
      const j = await fetch(`/api/detail?url=${encodeURIComponent(r.url)}`).then(x => x.json());
      if (myGen !== searchGen || !matrixList.includes(r)) return;
      segnalaPausaDettaglio(j);
      if (j.ok && j.detail) {
        const utili = Object.entries(j.detail).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
        for (const [k, v] of utili) if (r[k] == null) r[k] = v;
        if (utili.length) r._detailLoaded = true;
        // Un vuoto best-effort sul server dura 15 minuti: un render non deve
        // martellare quella cache ne' segnare la riga completata per sempre.
        else r._detailRetryAt = Date.now() + 15 * 60 * 1000;
      }
    } catch (_) {
      r._detailRetryAt = Date.now() + 30000;
    } finally { delete r._detailInFlight; }
  }));
  if (myGen === searchGen && matrixList === list && !cmatrixPanel.classList.contains('d-none')) renderMatrix();
}

// ─── Segnalazioni (bug-report) ───────────────────────────────────────────────
function openReport(avviso = '') {
  const m = document.getElementById('reportModal'); if (!m) return;
  document.getElementById('reportMsg').value = avviso ? `Avviso sulla ricerca: ${avviso}\n` : '';
  document.getElementById('reportStatus').textContent = '';
  const att = document.getElementById('reportAttach');
  // "Allega i dati della ricerca" esiste se una RICERCA c'e' stata. `searchActive` e' vero
  // anche nel parco di un concessionario, dove i criteri non esistono: la spunta si offriva
  // e allegava il nulla (o, prima del reset, i criteri di tutt'altro).
  if (att) { att.checked = !!avviso && !!lastSearchParams; att.parentElement.style.display = lastSearchParams ? '' : 'none'; }
  m.classList.remove('d-none');
  document.getElementById('reportMsg').focus();
}
function closeReport() { document.getElementById('reportModal')?.classList.add('d-none'); }
async function submitReport() {
  const msg = document.getElementById('reportMsg').value.trim();
  const status = document.getElementById('reportStatus');
  if (!msg) { status.textContent = 'Scrivi un messaggio.'; return; }
  const attach = document.getElementById('reportAttach')?.checked && !!lastSearchParams;
  const body = { type: attach ? 'search' : 'bug', message: msg };
  if (attach) { body.searchParams = lastSearchParams; body.count = currentResults.length; }
  const btn = document.getElementById('reportSend'); btn.disabled = true; status.textContent = 'Invio…';
  try {
    const r = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { closeReport(); toast('Grazie, segnalazione inviata.'); }
    else if (r.status === 429) status.textContent = 'Troppe segnalazioni, riprova tra qualche minuto.';
    else status.textContent = 'Invio non riuscito.';
  } catch (_) { status.textContent = 'Errore di rete.'; }
  finally { btn.disabled = false; }
}

// ─── Attesa di caricamento: skeleton + consiglio rotante ──────────────────────
const LOADING_TIPS = [
  'Raggruppa i risultati per modello, fonte, carburante o anno dalla toolbar.',
  'Dal menu “Prezzo €” aggiungi commissione e spese: vedi subito il prezzo di listino.',
  'Confronta più annunci fianco a fianco: spuntali e premi “Apri confronto”.',
  'Salva una ricerca e AMR ti avvisa su annunci nuovi e cali di prezzo.',
  'Esporta i risultati in PDF o CSV con un click.',
  'Ordina per prezzo, anno o km cliccando l’intestazione della colonna.',
  'Filtra per regione; su Autoscout puoi cercare entro un raggio in km dal capoluogo.',
  'Hai domande? Ti rispondiamo subito in chat su WhatsApp.',
];
function loadingBlockHTML(status) {
  const skel = '<div class="skel-row"><div class="skel-thumb"></div><div class="skel-lines"><span></span><span></span></div><div class="skel-price"></div></div>'.repeat(6);
  return `<div class="amr-loading">
    <div class="amr-loading-bar"><span class="spinner-border text-primary" role="status" style="width:1.1rem;height:1.1rem;border-width:2px"></span><span class="amr-loading-status">${escapeHtml(status)}</span></div>
    <div class="amr-loading-tip">${icon('bulb', 'tip-ico')}<span class="tip-text">${escapeHtml(LOADING_TIPS[0])}</span></div>
    <div class="skel-list">${skel}</div>
  </div>`;
}
// timer per-elemento (memorizzato su el._tipTimer): caricamenti concorrenti dei veicoli
// non si uccidono a vicenda e non condividono un id duplicato.
function startLoadingTips(root) {
  const el = root && root.querySelector && root.querySelector('.amr-loading-tip'); if (!el) return;
  if (el._tipTimer) clearInterval(el._tipTimer);
  let idx = 0;
  el._tipTimer = setInterval(() => {
    if (!el.isConnected) { clearInterval(el._tipTimer); el._tipTimer = null; return; }   // DOM sostituito → stop
    idx = (idx + 1) % LOADING_TIPS.length;
    const txt = el.querySelector('.tip-text');
    el.classList.add('fade');
    setTimeout(() => { if (txt) txt.textContent = LOADING_TIPS[idx]; el.classList.remove('fade'); }, 220);
  }, 3200);
}
function stopLoadingTips(root) { const el = root && root.querySelector && root.querySelector('.amr-loading-tip'); if (el && el._tipTimer) { clearInterval(el._tipTimer); el._tipTimer = null; } }

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showLoading() { statusBox.classList.remove('d-none'); loadingState.innerHTML = loadingBlockHTML('Cerco su più siti…'); loadingState.classList.remove('d-none'); errorState.classList.add('d-none'); startLoadingTips(loadingState); }
function hideLoading() {
  stopLoadingTips(loadingState);
  loadingState.classList.add('d-none');
  const errorVisible = !errorState.classList.contains('d-none');
  if (!errorVisible) statusBox.classList.add('d-none');
}
function showError(msg) { statusBox.classList.remove('d-none'); loadingState.classList.add('d-none'); errorState.classList.remove('d-none'); errorText.textContent = msg; }
function hideError() { errorState.classList.add('d-none'); statusBox.classList.add('d-none'); }
/**
 * IL CONTESTO E' CAMBIATO. Un punto solo, chiamato da chiunque cambi cosa si sta guardando.
 *
 * Erano TRE i posti che riempiono la griglia — `doSearch`, il parco di un concessionario
 * (`cpMostraParco`) e un gruppo di vetrine (`cpMostraGruppo`) — piu' `hideResults` che la
 * svuota e il cambio Auto/Moto. Ognuno azzerava un sottoinsieme diverso, e quello che
 * restava indietro descriveva la schermata di PRIMA: la liquidita' della BMW cercata sotto
 * la Panda del parco, il PDF del parco con in testa i criteri di un'altra ricerca, "Solo
 * IVA esposta" che sopravvive alla ricerca nuova e la svuota mentre il pannello dice che
 * non c'e' niente, il raggruppamento della ricerca auto ancora attivo passando alle moto.
 *
 * Il confine e' quello deciso dal proprietario: si azzera QUELLO CHE DESCRIVE LA RICERCA
 * (i suoi dati, i filtri attivi, le colonne). NON si azzera come guardi — ordinamento,
 * vista lista/schede, menu prezzi, provincia, unita' — ne' gli annunci spuntati per il
 * confronto, che di proposito attraversano i contesti: spunti la tua auto nel parco, torni
 * alla ricerca, spunti un annuncio di mercato e li metti a fianco.
 */
function resetContesto() {
  // Una fetta di "Carica altri" ancora in volo non deve piu' atterrare: la risposta in
  // ritardo rimetteva `lastSources` e concatenava annunci in uno stato gia' azzerato.
  searchGen++;
  lastSearchParams = null;
  lastSources = null;
  renderSearchAlerts([]);
  fettaPresa = 0;
  paginaErrore = null;
  paginaSubitoInSospeso = null;
  paginaFontiInSospeso = null;
  if (paginaRetryTimer) { clearTimeout(paginaRetryTimer); paginaRetryTimer = null; }
  ultimiVisti = null;
  soloIva = false;
  // Il toggle «mostrali» delle versioni smentite descrive LA ricerca, non il modo di
  // guardare: lasciato acceso, condizionava la ricerca successiva senza che nessuno
  // l'avesse chiesto in quel contesto.
  mostraVersioniSmentite = false;
  // La lista stessa: era azzerata in due punti fuori di qui, contro la regola scritta
  // qui sotto («un posto solo»). Chi riempie riassegna subito dopo, quindi e' innocuo.
  currentResults = [];
  groupDim = '';
  colsToccate = false;
  visibleCols = colsDefault(null);
  syncColMenu();
  // I segni di liquidita' accanto alle righe sono della MARCA cercata: senza ricerca non
  // esistono, e tenerli significava attribuirli agli annunci di un altro contesto.
  liqMarca = null; liqModelli = null; liqVoce = null; liqStato = 'mai';
  liqAnn = null;
  clearVehScheda();
}
function hideResults() {
  resetContesto();
  searchActive = false;
  targaBtnSync();   // niente annunci: il bottone della targa non ha dove andare
  document.body.classList.remove('has-results');   // torna allo stato iniziale → sfondo + search centrata
  resultsSection.classList.add('d-none'); noResults.classList.add('d-none'); resultsToolbar.classList.add('d-none');
  fonteBreakdown.innerHTML = ''; resultsGrid.innerHTML = ''; compareBar.classList.add('d-none'); closeMatrix();
  // L'avviso «Nascosti N annunci...» e' FRATELLO di fonteBreakdown, fuori da
  // resultsSection: svuotare i risultati non lo raggiungeva, e restava a schermo un
  // conteggio che non descriveva piu' nessuna lista, con un bottone che non faceva niente.
  rigaVersione(0);
  renderCompareBar();   // le spunte restano: la barra torna se ci sono ancora annunci a confronto
}
