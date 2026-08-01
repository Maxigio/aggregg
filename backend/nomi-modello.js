'use strict';
/**
 * IL NOME DEL MODELLO SENZA LA GENERAZIONE — una regola, un posto.
 *
 * Subito attacca la generazione al nome del modello ("Golf 5ª serie", "Macan 1ªs.",
 * "Cayenne 2ªs.'10-'18", "Porter 1ª/2ª serie") e il catalogo tecnico quei nomi non li ha:
 * con il suffisso attaccato la scheda risponde "il catalogo non ha X" — non una scheda
 * incompleta, proprio niente.
 *
 * La stessa regola stava scritta in TRE file: qui (quella che gira in produzione, la piu'
 * debole delle tre), in scripts/build-subito-modelli.js e in scripts/build-catalogo-livelli.js.
 * Le due degli script avevano due cose in piu' che a quella viva mancavano:
 *   - il ciclo FINCHE' SMETTE DI CAMBIARE: i suffissi si accumulano ("Jazz 1ª serie 01-08",
 *     "Cayenne 3ªs.'17-->") e un passaggio solo ne toglieva uno e lasciava l'altro;
 *   - la lista di generazioni presa INTERA: "Porter 1ª/2ª serie" con la sola coda diventava
 *     "Porter 1ª/", cioe' spazzatura che non aggancia niente e non si legge nemmeno.
 *
 * Questa e' l'unione delle tre, e la usano tutte e tre.
 *
 * ATTENZIONE, la trappola gia' morsa: ordinale e punto NON possono essere entrambi
 * facoltativi. Con "\d+ s" nudo la regola decapita nomi di catalogo VERI che finiscono in
 * "<cifre> S" — "K 1200 S" diventa "K", "Monster 620 S" diventa "Monster" (misurato su
 * data/models.json: 90 nomi alterati, 28 famiglie Moto.it esatte perse). Serve almeno un
 * segnale della serie abbreviata: l'ordinale attaccato alla cifra, oppure il punto dopo la s.
 */

const REGOLE = [
  // "Serie 3 (E90/91)", "Giulia (2016)", "(07-10)" — dalla parentesi in poi.
  [/\s*\(.*$/, ''],
  // "Golf 5ª serie", "Golf 7a serie"
  [/\s+\d+[ªa°]?\s*serie\b.*$/i, ''],
  // La LISTA di generazioni: "Porter 1ª/2ª serie", "1ª-2ª s.", "1ª/2ª/3ª/4ª"
  [/\s*(\d+[ªa°]\s*[/-]\s*)*\d+[ªa°]\s*(serie|s\.?)?\s*$/i, ''],
  // La forma ABBREVIATA con l'ordinale o il punto: "Macan 1ªs.", "Picanto 2ª s.",
  // "C3 Aircross 1ª-2ª s." — mai "K 1200 S", che di segnali non ne ha nessuno.
  [/\s+\d+(?:[ªa°](?:\s*-\s*\d+[ªa°]?)?\s*s\.?|(?:\s*-\s*\d+[ªa°]?)?\s*s\.)(?:\s|$).*$/i, ''],
  /**
   * La coda di anni rimasta sola: "'19->", "15-24", "01-08", "'82-97", "2010-2018".
   *
   * Un anno e' due cifre (con o senza apostrofo) oppure quattro che iniziano per 19 o 20.
   * MAI tre: la versione degli script accettava `\d{2,4}` e mangiava le cilindrate —
   * "Serie 200-280(W123)" diventava "Serie" invece di "Serie 200-280" (misurato: 3 nomi
   * Mercedes su 7.556). Il numero di cifre e' l'unico segnale che distingue un intervallo
   * di anni da un intervallo di motori, e va preso sul serio.
   */
  [/\s*'?(?:\d{2}|(?:19|20)\d{2})\s*-+>?\s*'?(?:\d{2}|(?:19|20)\d{2})?\s*$/, ''],
];

function senzaGenerazione(nome) {
  let s = String(nome == null ? '' : nome).trim(), prima;
  do {
    prima = s;
    for (const [re, con] of REGOLE) s = s.replace(re, con);
    s = s.trim();
  } while (s !== prima && s.length);
  return s;
}

module.exports = { senzaGenerazione };

// self-check: `node backend/nomi-modello.js`
if (require.main === module) {
  const assert = require('node:assert');
  const casi = [
    ['Golf 5ª serie', 'Golf'],
    ['Macan 1ªs.', 'Macan'],
    ['Picanto 2ª s.', 'Picanto'],
    ['C3 Aircross 1ª-2ª s.', 'C3 Aircross'],
    ['Porter 1ª/2ª serie', 'Porter'],
    ['Cayenne 2ªs.\'10-\'18', 'Cayenne'],
    ['Jazz 1ª serie 01-08', 'Jazz'],
    ['Serie 3 (E90/91)', 'Serie 3'],
    ['Puma \'19->', 'Puma'],
    // NON si toccano: nomi veri che finiscono con cifre + S
    ['K 1200 S', 'K 1200 S'],
    ['Monster 620 S', 'Monster 620 S'],
    ['Golf', 'Golf'],
    // Tre cifre NON sono un anno: "200-280" e' un intervallo di motori, non di anni.
    ['Serie 200-280(W123)', 'Serie 200-280'],
    ['XJ/Sover/Daim\'82-97', 'XJ/Sover/Daim'],
    ['Fiesta 1ª/2ª serie', 'Fiesta'],
    ['Accord 3ª-4ª serie', 'Accord'],
  ];
  for (const [dentro, fuori] of casi) assert.strictEqual(senzaGenerazione(dentro), fuori, dentro);
  console.log(`OK — ${casi.length} casi`);
}
