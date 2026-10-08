# Checkpoint dello staging con ingress Nhost — 8 ottobre 2026

## Perimetro e preparazione

Prosegue il gate ordinato della [policy ingress](ingress-policy-2026-10-08.md).
Sono autorizzati checkpoint cifrato PostgreSQL + volume Run, restore isolato,
aggiornamento del solo staging e successivo M2 solo stato. Produzione M2 esclusa.

La configurazione Run originale è confrontata integralmente con la ricevuta
validata. Il preflight osserva una replica pronta e `/healthz` 200; accetta
solo la risposta applicativa originale nota, 200 oppure il 403 del vecchio
guard con body e header esatti. Questo non costituisce un gate Auth superato.

Immagine di manutenzione dai tre blob del commit `4d329e8`, caricata nel
registry di staging e verificata amd64/arm64:

`sha256:80a30f3ff4bada3cdba67841c6d27a3835f7827001b21d56da55afdf0cbf1b51`.

Fixture amd64 legacy e arm64 `AMR_BACKUP_INGRESS=nhost`: dump PostgreSQL
18.6, cifratura, due repository e restore senza rete PASS. Dimensioni
sintetiche: archivio PostgreSQL 10.240 byte, SQLite 20.480 byte.
Nessun dato cloud in queste fixture; nessun prune o modifica dei container
di collaudo preesistenti.

## Finding verificati prima del checkpoint remoto

La review indipendente ha segnalato tre guard del recovery/restore:

- Il controller temporaneo poteva essere interrotto mentre disabilitava
  i segnali nel `finally`. Ora registra SIGINT/SIGTERM e li osserva ai
  confini di fase; il recovery non solleva eccezioni per questi segnali.
- Un errore successivo all'assegnazione di `ok=true` poteva lasciare un
  falso PASS. L'`except` azzera l'esito e il controllo finale esclude errori,
  interruzioni e recovery/cleanup non confermati.
- Nel conservatore, un container con nome atteso ma label/ID discordanti
  non veniva rimosso, correttamente, ma lasciava `cleanup=true`. Ora il
  controllo `pulisciRestore` fallisce senza rimuovere il container estraneo;
  il chiamante registra `cleanup=false` e `restore=false`.

Prove: 16/16 test backup; 8 scenari del controller (download 403/503,
mutazione senza ack, ruolo negato, cifratura lunga, chiusura CLI fallita,
arresto lungo, successo); 3 controprove aggiuntive su errore finale e
segnali durante cleanup/dopo download. Tutte PASS. Controlli del readback
grezzo/tipizzato e degli schemi sconosciuti: 14 casi PASS.

Le prove del controller sono simulate; quelle Docker sono locali. Il
checkpoint remoto e il ritorno verificato all'originale richiedono una
ricevuta di esecuzione separata.

Evidenze private prive di body applicativi, cookie o segreti:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-checkpoint-nhost-20261008-yex4nmod/`.

## Riferimenti

[PostgreSQL pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html):
snapshot consistente; i ruoli globali richiedono una copia distinta. Il
dump proviene esclusivamente dal nostro progetto e il restore viene
eseguito in risorse nuove senza rete.
[Nhost CLI deployments](https://docs.nhost.io/products/run/cli-deployments):
build multiarch e deployment della configurazione Run. La procedura usa
un digest immutabile, readback completo e rollback alla configurazione esatta.
