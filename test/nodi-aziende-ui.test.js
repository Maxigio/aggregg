'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright');
const { creaCentro } = require('../backend/nodi/centro');

const browserPath = process.env.AMR_TEST_CHROMIUM || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
test('UI account nel centro: Admin, invito, idempotenza, cliente e logout senza collisioni DOM',
  { skip: !fs.existsSync(browserPath) && 'Chromium non disponibile: impostare AMR_TEST_CHROMIUM' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-account-ui-'));
  const server = require('node:http').createServer().listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const origine = 'http://127.0.0.1:' + server.address().port;
  let aziendeRoute, operazioni = [], failElenco = false, elencoCount = 0, token = 'a'.repeat(64), invitoPersistente = null;
  const centro = creaCentro({ directory: dir, tokens: { locale: 'a'.repeat(64) }, adminLocale: true,
    inizializzaAccessi: app => {
      const accessi = require('../backend/nodi/login-nhost-prova').mount(app, { origine, cookiePath: '/',
        client: { login: async () => ({ mfa: { ticket: 'ticket-sintetico' } }),
          mfa: async () => ({ session: { user: { id: 'admin', emailVerified: true },
            accessToken: 'sintetico', refreshToken: 'sintetico' } }), logout: async () => {} },
        identita: async () => ({ attiva: true, admin: true, epoca: 0 }) });
      aziendeRoute = require('../backend/nodi/aziende-prova-route').mount(app, { origine, accessi,
        account: { elenco: async () => {
          elencoCount++;
          if (failElenco) throw Object.assign(new Error('KO sintetico'), { status: 503 });
          return { aziende: [{ id: 'cliente', nome: '<script>errore()</script>', stato: 'accettato' },
            ...(invitoPersistente ? [{id:invitoPersistente.id,nome:invitoPersistente.nome,stato:'pending'}] : [])] };
        }, invita: async (s, b) => {
          if (invitoPersistente && b.operazione !== invitoPersistente.operazione) {
            throw Object.assign(new Error('invito_esistente'), {status:409,codice:'invito_esistente'});
          }
          if (invitoPersistente && JSON.stringify(b) !== JSON.stringify(invitoPersistente)) {
            throw Object.assign(new Error('operazione_in_conflitto'), {status:409,codice:'operazione_in_conflitto'});
          }
          invitoPersistente = {...b}; return {ok:true,token};
        },
        attiva: async (s, b) => { operazioni.push(b.operazione); return { ok: true }; },
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
  await page.locator('#account-invita input[name=email]').fill('ref@amr.invalid');
  await page.locator('#account-invita button').click();
  await page.waitForSelector('#account-consegna a');
  assert.match(await page.locator('#account-stato').textContent(), /non inviato/);
  const primoLink = await page.locator('#account-consegna a').getAttribute('href');
  // Ricaricare perde l'operazione nel browser, ma non deve bloccare l'invito esistente.
  await page.reload(); await page.waitForSelector('.area-nav a[href="#accountPanel"]:not([hidden])');
  await page.locator('.area-nav a[href="#accountPanel"]').click();
  await page.waitForSelector('#account-admin:not([hidden])');
  await page.locator('#account-invita input[name=email]').fill('ref@amr.invalid');
  await page.locator('#account-invita button').click();
  await page.waitForSelector('#account-consegna a');
  assert.equal(await page.locator('#account-consegna a').getAttribute('href'), primoLink);
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
  await page.locator('.area-nav a[href="#accountPanel"]').click();
  await page.locator('#account-esci').click();
  await page.waitForFunction(() => document.getElementById('account-esci').hidden);
  assert.equal(await page.locator('#account-admin').isVisible(), false);
  assert.equal(await page.locator('#account-aziende').textContent(), '');
  assert.equal(await page.locator('#account-consegna').textContent(), '');
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
