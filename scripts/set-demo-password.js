#!/usr/bin/env node
/**
 * Imposta la password DEMO (ospite read-only) per far provare l'app.
 * Uso:  node scripts/set-demo-password.js "<password>"
 * Read-modify-write su auth.json: preserva la password principale + il secret, quindi non fa
 * rifare il login a papà né alle persone con un nome. Chi era entrato con la VECCHIA password
 * demo invece esce subito — il suo cookie è firmato anche con la credenziale demo — ed è
 * proprio a questo che serve cambiarla. Richiede che la password principale esista già.
 * Chi entra con questa password può cercare e navigare, ma NON tocca il pannello
 * admin né le ricerche salvate (sola lettura, enforced server-side).
 */
const auth = require('../backend/auth');

const pw = process.argv[2];
if (!pw) {
  console.error('Uso: node scripts/set-demo-password.js "<password>"');
  process.exit(1);
}
try {
  const p = auth.setDemoPassword(pw);
  console.log('Password demo impostata. File:', p);
  console.log('Dalla a chi vuole provare: accesso in sola lettura (no admin, no salvataggi).');
} catch (e) {
  console.error('Errore:', e.message);
  process.exit(1);
}
