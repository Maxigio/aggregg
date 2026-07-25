#!/usr/bin/env node
'use strict';
/**
 * Genera data/autodata-loghi.json = { <chiave marca di autodata-index> : <url logo> }.
 *
 * Nel catalogo le marche di auto-data.net avevano tutte lo stesso segnaposto grigio: una
 * griglia di 392 quadratini identici non aiuta a trovare niente. La fonte i loghi ce li ha,
 * su /it/allbrands, tutte e 393 le marche in una pagina sola.
 *
 * Una richiesta, e le chiavi sono le stesse di data/autodata-index.json: l'accoppiamento
 * avviene sullo SLUG del link marca ("fiat-brand-67"), che l'indice gia' conserva — non sul
 * nome, che sarebbe fragile.
 *
 * robots.txt di auto-data.net: nessuna regola Disallow (verificato). Rigenerabile:
 *   node scripts/build-autodata-loghi.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const cheerio = require('cheerio');

const HOST = 'https://www.auto-data.net';
const PAGINA = `${HOST}/it/allbrands`;
const OUT = path.join(__dirname, '..', 'data', 'autodata-loghi.json');
const INDICE = require('../data/autodata-index.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

function get(u, hop = 0) {
  return new Promise((res, rej) => {
    if (hop > 5) return rej(new Error('troppi redirect'));
    // Host bloccato: il percorso lo scegliamo noi e nessun redirect puo' portarci altrove.
    if (!/^https:\/\/(www\.)?auto-data\.net\//.test(u)) return rej(new Error('host non ammesso: ' + u));
    const q = https.get(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9', 'Accept-Encoding': 'gzip' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume(); return get(new URL(r.headers.location, u).href, hop + 1).then(res, rej);
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const c = []; let s = r;
      if ((r.headers['content-encoding'] || '') === 'gzip') s = r.pipe(zlib.createGunzip());
      s.on('data', x => c.push(x));
      s.on('end', () => res(Buffer.concat(c).toString('utf8')));
      s.on('error', rej);
    });
    q.on('error', rej);
    q.setTimeout(20000, () => q.destroy(new Error('timeout')));
  });
}

(async () => {
  const $ = cheerio.load(await get(PAGINA));
  // slug del link → url logo. Lo slug e' la stessa cosa che l'indice salva per ogni marca.
  const perSlug = new Map();
  $('a[href*="-brand-"]').each((_, a) => {
    const href = String($(a).attr('href') || '');
    const img = $(a).find('img').attr('src') || $(a).find('img').attr('data-src');
    if (!img) return;
    const slug = (href.match(/([a-z0-9._-]+-brand-\d+)/i) || [])[1];
    if (slug && !perSlug.has(slug)) perSlug.set(slug, img.startsWith('http') ? img : HOST + img);
  });

  const out = {};
  let senza = 0;
  for (const [chiave, b] of Object.entries(INDICE.brands || {})) {
    const url = perSlug.get(b.slug);
    if (url) out[chiave] = url; else senza++;
  }
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), fonte: PAGINA, loghi: out }));
  console.log(`[autodata-loghi] loghi in pagina: ${perSlug.size} · abbinati all'indice: ${Object.keys(out).length} · senza logo: ${senza}`);
  console.log('[autodata-loghi] scritto ' + OUT);
})().catch(e => { console.error('[autodata-loghi] KO:', e.message); process.exit(1); });
