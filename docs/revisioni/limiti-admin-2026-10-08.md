# Limiti delle nuove ricerche — 8 ottobre 2026

## Perimetro concordato

Segue il punto 6 del registro console. Baseline `9708b8f`, branch
`feat/nodi-residenziali-prototipo`. I limiti iniziali approvati restano
60 secondi, 2 richieste pendenti per persona e 60 complessive. L'Admin può
ridurli e ripristinarli entro questi massimi; aumentarli oltre il perimetro
richiede una nuova prova di capacità. Nessun valore viene presentato come
capacità misurata del SaaS.

Questo incremento prepara il backend, non la nuova console: nessun frontend,
deploy, credenziale, catalogo, richiesta ai portali o collegamento M2 modificato.
Le modifiche locali preesistenti sono preservate.

## Contratto e implementazione

- `GET /api/admin/limiti` restituisce valori, massimi e revisione.
- `POST /api/admin/limiti` accetta soltanto revisione corrente e tre interi
  positivi: `timeoutMs`, `maxPersona`, `maxTotale`. Nessuna coercizione o campo
  operatore proveniente dal body. Configurazione obsoleta: 409.
- Si riusano controlli Admin/MFA, sessione, origine e header esplicito.
  L'autorizzazione viene ricontrollata dopo la lettura del body, come per
  manutenzione e sospensioni. Body massimo 1 KiB.
- SQLite conserva configurazione e audit prima/dopo nello stesso commit.
  Un errore di audit annulla anche il cambio delle soglie. L'operatore è
  l'identificatore server, senza email; `locale` vale solo nel collaudo locale.
- Audit: sette giorni, pulizia all'avvio e periodica tramite la retention
  esistente, massimo 10.000 righe recenti. Se il cap è pieno, il comando si
  ferma esplicitamente senza eliminare la storia recente.
- Le impostazioni di avvio possono restringere i massimi. Il riavvio non
  sovrascrive la configurazione persistita. Se questa supera i nuovi massimi
  del processo, l'avvio fallisce: niente rialzo o correzione silenziosa.
- Ogni ammissione conserva revisione e limiti. Ricerche già ammesse terminano
  con il proprio budget; gli stessi ID restano consultabili senza nuova
  ammissione. I contatori attivi restano conteggiati dopo una riduzione.
- La condivisione della prima pagina distingue anche la revisione dei limiti:
  una nuova richiesta non eredita il budget di un'esecuzione già in corso
  con impostazioni diverse. Questo può aumentare le chiamate durante un
  cambio di configurazione; evita di applicare alla nuova ricerca la vecchia
  deadline. Cursori, retry, affinità e pause delle fonti restano invariati.

## Prove, controprove e review

Node 24.21.0, SQLite e HTTP loopback, sessioni sintetiche; nessuna credenziale
reale o rete verso portali. Gate finale pertinente: **90/90**, zero fail/skip/cancel,
5,595 s. File: `nodi-limiti-configurazione`, `nodi-limiti-ricerca`,
`nodi-centro-run`, `nodi-proprietario-http`, `nodi-manutenzione`,
`nodi-diagnostica-retention` e `nodi-diagnostica-guasti`.

Coperti: persistenza, rollback, CAS, input inattesi, cap audit, quote e budget
dei vecchi/nuovi avvii, retry dello stesso ID, origine/header/MFA e mancata
condivisione fra revisioni diverse.

Review indipendente in sola lettura: due finding confermati e corretti.

1. Revoca Admin durante un body HTTP incompleto: il vecchio handler scriveva
   configurazione e audit con 200, mentre una nuova richiesta era già negata.
   La nuova regressione falliva 200 contro 403; dopo il secondo controllo
   ritorna 403, revisione e audit invariati. Nessun await fra quel controllo
   e la transazione sincrona.
2. Audit scaduto senza altre modifiche: dopo otto giorni rimaneva una riga.
   La nuova regressione falliva 1 contro 0; la pulizia periodica ora la elimina
   anche senza nuovi comandi e preserva revisione e valori correnti.

Non è un collaudo delle API sul candidato remoto né della futura UI. Restano
da integrare rappresentazione, conferma dei valori e conflitto 409 durante il
gate frontend. L'audit non è un backup esterno o una garanzia antimanomissione
contro un amministratore del computer.

## Fonti autorevoli

- [OWASP API4: consumo di risorse](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/):
  limiti di esecuzione e risorse; non prescrive i numeri AMR.
- [OWASP: input validation](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html):
  validazione strutturale e intervalli espliciti.
- [OWASP: logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html):
  protezione degli identificativi, accessi e prove dei guasti dell'audit.

Il punto 6 ha ora un contratto backend verificato; non anticipa il punto 8.
Restano aperti notifiche/ripristino silenzioso, baseline live, backup operativo,
CHECK storico, candidato remoto e collegamento isolato M2.
