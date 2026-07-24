'use strict';
// Scheda tecnica veicolo da auto-data.net (auto) — fetch HTTP (https nativo) + parsing cheerio.
// Catena: allbrands → brand page (modelli) → model page (generazioni) → generation page
// (motorizzazioni/trim) → trim page (~65 campi tecnici). Zero nuove dipendenze.
const https = require('https');
const zlib = require('zlib');
const cheerio = require('cheerio');
const { fail, kindForStatus } = require('./utils');

const HOST = 'https://www.auto-data.net';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TIMEOUT_MS = 15000;

// Anti-SSRF: questo scraper parla SOLO con auto-data.net. Vale per l'URL iniziale
// E per ogni redirect (un 3xx non può deviare verso host interni/metadata).
const isAllowedHost = h => /(^|\.)auto-data\.net$/i.test(String(h || ''));

// GET testo con gzip/deflate + segui-redirect manuale. Lancia (fail) su errore/blocco.
function httpGetText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (_) { return reject(fail('url non valido', { kind: 'error' })); }
    if (!isAllowedHost(u.hostname)) return reject(fail('host non consentito', { kind: 'blocked' }));
    const req = https.get(url, { headers: { 'user-agent': UA, 'accept-encoding': 'gzip, deflate', 'accept-language': 'en' } }, res => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < 5) {
        res.resume();
        let next; try { next = new URL(res.headers.location, url); } catch (_) { return reject(fail('redirect non valido', { kind: 'error' })); }
        if (!isAllowedHost(next.hostname)) return reject(fail('redirect fuori host', { kind: 'blocked' }));
        return resolve(httpGetText(next.href, redirects + 1));
      }
      if (code === 403 || code === 429) { res.resume(); return reject(fail(`http ${code}`, { status: code, kind: 'blocked' })); }
      if (code >= 400) { res.resume(); return reject(fail(`http ${code}`, { status: code, kind: kindForStatus(code) })); }
      const chunks = [];
      let s = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') s = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      s.on('data', c => chunks.push(c));
      s.on('end', () => resolve({ status: code, body: Buffer.concat(chunks).toString('utf8') }));
      s.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
  });
}

const slugOf = href => String(href || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/?(en\/)?/, '').replace(/\/+$/, '');
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

// allbrands → [{ name, slug }] (slug es. "volkswagen-brand-80")
function parseBrandList(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('a[href*="-brand-"]').each((_, a) => {
    const slug = slugOf($(a).attr('href')); const name = clean($(a).text());
    if (/-brand-\d+$/.test(slug) && name) out.push({ name, slug });
  });
  return dedupe(out);
}
// brand page → [{ name, slug }] (slug es. "volkswagen-golf-model-896")
function parseModelList(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('a[href*="-model-"]').each((_, a) => {
    const slug = slugOf($(a).attr('href')); const name = clean($(a).text());
    if (/-model-\d+$/.test(slug) && name) out.push({ name, slug });
  });
  return dedupe(out);
}
// model page → [{ name, slug, years }] (slug es. "volkswagen-golf-vii-5-door-generation-3936").
// Nome + anni dal CONTESTO della riga ("Golf VIII 2020 - 2024 Hatchback…"): il link-nome NON
// contiene gli anni, che stanno nella riga insieme a carrozzeria/potenza.
function parseGenerationList(html) {
  const $ = cheerio.load(html);
  const bySlug = new Map();
  $('a[href*="-generation-"]').each((_, a) => {
    const slug = slugOf($(a).attr('href'));
    if (!/-generation-\d+$/.test(slug)) return;
    const text = clean($(a).text());
    const ctx = clean($(a).closest('tr, li, div').text());
    const yr = ctx.match(/((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})?/);   // range "2012 - 2020" / "1974 -": ancora sugli anni, non su cilindrata & c.
    const years = yr ? [Number(yr[1]), ...(yr[2] ? [Number(yr[2])] : [])]
      : [...new Set((ctx.match(/(19|20)\d{2}/g) || []).map(Number))].sort((x, y) => x - y);
    const isName = /[a-z]/i.test(text) && !/^\d/.test(text) && text.length < 70;   // il nome vero (non "2024 - Hatchback…")
    const g = bySlug.get(slug) || { slug, name: '', years: [], img: '' };
    if (isName && !g.name) g.name = text;
    if (years.length >= g.years.length) g.years = years;
    if (!g.img) {   // thumbnail della generazione (aiuta la scelta): prima <img> "foto" nella riga
      const src = $(a).closest('tr, li, div').find('img').first().attr('src') || '';
      const junk = /(flag|logo|icon|sprite|loader|spacer|blank|pixel|placeholder|\/i\/)/i;   // scarta bandiere/icone/segnaposto
      if (/\.(jpe?g|png|webp)/i.test(src) && !junk.test(src)) {
        g.img = /^https?:/.test(src) ? src : src.startsWith('//') ? 'https:' + src : HOST + (src[0] === '/' ? '' : '/') + src;
      }
    }
    bySlug.set(slug, g);
  });
  return [...bySlug.values()].filter(g => g.name);
}
// generation page → [{ label, url, hp, fuel }] motorizzazioni (label ricavata dallo slug)
function parseTrimList(html, genSlug) {
  const $ = cheerio.load(html);
  const genBase = String(genSlug || '').replace(/-generation-\d+$/, '');   // es. "volkswagen-golf-vii-5-door"
  const seen = new Set(); const out = [];
  $('a[href]').each((_, a) => {
    const slug = slugOf($(a).attr('href'));
    if (!/-\d{4,6}$/.test(slug)) return;                 // trim page: finisce con ID
    if (genBase && !slug.startsWith(genBase + '-')) return;
    if (/-(brand|model|generation)-\d+$/.test(slug)) return;
    if (seen.has(slug)) return; seen.add(slug);
    const trimSlug = slug.slice((genBase + '-').length).replace(/-\d{4,6}$/, '');   // solo la parte trim (no marca/gen/id)
    const label = prettyLabel(trimSlug);
    // anni della motorizzazione dal contesto riga ("…DSG 2024 -" / "…2013 - 2020")
    const ctx = clean($(a).closest('tr, li, div').text());
    const ym = ctx.match(/((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})?/);
    const year = ym ? Number(ym[1]) : null;
    const yearRange = ym ? (ym[2] ? `${ym[1]}–${ym[2]}` : `${ym[1]}–`) : '';
    out.push({ label, url: `${HOST}/it/${slug}`, hp: hpOf(trimSlug), fuel: fuelOf(trimSlug), year, yearRange });   // hp/fuel dallo slug-trim; /it/ = specifiche in italiano
  });
  return out;
}

function prettyLabel(s) {
  const out = s.replace(/-/g, ' ')
    .replace(/\b(tdi|tsi|tfsi|fsi|gti|gtd|gte|cdi|dsg|hp|kw|awd|4motion|4matic|xdrive|quattro|scr)\b/gi, m => m.toUpperCase())
    .replace(/\b(\d+)hp\b/gi, '$1 Hp')
    .replace(/\s+/g, ' ').trim();
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}
const hpOf = s => { const m = String(s).match(/(\d+)hp/i); return m ? Number(m[1]) : null; };
const fuelOf = s => { s = String(s).toLowerCase();
  if (/tdi|cdi|hdi|dci|jtd|bluetec|diesel|\d+d(?![a-z0-9])/.test(s)) return 'Diesel';   // \d+d = "320d/318d"; NON "hybrid-e" (era il baco di "d-")
  if (/tsi|tfsi|fsi|vti|mpi|gti|petrol|benz/.test(s)) return 'Benzina';
  if (/phev|plug/.test(s)) return 'Ibrida plug-in';
  if (/hybrid|hev/.test(s)) return 'Ibrida';
  if (/electric|ev\b|e-tron|kwh/.test(s)) return 'Elettrica';
  return null;
};

// Ricerca interna del sito (get-words.php) → [{ slug, url, label, kind, year, yearRange, hp, fuel, img }].
// Risolve sigle-motore/varianti che NON sono modelli ("318"→trim Serie 3, "CT 200h"→trim Lexus CT).
// Formato risposta: "header###idx|slug###<img src=…>label |slug2###<img …>label2 |…" (slug prima, label dopo).
function parseSearchWords(body) {
  const parts = String(body || '').split('###');
  const SL = /\|([a-z0-9][a-z0-9.\-]*-\d+)/i;   // slug: può contenere punti (es. "24.2-kwh") e finisce con -ID
  const slugs = [], labels = [], imgs = [];
  const first = (parts[1] || '').match(SL); if (first) slugs.push(first[1]);
  for (let i = 2; i < parts.length; i++) {
    const lm = parts[i].match(/<img[^>]*src="([^"]*)"[^>]*>\s*([^|]*?)\s*(?:\||$)/i);
    if (lm) { imgs.push(lm[1]); labels.push(clean(lm[2])); }
    const sm = parts[i].match(SL); if (sm) slugs.push(sm[1]);
  }
  const out = [];
  for (let i = 0; i < Math.min(slugs.length, labels.length); i++) {
    const slug = slugs[i], raw = labels[i];
    const kind = /-model-\d+$/.test(slug) ? 'model' : /-generation-\d+$/.test(slug) ? 'gen' : 'trim';
    const ym = raw.match(/\((\d{4})\s*-\s*(\d{4})?\s*\)/);   // "(1982 - 1986)" / "(2017 - )"
    const hp = (raw.match(/\((\d{2,4})\s*Hp\)/i) || [])[1];
    const label = raw.replace(/\s*\(\d{2,4}\s*Hp\)/i, '').replace(/\s*\(\d{4}\s*-\s*\d{0,4}\s*\)\s*$/, '').trim();   // via anno/hp (mostrati a parte)
    let img = imgs[i] || '';
    if (img && !/^https?:/.test(img)) img = img.startsWith('//') ? 'https:' + img : HOST + (img[0] === '/' ? '' : '/') + img;
    out.push({ slug, url: `${HOST}/it/${slug}`, label, kind, year: ym ? Number(ym[1]) : null, yearRange: ym ? (ym[2] ? `${ym[1]}–${ym[2]}` : `${ym[1]}–`) : '', hp: hp ? Number(hp) : null, fuel: fuelOf(slug), img });   // /it/ = specifiche italiane
  }
  return out;
}

// valore: togli le conversioni imperiali (mpg/mph/lbs/in./cu ft/gal/qt), anche a range "36.8 - 32.7 US mpg" → resta il metrico
function cleanVal(v) {
  return clean(v)
    .replace(/\s*[|]?\s*\d[\d.,]*\s*(?:-\s*\d[\d.,]*\s*)?(US\b|UK\b|Imp\b|mph|mpg|lbs?\b|cu\.?|in\.|ft\b|gal\b|qt\b).*$/i, '')   // taglia dalla 1a conversione imperiale (range incluso)
    .replace(/\s+$/, '').trim() || clean(v);
}

const GROUP_ORDER = ['Motore', 'Prestazioni', 'Consumi ed emissioni', 'Trasmissione, freni, sospensioni', 'Dimensioni', 'Pesi e capacità', 'Generale'];
// bilingue EN (/en/) + IT (/it/): mantiene l'inglese (nessuna regressione) e aggiunge i termini italiani.
function classifyKey(k) {
  const s = k.toLowerCase();
  if (/consum|economy|co2|emission|emissione|fuel type|tipo (di )?carburante|gas di scarico/.test(s)) return 'Consumi ed emissioni';
  if (/displacement|cylinder|valve|bore|stroke|compression|aspiration|fuel system|injection|coolant|position of|motor|cilindr|valvol|alesaggio|\bcorsa\b|compressione|aspirazion|iniezione|distribuzione|olio/.test(s)) return 'Motore';
  if (/power|torque|speed|acceleration|0-100|0-60|per litre|per litro|weight-to-power|prestazion|potenza|coppia|accelerazion|velocit|rapporto peso/.test(s)) return 'Prestazioni';
  if (/drive|transmission|gearbox|number of gears|clutch|suspension|brake|tyre|tire|rim|wheel size|steering|assisting|axle|trazione|marce|\bcambio\b|sospension|freni|pneumatic|cerchi|sterzo|assistenza|avviamento/.test(s)) return 'Trasmissione, freni, sospensioni';
  if (/length|width|height|wheelbase|track|clearance|ground|turning|drag|aerodynamic|coefficient|lunghezza|larghezza|altezza|\bpasso\b|carreggiata|coefficiente|resistenza|diametro|sterzata|suolo/.test(s)) return 'Dimensioni';
  if (/weight|kerb|payload|trunk|boot|volume|tank|capacit|peso|massa|carico|bagagliaio|serbatoio|tetto|rimorchiabile/.test(s)) return 'Pesi e capacità';
  return 'Generale';
}
const IDENTITY_KEYS = new Set(['Brand', 'Model', 'Generation', 'Modification (Engine)', 'Start of production', 'End of production',
  'Marca', 'Modello', 'Generazione', 'Modifica (motore)', 'Inizio anno di produzione']);

// trim page → { head:{brand,model,generation,modification}, groups:[{title, rows:[{k,v}]}] }
// I titoli-sezione di auto-data.net non si allineano 1:1 alle tabelle → classifichiamo per contenuto.
function parseTrimSpecs(html) {
  const $ = cheerio.load(html);
  const head = {};
  const byGroup = {}; const seen = new Set();
  $('table.cardetailsout tr').each((_, tr) => {
    const cells = $(tr).find('th,td');
    if (cells.length < 2) return;
    const k = clean($(cells[0]).text());
    if (!k) return;
    $(cells[1]).find('br').replaceWith(' ');   // valori multi-riga (<br>) → non fondere le parole
    const vRaw = clean($(cells[1]).text());
    if (k === 'Brand' || k === 'Marca') head.brand = vRaw;
    else if (k === 'Model' || k === 'Modello') head.model = vRaw;
    else if (k === 'Generation' || k === 'Generazione') head.generation = vRaw;
    else if (k === 'Modification (Engine)' || k === 'Modifica (motore)') head.modification = vRaw;
    if (IDENTITY_KEYS.has(k) || seen.has(k)) return;   // identità → nel head, non nei gruppi
    const v = cleanVal(vRaw);
    if (!v || v === k) return;
    seen.add(k);
    const g = classifyKey(k);
    (byGroup[g] = byGroup[g] || []).push({ k, v });
  });
  const groups = GROUP_ORDER.filter(t => byGroup[t]).map(t => ({ title: t, rows: byGroup[t] }));
  return { head, groups };
}

async function fetchVehicleSpecs(url) {
  const { body } = await httpGetText(url);
  const parsed = parseTrimSpecs(body);
  if (!parsed.groups.length) throw fail('nessuna specifica trovata', { kind: 'error' });
  return { ...parsed, source: 'auto-data.net', url };
}

function dedupe(arr) { const m = new Map(); for (const x of arr) if (!m.has(x.slug)) m.set(x.slug, x); return [...m.values()]; }

module.exports = {
  HOST, httpGetText, fetchVehicleSpecs,
  parseBrandList, parseModelList, parseGenerationList, parseTrimList, parseTrimSpecs, parseSearchWords,
  slugOf, prettyLabel,
};
