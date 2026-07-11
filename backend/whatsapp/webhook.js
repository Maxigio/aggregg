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

// ── Allowlist mittenti (csv in WHATSAPP_ALLOWED_SENDERS). Vuoto = nessun filtro
// app-level (il numero di test Meta è comunque limitato a 5 destinatari).
const digits = s => String(s || '').replace(/\D/g, '');
function allowed(from) {
  const raw = (process.env.WHATSAPP_ALLOWED_SENDERS || '').trim();
  if (!raw) return true;
  return raw.split(',').map(digits).filter(Boolean).includes(digits(from));
}

// ── Stato conversazione in memoria, TTL 30 min. ponytail: in-memory; tabella DB
// wa_conversations se serve persistenza cross-restart.
const CONV_TTL = 30 * 60 * 1000;
const convs = new Map();
function getConv(from) {
  const now = Date.now();
  for (const [k, v] of convs) if (now - v.ts > CONV_TTL) convs.delete(k);
  let c = convs.get(from);
  if (!c) { c = { history: [], ts: now }; convs.set(from, c); }
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
  console.warn('[wa] ⚠ WHATSAPP_APP_SECRET assente → POST accettate SENZA verifica firma (MVP). Aggiungilo per integrità piena.');
}

function handlePost(req, res, searchFn) {
  const raw = req.body;   // Buffer (express.raw)
  if (!Buffer.isBuffer(raw)) return res.sendStatus(400);
  // Firma HMAC obbligatoria SE WHATSAPP_APP_SECRET è configurato. Se assente (MVP col numero test
  // Meta), si accetta senza verifica con avviso — la webhook resta gated dall'URL Funnel semi-segreto.
  if (process.env.WHATSAPP_APP_SECRET) {
    if (!verifySignature(raw, req.get('x-hub-signature-256'))) return res.status(401).send('firma non valida');
  } else {
    warnUnsigned();
  }
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

async function handleInbound(msg, searchFn) {
  const from = msg.from;
  if (!from) return;
  if (!allowed(from)) { console.warn('[wa] mittente fuori allowlist:', from); return; }
  if (!rateOk(from)) { await waClient.sendText(from, 'Un attimo di pausa 🙏 riprova tra poco.').catch(() => {}); return; }
  waClient.markRead(msg.id);

  let text = '';
  if (msg.type === 'text') text = msg.text?.body || '';
  else {
    await waClient.sendText(from, 'Per ora gestisco richieste in testo: scrivimi marca e modello (es. "Audi A3 2018") o un codice ricambio.').catch(() => {});
    return;
  }
  if (!text.trim()) return;

  const conv = getConv(from);
  try {
    const { text: reply, history } = await bot.handleMessage({ from, text, history: conv.history, searchFn });
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

module.exports = { mount, PATH, verifySignature, allowed, rateOk, handleVerify, handlePost };
