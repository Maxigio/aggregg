"""Parser della barra comandi `:` (PURO → testabile senza UI/DB).

Grammatica v1:
  :run <auto|moto> <marca> <modello…>   → accoda un target (anche ad-hoc)
  :run due                              → accoda tutti i 'due' (mirror dueTargets)
  :clear  (alias :stop)                 → svuota i pending della coda
  :cancel <id>                          → annulla un job
Ritorna un dict {cmd, …}. cmd='error' con msg per input invalido; cmd='noop' per vuoto.
"""
from __future__ import annotations

from .constants import FULL_SENTINEL, TIPI


def parse_command(text: str) -> dict:
    s = (text or "").strip().lstrip(":").strip()   # tollera ':' e '::' iniziali
    if not s:
        return {"cmd": "noop"}
    parts = s.split()
    verb = parts[0].lower()
    args = parts[1:]

    if verb in ("run", "r"):
        if not args:
            return {"cmd": "error", "msg": "uso: :run <auto|moto> <marca> <modello> [full|pN] · :run due"}
        if args[0].lower() == "due":
            return {"cmd": "run_due"}
        if args[0].lower() not in TIPI:
            return {"cmd": "error",
                    "msg": f"manca il tipo ({'/'.join(TIPI)}) — es. :run auto bmw serie 3"}
        # Profondità OPZIONALE = ULTIMO token. 'full' non è MAI un modello reale → sempre
        # profondità (il check finale len<2 segnala comunque il modello mancante). 'pN'
        # invece confligge con modelli REALI 'P50'/'P1800'/'P51' (data/models.json): lo
        # consumo solo se restano marca + ≥1 parola di modello (len(rest) > 2), così con
        # marca+modello soli ('peel p50') il token resta il MODELLO, non la profondità.
        rest = args[1:]                       # marca + modello (+ profondità)
        pages = None
        last = rest[-1].lower() if rest else ""
        if last == "full":
            pages = FULL_SENTINEL             # crawler clampa al safety cap (= full-depth)
            rest = rest[:-1]
        elif last.startswith("p") and last[1:].isdigit() and int(last[1:]) > 0 and len(rest) > 2:
            pages = int(last[1:])
            rest = rest[:-1]
        if len(rest) < 2:                     # serve marca + almeno una parola di modello
            return {"cmd": "error", "msg": "uso: :run <auto|moto> <marca> <modello> [full|pN]"}
        return {"cmd": "run", "tipo": args[0].lower(), "marca": rest[0],
                "modello": " ".join(rest[1:]), "pages": pages}

    if verb == "add":
        # :add <auto|moto> <marca> <modello…> → aggiunge un target al catalogo watchlist
        # (NON crawla; idempotente). Rimpiazza il vecchio pannello admin "+ aggiungi".
        if not args or args[0].lower() not in TIPI:
            return {"cmd": "error", "msg": f"uso: :add <{'/'.join(TIPI)}> <marca> <modello>"}
        if len(args) < 3:
            return {"cmd": "error", "msg": "uso: :add <auto|moto> <marca> <modello>"}
        return {"cmd": "add", "tipo": args[0].lower(), "marca": args[1], "modello": " ".join(args[2:])}

    if verb in ("clear", "stop"):
        return {"cmd": "clear"}

    if verb == "cancel":
        if len(args) != 1 or not args[0].isdigit():
            return {"cmd": "error", "msg": "uso: :cancel <id>"}
        return {"cmd": "cancel", "id": int(args[0])}

    return {"cmd": "error", "msg": f"comando sconosciuto: {verb} (run/due/clear/cancel)"}
