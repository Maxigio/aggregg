#!/usr/bin/env node
/**
 * Imposta la password per l'accesso remoto (Funnel).
 * Uso:  node scripts/set-password.js "<password>"
 * Crea/aggiorna auth.json. Da fare UNA volta prima di accendere Funnel.
 */
const auth = require('../backend/auth');

const pw = process.argv[2];
if (!pw) {
  console.error('Uso: node scripts/set-password.js "<password>"');
  process.exit(1);
}
try {
  const p = auth.setPassword(pw);
  console.log('Password impostata. File:', p);
  console.log('Ora puoi accendere Funnel. L\'app chiederà il login (una volta per dispositivo).');
} catch (e) {
  console.error('Errore:', e.message);
  process.exit(1);
}
