'use strict';
/**
 * La lettura del risultato del portale.
 *
 * Quello che conta e' che NON si perda un messaggio: se il CAPTCHA e' sbagliato o la
 * targa non esiste, il portale risponde una frase e quella frase e' la risposta — non
 * un errore nostro da nascondere.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { _leggiRisultato } = require('../backend/targa');
const fs = require('node:fs');
const path = require('node:path');

test('legge le coppie da una tabella', () => {
  const html = `<table><tr><th>Targa</th><td>AB123CD</td></tr>
    <tr><td>Classe ambientale:</td><td>Euro 6</td></tr>
    <tr><td>Data ultima revisione</td><td>12/2024</td></tr></table>`;
  const { coppie } = _leggiRisultato(html);
  assert.deepStrictEqual(coppie, [['Targa', 'AB123CD'], ['Classe ambientale', 'Euro 6'], ['Data ultima revisione', '12/2024']]);
});

test('legge anche le liste di definizione, che il portlet usa altrove', () => {
  const { coppie } = _leggiRisultato('<dl><dt>Classe ambientale</dt><dd>Euro 5</dd></dl>');
  assert.deepStrictEqual(coppie, [['Classe ambientale', 'Euro 5']]);
});

test('il messaggio del portale non si perde: e\' la risposta, non un errore', () => {
  // MARKUP VERO, preso dalla risposta del portale: non usa le classi standard di
  // Liferay. Cercando `portlet-msg-error` non si trovava niente e "Codice Captcha non
  // valido" spariva — la verifica sembrava muta quando invece aveva risposto.
  const { avvisi } = _leggiRisultato('<span id="captcha.errors" class="errore-desc">Codice Captcha non valido</span>');
  assert.deepStrictEqual(avvisi, ['Codice Captcha non valido']);
});

test('quello che il portlet AGGIUNGE si vede anche se non sappiamo che forma ha', () => {
  // La rete di sicurezza: non conosciamo il markup della risposta "trovato", ma la
  // pagina vuota si', quindi la differenza si legge comunque.
  const vuoto = '<p>Inserisci la targa</p><p>Tipo veicolo</p>';
  const dopo = '<p>Inserisci la targa</p><p>Tipo veicolo</p><p>Classe ambientale Euro 6</p>';
  const { nuove } = _leggiRisultato(dopo, vuoto);
  assert.deepStrictEqual(nuove, ['Classe ambientale Euro 6']);
  // senza la pagina vuota non si inventa niente
  assert.deepStrictEqual(_leggiRisultato(dopo).nuove, []);
});

test('niente coppie inventate da tabelle di impaginazione', () => {
  // tre celle = layout, non un dato: due sole celle sono una coppia
  const { coppie } = _leggiRisultato('<table><tr><td>a</td><td>b</td><td>c</td></tr></table>');
  assert.strictEqual(coppie.length, 0);
  // etichetta uguale al valore: non e' un dato
  assert.strictEqual(_leggiRisultato('<table><tr><td>x</td><td>x</td></tr></table>').coppie.length, 0);
});

test('le entita\' HTML tornano lettere', () => {
  const { coppie } = _leggiRisultato('<table><tr><td>Propriet&agrave;</td><td>S&igrave;</td></tr></table>');
  assert.deepStrictEqual(coppie, [['Proprietà', 'Sì']]);
});

test('la tabella del portale diventa etichetta→valore, non due elenchi in fila', () => {
  // FORMA VERA della risposta: una riga di intestazioni e una di valori, quattro colonne.
  // Leggendo solo le righe da due celle non si accoppiava niente e i dati uscivano come
  // "Tipo Veicolo / Targa / … / AUTOVEICOLO / … / EURO6 / 110": corretti e illeggibili.
  const html = '<table>'
    + '<tr><th>Tipo Veicolo</th><th>Targa</th><th>Compatibilit&agrave; Ambientale</th><th>Emissione CO2 (g/Km)</th></tr>'
    + '<tr><td>AUTOVEICOLO</td><td>XX000XX</td><td>EURO6</td><td>110</td></tr></table>';
  const { tabelle } = _leggiRisultato(html);
  assert.strictEqual(tabelle.length, 1);
  assert.deepStrictEqual(tabelle[0].intestazioni, ['Tipo Veicolo', 'Targa', 'Compatibilità Ambientale', 'Emissione CO2 (g/Km)']);
  assert.deepStrictEqual(tabelle[0].righe, [['AUTOVEICOLO', 'XX000XX', 'EURO6', '110']]);
});

test('piu\' righe di valori restano righe distinte', () => {
  const html = '<table><tr><th>Data</th><th>Esito</th></tr>'
    + '<tr><td>12/2024</td><td>Regolare</td></tr><tr><td>12/2022</td><td>Regolare</td></tr></table>';
  const { tabelle } = _leggiRisultato(html);
  assert.strictEqual(tabelle[0].righe.length, 2, 'due revisioni non si appiattiscono in una');
});

test('una tabella di sola impaginazione non diventa dati', () => {
  // colonne disallineate: si ripiega sulle righe a due celle, senza inventare accoppiamenti
  const { tabelle, coppie } = _leggiRisultato('<table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>x</td><td>y</td></tr></table>');
  assert.strictEqual(tabelle.length, 0);
  assert.deepStrictEqual(coppie, [['x', 'y']]);
});

test('la sfida si consuma PRIMA di partire: due invii insieme non bussano due volte al portale', async () => {
  // Il portale rigenera il CAPTCHA a ogni invio, quindi la sfida vale una volta sola — e
  // la cancellazione stava DOPO l'await: due invii concorrenti (doppio clic su «Verifica»)
  // passavano entrambi il `sfide.get(id)` e mandavano DUE richieste ad ACI con lo stesso
  // CAPTCHA. La seconda non poteva che fallire, e intanto si bussava due volte per una
  // verifica sola. E' la stessa forma di `throttle` e della sessione: chi ha osservato
  // prima non decide dopo.
  const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'targa.js'), 'utf8')
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const corpo = src.slice(src.indexOf('async function verifica('));
  const consuma = corpo.indexOf('sfide.delete(id)');
  const parte = corpo.indexOf('await chiamata(s.azione');
  assert.ok(consuma > 0 && parte > 0, 'verifica() non ha piu\' la forma attesa');
  assert.ok(consuma < parte,
    'la sfida va consumata PRIMA della chiamata al portale: dopo, due invii concorrenti passano entrambi');
});
