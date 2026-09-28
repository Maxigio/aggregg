'use strict';
const https = require('node:https');

const ALLOWED = new Set(['www.subito.it', 'subito.it', 'www.autoscout24.it', 'autoscout24.it']);
const URLS = {
  subito: 'https://www.subito.it/auto/ford-kuga-roma-661722972.htm',
  autoscout: 'https://www.autoscout24.it/annunci/fiat-panda-pandina-1-0-firefly-65-cv-hybrid-icon-promo-flex-elettrica-benzina-blu-azzurro-cat_ma28mo1746-0adc2d91-5d48-4f75-9a44-521bf19ec632',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function leggi(raw, hop = 0) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !ALLOWED.has(url.hostname) || hop > 5) throw new Error('redirect non consentito');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url);
        res.resume();
        resolve(leggi(next, hop + 1));
        return;
      }
      let bytes = 0;
      res.on('data', c => { bytes += c.length; });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('risposta interrotta')));
      res.on('end', () => resolve({ status: res.statusCode, bytes, contentLength: res.headers['content-length'] || null,
        contentEncoding: res.headers['content-encoding'] || 'identity', hop }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  const fonte = process.argv[2];
  if (!URLS[fonte]) throw new Error('uso: node amr-detail-probe.js subito|autoscout');
  const result = await leggi(URLS[fonte]);
  process.stdout.write(JSON.stringify({ fonte, ...result, triplo: result.status === 200 ? result.bytes * 3 : null }) + '\n');
})().catch(e => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
