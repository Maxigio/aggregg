# Modello e versione: decisione per la ricerca Subito

**Aggiornamento dopo la prova sul dev server:** la soluzione basata sulla sola sigla
implicita nel modello non garantisce una ricerca abbastanza fedele al portale.
Con «Ducati 748 R» senza il campo Versione, Subito restituisce troppi annunci sbagliati;
specificando la versione il risultato e' migliore. La verifica della sigla nell'annuncio
resta utile per dichiarare le corrispondenze, ma non sostituisce il filtro di ricerca.
L'interfaccia ora richiede una scelta esplicita: una versione specifica, oppure
«Nessuna Versione». Quest'ultima lascia vuoto il parametro `versione` e permette
ricerche generali, anche per sola marca. L'API continua ad accettare richieste senza
versione per compatibilita' con i chiamanti esistenti.

La ricerca di AMR seleziona una marca, un modello e una scelta sul campo Versione. Il nome mostrato da AMR non coincide sempre con la struttura del catalogo della fonte. Esempio osservato: AMR mostra «Ducati 748 R», mentre Subito cataloga la famiglia «748» e la sigla «R» come versione. Cercare il solo modello senza considerare la sigla fa entrare anche annunci «748 S».

## Regola adottata

- `subito-nodo.js` separa una sigla finale di una lettera dal modello **solo se il catalogo nativo di Subito la conferma come versione di quella famiglia**. Non esiste una lista di eccezioni Ducati. Un nome che il catalogo tratta come modello completo resta tale.
- `versione-verifica.js` confronta la versione dichiarata dall'annuncio. Se il campo nativo manca, usa il titolo solo quando contiene un'indicazione univoca subito dopo il nome della famiglia; «R/S» non prova né R né S. Una versione ignota resta visibile come non verificata; una versione dichiarata diversa può essere nascosta, ma l'utente può mostrarla.
- Il campo Versione esplicito continua ad avere precedenza. Nel frontend un campo vuoto
  blocca l'invio; per una ricerca generale si seleziona «Nessuna Versione», che non
  invia alcun filtro. Una versione specifica richiede un modello scelto dalla lista.
- Le risposte grezze conservate per il recupero annunci hanno una scadenza effettiva in memoria; non diventano un archivio degli annunci.

Queste regole proteggono la **corrispondenza della richiesta**, non garantiscono che il venditore abbia compilato correttamente l'annuncio. L'etichetta «Versione non verificata» significa che AMR non ha abbastanza elementi per confermare o smentire.

## Quando si rivedrà AutoScout24

Ripartire dalla richiesta «Ducati 748 R»: il ponte può tradurla nel solo codice del modello base «748», mentre il backend la considera già esatta. Verificare nel frontend e nelle chiamate API di AutoScout24 come rappresenta modello e versione, poi confrontare gli ID restituiti e i campi dichiarati dagli annunci. Applicare lo stesso criterio di tre esiti (confermata, smentita, ignota) senza attribuire una precisione che il filtro API non dimostra. Non copiare meccanicamente lo split di Subito: il catalogo e il campo versione di AutoScout24 hanno una struttura propria.

La prova sul frontend di sviluppo è stata accettata dall'utente; la prima segnalazione di mancata efficacia riguardava per errore il frontend di produzione. Nessuna modifica di questa decisione va distribuita sull'M2 senza una richiesta esplicita.
