'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
function estrai(da, fino) {
  const start = APP.indexOf(da);
  const end = APP.indexOf(fino, start);
  assert.ok(start >= 0 && end > start, `Blocco frontend mancante: ${da}`);
  return APP.slice(start, end);
}
const fonti = estrai('const SOURCE_STATUS =', '// ─── Spec (dettaglio)');
const ricambi = estrai('function renderRicambiPanel()', '// Toolbar rispecchiata');
const escape = estrai('function escapeHtml(str)', '\n/**');
const ORA = new Date(2026, 8, 23, 10, 0).getTime();
class Orologio extends Date {
  constructor(...args) { super(...(args.length ? args : [ORA])); }
  static now() { return ORA; }
}
const traDueOre = ORA + 2 * 60 * 60 * 1000;
const pausa = { fermo: true, fino: traDueOre, verifica: false };

function schermo(sources = {}, articoli = []) {
  const panel = { innerHTML: '', dataset: {}, querySelector: () => null };
  const vietato = () => { throw new Error('La UI non deve avviare rete o timer'); };
  const c = vm.createContext({
    Date: Orologio, fetch: vietato, setTimeout: vietato, setInterval: vietato,
    fonteBreakdown: { innerHTML: '' }, lastSources: sources, paginaErrore: null,
    FONTE_LABEL: { subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it' },
    RC_FONTE: { subito: 'Subito.it' },
    document: { getElementById: id => { assert.equal(id, 'ricambiPanel'); return panel; } },
    rcData: { sources, articoli }, rcVeicolo: 'auto', rcRestanti: null,
    confrontoRicambi: [], rcCompareOpen: false, rcGroupDim: '',
    stopLoadingTips() {}, rcSchedaHTML: () => '', budgetHTML: () => '', rcToolbarHTML: () => '',
    rcVisibleArts: () => articoli, rcBestKey: () => null,
    rcRowHTML: () => '<div>Offerta ricambio</div>', rcGridHeadHTML: () => '',
  });
  vm.runInContext([escape, fonti, ricambi].join('\n'), c);
  return { c, panel };
}

test('cooldown: orario locale, data solo se diversa da oggi, nessuna promessa di successo', () => {
  const { c } = schermo();
  const oggi = c.fontePausaHTML('Subito.it', pausa);
  const orario = new Date(traDueOre).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  assert.match(oggi, /Fonte Subito\.it: richieste sospese\./);
  assert.ok(oggi.includes(`Potrai riprovare dalle ${orario}; la disponibilità sarà verificata alla prossima richiesta.`));
  assert.doesNotMatch(oggi, / del /);
  const domani = new Date(2026, 8, 24, 0, 15).getTime();
  assert.ok(c.fontePausaHTML('Moto.it', { ...pausa, fino: domani })
    .includes(`del ${new Date(domani).toLocaleDateString('it-IT')}`));
});

test('pausa scaduta e verifica distinguono un prossimo tentativo da una verifica in corso', () => {
  const { c } = schermo();
  for (const stato of [
    { ...pausa, fino: ORA - 1 }, { ...pausa, fino: ORA },
    { fermo: false, fino: null, verifica: true },
  ]) {
    assert.match(c.fontePausaHTML('Autoscout24', stato),
      /Pausa terminata: la prossima richiesta verificherà se Autoscout24 è nuovamente disponibile\./);
  }
  assert.match(c.fontePausaHTML('Autoscout24', { ...pausa, fino: ORA - 1, verifica: true }),
    /Verifica della disponibilità di Autoscout24 in corso\./);
  assert.equal(c.fontePausaHTML('Subito.it', null), '');
  assert.equal(c.fontePausaHTML('Subito.it', { fermo: false, fino: null, verifica: false }), '');
});

test('scadenze non numeriche, non positive o fuori dal calendario non vengono mostrate', () => {
  const { c } = schermo();
  for (const fino of [null, undefined, '', String(traDueOre), '<img src=x>', NaN, Infinity, -Infinity, 0, -1, 1e20]) {
    const html = c.fontePausaHTML('Subito.it', { ...pausa, fino });
    assert.match(html, /richieste sospese\. La disponibilità sarà verificata alla prossima richiesta\./);
    assert.doesNotMatch(html, /Invalid Date|NaN|Infinity|dalle|<img|Pausa terminata/);
  }
});

test('Auto/Moto: tutte le fonti mostrano la pausa anche se skipped, vuote, bloccate o parziali', () => {
  for (const fonte of ['subito', 'autoscout', 'moto']) {
    for (const status of ['skipped', 'blocked', 'empty', 'error', 'timeout', 'ok']) {
      const { c } = schermo({ [fonte]: { status, count: 1, pausa, parziale: 'Risposta parziale' } });
      c.renderSourceStatus();
      assert.ok(c.fonteBreakdown.innerHTML.includes(`Fonte ${c.FONTE_LABEL[fonte]}: richieste sospese.`));
      if (status === 'ok' || status === 'error') assert.match(c.fonteBreakdown.innerHTML, /Risposta parziale/);
    }
  }
});

test('Ricambi: pausa visibile con e senza offerte e per ogni stato della fonte', () => {
  for (const status of ['skipped', 'blocked', 'empty', 'error', 'timeout', 'ok']) {
    for (const articoli of [[], [{ fonte: 'subito' }]]) {
      const { c, panel } = schermo({ subito: { status, pausa, reason: 'Motivo precedente' } }, articoli);
      c.renderRicambiPanel();
      assert.match(panel.innerHTML, /Fonte Subito\.it: richieste sospese\./);
      if (status === 'blocked') assert.match(panel.innerHTML, /Motivo precedente/);
      if (articoli.length) assert.match(panel.innerHTML, /Offerta ricambio/);
    }
  }
  const { c, panel } = schermo({ subito: { status: 'skipped', pausa: { ...pausa, fino: ORA - 1 } } });
  c.renderRicambiPanel();
  assert.match(panel.innerHTML, /Pausa terminata: la prossima richiesta verificherà/);
});

test('escape: nomi nelle pause e motivi skipped sconosciuti non diventano HTML', () => {
  const payload = '<img src=x onerror="alert(1)">&';
  const { c, panel } = schermo({ subito: { status: 'skipped', reason: payload, pausa } });
  const escaped = c.escapeHtml(payload);
  assert.ok(c.fontePausaHTML(payload, pausa).includes(escaped));
  c.renderSourceStatus();
  assert.ok(c.fonteBreakdown.innerHTML.includes(escaped));
  assert.doesNotMatch(c.fonteBreakdown.innerHTML, /<img/);
  c.RC_FONTE.subito = payload;
  c.renderRicambiPanel();
  assert.ok(panel.innerHTML.includes(escaped));
  assert.doesNotMatch(panel.innerHTML, /<img/);
});

test('senza metadati pausa: conservati motivi noti, avvisi parziali e di allargamento', () => {
  const { c, panel } = schermo({
    subito: { status: 'skipped', reason: 'in pausa dopo un blocco' },
    autoscout: { status: 'ok', count: 2, totale: 20, allargato: 'marca', reason: 'Modello <allargato>' },
    moto: { status: 'error', parziale: 'Fonte <parziale>' },
  });
  c.renderSourceStatus();
  assert.match(c.fonteBreakdown.innerHTML, /Subito\.it <b>in pausa<\/b>/);
  assert.match(c.fonteBreakdown.innerHTML, /Modello &lt;allargato&gt;/);
  assert.match(c.fonteBreakdown.innerHTML, /Fonte &lt;parziale&gt;/);
  assert.doesNotMatch(c.fonteBreakdown.innerHTML, /richieste sospese|Pausa terminata|verificata alla prossima/);
  c.renderRicambiPanel();
  assert.doesNotMatch(panel.innerHTML, /richieste sospese|Pausa terminata|verificata alla prossima/);
});

const annuncio = (n = 1) => ({ fonte: 'moto', url: `https://www.moto.it/annuncio-${n}` });
const detailKo = (fonte = 'moto', stato = pausa) => ({ ok: false, error: 'Fonte <bloccata>', fonte, pausa: stato });
const risposta = data => ({ ok: data.ok, status: data.ok ? 200 : 502, json: async () => data });
function dettagli(sources, risultati = [annuncio()]) {
  const { c } = schermo(sources);
  const avvisi = [], miniature = [];
  let matrici = 0;
  Object.assign(c, {
    searchGen: 1, currentResults: risultati, confronto: [], matrixList: risultati,
    cmatrixPanel: { classList: { contains: () => false } }, hasSpec: () => false,
    toast: testo => avvisi.push(testo), updateRowThumb: url => miniature.push(url),
    renderMatrix: () => { matrici++; }, fetch: async () => risposta(detailKo()),
  });
  vm.runInContext([
    estrai('function trovaResult(url)', '// Aggiorna SOLO'),
    estrai('async function enrichMotoRow(url)', '\nfunction updateRowThumb'),
    estrai('async function enrichMotoSpecs(list)', '// ─── Segnalazioni'),
  ].join('\n'), c);
  return { c, avvisi, miniature, matrici: () => matrici };
}

test('detail HTTP 502: pausa persistente per ogni fonte senza perdere i dati della ricerca', async () => {
  for (const fonte of ['subito', 'autoscout', 'moto']) {
    const stato = { status: 'ok', count: 3, totale: 42, reason: 'Annotazione precedente' };
    const { c, avvisi } = dettagli({ [fonte]: stato });
    c.fetch = async () => risposta(detailKo(fonte));
    await c.enrichMotoRow(c.currentResults[0].url);
    assert.strictEqual(c.lastSources[fonte].pausa, pausa);
    for (const [k, v] of Object.entries(stato)) assert.equal(c.lastSources[fonte][k], v);
    assert.match(c.fonteBreakdown.innerHTML, /richieste sospese/);
    assert.equal(c.currentResults[0]._enriched, undefined);
    assert.equal(avvisi.length, 0, 'la ricerca ha già un avviso persistente');
    c.renderSourceStatus();
    assert.match(c.fonteBreakdown.innerHTML, /richieste sospese/);
  }
});

test('detail senza pausa attiva: il messaggio upstream rimane visibile ed escaped', async () => {
  const { c } = dettagli({ moto: { status: 'ok', count: 1 } });
  c.fetch = async () => risposta(detailKo('moto', { fermo: false, fino: null, verifica: false }));
  await c.enrichMotoSpecs(c.matrixList);
  assert.match(c.fonteBreakdown.innerHTML, /Dettagli Moto\.it: Fonte &lt;bloccata&gt;/);
  assert.doesNotMatch(c.fonteBreakdown.innerHTML, /<bloccata>/);
  assert.equal(c.currentResults[0]._detailLoaded, undefined);
});

test('Competitor: dettaglio e confronto concorrenti producono un solo toast per fonte e stato', async () => {
  const { c, avvisi } = dettagli(null, [annuncio(1), annuncio(2), annuncio(3)]);
  await Promise.all([c.enrichMotoRow(c.currentResults[0].url), c.enrichMotoSpecs(c.matrixList)]);
  assert.equal(avvisi.length, 1);
  assert.match(avvisi[0], /Fonte Moto\.it: richieste sospese/);
  assert.equal(c.lastSources, null);
  await c.enrichMotoSpecs(c.matrixList);
  assert.equal(avvisi.length, 1, 'la stessa pausa non riavvia una raffica di toast');
  c.fetch = async () => risposta(detailKo('moto', { ...pausa, fino: traDueOre + 60000 }));
  await c.enrichMotoSpecs(c.matrixList);
  assert.equal(avvisi.length, 2, 'un cambiamento di pausa va comunicato');
  c.searchGen++;
  await c.enrichMotoSpecs(c.matrixList);
  assert.equal(avvisi.length, 3, 'il nuovo contesto può ricevere il proprio avviso');
});

test('detail tardivo: un cambio contesto blocca avvisi, merge e ridisegni anche con lo stesso oggetto', async () => {
  for (const metodo of ['enrichMotoRow', 'enrichMotoSpecs']) {
    for (const data of [detailKo(), { ok: true, detail: { cilindrata: 900 } }]) {
      const { c, avvisi, miniature, matrici } = dettagli(null);
      const originale = c.currentResults[0];
      let completa;
      c.fetch = () => new Promise(resolve => { completa = resolve; });
      const pending = c[metodo](metodo === 'enrichMotoRow' ? originale.url : c.matrixList);
      c.searchGen++; // il confronto può conservare lo stesso annuncio fra due contesti
      const nuoveFonti = { moto: { status: 'empty' } };
      c.lastSources = nuoveFonti;
      completa(risposta(data));
      await pending;
      assert.deepEqual(c.lastSources, { moto: { status: 'empty' } });
      assert.equal(c.fonteBreakdown.innerHTML, '');
      assert.equal(originale.cilindrata, undefined);
      assert.equal(avvisi.length, 0);
      assert.equal(miniature.length, 0);
      assert.equal(matrici(), 0);
    }
  }
});

test('detail tardivo: lo stesso URL con un oggetto diverso non appartiene alla richiesta originale', async () => {
  for (const metodo of ['enrichMotoRow', 'enrichMotoSpecs']) {
    const { c, avvisi } = dettagli(null);
    let completa;
    c.fetch = () => new Promise(resolve => { completa = resolve; });
    const originale = c.currentResults[0];
    const pending = c[metodo](metodo === 'enrichMotoRow' ? originale.url : c.matrixList);
    c.currentResults = [{ ...originale }];
    c.matrixList = c.currentResults;
    completa(risposta(detailKo()));
    await pending;
    assert.equal(avvisi.length, 0);
    assert.equal(c.lastSources, null);
  }
});

test('errori ordinari restano silenziosi e ritentabili; i dettagli riusciti si uniscono ancora', async () => {
  for (const metodo of ['enrichMotoRow', 'enrichMotoSpecs']) {
    const { c, avvisi } = dettagli({ moto: { status: 'ok', count: 1 } });
    const r = c.currentResults[0];
    const arg = metodo === 'enrichMotoRow' ? r.url : c.matrixList;
    c.fetch = async () => risposta({ ok: false, error: 'Errore ordinario' });
    await c[metodo](arg);
    assert.equal(c.fonteBreakdown.innerHTML, '');
    assert.equal(avvisi.length, 0);
    assert.equal(r._enriched, undefined);
    assert.equal(r._detailLoaded, undefined);
    c.fetch = async () => risposta({ ok: true, detail: { cilindrata: 900 } });
    await c[metodo](arg);
    assert.equal(r.cilindrata, 900);
    assert.equal(r[metodo === 'enrichMotoRow' ? '_enriched' : '_detailLoaded'], true);
  }
});

test('detail riuscito: sincronizza la pausa e cancella il vecchio errore senza cambiare stato o conteggi', async () => {
  for (const metodo of ['enrichMotoRow', 'enrichMotoSpecs']) {
    for (const pausaDopo of [{ fermo: false, fino: null, verifica: false }, pausa]) {
      const { c, avvisi } = dettagli({ moto: { status: 'empty', count: 0, totale: 42 } });
      const arg = metodo === 'enrichMotoRow' ? c.currentResults[0].url : c.matrixList;
      await c[metodo](arg);
      assert.match(c.fonteBreakdown.innerHTML, /richieste sospese/);
      assert.equal(c.lastSources.moto.erroreDettaglio, 'Fonte <bloccata>');
      c.fetch = async () => risposta({ ok: true, detail: { cilindrata: 900 }, fonte: 'moto', pausa: pausaDopo });
      await c[metodo](arg);
      assert.strictEqual(c.lastSources.moto.pausa, pausaDopo);
      assert.equal(c.lastSources.moto.erroreDettaglio, null);
      assert.equal(c.lastSources.moto.status, 'empty');
      assert.equal(c.lastSources.moto.count, 0);
      assert.equal(c.lastSources.moto.totale, 42);
      assert.equal(avvisi.length, 0);
      assert.doesNotMatch(c.fonteBreakdown.innerHTML, /bloccata/);
      if (pausaDopo.fermo) assert.match(c.fonteBreakdown.innerHTML, /richieste sospese/);
      else assert.doesNotMatch(c.fonteBreakdown.innerHTML, /richieste sospese|Dettagli Moto/);
    }
  }
});

test('Competitor: successo senza pausa non produce toast, successo in cache con pausa avvisa ancora', async () => {
  for (const pausaDopo of [undefined, null, { fermo: false, fino: null, verifica: false }, pausa]) {
    const { c, avvisi } = dettagli(null);
    c.fetch = async () => risposta({ ok: true, detail: { cilindrata: 900 }, fonte: 'moto', pausa: pausaDopo });
    await c.enrichMotoRow(c.currentResults[0].url);
    assert.equal(avvisi.length, pausaDopo?.fermo ? 1 : 0);
    if (avvisi.length) assert.match(avvisi[0], /richieste sospese/);
  }
});

test('Competitor: cache mantenuta durante la pausa mostra un avviso testuale', () => {
  const c = vm.createContext({
    cpChiave: () => 'subito:1', cpParchi: { 'subito:1': { stato: 'ok', dati: { numeri: {}, avvisoCache: 'Fonte in pausa <img onerror=alert(1)>. Dati non aggiornati.' } } },
    cpApertoId: null, cpAperte: new Set(), FONTE_LABEL: { subito: 'Subito' },
    cpNumeriChiave: () => 'NUMERI PRESENTI', cpUnisciHTML: () => '', cpOrariHTML: () => '', miniHTML: () => '',
  });
  vm.runInContext(escape + '\n' + estrai('function cpSchedaHTML(v)', '\nfunction '), c);
  const html = c.cpSchedaHTML({ fonte: 'subito', id: '1', nome: 'Vetrina' });
  assert.match(html, /Dati non aggiornati/); assert.match(html, /NUMERI PRESENTI/);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img onerror/);
});

test('avviso di pagina interrotta: testo del server escapato prima di inserirlo nel DOM', () => {
  const { c } = schermo({ subito: { status: 'ok', count: 10 } });
  c.paginaErrore = { testo: '<img src=x onerror=alert(1)>', riprovabile: true };
  c.renderSourceStatus();
  assert.match(c.fonteBreakdown.innerHTML, /&lt;img/);
  assert.doesNotMatch(c.fonteBreakdown.innerHTML, /<img src=x/);
});
