# Riferimento scraper — il modello Subito come baseline

> **Scopo di questo documento**: fissare il risultato ideale raggiunto su Subito.it e usarlo come baseline per rivedere **Autoscout24** e **Moto.it**.
> Ogni sito ha le sue peculiarità tecniche, ma l'obiettivo utente è lo stesso e non negoziabile.

---

## 1. Definizione di "risultato ideale"

Dal punto di vista dell'utente finale (padre, non tecnico, uso quotidiano):

| Requisito | Regola | Verifica |
|-----------|--------|----------|
| **Completezza** | Nessun annuncio economico mancante rispetto al sito originale | Confronto URL-per-URL con il sito: `mancanti = 0`, `extra = 0` |
| **Ordinamento** | Prezzo crescente, già dal server del sito (non post-sort) | Top 5 confronto posizione-per-posizione con il sito |
| **Profondità** | Almeno 60 risultati (~2 pagine Subito) sufficienti per l'uso reale | Pag1 + pag2 = ~60 annunci dedup |
| **Match marca/modello** | Annunci pertinenti anche con titoli "creativi" dei venditori | Caso KTM 1190 Adventure: titoli tipo "Adventure 1190" non devono essere scartati |

**Principio cardine**: _completezza > velocità_. Non deve mai mancare l'annuncio più economico.

---

## 2. Cosa fa Subito e perché funziona

### 2.1 Filtro server-side via URL (la cosa più importante)
Il sito filtra già per marca, modello, prezzo, anno, km. Ci fidiamo di quello che ci restituisce e **non riapplichiamo** il filtro marca/modello sul titolo.

**Pattern URL**:
- Auto: `/annunci-{regione}/vendita/auto/{marca}/{modello}/?order=priceasc&o=N`
- Moto: `/annunci-{regione}/vendita/moto-e-scooter/?bb={brandKey}&bm={modelKey}&order=priceasc&o=N`
- Parametri numerici: `ps` (prezzoMin), `pe` (prezzoMax), `ys`/`ye` (anno), `me` (km come indice categoria, **non** valore raw)
- Sort: `order=priceasc`
- Paginazione: `o=N` (1-based)

### 2.2 Regola d'oro del post-filter (backend/server.js:132-171)
> _Se il sito ha già filtrato server-side, il post-filter sul titolo NON deve rieseguire lo stesso controllo._

Il bug risolto (KTM 1190 Adventure): 21 annunci validi venivano scartati dal post-filter che cercava `1190adventure` nel titolo normalizzato. I venditori scrivono titoli come "Adventure 1190", "KTM 1190 r", "moto KTM 1190 adv s" — tutti validi ma rigettati.

**Flag da verificare** prima di applicare il controllo titolo:
```js
const subitoFiltered    = r.fonte === 'subito'    && (params.tipo === 'auto' || params.motoBrandKey);
const autoscoutFiltered = r.fonte === 'autoscout' && (params.slugAutoscout || params.mmmvAutoscout);
const motoitFiltered    = r.fonte === 'moto'      && (params.slugMoto);
```
Se una di queste è vera → skip del check sul titolo per marca. Stesso pattern per il modello.

### 2.3 Estrazione dati strutturati
Subito espone tutti i dati (titolo, prezzo, km, anno, carburante, provincia, url) nel JSON `#__NEXT_DATA__` lato pagina. Zero parsing HTML fragile.

### 2.4 Anti-WAF
Akamai blocca axios → usiamo **Playwright Chrome headless** con flag `--disable-blink-features=AutomationControlled` e script che nasconde `navigator.webdriver`. Browser singleton + rate limit 2s tra ricerche + pausa randomizzata 800–1400ms tra pag1 e pag2.

### 2.5 Dedup
Dedup per `url` dopo aver concatenato pag1 + pag2.

---

## 3. Check di portabilità ad Autoscout24 / Moto.it

Per ogni sito, prima di toccare il codice, rispondere a queste domande:

| # | Domanda | Subito (riferimento) | Autoscout24 | Moto.it |
|---|---------|----------------------|-------------|---------|
| 1 | Il sito supporta un **sort priceasc via URL**? | ✅ `order=priceasc` | ❓ da verificare (attualmente non impostato in `autoscout.js`) | ❓ da verificare |
| 2 | Il sito **filtra server-side** per marca/modello? | ✅ via path/param | ✅ via path | ✅ via path |
| 3 | Quanti **risultati per pagina**? E quante pagine prendiamo? | 30/pagina × 2 = 60 | ❓ | ❓ (commento nel codice: solo ~13 SSR) |
| 4 | Esiste un **JSON strutturato** (Next/Nuxt data, API interna) o dobbiamo scrapare HTML? | `__NEXT_DATA__` | HTML Cheerio | HTML Cheerio |
| 5 | Il sito ha **anti-bot aggressivo** (richiede Playwright) o axios basta? | Playwright obbligatorio | axios | axios |
| 6 | Il sito espone **categorie separate** per accessori vs veicoli? | Sì (cat 3 vs 36 — già usiamo la 3) | da verificare | da verificare |
| 7 | Il **post-filter titolo** in `server.js` gestisce già il caso? | Sì (`autoscoutFiltered`, `motoitFiltered`) | Sì | Sì |

### Priorità suggerita per il lavoro su AS / Moto.it
1. **Sort priceasc**: verificare che l'URL includa il parametro di ordinamento. Se no, completezza compromessa quando i risultati sono più di una pagina.
2. **Paginazione profonda come Subito**: almeno 2 pagine o l'equivalente di ~60 risultati, altrimenti perdiamo annunci economici.
3. **Script di confronto** analogo a `C:\temp\compare_subito.js`, adattato al sito.
4. **Dedup per URL**.
5. Verificare che il post-filter in [backend/server.js:143-157](backend/server.js:143) abbia i flag giusti per il sito (già presenti, confermare solo).

---

## 4. Benchmark da superare (test di non-regressione)

I 5 test che su Subito oggi danno **100% match, 0 mancanti, 0 extra**:

1. Auto Fiat Panda (no filtri) — archivio 20.500
2. Auto Toyota Yaris (prezzoMax 8.000) — archivio 1.814
3. Moto Yamaha MT-07 (prezzoMax 6.000) — archivio 805
4. Moto KTM 1190 Adventure (no filtri) — archivio 159 (**caso titoli creativi**)
5. Auto Audi A3 (annoMin 2015, prezzoMax 20.000) — archivio 2.519

Quando si lavora su AS/Moto.it, rieseguire questi test e verificare che il match con Subito resti al 100%, e che AS/Moto.it contribuiscano risultati coerenti (stesso ordinamento priceasc, nessuna perdita).

Lo script `compare_subito.js` è in `C:\temp\` ed è il modello da replicare per gli altri siti (usa `execFileSync('curl', ...)` per evitare problemi di quoting shell su Windows, e replica gli header di `backend/scrapers/utils.js` per evitare blocchi 403).

---

## 5. Problemi noti ancora aperti su Subito (bassa priorità)

| # | File:riga | Descrizione | Impatto |
|---|-----------|-------------|---------|
| 1 | [backend/scrapers/subito-playwright.js:194](backend/scrapers/subito-playwright.js:194) | `pag2` viene saltata silenziosamente se pag1 fallisce (`pag1.length === 0`). Un fallimento transient fa perdere anche la pagina 2. | Basso — raro in pratica |
| 2 | [backend/scrapers/subito-playwright.js:157](backend/scrapers/subito-playwright.js:157) | `__NEXT_DATA__` mancante → solo `console.warn`, nessun retry. | Basso |
| 3 | Discrepanza `list` (30) vs `rankedList` (33) nel JSON Subito | Potrebbero esserci 3 annunci in più recuperabili per pagina. **Da investigare** prima di passare ad AS/Moto.it? Decisione utente. | Medio — potenziale +6 annunci per ricerca |
| 4 | Annunci "accessori moto" in categoria 3 | I venditori taggano accessori con marca/modello del veicolo → bleed in categoria 3. Il sito non li separa server-side. Richiede euristica UI o filtro in `server.js`. | Medio — non sono "missing", sono "extra rumorosi" |

---

## 6. File chiave (tour rapido per context-reset)

| Cosa | Dove |
|------|------|
| Endpoint ricerca + post-filter | [backend/server.js](backend/server.js) — `/api/search` e filtro lines 132-171 |
| Scraper Subito (baseline) | [backend/scrapers/subito-playwright.js](backend/scrapers/subito-playwright.js) |
| Scraper Autoscout24 (da rivedere) | [backend/scrapers/autoscout.js](backend/scrapers/autoscout.js) |
| Scraper Moto.it (da rivedere) | [backend/scrapers/motoit.js](backend/scrapers/motoit.js) |
| Header anti-bot condivisi | [backend/scrapers/utils.js](backend/scrapers/utils.js) |
| DB marche/modelli | [data/models.json](data/models.json) |
| Script test di confronto | `C:\temp\compare_subito.js` |

---

## 7. Checklist per la sessione successiva (AS + Moto.it)

- [ ] Leggere questo documento
- [ ] Far partire il tool in locale, lanciare una ricerca che coinvolge AS (auto) o Moto.it (moto), osservare console
- [ ] Verificare il sort priceasc nelle URL costruite dai due scraper
- [ ] Replicare `compare_subito.js` per Autoscout24 (5 test auto)
- [ ] Replicare per Moto.it (5 test moto)
- [ ] Confrontare top 5 priceasc posizione-per-posizione
- [ ] Applicare le correzioni ad autoscout.js / motoit.js
- [ ] Rieseguire i 5 test Subito per verificare zero regressioni
- [ ] (Opzionale) Affrontare la questione `rankedList` su Subito
