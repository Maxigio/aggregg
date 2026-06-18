'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { _motoitImages } = require('../backend/scrapers/detail');

const CDN = 'https://cdn-img.moto.it/images';

test('motoitImages: filename `image.jpg` (caso comune)', () => {
  const html = `
    <meta property="og:image" content="${CDN}/100/2000x/image.jpg?quality=75&format=webp&width=1200"/>
    <img src="${CDN}/100/2000x/image.jpg?width=300">
    <img src="${CDN}/101/2000x/image.jpg?width=300">
  `;
  const out = _motoitImages(html);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].thumb, `${CDN}/100/2000x/image.jpg?format=webp&width=300`);
  assert.strictEqual(out[0].full, `${CDN}/100/2000x/image.jpg?format=webp&width=1200`);
});

test('motoitImages: filename numerico-trattino (annunci premium/dealer — era 0 prima)', () => {
  const html = `
    <meta property="og:image" content="${CDN}/50400644/2000x/010407553-7559-332.jpg?format=webp&width=1200"/>
    <img src="${CDN}/50400644/2000x/010407553-7559-332.jpg">
    <img src="${CDN}/50400645/2000x/010407553-7559-205.jpg">
  `;
  const out = _motoitImages(html);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].thumb, `${CDN}/50400644/2000x/010407553-7559-332.jpg?format=webp&width=300`);
});

test('motoitImages: scarta editoriali (slug alfabetici) e crop SQUARE/', () => {
  const html = `
    <meta property="og:image" content="${CDN}/50400644/2000x/010407553-7559-332.jpg"/>
    <img src="${CDN}/50400644/2000x/010407553-7559-332.jpg">
    <img src="${CDN}/47197479/2000x/ducati-logo.jpg">
    <img src="${CDN}/20270235/2000x/v4-hp.jpg">
    <img src="${CDN}/30349852/SQUARE/2000x/my23_ducati_high-jpg.jpg">
  `;
  const out = _motoitImages(html);
  assert.strictEqual(out.length, 1, 'solo la foto-annuncio, niente logo/press/SQUARE');
  assert.match(out[0].thumb, /50400644/);
});

test('motoitImages: dedup per id e cap 10', () => {
  let html = '';
  for (let i = 0; i < 15; i++) html += `<img src="${CDN}/${900 + i}/2000x/image.jpg">`;
  html += `<img src="${CDN}/900/2000x/image.jpg">`;   // duplicato id 900
  const out = _motoitImages(html);
  assert.strictEqual(out.length, 10, 'cap 10');
  const ids = out.map(o => o.thumb.match(/images\/(\d+)\//)[1]);
  assert.strictEqual(new Set(ids).size, ids.length, 'nessun id duplicato');
});

test('motoitImages: nessuna foto → array vuoto', () => {
  assert.deepStrictEqual(_motoitImages('<html><body>niente</body></html>'), []);
});
