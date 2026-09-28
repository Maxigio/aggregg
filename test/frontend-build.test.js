'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFrontendSync, frontendSourceSync } = require('../scripts/build-frontend');

test('il bundle conserva le icone prima dell’app e si compila', () => {
  const source = frontendSourceSync();
  assert.ok(source.js.indexOf('function icon(') >= 0);
  assert.ok(source.js.indexOf('function icon(') < source.js.indexOf('const form'));
  new Function(source.js);
  const built = buildFrontendSync();
  new Function(built.js);
  assert.ok(built.ver && built.css);
});
