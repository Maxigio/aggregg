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


def test_accesslog_screen() -> None:
    """Apre il log accessi (tasto l), carica righe sentinel, prova il filtro 'demo'."""
    import json

    import psycopg

    from amradmin.db import Db, read_database_url
    try:
        Db().conn()
    except Exception as e:
        print(f"⤼ SKIP access log screen: DB non raggiungibile ({e})")
        return

    TOKEN = "amrtestlogUA"   # marcatore per il cleanup (LIKE), robusto al LIMIT 200
    conn = psycopg.connect(read_database_url(), autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO access_log (event,role,ip,user_agent,query,result_count) "
                        "VALUES (%s,%s,%s,%s,%s::jsonb,%s)",
                        ("search", "demo", "1.2.3.4", f"probe {TOKEN}",
                         json.dumps({"tipo": "moto", "marca": "Suzuki", "modello": "V-Strom 1050"}), 7))
            cur.execute("INSERT INTO access_log (event,role,ip,user_agent) VALUES (%s,%s,%s,%s)",
                        ("login_ok", "full", "127.0.0.1", f"probe {TOKEN}"))
            # MALEVOLO: markup Rich in query/user-agent/ip → senza escape rompe il render
            cur.execute("INSERT INTO access_log (event,role,ip,user_agent,query) "
                        "VALUES (%s,%s,%s,%s,%s::jsonb)",
                        ("search", "demo", "[/]", f"ev[/]il {TOKEN}",
                         json.dumps({"tipo": "moto", "marca": "Suzuki[/]", "modello": "X[bold]"})))

        from amradmin.app import AmrAdminApp
        from amradmin.screens import AccessLogScreen

        async def run() -> None:
            app = AmrAdminApp()
            async with app.run_test(size=(140, 40)) as pilot:
                await pilot.pause()
                await app.workers.wait_for_complete()
                await pilot.press("l")
                await pilot.pause()
                await app.workers.wait_for_complete()
                await pilot.pause()
                scr = app.screen
                assert isinstance(scr, AccessLogScreen), f"schermata inattesa: {type(scr).__name__}"
                # REGRESSION markup-injection: il render NON deve sollevare MarkupError
                assert isinstance(app.export_screenshot(), str), "render fallito (markup?)"
                # filtro demo: tra le righe mostrate col nostro token, nessuna 'full'
                from textual.widgets import Input
                scr.query_one("#afilter", Input).value = "demo"
                scr.reload()
                await app.workers.wait_for_complete()
                await pilot.pause()
                app.export_screenshot()   # ancora nessun crash col malevolo presente
                mine = [r for r in scr.rows if TOKEN in (r.get("user_agent") or "")]
                assert mine and all(r["role"] == "demo" for r in mine), "filtro demo non applicato"

        asyncio.run(run())
        # i sentinel ci sono nel DB (a prescindere dalla finestra LIMIT 200 della UI)
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM access_log WHERE user_agent LIKE %s", (f"%{TOKEN}%",))
            assert cur.fetchone()[0] == 3
        print("✔ access log screen (push/load/filtro + regression markup) OK")
    finally:
        conn.execute("DELETE FROM access_log WHERE user_agent LIKE %s", (f"%{TOKEN}%",))
        conn.close()


def test_coverage_screen() -> None:
    """Apre la copertura (tasto c) su una riga market_size sentinel (tetto 10,
    0 ingeriti → 0%) e verifica caricamento + calcolo."""
    import psycopg

    from amradmin.db import Db, read_database_url
    try:
        Db().conn()
    except Exception as e:
        print(f"⤼ SKIP coverage screen: DB non raggiungibile ({e})")
        return

    SENT = "__covtest__"
    conn = psycopg.connect(read_database_url(), autocommit=True)
    try:
        conn.execute("INSERT INTO market_size (tipo,marca,modello,fonte,total) VALUES (%s,%s,%s,%s,%s)",
                     ("auto", SENT, "x", "autoscout", 10))

        from amradmin.app import AmrAdminApp
        from amradmin.screens import CoverageScreen

        async def run() -> None:
            app = AmrAdminApp()
            async with app.run_test(size=(140, 40)) as pilot:
                await pilot.pause()
                await app.workers.wait_for_complete()
                await pilot.press("c")
                await pilot.pause()
                await app.workers.wait_for_complete()
                await pilot.pause()
                scr = app.screen
                assert isinstance(scr, CoverageScreen), f"schermata inattesa: {type(scr).__name__}"
                mine = [r for r in scr.rows if r["marca"] == SENT]
                assert mine, "riga sentinel non caricata"
                r = mine[0]
                assert r["tetto"] == 10 and r["ingeriti"] == 0 and float(r["coverage_pct"]) == 0.0 \
                    and r["manca"] == 10, f"calcolo copertura errato: {r}"
                assert isinstance(app.export_screenshot(), str)

        asyncio.run(run())
        print("✔ coverage screen (push/load/calcolo) OK")
    finally:
        conn.execute("DELETE FROM market_size WHERE marca=%s", (SENT,))
        conn.close()


if __name__ == "__main__":
    test_render_handles_nulls()
    test_headless_mount()
    test_watchlist_screen()
    test_accesslog_screen()
    test_coverage_screen()
    print("\nTEST OK")
