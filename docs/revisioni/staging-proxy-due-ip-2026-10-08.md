# Due IP aggiuntivi per il collaudo staging — 8 ottobre 2026

## Autorizzazione e modifica

Il proprietario autorizza l'aggiunta provvisoria dei soli `10.110.1.249`
e `10.110.21.247`, osservati nella nuova sonda. Unica voce Run aggiornata:

```toml
name = "AMR_CENTRO_PROXY_IP"
value = "{{ secrets.AMR_CENTRO_PROXY_IP }},10.110.18.147,10.110.1.249,10.110.21.247"
```

Il riferimento preserva la lista precedente senza acquisire tutti i segreti
del progetto. Restano invariati immagine, comando, repliche, volume, Auth,
altri environment e controlli di accesso. Nessun ruolo SQL, segreto del
progetto, nodo, scraper o backup automatico modificato. Originale `66e2b24`
ancora distribuito; candidato locale `b8e8050` non caricato o distribuito.
Il commit `31967c2` conserva le precedenti misure e il gate locale.

## Prove e controprove

- Preflight senza mutazioni: configurazione esatta rispetto allo snapshot,
  servizio Running e una replica ready. Nuova rilettura immediatamente
  prima dell'unico apply; ACK e readback esatto confermati. Altri campi e
  tutti gli altri environment confrontati integralmente, invariati.
- Validatore del pacchetto applicato a vecchio/nuovo stato, senza risolvere
  segreti remoti. **21 controprove locali** sul middleware reale: i due
  peer sono negati dalla lista storica e ammessi dopo l'append; IP vicini,
  Host, Origin e protocollo errati rimangono negati. La lista storica
  sintetica non equivale a verificare il valore remoto del segreto.
- Nuova replica Running/ready, data successiva all'inizio dell'apply e
  configurazione ancora esatta. Letture di config e status separate:
  questa verifica non è l'attestazione crittografica di una revisione.
- **16/16 controlli ingress remoti PASS**: liveness, modalità Nhost,
  dinieghi per Admin/ricerca/backup/nodo anonimi, GET ricerca disabilitato,
  login sintetico disabilitato, header falsificati, cookie di bootstrap
  protetto, Origin assente/estranea/null e Host estraneo. L'Host estraneo
  è negato dal routing: non attribuirlo al guard AMR.
- Verifica separata del frontend `/`: **200**, senza cookie. Non equivale
  a un collaudo manuale della UI o del login; nessuna preview aperta.
- Il resolver del Mac è invariato: risoluzione pubblica limitata al processo
  di verifica, soli IPv4 globali, TLS e hostname verificati. I cookie vengono
  verificati in RAM, mai salvati o riportati.

La review indipendente ha confermato il delta e l'assenza di percorsi verso
credenziali risolte, SQL o M2. Finding **condizionato**: il confronto prima
dell'apply non è un CAS atomico; un altro writer simultaneo potrebbe essere
sovrascritto. Nessuna sovrascrittura riprodotta. L'introspezione Cloud mostra
`updateRunServiceConfig(appID, serviceID, config)` senza precondizione di
versione nel relativo input. Operazione unica, senza altri deploy avviati
da questa chat; proprietario avvisato di non cambiare la dashboard durante
il passaggio. Nessun lock locale presentato come difesa da writer esterni.
Seconda review: ricevute ACK/readback/readiness non dichiarano un gate Auth.

## Esito e limiti

Il 403 generalizzato è assente nel campione dopo la sola modifica della
lista. Questo sostiene la diagnosi ingress, ma non prova stabilità futura
dei peer, isolamento della rete interna o correttezza di login/MFA.
La [guida Express](https://expressjs.com/en/guide/behind-proxies/) richiede
fiducia coerente con il proxy effettivo. Il contratto stabile dell'ingress
Nhost resta da chiarire prima della produzione; non aggiungere automaticamente
altri peer o subnet.

Ricevute private in
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-proxy-due-ip-20261008-2_g894qi/`:
`esito-preflight.json`, `esito-execute.json`, `readback.json`, `ingress.json`,
`frontend.json`.
`stato-validato.json` conserva il nuovo snapshot non risolto per il prossimo
checkpoint: un executor fissato alla vecchia lista deve fermarsi, non
eliminare le aggiunte appena autorizzate.

Aggiornamento successivo: il [checkpoint](checkpoint-staging-2026-10-08.md)
non è acquisito. Dopo il recovery dell'originale, nuove richieste anonime
alternano 200/403 sul frontend e 401/403 sull'API protetta, con liveness 200.
La modifica autorizzata rimane applicata, ma il PASS 16/16 precedente non
prova accesso stabile dopo il riavvio. L'indagine deve isolare il controllo
che produce il 403. Il proprietario ha escluso il contatto al supporto:
verificare prima le nostre assunzioni e il guard effettivamente distribuito.
Poi: checkpoint fresco, cifratura e restore isolato; candidato remoto e M2
solo stato. CHECK storico e stabilità ingress restano gate di produzione.

**Diagnosi successiva verificata:** la sonda multiarch delle 05:25 UTC
misura `10.110.1.21` non fidato e `10.110.1.249` fidato nella stessa istanza,
con Host atteso e protocollo https. Il middleware originale riproduce
403/200 rispettivamente. La lista dei campioni precedenti non copre tutti
i percorsi osservati; il PASS iniziale non ne dimostrava l'esaustività.
Dettagli e controprove nel [checkpoint](checkpoint-staging-2026-10-08.md).
Originale ripristinato, nessun ulteriore IP aggiunto. Prima del prossimo
checkpoint serve concordare la correzione della policy ingress; un nuovo
IP provvisorio non chiuderebbe il requisito di stabilità per la produzione.
