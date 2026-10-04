'use strict';
const assert = require('node:assert/strict');
// I chiamanti sintetici seguono il protocollo esplicito; il server non accetta il vecchio login diretto.
async function finalizza(r, invia) {
  if (r.status !== 200) return r;
  const data = r.clone ? await r.clone().json() : JSON.parse(r.raw);
  if (!data.conferma) return r;
  assert.deepEqual(r.headers.getSetCookie ? r.headers.getSetCookie() : r.headers['set-cookie'] || [], []);
  const finale = await invia(data.conferma);
  finale.cookieContesto = r.cookieContesto;
  return finale;
}
module.exports = { finalizza };
