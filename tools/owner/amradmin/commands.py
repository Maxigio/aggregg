"""Parser della barra comandi `:` (PURO → testabile senza UI/DB).

Grammatica v1:
  :run <auto|moto> <marca> <modello…>   → accoda un target (anche ad-hoc)
  :run due                              → accoda tutti i 'due' (mirror dueTargets)
  :clear  (alias :stop)                 → svuota i pending della coda
  :cancel <id>                          → annulla un job
Ritorna un dict {cmd, …}. cmd='error' con msg per input invalido; cmd='noop' per vuoto.
"""
from __future__ import annotations

from .constants import TIPI


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
        # Profondità OPZIONALE = ULTIMO token, solo se 'full' o 'pN' (prefisso 'p' per non
        # confonderla con un modello numerico tipo '320'/'500'). default = None (cap medio).
        rest = args[1:]                       # marca + modello (+ profondità)
        pages = None
        last = rest[-1].lower() if rest else ""
        if last == "full":
            pages = 9999                      # crawler clampa al safety cap (= full-depth)
            rest = rest[:-1]
        elif last.startswith("p") and last[1:].isdigit() and int(last[1:]) > 0:
            pages = int(last[1:])
            rest = rest[:-1]
        if len(rest) < 2:                     # serve marca + almeno una parola di modello
            return {"cmd": "error", "msg": "uso: :run <auto|moto> <marca> <modello> [full|pN]"}
        return {"cmd": "run", "tipo": args[0].lower(), "marca": rest[0],
                "modello": " ".join(rest[1:]), "pages": pages}

    if verb in ("clear", "stop"):
        return {"cmd": "clear"}

    if verb == "cancel":
        if len(args) != 1 or not args[0].isdigit():
            return {"cmd": "error", "msg": "uso: :cancel <id>"}
        return {"cmd": "cancel", "id": int(args[0])}

    return {"cmd": "error", "msg": f"comando sconosciuto: {verb} (run/due/clear/cancel)"}
