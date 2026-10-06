# Regole operative con accesso completo

Decisione dell'utente, 6 ottobre 2026. Si applicano al lavoro AP su AMR:
l'accesso tecnico completo non amplia il perimetro autorizzato.
Queste regole sono operative; non sostituiscono un sandbox del sistema.

Prima di ogni azione eseguire due controlli distinti: verificare prima il
bersaglio, gli effetti e il recupero possibile; ricontrollare poi il comando
concreto, i suoi argomenti e l'ambiente effettivo. Fermarsi se può cancellare
o sovrascrivere risorse preesistenti fuori dal perimetro autorizzato.

## File e dati

- Non cancellare file, directory, volumi o backup preesistenti senza un
  ordine esplicito che identifichi cosa eliminare. Non sovrascrivere lavoro
  altrui o dati vivi per risolvere un errore.
- Il cleanup automatico è ammesso soltanto per risorse temporanee create
  dal collaudo corrente, con percorso o nome esatto e provenienza verificata.
  Verificare destinazione e symlink prima di rimozioni ricorsive; niente
  wildcard, percorsi dedotti da input esterno o cleanup di cartelle condivise.
- Non usare `git reset --hard`, `git clean`, push forzati, `rsync --delete`
  o comandi equivalenti senza autorizzazione esplicita e circoscritta.
  Preparare un diff e una copia recuperabile prima delle modifiche delicate.
- Non leggere o esporre credenziali e dati personali. L'eventuale uso interno
  richiede il perimetro già autorizzato: niente valori in chat, log, fixture,
  documentazione o argomenti di comando; usare riferimenti o canali privati.

## Software e dipendenze

- Riutilizzare runtime e dipendenze presenti. Nessuna installazione di sistema
  o modifica delle dipendenze del progetto senza necessità concreta e
  autorizzazione nel task.
- Non scaricare ed eseguire materiale non verificato. Usare fonti ufficiali,
  una versione precisa e digest o firma quando disponibili; verificare
  provenienza, compatibilità e contenuto prima dell'esecuzione. Un hash
  calcolato solo dopo il download non dimostra l'autenticità della fonte.
- Niente `curl | sh`, installer remoti eseguiti alla cieca, `npx` che scarica
  pacchetti implicitamente o installazioni globali come scorciatoia.
  Se l'autenticità non è verificabile, fermare l'installazione e discuterla.

## Ambienti e collaborazione

- Verificare branch, modifiche locali, processi, porte, dati e destinazione
  prima di ogni operazione. Non cambiare branch nel checkout condiviso.
  Fare staging solo dei file del proprio task e controllare l'indice.
- Commit, push, deploy, costi cloud e operazioni sull'M2 richiedono il loro
  perimetro esplicito. L'autorizzazione di un commit non autorizza un deploy.
- Non aggirare un'azione rifiutata cambiando tool, credenziale o modalità
  di accesso. Un'approvazione mancante non si presume dal tempo trascorso.
- Per modifiche remote verificare configurazione, dati da preservare e
  rollback prima di intervenire. Una replica richiesta non dimostra lo
  stato effettivo; un HTTP 200 non dimostra il funzionamento dell'app.
- Verificare i finding, applicare fix circoscritti e usare review indipendente
  per modifiche delicate. Distinguere prove simulate, locali e live.
  Segnalare fallimenti e limiti senza dichiarare disponibile un servizio
  o acquisito un backup che non è stato verificato.

## Stato specifico dello staging

Il solo accesso completo non autorizzava a ripetere la recovery rifiutata.
L'utente ha poi autorizzato esplicitamente il ripristino della release AMR
`66e2b24`, eseguito il 6 ottobre sullo stesso volume. Le nuove operazioni
mantengono i propri gate; la produzione M2 resta esclusa dal ripristino.
