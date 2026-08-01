'use strict';
// Fonte "web" per i ricambi: quando Autodoc non ha il codice (o come 2ª fonte sempre),
// usa il tool web_search dell'API Anthropic per identificare il pezzo e trovare rivenditori.
// Tollerante alle varianti di suffisso (es. 06A906032HP vs …HN). Nessun browser.
//
// Output unificato con la fonte Autodoc: articoli con `fonte:'web'`.
const { Anthropic } = require('@anthropic-ai/sdk');
const logger = require('./logger');

const MODEL = () => process.env.BOT_MODEL || 'claude-sonnet-5';
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
const SUBMIT_TOOL = {
  name: 'submit_result',
  description: 'Restituisci il ricambio identificato e i rivenditori online trovati.',
  input_schema: {
    type: 'object',
    properties: {
      pezzo: {
        type: 'object',
        description: 'Identificazione del pezzo',
        properties: { tipo: { type: 'string', description: 'che pezzo è (es. Centralina motore / ECU)' }, veicoli: { type: 'string', description: 'veicoli compatibili' } },
      },
      articoli: {
        type: 'array',
        description: 'Rivenditori online dove comprarlo (max 8)',
        items: {
          type: 'object',
          properties: {
            nome: { type: 'string', description: 'titolo prodotto/annuncio' },
            url: { type: 'string', description: 'link diretto alla pagina prodotto' },
            venditore: { type: 'string', description: 'dominio del rivenditore, es. ricambi.it' },
            prezzo: { type: ['number', 'null'], description: 'prezzo in EUR se visibile, altrimenti null' },
          },
          required: ['nome', 'url'],
        },
      },
    },
    required: ['pezzo', 'articoli'],
  },
};

const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

function prompt(q, mode, raw, veicolo) {
  const vt = veicolo === 'moto' ? 'MOTO' : 'AUTO';
  let soggetto;
  if (mode === 'nome') {
    soggetto = `un ricambio per ${vt} descritto come: "${q}"`;
  } else if (mode === 'prodotto') {
    soggetto = `il ricambio per ${vt} con codice ARTICOLO del produttore/aftermarket: "${q}" (es. Brembo, TOPRAN, Bosch — NON è un codice OEM di una casa auto/moto: identifica prima il PRODUTTORE del codice, non confonderlo con codici OEM simili di altre case)`;
  } else {
    // oem — i codici corti/ambigui (es. "8 532 508-04" → "853250804") collassano su famiglie
    // di altri produttori (PROVATO: scambiato per Toyota 85325xxx). Passa anche la forma
    // originale con separatori e avvisa dell'ambiguità.
    const orig = raw && raw !== q ? ` La forma originale scritta dall'utente è "${raw}" (i separatori possono essere significativi).` : '';
    const warn = q.length < 9 ? ' ATTENZIONE: codice corto/ambiguo — più produttori usano numerazioni simili: verifica LA MARCA del pezzo dai risultati prima di rispondere, non dedurla dal solo formato del numero.' : '';
    soggetto = `il ricambio per ${vt} con codice OEM/OE: "${q}" (il codice può avere VARIANTI di suffisso — lettere finali diverse — della stessa famiglia: consideralo).${orig}${warn}`;
  }
  return `Sei un assistente esperto di ricambi auto/moto. Cerca ${soggetto}.
Usa la ricerca web per:
1) identificare CHE PEZZO è (tipo + veicoli compatibili);
2) trovare rivenditori online (Italia/Europa) dove comprarlo, con link diretti alla pagina prodotto.
Quando hai i risultati, chiama SEMPRE submit_result con pezzo{tipo,veicoli} e articoli[] (nome, url, venditore=dominio, prezzo se visibile). Max 8 rivenditori, preferisci pagine prodotto reali. Se non trovi nulla di attinente, articoli vuoto ma compila comunque pezzo se lo identifichi.`;
}

// searchWebParts('06A906032HP', {mode:'oem'|'prodotto'|'nome', raw?}) → { oen, pezzo, articoli, count, error? }
// opts.raw = forma originale scritta dall'utente (separatori inclusi) — usata nel prompt oem.
async function searchWebParts(queryRaw, opts = {}) {
  const mode = ['nome', 'prodotto'].includes(opts.mode) ? opts.mode : 'oem';
  const q = mode === 'oem'
    ? String(queryRaw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    : String(queryRaw || '').trim();
  if (!q) return { oen: '', articoli: [], count: 0, error: 'query vuota' };
  if (!process.env.ANTHROPIC_API_KEY) return { oen: q, articoli: [], count: 0, error: 'ANTHROPIC_API_KEY assente' };

  const client = new Anthropic();
  const oen = q;   // mantiene il campo di ritorno `oen` = termine cercato (codice o nome normalizzato)
  const messages = [{ role: 'user', content: prompt(q, mode, opts.raw, opts.veicolo) }];
  try {
    // Loop di continuazione: web_search (server tool) può restituire stop_reason 'pause_turn'
    // prima che il modello chiami submit_result → vanno rialimentati i content. max_tokens alto
    // così non tronca prima del submit.
    let submit = null, lastResp = null;
    for (let iter = 0; iter < 4; iter++) {
      const resp = await client.messages.create({ model: MODEL(), max_tokens: 4096, tools: [WEB_SEARCH_TOOL, SUBMIT_TOOL], messages });
      lastResp = resp;
      submit = resp.content.find(b => b.type === 'tool_use' && b.name === 'submit_result');
      if (submit) break;
      if (resp.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: resp.content }); continue; }  // turno pausato → continua
      break;   // end_turn / max_tokens / tool_use non-submit → esci e prova il fallback citazioni
    }
    if (!submit) {
      /**
       * UNA PAGINA TROVATA NON E' UN'OFFERTA.
       *
       * Quando il modello non produce l'elenco strutturato, qui si prendevano le CITAZIONI
       * grezze della ricerca web e si spedivano come `articoli`, col dominio al posto del
       * venditore e il prezzo vuoto: a schermo finivano nella lista delle offerte, in mezzo
       * a quelle vere di Subito e eBay, indistinguibili. Ma sono pagine che il motore ha
       * trovato cercando quel codice — un forum, una scheda tecnica, un catalogo — non
       * qualcuno che quel pezzo lo vende.
       *
       * Escono lo stesso, perche' spesso servono, ma per quello che sono: `pagine`, un campo
       * a parte che il frontend mostra in una sezione sua. `articoli` resta vuoto, e la
       * fonte web dichiara di non aver trovato offerte.
       */
      const links = citationsFrom(lastResp ? lastResp.content : []);
      if (links.length) return { oen, pezzo: { tipo: textFrom(lastResp.content) || null, veicoli: null },
        articoli: [], count: 0, pagine: links.slice(0, 8).map(({ fonte, prezzo, valuta, venditore, ...r }) => ({ ...r, dominio: venditore })) };
      logger.warn('[web-parts]', `nessun risultato strutturato per "${q}" (${mode}), stop_reason=${lastResp && lastResp.stop_reason}`);
      return { oen, articoli: [], count: 0, error: 'nessun risultato strutturato dal modello' };
    }

    const input = submit.input || {};
    const articoli = (Array.isArray(input.articoli) ? input.articoli : [])
      .filter(a => a && a.nome && a.url)
      .slice(0, 8)
      .map(a => ({ fonte: 'web', nome: String(a.nome), url: String(a.url), venditore: a.venditore || domainOf(a.url), prezzo: typeof a.prezzo === 'number' ? a.prezzo : null, valuta: 'EUR' }));
    return { oen, pezzo: input.pezzo || null, articoli, count: articoli.length };
  } catch (e) {
    logger.error('[web-parts]', `lookup "${q}" (${mode}) fallito:`, e);
    return { oen, articoli: [], count: 0, error: e.message };
  }
}

// estrae i risultati di ricerca dai blocchi web_search_tool_result (fallback)
function citationsFrom(content) {
  const out = [];
  for (const b of content || []) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) {
        if (r.type === 'web_search_result' && r.url) out.push({ fonte: 'web', nome: r.title || r.url, url: r.url, venditore: domainOf(r.url), prezzo: null, valuta: 'EUR' });
      }
    }
  }
  return out;
}
const textFrom = content => (content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim().slice(0, 200) || null;

module.exports = { searchWebParts };

// self-check manuale: `node backend/web-parts.js 06A906032HP` (richiede ANTHROPIC_API_KEY in .env)
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  searchWebParts(process.argv[2] || '06A906032HP')
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
