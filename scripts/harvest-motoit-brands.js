#!/usr/bin/env node
/**
 * Harvest degli slug brand REALI di Moto.it → data/motoit-brands.json
 *
 * Perché: la ricerca Moto.it usa /moto-usate/ricerca?brand=<slug>, ma lo slug
 * non coincide col nome marca del catalogo (es. catalogo "Beta" → Moto.it
 * "betamotor"). Niente slug inventati: li prendiamo dalla fonte.
 *
 * Strategia (in ordine di preferenza):
 *   1) <select> marca nel motore di ricerca /moto-usate/ricerca (lista completa)
 *   2) fallback: anchor /moto-usate/<slug> sulla landing /moto-usate
 *
 * Uso:  node scripts/harvest-motoit-brands.js
 * Output: data/motoit-brands.json = [{ "name": "Betamotor", "slug": "betamotor" }, …]
 */
const path = require('path');
const fs   = require('fs');
const { chromium } = require('playwright');
const { resolveChromiumExecutable } = require('../backend/scrapers/utils');

const BASE = 'https://www.moto.it';
const PW_BROWSERS = path.join(__dirname, '..', 'pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = PW_BROWSERS;
const OUT = path.join(__dirname, '..', 'data', 'motoit-brands.json');

// Slug validi: un solo segmento, non sezioni note
const RESERVED = new Set(['ricerca', 'pagina', 'preferiti', 'concessionari', 'recensioni', 'listino', 'novita']);
const isBrandSlug = s => /^[a-z0-9][a-z0-9-]*$/.test(s) && !RESERVED.has(s) && !/^pagina-/.test(s);

async function harvest() {
  const browser = await chromium.launch({
    executablePath: resolveChromiumExecutable(PW_BROWSERS),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
  });
  const page = await ctx.newPage();
  const byName = new Map();   // name → slug (dedup, ultimo vince)

  // ── Strategia 1: <select> marca nella ricerca ──────────────────────────────
  try {
    await page.goto(`${BASE}/moto-usate/ricerca`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const opts = await page.$$eval('select option', els => els.map(o => ({
      value: (o.value || '').trim(),
      label: (o.textContent || '').trim(),
    })));
    for (const o of opts) {
      // value può essere lo slug, oppure "brand|slug" — prendi l'ultimo segmento
      const slug = (o.value.includes('|') ? o.value.split('|').pop() : o.value).toLowerCase();
      if (o.label && isBrandSlug(slug)) byName.set(o.label, slug);
    }
    console.log(`[harvest] da <select>: ${byName.size} marche`);
  } catch (e) {
    console.warn('[harvest] select non disponibile:', e.message);
  }

  // ── Strategia 2: anchor /moto-usate/<slug> sulla landing ───────────────────
  try {
    await page.goto(`${BASE}/moto-usate`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const anchors = await page.$$eval('a[href*="/moto-usate/"]', els => els.map(a => ({
      href: a.getAttribute('href') || '',
      text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
    })));
    for (const a of anchors) {
      const m = a.href.match(/\/moto-usate\/([a-z0-9-]+)\/?$/i);
      if (!m) continue;
      const slug = m[1].toLowerCase();
      if (isBrandSlug(slug) && a.text && a.text.length <= 40 && !byName.has(a.text)) {
        byName.set(a.text, slug);
      }
    }
    console.log(`[harvest] dopo landing: ${byName.size} marche totali`);
  } catch (e) {
    console.warn('[harvest] landing non disponibile:', e.message);
  }

  await browser.close();

  const list = [...byName.entries()]
    .map(([name, slug]) => ({ name, slug }))
    .sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));

  if (list.length === 0) {
    console.error('[harvest] ERRORE: nessuna marca trovata, non sovrascrivo il file.');
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify(list, null, 2) + '\n');
  console.log(`[harvest] scritte ${list.length} marche in ${path.relative(process.cwd(), OUT)}`);
}

harvest().catch(err => { console.error('[harvest] fallito:', err); process.exit(1); });
