'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright');
const { creaCentro } = require('../backend/nodi/centro');

const browserPath = process.env.AMR_TEST_CHROMIUM || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const browserDisponibile = { skip: !fs.existsSync(browserPath) && 'Chromium non disponibile' };

async function apriAccountSintetico(t, api) {
  const server = require('node:http').createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><main data-account-prototipo></main><script src="/account.js" defer></script>');
    } else if (req.url === '/account.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.end(fs.readFileSync(path.join(__dirname, '../frontend/nodi-aziende-prova.js')));
    } else res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const origine = 'http://127.0.0.1:' + server.address().port;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origine) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (await api(route, url)) return;
    if (url.pathname === '/api/auth/aziende/pagina') return route.fulfill({ contentType: 'text/html',
      body: fs.readFileSync(path.join(__dirname, '../backend/nodi/aziende-prova.html'), 'utf8') });
    const risposte = { '/api/auth/me': { admin: true }, '/api/auth/aziende/elenco': { aziende: [] },
      '/api/auth/sessioni': { sessioni: [] } };
    assert.ok(Object.hasOwn(risposte, url.pathname), 'API inattesa: ' + url.pathname);
    return route.fulfill({ json: risposte[url.pathname] });
  });
  await page.goto(origine);
  await page.waitForFunction(() => document.getElementById('account-sessioni-panel')?.hidden === false
    && document.getElementById('account-sessione-aggiorna')?.disabled === false);
  return { page, errors };
}

test('F13: refresh account chiude il pending invalidato e una risposta tardiva non sovrascrive una nuova azione', browserDisponibile, async t => {
  let attivo = true;
  const pendenti = [];
  const { page, errors } = await apriAccountSintetico(t, async (route, url) => {
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ status: attivo ? 200 : 401, json: attivo ? { admin: true } : {} }); return true;
    }
    if (url.pathname === '/api/auth/logout') {
      attivo = false;
      await route.fulfill({ json: { ok: true, provider: { stato: 'pending', id: 'a'.repeat(64) } } }); return true;
    }
    if (url.pathname === '/api/auth/logout/stato') { pendenti.push(route); return true; }
    if (url.pathname === '/api/auth/aziende/invita') {
      const body = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, id: body.id, operazione: body.operazione,
        link: url.origin + '/api/auth/aziende/pagina#sintetico' } }); return true;
    }
    return false;
  });
  for (const stato of ['confirmed', 'unconfirmed']) {
    await page.click('#account-esci');
    await page.waitForFunction(() => document.getElementById('account-stato').textContent.includes('Nhost in corso'));
    await page.click('#account-sessione-aggiorna');
    await page.waitForFunction(() => !document.getElementById('account-sessione-aggiorna').disabled);
    assert.match(await page.locator('#account-stato').textContent(), /Sessione AMR terminata.*Nhost non è confermata/);
    await page.waitForTimeout(2100);
    for (const route of pendenti.splice(0)) await route.fulfill({ json: { provider: { stato } } });
    await page.waitForTimeout(50);
    assert.match(await page.locator('#account-stato').textContent(), /Nhost non è confermata/);
    assert.equal(await page.locator('#account-sessioni-panel').isVisible(), false);
    attivo = true; await page.reload();
    await page.waitForFunction(() => !document.getElementById('account-sessione-aggiorna').disabled);
  }
  // Un nuovo login e un nuovo invito prevalgono sul poll già in volo.
  await page.click('#account-esci');
  const termine = Date.now() + 5000;
  while (!pendenti.length && Date.now() < termine) await page.waitForTimeout(20);
  assert.equal(pendenti.length, 1);
  attivo = true; await page.click('#account-sessione-aggiorna');
  await page.waitForSelector('#account-admin:not([hidden])');
  await page.locator('#account-invita input[name=email]').fill('ref@amr.invalid');
  await page.locator('#account-invita button').click();
  await page.waitForFunction(() => document.getElementById('account-stato').textContent.includes('Invito disponibile nel link'));
  await pendenti.pop().fulfill({ json: { provider: { stato: 'confirmed' } } });
  await page.waitForTimeout(50);
  assert.match(await page.locator('#account-stato').textContent(), /Invito disponibile nel link/);
  assert.equal(await page.locator('#account-admin').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('F13: senza invalidazione il polling conferma, segnala il rifiuto o scade senza restare pending', browserDisponibile, async t => {
  let risposta = 'confirmed', richieste = 0;
  const pendenti = [];
  const { page, errors } = await apriAccountSintetico(t, async (route, url) => {
    if (url.pathname === '/api/auth/logout') {
      await route.fulfill({ json: { ok: true, provider: { stato: 'pending', id: 'b'.repeat(64) } } }); return true;
    }
    if (url.pathname === '/api/auth/logout/stato') {
      richieste++;
      assert.deepEqual(route.request().postDataJSON(), { id: 'b'.repeat(64) });
      if (risposta === 'timeout') pendenti.push(route);
      else await route.fulfill({ json: { provider: { stato: risposta } } });
      return true;
    }
    return false;
  });
  for (const stato of ['confirmed', 'unconfirmed', 'timeout', 'pending']) {
    risposta = stato; richieste = 0;
    await page.click('#account-esci');
    await page.waitForFunction(() => document.getElementById('account-stato').textContent.includes('Nhost in corso'));
    await page.waitForFunction(() => !document.getElementById('account-stato').textContent.includes('Nhost in corso'),
      null, { timeout: 16000 });
    assert.match(await page.locator('#account-stato').textContent(), stato === 'confirmed'
      ? /Sessione AMR terminata.*Nhost confermata/ : /Sessione AMR terminata.*Nhost non è confermata/);
    assert.equal(richieste, stato === 'pending' ? 6 : 1);
    for (const route of pendenti.splice(0)) await route.fulfill({ json: { provider: { stato: 'confirmed' } } });
    await page.waitForTimeout(2100);
    assert.equal(richieste, stato === 'pending' ? 6 : 1, 'Nessun poll dopo un esito terminale');
    if (stato === 'timeout') assert.match(await page.locator('#account-stato').textContent(), /Nhost non è confermata/);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('account-sessioni-panel')?.hidden === false
      && document.getElementById('account-sessione-aggiorna')?.disabled === false);
  }
  assert.deepEqual(errors, []);
});

test('F13: revoca riuscita conserva esito e polling se il refresh sessioni fallisce; retry della sola lettura', browserDisponibile, async t => {
  const corrente = { id: 'c'.repeat(64), corrente: true, creata: '2026-10-02T08:00:00Z', scadenza: '2026-10-03T08:00:00Z' };
  const altra = { ...corrente, id: 'd'.repeat(64), corrente: false };
  let risposta = 'confirmed', guasto = 503, revocata = false, letture = 0, revoche = 0, poll = 0;
  const { page, errors } = await apriAccountSintetico(t, async (route, url) => {
    if (url.pathname === '/api/auth/sessioni') {
      letture++;
      if (revocata && guasto === 'rete') await route.abort('connectionfailed');
      else if (revocata && guasto) await route.fulfill({ status: guasto, json: {} });
      else await route.fulfill({ json: { sessioni: revocata ? [corrente] : [corrente, altra] } });
      return true;
    }
    if (url.pathname === '/api/auth/sessioni/revoca') {
      assert.deepEqual(route.request().postDataJSON(), { id: altra.id });
      revoche++; revocata = true;
      await route.fulfill({ json: { ok: true, provider: { stato: risposta, id: 'e'.repeat(64) } } }); return true;
    }
    if (url.pathname === '/api/auth/logout/stato') {
      poll++; await route.fulfill({ json: { provider: { stato: 'confirmed' } } }); return true;
    }
    return false;
  });
  for (const caso of [{ stato: 'confirmed', guasto: 503 }, { stato: 'pending', guasto: 503 },
    { stato: 'unconfirmed', guasto: 503 }, { stato: 'confirmed', guasto: 'rete' }]) {
    risposta = caso.stato; guasto = caso.guasto;
    await page.locator('#account-sessioni').getByRole('button', { name: 'Revoca sessione', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('account-sessioni-aggiorna').disabled);
    assert.match(await page.locator('#account-stato').textContent(), /Sessione selezionata terminata/);
    assert.doesNotMatch(await page.locator('#account-stato').textContent(), /Operazione non riuscita|Esito non confermato/);
    assert.match(await page.locator('#account-sessioni-avviso').textContent(), /Elenco delle sessioni non aggiornato.*Aggiorna sessioni/);
    assert.equal(await page.locator('#account-sessioni-avviso').isVisible(), true);
    assert.equal(await page.locator('#account-esci').isVisible(), true, 'Il chiamante resta autenticato');
    assert.equal(await page.locator('#account-admin').isVisible(), true);
    assert.equal(await page.locator('#account-sessioni').getByRole('button', { name: 'Revoca sessione', exact: true }).count(), 0,
      'La sessione già revocata non resta riprovabile');
    assert.equal(letture, 2); assert.equal(revoche, 1);
    if (caso.stato === 'pending') {
      await page.waitForFunction(() => document.getElementById('account-stato').textContent.includes('Nhost confermata'));
      assert.equal(poll, 1);
      assert.equal(await page.locator('#account-sessioni-avviso').isVisible(), true, 'Il poll non cancella il warning della lettura');
    } else {
      assert.match(await page.locator('#account-stato').textContent(), caso.stato === 'confirmed' ? /Nhost confermata/ : /Nhost non è confermata/);
      assert.equal(poll, 0);
    }
    await page.click('#account-sessioni-aggiorna');
    await page.waitForFunction(() => !document.getElementById('account-sessioni-aggiorna').disabled);
    assert.match(await page.locator('#account-stato').textContent(), /Sessione selezionata terminata/);
    assert.equal(await page.locator('#account-sessioni-avviso').isVisible(), true);
    assert.equal(letture, 3); assert.equal(revoche, 1);
    guasto = 0; await page.click('#account-sessioni-aggiorna');
    await page.waitForFunction(() => !document.getElementById('account-sessioni-aggiorna').disabled);
    assert.equal(await page.locator('#account-sessioni-avviso').isVisible(), false);
    assert.equal(letture, 4); assert.equal(revoche, 1, 'Il retry non ripete la revoca');
    assert.equal(await page.locator('#account-sessioni').getByRole('button', { name: 'Termina questa sessione' }).count(), 1);
    revocata = false; letture = revoche = poll = 0; await page.reload();
    await page.waitForFunction(() => document.getElementById('account-sessioni-panel')?.hidden === false
      && document.getElementById('account-sessioni-aggiorna')?.disabled === false);
  }
  assert.deepEqual(errors, []);
});

test('F13: revoca corrente, POST fallito e perdita di accesso preservano i confini della UI sessioni', browserDisponibile, async t => {
  const corrente = { id: 'f'.repeat(64), corrente: true, creata: '2026-10-02T08:00:00Z', scadenza: '2026-10-03T08:00:00Z' };
  const altra = { ...corrente, id: '1'.repeat(64), corrente: false };
  let caso, letture = 0, revoche = 0, poll = 0;
  const casi = [{ corrente: true, post: 200, refresh: 200, provider: 'pending' },
    { corrente: false, post: 503, refresh: 200, provider: 'confirmed' },
    { corrente: false, post: 200, refresh: 401, provider: 'confirmed' },
    { corrente: false, post: 200, refresh: 200, provider: 'pending' }];
  caso = casi[0];
  const { page, errors } = await apriAccountSintetico(t, async (route, url) => {
    if (url.pathname === '/api/auth/sessioni') {
      letture++;
      if (revoche && caso.refresh !== 200) await route.fulfill({ status: caso.refresh, json: { codice: 'sessione_revocata' } });
      else await route.fulfill({ json: { sessioni: revoche ? [corrente] : [corrente, altra] } });
      return true;
    }
    if (url.pathname === '/api/auth/sessioni/revoca') {
      assert.deepEqual(route.request().postDataJSON(), { id: caso.corrente ? corrente.id : altra.id });
      revoche++;
      await route.fulfill({ status: caso.post, json: caso.post === 200
        ? { ok: true, provider: { stato: caso.provider, id: '2'.repeat(64) } } : {} }); return true;
    }
    if (url.pathname === '/api/auth/logout/stato') {
      poll++; await route.fulfill({ json: { provider: { stato: 'confirmed' } } }); return true;
    }
    return false;
  });
  for (let i = 0; i < casi.length; i++) {
    caso = casi[i];
    if (i) {
      letture = revoche = poll = 0; await page.reload();
      await page.waitForFunction(() => document.getElementById('account-sessioni-panel')?.hidden === false
        && document.getElementById('account-sessioni-aggiorna')?.disabled === false);
    }
    await page.evaluate(() => {
      window.accountEvents = [];
      document.addEventListener('amr:account', e => window.accountEvents.push(e.detail));
    });
    await page.locator('#account-sessioni').getByRole('button', {
      name: caso.corrente ? 'Termina questa sessione' : 'Revoca sessione', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('account-sessione-aggiorna').disabled);
    assert.equal(revoche, 1);
    if (caso.post !== 200) {
      assert.match(await page.locator('#account-stato').textContent(), /Operazione non riuscita.*HTTP 503/);
      assert.doesNotMatch(await page.locator('#account-stato').textContent(), /Sessione.*terminata/);
      assert.equal(await page.locator('#account-sessioni button').count(), 2);
      assert.equal(await page.locator('#account-sessioni-avviso').isVisible(), false);
      assert.equal(await page.locator('#account-esci').isVisible(), true);
      assert.equal(letture, 1); assert.equal(poll, 0);
    } else if (caso.corrente) {
      assert.equal(await page.locator('#account-admin').isVisible(), false);
      assert.equal(await page.locator('#account-sessioni-panel').isVisible(), false);
      assert.equal(await page.locator('#account-esci').isVisible(), false);
      assert.equal(await page.locator('#account-sessione').textContent(), 'Sessione terminata.');
      assert.deepEqual(await page.evaluate(() => window.accountEvents), [null]);
      assert.equal(letture, 1, 'Revocare questa sessione non rilegge dati autenticati');
      await page.waitForFunction(() => document.getElementById('account-stato').textContent.includes('Nhost confermata'));
      assert.match(await page.locator('#account-stato').textContent(), /Sessione AMR terminata/);
      assert.equal(poll, 1);
    } else if (caso.refresh === 401) {
      assert.equal(await page.locator('#account-admin').isVisible(), false);
      assert.equal(await page.locator('#account-sessioni-panel').isVisible(), false);
      assert.equal(await page.locator('#account-sessione').textContent(), 'Sessione revocata. Accedi nuovamente.');
      assert.deepEqual(await page.evaluate(() => window.accountEvents), [null]);
      assert.match(await page.locator('#account-stato').textContent(), /Sessione selezionata terminata.*Nhost confermata/);
      assert.equal(letture, 2);
    } else {
      await page.click('#account-sessioni-aggiorna');
      await page.waitForFunction(() => !document.getElementById('account-sessioni-aggiorna').disabled);
      assert.match(await page.locator('#account-stato').textContent(), /Sessione selezionata terminata.*Nhost non è confermata/);
      await page.waitForTimeout(2100);
      assert.equal(poll, 0, 'Il refresh invalida il poll ancora in attesa');
      assert.equal(await page.locator('#account-admin').isVisible(), true);
      assert.equal(await page.locator('#account-esci').isVisible(), true);
      assert.deepEqual(await page.evaluate(() => window.accountEvents), []);
      assert.equal(letture, 3);
    }
  }
  assert.deepEqual(errors, []);
});

test('F10: il recovery riusa insieme id e operazione restituiti, senza dipendere da prefissi', browserDisponibile, async t => {
  const richieste = [], recuperato = { id: 'azienda-importata-sintetica', operazione: '00000000-0000-4000-8000-000000000010' };
  const { page, errors } = await apriAccountSintetico(t, async (route, url) => {
    if (url.pathname !== '/api/auth/aziende/invita') return false;
    richieste.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, giaCreata: true, ...recuperato } }); return true;
  });
  await page.locator('#account-invita input[name=email]').fill('ref@amr.invalid');
  for (let i = 0; i < 2; i++) {
    await page.locator('#account-invita button').click();
    await page.waitForFunction(() => !document.querySelector('#account-invita button').disabled);
    assert.match(await page.locator('#account-stato').textContent(), /Invito già registrato/);
    assert.equal(await page.locator('#account-consegna a').count(), 0);
  }
  assert.equal(richieste.length, 2);
  assert.equal(richieste[1].id, recuperato.id); assert.equal(richieste[1].operazione, recuperato.operazione);
  assert.notEqual(richieste[0].id, recuperato.id); assert.notEqual(richieste[0].operazione, recuperato.operazione);
  assert.deepEqual(errors, []);
});

test('UI account nel centro: Admin, invito, idempotenza, cliente e logout senza collisioni DOM',
  { skip: !fs.existsSync(browserPath) && 'Chromium non disponibile: impostare AMR_TEST_CHROMIUM' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-account-ui-'));
  const server = require('node:http').createServer().listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const origine = 'http://127.0.0.1:' + server.address().port;
  let aziendeRoute, operazioni = [], failElenco = false, elencoCount = 0, token = 'a'.repeat(64), invitoPersistente = null;
  let commerciale = null;
  let oraLimite = Date.now();
  let perdiRevoca = false;
  let logoutProviderFallisce = false;
  const modifiche = [];
  const centro = creaCentro({ directory: dir, tokens: { locale: 'a'.repeat(64) }, adminLocale: true,
    inizializzaAccessi: app => {
      const accessi = require('../backend/nodi/login-nhost-prova').mount(app, { origine, cookiePath: '/',
        client: { login: async () => ({ mfa: { ticket: 'ticket-sintetico' } }),
          mfa: async () => ({ session: { user: { id: 'admin', emailVerified: true },
            accessToken: 'sintetico', refreshToken: 'sintetico' } }), logout: async () => {
            if(logoutProviderFallisce)throw new Error('provider sintetico non disponibile');
          } },
        identita: async () => ({ attiva: true, admin: true, epoca: 0 }) });
      aziendeRoute = require('../backend/nodi/aziende-prova-route').mount(app, { origine, accessi, ora:()=>oraLimite,
        account: { elenco: async () => {
          elencoCount++;
          if (failElenco) throw Object.assign(new Error('KO sintetico'), { status: 503 });
          return { aziende: [commerciale || { id: 'cliente', nome: '<script>errore()</script>', stato: 'accettato' },
            ...(invitoPersistente ? [{id:invitoPersistente.id,nome:invitoPersistente.nome,stato:'pending'},
              {id:'omonima',nome:invitoPersistente.nome,stato:'pending'}] : [])] };
        }, invita: async (s, b) => {
          if (invitoPersistente && ['nome','email','moduli'].some(k=>JSON.stringify(b[k])!==JSON.stringify(invitoPersistente[k]))) {
            throw Object.assign(new Error('operazione_in_conflitto'), {status:409,codice:'operazione_in_conflitto'});
          }
          if(invitoPersistente) {
            if(b.operazione===invitoPersistente.operazione && b.id!==invitoPersistente.id) {
              throw Object.assign(new Error('operazione_in_conflitto'),{status:409,codice:'operazione_in_conflitto'});
            }
            return {ok:true,id:invitoPersistente.id,operazione:invitoPersistente.operazione,giaCreata:true};
          }
          invitoPersistente = {...b}; return {ok:true,id:b.id,operazione:b.operazione,token};
        },
        attiva: async (s, b) => { operazioni.push(b.operazione); return { ok: true }; },
        rinnova: async (s,b) => {
          modifiche.push({verbo:'rinnova',...b}); commerciale.stato = 'attiva';
          return {ok:true};
        },
        revocaAzienda: async (s,b) => {
          modifiche.push({verbo:'revoca',...b}); commerciale.stato = 'revocata';
          if (perdiRevoca) { perdiRevoca=false; throw Object.assign(new Error('risposta persa'),{status:503}); }
          return {ok:true};
        },
        statoOperazione: async (s,b) => ({confermata:modifiche.some(op=>op.operazione===b.operazione&&op.id===b.id)}),
        invito: async () => ({ email: 'ref@amr.invalid' }) }, client: {} });
      return accessi;
    } });
  server.on('request', centro.app);
  let browser;
  t.after(async () => {
    await browser?.close(); aziendeRoute.close(); centro.close();
    server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const context = await browser.newContext(), page = await context.newPage();
  await page.addInitScript(() => {
    const originale = window.setInterval;
    window.setInterval = (fn, ms, ...args) => {
      if (ms === 30000) window.aggiornaAccountProva = fn;
      return originale(fn, ms, ...args);
    };
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Login sintetico tramite le vere rotte AMR: nessun cookie reale letto.
  await page.goto(origine + '/api/auth/pagina');
  await page.locator('input[name=email]').fill('admin@amr.invalid');
  await page.locator('input[name=password]').fill('password-sintetica');
  await page.locator('#login button').click();
  await page.locator('input[name=otp]').fill('123456');
  await page.locator('#mfa button').click();
  await page.waitForURL(origine + '/');
  await page.waitForSelector('.area-nav a[href="#accountPanel"]:not([hidden])');
  await page.locator('.area-nav a[href="#accountPanel"]').click();
  await page.waitForSelector('#account-admin:not([hidden])');
  assert.match(await page.locator('#account-sessione').textContent(), /Admin autenticato/);
  assert.equal(await page.locator('#account-aziende script').count(), 0);
  assert.equal(await page.locator('#ricercaPanel').isVisible(), false);
  assert.equal(await page.locator('.area-nav a[href="#ricercaPanel"]').isVisible(), false);
  assert.match(await page.locator('#account-aziende').textContent(), /<script>/);
  assert.equal(await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('[id]'), e => e.id);
    return ids.length === new Set(ids).size;
  }), true);
  const primaFocus = elencoCount;
  await page.getByRole('button', { name: 'Attiva per un anno' }).focus();
  await page.evaluate(() => window.aggiornaAccountProva());
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  assert.ok(elencoCount > primaFocus);
  assert.equal(await page.getByRole('button', { name: 'Attiva per un anno' }).evaluate(b => b === document.activeElement), true);
  // Aggiornamento account non cambia il pulsante della diagnostica e viceversa.
  const prima = elencoCount;
  await page.locator('#account-aggiorna').click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  assert.ok(elencoCount > prima);
  assert.equal(await page.locator('#aggiorna').isEnabled(), true);
  // SQL confermato + successiva lettura fallita: retry mantiene l'operazione.
  failElenco = true;
  await page.getByRole('button', { name: 'Attiva per un anno' }).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  failElenco = false;
  await page.locator('#account-aggiorna').click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  await page.getByRole('button', { name: 'Attiva per un anno' }).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  assert.equal(operazioni.length, 2); assert.equal(operazioni[0], operazioni[1]);
  commerciale = {id:'cliente',nome:'Cliente',stato:'attiva',scadenza:'2027-10-02T00:00:00.000Z'};
  await page.locator('#account-aggiorna').click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  page.on('dialog', dialog => dialog.accept());
  failElenco = true;
  await page.getByRole('button',{name:'Revoca accesso azienda'}).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  // Mutazione riuscita, lettura fallita: ripetere il gesto ritenta solo la lettura.
  await page.getByRole('button',{name:'Revoca accesso azienda'}).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  assert.equal(modifiche.length,1);
  failElenco = false;
  await page.getByRole('button',{name:'Revoca accesso azienda'}).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  assert.equal(await page.locator('#account-aggiorna').evaluate(b=>b===document.activeElement),true);
  await page.getByRole('button',{name:'Rinnova e riattiva'}).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  await page.getByRole('button',{name:'Revoca accesso azienda'}).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  assert.equal(modifiche.length,3);
  assert.notEqual(modifiche[0].operazione,modifiche[2].operazione);
  await page.getByRole('button',{name:'Rinnova e riattiva'}).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  perdiRevoca = true;
  await page.getByRole('button',{name:'Revoca accesso azienda'}).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  const revocaSenzaAck = modifiche.at(-1).operazione;
  await page.locator('#account-aggiorna').click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  await page.getByRole('button',{name:'Rinnova e riattiva'}).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  await page.getByRole('button',{name:'Revoca accesso azienda'}).click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  assert.notEqual(modifiche.at(-1).operazione,revocaSenzaAck);
  commerciale = null;
  // Le molte controprove sopra occupano una finestra intera: la successiva
  // sequenza UI esercita una nuova finestra, senza indebolire il limite reale.
  oraLimite += 60001;
  await page.locator('#account-invita input[name=email]').fill('ref@amr.invalid');
  await page.locator('#account-invita button').click();
  await page.waitForSelector('#account-consegna a');
  assert.match(await page.locator('#account-stato').textContent(), /non inviato/);
  const primoLink = await page.locator('#account-consegna a').getAttribute('href');
  // Simula un invito preesistente con ID aziendale indipendente dall'operazione.
  invitoPersistente.id = 'invito-' + invitoPersistente.operazione;
  // Ricaricare perde l'operazione nel browser, ma non deve bloccare l'invito esistente.
  await page.reload(); await page.waitForSelector('.area-nav a[href="#accountPanel"]:not([hidden])');
  await page.locator('.area-nav a[href="#accountPanel"]').click();
  await page.waitForSelector('#account-admin:not([hidden])');
  await page.locator('#account-invita input[name=email]').fill('ref@amr.invalid');
  await page.locator('#account-invita button').click();
  await page.waitForSelector('#account-consegna a');
  assert.equal(await page.locator('#account-consegna a').getAttribute('href'), primoLink);
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  await page.locator('#account-invita button').click();
  await page.waitForFunction(() => !document.getElementById('account-aggiorna').disabled);
  assert.equal(await page.locator('#account-consegna a').getAttribute('href'), primoLink);
  assert.equal((await page.locator('#account-stato').textContent()).includes('non coincidono'),false);
  // La perdita della copia RAM non viene dichiarata come link disponibile.
  await page.route('**/api/auth/aziende/invita',route=>route.fulfill({json:{ok:true,giaCreata:true,id:invitoPersistente.id,operazione:invitoPersistente.operazione}}));
  await page.locator('#account-invita button').click();
  await page.waitForFunction(()=>document.getElementById('account-stato').textContent.includes('link temporaneo non è disponibile'));
  assert.equal(await page.locator('#account-consegna a').count(),0);
  assert.equal((await page.locator('#account-stato').textContent()).includes('Invito disponibile nel link'),false);
  await page.unroute('**/api/auth/aziende/invita');
  // La pagina referente mantiene il flusso separato, senza controlli Admin.
  const recipient = await context.newPage();
  await recipient.goto(origine + '/api/auth/aziende/pagina#' + token);
  await recipient.waitForSelector('#account-destinatario:not([hidden])');
  assert.equal(new URL(recipient.url()).hash, '');
  assert.equal(await recipient.locator('#account-admin').isVisible(), false);
  const gestione = await context.newPage();
  await gestione.goto(origine + '/api/auth/aziende/pagina');
  await gestione.waitForURL(origine + '/#accountPanel');
  await gestione.waitForSelector('#account-admin:not([hidden])');
  await gestione.close();
  // Una risposta diagnostica arrivata dopo logout non deve riaprire dati Admin.
  let diagnosticaTardiva;
  await page.route('**/api/stato', route => { diagnosticaTardiva = route; });
  await page.locator('.area-nav a[href="#diagnosticaPanel"]').click();
  await page.locator('#aggiorna').click();
  await page.waitForFunction(() => document.getElementById('aggiorna').disabled);
  for (let i = 0; !diagnosticaTardiva && i < 30; i++) await page.waitForTimeout(20);
  assert.ok(diagnosticaTardiva);
  // Logout nel pannello integrato distrugge la sessione lato server.
  logoutProviderFallisce = true;
  await page.locator('.area-nav a[href="#accountPanel"]').click();
  await page.locator('#account-esci').click();
  await page.waitForFunction(() => document.getElementById('account-esci').hidden);
  assert.equal(await page.locator('#account-admin').isVisible(), false);
  assert.equal(await page.locator('#account-aziende').textContent(), '');
  assert.equal(await page.locator('#account-consegna').textContent(), '');
  await page.waitForFunction(() => document.getElementById('account-stato').textContent.includes('Nhost non è confermata'));
  assert.match(await page.locator('#account-stato').textContent(), /Sessione AMR terminata.*Nhost non è confermata/);
  assert.equal(await page.locator('#cerca').isVisible(), false);
  await diagnosticaTardiva.fulfill({ json: { nodi: [{ id: 'tardivo' }], lavori: [] } });
  await page.waitForFunction(() => !document.getElementById('aggiorna').disabled);
  assert.equal(await page.locator('#diagnosticaPanel').isVisible(), false);
  assert.equal(await page.locator('#nodi').textContent(), '');

  assert.equal((await context.request.get(origine + '/api/auth/me')).status(), 401);
  assert.deepEqual(errors, []);
  // Un cliente autenticato non carica il registro aziende Admin.
  await page.route('**/api/auth/me', route => route.fulfill({ json: { admin: false,
    azienda: 'cliente', aziendaValida: false, moduli: ['moto'] } }));
  await page.route('**/api/auth/sessioni', route => route.fulfill({ json: { sessioni: [] } }));
  const letture = elencoCount;
  await page.locator('#account-sessione-aggiorna').click();
  await page.waitForFunction(() => document.getElementById('account-sessione').textContent.includes('in attesa'));
  assert.equal(await page.locator('#account-admin').isVisible(), false);
  assert.equal(elencoCount, letture);
  let pollingAdmin = 0;
  page.on('request', r => { if (/\/api\/(stato|admin)(\?|$)/.test(new URL(r.url()).pathname)) pollingAdmin++; });
  await page.waitForTimeout(3200);
  assert.equal(pollingAdmin, 0);
  // Il referente attivo accede direttamente a Ricerca, con il solo modulo acquistato.
  await page.route('**/api/auth/me', route => route.fulfill({ json: { admin: false,
    azienda: 'cliente', aziendaValida: true, moduli: ['moto'] } }));
  await page.route('**/api/brands?*', route => route.fulfill({ json: { brands: [] } }));
  await page.route('**/api/filtri', route => route.fulfill({ json: { regioni: [], filtriAuto: [] } }));
  await page.goto(origine + '/');
  await page.waitForSelector('#cerca:not([hidden])');
  assert.equal(new URL(page.url()).hash, '#ricercaPanel');
  assert.equal(await page.locator('[name=tipo][value=moto]').isChecked(), true);
  assert.equal(await page.locator('[name=tipo][value=auto]').isEnabled(), false);
  assert.equal(await page.locator('.area-nav a[href="#diagnosticaPanel"]').isVisible(), false);
  await page.locator('#marca').fill('Filtro conservato');
  await page.locator('.area-nav a[href="#accountPanel"]').click();
  await page.waitForSelector('#accountPanel:not([hidden])');
  await page.goBack();
  await page.waitForSelector('#ricercaPanel:not([hidden])');
  assert.equal(await page.locator('#marca').inputValue(), 'Filtro conservato');
  await page.goForward();
  await page.waitForSelector('#accountPanel:not([hidden])');
  await page.evaluate(() => { location.hash = 'diagnosticaPanel'; });
  await page.waitForSelector('#ricercaPanel:not([hidden])');
  assert.equal(new URL(page.url()).hash, '#ricercaPanel');
  assert.equal(await page.locator('.area-nav [aria-current=page]').count(), 1);
  await page.locator('.area-nav a[href="#ricercaPanel"]').focus();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('amr:account', {detail:null})));
  assert.equal(await page.locator('#accountPanel').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '#accountPanel');
  // L'azzeramento delle righe non deve far perdere il focus prima della verifica.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('amr:account', {
    detail: {admin:true,moduli:[],aziendaValida:false} })));
  await page.locator('.area-nav a[href="#diagnosticaPanel"]').click();
  await page.waitForSelector('#aggiorna');
  await page.locator('#aggiorna').focus();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('amr:account', {detail:null})));
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '#accountPanel');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);

});
