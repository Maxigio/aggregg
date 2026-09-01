'use strict';
// Webhook Meta WhatsApp Cloud API. Montato da server.js e aggiunto ad AUTH_FREE
// (Meta non ha il cookie: la sicurezza è la firma HMAC, non l'IP).
// - GET  : handshake di verifica (hub.mode/hub.verify_token/hub.challenge).
// - POST : messaggi in entrata. Verifica X-Hub-Signature-256 sul RAW body, ack 200
//   immediato, poi elabora async (il bot può metterci secondi; Meta vuole 200 rapido).
const express = require('express');
const crypto = require('node:crypto');
const bot = require('./bot');
const waClient = require('./client');
const auth = require('../auth');

const PATH = '/api/whatsapp/webhook';

// ── Firma: sha256=HMAC(app_secret, rawBody), timing-safe. Richiede APP_SECRET.
function verifySignature(rawBuf, header) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) { console.error('[wa] WHATSAPP_APP_SECRET assente → POST rifiutata'); return false; }
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBuf).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Allowlist mittenti (csv in WHATSAPP_ALLOWED_SENDERS) — FALLBACK LEGACY.
// VUOTO = NESSUNO, non "tutti". Prima l'elenco vuoto lasciava passare chiunque, e il `from`
// lo scrive chi manda il payload: era anche il modo di aggirare il rate limit, che e' chiavato
// proprio su quel numero (basta cambiare una cifra). Una porta che si apre da sola quando non
// la si configura e' il contrario di una porta.
// Oggi la via principale e' auth.personaDaTelefono (numero → persona di auth.json, con nome):
// questa lista resta per retrocompatibilita', autorizza SENZA identita'.
const digits = s => String(s || '').replace(/\D/g, '');
function allowed(from) {
  const raw = (process.env.WHATSAPP_ALLOWED_SENDERS || '').trim();
  if (!raw) return false;
  return raw.split(',').map(digits).filter(Boolean).includes(digits(from));
}

// ── Numeri sconosciuti: risposta cortese UNA volta per numero, poi silenzio.
// Il payload e' gia' autenticato dalla firma HMAC di Meta, quindi il `from` e' un numero vero:
// rispondergli una volta spiega la porta chiusa senza offrire un canale di spam. Il TTL con
// sweep (stesso pattern di rlHits) evita che la mappa cresca per sempre e fa si' che chi
// riprova il giorno dopo riceva di nuovo la spiegazione, non il silenzio assoluto.
const RIFIUTO_TTL = 24 * 60 * 60 * 1000;
const rifiutati = new Map();
const MSG_NON_RICONOSCIUTO = 'Questo numero non è associato a nessun account Auto Moto Radar, quindi non posso risponderti qui. Se pensi sia un errore, contatta chi gestisce il servizio.';
async function rifiutaCortese(from) {
  const now = Date.now();
  for (const [k, t] of rifiutati) if (now - t > RIFIUTO_TTL) rifiutati.delete(k);
  console.warn('[wa] mittente non riconosciuto:', from);
  if (rifiutati.has(from)) return;
  rifiutati.set(from, now);
  await waClient.sendText(from, MSG_NON_RICONOSCIUTO).catch(() => {});
}

// ── Disclosure AI Act (Art. 50): chi parla con un sistema AI deve saperlo, all'inizio di
// OGNI sessione. Obbligo legale, non una preferenza: il testo si puo' riformulare via env
// (WA_DISCLOSURE_TEXT) ma MAI svuotare — stringa vuota o assente = testo di default.
const DISCLOSURE_DEFAULT = 'Sei in contatto con l\'assistente AI di Auto Moto Radar, un sistema automatico di intelligenza artificiale.';
const disclosureText = () => (process.env.WA_DISCLOSURE_TEXT || '').trim() || DISCLOSURE_DEFAULT;

// ── Stato conversazione in memoria, TTL 30 min. ponytail: in-memory; tabella DB
// wa_conversations se serve persistenza cross-restart.
// `disclosed` nasce false a OGNI creazione dello stato (prima interazione o TTL scaduto):
// e' il segnale che la disclosure AI Act va (ri)mandata. La scadenza del TTL che fa ripartire
// la disclosure e' il comportamento VOLUTO — una nuova sessione e' una nuova conversazione,
// e la persona va riavvisata: non "ottimizzarlo" via.
const CONV_TTL = 30 * 60 * 1000;
const convs = new Map();
function getConv(from) {
  const now = Date.now();
  for (const [k, v] of convs) if (now - v.ts > CONV_TTL) convs.delete(k);
  let c = convs.get(from);
  if (!c) { c = { history: [], ts: now, disclosed: false }; convs.set(from, c); }
  else c.ts = now;   // rinfresca alla lettura → un utente attivo (anche se il bot erra) non viene potato a metà
  return c;
}

// ── Rate-limit per mittente: 20 richieste / 5 min.
const rlHits = new Map();
function rateOk(from) {
  const now = Date.now(), w = 5 * 60 * 1000, cap = 20;
  for (const [k, v] of rlHits) if (now - v.start >= w) rlHits.delete(k);   // sweep finestre scadute (no leak)
  const rec = rlHits.get(from);
  if (!rec || now - rec.start >= w) { rlHits.set(from, { start: now, count: 1 }); return true; }
  rec.count++; return rec.count <= cap;
}

function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge ?? ''));
  }
  return res.sendStatus(403);
}

let _warnedUnsigned = false;
function warnUnsigned() {
  if (_warnedUnsigned) return; _warnedUnsigned = true;
  console.warn('[wa] ⚠ WHATSAPP_APP_SECRET assente → la webhook RIFIUTA le POST (503). Aggiungilo per attivarla.');
}

function handlePost(req, res, searchFn) {
  const raw = req.body;   // Buffer (express.raw)
  if (!Buffer.isBuffer(raw)) return res.sendStatus(400);
  // FIRMA HMAC OBBLIGATORIA, SEMPRE.
  //
  // Prima, senza `WHATSAPP_APP_SECRET`, si accettava qualunque POST "perche' l'URL del Funnel
  // e' semi-segreto". Non regge: e' l'UNICA rotta in AUTH_FREE, sta su internet mentre tutto il
  // resto e' dietro login, e dentro ci gira `runSearch` vero — cioe' scraping verso Subito,
  // Autoscout e Moto.it dall'IP di casa, piu' un messaggio in uscita. Un URL indovinato o
  // finito in un log altrui bastava. Senza segreto la rotta non risponde: 503, non 200.
  const segreto = process.env.WHATSAPP_APP_SECRET;
  if (!segreto) { warnUnsigned(); return res.status(503).send('webhook non configurata'); }
  if (!verifySignature(raw, req.get('x-hub-signature-256'))) return res.status(401).send('firma non valida');
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
  res.sendStatus(200);   // ack immediato, poi lavoro async
  processPayload(payload, searchFn).catch(e => console.error('[wa] process KO:', e.message));
}

async function processPayload(payload, searchFn) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const msg of value.messages || []) {   // ignora value.statuses (delivery/read)
        await handleInbound(msg, searchFn).catch(e => console.error('[wa] inbound KO:', e.message));
      }
    }
  }
}

// ── Coda per-mittente. handlePost fa ack e NON attende processPayload: due POST ravvicinate
// dello stesso numero girerebbero in parallelo, partendo entrambe dallo STESSO conv.history;
// l'ultima a finire sovrascriverebbe il turno dell'altra (contesto perso, non corrotto).
// La catena di promise serializza i messaggi per numero; un turno fallito non blocca i
// successivi, e la voce si toglie quando la coda si svuota (no leak).
const inboundQueues = new Map();
function handleInbound(msg, searchFn) {
  const from = msg && msg.from;
  if (!from) return Promise.resolve();
  const prev = inboundQueues.get(from) || Promise.resolve();
  const next = prev.then(() => processInbound(msg, searchFn));
  const tail = next.catch(() => {});
  inboundQueues.set(from, tail);
  tail.then(() => { if (inboundQueues.get(from) === tail) inboundQueues.delete(from); });
  return next;
}

async function processInbound(msg, searchFn) {
  const from = msg.from;
  // Chi e': (a) il numero risale a una persona di auth.json → autorizzato CON identita';
  // (b) fallback legacy: numero nell'allowlist env → autorizzato SENZA identita';
  // (c) nessuno dei due → risposta cortese una volta, e il bot NON viene invocato.
  const utente = auth.personaDaTelefono(from);
  if (!utente && !allowed(from)) { await rifiutaCortese(from); return; }
  if (!rateOk(from)) { await waClient.sendText(from, 'Un attimo di pausa 🙏 riprova tra poco.').catch(() => {}); return; }
  waClient.markRead(msg.id);

  // Disclosure Art. 50 PRIMA di qualunque altra risposta della sessione (anche quella
  // "solo testo"): se l'invio fallisce non si marca, si ritenta al messaggio dopo e
  // SOPRATTUTTO non si va avanti — nessuna risposta del bot puo' uscire senza disclosure.
  const conv = getConv(from);
  if (!conv.disclosed) {
    try { await waClient.sendText(from, disclosureText()); conv.disclosed = true; }
    catch (e) { console.error('[wa] disclosure KO:', e.message); return; }
  }

  let text = '';
  if (msg.type === 'text') text = msg.text?.body || '';
  else {
    await waClient.sendText(from, 'Per ora gestisco richieste in testo: scrivimi marca e modello (es. "Audi A3 2018") o un codice ricambio.').catch(() => {});
    return;
  }
  if (!text.trim()) return;

  try {
    const { text: reply, history } = await bot.handleMessage({ from, text, history: conv.history, searchFn, utente });
    conv.history = history; conv.ts = Date.now();
    if (reply) await waClient.sendText(from, reply);
  } catch (e) {
    console.error('[wa] bot KO:', e.message);
    await waClient.sendText(from, 'Ops, problema tecnico da parte mia. Riprova tra poco.').catch(() => {});
  }
}

// Montaggio sull'app Express. searchFn iniettata da server.js (closure runSearch/parse).
function mount(app, { searchFn }) {
  app.get(PATH, handleVerify);
  app.post(PATH, express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => handlePost(req, res, searchFn));
  console.log(`[wa] webhook montato su ${PATH} · client ${waClient.configured() ? 'OK' : 'INCOMPLETO (mancano token/segreti)'}`);
}

module.exports = { mount, PATH, verifySignature, allowed, rateOk, handleVerify, handlePost, handleInbound, disclosureText };
