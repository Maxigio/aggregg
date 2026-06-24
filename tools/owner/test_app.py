"""Test del tool owner — eseguibili senza framework:
    tools/owner/.venv/bin/python tools/owner/test_app.py

1) render-test DB-INDIPENDENTE: i pannelli si costruiscono anche con valori
   nulli (priority None, last_swept None) — copre il path UI senza DB.
2) headless DB-GATED: monta l'app Textual con run_test; se il DB non è
   raggiungibile fa SKIP (non fallisce).
"""
from __future__ import annotations

import asyncio

from rich.console import Console

from amradmin import render as R


def test_render_handles_nulls() -> None:
    """I renderable reggono None (priority nullable, last_swept mai) — fix review #1."""
    con = Console(record=True, width=100, file=open("/dev/null", "w"))
    con.print(R.counts_panel({"total": 10, "active": 3, "pending": 7}))
    con.print(R.last_run_line(None))                       # mai avviato
    con.print(R.last_run_line({"written": 5, "targets": 2, "errors": 0, "finished_at": None}))
    con.print(R.nodes_panel(
        [{"node": "imac", "total": 2, "coda": 1, "mai": 0, "due": 1, "fresco": 0,
          "spenti": 0, "last_swept": None}],
        {"nodi": [{"node": "imac", "fonte": "subito", "blocked": False, "degraded": True}]},
    ))
    con.print(R.fonti_panel([{"fonte": "subito", "total": 9, "active": 8, "gone": 1}]))
    # il caso critico: priority None NON deve sollevare TypeError
    con.print(R.ramp_panel({"total": 10, "active": 3, "queue": 7, "next": [
        {"tipo": "auto", "marca": "Fiat", "modello": "Panda", "priority": None},
        {"tipo": "moto", "marca": "BMW", "modello": "R 1200", "priority": 4762},
    ]}))
    print("✔ render-test (None-safe) OK")


def test_headless_mount() -> None:
    """Monta l'app headless. DB-gated: SKIP se Postgres non raggiungibile."""
    from amradmin.db import Db
    try:
        Db().conn()
    except Exception as e:
        print(f"⤼ SKIP headless: DB non raggiungibile ({e})")
        return

    from amradmin.app import AmrAdminApp

    async def run() -> None:
        app = AmrAdminApp()
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()
            await app.workers.wait_for_complete()   # attende il worker di refresh
            await pilot.pause()
            assert app.last_error is None, f"errore al mount: {app.last_error}"
            svg = app.export_screenshot()
            for needed in ("Watchlist", "Nodi", "Ramp"):
                assert needed in svg, f"pannello mancante: {needed}"

    asyncio.run(run())
    print("✔ headless mount/refresh/render OK")


def test_watchlist_screen() -> None:
    """Apre la schermata watchlist (tasto w), carica le righe, applica un filtro."""
    from amradmin.db import Db
    try:
        Db().conn()
    except Exception as e:
        print(f"⤼ SKIP watchlist screen: DB non raggiungibile ({e})")
        return

    from textual.widgets import Input

    from amradmin.app import AmrAdminApp
    from amradmin.screens import WatchlistScreen

    async def run() -> None:
        app = AmrAdminApp()
        async with app.run_test(size=(140, 40)) as pilot:
            await pilot.pause()
            await app.workers.wait_for_complete()
            await pilot.press("w")                       # apre WatchlistScreen
            await pilot.pause()
            await app.workers.wait_for_complete()
            await pilot.pause()
            scr = app.screen
            assert isinstance(scr, WatchlistScreen), f"schermata inattesa: {type(scr).__name__}"
            assert len(scr.rows) > 0, "watchlist screen senza righe"
            # filtro server-side
            scr.query_one("#filter", Input).value = "Fiat"
            scr.reload()
            await app.workers.wait_for_complete()
            await pilot.pause()
            assert scr.rows, "filtro Fiat: nessuna riga"
            assert all("fiat" in r["marca"].lower() or "fiat" in r["modello"].lower() for r in scr.rows), \
                "filtro non applicato"

    asyncio.run(run())
    print("✔ watchlist screen (push/load/filtro) OK")


if __name__ == "__main__":
    test_render_handles_nulls()
    test_headless_mount()
    test_watchlist_screen()
    print("\nTEST OK")
