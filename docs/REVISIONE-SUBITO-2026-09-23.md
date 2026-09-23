# Revisione Subito — 23 settembre 2026

Checkpoint prima degli interventi: `3d123ef`. Nessun deploy sull'M2.
Subito serve Auto, Moto, Ricambi e Competitor; le prove qui sono simulate,
senza richieste ai portali e senza credenziali reali.

## Gestione 429 in Ricambi e Competitor

- **Confermato e corretto:** Ricambi interrogava Hades anche con la pausa
  condivisa attiva. Il client usato da Ricambi ora consulta `fonti-salute`,
  registra gli esiti e dichiara la pausa senza fermare le altre fonti.
- **Confermato e corretto:** il gruppo Competitor proseguiva sulla seconda
  vetrina Subito dopo un 429 sulla prima. Si fermano le ulteriori vetrine Subito
  della stessa operazione; restano i risultati ricevuti, le altre fonti e i
  dati gia' disponibili in cache. Un vecchio 429 in cache non interrompe un
  nuovo aggiornamento.
- **Confermato e corretto:** la rilettura della scheda vetrina ignorava la
  pausa e perdeva il codice HTTP. Rispetta ora la pausa, registra il 429 e
  impedisce lo scarico successivo del parco quando arriva quel blocco.
- Gli avvisi non dipendono piu' dalla presenza di `(429)` nel testo:
  il codice HTTP e il messaggio sono distinti.

Non cambia la politica di `fonti-salute`: la pausa condivisa scatta dopo
due blocchi, mentre il primo 429 interrompe la sequenza in corso. Fermare
tutta l'installazione al primo 429, durata e ripartenza restano da definire.
Le richieste concorrenti gia' partite non vengono annullate da questi fix.

Prove: `test/subito-429.test.js`, suite Ricambi e Competitor, poi suite completa
con dotenv disabilitato e dati/log temporanei: **908 passati, 0 falliti**.
Log locale: `/private/tmp/amr-429-suite-completa.log`.
Il diff preserva la validazione host e l'escape HTML degli avvisi.

## Prossimo problema: paginazione dopo una risposta parziale

**Confermato, non ancora corretto.** `caricaAltri()` considera una fonte con
`status: ok` come completata anche se `parzialeRete` e' vero, e incrementa
`fettaPresa`. Una risposta con la prima pagina valida e la seconda fallita
conserva correttamente gli annunci, ma il clic successivo salta la pagina
non ricevuta.

Riproduzione sul frontend e sul wrapper Subito reali con HTTP simulato:

```sh
node /private/tmp/amr-contesto-20260923/verifica-carica-altri-parziale.cjs
```

Offset richiesti: `0, 50, 100, 150 (429), 200, 250`.
Mancano gli annunci agli offset `150–199`: il secondo clic non li ritenta.

Correzione proposta: conservare gli annunci ricevuti e lo stato della
porzione incompleta, senza avanzare oltre; deduplicare per URL alla ripresa.
Prima del fix verificare anche prima ricerca parziale, fonte in pausa e
fonti con avanzamenti diversi, per non introdurre salti o richieste inutili.
