# Richiesta tecnica Nhost Run — ingress HTTPS

Bozza storica per il supporto del progetto AMR staging. **Non inviata e
invio escluso dal proprietario.** Resta come elenco delle incertezze di
rete; non richiede di contattare il supporto per proseguire l'indagine.
Nessuna credenziale, cookie, dato cliente o richiesta agli scraper.
Non richiede modifiche al servizio da parte del supporto: prima chiarire
il contratto di rete e la configurazione raccomandata.

Il testo seguente fotografa l'indagine prima della sonda riuscita. La
[diagnosi successiva](checkpoint-staging-2026-10-08.md#misura-riuscita-e-causa-verificata-del-diniego)
identifica un peer non fidato e riproduce il 403 con il middleware originale;
resta da definire una policy duratura, senza contattare il supporto.

## Testo della richiesta

Usiamo Nhost Run per il servizio `amr-centro-staging`, esposto tramite HTTPS
sulla porta 3000, una replica. Il backend accetta Host atteso e HTTPS;
per fidarsi di `X-Forwarded-Proto` verifica anche che il peer del socket sia
un reverse proxy esplicitamente autorizzato.

Sonde isolate hanno osservato peer interni differenti fra avvii. Abbiamo
aggiunto provvisoriamente i soli IP osservati, senza rimuovere gli altri
controlli. Dopo questa modifica, sedici controlli ingress consecutivi sono
passati. Dopo un successivo riavvio, con configurazione originale invariata,
fra le 03:04 e le 03:05 UTC dell'8 ottobre 2026 osserviamo:

- `/healthz`, esclusa dal guard di trasporto: tre risposte 200;
- frontend `/`: 403, 200, 200;
- API protetta richiesta senza login: 403, 403, 401 atteso.

La replica risulta Running/ready. Non abbiamo ancora identificato il peer
e gli header corrispondenti a ciascuna di queste risposte: l'ipotesi ingress
non è presentata come causa già dimostrata.

Vorremmo una configurazione supportata e stabile, senza rendere fidata
un'intera rete privata sulla base di pochi campioni:

1. Qual è il contratto per identificare i reverse proxy Run fidati:
   IP/CIDR stabili, altro meccanismo autenticato o network policy?
2. Il peer interno può variare anche fra richieste alla stessa replica?
3. Chi può raggiungere direttamente la porta HTTP interna del servizio:
   solo ingress, altri workload dello stesso progetto o anche altri
   progetti/organizzazioni? Quali garanzie di isolamento sono applicate?
4. Il proxy sovrascrive sempre `X-Forwarded-For`, `X-Forwarded-Host` e
   `X-Forwarded-Proto`, inclusi header duplicati o inviati dal chiamante?
5. Qual è la configurazione raccomandata per un backend Node/Express
   che impone HTTPS, Host/Origin e cookie Secure? Come vengono comunicati
   cambiamenti dell'ingress?
6. Quali metadati diagnostici minimi possiamo raccogliere per distinguere
   un rifiuto del routing Nhost da un rifiuto del backend, senza registrare
   credenziali o dati applicativi?

## Evidenze e limiti

[Registro del checkpoint](checkpoint-staging-2026-10-08.md) e
[modifica dei due IP autorizzati](staging-proxy-due-ip-2026-10-08.md).
La [documentazione Run](https://docs.nhost.io/products/run/networking)
descrive rete condivisa ed esposizione HTTPS; nella pagina consultata non
abbiamo trovato un contratto stabile dei peer. Non presumiamo che tale
contratto sia assente da ogni documentazione o canale di supporto.
La [guida Express](https://expressjs.com/en/guide/behind-proxies/) richiede
una configurazione di fiducia coerente con il proxy effettivo.
