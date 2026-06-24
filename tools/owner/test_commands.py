"""Test PURO del parser della barra comandi (commands.parse_command). No DB/UI.
    tools/owner/.venv/bin/python tools/owner/test_commands.py
"""
from __future__ import annotations

from amradmin.commands import parse_command as p


def test_parse() -> None:
    assert p("")["cmd"] == "noop"
    assert p(":")["cmd"] == "noop"
    assert p("::")["cmd"] == "noop"
    assert p("::run auto fiat panda")["cmd"] == "run"   # '::' iniziale tollerato
    # run ad-hoc, modello multi-parola
    assert p(":run auto bmw serie 3") == {"cmd": "run", "tipo": "auto", "marca": "bmw", "modello": "serie 3", "pages": None}
    assert p("run moto ducati monster")["tipo"] == "moto"      # senza ':' iniziale
    # profondità per-run (ultimo token: 'full' o 'pN')
    assert p(":run auto audi a3 full") == {"cmd": "run", "tipo": "auto", "marca": "audi", "modello": "a3", "pages": 9999}
    assert p(":run auto audi a3 p50") == {"cmd": "run", "tipo": "auto", "marca": "audi", "modello": "a3", "pages": 50}
    assert p(":run auto bmw serie 3 full")["modello"] == "serie 3" and p(":run auto bmw serie 3 full")["pages"] == 9999
    assert p(":run auto bmw serie 3 p20")["modello"] == "serie 3" and p(":run auto bmw serie 3 p20")["pages"] == 20
    # numero SENZA 'p' = parte del modello, NON profondità (disambiguazione)
    assert p(":run auto bmw 320")["modello"] == "320" and p(":run auto bmw 320")["pages"] is None
    assert p(":run auto fiat 500")["modello"] == "500" and p(":run auto fiat 500")["pages"] is None
    assert p(":run auto audi a3")["pages"] is None             # default
    # 'pN' confligge con modelli REALI 'P50'/'P1800' (data/models.json): se restano solo
    # marca+modello (len 2) il token È il modello, NON la profondità (Peel P50 crawlabile)
    assert p(":run auto peel p50") == {"cmd": "run", "tipo": "auto", "marca": "peel", "modello": "p50", "pages": None}
    assert p(":run auto volvo p1800")["modello"] == "p1800" and p(":run auto volvo p1800")["pages"] is None
    # ...ma con marca + ≥1 parola di modello + token, 'pN' torna profondità
    assert p(":run auto fiat 500 p10")["modello"] == "500" and p(":run auto fiat 500 p10")["pages"] == 10
    # 'full' è SEMPRE profondità (nessun modello reale 'full'); da solo → manca il modello
    assert p(":run auto audi a3 full")["pages"] == 9999
    assert p(":run auto bmw full")["cmd"] == "error"           # 'full' consumato → modello mancante
    # due
    assert p(":run due")["cmd"] == "run_due"
    # errori
    assert p(":run")["cmd"] == "error"            # senza args
    assert p(":run bmw 320")["cmd"] == "error"    # tipo mancante (bmw ∉ auto/moto)
    assert p(":run auto bmw")["cmd"] == "error"   # senza modello
    # add (→ watchlist, no crawl)
    assert p(":add auto bmw serie 3") == {"cmd": "add", "tipo": "auto", "marca": "bmw", "modello": "serie 3"}
    assert p(":add moto ducati monster")["cmd"] == "add"
    assert p(":add auto bmw")["cmd"] == "error"        # senza modello
    assert p(":add bmw 320")["cmd"] == "error"         # tipo mancante
    assert p(":add")["cmd"] == "error"                 # nudo
    assert p(":add auto")["cmd"] == "error"            # solo tipo
    # clear / cancel
    assert p(":clear")["cmd"] == "clear"
    assert p(":stop")["cmd"] == "clear"
    assert p(":cancel 7") == {"cmd": "cancel", "id": 7}
    assert p(":cancel")["cmd"] == "error"
    assert p(":cancel x")["cmd"] == "error"
    assert p(":boh")["cmd"] == "error"
    print("✔ command parse OK")


if __name__ == "__main__":
    test_parse()
    print("\nTEST OK")
