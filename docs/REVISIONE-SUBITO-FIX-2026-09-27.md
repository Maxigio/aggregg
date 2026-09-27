# Subito — verifica e correzione degli undici finding

Baseline: `07c6972`, ramo `feat/ui-redesign-rating-grouping`.
Le correzioni sono nel working tree, senza commit o deploy. M2 non aggiornato.
Questa è una verifica dei finding elencati dall'utente, non una certificazione dell'intera applicazione.

## Esito delle proposte

| Finding e moduli | Risoluzione verificata | Prove ripetibili nel repository |
| --- | --- | --- |
| Recupero iniziale fallito blocca «Carica altro» — Auto/Moto | Accettati cursore 0 e selezione delle fonti anche sulla pagina 0. La prima pagina con recupero incompleto resta sospesa; il retry ripete solo il recupero, senza pubblicare metà pagina. | `test/paginazione-fonti.test.js`, `test/paginazione-ricerca.test.js`, `test/subito-retry-integrazione.test.js` |
| 403 interrotto o enorme perde lo status — tutti i moduli | Gli HTTP diversi da 200 sono classificati appena arrivano gli header, prima di chiudere il trasporto. Gli eventi successivi non sostituiscono l'errore già restituito. | `test/subito-trasporto.test.js` |
| Il download del 429 continua dopo il rigetto — Ricambi, Competitor, recupero | Il trasporto chiude la richiesta, preservando status e Retry-After. Verificato anche con ClientRequest/IncomingMessage reali e socket in memoria. | `test/subito-trasporto.test.js`, `test/fonti-429-trasporti.test.js` |
| Dopo ripetuti 403 la pausa resta a 15 minuti — tutti i moduli | Il blocco del tentativo di verifica viene registrato prima della pausa generica. La sequenza verificata è 15, 60, 360 minuti; resta ammessa una sola verifica concorrente, senza duplicare gli incrementi. | `test/fonti-ripartenza.test.js` |
| Il retry Subito ripete AutoScout riuscito — Auto/Moto | Chiave server distinta per fonte, con filtri conservati e cursori Subito esclusi solo dalle altre fonti. Inoltre le porzioni complete della pagina restano temporaneamente nel browser: anche dopo la scadenza della cache il retry chiede soltanto le fonti mancanti. | `test/paginazione-fonti.test.js`, `test/paginazione-ricerca.test.js`, `test/subito-retry-integrazione.test.js` |
| Risposta Competitor tardiva sostituisce la vista — Competitor | Identità della scelta, del contesto e della richiesta in corso. Il completamento può popolare la cache, ma solo la scelta corrente può sostituire la griglia. Coperti singolo, gruppo, selezione di cache e aggiunta tramite POST. | `test/competitor-ui.test.js` |
| Il PDF taglia oltre 2.000 righe — export condiviso | Oltre il limite il server risponde 400 con spiegazione; il browser mostra il messaggio e suggerisce CSV. Un export ammesso conserva tutte le righe. | `test/report-pdf-limite.test.js` |
| Prezzo sconosciuto diventa «trattabile» — Ricambi/export | Conservati i flag per prezzo su richiesta e illeggibile. Etichette distinte da prezzo assente; zero resta un numero. Allineati browser e compositore PDF lato server, senza esportare il testo grezzo del prezzo. | `test/ricambi-metadati.test.js`, `test/metadati-fonte-ui.test.js`, `test/report-pdf-limite.test.js` |
| Si perde la copertura della pagina — Ricambi | Propagati totale grezzo, troncatura, disponibilità di altre pagine e avvisi. Conteggio filtrato e totale fonte restano distinti; totale mancante resta null. UI e PDF dichiarano il limite alla prima pagina, senza altre richieste. | `test/ricambi-metadati.test.js`, `test/metadati-fonte-ui.test.js` |
| Si perdono gli avvisi sui prezzi illeggibili — Competitor | Gli avvisi attraversano aggregazione, rotte, cache e viste singola/gruppo. Restano separati da pagine cadute o interi annunci scartati; l'annuncio viene mantenuto. | `test/competitor-metadati.test.js`, `test/competitor-pausa-cache.test.js`, `test/metadati-fonte-ui.test.js` |
| Duplicati fra rami/pagine — Auto/Moto | Deduplica incrementale per fonte e ID stabile, URL come ripiego. Si conserva la prima copia, inclusa quella già pubblicata: un cambio prezzo non sovrascrive silenziosamente la griglia durante la paginazione. | `test/paginazione-ricerca.test.js` |

La proposta sulla cache server da sola era insufficiente: una pausa 429 può superare il suo TTL. La soluzione adottata conserva nel browser solo le righe **normalizzate** della pagina incompleta, cancellate al cambio del contesto. Non conserva un archivio delle risposte Hades grezze. La prova integrata attraversa le funzioni UI, l'handler Express, il core e il client Subito con trasporti controllati: dopo 503 e 429 e scadenza della cache, la pagina nativa e AutoScout non vengono richiesti nuovamente.

## Seconda revisione e controprove

La lettura indipendente del diff e nuove prove hanno rilevato e chiuso anche questi casi:

- **POST Competitor lento:** acquisire il token soltanto all'avvio del download era troppo tardi. Il token ora nasce al clic di aggiunta e attraversa il POST. Un'intenzione superata non sostituisce la cache o il download più recente della stessa vetrina.
- **Fonte esaurita in pausa:** un suo stato ricevuto insieme alla risposta di un'altra fonte non deve bloccare la pagina. Il controllo degli errori considera le fonti effettivamente richieste per quella pagina.
- **Recupero riuscito ma un'altra fonte ancora fallita:** i risultati Subito completati vengono conservati; il successivo retry chiede solo la fonte rimasta in errore, anche sulla pagina 0.
- **Successo vuoto dopo errore:** aggiorna i metadati della fonte e rimuove il vecchio avviso di errore, conservando gli annunci già pubblicati.
- **Avvisi PDF nascosti dal sottotitolo lungo:** riprodotto sul PDF effettivo. Gli avvisi hanno ora una tabella dedicata che va a capo e prosegue su altre pagine. Il nuovo campo è validato: massimo 10 avvisi e 4.000 caratteri complessivi; l'eccesso viene rifiutato, non tagliato. Il compositore lato server distingue anch'esso i diversi stati del prezzo.

Due test preesistenti simulavano un errore AutoScout senza dichiararlo fra le fonti ancora interrogabili. Le fixture ora aprono entrambe le fonti; le asserzioni sulla mancata pubblicazione e sul blocco restano invariate. Un test separato verifica la situazione opposta, fonte esaurita e non richiesta.

## Verifiche finali

- Suite interessata: **478 test passati, 0 falliti, 0 saltati**.
- Compatibilità del compositore `tabellaRicambi`: **1 test passato** nel file preesistente `test/whatsapp.test.js`; i due file operativi WhatsApp non sono stati modificati.
- Due PDF sintetici prodotti e controllati con estrazione del testo e ispezione delle pagine renderizzate: avvisi ordinari con sottotitolo lungo e avvisi su più pagine. Nessun avviso o ultima riga persi nei casi provati.
- `git diff --check` senza errori.

I test hanno usato directory temporanee per dati e log, con `dotenv.config` disattivato. Gli HTTP di prova erano locali o simulati; nessuna richiesta live alle piattaforme, nessuna lettura di credenziali reali. Alcuni test hanno richiesto l'esecuzione fuori dalla sandbox esclusivamente per aprire listener HTTP locali.

Comando della suite interessata, dalla radice del repository. Il preload assegna a ogni processo dati/log temporanei e disabilita il caricamento del `.env`:

```sh
mkdir -p /private/tmp/amr-fix-20260927
cat > /private/tmp/amr-fix-20260927/isolate.cjs <<'NODE'
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-fix-test-'));
process.env.USER_DATA_PATH = dir;
process.env.AMR_LOG_DIR = dir;
process.env.AMR_WHATSAPP = '0';
process.env.AMR_ASTE_LOCALE = '0';
const req = require('node:module').createRequire('/Volumes/MAIN/BananaChePrezzi-main/package.json');
req('dotenv').config = () => ({ parsed: {} });
NODE
NODE_OPTIONS=--require=/private/tmp/amr-fix-20260927/isolate.cjs node --test --test-reporter=tap \
  test/subito-*.test.js test/paginazione-*.test.js test/fonti-*.test.js \
  test/ricambi*.test.js test/competitor*.test.js test/metadati-fonte-ui.test.js \
  test/report-pdf-limite.test.js test/silenzi-fonti.test.js test/campi-fonte.test.js \
  test/versione-verifica.test.js test/versione-dedotta.test.js test/filtri-auto.test.js \
  test/ponte-buchi.test.js
```

Log di questa esecuzione: `/private/tmp/amr-fix-20260927/suite-finale.log`.
I file in `/private/tmp` sono temporanei; le regressioni ripetibili sono nei test elencati sopra.

## Limiti

Le prove confermano i comportamenti nei casi controllati, non la frequenza reale dei guasti del portale né l'assenza di altri difetti. Nessuna modifica alla selezione delle famiglie, alle query di ricerca, ai filtri di versione, al limite Hades di 808.290 byte o ai criteri privacy concordati. Non è stato svolto un collaudo grafico completo dell'app o un gate di rilascio sull'M2. La differenza di prezzo fra copie duplicate resta osservabile solo con una nuova ricerca: la paginazione conserva la prima copia.
