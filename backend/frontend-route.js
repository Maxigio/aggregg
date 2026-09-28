'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const filtriAuto = require('./filtri-auto');
const { buildFrontendSync, frontendSourceSync, JS_FILES, CSS_FILES } = require('../scripts/build-frontend');
const { buildGuidaSync, mtimeGuida } = require('../scripts/build-guida');

function mount(app) {
  // Serve app.js/style.css minificati; se esbuild manca al boot si serve il sorgente composto.
  let minFE = { js: null, css: null, ver: '' };
  try { minFE = buildFrontendSync(); console.log(`[frontend] minify OK v${minFE.ver}`); }
  catch (e) {
    console.warn('[frontend] minify fallita → servo i sorgenti:', e.message);
    try { minFE = frontendSourceSync(); } catch (_) { /* lo static gestisce l'assenza del file */ }
  }

  /**
   * IL BUNDLE SI RIFA' DA SOLO QUANDO IL SORGENTE CAMBIA.
   *
   * Senza, `index.html` veniva riletto dal disco a ogni richiesta mentre `app.js` restava
   * quello congelato all'avvio: modificando il frontend si otteneva una pagina con l'HTML
   * NUOVO e il JavaScript VECCHIO. E' successo davvero, e il sintomo non dice niente — il
   * bottone della sezione nuova compare e non fa niente, perche' il gestore non e' nel
   * bundle. Un errore che non fa rumore e manda a cercare il bug nel posto sbagliato.
   *
   * Controlla il timestamp di ogni sorgente del bundle e del foglio stile.
   * Se la ricostruzione fallisce si tiene il bundle buono di prima invece di servire un
   * frontend a meta'.
   */
  let mtimeFE = '';
  const FILE_FE = [...JS_FILES, ...CSS_FILES];
  const timbroFE = () => FILE_FE.map(f => {
    try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; }
    catch (_) { return 'assente'; }
  }).join('|');
  mtimeFE = timbroFE();
  function aggiornaFE() {
    const t = timbroFE();
    if (t === mtimeFE || !minFE.js) return;
    try {
      minFE = buildFrontendSync();
      mtimeFE = t;
      console.log(`[frontend] sorgente cambiato → minify rifatta v${minFE.ver}`);
    } catch (e) {
      mtimeFE = t;   // non ritentare a ogni richiesta su un sorgente rotto
      console.warn('[frontend] minify fallita, tengo il bundle precedente:', e.message);
    }
  }

  const serveMin = (kind, type) => (req, res, next) => {
    aggiornaFE();
    if (!minFE[kind]) return next();                         // build fallita → sorgente via static
    res.type(type).set('Cache-Control', 'no-cache').set('ETag', `"${minFE.ver}"`);
    if (req.headers['if-none-match'] === `"${minFE.ver}"`) return res.status(304).end();
    res.send(minFE[kind]);
  };
  app.get('/app.js',    serveMin('js',  'application/javascript'));
  app.get('/style.css', serveMin('css', 'text/css'));

  // index.html con asset VERSIONATI (?v=<ver>): al cambio codice l'URL cambia → il browser scarica
  // il bundle nuovo da solo su un reload normale (niente hard refresh). ver = hash del build minify.
  app.get(['/', '/index.html'], (req, res, next) => {
    try {
      // Prima di scrivere il ?v= nell'HTML: se il sorgente e' cambiato la versione dev'essere
      // gia' quella nuova, se no la pagina chiede il bundle vecchio col numero vecchio e il
      // giro riparte identico.
      aggiornaFE();
      const v = minFE.ver || String(Date.now());
      let html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8')
        .replace(/(src|href)="(app\.js|style\.css|pricing\.js)"/g, `$1="$2?v=${v}"`);
      res.set('Cache-Control', 'no-cache').type('html').send(html);
    } catch (_) { next(); }
  });

  /**
   * I FILTRI AVANZATI DELLE AUTO, per chi deve disegnarli.
   *
   * Le voci non si riscrivono nell'HTML: vengono da data/filtri-auto.json, che e' la stessa
   * tabella con cui il server le traduce nel dialetto delle fonti. Scritte in due posti,
   * il giorno che una fonte cambia un codice ne resterebbe uno vecchio — e a schermo non
   * si vedrebbe niente, solo una ricerca che torna storta.
   */
  app.get('/api/filtri-auto', (req, res) => {
    res.set('Cache-Control', 'no-cache').json({
      filtri: filtriAuto.NOMI.map(n => ({
        nome: n,
        etichetta: filtriAuto.TAB.filtri[n].etichetta,
        voci: filtriAuto.voci(n),
      })),
      potenza: { etichetta: filtriAuto.TAB.potenza.etichetta },
    });
  });

  /**
   * LA GUIDA — montata, non scritta a mano.
   *
   * Il testo sta in docs/guida/*.md; gli elenchi (modi, filtri, ordinamenti, fonti) e i pezzi
   * mostrati escono da frontend/index.html e da fonti-route.js, cioe' dalle stesse sorgenti che
   * l'app usa per funzionare. Vedi scripts/build-guida.js.
   *
   * Sta PRIMA dello static apposta: `frontend/guida.html` e' il modello con i segnaposti
   * <!--INDICE--> e <!--CORPO--> dentro, e servito cosi' com'e' mostrerebbe una pagina vuota.
   * Intercettare anche `/guida.html` chiude quella porta.
   *
   * Dietro il gate come tutto il resto (non e' in AUTH_FREE): e' la mappa completa di cosa sa
   * fare l'app, e questo server e' pubblicato su internet.
   */
  let guida = { html: null, ver: '', sezioni: 0 };
  let mtimeGuidaVisto = 0;
  try {
    guida = buildGuidaSync();
    mtimeGuidaVisto = mtimeGuida();
    console.log(`[guida] montata v${guida.ver} (${guida.sezioni} sezioni)`);
  } catch (e) {
    console.warn('[guida] build fallita → /guida risponde 503:', e.message);
  }

  app.get(['/guida', '/guida.html'], (req, res) => {
    const t = mtimeGuida();
    if (t !== mtimeGuidaVisto) {
      // Il timbro si aggiorna anche quando la build fallisce: se no un markdown rotto farebbe
      // ritentare il montaggio a OGNI richiesta, e la guida diventerebbe il pezzo piu' lento
      // dell'app proprio mentre e' rotta. Si tiene l'ultima versione buona.
      mtimeGuidaVisto = t;
      try { guida = buildGuidaSync(); console.log(`[guida] sorgente cambiato → rimontata v${guida.ver}`); }
      catch (e) { console.warn('[guida] rimontaggio fallito, tengo la versione precedente:', e.message); }
    }
    if (!guida.html) return res.status(503).type('text/plain').send('La guida non è disponibile: montaggio fallito.');
    res.type('html').set('Cache-Control', 'no-cache').set('ETag', `"${guida.ver}"`);
    if (req.headers['if-none-match'] === `"${guida.ver}"`) return res.status(304).end();
    res.send(guida.html);
  });

  app.use(express.static(path.join(__dirname, '../frontend'), {
    setHeaders(res, filePath) {
      // HTML sempre rivalidato → niente index.html stale in cache dopo un deploy/edit
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

}

module.exports = { mount };
