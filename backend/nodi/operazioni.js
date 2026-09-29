'use strict';

const { parseSearchParams } = require('../ricerca-parametri');
const { runSearch } = require('../ricerca-coordinatore');
const salute = require('../fonti-salute');
const { componiRicerca } = require('./componi-ricerca');

function handlerDi(modulo, rotta, opzioni) {
  const rotte = new Map();
  modulo.mount({ get: (percorso, handler) => rotte.set(percorso, handler) }, opzioni);
  return rotte.get(rotta);
}

const menu = new Map();
const appMenu = { get: (percorso, handler) => menu.set(percorso, handler) };
require('../menu-ricerca-route').mount(appMenu);
const dettaglio = handlerDi(require('../dettaglio-route'), '/api/detail', { chiaveLimite: () => 'nodo-locale' });

function chiama(handler, query) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(n) { this.statusCode = n; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve().then(() => handler({ query }, res)).catch(reject);
  });
}

async function esegui(lavoro) {
  const { operazione, input } = lavoro;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input non valido');
  if (operazione === 'componi') {
    return { status: 200, body: componiRicerca(input.principale, input.sostituzioni) };
  }
  if (operazione === 'ricerca' || operazione === 'fonte') {
    const query = { ...input };
    if (operazione === 'fonte') {
      if (!['subito', 'autoscout', 'moto'].includes(lavoro.fonte)) throw new Error('fonte non valida');
      query.fetta = String(query.fetta ?? 0);
      query.fonti = lavoro.fonte;
    }
    const parsed = parseSearchParams(query);
    if (parsed.errors) return { status: 400, body: { error: parsed.errors.join(', ') } };
    parsed.params._cacheScope = lavoro.azienda;
    return { status: 200, body: await runSearch(parsed.params) };
  }
  if (operazione === 'modelli' || operazione === 'marche' || operazione === 'versioni') {
    return chiama(menu.get('/api/' + (operazione === 'marche' ? 'brands' : operazione === 'modelli' ? 'models' : 'versioni')), input);
  }
  if (operazione === 'dettaglio') return chiama(dettaglio, input);
  throw new Error('operazione non valida');
}

function statoFonti() {
  return Object.fromEntries(['subito', 'autoscout', 'moto'].map(f => [f, salute.fermo(f)]));
}

module.exports = { esegui, statoFonti };
