'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { renderReportPdf } = require('./report-pdf');
const { crea } = require('./limite-richieste');

function reportsFile() {
  const ud = process.env.USER_DATA_PATH;
  return (ud && fs.existsSync(ud)) ? path.join(ud, 'reports.jsonl') : path.join(__dirname, '..', 'data', 'reports.jsonl');
}

function mount(app, deps = {}) {
  const chiaveLimite = deps.chiaveLimite || (req => req.authId || req.ip || '');
  const limiteReport = deps.limiteReport || crea({ max: 5, finestra: 10 * 60 * 1000, cosa: 'segnalazioni' });
  const limitePdf = deps.limitePdf || crea({ max: 10, cosa: 'esportazioni PDF' });
  const rendiPdf = deps.renderReportPdf || renderReportPdf;

  // Le segnalazioni sono disponibili anche agli utenti demo. Il contenuto non torna nella risposta.
  app.post('/api/report', express.json({ limit: '32kb' }), (req, res) => {
    const gRep = limiteReport.consuma(chiaveLimite(req));
    if (!gRep.ok) return res.status(429).json({ error: limiteReport.messaggio(gRep), riprovaFra: gRep.attesa, restanti: 0 });
    const b = req.body || {};
    const type = b.type === 'search' ? 'search' : 'bug';
    const message = String(b.message == null ? '' : b.message).slice(0, 2000).trim();
    if (!message) return res.status(400).json({ error: 'messaggio obbligatorio' });
    const rec = {
      ts: new Date().toISOString(), type, message,
      searchParams: (b.searchParams && typeof b.searchParams === 'object') ? b.searchParams : null,
      count: Number.isFinite(b.count) ? b.count : null,
      role: req.authRole || 'full',
    };
    try {
      fs.appendFileSync(reportsFile(), JSON.stringify(rec) + '\n');
      res.json({ ok: true });
    } catch (e) {
      console.error('[report]', e.message);
      res.status(500).json({ error: 'Impossibile salvare la segnalazione' });
    }
  });

  // I prezzi finali arrivano già composti dal browser; qui si impagina soltanto il documento.
  app.post('/api/report-pdf', express.json({ limit: '4mb' }), (req, res) => {
    const gPdf = limitePdf.consuma(chiaveLimite(req));
    if (!gPdf.ok) return res.status(429).json({ error: limitePdf.messaggio(gPdf), riprovaFra: gPdf.attesa, restanti: 0 });
    const b = req.body || {};
    const righe = Array.isArray(b.righe) ? b.righe : [];
    if (righe.length > 2000) return res.status(400).json({ error: 'Il PDF può contenere al massimo 2.000 annunci. Riduci la selezione oppure esporta tutti gli annunci in CSV.' });
    if (!righe.length) return res.status(400).json({ error: 'niente da stampare' });
    // Il rendering è sincrono: non accettiamo testo arbitrariamente lungo negli avvisi.
    if (b.avvisi != null && (!Array.isArray(b.avvisi) || b.avvisi.length > 10
        || b.avvisi.some(a => typeof a !== 'string') || b.avvisi.join('').length > 4000)) {
      return res.status(400).json({ error: 'Avvisi PDF non validi: massimo 10 avvisi e 4.000 caratteri complessivi.' });
    }
    try {
      const buf = rendiPdf([], b.params || {}, {
        titolo: b.titolo || null, sottotitolo: b.sottotitolo || null,
        avvisi: b.avvisi || [], contatore: b.contatore || null,
        colonne: Array.isArray(b.colonne) ? b.colonne : null,
        righe, fonti: Array.isArray(b.fonti) ? b.fonti : [],
        colonneStile: (b.colonneStile && typeof b.colonneStile === 'object') ? b.colonneStile : null,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${String(b.nome || 'automotoradar.pdf').replace(/[^\w.-]/g, '')}"`);
      res.send(buf);
    } catch (e) {
      console.error('[report-pdf]', e.message);
      res.status(500).json({ error: 'PDF non generato' });
    }
  });
}

module.exports = { mount };
