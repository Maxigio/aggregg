'use strict';
// Client Meta WhatsApp Cloud API (Graph). Usa fetch/FormData/Blob globali (Node ≥18),
// nessuna dipendenza HTTP. Segreti letti a runtime da process.env (caricati da .env in
// server.js) così un cambio di .env non richiede modifiche al codice.
//
// Endpoint: POST /{PHONE_NUMBER_ID}/messages e /{PHONE_NUMBER_ID}/media.
// Docs: developers.facebook.com/docs/whatsapp/cloud-api

const GRAPH = () => 'https://graph.facebook.com/' + (process.env.GRAPH_API_VERSION || 'v22.0');
const token = () => process.env.WHATSAPP_TOKEN || '';
const phoneId = () => process.env.WHATSAPP_PHONE_NUMBER_ID || '';

// Dry-run: per test locale senza Meta. Logga (e scrive i PDF in WA_DEV_DUMP_DIR)
// invece di chiamare Graph. Attiva con WA_DRY_RUN=1.
const dryRun = () => process.env.WA_DRY_RUN === '1';

function configured() {
  return dryRun() || Boolean(token() && phoneId());
}

async function graphPost(pathSeg, body) {
  const res = await fetch(`${GRAPH()}/${phoneId()}/${pathSeg}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Graph ${pathSeg} ${res.status}: ${j.error?.message || 'errore'}`);   // niente token nel log
  return j;
}

// Messaggio di testo semplice.
async function sendText(to, bodyText) {
  if (dryRun()) { console.log(`[wa dry] text → ${to}: ${String(bodyText).slice(0, 200)}`); return { dryRun: true }; }
  return graphPost('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body: String(bodyText).slice(0, 4096) },
  });
}

// Carica un buffer come media → ritorna media_id (riusabile per l'invio documento).
async function uploadMedia(buffer, filename, mime = 'application/pdf') {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), filename);   // fetch imposta il boundary multipart
  const res = await fetch(`${GRAPH()}/${phoneId()}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },   // NIENTE Content-Type: lo mette FormData col boundary
    body: form,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Graph media ${res.status}: ${j.error?.message || 'errore'}`);
  return j.id;
}

// Invia un documento già caricato (media_id) con nome file + caption.
async function sendDocument(to, mediaId, filename, caption = '') {
  return graphPost('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: { id: mediaId, filename, caption: String(caption).slice(0, 1024) },
  });
}

// Segna letto (spunte blu) — best-effort, non deve mai far fallire il flusso.
async function markRead(messageId) {
  if (dryRun()) return;
  try {
    await graphPost('messages', { messaging_product: 'whatsapp', status: 'read', message_id: messageId });
  } catch { /* non bloccante */ }
}

// Helper composito: carica il PDF e lo invia in un colpo.
async function sendPdf(to, buffer, filename, caption = '') {
  if (dryRun()) {
    const dir = process.env.WA_DEV_DUMP_DIR;
    if (dir) {
      const fs = require('node:fs'), path = require('node:path');
      const dest = path.join(dir, filename);
      fs.writeFileSync(dest, buffer);
      console.log(`[wa dry] PDF → ${to}: scritto ${dest} (${buffer.length} byte) · caption: ${caption}`);
    } else {
      console.log(`[wa dry] PDF → ${to}: ${filename} (${buffer.length} byte) · caption: ${caption}`);
    }
    return { dryRun: true };
  }
  const mediaId = await uploadMedia(buffer, filename, 'application/pdf');
  return sendDocument(to, mediaId, filename, caption);
}

module.exports = { configured, sendText, uploadMedia, sendDocument, sendPdf, markRead };
