'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const { parseSearchParams } = require('../backend/ricerca-parametri');
const browserPath = process.env.AMR_TEST_CHROMIUM || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const opzioniBrowser = { skip: !fs.existsSync(browserPath) && 'Chromium non disponibile' };

async function attendiRichieste(lista, numero) {
  const termine = Date.now() + 5000;
  while (lista.length < numero && Date.now() < termine) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lista.length, numero, 'Richieste sintetiche ricevute');
}

async function apriPrototipo(t, api, http) {
  const server = require('node:http').createServer((req, res) => {
    if (http?.(req, res)) return;
    const files = { '/': 'backend/nodi/prototipo.html', '/prototipo.js': 'frontend/nodi-prototipo.js',
      '/prototipo.css': 'frontend/nodi-prototipo.css', '/api/auth/bootstrap.js': 'frontend/nodi-bootstrap-prova.js' };
    const file = files[req.url];
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript'
      : req.url.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(__dirname, '..', file)));
  }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const originale = window.setInterval;
    window.setInterval = (fn, ms, ...args) => {
      if (ms === 3000) { window.pollDiagnosticaProva = fn; return 0; }
      return originale(fn, ms, ...args);
    };
  });
  const origine = 'http://127.0.0.1:' + server.address().port;
  const ricerche = new Map();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origine) return route.abort();
    if (!url.pathname.startsWith('/api/') || url.pathname === '/api/auth/bootstrap.js') return route.continue();
    if (url.pathname === '/api/ricerche' && route.request().method() === 'POST') {
      const { id, input } = route.request().postDataJSON();
      assert.equal(parseSearchParams(input).errors, undefined, 'Filtri inviati nel POST validi');
      assert.equal(ricerche.has(id), false, 'La UI non deve ripetere il POST');
      const record = { id, stato: 'in_corso' }; ricerche.set(id, record);
      await route.fulfill({ status: 202, json: record });
      // Le fixture esistenti descrivono il risultato della ricerca; lo
      // restituiamo nel nuovo involucro senza simulare una connessione lunga.
      const query = new URL('/api/search?' + new URLSearchParams(input), origine);
      const esito = { fulfill: async ({ status = 200, json }) => {
        if (record.stato === 'abbandonata') return;
        record.stato = status === 200 ? 'conclusa' : 'errore'; record.esito = { status, body: json };
      } };
      assert.equal(await api?.(esito, query), true, 'Fixture ricerca mancante');
      return;
    }
    if (url.pathname.startsWith('/api/ricerche/')) {
      const record = ricerche.get(url.pathname.split('/').pop());
      assert.ok(record, 'ID di ricerca inatteso');
      if (route.request().method() === 'DELETE') { record.stato = 'abbandonata'; delete record.esito; }
      return route.fulfill({ json: record });
    }
    if (url.pathname === '/api/search') assert.equal(parseSearchParams(Object.fromEntries(url.searchParams)).errors,
      undefined, 'La query della UI deve rispettare il contratto backend');
    if (await api?.(route, url)) return;
    const risposte = {
      '/api/test/config': { accesso: 'sintetico' }, '/api/stato': { nodi: [] },
      '/api/admin': { nodi: [], lavori: [], eventi: [], pagina: 1, pagine: 1, totale: 0 },
    };
    if (url.pathname === '/api/test/me') return route.fulfill({ status: 401, json: {} });
    assert.ok(Object.hasOwn(risposte, url.pathname), 'API inattesa: ' + url.pathname);
    await route.fulfill({ json: risposte[url.pathname] });
  });
  await page.goto(origine);
  await page.waitForFunction(() => document.getElementById('aggiornato').textContent.startsWith('Aggiornato alle'));
  return { page, errors };
}

const filtriProva = { regioni: ['lazio', 'lombardia'], filtriAuto: [{ nome: 'carburante',
  etichetta: 'Carburante', voci: [{ id: 'benzina', etichetta: 'Benzina' }, { id: 'diesel', etichetta: 'Diesel' }] }] };
async function apriCataloghiProva(t, api, http) {
  const pagina = await apriPrototipo(t, async (route, url) => {
    if (await api?.(route, url)) return true;
    const risposte = {
      '/api/brands': { brands: [{ nome: url.searchParams.get('tipo') === 'auto' ? 'Fiat' : 'Yamaha' }] },
      '/api/filtri': filtriProva, '/api/models': { modelli: [{ nome: 'Panda' }] },
      '/api/versioni': { versioni: ['Versione di prova'] },
      '/api/search': { risultati: [], sources: { subito: { status: 'empty', hasMore: false } } },
    };
    if (!Object.hasOwn(risposte, url.pathname)) return false;
    await route.fulfill({ json: risposte[url.pathname] }); return true;
  }, http);
  await pagina.page.locator('.area-nav a[href="#ricercaPanel"]').click();
  return pagina;
}

function accessoCookieProva({ iniziale = false, meInAttesa = false } = {}) {
  const login = [], me = [], aziende = {
    aziendaA: { azienda: 'aziendaA', moduli: ['auto', 'moto'] },
    aziendaB: { azienda: 'aziendaB', moduli: ['moto'] },
  }, cookie = { aziendaA: 'a'.repeat(64), aziendaB: 'b'.repeat(64) };
  const intestazione = azienda => `amr_prova=${cookie[azienda]}; HttpOnly; SameSite=Strict; Path=/`;
  function rispondi(res, status, data, azienda) {
    if (azienda) res.setHeader('set-cookie', intestazione(azienda));
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  }
  return { login, me, cookie,
    api: async (route, url) => {
      if (!['/api/test/login', '/api/test/me'].includes(url.pathname)) return false;
      await route.continue(); return true;
    },
    http: (req, res) => {
      if (req.url === '/' && iniziale) res.setHeader('set-cookie', intestazione('aziendaA'));
      if (req.url === '/api/test/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => login.push({ res, azienda: JSON.parse(body).azienda, cookie: req.headers.cookie }));
        return true;
      }
      if (req.url !== '/api/test/me') return false;
      const token = /(?:^|;\s*)amr_prova=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      const azienda = Object.keys(cookie).find(nome => cookie[nome] === token);
      const risposta = { res, status: azienda ? 200 : 401, data: aziende[azienda] || {} };
      if (meInAttesa) me.push(risposta);
      else rispondi(res, risposta.status, risposta.data);
      return true;
    },
    concludiLogin: (indice, status = 200) => {
      const richiesta = login[indice];
      rispondi(richiesta.res, status, status === 200 ? aziende[richiesta.azienda] : {},
        status === 200 ? richiesta.azienda : undefined);
    },
    concludiMe: indice => {
      meInAttesa = false;
      const risposta = me[indice]; rispondi(risposta.res, risposta.status, risposta.data);
    },
  };
}

async function verificaSessioneCookie(page, fixture, azienda) {
  const cookie = (await page.context().cookies()).find(c => c.name === 'amr_prova');
  assert.equal(cookie?.value, fixture.cookie[azienda]);
  assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict');
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/test/me')).json()).azienda), azienda);
}

for (const fase of ['brands', 'filtri']) for (const status of [200, 503])
test(`F3: ${fase} tardivo (${status}) non riscrive filtri, avvisi o diagnostica di B`, opzioniBrowser, async t => {
  const pendenti = []; let trattieni = true, filtri = 0, stati = 0;
  const { page, errors } = await apriCataloghiProva(t, async (route, url) => {
    if (url.pathname === '/api/filtri') filtri++;
    if (url.pathname === '/api/stato') stati++;
    if (url.pathname === '/api/' + fase && trattieni) { pendenti.push(route); return true; }
    return false;
  });
  await page.evaluate(() => { window.identitaA = applicaIdentita({ azienda: 'aziendaA', moduli: ['auto', 'moto'] }); });
  await attendiRichieste(pendenti, 1); trattieni = false;
  await page.evaluate(() => applicaIdentita({ azienda: 'aziendaB', moduli: ['auto', 'moto'] }));
  await page.locator('.advanced > summary').click();
  await page.locator('#regione').selectOption('lombardia');
  await page.locator('#filtriAuto select').selectOption('diesel');
  await page.evaluate(() => messaggio('Avviso corrente'));
  const prima = { filtri, stati };
  await pendenti.pop().fulfill({ status, json: fase === 'filtri' ? filtriProva : { brands: [{ nome: 'Fiat' }] } });
  await page.evaluate(() => window.identitaA);
  assert.equal(await page.locator('#regione').inputValue(), 'lombardia');
  assert.equal(await page.locator('#filtriAuto select').inputValue(), 'diesel');
  assert.equal(await page.locator('#formErrore').textContent(), 'Avviso corrente');
  assert.equal(await page.locator('#identita').textContent(), 'aziendaB · auto + moto');
  assert.deepEqual({ filtri, stati }, prima, 'Nessun caricamento successivo del contesto A');
  assert.deepEqual(errors, []);
});

for (const fase of ['brands', 'filtri']) for (const status of [200, 503])
test(`F3: reset durante ${fase} (${status}) blocca tutte le continuazioni dell’identità`, opzioniBrowser, async t => {
  const pendenti = []; let filtri = 0, stati = 0;
  const { page, errors } = await apriCataloghiProva(t, async (route, url) => {
    if (url.pathname === '/api/filtri') filtri++;
    if (url.pathname === '/api/stato') stati++;
    if (url.pathname === '/api/' + fase) { pendenti.push(route); return true; }
    return false;
  });
  await page.evaluate(() => { window.identitaA = applicaIdentita({ azienda: 'aziendaA', moduli: ['auto', 'moto'] }); });
  await attendiRichieste(pendenti, 1);
  await page.evaluate(() => terminaContesto());
  const prima = { filtri, stati };
  await pendenti.pop().fulfill({ status, json: fase === 'filtri' ? filtriProva : { brands: [{ nome: 'Fiat' }] } });
  await page.evaluate(() => window.identitaA);
  assert.equal(await page.locator('#cerca').isVisible(), false);
  assert.equal(await page.locator('#regione option').count(), 1);
  assert.equal(await page.locator('#filtriAuto select').count(), 0);
  assert.equal(await page.locator('#formErrore').textContent(), '');
  assert.deepEqual({ filtri, stati }, prima);
  assert.deepEqual(errors, []);
});

test('F3: risposta corrente conserva scelte fatte durante l’attesa e resta valida dopo una ricerca', opzioniBrowser, async t => {
  const pendenti = []; let trattieni = false;
  const { page, errors } = await apriCataloghiProva(t, async (route, url) => {
    if (url.pathname === '/api/filtri' && trattieni) { pendenti.push(route); return true; }
    return false;
  });
  await page.evaluate(() => applicaIdentita({ azienda: 'aziendaA', moduli: ['auto', 'moto'] }));
  await page.locator('.advanced > summary').click();
  await page.locator('#regione').selectOption('lazio');
  await page.locator('#filtriAuto select').selectOption('benzina');
  trattieni = true;
  await page.evaluate(() => { window.filtriInAttesa = caricaFiltri(); });
  await attendiRichieste(pendenti, 1);
  await page.locator('#regione').selectOption('lombardia');
  await page.locator('#filtriAuto select').selectOption('diesel');
  await page.evaluate(() => inviaRicerca(new URLSearchParams({ tipo: 'auto', marca: 'Fiat' })));
  await page.locator('#filtriAuto select').focus();
  await page.evaluate(() => { window.selectCorrente = document.activeElement; });
  await pendenti.pop().fulfill({ json: filtriProva });
  await page.evaluate(() => window.filtriInAttesa);
  assert.equal(await page.locator('#regione').inputValue(), 'lombardia');
  assert.equal(await page.locator('#filtriAuto select').inputValue(), 'diesel');
  assert.equal(await page.evaluate(() => document.activeElement === window.selectCorrente), true);
  // Un catalogo realmente cambiato deve ancora essere applicato, conservando i valori validi.
  await page.evaluate(() => { window.filtriInAttesa = caricaFiltri(); });
  await attendiRichieste(pendenti, 1);
  await pendenti.pop().fulfill({ json: { ...filtriProva, regioni: [...filtriProva.regioni, 'veneto'],
    filtriAuto: [{ ...filtriProva.filtriAuto[0], voci: [...filtriProva.filtriAuto[0].voci, { id: 'gpl', etichetta: 'GPL' }] }] } });
  await page.evaluate(() => window.filtriInAttesa);
  assert.equal(await page.locator('#regione').inputValue(), 'lombardia');
  assert.equal(await page.locator('#filtriAuto select').inputValue(), 'diesel');
  assert.equal(await page.locator('#filtriAuto option[value=gpl]').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement.name), 'carburante');
  assert.deepEqual(errors, []);
});

test('F3: cambio tipo durante le marche conserva il primo caricamento dei filtri condivisi', opzioniBrowser, async t => {
  const pendenti = []; let filtri = 0;
  const { page, errors } = await apriCataloghiProva(t, async (route, url) => {
    if (url.pathname === '/api/filtri') filtri++;
    if (url.pathname === '/api/brands' && url.searchParams.get('tipo') === 'auto') { pendenti.push(route); return true; }
    return false;
  });
  await page.evaluate(() => { window.identitaA = applicaIdentita({ azienda: 'aziendaA', moduli: ['auto', 'moto'] }); });
  await attendiRichieste(pendenti, 1);
  await page.locator('[name=tipo][value=moto]').check();
  await page.waitForFunction(() => document.getElementById('marche').textContent === ''
    && document.getElementById('marche').firstChild?.value === 'Yamaha');
  await pendenti.pop().fulfill({ json: { brands: [{ nome: 'Fiat' }] } });
  await page.evaluate(() => window.identitaA);
  assert.equal(filtri, 1);
  assert.equal(await page.locator('#regione option').count(), 3);
  assert.equal(await page.locator('#filtriAuto select').count(), 1);
  assert.equal(await page.locator('#filtriAuto').isVisible(), false);
  assert.equal(await page.locator('#marche option').first().getAttribute('value'), 'Yamaha');
  assert.deepEqual(errors, []);
});

for (const fase of ['brands', 'models', 'versioni']) for (const cambio of ['tipo', 'reset'])
test(`F3: scenario superato durante ${fase} non riparte dopo ${cambio}`, opzioniBrowser, async t => {
  const pendenti = []; let trattieni = false, modelli = 0, versioni = 0;
  const { page, errors } = await apriCataloghiProva(t, async (route, url) => {
    if (url.pathname === '/api/models') modelli++;
    if (url.pathname === '/api/versioni') versioni++;
    if (url.pathname === '/api/' + fase && trattieni) { pendenti.push(route); return true; }
    return false;
  });
  await page.evaluate(() => applicaIdentita({ azienda: 'aziendaA', moduli: ['auto', 'moto'] }));
  if (fase === 'brands') await page.evaluate(() => { cataloghi.auto = null; });
  trattieni = true; await page.locator('[data-scenario=auto]').click();
  await attendiRichieste(pendenti, 1); trattieni = false;
  if (cambio === 'tipo') {
    await page.locator('[name=tipo][value=moto]').check();
    await page.locator('[name=tipo][value=auto]').check();
    await page.waitForFunction(() => document.getElementById('marche').firstChild?.value === 'Fiat');
  } else await page.evaluate(() => terminaContesto());
  await page.evaluate(() => {
    $('marca').value = 'Scelta corrente'; $('modello').value = 'Modello corrente'; $('versione').value = 'Versione corrente';
  });
  const prima = { modelli, versioni };
  await pendenti.pop().fulfill({ json: fase === 'brands' ? { brands: [{ nome: 'Fiat' }] }
    : fase === 'models' ? { modelli: [{ nome: 'Panda' }] } : { versioni: ['Versione di prova'] } });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#marca').inputValue(), 'Scelta corrente');
  assert.equal(await page.locator('#modello').inputValue(), 'Modello corrente');
  assert.equal(await page.locator('#versione').inputValue(), 'Versione corrente');
  assert.deepEqual({ modelli, versioni }, prima);
  assert.deepEqual(errors, []);
});

test('F3: scenario corrente completa la sequenza originale, senza richieste aggiuntive', opzioniBrowser, async t => {
  let modelli = 0, versioni = 0;
  const { page, errors } = await apriCataloghiProva(t, async (route, url) => {
    if (url.pathname === '/api/models') modelli++;
    if (url.pathname === '/api/versioni') versioni++;
    return false;
  });
  await page.evaluate(() => applicaIdentita({ azienda: 'aziendaA', moduli: ['auto', 'moto'] }));
  await page.locator('[data-scenario=auto]').click();
  await page.waitForFunction(() => $('versione').value === 'Nessuna Versione');
  assert.equal(await page.locator('#marca').inputValue(), 'Fiat');
  assert.equal(await page.locator('#modello').inputValue(), 'Panda');
  assert.deepEqual({ modelli, versioni }, { modelli: 1, versioni: 1 });
  assert.deepEqual(errors, []);
});

test('F3: errore filtri corrente resta visibile e il caricamento successivo resta possibile', opzioniBrowser, async t => {
  let guasto = true;
  const { page, errors } = await apriCataloghiProva(t, async (route, url) => {
    if (url.pathname === '/api/filtri' && guasto) { await route.fulfill({ status: 503, json: {} }); return true; }
    return false;
  });
  await page.evaluate(() => applicaIdentita({ azienda: 'aziendaA', moduli: ['auto', 'moto'] }));
  assert.match(await page.locator('#formErrore').textContent(), /Filtri avanzati non disponibili/);
  guasto = false;
  await page.evaluate(() => caricaFiltri());
  assert.equal(await page.locator('#regione option').count(), 3);
  assert.equal(await page.locator('#filtriAuto select').count(), 1);
  assert.deepEqual(errors, []);
});

test('F3: login sintetico seriale mantiene UI e cookie HTTP coerenti e permette il login successivo', opzioniBrowser, async t => {
  const fixture = accessoCookieProva();
  const { page, errors } = await apriCataloghiProva(t, fixture.api, fixture.http);
  await page.locator('#entra').click(); await attendiRichieste(fixture.login, 1);
  assert.equal(await page.locator('#entra').isDisabled(), true);
  await page.locator('#azienda').selectOption('aziendaB');
  await page.evaluate(() => $('entra').dispatchEvent(new MouseEvent('click')));
  fixture.concludiLogin(0);
  await page.waitForFunction(() => $('regione').options.length === 3);
  await page.waitForFunction(() => !$('entra').disabled);
  assert.equal(fixture.login.length, 1, 'Il guard blocca anche click sintetici sul bottone disabilitato');
  assert.equal(await page.locator('#identita').textContent(), 'aziendaA · auto + moto');
  await verificaSessioneCookie(page, fixture, 'aziendaA');
  await page.locator('#entra').click(); await attendiRichieste(fixture.login, 2);
  assert.match(fixture.login[1].cookie, new RegExp('amr_prova=' + fixture.cookie.aziendaA));
  fixture.concludiLogin(1);
  await page.waitForFunction(() => !$('entra').disabled);
  assert.equal(await page.locator('#identita').textContent(), 'aziendaB · moto');
  assert.equal(await page.locator('[name=tipo][value=moto]').isChecked(), true);
  await verificaSessioneCookie(page, fixture, 'aziendaB');
  assert.deepEqual(errors, []);
});

test('F3: login fallito conserva il caricamento dei cataloghi della sessione corrente', opzioniBrowser, async t => {
  const pendenti = [];
  const { page, errors } = await apriCataloghiProva(t, async (route, url) => {
    if (url.pathname === '/api/brands') { pendenti.push(route); return true; }
    if (url.pathname === '/api/test/login') { await route.fulfill({ status: 503, json: {} }); return true; }
    return false;
  });
  await page.evaluate(() => { window.identitaA = applicaIdentita({ azienda: 'aziendaA', moduli: ['auto', 'moto'] }); });
  await attendiRichieste(pendenti, 1);
  await page.locator('#entra').click();
  await page.waitForFunction(() => $('identita').textContent.includes('Servizio non disponibile'));
  await pendenti.pop().fulfill({ json: { brands: [{ nome: 'Fiat' }] } });
  await page.evaluate(() => window.identitaA);
  assert.equal(await page.locator('#cerca').isVisible(), true);
  assert.equal(await page.locator('#regione option').count(), 3);
  assert.equal(await page.locator('#marche option').first().getAttribute('value'), 'Fiat');
  assert.deepEqual(errors, []);
});

for (const mePrima of [false, true])
test(`F3: bootstrap valido riprende dopo login fallito con me ${mePrima ? 'prima' : 'dopo'} il fallimento`, opzioniBrowser, async t => {
  const fixture = accessoCookieProva({ iniziale: true, meInAttesa: true });
  const { page, errors } = await apriCataloghiProva(t, fixture.api, fixture.http);
  await attendiRichieste(fixture.me, 1);
  await page.locator('#azienda').selectOption('aziendaB'); await page.locator('#entra').click();
  await attendiRichieste(fixture.login, 1);
  if (mePrima) {
    fixture.concludiMe(0);
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#cerca').isVisible(), false);
  }
  fixture.concludiLogin(0, 503);
  await page.waitForFunction(() => !$('entra').disabled);
  if (!mePrima) fixture.concludiMe(0);
  await page.waitForFunction(() => $('regione').options.length === 3);
  assert.equal(await page.locator('#cerca').isVisible(), true);
  assert.equal(await page.locator('#identita').textContent(), 'aziendaA · auto + moto');
  assert.equal(await page.locator('#azienda').inputValue(), 'aziendaA');
  await verificaSessioneCookie(page, fixture, 'aziendaA');
  assert.deepEqual(errors, []);
});

for (const reset of [false, true])
test(`F3: bootstrap in attesa non supera ${reset ? 'reset' : 'login riuscito'} con cookie HTTP reale`, opzioniBrowser, async t => {
  const fixture = accessoCookieProva({ iniziale: true, meInAttesa: true });
  const { page, errors } = await apriCataloghiProva(t, fixture.api, fixture.http);
  await attendiRichieste(fixture.me, 1);
  await page.locator('#azienda').selectOption('aziendaB'); await page.locator('#entra').click();
  await attendiRichieste(fixture.login, 1);
  fixture.concludiMe(0);
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#cerca').isVisible(), false);
  if (reset) await page.evaluate(() => terminaContesto());
  fixture.concludiLogin(0);
  await page.waitForFunction(() => !$('entra').disabled);
  assert.equal(await page.locator('#cerca').isVisible(), !reset);
  assert.equal(await page.locator('#identita').textContent(), reset
    ? 'Accedi con il tuo account locale.' : 'aziendaB · moto');
  assert.equal(await page.locator('#azienda').inputValue(), 'aziendaB');
  await verificaSessioneCookie(page, fixture, 'aziendaB');
  assert.deepEqual(errors, []);
});

for (const superata of [false, true])
test(`F3: errore configurazione ${superata ? 'superato è ignorato' : 'corrente è visibile'}`, opzioniBrowser, async t => {
  const pendenti = []; let trattieni = false;
  const { page, errors } = await apriCataloghiProva(t, async (route, url) => {
    if (url.pathname === '/api/test/config' && trattieni) { pendenti.push(route); return true; }
    return false;
  });
  trattieni = true; await page.reload(); await attendiRichieste(pendenti, 1);
  if (superata) await page.evaluate(() => applicaIdentita({ azienda: 'aziendaB', moduli: ['moto'] }));
  await pendenti.pop().fulfill({ status: 503, json: {} });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#identita').textContent(), superata
    ? 'aziendaB · moto' : 'Configurazione accessi non disponibile.');
  assert.deepEqual(errors, []);
});

for (const endpoint of ['login', 'me']) for (const status of [200, 503])
test(`F3: ${endpoint} sintetico tardivo (${status}) non sostituisce identità o errore correnti`, opzioniBrowser, async t => {
  const pendenti = [];
  const { page, errors } = await apriCataloghiProva(t, async (route, url) => {
    if (url.pathname === '/api/test/' + endpoint) { pendenti.push(route); return true; }
    return false;
  });
  if (endpoint === 'login') await page.locator('#entra').click();
  await attendiRichieste(pendenti, 1);
  await page.evaluate(() => applicaIdentita({ azienda: 'aziendaB', moduli: ['moto'] }));
  await page.locator('#azienda').selectOption('aziendaB');
  await page.evaluate(() => { $('identita').textContent = 'Identità corrente'; });
  await pendenti.pop().fulfill({ status, json: { azienda: 'aziendaA', moduli: ['auto', 'moto'] } });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#identita').textContent(), 'Identità corrente');
  assert.equal(await page.locator('#azienda').inputValue(), 'aziendaB');
  assert.equal(await page.locator('[name=tipo][value=auto]').isEnabled(), false);
  assert.deepEqual(errors, []);
});

for (const fallisce of [false, true])
test(`F3: account superato durante lo stato (${fallisce ? 'errore' : 'successo'}) non cambia aree o messaggi`, opzioniBrowser, async t => {
  const { page, errors } = await apriCataloghiProva(t);
  await page.evaluate(() => {
    window.areeAggiornate = 0;
    const originale = aggiornaAree;
    aggiornaAree = (...args) => { window.areeAggiornate++; return originale(...args); };
    aggiornaStato = () => new Promise((resolve, reject) => { window.liberaStato = resolve; window.fallisciStato = reject; });
    document.dispatchEvent(new CustomEvent('amr:account', { detail: {
      azienda: 'aziendaA', aziendaValida: true, moduli: ['auto', 'moto'] } }));
  });
  await page.waitForFunction(() => Boolean(window.liberaStato));
  const prima = await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('amr:account', { detail: { azienda: 'aziendaB', aziendaValida: false } }));
    return { testo: $('identita').textContent, aree: window.areeAggiornate };
  });
  await page.evaluate(errore => { if (errore) window.fallisciStato(new Error('Guasto superato')); else window.liberaStato(); }, fallisce);
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => ({ testo: $('identita').textContent, aree: window.areeAggiornate })), prima);
  assert.deepEqual(errors, []);
});

for (const perdita of ['rete', '502'])
test(`ricerca breve UI: POST perso (${perdita}) e GET transitorio non ripetono avvio, filtri né pagina`, opzioniBrowser, async t => {
  const { page, errors } = await apriPrototipo(t);
  let inizi = 0, letture = 0, id;
  const input = { tipo: 'moto', marca: 'BMW', modello: 'R 1200 GS Adventure', versione: '',
    fetta: '2', fonti: 'subito', subitoMainStart: '-1', subitoRecuperoStart: '50' };
  await page.route('**/api/ricerche', async route => {
    inizi++; const body = route.request().postDataJSON(); id = body.id;
    assert.deepEqual(body.input, input);
    if (perdita === 'rete') await route.abort('failed');
    else await route.fulfill({ status: 502, json: {} });
  });
  await page.route('**/api/ricerche/*', async route => {
    assert.equal(new URL(route.request().url()).pathname, '/api/ricerche/' + id);
    assert.equal(route.request().method(), 'GET'); letture++;
    await route.fulfill(letture === 1 ? { status: 503, json: {} } : { json: {
      id, stato: 'conclusa', esito: { status: 200, body: { risultati: [], sources: { subito: { status: 'empty' } } } } } });
  });
  const data = await page.evaluate(input => consultaRicerca(new URLSearchParams(input)), input);
  assert.equal(data.sources.subito.status, 'empty'); assert.equal(inizi, 1); assert.equal(letture, 2);
  assert.deepEqual(errors, []);
});

test('ricerca breve UI: ID perso al restart ferma la consultazione, nessun POST automatico', opzioniBrowser, async t => {
  const { page, errors } = await apriPrototipo(t); let inizi = 0, letture = 0;
  await page.route('**/api/ricerche', async route => { inizi++; await route.abort('failed'); });
  await page.route('**/api/ricerche/*', async route => { letture++; await route.fulfill({ status: 404, json: {} }); });
  const messaggio = await page.evaluate(async () => {
    try { await consultaRicerca(new URLSearchParams({ tipo: 'moto', marca: 'Yamaha' })); }
    catch (e) { return e.message; }
  });
  assert.match(messaggio, /Nessuna ricerca è stata ripetuta/); assert.equal(inizi, 1); assert.equal(letture, 1);
  assert.deepEqual(errors, []);
});

test('ricerca breve UI: cambio contesto invia DELETE e blocca la consegna precedente', opzioniBrowser, async t => {
  const { page, errors } = await apriPrototipo(t); let cancellazioni = 0, pendente;
  await page.route('**/api/ricerche', async route => {
    await route.fulfill({ status: 202, json: { id: route.request().postDataJSON().id, stato: 'in_corso' } });
  });
  await page.route('**/api/ricerche/*', async route => {
    if (route.request().method() === 'DELETE') { cancellazioni++; await route.fulfill({ json: { stato: 'abbandonata' } }); }
    else pendente = route;
  });
  await page.evaluate(() => { window.ricercaProva = inviaRicerca(new URLSearchParams({ tipo: 'moto', marca: 'BMW' })); });
  for (let i = 0; i < 100 && !pendente; i++) await page.waitForTimeout(10);
  assert.ok(pendente); await page.evaluate(() => terminaContesto());
  await pendente.fulfill({ json: { stato: 'conclusa', esito: { status: 200, body: {
    risultati: [{ titolo: 'Annuncio precedente', fonte: 'subito' }], sources: { subito: { status: 'ok' } } } } } });
  await page.evaluate(() => window.ricercaProva);
  await page.waitForTimeout(50);
  assert.equal(cancellazioni, 1); assert.equal(await page.locator('#risultati').textContent(), '');
  assert.deepEqual(errors, []);
});

test('ricerca breve UI: interruzione certa e timeout incerto hanno avvisi distinti e nessun annuncio', opzioniBrowser, async t => {
  let incerto = false;
  const { page, errors } = await apriPrototipo(t, async (route, url) => {
    if (url.pathname !== '/api/search') return false;
    await route.fulfill({ status: 504, json: { codice: 'ricerca_scaduta', interrotto: !incerto, incerto } });
    return true;
  });
  await page.evaluate(() => inviaRicerca(new URLSearchParams({ tipo: 'moto', marca: 'Yamaha' })));
  assert.match(await page.locator('#avvisi').textContent(), /Ricerca interrotta/);
  assert.doesNotMatch(await page.locator('#avvisi').textContent(), /Esito incerto/);
  incerto = true;
  await page.evaluate(() => inviaRicerca(new URLSearchParams({ tipo: 'moto', marca: 'Yamaha' })));
  assert.match(await page.locator('#avvisi').textContent(), /Esito incerto/);
  assert.equal(await page.locator('#risultati').textContent(), ''); assert.deepEqual(errors, []);
});

test('ricerca breve UI: 401/403/404/410 testuali non perdono lo status né proseguono il polling', opzioniBrowser, async t => {
  const { page, errors } = await apriPrototipo(t); let status = 401, letture = 0;
  await page.route('**/api/ricerche', route => route.fulfill({ status: 202, json: { stato: 'in_corso' } }));
  await page.route('**/api/ricerche/*', async route => {
    if (++letture === 1) await route.fulfill({ status, contentType: 'text/plain', body: 'Errore sintetico' });
    else await route.fulfill({ json: { stato: 'conclusa', esito: { status: 200, body: { risultati: [] } } } });
  });
  for (status of [401, 403, 404, 410]) {
    letture = 0;
    const esito = await page.evaluate(async () => {
      try { await consultaRicerca(new URLSearchParams({ tipo: 'moto', marca: 'Yamaha' })); return 'nessun errore'; }
      catch (e) { return e.message; }
    });
    assert.equal(letture, 1, 'HTTP ' + status + ' non è transitorio');
    assert.match(esito, status < 404 ? /Accesso interrotto/ : /Esito non più disponibile/);
  }
  assert.deepEqual(errors, []);
});

test('U05: ampliamenti e versioni non verificate visibili, persistenti fra pagine e senza HTML attivo', opzioniBrowser, async t => {
  const { page, errors } = await apriPrototipo(t);
  await page.evaluate(() => {
    document.getElementById('ricercaPanel').hidden = false;
    renderRisultato({ risultati: [{ titolo: 'Moto sintetica', fonte: 'autoscout',
      url: 'https://example.invalid/moto', dichiarazione: 'versione-non-verificata', versioneEsito: 'ignota' }],
      sources: { autoscout: { status: 'ok', allargato: 'versione', reason: 'Versione non trovata: mostro tutte le versioni.', count: 1 },
        moto: { status: 'ok', versioneKoRete: true, versioneElencoMonco: '<img src=x onerror=alert(1)> elenco incompleto' } } });
  });
  assert.match(await page.locator('#avvisi').textContent(), /mostro tutte le versioni/);
  assert.match(await page.locator('#avvisi').textContent(), /elenco incompleto/);
  assert.equal(await page.locator('#avvisi img').count(), 0);
  const avvisi = page.locator('#risultati details').first();
  assert.equal(await avvisi.locator('summary').textContent(), 'Avvisi sull’annuncio');
  await avvisi.locator('summary').click();
  assert.equal(await avvisi.locator('p').textContent(), 'Versione non verificata.');
  await page.evaluate(() => renderRisultato({ risultati: [], sources: { subito: { status: 'empty', count: 0 } } }, true, ['subito'], 1));
  assert.match(await page.locator('#avvisi').textContent(), /mostro tutte le versioni/);
  assert.equal(await avvisi.evaluate(e => e.open), true);
  await page.evaluate(() => renderRisultato({ risultati: [], sources: { autoscout: { status: 'ok', count: 0 } } }, true, ['autoscout'], 2));
  assert.match(await page.locator('#avvisi').textContent(), /mostro tutte le versioni/);
  await page.evaluate(() => renderAvvisiRicerca(['HTTP 503. Riprova questa pagina.']));
  assert.match(await page.locator('#avvisi').textContent(), /mostro tutte le versioni/);
  assert.match(await page.locator('#avvisi').textContent(), /HTTP 503/);
  await page.evaluate(() => renderRisultato({ risultati: [], sources: { subito: { status: 'ok', count: 0 } } }, true, ['subito'], 3));
  assert.match(await page.locator('#avvisi').textContent(), /mostro tutte le versioni/);
  assert.doesNotMatch(await page.locator('#avvisi').textContent(), /HTTP 503/);

  await page.evaluate(() => renderRisultato({ risultati: [{ titolo: 'Moto verificata', fonte: 'subito',
    url: 'https://example.invalid/verificata', dichiarazione: 'esatto', versioneEsito: 'confermata' }], sources: { subito: { status: 'ok' } } }));
  assert.equal(await page.locator('#avvisi').textContent(), '');
  assert.equal(await page.locator('#risultati details').count(), 0);
  assert.deepEqual(errors, []);
});

test('F06: polling seriale conserva risposte lente, riparte dopo errori e consente refresh manuale', opzioniBrowser, async t => {
  let trattieni = false, versione = 0;
  const pendenti = [];
  const { page, errors } = await apriPrototipo(t, async (route, url) => {
    if (url.pathname === '/api/stato' && trattieni) { pendenti.push(route); return true; }
    if (url.pathname === '/api/admin') {
      await route.fulfill({ json: { nodi: [], lavori: [{ id: 'job-' + versione,
        operazione: 'ricerca', azienda: 'sintetica', stato: 'concluso' }], pagina: 1, pagine: 1 } });
      return true;
    }
    return false;
  });
  trattieni = true;
  await page.evaluate(() => window.pollDiagnosticaProva());
  await attendiRichieste(pendenti, 1);
  await page.evaluate(() => { window.pollDiagnosticaProva(); window.pollDiagnosticaProva(); });
  await page.waitForTimeout(50);
  assert.equal(pendenti.length, 1, 'I tick durante una risposta lenta non devono aprire altre richieste');
  versione = 1;
  await pendenti.shift().fulfill({ json: { nodi: [] } });
  await page.waitForSelector('[data-lavoro="job-1"]');

  await page.evaluate(() => window.pollDiagnosticaProva());
  await attendiRichieste(pendenti, 1);
  await pendenti.shift().fulfill({ status: 503, json: {} });
  await page.waitForFunction(() => document.getElementById('aggiornato').textContent.startsWith('Stato non disponibile'));
  await page.evaluate(() => window.pollDiagnosticaProva());
  await attendiRichieste(pendenti, 1);
  assert.equal(pendenti.length, 1, 'Un errore deve liberare il polling');
  await page.click('#aggiorna');
  await attendiRichieste(pendenti, 2);
  assert.equal(pendenti.length, 2, 'Il refresh manuale deve sostituire una richiesta lenta');
  versione = 2;
  await pendenti.pop().fulfill({ json: { nodi: [] } });
  await page.waitForSelector('[data-lavoro="job-2"]');
  await pendenti.pop().fulfill({ json: { nodi: [] } });
  assert.deepEqual(errors, []);
});

test('diagnostica: nodo solo stato visibile senza indicare disponibilità dei portali', opzioniBrowser, async t => {
  const nodi=[{id:'m2-osservatore',online:true,compatibile:true,soloStato:true,simulato:false,sospese:[],fonti:{}}];
  const {page,errors}=await apriPrototipo(t,async(route,url)=>{
    if(url.pathname==='/api/stato'){await route.fulfill({json:{nodi}});return true;}
    if(url.pathname==='/api/admin'){await route.fulfill({json:{nodi,lavori:[],eventi:[],pagina:1,pagine:1,totale:0}});return true;}
    return false;
  });
  const card=page.locator('#nodi .node-card');
  assert.match(await card.innerText(),/Solo stato · ricerche disabilitate/);
  assert.equal(await card.locator('.source-row').count(),3);
  for(const row of await card.locator('.source-row').all())assert.match(await row.innerText(),/portale non verificato/);
  assert.ok(!(await card.innerText()).includes('Disponibile'));assert.deepEqual(errors,[]);
});

test('F07: risposte e finally obsoleti non cambiano pagina o controlli della richiesta corrente', opzioniBrowser, async t => {
  const nodi = ['a', 'b'].map(id => ({ id, online: true, sospese: [], fonti: {} }));
  const richiesteA = [], richiesteB = [];
  let trattieniB = false;
  const stato = pagina => ({ nodi, lavori: [], pagina, pagine: 5, totale: 100 });
  const { page, errors } = await apriPrototipo(t, async (route, url) => {
    if (url.pathname === '/api/stato') { await route.fulfill({ json: { nodi } }); return true; }
    if (url.pathname !== '/api/admin') return false;
    if (url.searchParams.get('nodo') === 'a') { richiesteA.push(route); return true; }
    if (url.searchParams.get('nodo') === 'b' && trattieniB) { richiesteB.push(route); return true; }
    await route.fulfill({ json: stato(Number(url.searchParams.get('pagina'))) }); return true;
  });
  for (const status of [200, 503]) {
    await page.selectOption('#nodoOsservato', 'a');
    await attendiRichieste(richiesteA, 1);
    await page.selectOption('#nodoOsservato', 'b');
    await page.waitForFunction(() => !document.getElementById('aggiorna').disabled);
    trattieniB = true;
    await page.click('#lavoriDopo');
    await attendiRichieste(richiesteB, 1);
    await richiesteA.pop().fulfill({ status, json: { nodi, lavori: [], pagina: 1, pagine: 1 } });
    await page.waitForTimeout(50);
    assert.deepEqual(await page.evaluate(() => ({ pagina: paginaLavori,
      aggiorna: document.getElementById('aggiorna').disabled,
      prima: document.getElementById('lavoriPrima').disabled,
      dopo: document.getElementById('lavoriDopo').disabled })),
    { pagina: 2, aggiorna: true, prima: true, dopo: true });
    await richiesteB.pop().fulfill({ json: stato(2) });
    await page.waitForFunction(() => document.getElementById('lavoriPagina').textContent.startsWith('Pagina 2 di 5'));
    assert.equal(await page.locator('#lavoriPrima').isEnabled(), true);
    trattieniB = false;
  }
  // La risposta corrente deve ancora correggere una pagina realmente sparita.
  await page.route('**/api/admin?*', route => route.fulfill({ json: { nodi, lavori: [], pagina: 1, pagine: 1 } }));
  await page.click('#aggiorna');
  await page.waitForFunction(() => !document.getElementById('aggiorna').disabled);
  assert.equal(await page.evaluate(() => paginaLavori), 1);
  assert.equal(await page.locator('#lavoriPrima').isEnabled(), false);
  assert.deepEqual(errors, []);
});

test('F08: append conserva dettaglio pendente e completato; nuova ricerca e logout lo invalidano', opzioniBrowser, async t => {
  let ricerche = 0, dettagli = 0, paginaFallita = true;
  const pendenti = [];
  const { page, errors } = await apriPrototipo(t, async (route, url) => {
    if (url.pathname === '/api/search') {
      if (url.searchParams.has('fetta') && paginaFallita) {
        await route.fulfill({ status: 503, json: {} }); return true;
      }
      const id = ++ricerche;
      await route.fulfill({ json: { risultati: [{ titolo: 'Moto ' + id, fonte: 'subito',
        url: 'https://www.subito.it/moto/prova-' + id + '.htm', accessoDettagli: 'firma-' + id }],
      sources: { subito: { status: 'ok', hasMore: true, mainNextStart: 50 } } } }); return true;
    }
    if (url.pathname === '/api/detail') {
      dettagli++; assert.match(url.searchParams.get('accessoDettagli'), /^firma-\d+$/);
      pendenti.push(route); return true;
    }
    return false;
  });
  await page.evaluate(() => {
    document.getElementById('ricercaPanel').hidden = false;
    parametriRicerca = new URLSearchParams({ tipo: 'moto', marca: 'Yamaha' });
    return inviaRicerca(parametriRicerca);
  });
  await page.locator('#risultati summary').click();
  await attendiRichieste(pendenti, 1);
  await page.evaluate(() => {
    window.cardProva = document.querySelector('#risultati .listing');
    window.dettaglioProva = window.cardProva.querySelector('details');
    window.dettaglioProva.querySelector('summary').focus();
    return inviaRicerca(new URLSearchParams({ tipo: 'moto', marca: 'Yamaha', fetta: '1', fonti: 'subito' }), true, 1);
  });
  assert.equal(await page.evaluate(() => window.cardProva === document.querySelector('#risultati .listing')), true);
  paginaFallita = false;
  await page.evaluate(() => inviaRicerca(new URLSearchParams({ tipo: 'moto', marca: 'Yamaha', fetta: '1', fonti: 'subito' }), true, 1));
  assert.deepEqual(await page.evaluate(() => ({ stessa: window.cardProva === document.querySelector('#risultati .listing'),
    aperto: document.querySelector('#risultati details').open,
    focus: document.activeElement === document.querySelector('#risultati summary'),
    righe: document.querySelectorAll('#risultati .listing').length })),
  { stessa: true, aperto: true, focus: true, righe: 2 });
  await pendenti.pop().fulfill({ json: { ok: true, detail: { cilindrata: 600 } } });
  await page.waitForFunction(() => document.querySelector('#risultati details').textContent.includes('600'));
  await page.locator('#risultati summary').first().click();
  await page.locator('#risultati summary').first().click();
  await page.waitForTimeout(50);
  assert.equal(dettagli, 1, 'Un dettaglio completato deve restare disponibile senza una seconda chiamata');
  await page.evaluate(() => inviaRicerca(new URLSearchParams({ tipo: 'moto', marca: 'Yamaha', fetta: '2', fonti: 'subito' }), true, 2));
  assert.equal(await page.evaluate(() => window.cardProva === document.querySelector('#risultati .listing')), true);
  assert.equal(await page.locator('#risultati details').first().evaluate(e => e.open && e.textContent.includes('600')), true);
  assert.equal(dettagli, 1);

  await page.evaluate(() => inviaRicerca(parametriRicerca));
  assert.equal(await page.evaluate(() => window.cardProva.isConnected), false);
  assert.equal(await page.locator('#risultati .listing').count(), 1);
  assert.equal(await page.locator('#risultati').textContent().then(s => s.includes('600')), false);
  await page.locator('#risultati summary').click();
  await attendiRichieste(pendenti, 1);
  await page.evaluate(() => terminaContesto());
  await pendenti.pop().fulfill({ json: { ok: true, detail: { cilindrata: 900 } } });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#risultati').textContent(), '');
  assert.deepEqual(errors, []);
});

test('F09: refresh nodi conserva il comando, rispetta focus esterno e ripiega se il nodo sparisce o va offline', opzioniBrowser, async t => {
  let nodi = ['locale', 'secondo'].map(id => ({ id, online: true, sospeso: false, sospese: [], fonti: {} }));
  let trattieniStato = false;
  const pendenti = [];
  const { page, errors } = await apriPrototipo(t, async (route, url) => {
    if (url.pathname === '/api/stato') {
      if (trattieniStato) pendenti.push(route);
      else await route.fulfill({ json: { nodi } });
      return true;
    }
    if (url.pathname === '/api/admin') {
      await route.fulfill({ json: { nodi, lavori: [], pagina: 1, pagine: 1 } }); return true;
    }
    return false;
  });
  await page.locator('#nodi button').first().focus();
  nodi[0].sospeso = true;
  await page.evaluate(() => aggiornaStato());
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BUTTON');
  assert.deepEqual(await page.evaluate(() => ({ testo: document.activeElement.textContent,
    nodo: document.activeElement.closest('.node-card')?.querySelector('h3').textContent })),
  { testo: 'Riattiva nodo', nodo: 'locale' });

  await page.locator('#nodoOsservato').focus();
  await page.evaluate(() => aggiornaStato());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nodoOsservato');
  await page.locator('#nodi button').first().focus();
  trattieniStato = true;
  await page.evaluate(() => { window.refreshProva = aggiornaStato(); });
  await attendiRichieste(pendenti, 1);
  await page.locator('.area-nav a[href="#ricercaPanel"]').click();
  await page.locator('#azienda').focus();
  trattieniStato = false;
  await pendenti.pop().fulfill({ json: { nodi } });
  await page.evaluate(() => window.refreshProva);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'azienda');

  await page.locator('.area-nav a[href="#diagnosticaPanel"]').click();
  await page.locator('#nodi button').first().focus();
  nodi[0].online = false;
  await page.evaluate(() => aggiornaStato());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nodoOsservato');
  assert.equal(await page.locator('#nodi button').first().isEnabled(), false);
  await page.locator('#nodi .node-card').nth(1).locator('button').first().focus();
  nodi = nodi.slice(0, 1);
  await page.evaluate(() => aggiornaStato());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nodoOsservato');
  assert.deepEqual(errors, []);
});

test('F02: prima pagina recuperabile, avvisi persistenti e avanzamento separato senza ripetere fonti riuscite', opzioniBrowser, async t => {
  const chiamate = [];
  let retryIniziali = 0, retryPagina = 0;
  const riga = (fonte, n) => ({ fonte, titolo: fonte + '-' + n, url: 'https://example.invalid/' + fonte + '/' + n });
  const { page, errors } = await apriPrototipo(t, async (route, url) => {
    if (url.pathname !== '/api/search') return false;
    const fetta = Number(url.searchParams.get('fetta') || 0), fonti = url.searchParams.get('fonti');
    chiamate.push({ fetta, fonti });
    let json;
    if (!fonti) json = { risultati: [riga('moto', 0)], sources: {
      moto: { status: 'ok', hasMore: true }, autoscout: { status: 'empty', hasMore: false },
      subito: { status: 'error', reason: 'errore iniziale Subito', hasMore: null } } };
    else if (fonti === 'moto') json = { risultati: fetta === 1 ? [riga('moto', 1)] : [],
      sources: { moto: { status: fetta === 1 ? 'ok' : 'empty', hasMore: fetta === 1 } } };
    else {
      assert.equal(fonti, 'subito');
      const fallisce = fetta === 0 ? ++retryIniziali === 1 : ++retryPagina === 1;
      json = { risultati: fallisce ? [] : [riga('subito', fetta)], sources: { subito: fallisce
        ? { status: 'timeout', reason: 'Subito ancora indisponibile', hasMore: false }
        : { status: 'ok', hasMore: fetta === 0, mainNextStart: fetta === 0 ? 50 : null } } };
    }
    await route.fulfill({ json }); return true;
  });
  await page.evaluate(() => {
    document.getElementById('ricercaPanel').hidden = false; form.hidden = false;
    parametriRicerca = new URLSearchParams({ tipo: 'moto', marca: 'Yamaha' });
    return inviaRicerca(parametriRicerca);
  });
  assert.equal(await page.locator('#risultati .listing').count(), 1, 'I risultati riusciti sono visibili subito');
  await page.click('#altri');
  await page.waitForFunction(() => !ricercaOccupata);
  assert.match(await page.locator('#avvisi').textContent(), /Subito.*prima pagina/i);
  assert.equal(await page.getByRole('button', { name: 'Riprova fonti mancanti' }).count(), 1);
  await page.getByRole('button', { name: 'Riprova fonti mancanti' }).click();
  await page.waitForFunction(() => !ricercaOccupata);
  assert.match(await page.locator('#avvisi').textContent(), /Subito.*prima pagina/i);
  assert.equal(await page.locator('#risultati .listing').count(), 2);
  await page.getByRole('button', { name: 'Riprova fonti mancanti' }).click();
  await page.waitForFunction(() => !ricercaOccupata);
  assert.equal(await page.locator('#risultati .listing').count(), 3);
  assert.match(await page.locator('#risultatoAiuto').textContent(), /^Pagina 1 /);
  assert.equal(await page.getByRole('button', { name: 'Riprova fonti mancanti' }).isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'risultati');
  assert.doesNotMatch(await page.locator('#avvisi').textContent(), /prima pagina/i);
  // Subito deve recuperare la propria seconda pagina, senza saltarla o ripetere Moto.it.
  await page.click('#altri'); await page.waitForFunction(() => !ricercaOccupata);
  assert.equal(await page.locator('#altri').textContent(), 'Riprova questa pagina');
  assert.equal(await page.locator('#risultati .listing').count(), 3);
  await page.click('#altri'); await page.waitForFunction(() => !ricercaOccupata);
  assert.equal(await page.locator('#risultati .listing').count(), 4);
  await page.click('#altri'); await page.waitForFunction(() => !ricercaOccupata);
  assert.equal(await page.locator('#altri').isVisible(), false);
  assert.deepEqual(chiamate, [{ fetta: 0, fonti: null }, { fetta: 1, fonti: 'moto' },
    { fetta: 0, fonti: 'subito' }, { fetta: 0, fonti: 'subito' },
    { fetta: 1, fonti: 'subito' }, { fetta: 1, fonti: 'subito' }, { fetta: 2, fonti: 'moto' }]);
  assert.deepEqual(errors, []);
});

test('F02: recupero Subito dal cursore zero, retry residuo e nessun duplicato dei risultati parziali', opzioniBrowser, async t => {
  const chiamate = [];
  const riga = n => ({ fonte: 'subito', titolo: 'Subito-' + n, url: 'https://example.invalid/' + n });
  const { page, errors } = await apriPrototipo(t, async (route, url) => {
    if (url.pathname !== '/api/search') return false;
    chiamate.push(Object.fromEntries(url.searchParams));
    const n = chiamate.length;
    const sources = n === 1 ? {
      subito: { status: 'ok', count: 1, hasMore: true, mainNextStart: 50, recuperoNextStart: 0,
        parzialeRete: true, errori: [{ fase: 'recupero' }] },
      autoscout: { status: 'error', hasMore: null }, moto: { status: 'skipped', hasMore: false, reason: 'marca non supportata' },
    } : n === 2 ? { subito: { status: 'ok', count: 1, mainNextStart: null, recuperoNextStart: 50, hasMore: true },
      autoscout: { status: 'error', hasMore: false } }
      : n === 3 ? { autoscout: { status: 'empty', count: 0, hasMore: false },
        subito: { status: 'skipped', hasMore: false } }
      : { subito: { status: 'empty', count: 0, hasMore: false, mainNextStart: null, recuperoNextStart: null } };
    await route.fulfill({ json: { sources, risultati: n === 1 ? [riga(1)] : n === 2 ? [riga(1), riga(2)] : [] } }); return true;
  });
  await page.evaluate(() => {
    document.getElementById('ricercaPanel').hidden = false; form.hidden = false;
    parametriRicerca = new URLSearchParams({ tipo: 'moto', marca: 'Yamaha' });
    return inviaRicerca(parametriRicerca);
  });
  assert.equal(await page.getByRole('button', { name: 'Riprova fonti mancanti' }).count(), 1);
  await page.getByRole('button', { name: 'Riprova fonti mancanti' }).click();
  await page.waitForFunction(() => !ricercaOccupata);
  assert.deepEqual(chiamate[1], { tipo: 'moto', marca: 'Yamaha', fetta: '0', fonti: 'subito,autoscout',
    subitoMainStart: '-1', subitoRecuperoStart: '0' });
  assert.equal(await page.locator('#risultati .listing').count(), 2);
  assert.match(await page.locator('#fonti').textContent(), /Subitook · 2 qui/);
  assert.match(await page.locator('#avvisi').textContent(), /AutoScout24.*prima pagina/i);
  assert.doesNotMatch(await page.locator('#avvisi').textContent(), /Subito.*prima pagina/i);
  await page.getByRole('button', { name: 'Riprova fonti mancanti' }).click();
  await page.waitForFunction(() => !ricercaOccupata);
  assert.equal(chiamate[2].fonti, 'autoscout');
  assert.equal(await page.locator('#risultati .listing').count(), 2);
  await page.click('#altri'); await page.waitForFunction(() => !ricercaOccupata);
  assert.equal(chiamate[3].fetta, '1'); assert.equal(chiamate[3].fonti, 'subito');
  assert.equal(chiamate[3].subitoMainStart, '50'); assert.equal(chiamate[3].subitoRecuperoStart, '50');
  assert.equal(await page.locator('#altri').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('F02: pause 429, errori HTTP, filtri e cambio account conservano o invalidano il retry correttamente', opzioniBrowser, async t => {
  let richieste = 0, modo = 'pausa';
  const fontiRichieste = [];
  const pendenti = [], fino = Date.now() + 60000;
  const { page, errors } = await apriPrototipo(t, async (route, url) => {
    if (url.pathname !== '/api/search') return false;
    richieste++;
    fontiRichieste.push(url.searchParams.get('fonti'));
    if (modo === 'attendi') { pendenti.push(route); return true; }
    if (modo === 'http') { await route.fulfill({ status: 504, json: {} }); return true; }
    await route.fulfill({ json: { risultati: [], sources: {
      subito: modo === 'pausa' ? { status: 'error', erroreHttp: 429, pausa: { fermo: true, fino }, hasMore: false }
        : { status: 'empty', hasMore: false },
      autoscout: modo === 'pausa' ? { status: 'skipped', reason: 'in pausa dopo un blocco',
        pausa: { fermo: true, fino: fino + 60000 }, hasMore: false } : { status: 'skipped', hasMore: false },
      moto: { status: 'skipped', hasMore: false, reason: 'solo moto' } } } }); return true;
  });
  await page.evaluate(() => {
    document.getElementById('ricercaPanel').hidden = false; form.hidden = false;
    parametriRicerca = new URLSearchParams({ tipo: 'auto', marca: 'Fiat' });
    return inviaRicerca(parametriRicerca);
  });
  const retry = page.getByRole('button', { name: 'Riprova fonti mancanti' });
  assert.equal(await retry.count(), 1);
  assert.equal(await retry.isEnabled(), false);
  assert.match(await page.locator('#avvisi').textContent(), /429|pausa/i);
  await page.evaluate(() => window.pollDiagnosticaProva());
  assert.equal(richieste, 1, 'Il polling non deve avviare retry delle ricerche');
  modo = 'http';
  await page.evaluate(fine => { Date.now = () => fine + 1; window.pollDiagnosticaProva(); }, fino);
  await page.waitForFunction(() => !document.querySelector('#riprovaFonti').disabled);
  await retry.click(); await page.waitForFunction(() => !ricercaOccupata);
  assert.equal(fontiRichieste[1], 'subito', 'La fonte con pausa ancora attiva non deve essere richiesta');
  assert.match(await page.locator('#avvisi').textContent(), /Esito incerto/);
  assert.match(await page.locator('#avvisi').textContent(), /prima pagina/i);
  await page.evaluate(() => form.dispatchEvent(new Event('input', { bubbles: true })));
  assert.equal(await retry.isEnabled(), false);
  await page.evaluate(() => document.getElementById('riprovaFonti').click());
  assert.equal(richieste, 2);
  modo = 'riuscita';
  await page.evaluate(() => inviaRicerca(new URLSearchParams({ tipo: 'auto', marca: 'Fiat' })));
  assert.equal(await retry.isVisible(), false);
  assert.doesNotMatch(await page.locator('#avvisi').textContent(), /prima pagina/i);
  modo = 'pausa';
  await page.evaluate(() => inviaRicerca(parametriRicerca));
  modo = 'attendi';
  await retry.click(); await attendiRichieste(pendenti, 1);
  await page.evaluate(() => terminaContesto());
  await pendenti.pop().fulfill({ json: { risultati: [{ titolo: 'Risposta account precedente', fonte: 'subito' }],
    sources: { subito: { status: 'ok', hasMore: true } } } });
  await page.waitForTimeout(50);
  assert.equal(await retry.isVisible(), false);
  assert.equal(await page.locator('#risultati').textContent(), '');
  assert.equal(await page.locator('#avvisi').textContent(), '');
  assert.deepEqual(errors, []);
});

test('F02: errore principale Subito non diventa solo recovery; retry prima pagina conserva quello di pagina successiva', opzioniBrowser, async t => {
  const chiamate = [];
  let motoTentativi = 0;
  const riga = n => ({ fonte: 'subito', titolo: 'Subito-' + n, url: 'https://example.invalid/subito/' + n });
  const { page, errors } = await apriPrototipo(t, async (route, url) => {
    if (url.pathname !== '/api/search') return false;
    const q = Object.fromEntries(url.searchParams); chiamate.push(q);
    let json;
    if (!q.fonti) json = { risultati: [riga(0)], sources: {
      subito: { status: 'ok', count: 1, parzialeRete: true, mainNextStart: 150, recuperoNextStart: 0,
        errori: [{ fase: 'pagina', pagina: 2 }, { fase: 'recupero' }], hasMore: true },
      moto: { status: 'ok', hasMore: true }, autoscout: { status: 'skipped', hasMore: false } } };
    else if (q.fonti === 'moto') json = { risultati: [], sources: { moto: ++motoTentativi === 1
      ? { status: 'error', hasMore: null } : { status: 'empty', hasMore: false } } };
    else {
      assert.equal(q.fonti, 'subito'); assert.equal(q.fetta, '0');
      assert.equal(q.subitoMainStart, undefined, 'Un errore della pagina principale deve rieseguire la fetta iniziale');
      assert.equal(q.subitoRecuperoStart, undefined);
      json = { risultati: [riga(0), riga(1)], sources: {
        subito: { status: 'ok', count: 2, mainNextStart: null, recuperoNextStart: null, hasMore: false } } };
    }
    await route.fulfill({ json }); return true;
  });
  await page.evaluate(() => {
    document.getElementById('ricercaPanel').hidden = false; form.hidden = false;
    parametriRicerca = new URLSearchParams({ tipo: 'moto', marca: 'Yamaha' });
    return inviaRicerca(parametriRicerca);
  });
  await page.click('#altri'); await page.waitForFunction(() => !ricercaOccupata);
  assert.match(await page.locator('#avvisi').textContent(), /Subito.*prima pagina/i);
  await page.getByRole('button', { name: 'Riprova fonti mancanti' }).click();
  await page.waitForFunction(() => !ricercaOccupata);
  assert.equal(await page.locator('#altri').textContent(), 'Riprova questa pagina');
  assert.match(await page.locator('#avvisi').textContent(), /Moto\.it.*Riprova questa pagina/);
  assert.equal(await page.locator('#risultati .listing').count(), 2);
  await page.click('#altri'); await page.waitForFunction(() => !ricercaOccupata);
  assert.equal(chiamate[3].fonti, 'moto'); assert.equal(chiamate[3].fetta, '1');
  assert.equal(await page.locator('#altri').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('prototipo: aggiornamento lavori conserva dettagli, focus e scroll senza congelare i dati',
  { skip: !fs.existsSync(browserPath) && 'Chromium non disponibile' }, async t => {
  const server = require('node:http').createServer((req, res) => {
    const files = { '/': 'backend/nodi/prototipo.html', '/prototipo.js': 'frontend/nodi-prototipo.js',
      '/prototipo.css': 'frontend/nodi-prototipo.css', '/api/auth/bootstrap.js': 'frontend/nodi-bootstrap-prova.js' };
    const file = files[req.url];
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript'
      : req.url.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(__dirname, '..', file)));
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Pilotare il callback reale evita che un poll finisca prima dell'apertura
  // dei dettagli e renda il confronto dei contatori dipendente dal carico.
  await page.addInitScript(() => {
    const originale = window.setInterval;
    window.setInterval = (fn, ms, ...args) => {
      if (ms === 3000) { window.pollDiagnosticaProva = fn; return 0; }
      return originale(fn, ms, ...args);
    };
  });
  let aggiornamenti = 0, inverti = false, rimossi = new Set(), nuovaMarca = 'BMW';
  let dettagli = 0;
  let consegnaDettagli;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/bootstrap.js') return route.continue();
    let json;
    if (url.pathname === '/api/test/config') json = {accesso:'sintetico'};
    else if (url.pathname === '/api/test/me') { await route.fulfill({status:401,json:{}}); return; }
    else if (url.pathname === '/api/stato') json = {nodi:[]};
    else if (url.pathname === '/api/detail') {
      dettagli++;
      assert.equal(url.searchParams.get('accessoDettagli'),'firma-sintetica');
      assert.equal(url.searchParams.get('url'),'https://www.subito.it/moto/prova.htm');
      json={ok:true,detail:{cambio:'<script>non_eseguire()</script>',cilindrata:600}};
      await new Promise(resolve=>{consegnaDettagli=resolve;});
    }
    else if (url.pathname === '/api/admin') {
      aggiornamenti++;
      const lavori = Array.from({length:20},(_, i) => ({
        id:'job-'+i,operazione:'ricerca',azienda:'fittizia',stato:i===0 && aggiornamenti>1?'concluso':'in_corso',
        creato:1800000000000,filtri:{tipo:'moto',marca:nuovaMarca,modello:'R 1200 GS Adventure'},nodo:'locale',
        nodo_ms:aggiornamenti*10})).filter(job=>!rimossi.has(job.id));
      if (inverti) lavori.reverse();
      json = {nodi:[], pagina:1,pagine:1,totale:lavori.length,eventi:[],lavori};
    } else throw new Error('Chiamata inattesa: '+url.pathname);
    await route.fulfill({json});
  });
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForSelector('#lavori details');
  const summary = page.locator('#lavori summary').first();
  await summary.click(); await summary.focus();
  const aperto = await page.evaluate(() => {
    const details = document.querySelector('#lavori details'); window.dettaglioOriginale = details;
    const scroll = document.querySelector('.table-scroll'); scroll.scrollTop=80; scroll.scrollLeft=50;
    return {top:scroll.scrollTop,left:scroll.scrollLeft};
  });
  const prima=aggiornamenti;
  assert.equal(await page.locator('#lavori .state').first().textContent(), 'In corso');
  await page.evaluate(() => window.pollDiagnosticaProva());
  await page.waitForFunction(() => document.querySelector('#lavori .state').textContent==='Concluso');
  assert.ok(aggiornamenti>prima);
  assert.deepEqual(await page.evaluate(() => ({open:document.querySelector('#lavori details').open,
    stesso:document.querySelector('#lavori details')===window.dettaglioOriginale,
    focus:document.activeElement===document.querySelector('#lavori summary'),
    top:document.querySelector('.table-scroll').scrollTop,left:document.querySelector('.table-scroll').scrollLeft})),
  {open:true,stesso:true,focus:true,...aperto});
  await summary.click();
  const contatore=aggiornamenti;
  const durataPrima = await page.locator('#lavori tr').first().locator('td').nth(8).textContent();
  await page.evaluate(() => window.pollDiagnosticaProva());
  await page.waitForFunction(n => document.querySelector('#lavori tr').children[8].textContent !== n,
    durataPrima);
  assert.ok(aggiornamenti>contatore);
  assert.equal(await page.locator('#lavori details').first().evaluate(e=>e.open),false);
  await summary.click(); await summary.focus();
  inverti = true; nuovaMarca = 'Marca aggiornata';
  await page.evaluate(() => window.pollDiagnosticaProva());
  await page.waitForFunction(() => document.querySelector('#lavori tr').dataset.lavoro==='job-19');
  assert.deepEqual(await page.evaluate(() => ({open:window.dettaglioOriginale.open,
    focus:document.activeElement===window.dettaglioOriginale.querySelector('summary'),
    aggiornato:window.dettaglioOriginale.querySelector('pre').textContent.includes('Marca aggiornata')})),
  {open:true,focus:true,aggiornato:true});
  rimossi.add('job-0'); rimossi.add('job-1');
  await page.evaluate(() => window.pollDiagnosticaProva());
  await page.waitForFunction(() => !document.querySelector('[data-lavoro="job-0"]'));
  assert.equal(await page.evaluate(() => document.activeElement===document.querySelector('.table-scroll')),true);
  assert.equal(await page.locator('#lavori tr').count(),18);
  rimossi = new Set(Array.from({length:20},(_,i)=>'job-'+i));
  await page.evaluate(() => window.pollDiagnosticaProva());
  await page.waitForFunction(() => document.getElementById('lavori').textContent.includes('Nessun lavoro'));
  assert.equal(await page.locator('#lavori tr').count(),1);
  await page.evaluate(() => {
    document.getElementById('ricercaPanel').hidden=false;
    renderRisultato({risultati:[{titolo:'Moto',url:'https://www.subito.it/moto/prova.htm',
      fonte:'subito',accessoDettagli:'firma-sintetica'}],sources:{}});
  });
  assert.equal(dettagli,0);
  await page.locator('#risultati summary').click();
  for(let i=0;!consegnaDettagli&&i<100;i++)await page.waitForTimeout(5);
  assert.ok(consegnaDettagli);
  // Una pagina successiva fallita cambia la sequenza HTTP, non la card esistente.
  await page.evaluate(()=>{sequenzaRicerca++;});
  consegnaDettagli();
  await page.waitForFunction(()=>document.querySelector('#risultati details p').textContent.includes('600'));
  assert.equal(dettagli,1);
  assert.equal(await page.locator('#risultati script').count(),0);
  await page.locator('#risultati summary').click();
  await page.locator('#risultati summary').click();
  await page.waitForTimeout(100);
  assert.equal(dettagli,1);
  assert.deepEqual(errors,[]);
});
