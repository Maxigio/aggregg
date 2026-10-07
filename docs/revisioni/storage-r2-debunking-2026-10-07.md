# R2 Standard — debunking per AMR

Data: 7 ottobre 2026. Codice verificato su `a2fa54a`, branch
`feat/nodi-residenziali-prototipo`. Le sezioni iniziali descrivono l'analisi
documentale e statica precedente all'attivazione. Il collaudo R2 autorizzato
successivamente è registrato in fondo, separato dalle prove di produzione.
Preservate le modifiche locali delle altre lavorazioni.

## Verdetto

R2 Standard è un candidato ragionevole per i backup esterni cifrati e
l'archiviazione di log e bug report. Il vantaggio dei costi è condizionato
al numero di operazioni e al traffico fatturato dagli altri servizi.
Compatibilità del protocollo e documentazione non dimostrano ancora che
il percorso AMR → R2 → restore funzioni. Raccomandato un collaudo isolato
prima dell'adozione; l'attivazione resta una scelta dell'utente.

## Decisioni e stato effettivo

- Restic open source con storage gestito: direzione concordata.
- Backup PostgreSQL giornaliero e journal commerciale dopo le operazioni,
  separati; conservazione di 14 copie giornaliere e journal per 90 giorni.
- Cifratura prima dell'upload; chiave di recupero custodita fuori dal backend
  e dal provider. Guasto del backup: continuare le operazioni con avviso
  persistente e stato visibile nell'Admin, come già concordato.
- Nuovi usi precisati dall'utente: log e bug report dal frontend AMR.
  Non sono stati richiesti allegati o screenshot.
- Diagnostica corrente: sette giorni e cap di 10.000 lavori/eventi con
  dichiarazione delle eventuali lacune; export manuale gestito dall'utente.
  Questa decisione non autorizza automaticamente un nuovo archivio remoto.

## Prove e controprove

| Affermazione | Controverifica | Conclusione |
| --- | --- | --- |
| Il traffico R2 non genera costi di egress. | Il listino R2 lo conferma. Non azzera la tariffazione di rete del servizio che invia i file. Nhost pubblica 50 GB inclusi e 0,10 USD/GB successivo. L'impatto degli upload del nostro servizio Run sulla fattura deve essere misurato. | Vantaggio R2 verificato; costo complessivo AMR condizionato. |
| È economico anche per tanti log. | Spazio, scritture/listing e letture hanno tariffe separate. Molti oggetti minuscoli o retry incontrollati possono costare più dello spazio. | Vantaggio condizionato al volume e alla modalità di invio. |
| Un alert di budget limita la fattura. | Cloudflare dichiara gli alert informativi: non fermano il consumo. | Affermazione smentita; servono limiti applicativi e monitoraggio della spesa. |
| Possiamo riusare restic. | Restic documenta endpoint S3 compatibili; R2 supporta operazioni di lettura, scrittura, listing e multipart. Il wrapper AMR invoca già il binario con un repository configurabile. Non è stata eseguita una prova AMR su R2. | Compatibilità plausibile e sostenuta dal contratto, integrazione non dimostrata. |
| R2 conserva automaticamente tutte le vecchie versioni. | `GetBucketVersioning` e `PutBucketVersioning` non risultano implementati nel contratto S3 consultato. Gli snapshot restic sono un meccanismo distinto. | Affermazione smentita per il versioning S3. |
| Un lock rende il repository restic più sicuro senza conseguenze. | I lock R2 impediscono cancellazione e sovrascrittura; AMR usa `forget` e `prune`, che richiedono cancellazioni. Un lock generale può impedirne l'esecuzione. Le regole possono inoltre essere rimosse da chi gestisce la configurazione del bucket. | Rischio di configurazione verificato; nessun lock generale proposto per il repository. |
| La cancellazione per età può gestire la retention restic. | I dati sono condivisi fra snapshot; un oggetto vecchio può servire a uno snapshot recente. La retention deve seguire il grafo restic, non l'età dei singoli oggetti. | Proposta non sicura; riusare la retention AMR/restic. |
| Scegliere una località europea basta. | Il location hint è best effort; la giurisdizione EU è invece il vincolo documentato per conservazione e trattamento degli oggetti. Va scelta alla creazione e non si cambia successivamente. | Usare bucket EU se adottiamo R2. Non è una certificazione automatica dell'intera applicazione. |
| R2 gestisce automaticamente i permessi delle aziende. | Token limitabili ai bucket; autorizzazioni per persona/azienda restano responsabilità del backend. Un prefisso aziendale non prova l'autorizzazione. | Vantaggio dei token verificato; isolamento AMR da implementare e collaudare. |
| Archiviare log significa avere logging e diagnosi completi. | Lo storage conserva oggetti. I Data Access Logs R2 riguardano operazioni sugli oggetti, escludono status >=400, sono best effort e sono disponibili per bucket senza giurisdizione. Non attestano gli errori AMR né sostituiscono la console. | Affermazione smentita; conservazione, consultazione e notifiche restano percorsi distinti. |
| Cifratura e durabilità impediscono la perdita dei backup. | Cifratura del provider, cifratura restic e permessi di cancellazione sono livelli distinti. Cloudflare dichiara un progetto per undici nove di durabilità; non è una prova delle nostre copie, dei restore o della disponibilità continua. Perdita della chiave restic o cancellazione autorizzata restano rischi. | Benefici documentati, garanzia complessiva non dimostrata. |

Fonti dei confronti: [prezzi R2](https://developers.cloudflare.com/r2/pricing/),
[prezzi Nhost](https://nhost.io/pricing),
[budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/),
[restic S3](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html),
[compatibilità S3 R2](https://developers.cloudflare.com/r2/api/s3/api/),
[bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/),
[retention restic](https://restic.readthedocs.io/en/stable/060_forget.html),
[giurisdizione](https://developers.cloudflare.com/r2/reference/data-location/),
[token R2](https://developers.cloudflare.com/r2/api/tokens/),
[access logs R2](https://developers.cloudflare.com/r2/buckets/data-access-logs/),
[cifratura R2](https://developers.cloudflare.com/r2/reference/data-security/),
[durabilità](https://developers.cloudflare.com/r2/reference/durability/).

## Costi: scenari, non preventivo AMR

Standard: 0,015 USD/GB-mese; operazioni Class A 4,50 USD/milione,
Class B 0,36 USD/milione. Quote mensili incluse: 10 GB-mese,
un milione A e dieci milioni B, condivise a livello di account.
Arrotondamento per unità di fatturazione; egress R2 gratuito.

| Consumo ipotetico nel mese | R2 stimato, prima di imposte |
| --- | ---: |
| 100 GB-mese, operazioni entro le quote incluse | 1,35 USD |
| 1.000 GB-mese, operazioni entro le quote incluse | 14,85 USD |
| 100 GB-mese, 10 milioni A, B entro quota | 41,85 USD |

Numeri calcolati dal [listino](https://developers.cloudflare.com/r2/pricing/),
non consumo misurato. Standard evita retrieval fee e permanenza minima
di 30 giorni di Infrequent Access: coerente con i nostri backup giornalieri
e log brevi. L'[attivazione R2](https://developers.cloudflare.com/r2/get-started/)
richiede la sottoscrizione del servizio a consumo, non l'acquisto del piano
Cloudflare Pro. La quota gratuita non è un blocco automatico della spesa.

## Verifica contro il codice

- `backend/nodi/backup-restic.js:45`: wrapper esistente riutilizzabile.
  Timeout 120 secondi, escalation a 125; `verifica` esegue `check --read-data`.
  `retention` fa verifica completa, `forget` e `prune`. All'aumentare del
  repository, i tempi e le risorse remoti possono eccedere il timeout:
  rischio condizionato, non guasto R2 riprodotto. Non aumentare limiti senza
  misure e senza controllare l'impatto sulle ricerche.
- `backend/nodi/backup-postgres-prova.js`: outbox e repository separati già
  esistenti; stato di copia e retention distinto. Un crash fra upload e
  conferma SQL può produrre duplicati. Le ricevute del provider non rendono
  atomiche scrittura R2 e transazione PostgreSQL.
- `backend/report-route.js:21`: bug report attuale tramite `/api/report`,
  JSON fino a 32 KB, messaggio fino a 2.000 caratteri, limite 5/10 minuti;
  `searchParams` accettato come oggetto e append locale a `reports.jsonl`.
  Nessun upload R2 esistente. La nuova integrazione deve definire i campi
  ammessi, senza esportare ciecamente qualunque parametro client.
- `scripts/frontend-parts/search-status.js:499`: report con messaggio e
  dati della ricerca opzionali, conteggio dei risultati. Non allega gli
  annunci. Non aggiungere upload generici per deduzione da questo requisito.
- `backend/nodi/diagnostica-retention.js:3`: retention locale sette giorni;
  la pulizia SQLite non cancellerebbe copie cloud aggiunte successivamente.

## Proposta minima da discutere

1. Bucket privati EU con scope distinti per repository DB, journal, log e
   report. Credenziali dei backup separate da quelle dei file applicativi;
   token di gestione dei bucket esclusi dal runtime dell'app. La manutenzione
   restic deve mantenere le cancellazioni strettamente necessarie al prune.
   L'accesso del proprietario Cloudflare resta un dominio di rischio comune.
2. Backup con restic e chiave esterna di recupero; nessuna lifecycle per età
   o lock generale sul suo repository. Eventuale copia protetta contro la
   compromissione dell'account/app va progettata e provata separatamente.
3. Report attraverso API AMR autenticata: permessi correnti, validazione,
   limiti, testo trattato come non fidato nella UI. Nessuna chiave R2 nel
   browser. I [presigned URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
   sono credenziali bearer valide fino alla scadenza: non ereditarne per
   deduzione la revoca immediata della sessione AMR.
4. Log strutturati e selezionati prima dell'invio; niente cookie, password,
   token, body dei provider o annunci. Dati liberi dei report possono
   contenere informazioni personali: accesso ristretto e durata concordata.
   [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).
5. Archiviazione asincrona fuori dal percorso di ricerca, log raccolti in
   file con dimensione/durata limitate anziché una scrittura per ogni evento;
   oggetti con nomi univoci. R2 limita a una scrittura al secondo sullo stesso
   nome: non usarlo per append continui a `latest.log`.
   [Limiti R2](https://developers.cloudflare.com/r2/platform/limits/).
6. Metadati di consultazione e stato delle copie nel backend/Admin; R2
   conserva i file. Errori di storage distinti dagli errori degli scraper.
   Quote applicative, metriche consumo e alert di budget; nessuna promessa
   di tetto economico assoluto soltanto grazie a queste misure.

Prima di integrare: decidere durata dei bug report, archivio dei log manuale
o automatico e capacità iniziale. Una lifecycle sui file indipendenti può
aiutare, ma le [cancellazioni](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
avvengono normalmente entro 24 ore dalla scadenza, non in un istante preciso.
Backup contenenti quei dati devono avere una policy coerente.

Alternativa concreta per log/report: Nhost include già 50 GB di storage nel
Pro. Può ridurre gestione di un secondo servizio, ma conserva la dipendenza
dal provider del backend. Per i backup indipendenti questa concentrazione
è uno svantaggio; non è dimostrato che spostare subito ogni file su R2 sia
più semplice o più economico nel nostro carico reale.

## Collaudo necessario dopo una scelta esplicita

1. Preparazione locale simulata: schema dei dati, autorizzazione fra due
   aziende, limiti, errori/retry, privacy di log e report. Nessuna rete reale.
2. Dopo autorizzazione del servizio: bucket di prova distinto, dati sintetici
   entro le quote incluse; upload, lettura e confronto di integrità con
   endpoint EU e versione restic effettivamente usata da AMR.
3. Backup DB/journal sintetici → restore isolato → verifica dei dati e replay
   ordinato; prova retention su sole copie sacrificabili. Nessuna modifica
   ai backup vivi per fare esperimenti.
4. Guasti controllati, timeout, permessi insufficienti/revocati, upload riuscito
   con conferma persa; stato Admin fedele senza annunci nei log. Misurare
   invio, lettura completa, prune e impatto sulle ricerche.
5. Osservare consumo R2 e Nhost, numero di operazioni e crescita dopo retention.
   Nessuna estrapolazione di una fattura mensile da un solo file di prova.

Fermarsi se restore o isolamento falliscono, il volume non rientra nei limiti,
la conservazione è incoerente o l'effetto sul budget non è spiegabile.
Non sono ancora verificati throughput AMR/R2, tempi di restore, bolletta
reale e applicabilità dello SLA/supporto al futuro account. Nessuna garanzia
di produzione derivata dalla sola documentazione o dai test locali precedenti.

## Collaudo isolato autorizzato il 7 ottobre

L'utente ha attivato R2 e autorizzato due bucket di prova privati Standard EU,
una nuova credenziale limitata a questi bucket e backup/restore di meno di
10 MiB di dati sintetici. Staging e M2 restano esclusi.

Configurazione verificata nel provider:

- `amr-collaudo-backup-db` e `amr-collaudo-backup-journal` creati, Standard,
  giurisdizione EU; Public Development URL disabilitata, nessun dominio
  pubblico, CORS o bucket lock.
- Solo la regola predefinita che interrompe upload multipart incompleti dopo
  sette giorni. Nessuna cancellazione per età degli oggetti restic.
- Credenziale utente creata: Object Read & Write soltanto sui due bucket,
  TTL 24 ore; nessun permesso Admin né estensione ai bucket futuri. Nome e
  permessi verificati prima dell'invio. I valori non entrano nel registro.
- Endpoint S3 con suffisso `.eu.r2.cloudflarestorage.com`, come richiesto
  dalla giurisdizione. File delle credenziali fuori dalla repo, permessi 0600,
  in directory 0700. Compilazione e salvataggio affidati all'utente.
- La dashboard iniziale indicava zero dati e zero consumo fatturabile. Dopo
  la creazione dei bucket: 11 operazioni Class A, zero Class B e zero byte.
  È una lettura puntuale del pannello, non un consuntivo mensile.

La dashboard presenta una quota gratuita mensile. Non è stata verificata
una scadenza di prova dopo trenta giorni; il consumo oltre la quota può
essere fatturato secondo il [listino R2](https://developers.cloudflare.com/r2/pricing/).

Preparazione locale:

- Restic 0.19.1 darwin/amd64: firma PGP di `SHA256SUMS` verificata con la
  chiave indicata dalla [documentazione ufficiale](https://restic.readthedocs.io/en/stable/020_installation.html).
  Fingerprint `CF8F18F2844575973F79D4E191A6868BD3F7A907`. SHA-256 dell'archivio
  verificato; il binario decompresso coincide con quello già presente.
  SHA-256 binario: `b2b553b402b9971b0c3f673d880397a421526f55a08f21fe5b82b5dd9e049a08`.
  Copia eseguibile verificata in directory temporanea, nessuna installazione
  globale né modifica al keyring personale.
- Script di prova temporaneo riusa `creaRestic`, restringe la destinazione
  ai due bucket e usa un prefisso casuale per esecuzione. Genera soltanto
  byte sintetici e una chiave restic esterna ai repository. Backup, check
  completo, confronto del restore e password errata; retention solo dry-run.
- La prova del file `database.dump` riguarda l'integrità di byte sintetici.
  Non è un dump PostgreSQL: non dimostra restore SQL, replay commerciale,
  outbox dello staging o tempi del database reale.

Verifiche concluse prima dell'esecuzione cloud:

- `test/nodi-backup-restic.test.js`: **61/61**, zero skipped, 82,017 s,
  Node 26.4.0, ambiente vuoto e dati/log temporanei. Abilitati i casi restic
  reale: repository separati, restore, password errata e retention su sole
  fixture locali. Non sono prove di R2 o del runtime distribuito su Nhost.
- Review indipendente in sola lettura: confermato un falso positivo nel
  primo script di collaudo. Il wrapper restituisce lo stesso errore per
  password errata, rete indisponibile e altri guasti; quell'errore generico
  non dimostra il rifiuto della password. Corretto soltanto lo script
  temporaneo, verificando il codice specifico restic `12` con stdout/stderr
  esclusi dai log. Il backend applicativo non è stato modificato.
- Controprova locale effettiva: password errata → `12`, repository assente
  → `10`, password corretta → `0`. I codici sono documentati in
  [restic scripting](https://restic.readthedocs.io/en/stable/075_scripting.html).
  La successiva review statica chiude il finding, senza altri rischi
  concreti confermati; non ha eseguito prove cloud.
- `node --check` sullo script temporaneo e `git diff --check` superati.

Stato al termine della preparazione: configurazione cloud creata;
esecuzione R2 ancora da verificare.
Dopo la comunicazione dell'utente, il controllo locale dei soli campi attesi
ha trovato ancora vuoti entrambi i valori nel file di collaudo. Nessuna
lettura della configurazione reale AMR per cercare credenziali alternative.
Pagina provider lasciata aperta per completare il salvataggio. Nessun dato
di prova caricato, repository R2 inizializzato o snapshot remoto generato.
Nessuna modifica applicativa, commit, deploy, collegamento ai backup vivi
o accesso M2. Allora il resto del collaudo dipendeva dalla configurazione
protetta; il completamento è registrato di seguito.

### Esito live dopo il salvataggio della credenziale

Il successivo salvataggio dell'utente è stato verificato internamente:
soltanto i due campi attesi, entrambi compilati e di formato valido, file
regolare 0600 appartenente all'utente in directory privata 0700. Nessun
valore di credenziale mostrato o incluso in argomenti, report o log.

Esecuzione conclusa il **7 ottobre 2026, 16:08:51 Europe/Rome**, dal processo
di prova sull'iMac con ambiente vuoto, Node 26.4.0 e restic verificato.
Sono stati riusati il wrapper e i metodi reali AMR, con endpoint S3 EU e
prefisso univoco `collaudo-18c9235b-029c-4200-9c60-75af27471938`.

| Repository | Payload sintetico | Backup, check completo e restore | Durata dell'intero ciclo | Retention dry-run |
| --- | ---: | --- | ---: | --- |
| Database | 262.144 byte casuali | riusciti; restore identico byte per byte e SHA-256 | 16,287 s | 1 conservata, 0 eliminabili |
| Journal | 135 byte JSON sintetico | riusciti; restore identico byte per byte e SHA-256 | 24,858 s | 1 conservata, 0 eliminabili |

Totale payload **262.279 byte**, sotto 10 MiB. Il totale riguarda i dati
sintetici, non una misura dei byte trasferiti inclusi metadata e protocollo.
Le durate comprendono init, identità, copia, check, restore e dry-run;
non sono tempi di upload soltanto né benchmark del futuro database.
I due repository hanno identità diverse. La prova con chiave restic errata
su R2 restituisce il codice specifico **12**, non un generico errore di rete.
Sono state ricontrollate da un secondo processo la ricevuta del collaudo,
le dimensioni e gli hash dei due file ripristinati, le due copie conservate
e i permessi privati della chiave di recupero.

Evidenza locale senza credenziali:
`/private/tmp/amr-r2-collaudo-YpHyo4/esito.json`. Chiave restic conservata
separatamente in un file privato nella directory temporanea; è soltanto
la chiave delle copie sintetiche. Questa custodia temporanea non è una
procedura di conservazione della chiave di produzione.

Controllo UI successivo: il bucket database elenca il prefisso della prova,
Default Storage Class Standard e Public Access Disabled. Il pannello mostra
45 operazioni Class A, 29 Class B ma ancora 0 B di Bucket Size. Quest'ultimo
valore non è usato per dedurre assenza di oggetti o misurare storage/fattura;
il restore effettivo via S3 dimostra la lettura dei dati remoti. La causa
della discrepanza del contatore non è stata verificata. L'apertura della
directory nel browser ha incontrato timeout della dashboard; questo non
è un fallimento del percorso restic già completato. Schermata dei segreti
chiusa dopo aver verificato il salvataggio.

**Collaudo minimo R2 superato**, limitatamente a copie cifrate e integrità
del restore di byte sintetici con il wrapper corrente. Nessun finding
ulteriore confermato nel percorso esercitato. Il solo finding della review
indipendente era il falso positivo sulla password, corretto e controprovato
prima dell'esecuzione cloud.

Restano esclusi: restore PostgreSQL e replay dei journal commerciali,
outbox e stato Admin reali, retention con forget/prune su R2, isolamento
fra aziende, permessi di altri bucket, carico, costi mensili e timeout su
copie grandi. Nessun archivio di log o bug report attivato. Le copie di
prova rimangono nei due bucket; nessuna pulizia remota avviata. Il token
mantiene la scadenza a 24 ore scelta alla creazione, non è una credenziale
di produzione. Nessun collegamento staging/M2, deploy o commit.

### Passo successivo: PostgreSQL e journal veri

Concluso il collaudo PG/R2 sintetico: due dump, tredici journal, 250.245
byte cumulativi, restore in un cluster separato e replay dei sette journal
successivi al primo dump. La verifica ha trovato e corretto nel replay la
revoca incompleta degli inviti di un collega; il precedente test sui byte
casuali non avrebbe potuto dimostrarla. Outbox, stato Admin con ruolo
limitato, epoche e permessi verificati nella fixture PostgreSQL.

Evidenze, finding, procedura e limiti nel
[registro PG/R2](storage-r2-postgres-2026-10-07.md). Copie remote conservate,
retention solo dry-run. Staging, M2, dati cliente e storage di log/report
restano scollegati; nessun deploy. Il restore dalla sola R2 senza indice
outbox del source e la custodia della chiave richiedono prove ulteriori.
