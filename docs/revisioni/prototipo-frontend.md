# Frontend del prototipo — revisione del 2 ottobre 2026

## Perimetro

Centro locale Nhost/PostgreSQL con worker reale iMac; M2 escluso. Preservare il
launcher manuale in esecuzione e l'azienda attivata: un suo riavvio elimina DB,
inviti e MFA del collaudo. Nessun commit/deploy richiesto in questo intervento.
Non leggere credenziali o sessioni dell'utente. Test browser con API simulate.

## Fonti autorevoli e applicazione

- [MDN: details](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details):
  usare il disclosure nativo, il suo stato `open` e l'interazione da tastiera.
  Il polling deve aggiornare i dati senza ricreare il controllo aperto.
- [W3C WAI: page regions](https://www.w3.org/WAI/tutorials/page-structure/regions/):
  navigazione e sezioni identificate, struttura comprensibile anche con tastiera
  e tecnologie assistive. Non basta cambiare i colori dei pannelli.
- [W3C WAI: grouping controls](https://www.w3.org/WAI/tutorials/forms/grouping/):
  raggruppare controlli collegati, mantenendo etichette e `fieldset` nativi.
- [MDN: replaceState](https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState):
  quando un token invito arriva nel fragment, rimuoverlo dall'URL senza produrre
  un nuovo elemento della cronologia. Non inserire token nei link di navigazione.

Le raccomandazioni di struttura sono scelte del progetto, non un layout imposto
dalle fonti. Nessuna nuova dipendenza proposta.

## AutoScout: prove e limiti

Il registro operativo, letto solo per i filtri non sensibili, contiene ricerche
BMW `R 1200 GS Adventure`, `mmmvAutoscout=13|70949||`, `annoMin=2010`,
`prezzoMin=5000`, sia senza versione sia con `versione=Adventure`.
Non contiene `kmMin=5000` in questi casi. Il catalogo locale e la UI inoltrano
il codice distinto di Adventure; centro e worker preservano questi parametri.

Una sola verifica live autorizzata, 2 ottobre 2026 alle 06:43:18 Europe/Rome:
scraper API, prima pagina da 50, BMW Adventure senza testo-versione,
classification make 13/model 70949, Bike, Italia, firstRegistration da 20100101
a 21001231, prezzo da 5000 a 100000000. Una chiamata HTTP 200; body 76 byte;
zero annunci normalizzati, totale 0, hasMore false. Nessun body, annuncio o
dato personale conservato. Nessuna ripetizione della ricerca.

Questo prova il vuoto della risposta API con quel codice, non la correttezza
attuale del codice rispetto al catalogo del portale. Il confronto col frontend
ufficiale è stato successivamente autorizzato: ispezione del form/catalogo con
query annunci bloccate, senza ripetere la ricerca live.

Il form ufficiale conferma Adventure `ma13mo70949`: ID locale corretto.
Usa il gateway `www.autoscout24.de/listing-search-api-v2/graphql` e
`listingsByQueryString` con `cat=ma13mo70949`, mentre lo scraper AMR usa
`listing-search.api.autoscout24.com/graphql` e `listings(vehicle:…)`.
Una sola chiamata aggiuntiva al conteggio ufficiale, autorizzata, alle 06:59:31
Europe/Rome ha ricevuto HTTP 401: confronto inconcludente, nessun retry.
Dettagli, controprove e proposta per la chat AMR in
[autoscout-adventure-2026-10-02.md](autoscout-adventure-2026-10-02.md).
Non modificare lo scraper in questa lavorazione: l'utente segue l'app in altra chat.

Review indipendente: riprodotta una risposta simulata AutoScout con elenco
vuoto e totale positivo che AMR tratta come empty/esaurita. È un finding
distinto e non spiega la prova live (il totale era zero); non modificato in
questa fase senza confrontarlo con il percorso attuale dell'app.

## Lavori recenti

Prima del fix, `renderStato` sostituiva tutte le righe ad ogni polling. Test
browser del codice reale: dettaglio chiuso, elemento sostituito e focus perso.
Fix: riuso delle righe per ID del lavoro, aggiornamento di stato/durate/filtri,
conservazione del disclosure; ripristino di focus e scroll al riordino, fallback
alla regione della tabella se il lavoro focalizzato scompare. Rimozione su copia
della lista DOM per non saltare righe durante l'iterazione.

La review indipendente ha rilevato il fallback focus mancante e il cleanup del
test registrato dopo il launch di Chrome. Entrambi corretti; test esteso a
riordino, cambiamento filtri, rimozioni e elenco vuoto.

## Organizzazione delle pagine

Stato attuale: `/` include account, diagnostica e ricerca; login/MFA ha una
pagina propria; `/api/auth/aziende/pagina` serve sia il template incorporato sia
il percorso dell'invito, ma permette anche gestione Admin duplicata.
La preparazione MFA è un endpoint temporaneo del launcher.

Decisione confermata e implementata: un ingresso con aree Ricerca,
Nodi e lavori, Account e aziende secondo permessi; login/MFA e invito restano
passaggi dedicati. Il template aziende resta condiviso con l'incorporamento,
ma la sua apertura senza fragment rimanda a `/#accountPanel`; l'invito con
fragment mantiene il percorso dedicato e rimuove il token dall'URL come prima.
Il callback email rimane invariato: la scheda originale conserva il token
dell'invito per completare l'accettazione.

Navigazione con link nativi e `aria-current`, Back/Forward e filtri conservati;
Admin senza licenza vede diagnostica/account, referente attivo ricerca/account.
Referente Moto vede soltanto il modulo acquistato. Area non autorizzata nel
fragment viene riportata a un'area consentita; l'autorizzazione reale resta
nelle rotte server, non nei link nascosti. Nessun nuovo framework o dipendenza.

Review indipendente: trovato focus perso alla revoca di un link o controllo
già rimosso da `terminaContesto`. Verificato e corretto catturando il focus
prima dell'azzeramento e prevedendo il fallback anche per i link revocati.
La seconda review non ha rilevato ulteriori problemi concreti nel perimetro.

## Evidenze dei test

- Prima del fix: `/private/tmp/amr-prototipo-ui-prima.log`, un fallimento che
  dimostra perdita di `open`, identità del nodo DOM e focus.
- Primo fix: `/private/tmp/amr-prototipo-ui-dopo.log`, un test passato.
- Review estesa: `/private/tmp/amr-prototipo-ui-review-20261002.log`, **17/17**,
  nessun test saltato. La review indipendente del fix non ha trovato ulteriori
  errori concreti dopo le due correzioni sopra; il reviewer ha eseguito prove
  DOM simulate, il browser è stato eseguito nell'ambiente principale.
- Collaudo dopo navigazione e review: `/private/tmp/amr-prototipo-aree-review.log`,
  **23/23 passati, nessun test saltato**. Login, inviti, template unico,
  idempotenza, logout con risposta tardiva, Back/Forward, filtro conservato,
  modulo Moto, revoca/focus, mobile e coordinamento centro coperti.

Il launcher reale non è stato riavviato: i file frontend sono letti ad ogni
richiesta; ricaricare il browser applica le modifiche preservando l'azienda
attivata e le sessioni del collaudo.

Nessuna certificazione di produzione: prove locali e un campione live, fonte
soggetta a cambiamenti. Aggiornare questo registro dopo le decisioni e il gate.
