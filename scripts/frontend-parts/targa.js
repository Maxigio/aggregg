// ─── VERIFICA PER TARGA ───────────────────────────────────────────────────────
/**
 * Classe ambientale, CO2 e ultima revisione dal Portale dell'Automobilista.
 *
 * DOVE STA, e non e' un caso. La targa si scrive ACCANTO ALLA VERSIONE, in chiaro nella
 * barra di ricerca. Stava nei filtri avanzati — cioe' in un pannello chiuso, insieme ai
 * campi che restringono — ed era la posizione sbagliata due volte: la targa NON filtra
 * niente (e' del mezzo che stai valutando, non di quelli in vendita) e sepolta li' non la
 * trovava nessuno. Versione e targa sono i due campi che DESCRIVONO il veicolo: stanno
 * insieme, sempre visibili. Il risultato compare in ADD ON, dentro la scheda tecnica,
 * accanto alle altre integrazioni esterne — perche' e' esattamente quello: un dato che
 * viene da fuori e costa una richiesta.
 *
 * IL CAPTCHA LO RISOLVI TU. L'immagine e' quella del portale, arriva qui dentro e la
 * leggi tu: nessun tentativo di indovinarla. Il server tiene la sessione e rimanda i
 * tuoi caratteri.
 *
 * LA TARGA NON SI SALVA: non in cache, non su disco, non nei log. Serve per il veicolo
 * che hai davanti adesso, e poi non serve piu'. Per questo qui non c'e' uno storico.
 */
let targaCercata = '';   // quella scritta nei filtri, per QUESTA ricerca
let tgSfida = null;      // { id, immagine, tipi } oppure { errore }
let tgEsito = null;      // { coppie, tabelle, avvisi, nuove } oppure { errore }
let tgOccupato = false;
// Il tipo si ricorda fra un tentativo e l'altro: dopo un invio il blocco si ridisegna
// (serve un'immagine nuova) e senza questo andava riscelto. I caratteri no: cambiano sempre.
let tgTipoScelto = 'A';

function tgReset() { tgSfida = null; tgEsito = null; tgOccupato = false; }

async function tgNuovaSfida(tieniEsito) {
  tgOccupato = true;
  if (!tieniEsito) tgEsito = null;
  tgRender();
  try {
    const d = await fetch('/api/targa/sfida').then(r => r.json());
    tgSfida = d.ok ? d : { errore: d.error || 'il portale non risponde' };
  } catch (_) { tgSfida = { errore: 'server non raggiungibile' }; }
  tgOccupato = false; tgRender();
}

async function tgVerifica() {
  if (tgOccupato || !tgSfida || !tgSfida.id) return;
  // Il campo sta dentro la finestra: si legge da li', non dal documento.
  const box = document.getElementById('targaModalBody') || document;
  const el = id => box.querySelector('#' + id);
  const captcha = ((el('tgCaptcha') || {}).value || '').trim();
  tgTipoScelto = (el('tgTipo') || {}).value || 'A';
  if (!targaCercata) { toast('Scrivi la targa nel campo accanto alla versione, poi riapri la scheda'); return; }
  if (!captcha) { toast('Scrivi i caratteri dell\'immagine'); return; }
  tgOccupato = true; tgEsito = null; tgRender();
  try {
    const r = await fetch('/api/targa/verifica', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: tgSfida.id, tipo: tgTipoScelto, targa: targaCercata, captcha }),
    });
    const d = await r.json();
    tgEsito = d.ok ? d : { errore: d.error || 'non riuscito' };
  } catch (_) { tgEsito = { errore: 'server non raggiungibile' }; }
  tgOccupato = false;
  // La sfida e' bruciata: il portale ne rigenera una a ogni invio. L'esito appena letto
  // resta a schermo — azzerarlo qui lo faceva sparire nell'istante in cui arrivava.
  tgSfida = null; tgRender();
  await tgNuovaSfida(true);
}

/**
 * Il risultato, nella forma in cui il portale lo manda davvero: una riga di intestazioni
 * e una di valori. Si mostra come coppie etichetta/valore, che e' come si legge — non
 * come due elenchi in fila, dove non si sa piu' quale numero appartiene a quale voce.
 * Se le righe di valori sono piu' d'una (piu' revisioni) restano gruppi distinti.
 */
function tgEsitoHTML() {
  if (!tgEsito) return '';
  if (tgEsito.errore) return `<div class="tg-avviso">${escapeHtml(tgEsito.errore)}</div>`;
  const avvisi = (tgEsito.avvisi || []).map(a => `<div class="tg-avviso">${escapeHtml(a)}</div>`).join('');
  const coppia = (k, v) => `<div class="det-spec"><span class="det-k">${escapeHtml(k)}</span><span class="det-v">${escapeHtml(v)}</span></div>`;
  const blocchi = (tgEsito.tabelle || []).map(t => t.righe.map(r =>
    `<div class="det-specs">${t.intestazioni.map((h, i) => (r[i] ? coppia(h, r[i]) : '')).join('')}</div>`).join('')).join('');
  const sciolte = (tgEsito.coppie || []).map(([k, v]) => coppia(k, v)).join('');
  // Cio' che il portale ha aggiunto e che non e' finito in tabella: si mostra com'e'.
  const extra = (tgEsito.nuove || []).map(x => `<div class="tg-riga">${escapeHtml(x)}</div>`).join('');
  if (!avvisi && !blocchi && !sciolte && !extra) {
    return '<div class="tg-avviso">Il portale ha risposto, ma non c\'era niente da leggere. Riprova con l\'immagine nuova.</div>';
  }
  return `<div class="tg-esito">${avvisi}${blocchi}${sciolte ? `<div class="det-specs">${sciolte}</div>` : ''}${extra}</div>`;
}

/** La verifica vive in un posto solo — la sua finestra — e li' si ridisegna. */
const tgModaleAperta = () => !document.getElementById('targaModal')?.classList.contains('d-none');
function tgRender() {
  if (!tgModaleAperta()) return;
  const b = document.getElementById('targaModalBody');
  if (b) b.innerHTML = tgCorpoHTML();
}

/**
 * LA VERIFICA IN PIEDI DA SOLA. La targa e' del mezzo che hai davanti, non di un annuncio:
 * per leggerne i dati non deve servire aprire un annuncio qualunque, la sua scheda tecnica
 * e sceglierne la motorizzazione. Il bottone accanto al campo apre questa finestra, chiede
 * subito l'immagine al portale, e il risultato compare qui dentro.
 *
 * IL CAPTCHA LO RISOLVI TU: l'immagine e' quella del portale, la leggi e la scrivi. Il
 * server tiene la sessione e rimanda i tuoi caratteri — non c'e' nessun tentativo di
 * indovinarla, ne' ci sara'.
 */
function tgApriModale() {
  const t = String((document.getElementById('targaFiltro') || {}).value || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!t) { showError('Scrivi prima la targa.'); return; }
  targaCercata = t;
  const m = document.getElementById('targaModal'); if (!m) return;
  m.classList.remove('d-none');
  tgEsito = null; tgSfida = null;
  tgRender();
  if (!tgOccupato) tgNuovaSfida();
}
function tgChiudiModale() { document.getElementById('targaModal')?.classList.add('d-none'); }

function tgCorpoHTML() {
  const s = tgSfida;
  let form;
  if (!s && tgOccupato) form = '<div class="tg-att">Chiedo l\'immagine al portale…</div>';
  else if (!s) form = '<div class="tg-att">Apri per chiedere l\'immagine al portale.</div>';
  else if (s.errore) {
    form = `<div class="tg-avviso">${escapeHtml(s.errore)}</div>`
      + '<button type="button" class="btn-ghost tg-btn" id="tgRiprova">Riprova</button>';
  } else {
    const tipi = (s.tipi || []).map(t =>
      `<option value="${escapeHtml(t.v)}"${t.v === tgTipoScelto ? ' selected' : ''}>${escapeHtml(t.t)}</option>`).join('');
    form = `<div class="tg-form">
      <select id="tgTipo" class="field-input" aria-label="tipo di veicolo">${tipi}</select>
      <div class="tg-captcha">
        <img src="${escapeHtml(s.immagine)}" alt="caratteri da leggere" width="150" height="50">
        <button type="button" class="tg-cambia" id="tgCambia" title="Cambia immagine">&#8635;</button>
      </div>
      <input type="text" id="tgCaptcha" class="field-input tg-cin" placeholder="Caratteri" maxlength="5" autocomplete="off" spellcheck="false">
      <button type="button" class="btn-cerca tg-btn" id="tgVai"${tgOccupato ? ' disabled' : ''}>${tgOccupato ? 'Cerco…' : 'Verifica'}</button>
    </div>`;
  }
  return `<div class="tg-corpo">
    <p class="tg-nota">Vuoi più dati? Faccelo sapere!</p>
    ${form}${tgEsitoHTML()}</div>`;
}

// Il blocco compare SOLO se una targa e' stata scritta nei filtri: senza, non c'e'
// niente da chiedere e un riquadro vuoto sarebbe solo ingombro.

resultsGrid?.addEventListener('click', e => {
  const omoBtn = e.target.closest('.veh-omo-btn');
  if (omoBtn) return vehOmoCarica(omoBtn.dataset.omo);
  if (e.target.closest('#tgVai')) return tgVerifica();
  if (e.target.closest('#tgCambia') || e.target.closest('#tgRiprova')) return tgNuovaSfida();
});
resultsGrid?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'tgCaptcha') { e.preventDefault(); tgVerifica(); }
});
