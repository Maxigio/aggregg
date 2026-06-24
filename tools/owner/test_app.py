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
    con.print(R.counts_panel({"total": 10, "crawlati": 3, "mai": 7}))
    con.print(R.last_run_line(None))                       # mai avviato
    con.print(R.last_run_line({"written": 5, "targets": 2, "errors": 0, "finished_at": None}))
    con.print(R.nodes_panel(
        [{"node": "imac", "total": 2, "coda": 1, "mai": 0, "due": 1, "fresco": 0,
          "spenti": 0, "last_swept": None}],
        {"nodi": [{"node": "imac", "fonte": "subito", "blocked": False, "degraded": True}]},
    ))
    con.print(R.fonti_panel([{"fonte": "subito", "total": 9, "active": 8, "gone": 1}]))
    # il caso critico: campi None (priority/tetto/manca/coverage_pct) NON sollevano
    con.print(R.suggester_panel([
        {"tipo": "auto", "marca": "Fiat", "modello": "Panda", "mai": True,
         "priority": None, "tetto": None, "manca": None, "coverage_pct": None},
        {"tipo": "moto", "marca": "BMW", "modello": "R 1200", "mai": False,
         "priority": 4762, "tetto": 6821, "manca": 6348, "coverage_pct": 7},
    ]))
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
            for needed in ("Watchlist", "Nodi", "crawlare"):   # ex-Ramp → suggeritore "Da crawlare"
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
    """Apre la copertura (tasto c). Copre: calcolo base (tetto 10/0 ingeriti → 0%),
    CLAMP a 100 quando ingeriti>tetto, filtro status='active' (un `gone` NON conta),
    markup-injection nella marca (R.safe non crasha), e il filtro fonte."""
    import psycopg

    from amradmin.db import Db, read_database_url
    try:
        Db().conn()
    except Exception as e:
        print(f"⤼ SKIP coverage screen: DB non raggiungibile ({e})")
        return

    SENT = "__covtest__"               # autoscout, 0 ingeriti → 0%, manca=10
    CLAMP = "__cov[red]hack[/]__"      # subito, ingeriti>tetto + markup → clamp 100, render-safe
    conn = psycopg.connect(read_database_url(), autocommit=True)
    try:
        conn.execute("INSERT INTO market_size (tipo,marca,modello,fonte,total) VALUES (%s,%s,%s,%s,%s)",
                     ("auto", SENT, "x", "autoscout", 10))
        conn.execute("INSERT INTO market_size (tipo,marca,modello,fonte,total) VALUES (%s,%s,%s,%s,%s)",
                     ("auto", CLAMP, "x", "subito", 4))
        for k in range(6):            # 6 ingeriti ATTIVI > tetto 4 → clamp 100
            conn.execute("INSERT INTO listings (url,fonte,tipo,marca,modello,status) "
                         "VALUES (%s,%s,%s,%s,%s,'active')",
                         (f"__covurl__{k}", "subito", "auto", CLAMP, "x"))
        # rumore: un 'gone' NON deve contare (verifica il filtro status='active')
        conn.execute("INSERT INTO listings (url,fonte,tipo,marca,modello,status) "
                     "VALUES (%s,%s,%s,%s,%s,'gone')",
                     ("__covurl__gone", "subito", "auto", CLAMP, "x"))

        from amradmin.app import AmrAdminApp
        from amradmin.screens import CoverageScreen
        from textual.widgets import Input

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
                # REGRESSION markup-injection: marca con tag Rich → il render NON crasha
                assert isinstance(app.export_screenshot(), str), "render fallito (markup marca?)"
                by = {r["marca"]: r for r in scr.rows}
                a = by.get(SENT)
                assert a and a["tetto"] == 10 and a["ingeriti"] == 0 \
                    and float(a["coverage_pct"]) == 0.0 and a["manca"] == 10, f"base 0% errato: {a}"
                c = by.get(CLAMP)
                # 6 ATTIVI (il 'gone' NON conta) su tetto 4 → coverage CLAMP 100, manca 0
                assert c and c["ingeriti"] == 6 and float(c["coverage_pct"]) == 100.0 \
                    and c["manca"] == 0, f"clamp/status-active errato: {c}"
                # filtro fonte 'subito' → resta CLAMP (subito), sparisce SENT (autoscout)
                scr.query_one("#cfilter", Input).value = "subito"
                scr.reload()
                await app.workers.wait_for_complete()
                await pilot.pause()
                marcas = {r["marca"] for r in scr.rows}
                assert CLAMP in marcas and SENT not in marcas, "filtro fonte non applicato"

        asyncio.run(run())
        print("✔ coverage screen (0% + clamp + status-active + markup + filtro) OK")
    finally:
        conn.execute("DELETE FROM listings WHERE url LIKE %s", ("__covurl__%",))
        conn.execute("DELETE FROM market_size WHERE marca IN (%s,%s)", (SENT, CLAMP))
        conn.close()


def test_crawl_queue_screen() -> None:
    """Apre la coda (tasto k) con job sentinel (incl. markup nel modello → R.safe)."""
    import psycopg

    from amradmin.db import Db, read_database_url
    try:
        Db().conn()
    except Exception as e:
        print(f"⤼ SKIP crawl queue screen: DB non raggiungibile ({e})")
        return

    SENT = "__qtest__"
    conn = psycopg.connect(read_database_url(), autocommit=True)
    try:
        conn.execute("INSERT INTO crawl_queue (tipo,marca,modello,status,written) "
                     "VALUES ('auto',%s,'x','done',5)", (SENT,))
        # MALEVOLO: markup Rich nel modello → senza R.safe romperebbe il render
        conn.execute("INSERT INTO crawl_queue (tipo,marca,modello,status) "
                     "VALUES ('auto',%s,'[bold]y[/]','pending')", (SENT,))

        from amradmin.app import AmrAdminApp
        from amradmin.screens import CrawlQueueScreen

        async def run() -> None:
            app = AmrAdminApp()
            async with app.run_test(size=(140, 40)) as pilot:
                await pilot.pause()
                await app.workers.wait_for_complete()
                await pilot.press("k")
                await pilot.pause()
                await app.workers.wait_for_complete()
                await pilot.pause()
                scr = app.screen
                assert isinstance(scr, CrawlQueueScreen), f"schermata inattesa: {type(scr).__name__}"
                # REGRESSION markup: il render NON deve sollevare MarkupError
                assert isinstance(app.export_screenshot(), str), "render fallito (markup modello?)"
                mine = [r for r in scr.rows if r["marca"] == SENT]
                assert len(mine) == 2, f"job sentinel non caricati: {mine}"

        asyncio.run(run())
        print("✔ crawl queue screen (push/load/markup) OK")
    finally:
        conn.execute("DELETE FROM crawl_queue WHERE marca=%s", (SENT,))
        conn.close()


def test_suggester_screen() -> None:
    """Apre il suggeritore (tasto s), carica righe live, applica un filtro."""
    from amradmin.db import Db
    try:
        Db().conn()
    except Exception as e:
        print(f"⤼ SKIP suggester screen: DB non raggiungibile ({e})")
        return

    from textual.widgets import Input

    from amradmin.app import AmrAdminApp
    from amradmin.screens import SuggesterScreen

    async def run() -> None:
        app = AmrAdminApp()
        async with app.run_test(size=(150, 40)) as pilot:
            await pilot.pause()
            await app.workers.wait_for_complete()
            await pilot.press("s")
            await pilot.pause()
            await app.workers.wait_for_complete()
            await pilot.pause()
            scr = app.screen
            assert isinstance(scr, SuggesterScreen), f"schermata inattesa: {type(scr).__name__}"
            assert len(scr.rows) > 0, "suggeritore senza righe (catalogo 14k attivo → atteso >0)"
            assert isinstance(app.export_screenshot(), str)
            scr.query_one("#sfilter", Input).value = "audi"
            scr.reload()
            await app.workers.wait_for_complete()
            await pilot.pause()
            assert scr.rows and all("audi" in r["marca"].lower() or "audi" in r["modello"].lower()
                                    for r in scr.rows), "filtro audi non applicato"

    asyncio.run(run())
    print("✔ suggester screen (push/load/filtro) OK")


def test_health_screen() -> None:
    """Apre la Salute crawler (tasto h) con una riga sentinel BLOCCATA (+ markup nella
    fonte → R.safe). Verifica push/load/colore-stato + render markup-safe."""
    import psycopg

    from amradmin.db import Db, read_database_url
    try:
        Db().conn()
    except Exception as e:
        print(f"⤼ SKIP health screen: DB non raggiungibile ({e})")
        return

    NODE = "__htest__"
    conn = psycopg.connect(read_database_url(), autocommit=True)
    try:
        # sentinel: bloccata + markup malevolo nella fonte → senza R.safe romperebbe il render
        conn.execute("INSERT INTO crawl_health (node, fonte, blocked, last_blocked_at, blocked_count) "
                     "VALUES (%s,'subito[bold]',true, now(), 3) "
                     "ON CONFLICT (node,fonte) DO UPDATE SET blocked=true, blocked_count=3", (NODE,))

        from amradmin.app import AmrAdminApp
        from amradmin.screens import HealthScreen

        async def run() -> None:
            app = AmrAdminApp()
            async with app.run_test(size=(150, 40)) as pilot:
                await pilot.pause()
                await app.workers.wait_for_complete()
                await pilot.press("h")
                await pilot.pause()
                await app.workers.wait_for_complete()
                await pilot.pause()
                scr = app.screen
                assert isinstance(scr, HealthScreen), f"schermata inattesa: {type(scr).__name__}"
                assert isinstance(app.export_screenshot(), str), "render KO (markup fonte?)"
                mine = [r for r in scr.rows if r["node"] == NODE]
                assert mine and mine[0]["blocked"] is True, f"riga sentinel bloccata non caricata: {mine}"
                assert len(scr.rows) >= 1, "almeno la sentinel (no accoppiamento allo stato prod)"

        asyncio.run(run())
        print("✔ health screen (push/load/blocked + markup) OK")
    finally:
        conn.execute("DELETE FROM crawl_health WHERE node=%s", (NODE,))
        conn.close()


def test_command_screen() -> None:
    """Apre la schermata Comandi (M-D, tasto :): push + parse-error + storia ↑.
    Niente DB-write/spawn (usa un comando ERRATO) → side-effect free anche su prod."""
    from amradmin.db import Db
    try:
        Db().conn()
    except Exception as e:
        print(f"⤼ SKIP command screen: DB non raggiungibile ({e})")
        return

    from textual.widgets import Input

    from amradmin.app import AmrAdminApp
    from amradmin.screens import CommandScreen

    async def run() -> None:
        app = AmrAdminApp()
        async with app.run_test(size=(140, 40)) as pilot:
            await pilot.pause()
            await app.workers.wait_for_complete()
            await pilot.press("colon")                     # ':' apre la schermata Comandi
            await pilot.pause()
            scr = app.screen
            assert isinstance(scr, CommandScreen), f"schermata inattesa: {type(scr).__name__}"
            assert isinstance(app.export_screenshot(), str), "render KO (cheatsheet markup?)"
            # comando ERRATO → riga d'errore nel log, nessuna scrittura/spawn
            inp = scr.query_one("#cmdin", Input)
            inp.value = ":comandoinesistente"
            await pilot.press("enter")
            await pilot.pause()
            assert scr._history == [":comandoinesistente"], f"storia non registrata: {scr._history}"
            # ↑ richiama l'ultimo comando digitato
            inp.value = ""
            scr.action_hist_prev()
            assert inp.value == ":comandoinesistente", f"storia ↑ non richiamata: {inp.value!r}"
            assert isinstance(app.export_screenshot(), str), "render KO dopo submit"

    asyncio.run(run())
    print("✔ command screen (push/parse-error/storia) OK")


if __name__ == "__main__":
    test_render_handles_nulls()
    test_headless_mount()
    test_watchlist_screen()
    test_accesslog_screen()
    test_coverage_screen()
    test_crawl_queue_screen()
    test_suggester_screen()
    test_health_screen()
    test_command_screen()
    print("\nTEST OK")
