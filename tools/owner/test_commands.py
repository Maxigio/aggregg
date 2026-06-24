"""Test PURO del parser della barra comandi (commands.parse_command). No DB/UI.
    tools/owner/.venv/bin/python tools/owner/test_commands.py
"""
from __future__ import annotations

from amradmin.commands import parse_command as p


def test_parse() -> None:
    assert p("")["cmd"] == "noop"
    assert p(":")["cmd"] == "noop"
    # run ad-hoc, modello multi-parola
    assert p(":run auto bmw serie 3") == {"cmd": "run", "tipo": "auto", "marca": "bmw", "modello": "serie 3"}
    assert p("run moto ducati monster")["tipo"] == "moto"      # senza ':' iniziale
    # due
    assert p(":run due")["cmd"] == "run_due"
    # errori
    assert p(":run")["cmd"] == "error"            # senza args
    assert p(":run bmw 320")["cmd"] == "error"    # tipo mancante (bmw ∉ auto/moto)
    assert p(":run auto bmw")["cmd"] == "error"   # senza modello
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
