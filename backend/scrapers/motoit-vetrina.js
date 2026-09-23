'use strict';
/**
 * MOTO.IT — il parco di un concessionario, dalla sua VETRINA.
 *
 * Il motore di ricerca di Moto.it non filtra per venditore: `/moto-usate/ricerca` conosce
 * marca, modello, versione, prezzo, anni — non chi vende. La vetrina invece esiste ed e'
 * servita dal server, tutta:
 *
 *     https://dealer.moto.it/<slug>            l'anagrafica (indirizzo, telefono, sito)
 *     https://dealer.moto.it/<slug>/Usato      il parco usato, 12 per pagina
 *     https://dealer.moto.it/<slug>/Usato/pagina-N
 *     https://dealer.moto.it/<slug>/Nuovo      il nuovo, elencato a parte dalla fonte
 *
 * Lo slug lo leggiamo gia' dalla pagina-annuncio (`vetrinaUrl` in detail.js): e' l'aggancio
 * che mancava per mettere Moto.it fra le fonti della sezione Competitor.
 *
 * TRE COSE MISURATE, perche' nessuna delle tre si indovina:
 *
 *   IL LINK ALL'ANNUNCIO NON VA RICOSTRUITO. La card porta l'id (`annuncio_10066816`) ma
 *   non l'URL, e l'id da solo non basta: `/moto-usate/annuncio/<id>` e `/moto-usate/<id>`
 *   rispondono 404 tutti e due. Moto.it pero' NORMALIZZA il percorso sull'id — chiesto
 *   `/moto-usate/xxx/xxx/xxx/10066816` risponde 301 verso
 *   `/moto-usate/yamaha/tricity-125/tricity-125-2017-20/10066816`. Quindi gli slug si
 *   scrivono come vengono dal titolo della card: se sbagliano, li corregge la fonte.
 *
 *   LA PAGINAZIONE MENTE PER DIFETTO. Il widget in fondo mostra al massimo sei numeri:
 *   fidandosi di quelli, un parco da dieci pagine ne darebbe sei e sembrerebbe intero. Si
 *   va avanti finche' una pagina torna vuota (misurato: pagina-4 di un parco da 33 usate
 *   risponde 200 con zero card), non finche' finiscono i numeri.
 *
 *   IL PREZZO CIVETTA. Su una vetrina vera una Tricity 125 sta a "1 euro". Qui il prezzo
 *   si legge com'e' scritto — e' chi fa le medie che deve sapere che quell'uno esiste.
 */
const cheerio = require('cheerio');
const salute = require('../fonti-salute');
const motoit = require('./motoit');          // `_get`: HTTP gentile + conteggio richieste

const BASE = 'https://dealer.moto.it';
const CARD_PER_PAGINA = 12;
const MAX_PAGINE = 40;                       // 40 x 12 = 480 veicoli: oltre, si dichiara troncato
const DELAY_MS = 700;                        // sequenziale e gentile, come lo scraper di ricerca

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pulisci = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Solo un nome di vetrina, mai un pezzo di percorso: l'URL lo componiamo noi. */
const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{1,59}$/;

/**
 * Dal link della vetrina allo slug. Accetta la home e le sue sottopagine
 * (`/nikomoto`, `/nikomoto/Usato`, `/nikomoto/Usato/pagina-2`).
 */
function slugVetrina(urlRaw) {
  let u; try { u = new URL(String(urlRaw || '').trim()); } catch (_) { return null; }
  if (!/^dealer\.moto\.it$/i.test(u.hostname)) return null;
  const primo = u.pathname.split('/').filter(Boolean)[0] || '';
  return SLUG_OK.test(primo) ? primo : null;
}

const numero = s => {
  const n = parseInt(String(s == null ? '' : s).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

/** Le foto della vetrina stanno su un'altra CDN (vetrinamotori), non su cdn-img.moto.it. */
function fotoDaSrc(src) {
  const base = String(src || '').split('?')[0];
  if (!/^https:\/\/cdn-img\.(vetrinamotori\.it|moto\.it)\//i.test(base)) return null;
  return { thumb: `${base}?quality=75&format=webp&width=400`, full: `${base}?quality=80&format=webp&width=1200` };
}

const slugParola = s => pulisci(s).toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * L'URL dell'annuncio su Moto.it. Gli slug sono un tentativo dal titolo della card: la
 * fonte normalizza sull'id (301), quindi sbagliarli non rompe niente.
 */
function urlAnnuncio(id, marca, modello) {
  const m = slugParola(marca) || 'moto';
  const mod = slugParola(String(modello).replace(/\(.*$/, '')) || 'modello';
  const ver = slugParola(modello) || mod;
  return `https://www.moto.it/moto-usate/${m}/${mod}/${ver}/${id}`;
}

/* ─── anagrafica ──────────────────────────────────────────────────────────── */
// La struttura dei contatti identifica la vetrina anche senza annunci. Un
// titolo generico o il nome ricavato dallo slug non provano la ripartenza.
const vetrinaRiconoscibile = body => cheerio.load(body)('.dlr-map__box__info, .dlr-map__box__address').length > 0;

/**
 * Chi e' il concessionario: nome, dove sta, come lo si chiama.
 * @returns {Promise<{fonte,id,nome,dove,via,telefono,sito,url}>}
 */
async function scheda(slug) {
  if (!SLUG_OK.test(String(slug || ''))) throw new Error('slug della vetrina non valido');
  return salute.richiesta('moto', async () => {
    const { status, body, headers } = await motoit._get(`${BASE}/${slug}`);
    if (status !== 200) throw salute.erroreHttp('moto', status, headers);
    if (salute.fermo('moto').verifica && !vetrinaRiconoscibile(body)) {
      throw new Error('Moto.it: vetrina non riconoscibile, disponibilità non verificata');
    }
    return schedaDaHtml(body, slug);
  });
}

function schedaDaHtml(body, slug) {
  const $ = cheerio.load(body);

  // Il nome sta nel <title> insieme alla descrizione: "Niko Moto - Concessionario moto
  // usate e nuove a Lavis, Trento". Prima del trattino c'e' solo il nome.
  const titolo = pulisci($('title').first().text());
  const nome = pulisci(titolo.split(/\s+[-–|]\s+/)[0]) || slug;

  // La tabella dei contatti e' una riga per icona (globo=indirizzo, telefono, link=sito):
  // si legge dall'icona, non dalla posizione, perche' le righe assenti non lasciano il posto.
  let via = null, telefono = null, sito = null;
  $('.dlr-map__box__info tr').each((_, tr) => {
    const riga = $(tr);
    const cls = (riga.find('i').attr('class') || '');
    const td = riga.find('td').first();
    if (/fa-globe/.test(cls) && !via) via = pulisci(td.text()) || null;
    if (/fa-phone/.test(cls) && !telefono) telefono = pulisci(td.text()) || null;
    if (/fa-link/.test(cls) && !sito) sito = td.find('a[href^="http"]').attr('href') || null;
  });

  // "Lavis (TN)": la sigla e' l'unico pezzo confrontabile con la provincia delle altre
  // fonti — il comune li' non c'e'.
  const dove = pulisci($('.dlr-map__box__address').first().text()) || null;
  return {
    fonte: 'moto', id: slug, nome,
    dove,
    provincia: (String(dove || '').match(/\(([A-Z]{2})\)/) || [])[1] || null,
    via, telefono, sito,
    url: `${BASE}/${slug}`,
  };
}

/* ─── il parco ────────────────────────────────────────────────────────────── */
/** Le card di UNA pagina di vetrina → annunci, nella forma che usa il resto dell'app. */
function mapCards(html, ctx = {}) {
  const $ = cheerio.load(html);
  const out = [];
  const carte = $('.dlr-card');
  carte.each((_, el) => {
    const c = $(el);
    const id = (c.find('[data-target^="#annuncio_"]').first().attr('data-target') || '').replace('#annuncio_', '');
    if (!/^\d{3,}$/.test(id)) return;
    const marca = pulisci(c.find('.dlr-card__info__title__brand').first().text()) || null;
    const modello = pulisci(c.find('.dlr-card__info__title__model').first().text()) || null;
    // "23.897 km" e "del 2017" stanno nella stessa striscia: si distinguono dall'etichetta,
    // non dall'ordine — una card senza chilometri sposterebbe l'anno al primo posto.
    const meta = pulisci(c.find('.dlr-card__meta').first().text());
    const km = (meta.match(/([\d.]+)\s*km/i) || [])[1];
    const anno = (meta.match(/del\s*((?:19|20)\d{2})/i) || [])[1];
    const foto = fotoDaSrc(c.find('.dlr-card__image__imagefile').first().attr('src'));
    out.push({
      fonte: 'moto',
      titolo: [marca, modello].filter(Boolean).join(' ') || `Annuncio ${id}`,
      prezzo: numero(c.find('.dlr-card__extrainfo__price').first().text()),
      km: numero(km),
      anno: anno ? parseInt(anno, 10) : null,
      marca,
      // Senza il periodo fra parentesi: "Tricity 125 (2017 - 20)" e' la versione, il modello
      // e' "Tricity 125" — ed e' quello che chiede il catalogo della scheda tecnica.
      modello: modello ? modello.replace(/\s*\(.*$/, '').trim() || null : null,
      carburante: null,
      provincia: ctx.provincia || null,
      // La vetrina e' di un concessionario per definizione: qui non c'e' il dubbio
      // privato/professionista che c'e' nella ricerca.
      venditore: 'concessionario',
      venditoreNome: ctx.venditoreNome || null,
      descrizione: pulisci(c.find('.dlr-card__info__content').first().text()) || null,
      immagini: foto ? [foto] : [],
      url: urlAnnuncio(id, marca, modello),
      nuovo: !!ctx.nuovo,
      danni: null,
      posted_at: null,
    });
  });
  return out;
}

/**
 * Le card di una pagina PIU' quante ce n'erano davvero.
 * Il conteggio GREZZO non e' un di piu': e' quello che dice se la pagina era piena. Contando
 * solo le card riuscite, una sola card fuori standard (promo, "in arrivo", markup diverso)
 * faceva sembrare finita una pagina piena. Stessa regola di autoscout-graphql.js:490 e
 * subito-api.js:521, dove il conteggio grezzo c'e' gia'.
 */
function leggiPagina(html, ctx = {}) {
  const grezze = cheerio.load(html)('.dlr-card').length;
  return { items: mapCards(html, ctx), grezze };
}

/**
 * Tutto il parco di una sezione della vetrina.
 * @param {string} slug
 * @param {{sezione?: 'Usato'|'Nuovo', maxPagine?: number, ctx?: object}} opts
 * @returns {Promise<{items: Array, troncato: boolean}>}
 */
async function parco(slug, opts = {}) {
  if (!SLUG_OK.test(String(slug || ''))) throw new Error('slug della vetrina non valido');
  const sezione = opts.sezione === 'Nuovo' ? 'Nuovo' : 'Usato';
  const maxPagine = opts.maxPagine || MAX_PAGINE;
  const ctx = { ...(opts.ctx || {}), nuovo: sezione === 'Nuovo' };
  const items = [];
  const visti = new Set();
  let troncato = false;
  let errorePagina = null;
  let illeggibili = 0;      // card presenti che non si sono lasciate leggere: si dicono, non si nascondono

  for (let p = 1; p <= maxPagine; p++) {
    const url = `${BASE}/${slug}/${sezione}` + (p > 1 ? `/pagina-${p}` : '');
    let letta;
    try {
      letta = await salute.richiesta('moto', async () => {
        const { status, body, headers } = await motoit._get(url);
        if (status !== 200) throw salute.erroreHttp('moto', status, headers);
        const pagina = leggiPagina(body, ctx);
        if (pagina.grezze > 0 && !pagina.items.length) throw Object.assign(
          new Error('le card della vetrina non si leggono più: la pagina della fonte è cambiata'), { illeggibili: pagina.grezze });
        if (salute.fermo('moto').verifica && !pagina.items.length && !vetrinaRiconoscibile(body)) {
          throw new Error('Moto.it: vetrina non riconoscibile, disponibilità non verificata');
        }
        return pagina;
      });
    } catch (e) {
      if (p === 1) throw e;
      errorePagina = e;
      if (e.illeggibili) { illeggibili += e.illeggibili; troncato = true; }
      break;
    }
    const { items: pagina, grezze } = letta;
    if (!grezze) break;                        // e' cosi' che finisce il parco, non col widget
    const prima = items.length;
    for (const v of pagina) { if (!visti.has(v.url)) { visti.add(v.url); items.push(v); } }
    illeggibili += grezze - pagina.length;
    // Si guarda il conteggio GREZZO: una pagina piena di dodici card resta piena anche se una
    // non si e' lasciata leggere. Prima il confronto era sulle card riuscite, e undici su
    // dodici significavano "elenco finito" — un parco da sessanta si fermava a undici, con
    // scritto `troncato: false` e le mediane calcolate su quegli undici.
    if (grezze < CARD_PER_PAGINA) break;
    // Una pagina piena che non porta NIENTE di nuovo: la fonte sta ripetendo l'ultima pagina.
    // Senza questa uscita si ciclerebbe fino a maxPagine ripetendo richieste inutili.
    if (items.length === prima) break;
    if (p === maxPagine) troncato = true;
    await sleep(DELAY_MS);
  }
  return { items, troncato, illeggibili, errorePagina };
}

module.exports = { slugVetrina, scheda, parco, _mapCards: mapCards, _scheda: schedaDaHtml, _urlAnnuncio: urlAnnuncio };
