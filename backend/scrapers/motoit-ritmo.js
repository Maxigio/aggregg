'use strict';

// Un solo calendario per ricerca, menu e vetrine: ogni chiamata parte almeno
// 1,5 secondi dopo la precedente, anche con più ricerche contemporanee.
let prossimo = 0;
async function attendi({ signal, deadlineAt = Infinity } = {}) {
  const ora = Date.now();
  const mio = Math.max(ora, prossimo);
  if (signal?.aborted || mio >= deadlineAt) throw Object.assign(new Error('attesa Moto.it annullata o scaduta'), { kind: 'transient' });
  prossimo = mio + 1500;
  if (mio > ora) await require('node:timers/promises').setTimeout(mio - ora, undefined, { signal: signal || undefined });
}

module.exports = { attendi };
