const { chromium } = require('playwright');
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../pw-browsers');
(async () => {
  const browser = await chromium.launch({
    executablePath: path.join(__dirname, '../pw-browsers/chromium-1217/chrome-win64/chrome.exe'),
    headless: false
  });
  const pg = await browser.newPage();
  await pg.goto('https://www.moto.it/moto-usate/ducati', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r=>setTimeout(r,2500));
  const info = await pg.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    const inline = scripts.filter(s => !s.src && s.textContent && s.textContent.length > 200);
    const summaries = inline.map(s => {
      const t = s.textContent;
      return {
        len: t.length,
        hasPrice: /"price"|"prezzo"/i.test(t),
        hasListing: /listing|annunci|mcard/i.test(t),
        hasJsonBlock: /\[\s*\{/.test(t),
        firstChars: t.slice(0, 180).replace(/\s+/g,' '),
      };
    });
    const visibleNums = [...document.body.textContent.matchAll(/(\d{1,5})\s+(annunci|moto|risultati)/gi)].slice(0,6).map(m=>m[0]);
    return { total: scripts.length, inline: inline.length, summaries, visibleNums };
  });
  console.log('Script tot:', info.total, 'inline big:', info.inline);
  info.summaries.slice(0, 15).forEach((s,i)=>console.log(`[${i}] len=${s.len} price=${s.hasPrice} listing=${s.hasListing} jsonArr=${s.hasJsonBlock} :: ${s.firstChars.slice(0, 120)}`));
  console.log('\nNumeri in pagina:', info.visibleNums);
  await browser.close();
})().catch(e=>console.error(e));
