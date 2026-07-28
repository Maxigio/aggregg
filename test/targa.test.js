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
