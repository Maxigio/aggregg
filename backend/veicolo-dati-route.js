'use strict';

const liquidita = require('./liquidita');
const iptCalc = require('./ipt');
const provSigla = require('./province-sigla');
const motornet = require('./scrapers/motornet');
const carburanti = require('./carburanti');

function mount(app) {
  // ─── Liquidita per MARCA: alimenta il segno accanto a ogni annuncio ───────────
  // Si serve solo la marca cercata (poche decine di modelli, non i 1.997 totali), cosi'
  // il client puo' attribuire il dato riga per riga senza scaricare tutto l'archivio.
  // Serve nelle ricerche per sola marca, dove ogni riga e' un modello diverso.
  app.get('/api/liquidita', (req, res) => {
    const marca = String((req.query || {}).marca || '').trim();
    const modello = String((req.query || {}).modello || '').trim();
    const tipo = String((req.query || {}).tipo || 'auto');
    if (!marca) return res.json({ ok: false });
    // La marca del catalogo va TRADOTTA in quella dell'Autoritratto ("Mercedes-Benz" \u2192
    // "mercedes"), senno' la scansione per prefisso non trova niente e la lista dei modelli
    // torna vuota \u2014 stesso difetto che `cerca()` aveva sulla voce singola.
    const marcaAci = liquidita.risolviMarca(marca);
    if (!marcaAci) return res.json({ ok: true, marca, anno: liquidita.dati.anno, fonte: liquidita.dati.fonte, modelli: [], voce: null });
    const pref = marcaAci + '|';
    const modelli = [];
    for (const [k, m] of Object.entries(liquidita.dati.modelli)) {
      if (!k.startsWith(pref)) continue;
      const r = liquidita.ricambioUtile(m);   // niente percentuale dove il rapporto non e' misurabile
      // `trasferimentiTotali` viaggia anche qui: i netti escludono le minivolture, cioe' il
      // passaggio al concessionario che poi rivende — sull'archivio ACI sono 2,4 milioni di
      // formalita' su 5,6, e sono proprio quelle del giro commerciale.
      modelli.push({ modello: m.modello, parco: m.parco, trasferimenti: m.trasferimenti,
                     trasferimentiTotali: m.trasferimentiTotali, ricambio: r });
    }
    res.set('Cache-Control', 'public, max-age=86400');
    // voce del modello cercato: la sola che sa dire "questo e' il dato del modello base, non
    // della variante" e che porta fonte e nota. Il frontend non deve reinventarle.
    const voce = modello ? liquidita.cerca(marca, modello, tipo) : null;
    res.json({ ok: true, marca, anno: liquidita.dati.anno, fonte: liquidita.dati.fonte, modelli, voce });
  });

  // ─── Passaggio di proprieta' del SINGOLO annuncio ────────────────────────────
  // Potenza e localita' sono gia' nell'annuncio: un operatore che guarda una macchina vuole
  // sapere li' quanto gli costa metterla a nome suo, non in un pannello a parte. La localita'
  // arriva in tre formati diversi secondo la fonte (sigla, provincia, comune) e va tradotta in
  // sigla, altrimenti l'IPT non e' calcolabile. Se la traduzione fallisce si dice perche':
  // meglio "non lo so" che un importo su una provincia indovinata.
  app.get('/api/passaggio', async (req, res) => {
    const { provincia, cap, cv, kw, tipo, ivaEsposta, storico, marca, modello } = req.query || {};
    const st = storico === '1';
    const loc = provSigla.risolvi(provincia, cap);
    if (!loc) return res.json({ ok: false, motivo: 'localita\' non riconosciuta: "' + String(provincia || '').slice(0, 40) + '"' });

    // Potenze fuori scala: un annuncio con "9999 CV" e' un errore di battitura del venditore,
    // non un veicolo. Meglio rifiutare che firmare un importo assurdo. Bande larghe di proposito
    // (esistono auto da 1.000+ CV): servono solo a fermare l'assurdo.
    const num = x => { const n = Number(x); return Number.isFinite(n) ? n : NaN; };
    const cvN = num(cv), kwN = num(kw);
    if (!Number.isNaN(kwN) && kwN !== 0 && !(kwN >= 1 && kwN <= 1500)) return res.json({ ok: false, provincia: loc.sigla, motivo: 'potenza fuori scala: ' + kwN + ' kW' });
    if (!Number.isNaN(cvN) && cvN !== 0 && !(cvN >= 1 && cvN <= 2000)) return res.json({ ok: false, provincia: loc.sigla, motivo: 'potenza fuori scala: ' + cvN + ' CV' });

    // kW dichiarati se ci sono, altrimenti stimati dai CV: la stima va detta, non nascosta.
    // Si arrotonda a un decimale PRIMA del calcolo: l'IPT si paga sui kW del libretto, che sono
    // un valore dichiarato — portarsi dietro 55,16240625 kW sarebbe finta precisione.
    // I kW DICHIARATI battono la stima: sopra e sotto i 53 kW la tariffa cambia categoria, e la
    // stima dai CV puo' far scavalcare la soglia a un'utilitaria (73 CV → 53,7 kW stimati, ma il
    // libretto puo' dire 53 → 49 € di differenza). Il listino li ha; se non li ha, si stima e si dice.
    let kwListino = null;
    // `tipo !== 'moto'`, simmetrico al guard sull'anno gia' dentro motornet: gli endpoint del
    // listino sono solo /nuovo/auto/, e per le moto il kW e' inutile in OGNI ramo di ipt.js
    // (non-storico: ok:false a prescindere; storico: importo fisso che i kW non li guarda).
    // Erano fino a 3 richieste con pause da 1,5 s — e un 403 mette la fonte in pausa 30 minuti.
    if (motornet.ATTIVO && tipo !== 'moto' && marca && modello && cvN >= 1) {
      // L'anno dell'annuncio arriva fin qui: su un'auto vecchia la richiesta al listino del
      // NUOVO non parte proprio (vedi motornet.js) e si va dritti alla stima dai CV, che e'
      // dichiarata. Prima si spendeva una richiesta a una fonte con un freno anti-raffica per
      // un modello che quel listino non ha piu'.
      try { kwListino = await motornet.kwDaCavalli(marca, modello, cvN, (req.query || {}).anno); }
      catch (e) { console.warn('[api/passaggio] motornet KO:', e.message); }
    }
    const kwDiretti = kwN >= 1 ? kwN : (kwListino ? kwListino.kw : null);
    const kwStimati = kwDiretti == null && cvN >= 1 ? Math.round(provSigla.kwDaCv(cvN) * 10) / 10 : null;
    const kW = kwDiretti != null ? kwDiretti : kwStimati;
    if (!(kW > 0) && !st) return res.json({ ok: false, provincia: loc.sigla, motivo: 'potenza non disponibile in questo annuncio' });

    const r = iptCalc.calcola({
      provincia: loc.sigla, kW: kW || 0, tipo: tipo === 'moto' ? 'moto' : 'auto',
      ivaEsposta: ivaEsposta === '1', storico: st,
    });
    r.localita = { testo: String(provincia || '').slice(0, 60), sigla: loc.sigla, via: loc.via };
    /**
     * LA STIMA SI DICHIARA. `potenzaStimata` viaggiava nella risposta e nessuno a schermo la
     * leggeva (rg su frontend/: zero): l'importo dell'IPT usciva identico a quello calcolato
     * su kW veri, mentre nasce da una conversione dai CV dichiarati — su 73 CV sono 53,7 kW
     * e ~49 euro di scarto sull'importo. `avvisi` e' il canale gia' montato a schermo
     * (passAvvisiHTML, ramo di successo compreso): la stima passa di li'.
     */
    if (kwStimati != null) {
      r.potenzaStimata = { cv: cvN, kw: kwStimati };
      r.avvisi = [`Potenza non dichiarata dall'annuncio: i ${kwStimati} kW sono STIMATI dai ${cvN} CV, e l'importo con loro.`,
        ...(r.avvisi || [])];
    }
    // `!(kwN >= 1)`, non `kwN < 1`: senza il parametro kw questo e' NaN, e NaN < 1 e' FALSO —
    // la provenienza non sarebbe mai uscita proprio nel caso per cui esiste. Stessa forma della
    // riga 564, che con NaN sceglie appunto i kW di listino.
    if (kwListino && !(kwN >= 1)) r.potenzaListino = { cv: cvN, kw: kwListino.kw, versioni: kwListino.versioni.slice(0, 3), fonte: kwListino.fonte, url: kwListino.url };
    // Cache solo sui successi: un "non calcolabile" dipende dai dati dell'annuncio, che possono
    // arrivare dopo (Moto.it arricchisce la potenza in un secondo momento).
    if (r.ok) res.set('Cache-Control', 'public, max-age=3600');
    res.json(r);
  });

  // ─── Prezzi carburante ufficiali per provincia (open data MIMIT, IODL 2.0) ────
  // Incrociati col consumo della scheda tecnica danno il costo reale al km dove vive
  // l'utente. L'indice è piccolo (107 province × 4 carburanti) → si serve tutto e il
  // client calcola: cambiare km/anno o provincia non richiede altre richieste.
  // La UI DEVE citare la fonte: è l'obbligo di attribuzione della licenza IODL 2.0.
  app.get('/api/carburanti', async (req, res) => {
    try {
      const idx = await carburanti.indice();
      if (!idx) return res.json({ ok: false, motivo: 'prezzi non disponibili' });
      res.set('Cache-Control', 'public, max-age=3600');
      res.json({ ok: true, aggiornato: idx.aggiornato, fonte: idx.fonte, italia: idx.italia, province: idx.province });
    } catch (e) {
      console.warn('[api/carburanti] KO:', e.message);
      res.json({ ok: false, motivo: 'prezzi non disponibili' });
    }
  });
}

module.exports = { mount };
