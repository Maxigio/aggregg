'use strict';

const $ = id => document.getElementById(id);
const form = $('cerca');
const cataloghi = { auto: null, moto: null };
const modelliCache = new Map();
const versioniCache = new Map();
let identita = null, moduli = [], modelli = [], sequenzaMarche = 0, sequenzaModelli = 0,
  sequenzaVersioni = 0, sequenzaRicerca = 0, sequenzaStato = 0;
let parametriRicerca = null, pagina = 0, fontiCorrenti = null, risultatiCorrenti = [], ricercaOccupata = false;
let filtriModificati = false, paginaIncompleta = null;
let primaPaginaMancante = {}, pagineFonti = {};
let paginaLavori = 1, paginaVisualizzata = 1, pagineDisponibili = 1;
let nodiElencati = '', diagnosticaAbilitata = false;
let aggiornamentoStato = 0;
let accountAbilitato = false, accessoSintetico = false;
const aree = ['ricercaPanel', 'diagnosticaPanel', 'accountPanel'];
function aggiornaAree(aggiornaIndirizzo = true, focus = document.activeElement) {
  const disponibili = { ricercaPanel: accessoSintetico || Boolean(identita && moduli.length),
    diagnosticaPanel: diagnosticaAbilitata, accountPanel: accountAbilitato };
  const richiesta = location.hash.slice(1);
  const scelta = disponibili[richiesta] && aree.includes(richiesta) ? richiesta
    : (!identita && diagnosticaAbilitata ? 'diagnosticaPanel' : aree.find(id => disponibili[id]));
  const linkFocalizzato = focus.closest('.area-nav a');
  const nascosto = !focus.isConnected || aree.some(id => id !== scelta && $(id).contains(focus))
    || (linkFocalizzato && !disponibili[linkFocalizzato.hash.slice(1)]);
  for (const id of aree) {
    $(id).hidden = id !== scelta;
    const link = document.querySelector(`.area-nav a[href="#${id}"]`);
    link.hidden = !disponibili[id];
    if (id === scelta) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (aggiornaIndirizzo && scelta && scelta !== richiesta) history.replaceState(null, '', '#' + scelta);
  if (nascosto && scelta) document.querySelector(`.area-nav a[href="#${scelta}"]`).focus({ preventScroll: true });
}
window.addEventListener('hashchange', () => aggiornaAree());
const nomiFonti = { subito: 'Subito', autoscout: 'AutoScout24', moto: 'Moto.it' };
const nomiEventi = { riavvio_lavori: 'Centro riavviato con lavori pendenti',
  lavoro_incerto: 'Lavoro avviato, esito non confermato',
  lavoro_interrotto: 'Lavoro interrotto prima dell’avvio',
  lavoro_errore: 'Lavoro terminato con errore', fonte_limitata: 'Fonte in pausa (429)',
  fonte_errore: 'Errore della fonte', fonte_parziale: 'Risposta parziale della fonte',
  sospensione_aggiunta: 'Sospensione manuale aggiunta',
  sospensione_rimossa: 'Sospensione manuale rimossa', lavori_cancellati: 'Lavori terminati eliminati' };
const normalizza = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');
const tipo = () => form.elements.tipo.value;

async function leggi(url, opzioni) {
  const r = await fetch(url, opzioni);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status >= 500
    ? (r.status === 504 ? 'Esito incerto: riprova esplicitamente.' : `Servizio non disponibile (HTTP ${r.status}). Riprova più tardi.`)
    : data.error || `HTTP ${r.status}`);
  return data;
}
function opzioni(lista, valori) {
  lista.replaceChildren(...valori.map(valore => {
    const o = document.createElement('option'); o.value = valore; return o;
  }));
}
function messaggio(errore) {
  $('formErrore').hidden = !errore;
  $('formErrore').textContent = errore || '';
}
function marcaScelta() {
  return cataloghi[tipo()]?.brands.find(b => normalizza(b.nome) === normalizza($('marca').value)) || null;
}
function modelloScelto() {
  return modelli.find(m => normalizza(m.nome) === normalizza($('modello').value)) || null;
}
async function caricaMarche() {
  const t = tipo(), numero = ++sequenzaMarche;
  $('marcaAiuto').textContent = 'Carico le marche…';
  try {
    if (!cataloghi[t]) cataloghi[t] = await leggi('/api/brands?tipo=' + t);
    if (numero !== sequenzaMarche || t !== tipo()) return;
    opzioni($('marche'), cataloghi[t].brands.map(b => b.nome));
    $('marcaAiuto').textContent = `${cataloghi[t].brands.length} marche dal catalogo AMR`;
  } catch (e) { if (numero === sequenzaMarche) $('marcaAiuto').textContent = `Catalogo non disponibile: ${e.message}`; }
}
async function caricaModelli() {
  const numero = ++sequenzaModelli, t = tipo(), marca = marcaScelta();
  modelli = []; opzioni($('modelli'), []); opzioni($('versioni'), ['Nessuna Versione']);
  if (!marca) { $('modelloAiuto').textContent = 'Seleziona una marca dal catalogo.'; return; }
  const key = `${t}|${marca.nome}`;
  $('modelloAiuto').textContent = 'Carico i modelli…';
  try {
    if (!modelliCache.has(key)) modelliCache.set(key, await leggi(`/api/models?tipo=${t}&marca=${encodeURIComponent(marca.nome)}`));
    if (numero !== sequenzaModelli || t !== tipo() || marca.nome !== marcaScelta()?.nome) return;
    const data = modelliCache.get(key); modelli = data.modelli || [];
    opzioni($('modelli'), modelli.map(m => m.nome));
    $('modelloAiuto').textContent = data.fonteMotoitKo
      ? `Catalogo Moto.it non disponibile: ${data.fonteMotoitKo}. Altri modelli disponibili.`
      : `${modelli.length} modelli; la ricerca per sola marca resta possibile.`;
  } catch (e) { if (numero === sequenzaModelli) $('modelloAiuto').textContent = `Modelli non disponibili: ${e.message}`; }
}
async function caricaVersioni() {
  const numero = ++sequenzaVersioni, t = tipo(), marca = marcaScelta(), modello = modelloScelto();
  opzioni($('versioni'), ['Nessuna Versione']);
  if (!marca || !modello) return;
  const key = `${t}|${marca.nome}|${modello.nome}`;
  try {
    if (!versioniCache.has(key)) versioniCache.set(key, await leggi(`/api/versioni?tipo=${t}&marca=${encodeURIComponent(marca.nome)}&modello=${encodeURIComponent(modello.nome)}`));
    if (numero !== sequenzaVersioni || t !== tipo() || modello.nome !== modelloScelto()?.nome) return;
    opzioni($('versioni'), ['Nessuna Versione', ...(versioniCache.get(key).versioni || [])]);
  } catch (_) { /* Resta disponibile il testo libero e «Nessuna Versione». */ }
}
async function caricaFiltri() {
  try {
    const data = await leggi('/api/filtri');
    const regioni = $('regione'); regioni.replaceChildren();
    for (const nome of ['', ...data.regioni]) {
      const option = document.createElement('option'); option.value = nome;
      option.textContent = nome ? nome[0].toUpperCase() + nome.slice(1) : 'Tutta Italia';
      regioni.append(option);
    }
    const area = $('filtriAuto'); area.replaceChildren();
    for (const f of data.filtriAuto) {
      const label = document.createElement('label'); label.textContent = f.etichetta;
      const select = document.createElement('select'); select.name = f.nome;
      const vuota = document.createElement('option'); vuota.value = ''; vuota.textContent = 'Tutte'; select.append(vuota);
      for (const v of f.voci) {
        const option = document.createElement('option'); option.value = v.id;
        option.textContent = v.etichetta + (v.allargaSu?.length ? ` · su ${v.allargaSu.join(' e ')} allarga` : '');
        select.append(option);
      }
      label.append(select); area.append(label);
    }
  } catch (e) { messaggio(`Filtri avanzati non disponibili: ${e.message}`); }
}
function aggiornaTipo() {
  sequenzaMarche++; sequenzaModelli++; sequenzaVersioni++;
  $('marca').value = ''; $('modello').value = ''; $('versione').value = '';
  modelli = []; opzioni($('modelli'), []); opzioni($('versioni'), ['Nessuna Versione']);
  $('filtriAuto').hidden = tipo() !== 'auto';
  $('potenzaAuto').hidden = tipo() !== 'auto';
  return identita ? caricaMarche() : Promise.resolve();
}
function preparaRicerca() {
  if (!identita || !moduli.includes(tipo())) throw new Error('Scegli un’azienda abilitata a questo modulo.');
  const brand = marcaScelta();
  if (!brand) throw new Error('Scegli una marca dal catalogo AMR.');
  const modello = $('modello').value.trim(), selezione = modelloScelto();
  const versione = $('versione').value.trim();
  if (!versione) throw new Error('Scegli una versione oppure “Nessuna Versione”.');
  if (normalizza(versione) !== normalizza('Nessuna Versione') && !selezione) {
    throw new Error('Per cercare una versione specifica, scegli un modello dal catalogo.');
  }
  const q = new URLSearchParams({ tipo: tipo(), marca: brand.nome });
  if (modello) q.set('modello', modello);
  if (normalizza(versione) !== normalizza('Nessuna Versione')) q.set('versione', versione.slice(0, 80));
  if (selezione) {
    if (selezione.mmmvAutoscout) q.set('mmmvAutoscout', selezione.mmmvAutoscout);
    if (selezione.slugMotoIt) q.set('motoitModelSlug', selezione.slugMotoIt);
  }
  for (const [chiave, valore] of new FormData(form)) {
    if (['tipo', 'marca', 'modello', 'versione'].includes(chiave) || !valore) continue;
    if (tipo() === 'moto' && ($('filtriAuto').querySelector(`[name="${chiave}"]`)
        || ['cvMin', 'cvMax'].includes(chiave))) continue;
    q.set(chiave, valore);
  }
  return q;
}
function elemento(tag, testo, classe) {
  const e = document.createElement(tag); e.textContent = String(testo);
  if (classe) e.className = classe;
  return e;
}
const riprovaFonti = elemento('button', 'Riprova fonti mancanti', 'btn quiet more');
riprovaFonti.id = 'riprovaFonti'; riprovaFonti.type = 'button'; riprovaFonti.hidden = true;
$('altri').before(riprovaFonti);
function fonteInPausa(s) {
  return s?.pausa?.fermo && (s.pausa.fino == null || s.pausa.fino > Date.now());
}
function fonteFallita(s) {
  return !s || s.parzialeRete || ['error', 'timeout'].includes(s.status)
    || s.status === 'skipped' && (s.pausa?.fermo || s.reason === 'in pausa dopo un blocco');
}
function aggiornaRetryPrimaPagina(avvisa = false) {
  const mancanti = Object.entries(primaPaginaMancante);
  riprovaFonti.hidden = !mancanti.length;
  riprovaFonti.disabled = ricercaOccupata || filtriModificati
    || !mancanti.some(([, s]) => !fonteInPausa(s.source));
  if (!avvisa) return;
  for (const avviso of $('avvisi').querySelectorAll('[data-prima-pagina]')) avviso.remove();
  for (const [fonte, { source: s }] of mancanti) {
    const pausa = fonteInPausa(s) ? ' Fonte in pausa'
      + (s.pausa.fino != null ? ' fino alle ' + new Date(s.pausa.fino).toLocaleTimeString('it-IT') : '') + '.' : '';
    const avviso = elemento('div', `${nomiFonti[fonte] || fonte}: prima pagina mancante. ${s?.reason || s?.parziale || 'Risposta non disponibile'}${s?.erroreHttp === 429 ? ' (429)' : ''}.${pausa} Riprova le fonti mancanti.`, 'alert');
    avviso.dataset.primaPagina = fonte; $('avvisi').append(avviso);
  }
}
function fontiConAltrePagine() {
  return Object.entries(fontiCorrenti || {}).filter(([f, s]) => !primaPaginaMancante[f]
    && s && s.hasMore !== false && ['ok', 'empty'].includes(s.status) && (pagineFonti[f] ?? pagina) < 50)
    .map(([f]) => f);
}
function statoClasse(stato) {
  return ['ok', 'concluso', 'online', 'empty'].includes(stato) ? 'ok'
    : ['errore', 'error', 'timeout', 'incerto', 'interrotto'].includes(stato) ? 'bad' : 'wait';
}
function statoLavoro(stato) {
  return ({ concluso: 'Concluso', interrotto: 'Interrotto prima dell’avvio',
    incerto: 'Avviato, esito non confermato', errore: 'Terminato con errore',
    attesa: 'In coda', in_corso: 'In corso' })[stato] || stato;
}
function orario(ts) { return ts ? new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
const millisecondi = n => Number.isFinite(n) && n >= 0 ? `${Math.round(n)} ms` : '—';
const dimensione = n => Number.isFinite(n) && n >= 0 ? `${Math.round(n / 1024)} KiB` : '—';
function renderStato(data) {
  const nodi = data.nodi || [], lavori = data.lavori || [];
  paginaVisualizzata = data.pagina || 1; pagineDisponibili = data.pagine || 1;
  const metriche = [[String(nodi.filter(n => n.online).length) + '/' + nodi.length, 'nodi online'],
    [nodi.filter(n => n.occupato).length, 'nodi occupati'],
    [nodi.reduce((n, x) => n + (x.sospeso ? 1 : x.sospese.length), 0), 'sospensioni manuali'],
    [data.lavoriAttivi ?? lavori.filter(x => ['attesa', 'in_corso'].includes(x.stato)).length, 'lavori attivi']];
  $('metriche').replaceChildren(...metriche.map(([n, etichetta]) => {
    const card = elemento('div', '', 'metric'); card.append(elemento('b', n), elemento('span', etichetta)); return card;
  }));
  const box = $('nodi'), focusNodo = box.contains(document.activeElement) ? document.activeElement : null;
  box.replaceChildren();
  if (!nodi.length) box.append(elemento('p', 'Nessun nodo collegato.', 'muted'));
  for (const n of nodi) {
    const card = elemento('article', '', 'node-card'), head = elemento('div', '', 'node-head');
    const title = elemento('div', '');
    title.append(elemento('h3', n.id), elemento('p', `${n.simulato ? 'Simulato · nessun portale interrogato' : 'Worker reale'} · ${n.occupato ? 'in lavoro' : 'libero'}`));
    head.append(title, elemento('span', '', `status-dot${n.online ? ' live' : ''}`)); card.append(head);
    const rows = elemento('div', '', 'source-rows');
    for (const fonte of ['subito', 'autoscout', 'moto']) {
      const fermo = n.sospeso || n.sospese.includes(fonte) || n.fonti?.[fonte]?.fermo;
      const fine = n.fonti?.[fonte]?.fino;
      const testo = n.autorizzato === false ? 'Credenziale revocata' : !n.online ? 'Nodo offline'
        : n.compatibile === false ? 'Release incompatibile' : n.sospeso || n.sospese.includes(fonte) ? 'Sospesa da Admin'
        : n.fonti?.[fonte]?.fermo ? `Pausa automatica${Number.isFinite(fine) ? ' fino alle ' + new Date(fine).toLocaleTimeString('it-IT') : ''}`
          : 'Disponibile';
      const row = elemento('div', '', 'source-row'); row.append(elemento('span', nomiFonti[fonte]), elemento('span', testo, fermo ? 'stop' : '')); rows.append(row);
    }
    card.append(rows);
    const actions = elemento('div', '', 'node-actions');
    for (const fonte of ['', 'subito', 'autoscout', 'moto']) {
      const attiva = fonte ? n.sospese.includes(fonte) : n.sospeso;
      const b = elemento('button', `${attiva ? 'Riattiva' : 'Sospendi'} ${fonte ? nomiFonti[fonte] : 'nodo'}`, attiva ? 'active' : '');
      b.dataset.nodo = n.id; b.dataset.fonte = fonte;
      b.type = 'button'; b.disabled = !n.online;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await leggi(`/api/admin/nodi/${encodeURIComponent(n.id)}`, { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-amr-local-admin': '1' },
          body: JSON.stringify({ fonte: fonte || null, sospeso: !attiva }) });
          await aggiornaStato();
        } catch (e) { $('aggiornato').textContent = e.message; b.disabled = false; }
      }); actions.append(b);
    }
    if (n.autorizzato !== false) {
      const b = elemento('button','Revoca credenziale'); b.type='button';b.dataset.nodo=n.id;b.dataset.fonte='credenziale';
      b.addEventListener('click', async()=>{
        if (!window.confirm('Revocare la credenziale del nodo? I lavori avviati avranno esito incerto. Per ricollegarlo servirà una nuova chiave.')) return;
        b.disabled=true;
        try {
          await leggi(`/api/admin/nodi/${encodeURIComponent(n.id)}/revoca-token`,{method:'POST',
            headers:{'content-type':'application/json','x-amr-local-admin':'1'},body:'{}'});
          await aggiornaStato();
        } catch(e) { $('aggiornato').textContent=e.message;b.disabled=false; }
      }); actions.append(b);
    }
    card.append(actions);
    box.append(card);
  }
  if (focusNodo && document.activeElement === document.body) {
    const equivalente = Array.from(box.querySelectorAll('button'))
      .find(b => b.dataset.nodo === focusNodo.dataset.nodo && b.dataset.fonte === focusNodo.dataset.fonte);
    (equivalente && !equivalente.disabled ? equivalente : $('nodoOsservato')).focus({ preventScroll: true });
  }
  const tbody = $('lavori'), scroll = tbody.closest('.table-scroll');
  const focus = tbody.contains(document.activeElement) ? document.activeElement : null;
  const posizione = { top: scroll.scrollTop, left: scroll.scrollLeft };
  const righe = new Map(Array.from(tbody.children, tr => [tr.dataset.lavoro, tr]));
  const presenti = new Set(lavori.map(job => job.id));
  for (const tr of Array.from(tbody.children)) if (!presenti.has(tr.dataset.lavoro)) tr.remove();
  if (!lavori.length) {
    const td = elemento('td', 'Nessun lavoro registrato.'); td.colSpan = 12;
    const tr = document.createElement('tr'); tr.append(td); tbody.append(tr);
  }
  for (const [indice, job] of lavori.entries()) {
    const tr = righe.get(job.id) || document.createElement('tr');
    tr.dataset.lavoro = job.id;
    const state = elemento('span', statoLavoro(job.stato), `state ${statoClasse(job.stato)}`);
    while (tr.children.length < 12) tr.append(document.createElement('td'));
    tr.children[0].replaceChildren(state);
    const valori = [job.operazione, job.azienda, job.nodo || '—', orario(job.creato),
      job.http ?? '—', millisecondi(job.assegnazione_ms), millisecondi(job.coda_ms),
      millisecondi(job.nodo_ms), millisecondi(job.trasporto_ms), dimensione(job.byte_risposta)];
    valori.forEach((v, i) => { tr.children[i + 1].textContent = String(v); });
    const cell = tr.children[11];
    if (job.filtri) {
      let disclosure = cell.querySelector('details');
      if (!disclosure) {
        disclosure = document.createElement('details');
        disclosure.append(elemento('summary', 'Dettagli'), elemento('pre', ''));
        cell.replaceChildren(disclosure);
      }
      const pre = disclosure.querySelector('pre'), testo = JSON.stringify(job.filtri, null, 2);
      if (pre.textContent !== testo) pre.textContent = testo;
    } else cell.textContent = '—';
    if (tbody.children[indice] !== tr) tbody.insertBefore(tr, tbody.children[indice] || null);
  }
  if (focus) {
    const destinazione = tbody.contains(focus) ? focus : scroll;
    if (document.activeElement !== destinazione) destinazione.focus({ preventScroll: true });
  }
  scroll.scrollTop = posizione.top; scroll.scrollLeft = posizione.left;
  $('lavoriPagina').textContent = `Pagina ${data.pagina || 1} di ${data.pagine || 1} · ${data.totale ?? lavori.length} lavori`;
  $('lavoriPrima').disabled = paginaLavori <= 1;
  $('lavoriDopo').disabled = paginaLavori >= (data.pagine || 1);
  $('aggiornato').textContent = 'Aggiornato alle ' + new Date().toLocaleTimeString('it-IT');
  const eventi = $('eventi'); eventi.replaceChildren();
  for (const e of data.eventi || []) eventi.append(elemento('li',
    `${orario(e.ts)} · ${nomiEventi[e.codice] || e.codice}${e.fonte ? ' · ' + (nomiFonti[e.fonte] || e.fonte) : ''}${e.nodo ? ' · ' + e.nodo : ''}${e.http ? ' · HTTP ' + e.http : ''}${e.lavoro ? ' · lavoro ' + e.lavoro.slice(0, 8) : ''}`));
  if (!eventi.childElementCount) eventi.append(elemento('li', 'Nessun evento operativo recente.'));
}
async function aggiornaStato(manuale = false) {
  if (!diagnosticaAbilitata) return;
  const numero = ++sequenzaStato;
  aggiornamentoStato = numero;
  if (manuale) { $('aggiorna').disabled = true; $('lavoriPrima').disabled = true;
    $('lavoriDopo').disabled = true; $('aggiornato').textContent = 'Aggiornamento in corso…'; }
  try {
    const elenco = await leggi('/api/stato');
    if (numero !== sequenzaStato) return;
    const ids = elenco.nodi.map(n => n.id).sort().join('|');
    if (ids !== nodiElencati) {
      nodiElencati = ids;
      const scelta = $('nodoOsservato').value;
      opzioni($('nodoOsservato'), ['', ...elenco.nodi.map(n => n.id).sort()]);
      $('nodoOsservato').options[0].textContent = 'Tutti i nodi';
      $('nodoOsservato').value = elenco.nodi.some(n => n.id === scelta) ? scelta : '';
    }
    const url = () => '/api/admin?pagina=' + paginaLavori
      + ($('nodoOsservato').value ? '&nodo=' + encodeURIComponent($('nodoOsservato').value) : '');
    let dettaglio = await leggi(url());
    if (numero !== sequenzaStato) return;
    if (paginaLavori > (dettaglio.pagine || 1)) {
      paginaLavori = dettaglio.pagine || 1;
      dettaglio = await leggi(url());
    }
    if (numero === sequenzaStato) renderStato(dettaglio);
  } catch (e) { if (numero === sequenzaStato) {
    paginaLavori = paginaVisualizzata;
    $('aggiornato').textContent = 'Stato non disponibile: ' + e.message;
  } }
  finally {
    if (numero === sequenzaStato) {
      aggiornamentoStato = 0; $('aggiorna').disabled = false;
      $('lavoriPrima').disabled = paginaLavori <= 1;
      $('lavoriDopo').disabled = paginaLavori >= pagineDisponibili;
    }
  }
}
function renderRisultato(body, aggiungi = false, richieste = null, paginaRisposta = pagina) {
  const righe = Array.isArray(body.risultati) ? body.risultati : [];
  risultatiCorrenti = aggiungi ? [...risultatiCorrenti, ...righe] : righe;
  fontiCorrenti = { ...(aggiungi ? fontiCorrenti : {}), ...Object.fromEntries(
    Object.entries(body.sources || {}).filter(([f]) => !aggiungi || !richieste || richieste.includes(f))) };
  $('ricercaStato').textContent = `${risultatiCorrenti.length} annunci`;
  $('risultatoAiuto').textContent = `Pagina ${paginaRisposta + 1} · ${righe.length} risultati in questa risposta`;
  const alert = $('avvisi'); alert.replaceChildren();
  for (const testo of body.avvisiNodi || []) alert.append(elemento('div', testo, 'alert'));
  for (const testo of paginaIncompleta?.avvisiErrori || []) alert.append(elemento('div', testo, 'alert'));
  for (const [fonte, s] of Object.entries(body.sources || {})) {
    if (aggiungi && richieste && !richieste.includes(fonte)) continue;
    if (primaPaginaMancante[fonte]) continue;
    if (!aggiungi && tipo() === 'auto' && fonte === 'moto' && s?.status === 'skipped') continue;
    if (s && (['error', 'timeout', 'skipped'].includes(s.status) || s.parziale || s.parzialeRete)) {
      alert.append(elemento('div', `${nomiFonti[fonte] || fonte}: ${s.reason || s.parziale || 'risposta parziale o non disponibile'}`, 'alert'));
    }
  }
  const fonti = $('fonti'); fonti.replaceChildren();
  for (const [fonte, s] of Object.entries(fontiCorrenti || {})) {
    const card = elemento('div', '', 'source-box');
    card.append(elemento('b', nomiFonti[fonte] || fonte), elemento('span', `${s.status} · ${s.count ?? 0} qui${s.hasMore === true ? ' · altre pagine' : ''}`));
    fonti.append(card);
  }
  const lista = $('risultati');
  if (!aggiungi || !lista.querySelector('.listing')) lista.replaceChildren();
  if (!risultatiCorrenti.length) lista.append(elemento('p', 'Nessun annuncio in questa ricerca.', 'muted'));
  for (const r of righe) {
    const card = elemento('article', '', 'listing');
    let url = null;
    try { const x = new URL(r.url); if (x.protocol === 'https:') url = x.href; } catch (_) {}
    if (url) { const a = elemento('a', r.titolo || 'Apri annuncio'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; card.append(a); }
    else card.append(elemento('strong', r.titolo || 'Annuncio'));
    const prezzo = Number.isFinite(r.prezzo) ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(r.prezzo) : 'Prezzo non indicato';
    card.append(elemento('div', [nomiFonti[r.fonte] || r.fonte, prezzo, r.anno, r.km != null ? `${r.km} km` : null].filter(Boolean).join(' · '), 'meta'));
    if (url && r.accessoDettagli) {
      const box = document.createElement('details');
      box.append(elemento('summary', 'Dettagli'));
      const stato = elemento('p', '', 'muted'), retry = elemento('button', 'Riprova');
      retry.type = 'button'; retry.hidden = true;
      box.append(stato, retry);
      let occupato = false, completato = false;
      const carica = async () => {
        if (occupato || completato) return;
        occupato = true; retry.hidden = true; stato.textContent = 'Caricamento dettagli…';
        try {
          const d = await leggi('/api/detail?' + new URLSearchParams({ url:r.url, accessoDettagli:r.accessoDettagli }));
          if (!card.isConnected) return;
          const campi = { cambio:'Cambio', potenzaCv:'Potenza CV', cilindrata:'Cilindrata',
            proprietari:'Proprietari', allestimento:'Allestimento', revisione:'Revisione' };
          const valori = Object.entries(campi).filter(([k]) => d.detail?.[k] != null)
            .map(([k, label]) => label + ': ' + d.detail[k]);
          stato.textContent = valori.length ? valori.join(' · ') : 'Dettagli non disponibili.';
          completato = Boolean(valori.length); retry.hidden = completato;
        } catch (e) {
          if (card.isConnected) {
            stato.textContent = e.message || 'Dettagli non disponibili.'; retry.hidden = false;
          }
        } finally { occupato = false; }
      };
      box.addEventListener('toggle', () => { if (box.open) carica(); });
      retry.addEventListener('click', carica);
      card.append(box);
    }
    lista.append(card);
  }
  $('altri').hidden = !paginaIncompleta && !fontiConAltrePagine().length;
  $('altri').disabled = filtriModificati;
  aggiornaRetryPrimaPagina(true);
}
async function inviaRicerca(query, aggiungi = false, paginaRichiesta = 0, riprovaPrima = false) {
  if (ricercaOccupata) return;
  const focusRetry = riprovaPrima && document.activeElement === riprovaFonti;
  ricercaOccupata = true; form.querySelector('[type=submit]').disabled = true; $('altri').disabled = true;
  const id = ++sequenzaRicerca;
  $('ricercaStato').textContent = 'Ricerca in corso…';
  if (!aggiungi) { $('risultatoAiuto').textContent = 'Il nodo sta interrogando le fonti selezionate.';
    primaPaginaMancante = {}; pagineFonti = {}; paginaIncompleta = null; filtriModificati = false;
    pagina = 0; risultatiCorrenti = []; fontiCorrenti = null;
    $('risultati').replaceChildren(); $('fonti').replaceChildren(); $('avvisi').replaceChildren(); }
  aggiornaRetryPrimaPagina();
  try {
    const body = await leggi('/api/search?' + query);
    if (id === sequenzaRicerca) {
      const richieste = query.get('fonti')?.split(',') || null;
      if (!aggiungi || riprovaPrima) {
        // Un retry può ripresentare righe parziali già visibili: conserva anche i loro dettagli.
        if (riprovaPrima) {
          const viste = new Set(risultatiCorrenti.map(r => JSON.stringify([r.fonte, r.url])));
          body.risultati = (body.risultati || []).filter(r => richieste.includes(r.fonte)
            && !(r.url && viste.has(JSON.stringify([r.fonte, r.url]))));
        }
        for (const f of richieste || Object.keys(body.sources || {})) {
          const s = body.sources?.[f], precedente = primaPaginaMancante[f];
          if (fonteFallita(s)) {
            const soloRecupero = f === 'subito' && s?.parzialeRete
              && s.errori?.some(e => e.fase === 'recupero')
              && s.errori.every(e => e.fase === 'recupero') && s.recuperoNextStart != null;
            primaPaginaMancante[f] = { source: s, parziale: precedente?.parziale || (soloRecupero ? s : null) };
          } else {
            if (precedente?.parziale) body.sources[f] = { ...s,
              count: risultatiCorrenti.filter(r => r.fonte === f).length
                + (body.risultati || []).filter(r => r.fonte === f).length,
              totale: precedente.parziale.totale ?? s.totale,
              mainNextStart: precedente.parziale.mainNextStart,
              hasMore: precedente.parziale.mainNextStart != null || s.recuperoNextStart != null };
            delete primaPaginaMancante[f]; pagineFonti[f] = 0;
          }
        }
        renderRisultato(body, aggiungi, richieste, paginaRichiesta);
        if (!paginaIncompleta) $('altri').textContent = 'Carica altro';
        await aggiornaStato(); return;
      }
      const fallite = (richieste || []).filter(f => {
        const s = body.sources?.[f];
        return !s || s.parzialeRete || !['ok', 'empty'].includes(s.status)
          && !(s.status === 'skipped' && s.hasMore === false && !fonteFallita(s));
      });
      const completaFonte = (accumulo, fonte) => {
        const s = body.sources[fonte];
        const righe = (body.risultati || []).filter(r => r.fonte === fonte);
        const parziale = accumulo.parziali?.[fonte];
        if (!parziale) return { source: s, righe };
        delete accumulo.parziali[fonte];
        const unite = [...parziale.righe, ...righe];
        return { righe: unite, source: { ...s, count: unite.length,
          totale: parziale.source.totale ?? s.totale,
          mainNextStart: parziale.source.mainNextStart,
          hasMore: parziale.source.mainNextStart != null || s.recuperoNextStart != null } };
      };
      if (fallite.length) {
        const accumulo = paginaIncompleta || { pagina: paginaRichiesta, risultati: [], sources: {},
          parziali: {}, avvisiNodi: [] };
        for (const f of (richieste || []).filter(f => !fallite.includes(f))) {
          const { source, righe } = completaFonte(accumulo, f);
          accumulo.sources[f] = source;
          accumulo.risultati.push(...righe);
        }
        if (fallite.includes('subito') && !accumulo.parziali.subito) {
          const s = body.sources?.subito;
          if (s?.parzialeRete && s.errori?.some(e => e.fase === 'recupero')
              && s.recuperoNextStart != null) {
            accumulo.parziali.subito = { source: s,
              righe: (body.risultati || []).filter(r => r.fonte === 'subito') };
          }
        }
        accumulo.avvisiNodi.push(...(body.avvisiNodi || []));
        accumulo.fallite = fallite;
        paginaIncompleta = accumulo;
        $('ricercaStato').textContent = 'Pagina incompleta';
        accumulo.avvisiErrori = fallite.map(f =>
          `${nomiFonti[f] || f}: ${body.sources?.[f]?.reason || 'risposta non disponibile'}. Riprova questa pagina.`);
        $('avvisi').replaceChildren(...accumulo.avvisiErrori.map(testo => elemento('div', testo, 'alert')));
        $('altri').hidden = false;
        $('altri').textContent = 'Riprova questa pagina';
      } else {
        if (paginaIncompleta) {
          for (const f of (richieste || [])) {
            if (!paginaIncompleta.parziali?.[f]) continue;
            const { source, righe } = completaFonte(paginaIncompleta, f);
            body.sources[f] = source;
            body.risultati = [...(body.risultati || []).filter(r => r.fonte !== f), ...righe];
          }
          body.risultati = [...paginaIncompleta.risultati, ...(body.risultati || [])];
          body.sources = { ...body.sources, ...paginaIncompleta.sources,
            ...Object.fromEntries((richieste || []).map(f => [f, body.sources[f]])) };
          body.avvisiNodi = [...paginaIncompleta.avvisiNodi, ...(body.avvisiNodi || [])];
          richieste.push(...Object.keys(paginaIncompleta.sources));
          paginaIncompleta = null;
        }
        pagina = Math.max(pagina, paginaRichiesta);
        for (const f of richieste || []) pagineFonti[f] = paginaRichiesta;
        renderRisultato(body, aggiungi, richieste, paginaRichiesta);
        $('altri').textContent = 'Carica altro';
      }
    }
    await aggiornaStato();
  } catch (e) {
    if (id === sequenzaRicerca) {
      $('ricercaStato').textContent = 'Non riuscita';
      $('avvisi').replaceChildren(elemento('div', e.message, 'alert'));
      if (aggiungi && !riprovaPrima) $('altri').textContent = 'Riprova questa pagina';
    }
  } finally {
    if (id === sequenzaRicerca) {
      ricercaOccupata = false; form.querySelector('[type=submit]').disabled = false; $('altri').disabled = filtriModificati;
      aggiornaRetryPrimaPagina(true);
      if (focusRetry && !filtriModificati && document.activeElement === document.body) {
        (riprovaFonti.hidden ? $('risultati') : riprovaFonti).focus({ preventScroll: true });
      }
    }
  }
}

async function applicaIdentita(data) {
  identita = data.azienda; moduli = data.moduli; sequenzaRicerca++; ricercaOccupata = false;
  aggiornaAree();
  paginaLavori = 1;
  parametriRicerca = null; pagina = 0; fontiCorrenti = null; risultatiCorrenti = [];
  paginaIncompleta = null; filtriModificati = false;
  primaPaginaMancante = {}; pagineFonti = {}; aggiornaRetryPrimaPagina();
  $('ricercaStato').textContent = 'In attesa';
  $('fonti').replaceChildren(); $('risultati').replaceChildren(); $('avvisi').replaceChildren();
  $('altri').hidden = true; $('altri').textContent = 'Carica altro';
  form.querySelector('[type=submit]').disabled = false; $('altri').disabled = false;
  $('identita').textContent = `${data.azienda} · ${moduli.join(' + ')}`;
  $('risultatoAiuto').textContent = 'Scegli marca, modello e versione, poi avvia la ricerca.';
  form.hidden = false;
  for (const radio of form.querySelectorAll('[name=tipo]')) radio.disabled = !moduli.includes(radio.value);
  for (const button of document.querySelectorAll('[data-scenario]')) {
    button.disabled = !moduli.includes(button.dataset.scenario);
  }
  if (moduli.length) {
    const t = moduli.includes(tipo()) ? tipo() : moduli[0];
    form.querySelector(`[name=tipo][value=${t}]`).checked = true;
    await aggiornaTipo(); await caricaFiltri();
  }
  await aggiornaStato();
}
// Una sessione cambiata invalida anche risposte e pagine in attesa nel browser.
function terminaContesto() {
  sequenzaRicerca++; sequenzaStato++; sequenzaMarche++; sequenzaModelli++; sequenzaVersioni++;
  aggiornamentoStato = 0;
  $('aggiorna').disabled = false; $('lavoriPrima').disabled = true; $('lavoriDopo').disabled = true;
  identita = null; moduli = []; parametriRicerca = null; paginaIncompleta = null;
  primaPaginaMancante = {}; pagineFonti = {}; aggiornaRetryPrimaPagina();
  risultatiCorrenti = []; fontiCorrenti = null; ricercaOccupata = false;
  form.hidden = true; $('altri').hidden = true;
  for (const id of ['fonti', 'risultati', 'avvisi', 'metriche', 'nodi', 'lavori', 'eventi']) $(id).replaceChildren();
  $('ricercaStato').textContent = 'In attesa';
  $('identita').textContent = 'Accedi con il tuo account locale.';
  $('risultatoAiuto').textContent = 'Le ricerche richiedono un account e un’azienda attiva.';
}
let contestoAccount = '';
document.addEventListener('amr:account', async e => {
  const me = e.detail, firma = JSON.stringify(me);
  if (firma === contestoAccount) return;
  const focusPrecedente = document.activeElement;
  contestoAccount = firma; terminaContesto();
  diagnosticaAbilitata = Boolean(me?.admin);
  aggiornaAree(false, focusPrecedente);
  if (diagnosticaAbilitata) aggiornaStato();
  if (me?.aziendaValida) {
    try { await applicaIdentita(me); }
    catch { $('identita').textContent = 'Impossibile aggiornare i cataloghi dell’account.'; }
  } else if (me) $('identita').textContent = me.admin
    ? 'Admin gestionale: le ricerche si apriranno con l’account del referente, dopo accettazione e attivazione dell’azienda.' : 'Azienda non attiva: completa l’invito e attendi l’attivazione dell’Admin.';
  aggiornaAree();
});
$('entra').addEventListener('click', async () => {
  try {
    const data = await leggi('/api/test/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ azienda: $('azienda').value }) });
    await applicaIdentita(data);
  } catch (e) { $('identita').textContent = e.message; }
});
for (const radio of form.querySelectorAll('[name=tipo]')) radio.addEventListener('change', aggiornaTipo);
function filtriCambiati() {
  if (!parametriRicerca) return;
  filtriModificati = true;
  $('altri').disabled = true;
  aggiornaRetryPrimaPagina();
  $('risultatoAiuto').textContent = 'Filtri modificati: avvia una nuova ricerca per continuare.';
}
form.addEventListener('input', filtriCambiati);
form.addEventListener('change', filtriCambiati);
$('marca').addEventListener('input', () => { $('modello').value = ''; $('versione').value = ''; caricaModelli(); });
$('modello').addEventListener('input', () => { $('versione').value = ''; caricaVersioni(); });
for (const button of document.querySelectorAll('[data-scenario]')) button.addEventListener('click', async () => {
  const t = button.dataset.scenario;
  if (!moduli.includes(t)) { messaggio('L’identità corrente non ha il modulo ' + t + '.'); return; }
  form.querySelector(`[name=tipo][value=${t}]`).checked = true; await aggiornaTipo();
  $('marca').value = t === 'auto' ? 'Fiat' : 'Yamaha'; await caricaModelli();
  $('modello').value = t === 'auto' ? 'Panda' : 'MT-07'; await caricaVersioni();
  $('versione').value = 'Nessuna Versione'; messaggio('');
  filtriCambiati();
});
form.addEventListener('submit', e => {
  e.preventDefault();
  if (ricercaOccupata) return;
  try { parametriRicerca = preparaRicerca(); pagina = 0; risultatiCorrenti = []; fontiCorrenti = null;
    paginaIncompleta = null; filtriModificati = false;
    $('altri').hidden = true; $('altri').textContent = 'Carica altro'; messaggio(''); inviaRicerca(parametriRicerca, false, 0); }
  catch (errore) { messaggio(errore.message); }
});
$('altri').addEventListener('click', () => {
  if (!parametriRicerca || ricercaOccupata || filtriModificati) return;
  const q = new URLSearchParams(parametriRicerca);
  const disponibili = fontiConAltrePagine();
  const prossimaPagina = paginaIncompleta?.pagina ?? Math.min(...disponibili.map(f => (pagineFonti[f] ?? pagina) + 1));
  const fonti = paginaIncompleta?.fallite || disponibili.filter(f => (pagineFonti[f] ?? pagina) + 1 === prossimaPagina);
  if (!fonti.length) return;
  q.set('fetta', String(prossimaPagina)); q.set('fonti', fonti.join(','));
  if (fonti.includes('subito')) {
    const inSospeso = paginaIncompleta?.parziali?.subito;
    const cursore = inSospeso?.source || fontiCorrenti.subito;
    q.set('subitoMainStart', String(inSospeso ? -1 : cursore.mainNextStart ?? -1));
    q.set('subitoRecuperoStart', String(inSospeso ? cursore.recuperoNextStart
      : cursore.recuperoNextStart ?? -1));
  }
  inviaRicerca(q, true, prossimaPagina);
});
riprovaFonti.addEventListener('click', () => {
  if (!parametriRicerca || ricercaOccupata || filtriModificati) return;
  const fonti = Object.keys(primaPaginaMancante).filter(f => !fonteInPausa(primaPaginaMancante[f].source));
  if (!fonti.length) return;
  const q = new URLSearchParams(parametriRicerca);
  q.set('fetta', '0'); q.set('fonti', fonti.join(','));
  const parziale = primaPaginaMancante.subito?.parziale;
  if (fonti.includes('subito') && parziale) {
    q.set('subitoMainStart', '-1'); q.set('subitoRecuperoStart', String(parziale.recuperoNextStart));
  }
  inviaRicerca(q, true, 0, true);
});
$('aggiorna').addEventListener('click', () => aggiornaStato(true));
$('nodoOsservato').addEventListener('change', () => { paginaLavori = 1; aggiornaStato(true); });
$('lavoriPrima').addEventListener('click', () => { if (paginaLavori > 1) { paginaLavori--; aggiornaStato(true); } });
$('lavoriDopo').addEventListener('click', () => { paginaLavori++; aggiornaStato(true); });
$('cancellaLavori').addEventListener('click', async () => {
  if (!window.confirm('Eliminare i lavori terminati, inclusi quelli falliti? Quelli ancora in corso resteranno. Puoi esportare prima il log.')) return;
  const bottone = $('cancellaLavori'); bottone.disabled = true;
  try {
    const esito = await leggi('/api/admin/lavori', { method: 'DELETE',
      headers: { 'x-amr-local-admin': '1' } });
    paginaLavori = 1;
    await aggiornaStato(true);
    $('aggiornato').textContent = `${esito.rimossi} lavori terminati eliminati`;
  } catch (e) { $('aggiornato').textContent = `Cancellazione non riuscita: ${e.message}`; }
  finally { bottone.disabled = false; }
});
form.hidden = true;
setInterval(() => {
  aggiornaRetryPrimaPagina();
  if (!aggiornamentoStato && !$('aggiorna').disabled) aggiornaStato();
}, 3000);
leggi('/api/test/config').then(async config => {
  if (config.accesso === 'nhost') {
    document.querySelector('.identity-card').hidden = true;
    $('risultatoAiuto').textContent = 'Le ricerche richiedono una licenza aziendale e un nodo disponibile.';
    accountAbilitato = true; aggiornaAree(false);
    const script = document.createElement('script');
    script.src = '/api/auth/aziende/pagina.js'; script.defer = true;
    script.onerror = () => { $('accountPanel').querySelector('[data-account-prototipo]').textContent =
      'Gestione account non disponibile. Ricarica la pagina per riprovare.'; };
    document.head.append(script);
    for (const src of ['/api/auth/colleghi/pagina.js', '/prototipo-backup.js']) {
      const aggiunto = document.createElement('script'); aggiunto.src = src; aggiunto.defer = true;
      document.head.append(aggiunto);
    }
  } else {
    accessoSintetico = true; diagnosticaAbilitata = true; aggiornaAree(); aggiornaStato();
    try { const data = await leggi('/api/test/me'); $('azienda').value = data.azienda; await applicaIdentita(data); }
    catch {}
  }
}).catch(() => { $('identita').textContent = 'Configurazione accessi non disponibile.'; });
