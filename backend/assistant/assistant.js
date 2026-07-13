'use strict';
// Assistente interno "AI mode" della web-app AMR: agent-loop Claude (Haiku 4.5).
// Gemello di backend/whatsapp/bot.js, con 3 differenze:
//  1) MODELLO Haiku 4.5 + chiave DEDICATA (ASSISTANT_ANTHROPIC_KEY) isolata dal bot WhatsApp;
//  2) la CATEGORIA (auto/moto/ricambio-auto/ricambio-moto + "ho un OEM?") arriva dai BOTTONI del
//     frontend come ctx → fissa tipo/veicolo/mode in modo DETERMINISTICO (niente classificazione
//     LLM a rischio): il modello estrae solo i parametri e conversa;
//  3) NIENTE PDF: gli handler restituiscono al modello un riassunto testuale (per il commento) ED
//     emettono l'envelope strutturato via `emit('results', ...)` che la rotta SSE inoltra al frontend.
// `searchFn` (closure su runSearch/parseSearchParams) è iniettata da server.js, come per il bot.
const fs = require('node:fs');
const path = require('node:path');
const { Anthropic } = require('@anthropic-ai/sdk');
const { reportStats } = require('../report-pdf');
const { ricambiStats } = require('../report-pdf-ricambi');
const { searchRicambi } = require('../ricambi-core');

const PROMPT_PATH = path.join(__dirname, 'prompt.md');
const MODEL = () => process.env.ASSISTANT_MODEL || 'claude-haiku-4-5';
const MAX_ITERS = 4;
const MAX_HISTORY = 20;
const loadPrompt = () => fs.readFileSync(PROMPT_PATH, 'utf8');
const eur = n => (n == null ? '—' : '€ ' + n.toLocaleString('it-IT'));

// ── Categoria (dai bottoni) → contesto deterministico. Nessuna inferenza LLM. ──
function deriveCtx(c = {}) {
  const cat = ['auto', 'moto', 'ricambio_auto', 'ricambio_moto'].includes(c.categoria) ? c.categoria : 'auto';
  if (cat === 'auto' || cat === 'moto') return { categoria: cat, kind: 'veicoli', tipo: cat };
  return { categoria: cat, kind: 'ricambio', veicolo: cat === 'ricambio_moto' ? 'moto' : 'auto', mode: c.oem ? 'oem' : 'nome' };
}
const CTX_LABEL = { auto: 'Auto usate', moto: 'Moto usate', ricambio_auto: 'Ricambi auto', ricambio_moto: 'Ricambi moto' };

// tipo iniettato dall'handler (ctx), NON dal modello → il modello non può sbagliarlo.
const TOOL_VEICOLI = {
  name: 'cerca_veicoli',
  description: 'Cerca annunci di veicoli usati (aggrega Subito.it, Autoscout24, Moto.it) e restituisce i risultati con statistiche di prezzo. Usa questo strumento quando l\'utente vuole cercare/valutare il mercato di un modello (marca obbligatoria). NON usarlo per domande su come funziona l\'app: a quelle rispondi a voce. Il tipo (auto/moto) è già fissato dalla categoria attiva, non passarlo.',
  input_schema: {
    type: 'object',
    properties: {
      marca: { type: 'string', description: 'marca del veicolo, es. Volkswagen, Audi, Yamaha — nome libero, il sistema lo normalizza' },
      modello: { type: 'string', description: 'modello, es. Golf, A3, MT-07 (opzionale ma consigliato)' },
      annoMin: { type: 'integer', description: 'anno minimo di immatricolazione, es. 2016' },
      annoMax: { type: 'integer', description: 'anno massimo di immatricolazione' },
      prezzoMin: { type: 'integer', description: 'prezzo minimo in €' },
      prezzoMax: { type: 'integer', description: 'prezzo massimo in €, es. 15000' },
      kmMin: { type: 'integer', description: 'chilometraggio minimo' },
      kmMax: { type: 'integer', description: 'chilometraggio massimo, es. 90000' },
      regione: { type: 'string', description: 'regione italiana, anche in forma naturale (es. Lombardia, Emilia Romagna) — opzionale' },
    },
    required: ['marca'],
  },
};
// veicolo + mode iniettati dall'handler (ctx). Il modello passa solo la query (codice o testo).
const TOOL_RICAMBIO = {
  name: 'cerca_ricambio',
  description: 'Cerca un ricambio su più fonti (catalogo Autodoc per auto / CMSNL per moto + Subito + eBay) e restituisce la scheda del pezzo e le offerte in vendita. Usa questo strumento quando l\'utente fornisce un codice o il nome di un ricambio da cercare. NON usarlo per domande su come funziona l\'app. Il veicolo (auto/moto) e la modalità (codice OEM o testo) sono già fissati dalla categoria attiva.',
  input_schema: {
    type: 'object',
    properties: { q: { type: 'string', description: 'il codice OE/OEM/OEN, il codice articolo, o il nome del pezzo — così come lo ha scritto l\'utente' } },
    required: ['q'],
  },
};
function toolsFor(ctx) { return ctx.kind === 'veicoli' ? [TOOL_VEICOLI] : [TOOL_RICAMBIO]; }

const vLabel = p => [p.marca, p.modello].filter(Boolean).join(' ') || 'la ricerca';
const srcCounts = (s = {}) => ['subito', 'autoscout', 'moto'].map(k => `${k}:${s[k]?.count ?? 0}`).join(' ');
const degradate = (s = {}) => Object.entries(s).filter(([, v]) => ['blocked', 'error', 'timeout', 'needs_bootstrap'].includes(v?.status)).map(([k]) => k);

// Handler cerca_veicoli: inietta ctx.tipo, cerca, emette i risultati al frontend, riassume al modello.
async function runCercaVeicoli(input, ctx, emit) {
  let r;
  try { r = await ctx.searchFn({ ...input, tipo: ctx.tipo }); }
  catch (e) { console.error('[assistant] searchFn KO:', e.message); return 'La ricerca ha dato un errore tecnico. Di\' all\'utente di riprovare tra poco.'; }
  if (r.error) return `Parametri non validi: ${r.error}. Chiedi all'utente di precisare (di solito serve almeno la marca).`;
  const risultati = r.risultati || [];
  const stats = reportStats(risultati);
  const deg = degradate(r.sources);
  emit('results', { kind: 'veicoli', params: r.params, risultati: risultati.slice(0, 60), stats, sources: r.sources });
  if (!risultati.length) {
    const nota = deg.length ? ` Alcune fonti non hanno risposto (${deg.join(', ')}), quindi il quadro è parziale.` : '';
    return `Nessun annuncio per ${vLabel(r.params)} (fonti — ${srcCounts(r.sources)}).${nota} Suggerisci di allargare i filtri (anni/km/regione).`;
  }
  const nota = deg.length ? ` Nota: fonti non disponibili ora (${deg.join(', ')}) → quadro parziale, dillo.` : '';
  return `Trovati ${stats.totale} annunci per ${vLabel(r.params)}: con prezzo ${stats.conPrezzo}, min ${eur(stats.min)}, mediana ${eur(stats.mediana)}, media ${eur(stats.media)}, max ${eur(stats.max)}. Fonti — ${srcCounts(r.sources)}.${nota} Commenta i numeri chiave in 1-2 frasi concise; i risultati sono già mostrati all'utente, non elencarli.`;
}

// Handler cerca_ricambio: inietta ctx.veicolo/mode, cerca, emette scheda+offerte, riassume al modello.
async function runCercaRicambio(input, ctx, emit) {
  const q = String(input.q || '').trim();
  if (!q) return 'Manca il codice o il nome del ricambio: chiedilo all\'utente.';
  let r;
  try { r = await searchRicambi(q, { mode: ctx.mode, veicolo: ctx.veicolo }); }
  catch (e) { console.error('[assistant] searchRicambi KO:', e.message); return `Ricerca ricambio fallita (${e.message}). Di' all'utente di riprovare.`; }
  const articoli = r.articoli || [];
  const scheda = r.scheda ? { tipoPezzo: r.scheda.tipoPezzo || r.tipoPezzo || null, codice: r.scheda.codice || r.oen, oeAlternativi: r.scheda.oeAlternativi || [], catalogo: r.scheda.catalogo || null } : null;
  emit('results', { kind: 'ricambi', oen: r.oen, mode: r.mode, veicolo: r.veicolo, tipoPezzo: r.tipoPezzo, veicoli: r.veicoli, scheda, articoli: articoli.slice(0, 40), sources: r.sources });
  if (!scheda && !articoli.length) {
    const srcs = Object.entries(r.sources || {}).map(([k, s]) => `${k}:${s.status}`).join(' ');
    return `Nessun risultato per "${q}" (fonti — ${srcs}). Chiedi di verificare il codice, o di provare col nome del pezzo se aveva usato un codice (e viceversa).`;
  }
  const stats = ricambiStats(articoli);
  const range = stats.conPrezzo ? `, offerte da ${eur(stats.min)} a ${eur(stats.max)}` : '';
  const pezzo = r.tipoPezzo || (scheda && scheda.tipoPezzo) || 'il ricambio';
  return `"${q}" = ${pezzo}${r.veicoli ? ` (compatibile: ${r.veicoli})` : ''}. ${articoli.length} offerte sul mercato${range}. La scheda e le offerte sono già mostrate all'utente: commenta cos'è il pezzo e come orientarsi in 1-2 frasi, senza elencare tutto.`;
}

// Chiamata Claude (Haiku non ha web_search qui → nessuna guardia tool-rifiutato serve, ma teniamo il wrap).
async function createMsg(client, req) { return client.messages.create(req); }

// Elabora UN turno. Emette eventi SSE ('text' man mano, 'results' quando cerca). Ritorna { history }.
async function runAssistant({ text, history = [], ctx: rawCtx, searchFn, emit }) {
  const client = new Anthropic({ apiKey: process.env.ASSISTANT_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY });
  const ctx = { ...deriveCtx(rawCtx), searchFn };
  const system = `${loadPrompt()}\n\n<contesto_sessione>\nCategoria attiva scelta dall'utente coi bottoni: ${CTX_LABEL[ctx.categoria]}.${ctx.kind === 'ricambio' ? ` Ricerca ricambio per ${ctx.veicolo === 'moto' ? 'MOTO' : 'AUTO'}, modalità ${ctx.mode === 'oem' ? 'codice OEM' : 'testo libero (codice articolo o nome)'}.` : ''} Puoi cercare SOLO in questa categoria; se l'utente chiede altro, digli di cambiare categoria dai bottoni. Le domande su come funziona l'app rispondile sempre.\n</contesto_sessione>`;
  const req = {
    model: MODEL(),
    max_tokens: 1200,
    system,
    tools: toolsFor(ctx),
    messages: [...history, { role: 'user', content: String(text || '') }],
  };

  for (let i = 0; i < MAX_ITERS; i++) {
    const resp = await createMsg(client, req);
    req.messages.push({ role: 'assistant', content: resp.content });
    const txt = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (txt) emit('text', { text: txt });   // testo pre-tool ("Cerco…") o commento finale

    if (resp.stop_reason !== 'tool_use') break;

    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      let out;
      if (block.name === 'cerca_veicoli') out = await runCercaVeicoli(block.input || {}, ctx, emit);
      else if (block.name === 'cerca_ricambio') out = await runCercaRicambio(block.input || {}, ctx, emit);
      else { toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'strumento non gestito', is_error: true }); continue; }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
    }
    if (!toolResults.length) break;
    req.messages.push({ role: 'user', content: toolResults });
  }
  return { history: cleanHistory(req.messages) };
}

// Storia sana per il turno dopo (coppie tool_use↔tool_result appaiate, no orfani). Come bot.js.
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

module.exports = { runAssistant, cleanHistory, deriveCtx };
