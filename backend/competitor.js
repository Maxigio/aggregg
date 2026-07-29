'use strict';
/**
 * COMPETITOR — il parco di un concessionario, il tuo e quello degli altri.
 *
 * Un concessionario e' una VETRINA su una fonte, e le fonti la sanno servire per intero:
 *
 *   Autoscout   /concessionari/<slug>  →  customerId nella pagina  →  customer:{id}
 *   Subito      annuncio               →  advertiser.user_id       →  uid=<id>
 *
 * Si incolla il link della vetrina e l'app ricava l'id da sola. Verificato su quattro
 * concessionari veri: Raineri Massimo 9345705, GTI Srls 3484947, Bonera 12806,
 * Rivoltella 13290.
 *
 * DUE TRAPPOLE, tutte e due gia' scattate durante la verifica:
 *
 *   L'id del NEGOZIO non e' l'id dell'UTENTE. Nell'URL di una vetrina Subito c'e'
 *   `shops/7798-...`, ma il filtro vuole `uid=1398723`. Sono due numeri diversi, e
 *   quello sbagliato NON da' errore: da' il catalogo intero di Subito. Per questo l'id
 *   utente si legge da un annuncio di quel negozio, non dall'URL.
 *
 *   Il tetto silenzioso. Chiedendo quattro pagine, Bonera rispondeva "200 veicoli" che
 *   erano il mio limite, non il suo parco. Qui si pagina fino in fondo e, se si tocca il
 *   tetto di sicurezza, la risposta lo DICE (`troncato`) invece di far sembrare completo
 *   un elenco che non lo e'.
 *
 * AGGIORNAMENTO SU RICHIESTA, mai all'apertura: un parco grosso costa una richiesta ogni
 * cinquanta veicoli, e nessuno vuole pagarle solo per aver aperto una scheda.
 */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const scrapeAs24 = require('./scrapers/autoscout-graphql');
const scrapeSubito = require('./scrapers/subito-api');
const vetrinaMoto = require('./scrapers/motoit-vetrina');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const MAX_PAGINE = 40;            // 40 × 50 = 2000 veicoli: oltre, si dichiara troncato

/* ─── dove si salva l'elenco ──────────────────────────────────────────────── */
function filePath() {
  const ud = process.env.USER_DATA_PATH;
  const dir = (ud && fs.existsSync(ud)) ? ud : path.join(__dirname, '..', 'data');
  return path.join(dir, 'competitor.json');
}
function leggi() {
  try { const j = JSON.parse(fs.readFileSync(filePath(), 'utf8')); return Array.isArray(j.voci) ? j.voci : []; }
  catch (_) { return []; }
}
function scrivi(voci) {
  fs.writeFileSync(filePath(), JSON.stringify({ aggiornato: new Date().toISOString(), voci }, null, 1));
  return voci;
}

/* ─── dal link della vetrina all'id ───────────────────────────────────────── */
function getTesto(url, redirect = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (_) { return reject(new Error('link non valido')); }
    // Anti-SSRF: si parla solo con le due fonti, e vale anche dopo un redirect.
    if (!/(^|\.)(autoscout24\.it|subito\.it)$/i.test(u.hostname)) return reject(new Error('host non consentito'));
    const req = https.get(u.href, { headers: { 'user-agent': UA, 'accept-language': 'it-IT,it;q=0.9', 'accept-encoding': 'gzip, deflate' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirect < 4) {
        res.resume();
        return resolve(getTesto(new URL(res.headers.location, u).href, redirect + 1));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('la pagina risponde ' + res.statusCode)); }
      const ch = []; let s = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') s = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      s.on('data', c => ch.push(c));
      s.on('end', () => resolve(Buffer.concat(ch).toString('utf8')));
      s.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('la fonte non risponde')));
  });
}

const pulisci = s => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Da un URL di vetrina a { fonte, id, nome, dove }.
 * I parametri di tracciamento (gclid, srsltid, utm_*) si ignorano: conta lo slug.
 */
async function risolviVetrina(urlRaw) {
  const url = String(urlRaw || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('serve il link della vetrina, che comincia con https://');

  // Moto.it: la vetrina non e' su moto.it ma su dealer.moto.it, e l'id e' il suo slug
  // (non un numero). Ha una porta HTTP sua, che parla solo con quell'host.
  const slugMoto = vetrinaMoto.slugVetrina(url);
  if (slugMoto) return await vetrinaMoto.scheda(slugMoto);

  if (/autoscout24\.it\/concessionari\//i.test(url)) {
    const html = await getTesto(url);
    const id = (html.match(/"customerId"\s*:\s*"?(\d{3,})"?/) || [])[1];
    if (!id) throw new Error('in questa pagina Autoscout non c\'e\' l\'id del concessionario');
    // Il nome sta in tre posti e non tutti reggono: il <title> ha attributi (il mio primo
    // `<title>` senza `[^>]*` non agganciava niente e il nome usciva vuoto), l'<h1> e'
    // pulito, e il titolo serve solo come rete. Si prende il primo che risponde.
    const h1 = pulisci((html.match(/<h1[^>]*>([\s\S]{2,90}?)<\/h1>/i) || [])[1] || '');
    const tit = pulisci((html.match(/<title[^>]*>([\s\S]{3,140}?)<\/title>/i) || [])[1] || '');
    const daTitolo = tit.replace(/^Veicoli di\s*/i, '').split('|')[0].replace(/\s+in\s+[^|]*$/i, '').trim();
    const nome = h1 || daTitolo || 'Concessionario';
    const dove = pulisci((html.match(/"addressLocality"\s*:\s*"([^"]{2,60})"/) || [])[1]
      || (tit.match(/\bin\s+([^|]+?)\s*\|/i) || [])[1] || '');
    const via = pulisci((html.match(/"streetAddress"\s*:\s*"([^"]{3,80})"/) || [])[1] || '');
    return { fonte: 'autoscout', id, nome, dove: dove || null, via: via || null, url };
  }

  if (/subito\.it\/shops\//i.test(url) || /subito\.it\/.*\/shops\//i.test(url)) {
    // L'URL porta l'id NEGOZIO; il filtro vuole l'id UTENTE. Si prende da un suo annuncio.
    const shop = (url.match(/\/shops\/(\d+)/) || [])[1];
    if (!shop) throw new Error('non riesco a leggere l\'id del negozio da questo link');
    const html = await getTesto(url);
    const uid = (html.match(/"user_id"\s*:\s*"?(\d{3,})"?/) || [])[1]
             || (html.match(/[?&]uid=(\d{3,})/) || [])[1];
    if (!uid) throw new Error('la vetrina non espone l\'id utente: apri un suo annuncio e incolla quello');
    const nome = pulisci((html.match(/<title>([^<|]{3,90})/i) || [])[1] || '') || ('Negozio ' + shop);
    return { fonte: 'subito', id: uid, shopId: shop, nome, dove: null, url };
  }

  throw new Error('per ora riconosco le vetrine di Autoscout (/concessionari/...), di Subito (/shops/...) e di Moto.it (dealer.moto.it/...)');
}

/* ─── il parco ────────────────────────────────────────────────────────────── */
/**
 * Tutti i veicoli di una vetrina, auto e moto insieme.
 * @returns {Promise<{veicoli:Array, troncato:boolean}>}
 */
async function parco(voce) {
  const veicoli = [];
  let troncato = false;

  // Moto.it non passa dagli scraper di ricerca: quel motore non filtra per venditore, e il
  // parco si legge dalla vetrina. Solo moto, e solo l'usato — il nuovo la fonte lo tiene
  // in una sezione a parte, e mescolarlo qui falserebbe ogni mediana.
  if (voce.fonte === 'moto') {
    const r = await vetrinaMoto.parco(voce.id, { ctx: { venditoreNome: voce.nome, provincia: voce.provincia || null } });
    return { veicoli: r.items.map(v => ({ ...v, tipo: 'moto' })), troncato: r.troncato };
  }

  for (const tipo of ['auto', 'moto']) {
    const params = voce.fonte === 'autoscout'
      ? { tipo, as24Customer: voce.id }
      : { tipo, subitoUid: voce.id };
    const scr = voce.fonte === 'autoscout' ? scrapeAs24 : scrapeSubito;
    let r;
    try { r = await scr(params, { maxPages: MAX_PAGINE, withMeta: true }); }
    catch (e) { throw new Error(`${voce.fonte}: ${e.message}`); }
    const items = Array.isArray(r) ? r : (r.items || []);
    if (!Array.isArray(r) && r.truncated) troncato = true;
    for (const v of items) veicoli.push({ ...v, tipo });
  }
  return { veicoli, troncato };
}

/* ─── i numeri ────────────────────────────────────────────────────────────── */
const mediana = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const conta = (arr, f) => {
  const m = new Map();
  for (const x of arr) { const k = f(x); if (k == null || k === '') continue; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const marcaDi = v => {
  // LA DICE LA FONTE. Prendendo la prima parola del titolo, "Alfa Romeo Giulia" diventava
  // "Alfa" e "Land Rover Defender" diventava "Land": due marche spezzate a meta' che poi
  // nel conteggio sembravano marche vere. Il titolo resta solo come rete.
  if (v.marca) return pulisci(v.marca);
  const t = pulisci(v.titolo);
  return t ? t.split(/\s+/)[0] : null;
};

function aggrega(veicoli) {
  const prezzi = veicoli.map(v => v.prezzo).filter(n => n > 0);
  const anni = veicoli.map(v => v.anno).filter(n => n > 1950);
  const km = veicoli.map(v => v.km).filter(n => n > 0);
  const oggi = Date.now();
  /**
   * GIACENZA. Solo Autoscout: li' `posted_at` e' la prima pubblicazione (misurato su un
   * parco vero: da 11 a 41 giorni, mediana 36). Su Subito la stessa data si azzera a ogni
   * rilancio — 27 auto tutte "pubblicate oggi" — quindi da li' non si calcola, e non si
   * mette insieme alle altre facendo finta di niente.
   */
  const gg = veicoli.filter(v => v.fonte === 'autoscout' && v.posted_at)
    .map(v => Math.round((oggi - new Date(v.posted_at)) / 86400000))
    .filter(n => Number.isFinite(n) && n >= 0);
  return {
    veicoli: veicoli.length,
    auto: veicoli.filter(v => v.tipo === 'auto').length,
    moto: veicoli.filter(v => v.tipo === 'moto').length,
    prezzo: prezzi.length ? { min: Math.min(...prezzi), mediana: mediana(prezzi), max: Math.max(...prezzi) } : null,
    anno: anni.length ? { mediana: mediana(anni), min: Math.min(...anni), max: Math.max(...anni) } : null,
    km: km.length ? { mediana: mediana(km) } : null,
    giacenza: gg.length ? { mediana: mediana(gg), max: Math.max(...gg), su: gg.length, suTotale: veicoli.length } : null,
    marche: conta(veicoli, marcaDi).slice(0, 12).map(([k, n]) => ({ nome: k, n })),
    alimentazione: conta(veicoli, v => v.carburante).slice(0, 8).map(([k, n]) => ({ nome: k, n })),
    venditori: conta(veicoli, v => v.venditoreNome).map(([k, n]) => ({ nome: k, n })),
  };
}

module.exports = { leggi, scrivi, risolviVetrina, parco, aggrega, _filePath: filePath };
