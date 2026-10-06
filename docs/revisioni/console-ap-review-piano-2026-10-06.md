# Console AP: review e ordine di lavoro — 6 ottobre 2026

## Baseline e confini

Branch `feat/nodi-residenziali-prototipo`, base `81e25ab`, HEAD esaminato
`3d9bc75`: 121 commit, 198 file, +33.416/−728 righe. La review riprende
[lo stato precedente](branch-nodi-2026-10-06-8cf9430.md), verifica i percorsi
che servono alla console e comprende due review indipendenti in sola lettura.
Non è una nuova lettura integrale di tutte le righe del branch.

Il [brainstorming](brainstorming-console-amr-ap.md), locale non tracciato,
fornisce requisiti e proposte: non prova comportamenti implementati e non
autorizza da solo cambi remoti, invii, configurazione di servizi o credenziali.
Il file originale e gli altri lavori locali sono preservati. Il frontend
non è stato modificato. Nessun deploy, accesso M2 o richiesta ai portali.

Decisione aggiornata in questa chat: la futura console, compresa la ricerca,
è riservata al proprietario. Non serve mantenere al suo interno il collaudo
del referente. Le API clienti e il lavoro APP restano distinti; non si
trasforma l'Admin in un cliente e non si impersonano persone o aziende.

## Stato verificato e gate aperti

- Coordinatore estratto, composizione pura centrale, protocollo ricerca
  POST/ID/GET, quote, affinità e autorizzazioni prima della consegna sono presenti.
  Retry e disconnessione incerta non autorizzano un replay automatico.
- Auth/PostgreSQL locale: il giro completo dell'ultimo runner precedente passa;
  le ricevute e il suo SHA sono nel [registro CHECK/Auth](branch-nodi-check-auth-2026-10-06.md).
  Non è un nuovo giro Auth cloud né un collaudo del nuovo frontend.
- La causa dei CHECK storici `23514` resta non dimostrata. Le funzioni attuali
  campionano il wall clock dopo i lock: la sola attesa del lock non ne spiega
  il rifiuto. Non rimuovere i CHECK o falsificare timestamp per far passare il test.
- Nuovo campione anonimo staging: tre GET, `/healthz` 200, `/` 403,
  `/api/admin` 401. Nessun body, login o dato personale acquisito. Il campione
  conferma l'ostacolo di accesso, non la sua causa né la frequenza intermittente.
  Non ampliare `trust proxy` per eliminare il sintomo senza un contratto provato.
- Backup cifrato staging e restore isolato già documentati: non equivalgono
  a storage gestito configurato o a un nuovo restore funzionale di Auth.
- M2 non collegato in questo incremento. Prima il gate staging, poi worker
  separato solo stato; prima del live, pause e ammissione sullo stesso IP devono
  essere coordinate anche con il servizio di produzione esistente.

## Difetti attuali confermati

### D1 — Un guasto diagnostico può impedire consegna e arresto del centro

`backend/nodi/centro.js:213–229, 250–284, 678–704, 970–983`:
`registra()` scrive SQLite senza protezione. Dopo un esito, il job è rimosso
dalla RAM prima della scrittura e della risoluzione della Promise. Un errore
diagnostico può quindi perdere un risultato già ricevuto; nei callback di
annullamento può uscire dal gestore e terminare il processo. In `close()`
può interrompere il cleanup dopo che `chiuso` è già impostato.

Prove indipendenti VM/SQLite con `FULL`: consegna 500, nuova consegna 409,
client 504; chiusura incompleta, intervalli e job residui. Controprove senza
guasto: consegna 200 e cleanup completo. Un errore sulla sola tabella eventi
non perde il risultato. Review indipendente: Node 24.19.0, SQL in memoria,
HTTP loopback, nessun filesystem o sistema remoto interessato.

Controprova principale su Node 24.21.0 e SQLite reale temporaneo: un trigger
`BEFORE INSERT ON lavori` provoca un errore sintetico. Il callback di abort
chiama `interrompiAccodati` → `registra`; Node termina con exit 1. Non è una
simulazione di disco realmente pieno, ma prova il percorso della stessa eccezione.

Correzione minima: rendere non fatali soltanto le scritture diagnostiche;
segnalare in RAM una raccolta incompleta senza log ricorsivi o ripetuti per ogni
evento; completare consegna, rifiuto e cleanup. Token revocati, sospensioni,
Auth e transazioni commerciali restano obbligatori: il guasto di quelle
scritture non viene assorbito come semplice errore di logging.

### D2 — La pulizia periodica può terminare il processo

`centro.js:93–101`: il timer esegue istruzioni SQLite senza catch.
Prova indipendente con `BUSY` e `FULL`: l'eccezione esce dal callback;
il processo figlio con `FULL` termina exit 1. Senza guasto termina exit 0;
rimossa la causa, la pulizia torna a riuscire. La pulizia deve segnalare il
fallimento senza abbattere il centro. Non si considera riuscita né si nasconde
una retention fallita.

## Condizioni e requisiti che non sono nuovi bug dimostrati

| Tema | Fatto e controprova | Conseguenza per il piano |
| --- | --- | --- |
| Proprietario e ricerca | `adminDiProva` usa `admin:true`; la ricerca richiede azienda valida, e SQL vieta all'Admin di diventare referente. Il comportamento attuale segue la vecchia decisione gestionale. | Definire una ricerca diagnostica autorizzata per il proprietario, senza cambiare le API clienti o bypassare limiti e permessi. Se in futuro ci saranno altri Admin, il booleano da solo non distingue il proprietario. |
| Sessioni | Il login elenca/revoca le proprie sessioni RAM; revocare un collega rimuove membership ed epoca. Non è un comando generico per scollegare un cliente. | Distinguere invalidazione sessioni, revoca account e revoca commerciale prima di esporre comandi. |
| Configurazione | Limiti nella closure; condivisione prima pagina senza revisione delle impostazioni. Il browser usa 75 s, il backend accetta fino a 300 s. Nello staging attuale il budget è 60 s. | Per impostazioni modificabili: snapshot all'ammissione, revisione nella condivisione, deadline comunicata; preservare i contatori del carico già ammesso. Il conflitto 75/300 è condizionato a una configurazione diversa da quella corrente. |
| Manutenzione | `avviati` descrive job attualmente consegnati, non la storia della ricerca; il recupero può accodare una fonte dopo la prima risposta. | Non svuotare tutte le code indistintamente. Distinguere ricerche mai consegnate da continuazioni già ammesse; persistere la manutenzione e il suo esito esplicito. |
| Restart AMR | Worker interrompe il lavoro su SIGTERM; un'epoca centrale cambiata lo arresta. Il launcher locale ferma i figli se uno esce. | Un processo non può verificare il proprio riavvio. Serve un responsabile esterno e un target AMR esplicito; nessun comando del sistema operativo o restart automatico implicito. |
| Release | Manifest include anche frontend/scripts, e confronta release e hash esatti. | Una modifica UI richiede inizialmente aggiornamento coordinato dei worker. Allentare il confronto senza un nuovo contratto sarebbe una regressione. |
| Retention | I cap attuali sono 10.000 righe; possono tagliare dati prima dei sette giorni. `DELETE` libera pagine SQLite riutilizzabili, non riduce necessariamente il file. | La prova indipendente in RAM passa da 738 pagine/729 libere a 9 dopo VACUUM: non prova saturazione reale. Decidere budget e completezza prima di cambiare cap o introdurre compattazione sul DB misto. |
| Notifiche | Il processo centrale fermo non può inviare il proprio allarme. openWA non è collegato o provato da questo documento. | Episodi correlati, invio confermato/incerto, fallback email ed osservatore esterno richiedono contratti e configurazione protetta; niente messaggi o nuovi servizi autonomi. |

## Ordine di lavoro e condizioni di completamento

1. **Affidabilità della diagnostica.** Correggere D1/D2, provare scrittura,
   timer, annullamento, consegna e cleanup con errori controllati. Esporre lo
   stato tecnico nelle API Admin; la nuova rappresentazione UI arriverà dopo.
   Verificare separatamente che le scritture operative continuino a fallire
   esplicitamente. Review indipendente del diff e commit dedicato.
2. **Contratti della console.** Concordare autorizzazione della ricerca owner,
   gestione sessioni e comandi; implementare manutenzione/configurazione con
   snapshot e persistenza. Prima di ogni scelta significativa, interview.
3. **Misure e risorse.** Fasi della prima ricerca misurate con clock monotono
   locale; distinguere trasporto stimato e latenza browser. Inventario di
   DB, pagine libere, WAL e output runtime; capacità, baseline del fattore tre
   e destinazione del backup diagnostico richiedono decisioni esplicite.
4. **Incidenti e notifiche.** Correlazione nodo/fonti e un episodio per guasto;
   prove simulate senza invii. Collegamento openWA/email, osservatore esterno
   e prove live solo nel perimetro concretamente autorizzato.
5. **Gate distribuito.** Diagnosi CHECK/ingress, artefatto e migrazioni append-only,
   aggiornamento/rollback staging e collaudo del candidato. Poi M2 solo stato;
   live dopo coordinamento pause e limiti. Non eseguire un deploy perché è
   semplicemente elencato in questo piano.
6. **Frontend owner.** Solo dopo i contratti verificati e le decisioni precedenti:
   console organizzata per operazioni reali, ricerca proprietario, prestazioni,
   incidenti e diagnostica incompleta. Nessuna pagina cliente duplicata. Prove
   automatiche, review indipendente, collaudo nel dev server dell'utente e commit.

Le dipendenze remote non impediscono i fix locali già autorizzati, ma non
possono essere dichiarate completate da una suite locale. Le nuove funzionalità
non sostituiscono il gate di produzione dell'app APP Auto/Moto.

## Ricevute nuove e fonti

Baseline principale: Node 24.21.0, dati/log temporanei, dotenv escluso,
HTTP(S) loopback. `nodi-centro`, `nodi-ricerche-http`, `nodi-pg-diagnostica`,
trasporto HTTP/HTTPS, sonda e ingress: **72 test, 71 pass, uno skip opt-in,
zero fail/cancelled**, `/private/tmp/amr-console-baseline-CJwjph/test.tap`.
Lo skip riguarda le attese reali di 55/65 s della sonda; non è una prova Nhost.

- [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html):
  protezione dei dati, correlazione, prove dei guasti di logging e risorse.
  È il fondamento del fail-soft diagnostico, non del fail-open autorizzativo.
- [Google SRE Monitoring](https://sre.google/workbook/monitoring/):
  distribuzioni, segmenti confrontabili e correlazione degli alert.
  Non prescrive la soglia AMR del triplo o una baseline specifica.
- [OpenTelemetry: context propagation](https://opentelemetry.io/docs/concepts/context-propagation/):
  correlazione fra processi; non impone SDK, collector o nuovi servizi.
- [PostgreSQL: clock](https://www.postgresql.org/docs/18/functions-datetime.html)
  e [campi degli errori](https://www.postgresql.org/docs/18/protocol-error-fields.html):
  limiti del wall clock e osservazione del vincolo senza esportare il detail.
- [Nhost Run networking](https://docs.nhost.io/products/run/networking):
  confini fra rete interna e porte pubbliche; la pagina non attesta un
  insieme stabile di IP proxy per la nostra allowlist.

Questi riferimenti sostengono le scelte; non provano da soli AMR o il provider.
