'use strict';
// AI mode — client dell'assistente interno AMR. Flusso: scegli categoria (bottoni) →
// eventuale OEM sì/no per i ricambi → chat con l'endpoint SSE /api/assistant.
// La categoria è deterministica (niente classificazione LLM): il modello estrae solo i parametri.

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => (typeof n === 'number' ? '€ ' + n.toLocaleString('it-IT') : null);
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : null);

let cat = null, oem = false, pendingCat = null;
let history = [];
let busy = false;

// ── Tema ──
$('themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = dark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('amr_theme', next); } catch {}
});

// ── Step 1: categoria ──
const CTX_LABEL = { auto: 'Auto usate', moto: 'Moto usate', ricambio_auto: 'Ricambi auto', ricambio_moto: 'Ricambi moto' };
const PLACEHOLDER = {
  auto: 'Es. golf diesel dal 2018, sotto i 15.000, in Lombardia',
  moto: 'Es. yamaha mt-07 dal 2019, max 50.000 km',
  ricambio_oem: 'Es. 1K0905851B',
  ricambio_free: 'Es. pastiglie freni anteriori',
};

document.querySelectorAll('.cat').forEach(b => b.addEventListener('click', () => {
  const c = b.dataset.cat;
  if (c === 'auto' || c === 'moto') { startChat(c, false); return; }
  pendingCat = c;
  $('oemSub').classList.remove('d-none');
  $('oemSub').scrollIntoView({ behavior: 'smooth', block: 'center' });
}));
document.querySelectorAll('.pill[data-oem]').forEach(b => b.addEventListener('click', () => {
  startChat(pendingCat, b.dataset.oem === '1');
}));
$('backCat').addEventListener('click', () => { $('oemSub').classList.add('d-none'); pendingCat = null; });
$('ctxReset').addEventListener('click', resetToPicker);

function startChat(c, isOem) {
  cat = c; oem = !!isOem; history = [];
  $('picker').classList.add('d-none');
  $('oemSub').classList.add('d-none');
  $('chat').classList.remove('d-none');
  $('thread').innerHTML = '';
  const isRic = c.startsWith('ricambio');
  $('ctxLabel').textContent = CTX_LABEL[c] + (isRic ? (isOem ? ' · codice OEM' : ' · codice o nome') : '');
  $('input').placeholder = isRic ? PLACEHOLDER[isOem ? 'ricambio_oem' : 'ricambio_free'] : PLACEHOLDER[c];
  $('input').focus();
}
function resetToPicker() {
  cat = null; pendingCat = null; history = [];
  $('chat').classList.add('d-none');
  $('picker').classList.remove('d-none');
  $('oemSub').classList.add('d-none');
}

// ── Chat / composer ──
$('composer').addEventListener('submit', e => {
  e.preventDefault();
  const t = $('input').value.trim();
  if (!t || busy) return;
  $('input').value = '';
  sendTurn(t);
});

function bubble(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  $('thread').appendChild(el);
  scrollDown();
  return el;
}
function scrollDown() { requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })); }
function setBusy(b) { busy = b; $('send').disabled = b; $('input').disabled = b; }

async function sendTurn(text) {
  setBusy(true);
  bubble('user', text);
  const thinking = bubble('bot thinking', 'Sto pensando');
  thinking.innerHTML = '<span class="dots">Sto pensando</span>';
  let thinkingLive = true;
  const dropThinking = () => { if (thinkingLive) { thinking.remove(); thinkingLive = false; } };

  try {
    const resp = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, history, ctx: { categoria: cat, oem } }),
    });
    if (!resp.ok || !resp.body) {
      dropThinking();
      let msg = 'Assistente non disponibile ora.';
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch {}
      bubble('bot err', msg);
      return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        handleEvent(chunk, dropThinking);
      }
    }
  } catch (e) {
    dropThinking();
    bubble('bot err', 'Connessione interrotta. Riprova.');
  } finally {
    dropThinking();
    setBusy(false);
    $('input').focus();
  }
}

function handleEvent(chunk, dropThinking) {
  let ev = 'message', data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) ev = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
  }
  let payload = {};
  try { payload = data ? JSON.parse(data) : {}; } catch { return; }

  if (ev === 'text') { dropThinking(); if (payload.text) bubble('bot', payload.text); }
  else if (ev === 'results') { dropThinking(); renderResults(payload); }
  else if (ev === 'error') { dropThinking(); bubble('bot err', payload.message || 'Errore.'); }
  else if (ev === 'done') { if (Array.isArray(payload.history)) history = payload.history; }
}

// ── Render risultati ──
function renderResults(p) {
  const box = document.createElement('div');
  box.className = 'res';
  box.innerHTML = p.kind === 'ricambi' ? ricambiHTML(p) : veicoliHTML(p);
  $('thread').appendChild(box);
  scrollDown();
}

function veicoliHTML(p) {
  const st = p.stats || {};
  const arr = (p.risultati || []);
  const cap = 18;
  const head = `<div class="res-head"><span class="tp">${esc([p.params?.marca, p.params?.modello].filter(Boolean).join(' ') || 'Risultati')}</span>` +
    `<span class="res-stat">${arr.length ? `<b>${st.totale ?? arr.length}</b> annunci · min <b>${eur(st.min) || '—'}</b> · mediana <b>${eur(st.mediana) || '—'}</b> · max <b>${eur(st.max) || '—'}</b>` : 'nessun annuncio'}</span></div>`;
  if (!arr.length) return head;
  const cards = arr.slice(0, cap).map(a => {
    const u = safeUrl(a.url);
    const titolo = esc(a.titolo || 'Annuncio');
    const nome = u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${titolo}</a>` : `<span>${titolo}</span>`;
    const meta = [a.anno, a.km != null ? a.km.toLocaleString('it-IT') + ' km' : null, a.provincia].filter(Boolean).map(esc).join(' · ');
    return `<div class="card">${nome}<span class="price">${eur(a.prezzo) || '—'}</span><span class="meta">${meta}</span><span class="src">${esc(a.fonte || '')}</span></div>`;
  }).join('');
  const more = arr.length > cap ? `<div class="more">…e altri ${arr.length - cap} annunci</div>` : '';
  return head + `<div class="cards">${cards}</div>${more}`;
}

function ricambiHTML(p) {
  const arr = (p.articoli || []);
  const tipo = p.tipoPezzo || (p.scheda && p.scheda.tipoPezzo) || 'Ricambio';
  const cap = 18;
  const head = `<div class="res-head"><span class="tp">${esc(tipo)}</span>` +
    `<span class="res-stat">${esc(p.oen || '')}${p.veicoli ? ' · ' + esc(String(p.veicoli).slice(0, 80)) : ''} · <b>${arr.length}</b> offerte</span></div>`;
  if (!arr.length && !p.scheda) return head;
  const cards = arr.slice(0, cap).map(a => {
    const u = safeUrl(a.url);
    const nome = esc((a.marca ? a.marca + ' ' : '') + (a.nome || 'Articolo'));
    const titolo = u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${nome}</a>` : `<span>${nome}</span>`;
    const prezzo = typeof a.prezzo === 'number' ? eur(a.prezzo) : (a.fonte === 'subito' ? 'trattabile' : 'prezzo sul sito');
    return `<div class="card">${titolo}<span class="price">${esc(prezzo)}</span><span class="src">${esc(a.fonte || '')}</span></div>`;
  }).join('');
  const more = arr.length > cap ? `<div class="more">…e altre ${arr.length - cap} offerte</div>` : '';
  return head + (arr.length ? `<div class="cards">${cards}</div>${more}` : '<div class="more">Scheda trovata a catalogo; nessuna offerta usata sul mercato ora.</div>');
}
