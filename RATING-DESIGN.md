# Sistema di rating — DESIGN ARCHIVIATO (non attivo)

> Rimosso dall'app in §21 (troppi problemi di dati sporchi). Questo documento conserva
> il design per un'eventuale ripresa futura. **Il codice completo è nella history git**:
> `frontend/analysis.js` al commit `a718c61` (e §16 nel piano).

## Cos'era
Punteggio 0-100 "affare" per annuncio + flag (affare / prezzo sospetto / km incoerenti /
dato mancante), calcolato client-side sul set di risultati, mostrato come badge + dropdown
"Rating". Modulo isomorfo `frontend/analysis.js` (UMD) condiviso UI + motore-avvisi server.

## Evoluzione del modello (2 iterazioni)
1. **Prezzo vs mediana piatta del cluster** → SBAGLIATO: un'auto vecchia/molti-km è
   economica *perché peggiore*, veniva segnata "affare". Mescola "buon prezzo" con
   "auto desiderabile".
2. **Prezzo ATTESO da modello di deprezzamento** (commit `a718c61`): regressione ridge OLS
   `prezzo ≈ b0 + b1·età + b2·km` sul cluster (predittori scalati, solver 3×3 Gauss,
   esclude self+duplicati). `_score` = residuo vs atteso (solo qualità-prezzo). Flag su
   atteso. Funzionava sui casi sintetici puliti.

## Perché è stato rimosso (il problema NON risolto)
È **garbage-in**: i comparabili NON sono comparabili. Nello stesso cluster finiscono:
- **ricambi** (Subito mescola "vendo per ricambi" nella categoria auto via `q=` testo-libero);
- **auto incidentate/rotte** (prezzo basso per condizione dichiarata SOLO in descrizione);
- **dati sbagliati** (titoli/anno/km scritti male dal venditore);
- **varianti diverse** (320d vs 320i, trim più/meno costosi).

Nessuna statistica (robustezza, shrinkage, k-NN, OLS) salva comparabili sbagliati.
Tentativi valutati e scartati:
- **Classificatore da titolo** → fragile: "MAI incidentata" / "no ricambi" = falsi positivi
  (negazione), danneggia proprio l'obiettivo (papà perde i buoni annunci).
- **Filtro-prezzo** (escludere i più economici dal fit) → becca solo la spazzatura più
  economica; un'incidentata guidabile a prezzo MEDIO resta falso-affare in lista.
- **Fetch descrizioni di massa** → lento / blocco scraper (Subito DataDome).

## Se si riprende in futuro — direzioni
- Capire la **condizione** di ogni annuncio richiede la **descrizione**, che sta solo nel
  dettaglio → serve un fetch sostenibile (mirato/bounded) o una sorgente dati che la dia in lista.
- Sfruttare i **dati strutturati AS24** (`vehicle.modelId`/`variant`/`transmission`/
  `engineDisplacementInCCM`) per varianti accurate — già fatto a fini display in §22.
- Eventuale segnale-condizione strutturato (AS24 `specialConditions`) se valorizzato.

## Cosa resta nell'app dopo la rimozione
- `clusterModello` (spostato in `frontend/app.js`) per il group-by "Modello/variante".
- Avvisi ricerche-salvate **solo price-based**: `nuovo` + `calo` (niente "affare").
- Dettaglio on-click (§15/§22): spec + dati strutturati AS24, senza punteggio.
