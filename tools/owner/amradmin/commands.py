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
    s = (text or "").strip()
    if s.startswith(":"):
        s = s[1:].strip()
    if not s:
        return {"cmd": "noop"}
    parts = s.split()
    verb = parts[0].lower()
    args = parts[1:]

    if verb in ("run", "r"):
        if not args:
            return {"cmd": "error", "msg": "uso: :run <auto|moto> <marca> <modello>  ·  :run due"}
        if args[0].lower() == "due":
            return {"cmd": "run_due"}
        if args[0].lower() not in TIPI:
            return {"cmd": "error",
                    "msg": f"manca il tipo ({'/'.join(TIPI)}) — es. :run auto bmw serie 3"}
        if len(args) < 3:
            return {"cmd": "error", "msg": "uso: :run <auto|moto> <marca> <modello>"}
        return {"cmd": "run", "tipo": args[0].lower(), "marca": args[1], "modello": " ".join(args[2:])}

    if verb in ("clear", "stop"):
        return {"cmd": "clear"}

    if verb == "cancel":
        if len(args) != 1 or not args[0].isdigit():
            return {"cmd": "error", "msg": "uso: :cancel <id>"}
        return {"cmd": "cancel", "id": int(args[0])}

    return {"cmd": "error", "msg": f"comando sconosciuto: {verb} (run/due/clear/cancel)"}
