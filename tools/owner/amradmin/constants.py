"""Costanti RISPECCHIATE da sorgenti JS — tenere allineate (drift = bug).

Il tool DB-puro non può importare il JS, quindi questi valori sono duplicati:
ogni costante cita la sua fonte autorevole nel backend.
"""

# Nodi validi per assigned_node (NULL = 'imac'). Fonte: backend/server.js:357
KNOWN_NODES = ["imac", "surface", "m2", "massimo"]

# Finestra di staleness: un target attivato è "due" se last_swept è più vecchio
# di STALE_HOURS. Fonte: backend/db/watchlist-repo.js (nodeStats/dueTargets,
# "interval '20 hours'") e backend/crawler.js.
STALE_HOURS = 20

# Tipi veicolo ammessi. Fonte: backend/server.js (validazione tipo auto|moto).
TIPI = ["auto", "moto"]

# Profondità "full" del crawl. FULL_PAGES = tetto di sicurezza (anti-runaway):
# Fonte autorevole backend/crawler.js FULL_PAGES_MAX (env CRAWLER_PAGES_FULL,
# default 200) — qui duplicato perché il tool DB-puro non legge l'env del Node;
# se cambi CRAWLER_PAGES_FULL aggiorna anche questo. FULL_SENTINEL = valore che la
# barra `:run … full` scrive in crawl_queue.pages; il crawler lo clampa a FULL_PAGES.
FULL_PAGES = 200
FULL_SENTINEL = 9999
