# AutoScout Adventure — report per la chat AMR

## Perimetro e verdetto

Indagine del 2 ottobre 2026 sul checkout `feat/nodi-residenziali-prototipo`,
HEAD `8d6e4cc`, con modifiche locali preesistenti preservate. Nessuna modifica
agli scraper, nessun commit/deploy e nessun intervento sull'M2.

**Confermato:** la ricerca AMR riceve una risposta AutoScout valida ma vuota;
l'ID del modello coincide con quello selezionato nel frontend ufficiale.
Il frontend ufficiale usa un endpoint e un contratto GraphQL differenti.
**Non dimostrato:** quale differenza provochi il vuoto e quale modifica lo risolva.
Il confronto col conteggio ufficiale ha ricevuto HTTP 401, quindi non discrimina
le ipotesi. Non sostituire l'endpoint sulla base di questa sola evidenza.

## Ricerca osservata e percorso

Moto; BMW; R 1200 GS Adventure; prove utente con «Nessuna Versione» e «Adventure».
I metadati operativi delle ricerche riportano anno minimo 2010 e **prezzo minimo
5.000 €**, non km minimi 5.000. Verificare questo dettaglio prima di altri confronti.

- `frontend/nodi-prototipo.js:152`: inoltra `mmmvAutoscout` della voce selezionata.
- `backend/nodi/operazioni.js:43–46`: parser condiviso e `runSearch`, senza
  sostituire il modello; scope della cache legato all'azienda.
- `backend/ricerca-coordinatore.js:326–327,410–422`: testo-versione e ripiego
  API senza versione. Non introdurre fallback browser o correzioni per BMW soltanto.
- `backend/scrapers/autoscout-graphql.js:25,51–52,192–222,259,275`:
  host legacy, `search.listings`, classificazione, anno e prezzo.
- `data/models.json:53660–53667`: voce Adventure, `13|70949||`, `modelIdAS=70949`.
  Catalogo letto soltanto; non modificato.

## Prove live autorizzate

### 1. API attuale AMR — 06:43:18 Europe/Rome

Una chiamata diretta allo scraper, con dati/log temporanei, senza versione:

```json
{"v":{"classification":[{"make":13,"model":70949}],"vehicleType":["Bike"],"firstRegistration":{"from":20100101,"to":21001231}},"loc":{"country":["Italy"]},"m":{"page":1,"size":50},"pr":{"price":{"from":5000,"to":100000000}}}
```

HTTP 200; body 76 byte; annunci 0; totale 0; `hasMore=false`; nessuna parzialità.
Il vuoto precede i filtri locali e la visualizzazione. Una sola chiamata:
nessuna ripetizione con/senza versione, nessun body o annuncio conservato.

### 2. Form ufficiale — chiamate ricerca/conteggio intercettate e abortite

Moto → BMW → R 1200 GS Adventure. Valori del catalogo effettivamente osservati:
`ma13mo70726` (GS), **`ma13mo70949` (Adventure)**, `ma13mo71062` (GS LC).
La selezione Adventure produce questa richiesta di conteggio, **non inviata**:

```text
POST https://www.autoscout24.de/listing-search-api-v2/graphql
query GetTotalListingCount($queryString: String!, $locale: Locale_) {
  search {
    listingsByQueryString(queryString: $queryString, locale: $locale) {
      metadata { totalItems }
    }
  }
}
variables:
queryString=sort=standard&desc=0&ustate=N,U&atype=B&cy=I&cat=ma13mo70949
locale=it_IT
```

Questo falsifica l'ipotesi «ID Adventure obsoleto». Prova una divergenza di
endpoint, operazione e rappresentazione della selezione; non prova la loro
equivalenza né cattura ancora la richiesta ufficiale completa degli annunci.
`ustate=N,U` è lo stato iniziale osservato nel form, non una decisione di
allargare AMR agli annunci nuovi.

### 3. Conteggio ufficiale — 06:59:31 Europe/Rome

Una sola chiamata aggiuntiva autorizzata al medesimo endpoint/operazione di
conteggio, senza cookie o credenziali e senza richiesta di annunci:

```text
sort=price&desc=0&ustate=N,U&atype=B&cy=I&cat=ma13mo70949&fregfrom=2010&pricefrom=5000
locale=it_IT
```

HTTP **401**, body 24 byte, non JSON; nessun totale. Nessun retry. I parametri
anno/prezzo aggiunti sono quelli del confronto desiderato: la loro accettazione
da parte del gateway non è dimostrata, poiché la richiesta è stata rifiutata.
Non interpretare il 401 come zero annunci o prova che il gateway sia inutilizzabile
dal browser. Non estrarre credenziali per proseguire senza discutere il perimetro.

## Finding distinto riprodotto con risposta controllata

**Media — elenco vuoto con totale positivo dichiarato esaurito.**
Risposta simulata `listings:[]`, `metadata.totalItems:12`: scraper/coordinatore
restituiscono `status=empty`, `count=0`, `total=12`, `hasMore=false`, senza avviso.

Evidenze: `autoscout-graphql.js:535` ammette il totale quando l'elenco è vuoto;
`:620` chiude la paginazione su zero righe; `:632` rileva il parser vuoto solo
con annunci grezzi presenti; `ricerca-coordinatore.js:127` classifica `empty`.
La UI del prototipo mostra count e hasMore (`nodi-prototipo.js:324`), non il totale.

Controprova: **non spiega la prova live**, che aveva totale zero.
Proposta per la chat AMR: verificare la contraddizione per pagina/offset e
dichiarare risposta incoerente, evitando falso esaurimento/cache valida.
Non aggiungere automaticamente richieste né applicare la regola a una pagina
oltre l'esaurimento reale. Perimetro: Auto/Moto e gli eventuali altri chiamanti
del client AutoScout da ricostruire sul checkout corrente. Non fixato qui.

## Passo discriminante proposto, non eseguito

1. Catturare e abortire la richiesta **annunci** del portale per i medesimi
   filtri, distinguendo conteggio e ricerca effettiva, usato e nuovo.
2. Concordare un confronto limitato: medesima operazione e medesime variabili
   fra endpoint, evitando di cambiare host e filtri contemporaneamente.
3. Se le prove confermano un cambiamento di contratto, correggere il client
   condiviso; verificare Auto e Moto, tutte le opzioni, pagina da 50, retry,
   429/salute e privacy dei privati. Nessun caso speciale Adventure.

Review indipendente in sola lettura: confermata la divergenza; respinta come
non dimostrata l'inferenza «endpoint diverso = causa certa». Campioni nel tempo,
non garanzia di stabilità futura della piattaforma. Almeno 15 secondi fra
ricerche sulla stessa fonte; le due chiamate effettuate sono separate da 16 minuti.
