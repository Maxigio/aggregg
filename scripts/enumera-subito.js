#!/usr/bin/env node
'use strict';
/**
 * ENUMERA il catalogo di Subito — marche, modelli, versioni — da data/subito-catalogo.json.
 *
 * NON campiona gli annunci: chiede il catalogo. Sono gli stessi endpoint che la pagina di ricerca
 * di Subito usa per riempire i suoi menu, e li dichiara lei nel proprio `filtersConfig`:
 *
 *   /car/brand   param cb   →  /v1/values/cars/brands
 *   /car/model   param cm   →  /v1/values/cars/brands/{marca}/metamodels
 *   /bike/brand  param bb   →  /v1/values/motorbikes/brands
 *   /bike/model  param bm   →  /v1/values/motorbikes/brands/{marca}/models
 *
 * Seguendo lo schema si arriva a tutti e tre i livelli (verificato, non dedotto):
 *
 *   AUTO  /v1/values/cars/brands                                   262 marche
 *         /v1/values/cars/brands/000083/metamodels                  31 metamodelli   "156"
 *         /v1/values/cars/brands/000083/models                      36 modelli       "156 2ª serie"
 *         /v1/values/cars/brands/000083/models/003405/versions       92 versioni      "156 1.6 16V Twin Spark Distinctive"
 *   MOTO  /v1/values/motorbikes/brands                             229 marche
 *         /v1/values/motorbikes/brands/000040/models               117 modelli       "1198"
 *         /v1/values/motorbikes/brands/000040/models/000698/versions
 *
 * PERCHE' NON SI CAMPIONA PIU'. Prima si leggevano gli id dagli annunci: si vedeva solo cio' che
 * e' in vendita oggi, la ricerca a testo libero restituiva altre marche (misurato: 70 annunci su
 * 100 cercando "Giulia"), e la paginazione si ferma comunque a 10.000 risultati per query.
 * Enumerando, niente di tutto questo esiste piu'.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE PROTEZIONI, e sono la parte importante. Ognuna nasce da un errore gia' commesso oggi:
 *
 *  BUDGET      un tetto di richieste per esecuzione, contato e rispettato. Un ritmo lento non
 *              basta quando il lavoro dura ore: quel che conta e' il totale. Al tetto si ferma
 *              e SALVA, non si arrende buttando via il lavoro.
 *  RIPRESA     ogni marca chiusa si segna `completa`. Rilanciare riprende da dove si era fermato
 *              e non ripete niente. Fermarsi non e' mai una perdita.
 *  ACCUMULO    il file non si rifa' mai da zero: si unisce. Un id visto ieri e non oggi NON
 *              sparisce — e' un fatto stabile del catalogo di Subito, non del nostro campione.
 *  MANIFESTO   per ogni marca si scrive quanto si e' preso e se e' completa. Una marca a meta'
 *              deve RISULTARE a meta', non essere scambiata per finita: e' esattamente il
 *              "lavoro fatto a meta' che crea confusione" da evitare.
 *  STOP SECCO  al primo 403 o 429 ci si ferma e si scrive. Nessuna riprova, nessuna insistenza:
 *              e' la stessa API che serve l'applicazione, e farsi bloccare spegne la ricerca.
 *  NIENTE INDOVINELLI  se una risposta non ha la forma attesa, la marca si marca come fallita
 *              con il motivo. Non si tira a indovinare un formato alternativo.
 *
 * Uso:
 *   node scripts/enumera-subito.js                    riprende e va avanti (tetto 2000 richieste)
 *   node scripts/enumera-subito.js --budget 500       tetto piu' basso
 *   node scripts/enumera-subito.js --tipo auto        solo auto (o moto)
 *   node scripts/enumera-subito.js --marche Fiat,BMW  solo alcune marche
 *   node scripts/enumera-subito.js --rifai            ignora il "completa" e rifa' tutto
 *   node scripts/enumera-subito.js --dry              non scrive
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const RADICE = path.join(__dirname, '..');
const OUT = path.join(RADICE, 'data', 'subito-catalogo.json');

const HOST = 'hades.subito.it';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAUSA_MS = 1200;              // il catalogo e' leggero, ma resta la fonte dell'applicazione
const TIMEOUT_MS = 25000;

/** I due schemi, verificati sul campo. `metamodelli` esiste solo per le auto. */
const SCHEMA = {
  auto: {
    marche: '/v1/values/cars/brands',
    metamodelli: b => `/v1/values/cars/brands/${b}/metamodels`,
    modelli: b => `/v1/values/cars/brands/${b}/models`,
    versioni: (b, m) => `/v1/values/cars/brands/${b}/models/${m}/versions`,
  },
  moto: {
    marche: '/v1/values/motorbikes/brands',
    metamodelli: null,
    modelli: b => `/v1/values/motorbikes/brands/${b}/models`,
    versioni: (b, m) => `/v1/values/motorbikes/brands/${b}/models/${m}/versions`,
  },
};

// ─── Rete ────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Bloccati extends Error {}

let spese = 0;
function chiedi(percorso) {
  spese++;
  return new Promise((resolve, reject) => {
    const req = https.get({ host: HOST, path: percorso, headers: { 'User-Agent': UA, Accept: 'application/json' } }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429) return reject(new Bloccati('HTTP ' + res.statusCode));
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        let j;
        try { j = JSON.parse(s); } catch (_) { return reject(new Error('risposta non JSON')); }
        // `JSON.parse("null")` torna null: JSON valido, ma non un oggetto. Leggerci dentro un
        // campo solleva un TypeError QUI, dentro il gestore della risposta e fuori dal try/catch
        // del corpo: il processo muore e non salva. E' successo all'enumeratore di Moto.it,
        // 44 marche perse. Il tipo si controlla prima di qualunque campo.
        if (!j || typeof j !== 'object') return reject(new Error('risposta JSON ma non un oggetto: ' + JSON.stringify(j)));
        // La forma attesa e' { values: [ {key, value}, … ]. Se non c'e', NON si prova a
        // interpretarla in un altro modo: si dichiara e si va avanti.
        if (!Array.isArray(j.values)) return reject(new Error('manca il campo `values`'));
        resolve(j.values);
      });
    });
    req.on('error', e => reject(new Error(e.message)));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

/**
 * Le voci ripulite. Si tiene TUTTO quello che descrive la gerarchia, e si butta solo il peso
 * (l'ordinamento del menu, che non ci serve).
 *
 * `group_key` e' la FAMIGLIA dichiarata dalla fonte: "156 1ª serie" e "156 2ª serie" portano
 * entrambi group_key 000324 = "156". Prima ricavavo quel nome togliendo la generazione con
 * un'espressione regolare, e ci ho sbattuto contro tutto il giorno — "Porter 1ª/" mozzato a
 * meta', "Mini" che coincideva con la marca, "Jazz 1ª serie 01-08" ripulito a meta'. La fonte
 * lo dice, e non c'e' niente da indovinare.
 *
 * `level` e `label` sono IL LIVELLO, dichiarato: 0/Marca, 1/Modello, 2/Versione. Anche quello
 * l'ho passato la giornata a dedurre.
 */
const voci = v => v.filter(x => x && x.key).map(x => ({
  id: String(x.key),
  nome: String(x.value == null ? '' : x.value),
  ...(x.group_key ? { famigliaId: String(x.group_key), famiglia: String(x.group_label || '') } : {}),
  ...(x.level != null ? { livello: x.level } : {}),
  ...(x.label ? { livelloNome: String(x.label) } : {}),
}));

// ─── Argomenti ───────────────────────────────────────────────────────────────
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const BUDGET = Math.max(1, Number(arg('budget', 2000)) || 2000);
const SOLO_TIPO = arg('tipo', null);
const SOLO_MARCHE = (arg('marche', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const SENZA_VERSIONI = process.argv.includes('--senza-versioni');
const RIFAI = process.argv.includes('--rifai');
const DRY = process.argv.includes('--dry');

// ─── Corpo ───────────────────────────────────────────────────────────────────
(async () => {
  // ACCUMULO: si parte da quello che c'e' gia'.
  const prima = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { return null; } })();
  const cat = {
    auto: (prima && prima.auto) || {},
    moto: (prima && prima.moto) || {},
  };
  const eranoMarche = Object.keys(cat.auto).length + Object.keys(cat.moto).length;

  let bloccato = false;
  const falliti = [];

  /**
   * SALVA DOPO OGNI MARCA. Il salvataggio solo in fondo regge finche' il programma finisce
   * sempre: un TypeError dentro un gestore di risposta non passa dal try/catch del corpo, uccide
   * il processo, e il file non viene mai scritto. E' successo all'enumeratore di Moto.it — 44
   * marche e 1.392 richieste perse perche' la fonte ha risposto `null` una volta.
   * Scrittura ATOMICA (tmp + rename): un crash a meta' scrittura lascerebbe un JSON troncato,
   * che e' peggio di un file vecchio — il vecchio almeno si legge.
   */
  const somma = t => {
    const m = Object.values(cat[t]);
    return {
      marche: m.length,
      complete: m.filter(x => x.completa).length,
      modelli: m.reduce((a, x) => a + Object.keys(x.modelli || {}).length, 0),
      versioni: m.reduce((a, x) => a + Object.values(x.modelli || {}).reduce((b, y) => b + Object.keys(y.versioni || {}).length, 0), 0),
    };
  };
  const salva = () => {
    if (DRY) return null;
    const conta = { auto: somma('auto'), moto: somma('moto') };
    const fuori = {
      generatedAt: new Date().toISOString(),
      fonte: 'hades.subito.it — endpoint /v1/values dichiarati dal filtersConfig della pagina di ricerca',
      nota: 'Catalogo ENUMERATO, non campionato dagli annunci. `completa` su una marca vuol dire che '
        + 'tutti i suoi modelli hanno avuto la chiamata versioni. Una marca senza `completa` e\' a '
        + 'meta\' e va ripresa: rilanciare lo script riparte da li\'.',
      conta, richiesteSpese: spese, bloccato, falliti,
      auto: cat.auto, moto: cat.moto,
    };
    const tmp = OUT + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(fuori, null, 1) + '\n');
    fs.renameSync(tmp, OUT);
    return conta;
  };


  /**
   * RETE DI ULTIMA ISTANZA. Le protezioni sopra coprono gli errori che ho PREVISTO: blocchi,
   * budget, risposte malformate. Ma un TypeError in un punto a cui non ho pensato uccide il
   * processo prima di qualunque salvataggio — e' successo, 44 marche buttate.
   * Qui si salva e poi si muore, invece di morire e basta. Non ripara il difetto: impedisce che
   * il difetto costi il lavoro gia' fatto.
   */
  const rete = (che, e) => {
    console.error('[enumera] ' + che + ': ' + (e && e.stack || e));
    try { salva(); console.error('[enumera] salvato quello che c\'era prima di uscire'); }
    catch (e2) { console.error('[enumera] nemmeno il salvataggio e\' riuscito: ' + e2.message); }
    process.exit(1);
  };
  process.on('uncaughtException', e => rete('eccezione non gestita', e));
  process.on('unhandledRejection', e => rete('promessa rifiutata e non gestita', e));

  const tipi = (SOLO_TIPO ? [SOLO_TIPO] : ['auto', 'moto']).filter(t => SCHEMA[t]);

  for (const tipo of tipi) {
    if (bloccato) break;
    const S = SCHEMA[tipo];
    let marche;
    try { marche = voci(await chiedi(S.marche)); await sleep(PAUSA_MS); }
    catch (e) {
      if (e instanceof Bloccati) { bloccato = true; console.warn('[enumera] ' + tipo + ': ' + e.message + ' → mi fermo'); break; }
      falliti.push(tipo + '/marche: ' + e.message); continue;
    }
    console.log('[enumera] ' + tipo + ': ' + marche.length + ' marche dal catalogo');

    for (const marca of marche) {
      if (bloccato) break;
      if (SOLO_MARCHE.length && !SOLO_MARCHE.some(x => x.toLowerCase() === marca.nome.toLowerCase())) continue;

      const gia = cat[tipo][marca.id];
      // RIPRESA: una marca gia' chiusa non si ripete.
      if (gia && (SENZA_VERSIONI ? gia.completaModelli : gia.completa) && !RIFAI) continue;
      // BUDGET: si controlla PRIMA di cominciare una marca, non a meta'. Cosi' quel che c'e'
      // nel file e' sempre o una marca intera o una marca marcata incompleta.
      if (spese >= BUDGET) { console.log('[enumera] budget di ' + BUDGET + ' richieste esaurito: mi fermo qui, il resto al prossimo giro'); break; }

      const nodo = cat[tipo][marca.id] = {
        nome: marca.nome,
        ...(gia || {}),
        id: marca.id,
        modelli: (gia && gia.modelli) || {},
        completa: false,
      };

      try {
        // NIENTE chiamata ai metamodelli: ogni modello porta gia' `group_key`, che e' lo stesso
        // dato. Erano 262 richieste per qualcosa che arrivava insieme alla risposta successiva.
        const modelli = voci(await chiedi(S.modelli(marca.id)));
        await sleep(PAUSA_MS);

        let conVersioni = 0, senzaVersioni = 0;
        for (const m of modelli) {
          const vecchio = nodo.modelli[m.id];
          // Modalita' marche+modelli: si registra il modello con la sua famiglia e si passa oltre.
          // `completoVersioni` resta false, cosi' il file dice che le versioni mancano ancora e
          // un giro successivo le prende senza rifare i modelli.
          if (SENZA_VERSIONI) {
            nodo.modelli[m.id] = { ...m, id: undefined, nome: m.nome, versioni: (vecchio && vecchio.versioni) || {}, completoVersioni: !!(vecchio && vecchio.completoVersioni) };
            delete nodo.modelli[m.id].id;
            continue;
          }
          if (spese >= BUDGET) break;                       // la marca restera' `completa:false`
          if (vecchio && vecchio.completoVersioni && !RIFAI) { conVersioni++; continue; }
          let vers = [];
          try { vers = voci(await chiedi(S.versioni(marca.id, m.id))); }
          catch (e) {
            if (e instanceof Bloccati) throw e;
            senzaVersioni++;
            nodo.modelli[m.id] = { ...m, id: undefined, versioni: (vecchio && vecchio.versioni) || {}, completoVersioni: false, motivo: e.message };
            await sleep(PAUSA_MS); continue;
          }
          const mappa = { ...((vecchio && vecchio.versioni) || {}) };
          for (const v of vers) mappa[v.id] = v.nome;
          nodo.modelli[m.id] = { ...m, id: undefined, versioni: mappa, completoVersioni: true };
          conVersioni++;
          // Si salva anche DENTRO la marca: una marca grossa sono minuti, e salvando solo a
          // marca chiusa morire a meta' li butta via. Qui e' sicuro perche' `completa` resta
          // false finche' la marca non e' finita — il file dice sempre la verita' su cosa manca.
          if (conVersioni % 15 === 0) salva();
          await sleep(PAUSA_MS);
        }
        // MANIFESTO a DUE livelli: i modelli possono essere completi anche se le versioni no.
        // Senza questa distinzione un giro "marche+modelli" lascerebbe tutto marcato incompleto
        // e il giro dopo rifarebbe da capo anche i modelli.
        nodo.completaModelli = true;
        nodo.completa = !SENZA_VERSIONI && conVersioni === modelli.length && senzaVersioni === 0;
        nodo.modelliAttesi = modelli.length;
        nodo.modelliFatti = Object.keys(nodo.modelli).length;
        console.log('  ' + tipo + ' ' + marca.nome.padEnd(22)
          + 'modelli ' + String(modelli.length).padStart(3)
          + ' · versioni ' + String(Object.values(nodo.modelli).reduce((a, x) => a + Object.keys(x.versioni || {}).length, 0)).padStart(4)
          + (nodo.completa ? ' · completa' : ' · INCOMPLETA')
          + ' · richieste spese ' + spese);
      } catch (e) {
        if (e instanceof Bloccati) {
          bloccato = true;
          console.warn('[enumera] ' + marca.nome + ': ' + e.message + ' → mi fermo e salvo');
          salva(); break;
        }
        falliti.push(tipo + '/' + marca.nome + ': ' + e.message);
      }
      salva();                                // dopo OGNI marca, riuscita o fallita
    }
  }

  // ─── Guardie ───────────────────────────────────────────────────────────────
  const oraMarche = Object.keys(cat.auto).length + Object.keys(cat.moto).length;
  // Accumulando non puo' rimpicciolire: se succede e' un difetto del codice, non un giro sfortunato.
  if (oraMarche < eranoMarche) {
    throw new Error(`il catalogo si e' RIMPICCIOLITO: ${oraMarche} marche contro ${eranoMarche}. Non scrivo.`);
  }

  const conta = salva() || { auto: somma('auto'), moto: somma('moto') };

  console.log('\n[enumera] richieste ' + spese + '/' + BUDGET + (bloccato ? ' · FERMATO da un blocco della fonte' : ''));
  for (const t of ['auto', 'moto']) {
    const c = conta[t];
    console.log('  ' + t.toUpperCase().padEnd(5) + c.marche + ' marche (' + c.complete + ' complete) · '
      + c.modelli + ' modelli · ' + c.versioni + ' versioni');
  }
  if (falliti.length) console.log('  falliti: ' + falliti.length + ' → ' + falliti.slice(0, 3).join(' | '));
  const restano = ['auto', 'moto'].reduce((a, t) => a + Object.values(cat[t]).filter(x => !x.completa).length, 0);
  if (restano) console.log('  marche ancora da completare: ' + restano + ' — rilancia per continuare');

  console.log(DRY ? '[enumera] --dry: niente scritto' : '[enumera] scritto ' + path.relative(RADICE, OUT));
})().catch(e => { console.error('[enumera] ' + e.message); process.exit(1); });
