#!/usr/bin/env node
/**
 * Cattura gli screenshot REALI dell'app per il deck-tutorial (F40).
 * Pilota l'app live a http://localhost:47321 via Playwright, fa login full,
 * esegue ricerche SOLO AUTO (Moto.it throttlato), salva PNG in docs/tutorial-assets.
 *
 * Uso: node scripts/capture-tutorial-shots.js
 * Ogni cattura è in try/catch isolato: un flusso che fallisce non blocca gli altri.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { resolveChromiumExecutable } = require('../backend/scrapers/utils');

const PW_BROWSERS = path.join(__dirname, '../pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = PW_BROWSERS;

const BASE = process.env.AMR_BASE || 'http://localhost:47321';
// review: MAI committare la password. Viene SOLO dall'env (il server è pubblico su :47321).
const PASSWORD = process.env.AMR_PW;
if (!PASSWORD) { console.error('Serve AMR_PW (password full) nell\'ambiente: AMR_PW=… node scripts/capture-tutorial-shots.js'); process.exit(1); }
const OUT = path.join(__dirname, '../docs/tutorial-assets');
fs.mkdirSync(OUT, { recursive: true });

const ok = [];
const ko = [];
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, name) });
  ok.push(name);
  console.log('  ✓', name);
};
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const step = async (name, fn) => {
  if (ONLY && !ONLY.has(name)) return;
  try { await fn(); }
  catch (e) { ko.push(`${name}: ${e.message}`); console.log('  ✗', name, '→', e.message); }
};

(async () => {
  const browser = await chromium.launch({
    executablePath: resolveChromiumExecutable(PW_BROWSERS),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  // tema dark (combacia col deck terminale)
  await ctx.addInitScript(() => { try { localStorage.setItem('amr_theme', 'dark'); } catch (_) {} });
  const page = await ctx.newPage();

  // ── 03 login (prima del login) ──
  await step('03-login', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#password', { timeout: 10000 });
    await page.waitForTimeout(500);
    await shot(page, '03-login.png');
  });

  // ── login full ──
  if (page.url().indexOf('/login') === -1) {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#password', { timeout: 10000 });
  }
  await page.fill('#password', PASSWORD);
  await Promise.all([
    page.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {}),
    page.click('button[type=submit]'),
  ]);
  await page.waitForTimeout(800);

  // ── 01 copertina (stato vuoto) ──
  await step('01-copertina', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await shot(page, '01-copertina.png');
  });

  // ── 04 cercare + filtri avanzati ──
  await step('04-cerca-filtri', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#advancedToggle', { timeout: 10000 });
    await page.click('#advancedToggle');
    await page.waitForTimeout(700);
    await shot(page, '04-cerca-filtri.png');
  });

  // ── 05 risultati (auto BMW 320d, bootstrap URL → doSearch) ──
  await step('05-risultati', async () => {
    await page.goto(`${BASE}/?tipo=auto&marca=BMW&modello=320d&prezzoMin=4000`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-info', { timeout: 60000 });
    await page.waitForTimeout(1000);
    await shot(page, '05-risultati.png');
  });

  // ── 06 raggruppa (chip Modello) ──
  await step('06-raggruppa', async () => {
    const chip = page.locator('#resultsToolbar').getByText('Modello', { exact: true }).first();
    await chip.click({ timeout: 5000 });
    await page.waitForTimeout(800);
    await shot(page, '06-raggruppa.png');
  });

  // ── 07 dettaglio inline (click ℹ prima riga) ──
  await step('07-dettaglio', async () => {
    await page.goto(`${BASE}/?tipo=auto&marca=BMW&modello=320d&prezzoMin=4000`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-info', { timeout: 60000 });
    await page.locator('.btn-info').first().click();
    await page.waitForTimeout(1600);
    await page.locator('.row-detail:not(.d-none)').first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, '07-dettaglio.png');
  });

  // ── 07b confronto (seleziona 3 annunci → Apri confronto) ──
  await step('07b-confronto', async () => {
    await page.goto(`${BASE}/?tipo=auto&marca=BMW&modello=320d&prezzoMin=4000`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-confronta', { timeout: 60000 });
    const cmp = page.locator('.btn-confronta');
    for (const i of [0, 1, 2]) { await cmp.nth(i).click().catch(() => {}); await page.waitForTimeout(150); }
    await page.click('#compareOpen', { timeout: 5000 });
    await page.waitForTimeout(1400);
    await shot(page, '07b-confronto.png');
  });

  // ── 08 valuta ──
  await step('08-valuta', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#modeToggle', { timeout: 10000 });
    await page.click('#modeToggle .mode-btn[data-mode="valuta"]');
    await page.waitForTimeout(400);
    // Auto a bassa varianza: il motore di valutazione è onesto (i modelli alto-volume
    // tipo 320d hanno range €1k-40k → mediana inaffidabile, vedi F34). Panda = range stretto.
    await page.fill('#marca', 'Jeep');
    await page.waitForTimeout(300);
    await page.fill('#modello', 'Renegade');
    await page.fill('#vAnno', '2018');
    await page.fill('#vKm', '70000');
    await page.fill('#vPrezzoMin', '7000');   // floor realistico (uso previsto del campo) → fascia onesta
    await page.fill('#vPrezzo', '13000');     // "il tuo prezzo" → mostra il verdetto sopra/in-linea/sotto
    await page.waitForTimeout(300);
    await page.click('#btnCerca');
    await page.waitForFunction(() => {
      const t = document.body.innerText.toLowerCase();
      return t.includes('valore di mercato') || t.includes('dati insufficienti') || t.includes('fascia');
    }, { timeout: 60000 });
    await page.waitForTimeout(800);
    await shot(page, '08-valuta.png');
  });

  // ── 09 salvati (offcanvas) ──
  await step('09-salvati', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.click('button:has(#salvatiCount)', { timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Ricerche")', { timeout: 5000 }).catch(() => {});   // tab con gli avvisi
    await page.waitForTimeout(900);
    await shot(page, '09-salvati.png');
  });

  await browser.close();
  console.log(`\n=== FATTO: ${ok.length} catturati, ${ko.length} falliti ===`);
  if (ko.length) console.log('Falliti:\n' + ko.map(x => '  - ' + x).join('\n'));
  console.log('Output:', OUT);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
