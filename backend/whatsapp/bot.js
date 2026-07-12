'use strict';
// Cervello del bot WhatsApp: agent loop Claude (SDK Anthropic).
// - system prompt letto DA FILE ad ogni messaggio (prompt.md) → l'owner ne cambia
//   il comportamento editando il file, senza redeploy ("potere sull'istruzione del bot").
// - tool `cerca_auto` (client): esegue la ricerca AMR e INVIA il PDF all'utente.
// - tool `web_search` (server, gestito da Anthropic): lookup OEM/ricambi/info generiche.
//
// `searchFn` è iniettato da server.js (closure su runSearch/parseSearchParams, funzioni
// locali non esportate). `waClient` è il client Graph (backend/whatsapp/client.js).
const fs = require('node:fs');
const path = require('node:path');
const { Anthropic } = require('@anthropic-ai/sdk');
const { renderReportPdf, reportStats } = require('../report-pdf');
const { searchRicambi } = require('../ricambi-core');   // multi-fonte: Autodoc + Web + Subito
const { fetchAutodocSpecs } = require('../oem-lookup');  // compat veicoli (l'envelope v7 è lazy)
const { renderRicambiPdf, ricambiStats } = require('../report-pdf-ricambi');
const waClient = require('./client');

const PROMPT_PATH = path.join(__dirname, 'prompt.md');
const MODEL = () => process.env.BOT_MODEL || 'claude-sonnet-5';
const MAX_ITERS = 4;                 // giri di tool-use prima di arrendersi
const MAX_HISTORY = 20;              // messaggi conservati per conversazione (bound token)
const WEB_SEARCH_ON = () => process.env.WA_WEB_SEARCH !== '0';
const OEM_LOOKUP_ON = () => process.env.WA_OEM_LOOKUP !== '0';

const eur = n => (n == null ? '—' : '€ ' + n.toLocaleString('it-IT'));
const loadPrompt = () => fs.readFileSync(PROMPT_PATH, 'utf8');

function baseTools() {
  const tools = [{
    name: 'cerca_auto',
    description: 'Cerca annunci di auto/moto usate su Subito.it, Autoscout24 e Moto.it e genera un report PDF dei prezzi che viene inviato AUTOMATICAMENTE all\'utente su WhatsApp. Usa questo strumento per qualunque richiesta di prezzo/mercato di un modello.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['auto', 'moto'], description: 'auto o moto (default auto)' },
        marca: { type: 'string', description: 'marca, es. Audi, Volkswagen, Yamaha — nome libero, il sistema lo normalizza' },
        modello: { type: 'string', description: 'modello, es. A3, Golf, MT-07 (opzionale ma consigliato)' },
        annoMin: { type: 'integer', description: 'anno minimo di immatricolazione (es. 2016)' },
        annoMax: { type: 'integer', description: 'anno massimo di immatricolazione' },
        prezzoMin: { type: 'integer', description: 'prezzo minimo in € (es. 5000)' },
        prezzoMax: { type: 'integer', description: 'prezzo massimo in € (es. 15000)' },
        kmMin: { type: 'integer', description: 'chilometraggio minimo' },
        kmMax: { type: 'integer', description: 'chilometraggio massimo (es. 90000)' },
        regione: { type: 'string', description: 'regione italiana, anche in forma naturale (es. Lombardia, Emilia Romagna) — opzionale' },
      },
      required: ['marca'],
    },
  }];
  if (OEM_LOOKUP_ON()) tools.push({
    name: 'oem_lookup',
    description: 'Dato un codice OE/OEM/OEN di un ricambio auto (es. "1K0905851B", con o senza spazi), cerca su PIÙ fonti (Autodoc + Web + Subito) di che pezzo si tratta e gli articoli in vendita (marca/nome, prezzo, venditore, link), e invia AUTOMATICAMENTE un PDF riepilogo all\'utente. Usa SEMPRE questo quando l\'utente manda un codice ricambio.',
    input_schema: { type: 'object', properties: { oen: { type: 'string', description: 'il codice OE/OEM/OEN, es. 1K0905851B' } }, required: ['oen'] },
  });
  if (WEB_SEARCH_ON()) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  return tools;
}

const label = p => [p.marca, p.modello].filter(Boolean).join(' ') || 'la ricerca';
const srcCounts = (sources = {}) => ['subito', 'autoscout', 'moto']
  .map(k => `${k}:${sources[k]?.count ?? 0}`).join(' ');

function pdfName(p) {
  const slug = [p.marca, p.modello].filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '') || 'report';
  const date = new Date().toISOString().slice(0, 10);
  return `automotoradar-${slug}-${date}.pdf`;
}

// Handler del tool client `cerca_auto`: ricerca → PDF → invio. Ritorna al modello un
// riassunto testuale (per il commento). Non lancia: ogni errore torna come testo.
async function runCercaAuto(input, ctx) {
  let r;
  try {
    r = await ctx.searchFn(input);
  } catch (e) {
    console.error('[wa] searchFn KO:', e.message);
    return `La ricerca ha dato errore tecnico. Riprova tra poco.`;
  }
  if (r.error) return `Parametri non validi: ${r.error}. Chiedi all'utente di precisare.`;
  const risultati = r.risultati || [];
  const stats = reportStats(risultati);
  if (!risultati.length) {
    return `Nessun annuncio trovato per ${label(r.params)} (fonti — ${srcCounts(r.sources)}). Nessun PDF inviato: suggerisci di allargare i filtri (anni/km/regione).`;
  }
  const buf = renderReportPdf(risultati, r.params);
  const fname = pdfName(r.params);
  const caption = `${label(r.params)} · ${stats.totale} annunci · mediana ${eur(stats.mediana)}`;
  if (waClient.configured()) {
    try {
      await waClient.sendPdf(ctx.from, buf, fname, caption);
    } catch (e) {
      console.error('[wa] invio PDF KO:', e.message);
      return `Trovati ${stats.totale} annunci (mediana ${eur(stats.mediana)}) ma l'invio del PDF è fallito. Avvisa l'utente.`;
    }
  } else {
    console.warn('[wa] client non configurato → PDF non inviato');
    return `Ricerca ok per ${label(r.params)}: totale ${stats.totale}, con prezzo ${stats.conPrezzo}, min ${eur(stats.min)}, mediana ${eur(stats.mediana)}, media ${eur(stats.media)}, max ${eur(stats.max)}. ATTENZIONE: l'invio del PDF NON è configurato → NON dire all'utente che hai inviato un PDF; dai i numeri chiave a voce.`;
  }
  return `PDF inviato all'utente. Risultati ${label(r.params)}: totale ${stats.totale}, con prezzo ${stats.conPrezzo}, min ${eur(stats.min)}, mediana ${eur(stats.mediana)}, media ${eur(stats.media)}, max ${eur(stats.max)}. Fonti — ${srcCounts(r.sources)}. Commenta i numeri chiave in 1-2 frasi.`;
}

// Handler del tool `oem_lookup`: codice OE/OEM/OEN → articoli su PIÙ fonti (Autodoc + Web + Subito)
// via searchRicambi, e invia un PDF ricambi (come cerca_auto per le auto).
async function runOemLookup(input, ctx) {
  const oen = String(input.oen || input.codice || '').trim();
  if (!oen) return 'Manca il codice OE/OEM/OEN: chiedilo all\'utente.';
  let r;
  try {
    r = await searchRicambi(oen, { mode: 'oem' });
  } catch (e) {
    console.error('[wa] oem_lookup KO:', e.message);
    return `Lookup ricambio fallito (${e.message}). Avvisa l'utente e digli di riprovare.`;
  }
  const articoli = r.articoli || [];
  if (!articoli.length) {
    const srcs = Object.entries(r.sources || {}).map(([k, s]) => `${k}:${s.status}`).join(' ');
    return `Nessun articolo per il codice ${r.oen} (fonti — ${srcs}). Chiedi di verificare il codice oppure prova a cercare il nome del pezzo.`;
  }
  // veicoli compatibili: l'envelope v7 li tiene lazy (Autodoc) → 1 nav sulla variante default,
  // SOLO se il tipo è univoco (multi-tipo = compat ambigua) e c'è l'url prodotto. Best-effort.
  if (!r.veicoli && r.scheda?.catalogo?.defaultArticleId) {
    const cat = r.scheda.catalogo;
    const v = cat.tipi.flatMap(t => t.articoli).find(a => a.articleId === cat.defaultArticleId);
    if (v && v.fonte === 'autodoc' && v.url) {
      try {
        const s = await fetchAutodocSpecs(v.url);
        if (s?.compatibilita?.length) r.veicoli = s.compatibilita.join(', ');
      } catch (e) { console.error('[wa] specs veicoli KO:', e.message); }
    }
  }
  const stats = ricambiStats(articoli);
  const price = p => (typeof p === 'number' ? '€ ' + p.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
  const top = articoli.slice(0, 6).map(a =>
    `- ${a.marca ? a.marca + ' ' : ''}${a.nome}${typeof a.prezzo === 'number' ? ` — ${price(a.prezzo)}` : ''} [${a.fonte}]${a.url ? `\n  ${a.url}` : ''}`).join('\n');
  // invia il PDF ricambi (come per le auto)
  let pdfSent = false;
  if (waClient.configured()) {
    try {
      const buf = renderRicambiPdf(articoli, { oen: r.oen, tipoPezzo: r.tipoPezzo, veicoli: r.veicoli });
      const fname = `ricambi-${String(r.oen || 'export').toLowerCase().replace(/[^a-z0-9]/g, '')}-${new Date().toISOString().slice(0, 10)}.pdf`;
      await waClient.sendPdf(ctx.from, buf, fname, `${r.tipoPezzo || 'Ricambio'} · ${r.oen} · ${stats.totale} articoli`);
      pdfSent = true;
    } catch (e) { console.error('[wa] invio PDF ricambi KO:', e.message); }
  }
  const pdfNote = pdfSent ? 'Il PDF con tutti gli articoli è stato inviato. ' : (waClient.configured() ? 'ATTENZIONE: invio PDF fallito, non dire di averlo inviato. ' : 'Invio PDF non configurato: dai i numeri a voce, non dire di aver inviato un PDF. ');
  const range = stats.conPrezzo ? `, prezzi da ${price(stats.min)} a ${price(stats.max)}` : '';
  return `Codice ${r.oen} = ${r.tipoPezzo || 'ricambio'}${r.veicoli ? ` (${r.veicoli})` : ''}. ${stats.totale} articoli su più fonti (Autodoc/Web/Subito)${range}:\n${top}\n\n${pdfNote}Riassumi cos'è il pezzo e proponi 2-3 opzioni con prezzo e link. Non elencare tutti e ${stats.totale}.`;
}

// Chiamata Claude con guardia: se il tool server web_search viene rifiutato (id versione
// cambiato), riprova UNA volta senza, così un solo messaggio non fa fallire tutto.
// ponytail: guardia stretta al fallimento tool, non retry generico.
async function createMsg(client, req, state) {
  try {
    return await client.messages.create(req);
  } catch (e) {
    if (state.webSearch && /web_search|tool|20250305/i.test(e.message || '')) {
      console.warn('[wa] web_search rifiutato, proseguo senza:', e.message);
      state.webSearch = false;
      req.tools = req.tools.filter(t => t.name !== 'web_search');
      return await client.messages.create(req);
    }
    throw e;
  }
}

// Elabora un messaggio utente. history = messaggi Anthropic precedenti (role/content).
// Ritorna { text, history } con lo storico aggiornato e potato.
async function handleMessage({ from, text, history = [], searchFn }) {
  const client = new Anthropic();   // legge ANTHROPIC_API_KEY da env
  const ctx = { from, searchFn };
  const state = { webSearch: WEB_SEARCH_ON() };
  const req = {
    model: MODEL(),
    max_tokens: 1500,
    system: loadPrompt(),
    tools: baseTools(),
    messages: [...history, { role: 'user', content: text }],
  };

  let finalText = '';
  for (let i = 0; i < MAX_ITERS; i++) {
    const resp = await createMsg(client, req, state);
    req.messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use') {
      finalText = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      break;
    }
    // esegui SOLO i tool client (web_search è server-side, già risolto da Anthropic)
    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'cerca_auto') {
        const out = await runCercaAuto(block.input || {}, ctx);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
      } else if (block.name === 'oem_lookup') {
        const out = await runOemLookup(block.input || {}, ctx);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
      } else {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'strumento non gestito', is_error: true });
      }
    }
    if (!toolResults.length) {   // tool_use senza tool client (solo server) → chiudi col testo
      finalText = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      break;
    }
    req.messages.push({ role: 'user', content: toolResults });
  }

  if (!finalText) finalText = 'Fatto. Se ti serve altro, scrivimi pure.';
  return { text: finalText, history: cleanHistory(req.messages) };
}

// Storia "sana" da ripassare al turno dopo: Anthropic esige tool_use↔tool_result appaiati e
// vieta di iniziare con un tool_result orfano. Un semplice slice(-N) può spezzare una coppia
// o lasciare in coda un tool_use non risposto (MAX_ITERS) → 400 persistente. Qui:
//  1) tronca la coda all'ultimo assistant text-only (fine turno pulita);
//  2) cap a MAX_HISTORY;
//  3) scarta i leading finché il primo non è un vero turno utente (user con content stringa).
function cleanHistory(messages) {
  let end = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') {
      const arr = Array.isArray(m.content) ? m.content : [{ type: 'text' }];
      if (!arr.some(b => b.type === 'tool_use')) { end = i; break; }
    }
  }
  if (end < 0) return [];
  const out = messages.slice(0, end + 1).slice(-MAX_HISTORY);
  while (out.length && !(out[0].role === 'user' && typeof out[0].content === 'string')) out.shift();
  return out;
}

module.exports = { handleMessage, cleanHistory };
