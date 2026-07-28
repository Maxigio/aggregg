#!/usr/bin/env node
'use strict';
/**
 * I RICHIAMI DELL'RDW — l'archivio olandese delle campagne di richiamo, scaricato una volta.
 *
 * PERCHE' ACCANTO A SAFETY GATE, e non al suo posto. Safety Gate e' l'allerta di sicurezza
 * europea: dice che un'autorita' ha accertato un pericolo, ma individua i veicoli colpiti
 * col numero di omologazione o un intervallo di telaio — due cose che un annuncio non
 * porta. `safety-gate.js` lo scrive nel suo commento e resta vero.
 *
 * L'RDW invece lega ogni campagna a MARCA e TIPO in chiaro: 5.245 campagne, 10.559 righe
 * marca+modello. E' l'aggancio che a Safety Gate manca. Che sia un archivio olandese non
 * lo rende olandese il difetto: se il costruttore richiama un modello per i bulloni dello
 * sterzo, quel modello ha quel difetto anche in piazzale a Brescia.
 *
 * COSA NON DICE, e va detto: la campagna riguarda numeri di telaio decisi dal costruttore,
 * non tutti gli esemplari del modello. Qui il semaforo resta a livello di MODELLO, come per
 * Safety Gate. E non c'e' finestra di produzione: filtrare per anno non si puo'.
 *
 * Licenza: Public Domain (dichiarata dall'API). Nessuna chiave, nessuna registrazione.
 *
 *   node scripts/build-rdw-richiami.js            → data/rdw-richiami.json
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const HOST = 'opendata.rdw.nl';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const DEST = path.join(__dirname, '..', 'data', 'rdw-richiami.json');
const PAGINA = 1000;

function getJson(percorso) {
  return new Promise((res, rej) => {
    const req = https.get({ host: HOST, path: percorso, headers: { 'user-agent': UA, accept: 'application/json' } }, r => {
      let d = ''; r.setEncoding('utf8');
      r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode + ' ' + d.slice(0, 120)));
        try { res(JSON.parse(d)); } catch (e) { rej(new Error('risposta non-JSON')); }
      });
    });
    req.on('error', rej);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

/** Scarica un dataset intero a pagine di mille. Si ferma quando la pagina non e' piena. */
async function tutto(id, etichetta) {
  const out = [];
  for (let off = 0; ; off += PAGINA) {
    const p = `/resource/${id}.json?$limit=${PAGINA}&$offset=${off}&$order=:id`;
    const pagina = await getJson(p);
    if (!Array.isArray(pagina)) throw new Error(etichetta + ': risposta inattesa');
    out.push(...pagina);
    process.stdout.write('\r  ' + etichetta + ': ' + out.length + ' righe');
    if (pagina.length < PAGINA) break;
    await new Promise(s => setTimeout(s, 400));   // gentile: e' un archivio pubblico, non una gara
  }
  process.stdout.write('\n');
  return out;
}

/**
 * Le categorie di difetto sono DICIANNOVE in tutto: tradurle a mano si puo' e si deve,
 * perche' e' l'unica parte che un operatore legge di corsa ("freni" vs "carrozzeria").
 * Il testo lungo resta in olandese: tradurre 5.245 descrizioni a mano non si fa, e
 * inventarne una traduzione automatica vorrebbe dire firmare parole non nostre.
 */
const CATEGORIE = {
  'Motorrijtuigen - carrosserie (beschermingsmiddelen inzittenden)': 'Sicurezza passeggeri (airbag, cinture)',
  'Motorrijtuigen - motor inclusief brandstof-, smeer- en koelsysteem': 'Motore, alimentazione e raffreddamento',
  'Motorrijtuigen en aanhangwagens - elektrische installatie': 'Impianto elettrico',
  'Motorrijtuigen en aanhangwagens - reminrichting': 'Impianto frenante',
  'Motorrijtuigen en aanhangwagens - assen, wielen, velgen, banden': 'Assi, ruote, cerchi e pneumatici',
  'Motorrijtuigen en aanhangwagens - stuurinrichting': 'Sterzo',
  'Motorrijtuigen en aanhangwagens - ophanging': 'Sospensioni',
  'Motorrijtuigen - krachtoverbrenging': 'Trasmissione',
  'Motorrijtuigen en aanhangwagens - carrosserie (diverse)': 'Carrozzeria (varie)',
  'Motorrijtuigen en aanhangwagens - carrosserie (deuren, motorkap, laadkleppen)': 'Carrozzeria (porte, cofano, sponde)',
  'Motorrijtuigen - carrosserie (zitplaatsen)': 'Sedili',
  'Motorrijtuigen en aanhangwagens - carrosserie (ruiten, ruitenwissers, ruitensproeiers)': 'Vetri e tergicristalli',
  'Motorrijtuigen en aanhangwagens - diversen': 'Varie',
  '(Nog) niet bekend': 'Non ancora classificato',
  'Motorrijtuigen en aanhangwagens - verbinding tussen motorvoertuig en aanhangwagen': 'Gancio di traino e collegamento rimorchio',
  'Motorrijtuigen en aanhangwagens - lichten, lichtsignalen en retroreflectie': 'Luci, segnalatori e catadiottri',
  'Motorrijtuigen en aanhangwagens - algemene bouwwijze': 'Struttura generale del veicolo',
  'Product voldoet niet aan de typegoedkeuringseisen': 'Prodotto non conforme all\'omologazione',
  'Onderdelen van motorrijtuigen en aanhangwagens': 'Componenti del veicolo',
};

// I rischi sono CINQUE valori in tutto (contati sull'archivio, non immaginati). Come per
// le categorie: quelli che non conosco lo script li segnala invece di lasciarli in olandese.
const RISCHI = {
  'Een (verkeers)ongeval met letselschade': 'Incidente con feriti',
  'Brand met letselschade': 'Incendio con feriti',
  'Een (verkeers)ongeval zonder letselschade': 'Incidente senza feriti',
  'Brand zonder letselschade': 'Incendio senza feriti',
  'Verhoogde kans op letsel bij een ongeval': 'Maggior rischio di lesioni in caso di incidente',
  'Het belasten van het milieu': 'Danno ambientale',
  'Letselschade': 'Danni alle persone',
  'Milieuschade': 'Danno ambientale',
  '(Nog) niet bekend': 'Non ancora valutato',
};

const num = v => { const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const iso = v => {
  const s = String(v || '');
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : (s.slice(0, 10).match(/^\d{4}-\d{2}-\d{2}$/) ? s.slice(0, 10) : null);
};

(async () => {
  console.log('Richiami RDW — scarico i tre pezzi (public domain, nessuna chiave)');
  const azioni = await tutto('j9yg-7rg9', 'campagne');
  const veicoli = await tutto('mu2x-mu5e', 'marca+modello');
  const rischi = await tutto('9ihi-jgpf', 'rischio');

  const perRif = new Map();
  for (const v of veicoli) {
    const k = v.referentiecode_rdw;
    if (!k) continue;
    if (!perRif.has(k)) perRif.set(k, { marche: new Set(), modelli: new Set() });
    const e = perRif.get(k);
    if (v.merk) e.marche.add(String(v.merk).trim());
    if (v.type) e.modelli.add(String(v.type).trim());
  }
  const perRischio = new Map();
  const rischiFuori = new Set();
  for (const r of rischi) {
    if (!r.referentiecode_rdw) continue;
    const grezzo = r.mogelijk_gevaar;
    if (!grezzo) continue;
    if (!RISCHI[grezzo]) rischiFuori.add(grezzo);
    perRischio.set(r.referentiecode_rdw, RISCHI[grezzo] || grezzo);
  }

  const fuori = new Set();   // categorie non tradotte: si segnalano invece di sparire
  const out = [];
  for (const a of azioni) {
    const rif = a.referentiecode_rdw;
    if (!rif) continue;
    const v = perRif.get(rif);
    // Una campagna senza marca non e' agganciabile a un annuncio: non serve tenerla.
    if (!v || !v.marche.size) continue;
    const cat = a.categorie_defect || null;
    if (cat && !CATEGORIE[cat]) fuori.add(cat);
    out.push({
      rif,
      data: iso(a.publicatiedatum_rdw),
      produttore: a.meldende_producent_distributeur || null,
      marche: [...v.marche],
      modelli: [...v.modelli],
      categoria: cat,
      categoriaIt: cat ? (CATEGORIE[cat] || null) : null,
      /**
       * LA PROSA OLANDESE NON SI TIENE.
       *
       * `omschrijving_defect`, `materi_le_gevolgen` e `beschrijving_van_het_herstel` sono
       * testo libero in olandese: 1,8 MB dei 3,6 del file, e a schermo sarebbero parole
       * che l'operatore non legge. Tradurle con un dizionario non si puo' (sono 4.066
       * frasi diverse con le subordinate, non etichette), tradurle a macchina e' una
       * spesa che il proprietario ha deciso di non fare adesso.
       *
       * Al loro posto il LINK alla campagna vera: la scheda ufficiale RDW, che c'e' per
       * tutte e mostra il difetto per esteso. Meglio un click che una lingua che non serve.
       */
      url: `https://opendata.rdw.nl/Voertuigen/Open-Data-RDW-Terugroep_actie/j9yg-7rg9/explore/query/`
        + encodeURIComponent(`SELECT * WHERE \`referentiecode_rdw\`='${rif}'`) + `/page/filter`,
      rischio: perRischio.get(rif) || null,
      veicoliTotale: num(a.totaal_aantal_voertuigen_terugroepactie),
      veicoliPaesiBassi: num(a.nationaal_opgegeven_aantal_voertuigen_terugroepactie),
      // La pagina del costruttore, quando la dichiara: e' li' che si prenota la riparazione.
      // C'e' solo sul 7% delle campagne, quindi affianca il link alla scheda RDW, non lo sostituisce.
      costruttoreUrl: /^https?:\/\//i.test(a.meer_informatie_op_internet || '') ? a.meer_informatie_op_internet : null,
    });
  }
  out.sort((x, y) => String(y.data || '').localeCompare(String(x.data || '')));

  const marche = new Map();
  for (const r of out) for (const m of r.marche) marche.set(m, (marche.get(m) || 0) + 1);

  const dati = {
    fonte: 'RDW Open Data — Terugroepacties',
    licenza: 'Public Domain',
    url: 'https://opendata.rdw.nl/',
    generato: new Date().toISOString().slice(0, 10),
    campagne: out,
  };
  fs.writeFileSync(DEST, JSON.stringify(dati));
  const mb = (fs.statSync(DEST).size / 1048576).toFixed(1);

  console.log('\nscritte ' + out.length + ' campagne agganciabili (su ' + azioni.length + ' totali) → ' + DEST + ' (' + mb + ' MB)');
  console.log('marche distinte: ' + marche.size);
  console.log('prime dieci: ' + [...marche.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([m, n]) => m + ' ' + n).join(' · '));
  if (fuori.size) console.log('\nCATEGORIE SENZA TRADUZIONE (aggiungile a CATEGORIE):\n  ' + [...fuori].join('\n  '));
  if (rischiFuori.size) console.log('\nRISCHI SENZA TRADUZIONE (aggiungili a RISCHI):\n  ' + [...rischiFuori].join('\n  '));
})().catch(e => { console.error('KO:', e.message); process.exit(1); });
