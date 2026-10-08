# Candidato ingress nello staging — 8 ottobre 2026

Segue il [checkpoint e recovery verificati](checkpoint-ingress-2026-10-08.md).
Branch `feat/nodi-residenziali-prototipo`. Staging Nhost AMR soltanto;
nessun intervento M2, richiesta ai portali o rilascio di produzione.

## Candidato effettivamente distribuito

- Release: `d632f5032b8188751e4a64fca5dfcfc8ac319465`.
- Digest multiarch: `sha256:4ed5414ae8cae68c5e8f7df345d4103dbdce704251ad4e30e4ff65292393e64f`.
- Codice: `35e6c369a75bc5bbe406425db5986e96b136fcddf404b95f8fbd64006f1e6d60`.
- Cataloghi: `0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`.

La build e il gate Auth/PostgreSQL locali riguardano questa immagine; i
successivi commit di documentazione e test non cambiano il runtime remoto.
Il preflight canonico ha confrontato piano, ricevute di upload e restore,
manifest e SHA del pacchetto SQL. Zero mutazioni nel preflight.

L'aggiornamento ha confermato l'arresto dopo due osservazioni: repliche
richieste ed effettive zero, connessioni dei tre ruoli AMR zero, risposta
HTTP di indisponibilità. Il 200 vuoto di `/healthz` in questa fase è distinto
dal body applicativo `ok` richiesto per confermare l'avvio.

Applicato un pacchetto SQL atomico che incorpora i tre incrementi
`schema-referente-sessioni.sql`, `schema-referente-retry.sql` e
`schema-login-inizio.sql`. SHA del pacchetto:
`8c08ac398a1e3941b34501b8ffef1739eb5d87465cdb7f446af758ab215901e8`.
Il suo header storico nomina un candidato precedente: i tre payload sono
stati confrontati con i blob di `d632f50` e risultano identici.
Nessun bootstrap, reset o backfill. PostgreSQL resta 18; aziende e persone
restano rispettivamente **2 e 2**. Il conteggio non prova da solo l'identità
di ogni riga: la preservazione deriva anche dalla review del pacchetto,
che non invoca comandi commerciali né modifica righe applicative.

Configurazione finale confrontata interamente: stessa porta, risorse,
volume dichiarato e riferimenti ai segreti. Cambiano immagine e policy
ingress: `AMR_CENTRO_INGRESS=nhost`, senza `AMR_CENTRO_PROXY_IP`.
Non è stata eseguita una rotazione dei token dei nodi.

Durante l'avvio è stato eseguito un solo rinnovo della replica dopo 150
secondi senza pod visibile. La replica finale è Running/ready, data di
avvio **13:39:04 UTC**. Esito finale verificato alle **13:39:26 UTC**.
Il manifest ricevuto dalla rotta del nodo coincide nei quattro campi;
questa lettura non collega o certifica un worker operativo.

## Prove e controprove dell'esecutore

Ventuno scenari simulati, nessuna rete: preflight, piano errato, baseline
non pronta, schema già presente, arresto fallito, ACK SQL incerto, dati
postflight inattesi, configurazione estranea, avvio fallito, rinnovo
incerto, manifest errato, ingress fallito, segnali e cleanup.
Il SQL viene inviato al massimo una volta; un conflitto non autorizza
a sovrascrivere una configurazione estranea. Il rollback non ripristina
o cancella dati: riporta l'immagine originale lasciando lo schema esteso,
le cui interfacce sono state verificate compatibili col vecchio runtime.

La review indipendente ha confermato un finding nell'attesa dell'avvio:
un ACK incerto del rinnovo poteva lasciare il candidato attivo pur con
esito fallito. Ora il flag è controllato prima della verifica e prima di
`success=True`; la controprova richiede il rollback e nessun controllo
anonimo dopo il rinnovo incerto. Rilettura indipendente: finding chiuso.
I 21 modelli sono eseguiti dal main, non nuovamente dal reviewer.

Guard prima/dopo e readback non costituiscono CAS. Non apportare altre
modifiche alla configurazione Run durante questa procedura. La prova
remota riuscita non è una prova remota di tutti i percorsi di rollback.

## Ingress remoto

**16/16 controlli PASS**, 2.678 ms complessivi, senza login, annunci o
reinvio dei cookie:

- `/healthz`: 200 e body `ok`; configurazione pubblica: 200, modalità Nhost.
- Identità, Admin, backup, ricerca e registrazione nodo anonimi: 401.
- Vecchia ricerca GET: 405; login sintetico: 404.
- Header inoltrati falsificati non concedono accesso Admin.
- Bootstrap: cookie Secure/HttpOnly/SameSite Strict, senza Domain.
- Origin assente/estranea/null: 403; Host estraneo: 404.

L'ultimo diniego può provenire dal routing Nhost: non certifica da solo
il guard Host applicativo. Questi controlli non provano l'isolamento
della rete interna, Auth remoto completo, la sessione MFA, i backup R2,
il funzionamento delle ricerche o un futuro comportamento stabile del DNS.
Il precedente 403 sul percorso pubblico non ricompare nel campione.

Ricevute private nella directory
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-checkpoint-nhost-20261008-yex4nmod/`:
`candidato-preflight.json`, `candidato-execute.json` e
`controprove-candidato.py`. Non contengono credenziali risolte.

## Gate ancora aperti

Richiesto all'utente il login Admin/MFA e l'apertura di «Account e aziende»
e «Nodi e lavori», senza avviare ricerche. La conferma manuale è ancora
pendente; non dichiarare concluso il collaudo Auth remoto.
Seguono runtime R2/Better Stack, poi M2 isolato solo stato/compatibilità.
Il CHECK storico resta non riprodotto e non spiegato; produzione e
redesign della console non sono autorizzati da questo esito.

Fonti ufficiali: [deploy Run](https://docs.nhost.io/products/run/cli-deployments),
[health check Run](https://docs.nhost.io/products/run/health-checks),
[transazioni PostgreSQL](https://www.postgresql.org/docs/18/tutorial-transactions.html).
