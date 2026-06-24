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
