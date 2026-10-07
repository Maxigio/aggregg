# Aggiunta del proxy nello staging — 7 ottobre 2026

## Decisione e perimetro

Il proprietario autorizza l'aggiunta provvisoria del peer osservato
`10.110.18.147` alla lista dello staging, mantenendo gli altri controlli.
Applicata al solo environment `AMR_CENTRO_PROXY_IP` di `amr-centro-staging`:

```toml
value = "{{ secrets.AMR_CENTRO_PROXY_IP }},10.110.18.147"
```

Il riferimento conserva la lista esistente senza leggerla o sovrascriverla.
Nessuna modifica del segreto del progetto, immagine, comando, repliche,
volume, Auth, SQL, nodi o scraper. Il candidato e90b88a non è distribuito.
L'originale 66e2b24 rimane il runtime dello staging. Nessun intervento M2.
La decisione non autorizza subnet, fiducia automatica in nuovi peer o produzione.

## Prove e controprove

- Preflight API `resolve:false`: configurazione esatta rispetto all'originale
  salvato, servizio Running, una replica ready. Secondo confronto prima della
  mutazione; unico payload con `environment`, unica voce modificata.
- Nhost conferma la mutazione e il readback esatto; altri environment e tutti
  gli altri campi invariati. Nessun retry delle mutazioni non confermate.
- CLI ufficiale 1.51.2 `run config-show`, HOME e `.secrets` solo sintetici:
  la concatenazione conserva i due IP storici e un ulteriore IP sintetico.
  Non risolve segreti remoti e non avvia servizi. L'IP sintetico non è aggiunto
  alla configurazione reale.
- 21 controprove locali con `trasporto-prova.js`: il vecchio elenco nega il
  nuovo peer; il nuovo lo ammette solo con Host/Origin/protocollo corretti.
  IP vicini, header falsificati o duplicati e origini estranee restano negati.
- `prepara-aggiornamento-staging.js` accetta il solo riferimento atteso seguito
  da IP letterali validi; rifiuta CIDR, altri template e elementi vuoti.
  I piani di aggiornamento e rollback conservano la nuova espressione.
- Review indipendente in sola lettura: confermata la perdita potenziale degli
  IP correnti con una sostituzione letterale; proposta abbandonata in favore
  dell'append. Confermato e corretto un TypeError introdotto nel validatore
  quando manca il campo proxy e il campo owner compensa il numero di voci.
- Suite pertinente dopo la correzione: **53 casi, 51 pass, due skip opt-in,
  zero failure/cancelled**, Node 24.21.0 e dati temporanei. I gate opt-in non
  sono eseguiti in questo incremento.
- Dopo l'apply: nuova replica ready, configurazione esatta, **16/16 controlli
  ingress anonimi PASS**. TLS, dinieghi Admin/backup/ricerca/nodo, Origin,
  header falsificati e cookie di bootstrap controllati. L'Host estraneo riceve
  404 dal routing: non viene presentato come prova del guard interno.

Il resolver DNS del Mac non è modificato: la sonda usa soltanto nel proprio
processo risposte pubbliche concordanti Google/Cloudflare, preservando TLS e
hostname. Il campione non prova stabilità futura dei peer, login/MFA,
ricerche, backup, CHECK storico o collaudo del candidato e90b88a.

Ricevute private locali, prive di credenziali:

- `/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-proxy-cli-20261007-d25x7_i3/esito.json`;
- `/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-proxy-apply-20261007-9qvau2qe/esito-execute.json`;
- `/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-proxy-remoto-20261007-nnvfma3w/esito.json`.
- Suite finale: `/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-proxy-verificato-20261007-lw7grx48/mirati.tap`.

Per annullare questa aggiunta si ripristina la sola voce environment al
riferimento originario. Per i prossimi aggiornamenti va acquisito uno snapshot
non sensibile aggiornato: gli executor fissati alla vecchia configurazione
devono rifiutare questo stato, non sovrascriverlo.

## Ordine concordato dei prossimi incrementi

Affrontare un punto alla volta, con analisi, interview, implementazione,
controprove e commit: 2 riapertura fonti; 3 riavvio worker; 4 affidabilità
notifiche; 5 baseline prestazioni; 6 comandi/soglie console; 7 storage backup.
Prima del punto 8 frontend: CHECK intermittente, poi collaudo remoto del
candidato e collegamento M2 nei gate concordati, infine review del branch
e correzione dei finding confermati. Commit dopo ciascun punto concluso.
Non anticipare l'implementazione della console.

## Riferimenti ufficiali verificati

- [Express: reverse proxy](https://expressjs.com/en/guide/behind-proxies/):
  fiducia coerente con socket e comportamento del proxy, non con header client.
- [Nhost: environment](https://docs.nhost.io/platform/cloud/environment-variables):
  interpolazione dei riferimenti anche dentro altri valori.
- [Nhost: configurazione Run](https://docs.nhost.io/products/run/configuration):
  environment del singolo servizio separato da quello globale.
- [CLI 1.51.2: config-show](https://github.com/nhost/nhost/blob/cli%401.51.2/cli/cmd/run/config_show.go):
  risoluzione locale dei soli segreti sintetici nella prova.
