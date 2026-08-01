# Ripresa lavori — bonifica AMR (2026-08-01)

Questo file esiste per una ragione sola: **chi riprende deve poter ricominciare senza
ricostruire niente**. Contiene le decisioni prese dal proprietario, cosa è già chiuso, cosa
resta, e come si lavora.

---

## 1. Da dove nasce tutto

Un'analisi a tappeto del repo (33 sonde per area e per lente, poi verifica avversariale) ha
prodotto **164 problemi confermati** in due giri:

| giro | trovati | confermati | refutati | non più attuali |
|---|---|---|---|---|
| primo | 173 distinti | **68** | 10 | — |
| secondo (i 93 rimasti) | 93 | **71** | 14 | 8 |

Gli elenchi completi, con file, riga, prova e scenario di innesco, stanno in:

- `docs/problemi/confermati-primo-giro.json`
- `docs/problemi/confermati-secondo-giro.json`

Ogni voce ha `titolo`, `file`, `riga`, `gravita`, `descrizione`, `prova`, `innesco`.
**Prima di lavorare su una voce, rileggere il codice**: molte sono state chiuse e i file sono
cambiati parecchio.

I problemi non sono lavori indipendenti: cadono in **sette famiglie**, e chiudere la famiglia
estingue anche i casi che nessuno aveva ancora guardato.

---

## 2. Le regole di prodotto decise dal proprietario

Queste valgono per tutti i fix, non solo per quelli in cui sono state decise.

**Dottrine di sempre (non sono difetti, non segnalarle):**
- *"se svuota, si ignora"*: un filtro che azzererebbe i candidati viene scartato;
- *"marcare, non nascondere"*: ciò che la fonte risponde si mostra, marcato, mai buttato;
- **niente fallback** e **niente post-filtri che nascondono risultati**;
- robots.txt **non** è un vincolo per questo progetto (decisione dichiarata del proprietario):
  mai proporre licenze, termini di servizio o accordi commerciali;
- i cataloghi sorgente in `data/` non si modificano: le correzioni vanno in file nuovi.

**Metro di verità:** conta l'annuncio reale sul portale, non quello che la ricerca interna del
portale riesce a trovare. Se AMR trova veicoli che il sito non trova, è un pregio. È un
difetto: mostrare un veicolo sbagliato senza dirlo, perdere annunci che esistono, far passare
una fonte muta per un mercato vuoto, mostrare un numero che non corrisponde alla fonte.

**Decisioni prese in intervista il 2026-08-01:**

- **Scheda tecnica**: si compone sul modello che l'**annuncio dichiara**, mai su quello
  cercato. Se l'annuncio non dichiara il modello ma dichiara la marca, si **chiede** (elenco
  modelli di quella marca) invece di indovinare.
- **Prezzo**: il rettificato (commissione, spese, margine, IVA) vale in **ogni** punto
  dell'app, con l'etichetta che lo dice. Mai due prezzi per lo stesso annuncio.
- **IVA**: lo scorporo 22% solo sugli annunci che **dichiarano** l'IVA esposta. Dove la fonte
  tace, colonne vuote.
- **Dettagli Moto.it**: nessun arricchimento allo scorrimento, si chiedono **al clic**.
- **Avvisi salvati**: restano **a mano** (nessun giro periodico), ma il pannello deve dire da
  quando non controlla. Un annuncio fuori bersaglio **non** genera avviso (non è un
  post-filtro: resta visibile nella ricerca, semplicemente non suona) e resta fra i visti.
- **"Carica altri" con la fonte caduta**: la fetta **non** si consuma, si dice chi non ha
  risposto, il clic dopo ritenta la stessa finestra.
- **Raggruppamento "Modello"**: sul modello **dichiarato** da annuncio e catalogo, mai
  indovinato dal titolo. Chi non lo dichiara va in "non dichiarato".
- **Regole scritte due volte (browser + server)**: si accetta la copia, ma un **test** blinda
  che diano lo stesso risultato sugli stessi ingressi. Niente cartella condivisa.
- **Stella "miglior prezzo"**: non si assegna quando la lista è **mista** (contiene annunci
  fuori bersaglio), né in griglia né nel confronto.
- **Ricerca a parole di Subito**: avviso sotto le pill, testo esatto voluto dal proprietario:
  *«Ricerca pari alla ricerca a testo libero di Subito. Vuoi gestire le tue ricerche in modo
  diverso? Parliamone!»*
- **PDF**: un solo layout (`backend/report-pdf.js`) per veicoli e ricambi, disegnato dal
  server anche per i bottoni del frontend. **Niente** statistiche aggregate, **niente** riga
  stato fonti, **niente** legenda prezzi: quel che serve sta nelle colonne.
- **Bot WhatsApp**: spento per l'AI Act (in vigore dal 2026-08-02). La webhook non viene
  montata; si riaccende solo con `AMR_WHATSAPP=1`. `backend/web-parts.js` (ricerca web
  ricambi) **resta acceso**: non è un chatbot.
- **Accessi**: una password **per persona**, gestite da terminale. Limiti **per persona**
  quando è entrata, per indirizzo quando no. Senza password **l'app non parte**.
- **Richiami**: su un dato di sicurezza meglio un'allerta in più da scartare che una campagna
  non vista — confronto largo, ma le corrispondenze per parole si **dichiarano**.
- **Ordine dei lavori**: per famiglia di causa, dai gravi. Le famiglie chiuse si riaprono
  quando la stessa forma ricompare dove la regola non era arrivata.
- **Crawler / DB / worker**: area in pausa, **non toccare** (decisione esplicita). Tre
  problemi gravi lì dentro restano aperti e vanno ripresi quando Postgres torna vivo.
- **I problemi minori** (43, non 36): primo giro fatto — vedi più sotto.

---

## 3. Cosa è già chiuso (commit di questa sessione, dal più vecchio)

| commit | cosa |
|---|---|
| `7d21f44` | **Campagna 1** — una fonte muta non passa più per un fatto (16 punti) |
| `ba93e94` | **Campagna 2** — un solo PDF col logo, marcatura fino in fondo, WhatsApp spento |
| `d25e1e7` | **Campagna 1-bis** — la regola dei silenzi portata dove non era arrivata (9) |
| `ce4d142` | **Campagna 2-bis** — la scheda segue l'annuncio, non la ricerca |
| `195d040` | **Campagna 3** — un ripiego che cambia le regole deve dirlo, o non esistere |
| `fe4d67e` | **Campagna 4/1** — provincia, regione, richiami |
| `bf3e150` | **Campagna 4/2** — una sola `senzaGenerazione`, marca RDW |
| `03d66dc` | **Campagna 6** — una password a testa, limiti per persona |
| `5362fda` | **Campagna 5** — un solo `resetContesto()`, e otto punti chiusi |
| `07a040e` | **Campagna 7** — il valore con la sua unità, e l'IVA solo dove è dichiarata |

Suite: **629 test, 620 pass, 0 fail, 9 skipped** (partiva da 576/567).

---

## 4. Cosa resta

### Campagna 4 — coda — **CHIUSA**
Le tre cache (`autoit-rilevamenti`, `motornet`, `safety-gate`) passano da `cache-disco`:
numero di schema, tetto alle voci, e scrittura accanto ai dati utente — nel pacchetto
Electron la cartella dell'app è di sola lettura e l'errore finiva in un `catch` vuoto, quindi
la cache non sopravviveva a un riavvio. Il commento di `utils.js` nomina il codice che il
taglio sul CAP lo esegue davvero.

### Campagna 5 — il contesto del frontend — **CHIUSA**
Decisioni prese e applicate: al cambio contesto si azzerano **dati della ricerca**, **filtri
attivi** e **colonne scelte** in un solo `resetContesto()`; **ordinamento** e **annunci
spuntati** restano (le spunte attraversano i contesti di proposito); liquidità e richiami si
prendono **dall'annuncio**, la liquidità **solo all'apertura** del gruppo; il campo
**versione** è spento finché non si sceglie un modello dalla tendina; i dettagli Moto.it si
chiedono **al clic** (misurato: una ricerca MT-07 faceva partire 39 richieste solo scorrendo,
ora 0); **due preferenze provincia** separate, carburante e passaggio.

### Campagna 7 — il valore con la sua unità — **CHIUSA**
Misurato e chiuso: costo carburante sul **ciclo misto** (era la prima riga, cioè l'urbano —
sulla Golf R 7,05 invece di 8,75 l/100 km); consumi delle prove moto **in l/100 km** col km/l
della fonte a fianco, e accelerazione/ripresa in `s`, frenata in `m`; **"Prezzi self"** dice
il vero riga per riga (206 voci su 420 sono self+servito: tutto GPL e metano); **scorporo IVA
solo dove la fonte lo dichiara**, altrove colonne vuote con la nota del perché.

Due cose emerse misurando, da non riaprire a vuoto:
- i **consumi delle elettriche in `l/100 km`** non si vedono: su 252 rilevamenti auto.it, 41
  elettrici, 11 dichiarati in kWh, e **tutti col consumo a `null`** → la riga sparisce da sé.
  L'etichetta ora legge `unitaConsumo`, così non mentirà il giorno che la fonte pubblica.
- `m.autonomia` delle prove inSella (km, misurata) arriva dalla fonte e **non è mai stata
  mostrata**: è una voce da aggiungere, non un'unità da correggere.

### Campagna 6 — **CHIUSA**
I limitatori erano **sette copie** della stessa funzione, tutte con lo stesso difetto (il
timestamp si segnava prima del confronto, quindi anche una richiesta già rifiutata contava).
Ora c'è `backend/limite-richieste.js`, uno solo: chi è già fermo non paga, e ogni 429 dice
fra quanto si riapre. Misurato: con una finestra di 2 s e tetto 5, un client che riprova ogni
200 ms **prima non passava mai**, ora passa dopo 2,0 s. Il budget si vede quando sta per
finire, nei Ricambi e nel Competitor.

**Chiusa anche la copia scaduta**: tutte e otto le cache la servivano quando la fonte cade, in
silenzio — un dato di sette giorni prima (di uno per i richiami) indistinguibile a schermo da
uno appena preso. Era il difetto della campagna 1 nella sua forma più pura. Decisione del
proprietario: **via da tutte e otto**. È una riga sola in `cache-disco.js`, ed è possibile
proprio perché le tre di questa coda erano appena state portate lì. Chi chiama dichiara già
il KO ("Fonte non raggiungibile", "Archivio non raggiungibile: non si sa se ci sono allerte").

### Minori — primo giro fatto (erano **43**, non 36)
Nove erano già caduti chiudendo le campagne. Fatti in questo giro: liquidità coi due numeri
(netti 3,19 mln contro 5,6 totali), freno sulla verifica targa e targa svincolata dalla
ricerca, tre cache di errori (richiami, `/api/models`, 403 eBay), `metodoDiMisura`, slot
prenotato su Motornet, schema di Wheel-Size, consumo scritto all'italiana, «N pneumatici
registrati» dall'archivio, «solo N impianti» che conta gli impianti, il conto delle richieste
che comprende i ripieghi a browser, `RIFERIMENTO_SCRAPER.md` dichiarato storico e
`backend/dealer.js` dichiarato sospeso.

**Trovata una NONA cache** scritta a mano, in `backend/carburanti.js`: il test «tutte le cache
passano dal modulo comune» guardava solo `backend/scrapers/`. Ora guarda tutto `backend/`.

**Non spedito, e perché**: il raggruppamento «Cilindrata» sulle moto. Misurato su 239 annunci
Yamaha MT-07 — Subito 0 su 100, Autoscout 40 su 100, Moto.it 0 su 39: farebbe un gruppo «non
indicata» da 199. E il campo `tipo` non arriva da nessuna fonte (0 su 239). Prima viene il
dato: la cilindrata sta nel titolo ("MT-07 689") e va letta lì — lavoro sugli scraper.

**Secondo giro — fatti anche questi**: il timeout ora **ferma** davvero (`backend/annullo.js`,
segnale via AsyncLocalStorage come `budget-richieste`: nessuna firma cambiata, e provato che
la presa si chiude); una sola sessione eBay anche con due richieste insieme; la sessione
Subito si scrive in modo atomico; il kW non si chiede al listino del nuovo su un'auto oltre
gli 8 anni; le due regole del carburante sono una sola (tolta la copia morta del backend, i
nove test spostati sulla copia viva — provavano quella sbagliata).

**Trovato dal collaudo, non era in elenco**: con un filtro del browser che svuota lo schermo,
il pannello diceva «Nessun risultato trovato» — cioè dava la colpa al mercato mentre gli
annunci c'erano tutti (misurato: 210, filtro «Solo IVA esposta»). Ora dice quanti sono e chi
li nasconde.

**Terzo giro — fatti anche questi.** Su Moto.it l'etichetta legge la versione dall'URL
dell'annuncio (`varianteDaSlug`): misurato su Honda CB 500, sette righe su sette passano da
«il venditore non ha indicato la versione» a «esatto» con la versione vera («S · 1997–2004»),
e `cb-500` e `cb-500-s` smettono di sembrare la stessa moto. Corretta anche l'asimmetria:
versione chiesta e non applicata dà la stessa frase delle altre due fonti. La pill dice a
quale ricerca appartiene il totale («39 di 5.273 sulla marca»). Su Subito l'annuncio senza
prezzo non sparisce più — entra marcato «su richiesta» — e se NESSUN annuncio porta un prezzo
la fonte lo dichiara come errore, perché è il parser, non il mercato. Il bottone del CAPTCHA
dice che la finestra si apre sull'iMac. E il **DMG è staccato**: `electron/auto-update.js`
tolto, target `dmg` fuori da `package.json`.

**Restano**: «il titolo nomina il modello?» ha due risposte nel repo, una a parole intere e
una a sottostringa (**decisione esplicita: si lasciano due**); il parziale di Autoscout che
il controllo delle salvate tratta da completo (**non selezionato in intervista**); i sette
dell'area in pausa e le due scritture dentro GET (**decisione esplicita: si lasciano**).

### Coda — **CHIUSA**
Due erano già chiusi da campagne precedenti: la marcatura nel confronto affiancato (riga
"Corrispondenza" + niente stella se misto) e «da quando non controlla» nel pannello avvisi.
Gli altri otto, con le misure:

- **richiami** ordinati per data del bollettino, con la data a schermo. L'archivio era
  ordinato per numero di caso come stringa e l'anno sta in fondo: le 224 allerte del 2026
  cominciavano alla posizione 267, e 22 marche su 27 vedevano le più vecchie.
- **identità annuncio** = `subito:<progressivo>` da `urn`, e i visti già su disco si
  convertono leggendo la coda del vecchio URL: nessun falso «nuovo», nessuno storico perso.
- **raggruppamento "Modello"** sul modello dichiarato, generazioni separate: 200 VW passano
  da 70 gruppi (`"volkswagen 1"`, `"volkswagen 5p"`) a 45 coi nomi veri.
- **scheda ricambio**: solo catalogo. Niente foto dal primo annuncio usato di Subito, niente
  dati tecnici da un'inserzione eBay — e quella richiesta a eBay non parte più.
- **codici OE**: si leggono dai link a `/pezzi-di-ricambio/oem/`, non dal testo. Sonda del
  2026-08-01: il blocco cercato per intestazione non esiste, e i dieci codici veri della
  pagina non uscivano affatto.
- **compatibilità**: il totale vero viaggia col dato, e la riga dice «+N altri, ne vuoi di
  più? Parliamone!».
- **ricerca web**: le citazioni escono come «pagine trovate sul web», non come offerte.
- **`/api/detail`**: passa dal limitatore comune come le altre sette rotte.

Il giro automatico all'avvio delle ricerche salvate **resta com'è** (decisione esplicita).

### Aree in pausa (non toccare senza dirlo)
- `backend/crawler.js:60` e `:103`, `scripts/fill-moto-local.js:38`, `worker/worker.js:145`:
  spazzolano l'intera marca e la salvano sotto un modello. **Sono i più gravi in assoluto** se
  Postgres torna vivo.
- Colonna `dichiarazione` in `listings`: rimandata.

---

## 5. Fili aperti che non sono difetti

- **Spremere i portali ACI** per tutto quello che si può esporre (il captcha lo risolve un
  umano, quindi è percorribile). Il proprietario ci tiene.
- **Metodo ripetibile per scovare fonti nuove** (accessibilità, copertura, stabilità).
- **ADD ON** sta diventando il posto dei calcoli incrociati (costo carburante e simili): le
  fonti nuove vanno pensate anche in quella direzione.
- Il proprietario ha bocciato: storico prezzi, catalogo unico, portali esteri, limitazioni
  regionali alla circolazione, statistiche di mercato aggregate. **Non riproporli.**
- Gli piace invece il tipo di numero che descrive **la controparte**, non il mercato: il
  `posted_at` di Autoscout (da quanto quel concessionario ha quell'auto ferma) è l'esempio che
  ha portato lui.

---

## 6. Come si lavora qui

- **Rispondere in italiano.** Modalità caveman e ponytail attive, ma **non caveman** quando si
  espongono effetti verificati.
- **Interviste prima di scrivere.** Il proprietario vuole essere consultato sulle decisioni di
  prodotto: si usa `AskUserQuestion` con opzioni concrete e misurate, non generiche.
- **Misurare, non dedurre.** Quasi ogni correzione di questa sessione ha cambiato forma dopo
  una misura (il centro del cerchio regione, le forme inglesi del Safety Gate, le collisioni
  di marca RDW, la virgola su `cm`). Misurare prima.
- **Sonde gentili**: fermarsi al primo 403/429, mai CAPTCHA, mai credenziali, mai account.
- **Mai il Chrome dell'utente**: Playwright headless impacchettato (`pw-browsers`).
- **Segreti solo in `.env`** (gitignored, lo tocca solo il proprietario): mai leggerlo, mai
  stamparlo.
- **Produzione su :47321** si tocca solo con
  `launchctl kickstart -k gui/$(id -u)/com.automotoradar.server`.
  Sviluppo: `PORT=47350 node backend/server.js`, e **prima** si ammazza per porta
  (`for PID in $(lsof -ti tcp:47350); do kill -9 $PID; done`), mai `pkill -f server.js`.
- **Mai** `node -e "require('./backend/server.js')"`: apre una porta vera.
- **Test**: `AMR_LOG_DIR="$(mktemp -d)" node --test test/*.test.js`. Verde a ogni passo.
- **Commit solo quando richiesto**, mai su `main` (ramo:
  `feat/ui-redesign-rating-grouping`), e il messaggio finisce con
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- I test nuovi difendono **la regola**, non la singola correzione: stanno in
  `test/silenzi-fonti.test.js`.
