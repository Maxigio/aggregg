"""App Textual — owner-tool DB-puro. v1: dashboard live (read-only).

Avvio reale (in un terminale):  tools/owner/.venv/bin/python -m amradmin
"""
from __future__ import annotations

import asyncio

from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Footer, Header, Input, Static

from . import queries as Q
from . import render as R
from .db import Db
from .screens import AccessLogScreen, CoverageScreen, CrawlQueueScreen, SuggesterScreen, WatchlistScreen

REFRESH_SECONDS = 5


class AmrAdminApp(App):
    """Dashboard live del database Auto Moto Radar (sola lettura, v1)."""

    TITLE = "Auto Moto Radar — Owner"
    CSS = """
    #counts, #lastrun { height: auto; }
    #nodes { height: auto; }
    .col { width: 1fr; }
    #status { dock: bottom; height: 1; color: $text-muted; }
    #cmd { dock: bottom; display: none; }
    """
    BINDINGS = [
        ("w", "watchlist", "Watchlist"),
        ("c", "coverage", "Copertura"),
        ("s", "suggester", "Suggeriti"),
        ("k", "crawl_queue", "Coda"),
        ("l", "accesslog", "Accessi"),
        (":", "command", "Comando"),
        ("r", "refresh", "Aggiorna"),
        ("q", "quit", "Esci"),
    ]

    def __init__(self, db: Db | None = None):
        super().__init__()
        self.db = db or Db()
        self.last_error: str | None = None   # seam per test/headless
        self.last_status: str = ""

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with VerticalScroll():
            yield Static(id="counts")
            yield Static(id="lastrun")
            yield Static(id="nodes")
            with Horizontal():
                yield Static(id="fonti", classes="col")
                yield Static(id="ramp", classes="col")
        yield Input(id="cmd", placeholder=":run auto bmw serie 3   ·   :run due   ·   :clear   ·   :cancel <id>")
        yield Static(id="status")
        yield Footer()

    def on_mount(self) -> None:
        self.refresh_data()
        self.set_interval(REFRESH_SECONDS, self.refresh_data)

    def action_refresh(self) -> None:
        self.refresh_data()

    def action_watchlist(self) -> None:
        self.push_screen(WatchlistScreen())

    def action_accesslog(self) -> None:
        self.push_screen(AccessLogScreen())

    def action_coverage(self) -> None:
        self.push_screen(CoverageScreen())

    def action_crawl_queue(self) -> None:
        self.push_screen(CrawlQueueScreen())

    def action_suggester(self) -> None:
        self.push_screen(SuggesterScreen())

    def action_command(self) -> None:
        """Mostra/nasconde la barra comandi `:` (toggle)."""
        inp = self.query_one("#cmd", Input)
        if inp.display:
            inp.display = False
            return
        inp.display = True
        inp.value = ":"
        inp.focus()

    def on_input_submitted(self, e: Input.Submitted) -> None:
        if e.input.id != "cmd":
            return
        text = e.input.value
        e.input.value = ""
        e.input.display = False
        self.run_command(text)

    @work(exclusive=True, group="cmd")
    async def run_command(self, text: str) -> None:
        from . import commands as C
        parsed = C.parse_command(text)
        if parsed["cmd"] == "noop":
            return
        if parsed["cmd"] == "error":
            self.notify(R.safe(parsed["msg"]), title="comando", severity="warning")
            return
        try:
            msg = await asyncio.to_thread(self._dispatch, parsed)
            # R.safe: il toast Rich rende il markup DOPO (sul compositor, fuori da questo
            # try) → marca/modello con un tag (es. 'serie[/]') romperebbero il render.
            self.notify(R.safe(msg), title="coda crawl")
        except Exception as e:   # validazione (es. tipo) o DB → toast, non crashare
            self.notify(R.safe(str(e)), title="comando", severity="error")

    def _dispatch(self, parsed: dict) -> str:
        """Esegue il comando (gira in thread). Db PROPRIA → no contesa con refresh_data."""
        from . import actions as A
        from . import queries as Q2
        from .drainer import spawn_drainer
        cmd = parsed["cmd"]
        with Db() as db:
            def drainer() -> str:
                # spawn SEMPRE (idempotente via advisory lock) → chiude la race di uscita
                try:
                    spawn_drainer()
                    return "attivo"
                except Exception as e:
                    return f"spawn KO ({e})"
            if cmd == "run":
                pg = parsed.get("pages")
                rid = A.enqueue(db, parsed["tipo"], parsed["marca"], parsed["modello"], pages=pg)
                depth = R.depth_label(pg)
                if not rid:
                    # già attivo: se 'pending', enqueue ha AGGIORNATO la profondità (override
                    # esplicito) → dillo, non far credere che il depth sia stato ignorato.
                    extra = f" — profondità → {depth}" if pg is not None else ""
                    return f"già in coda: {parsed['marca']} {parsed['modello']}{extra}"
                return f"in coda: {parsed['tipo']} {parsed['marca']} {parsed['modello']} ({depth}) · drainer {drainer()}"
            if cmd == "run_due":
                res = A.enqueue_rows(db, Q2.due_targets(db))
                if not res["queued"]:
                    return f"niente di 'due' ora (dup {res['skipped']})"
                return f"due in coda: {res['queued']} (dup {res['skipped']}) · drainer {drainer()}"
            if cmd == "clear":
                return f"coda svuotata: {A.clear_pending(db)} pending annullati"
            if cmd == "cancel":
                st = A.cancel(db, parsed["id"])
                return f"job {parsed['id']}: {st or 'non trovato/non attivo'}"
        return "comando ignoto"

    @work(exclusive=True)
    async def refresh_data(self) -> None:
        # Le query psycopg sono BLOCCANTI: girarle nell'event loop freezerebbe la UI
        # (verificato). Le offloado a un thread con asyncio.to_thread; exclusive=True
        # serializza i refresh (niente uso concorrente della connessione).
        try:
            panels = await asyncio.to_thread(self._collect)
        except Exception as e:  # DB giù / query KO → mostra l'errore, non crashare
            self.last_error = str(e)
            self.query_one("#status", Static).update(f"[red]errore DB:[/] {e}")
            return
        # update widget sul loop (i renderable sono già pronti dal thread)
        self.last_error = None
        for wid, key in (("#counts", "counts"), ("#lastrun", "lastrun"), ("#nodes", "nodes"),
                         ("#fonti", "fonti"), ("#ramp", "ramp")):
            self.query_one(wid, Static).update(panels[key])
        self.last_status = f"DB ok · refresh {REFRESH_SECONDS}s · [r] aggiorna  [q] esci"
        self.query_one("#status", Static).update(self.last_status)

    def _collect(self) -> dict:
        """Esegue tutte le query e costruisce i renderable (gira in un thread)."""
        db = self.db
        return {
            "counts": R.counts_panel(Q.counts(db)),
            "lastrun": R.last_run_line(Q.last_run(db, "imac")),
            "nodes": R.nodes_panel(Q.node_stats(db), Q.health(db)),
            "fonti": R.fonti_panel(Q.listings_by_fonte(db)),
            "ramp": R.suggester_panel(Q.suggestions(db, limit=8)),   # preview: solo 8 (no query pesante ogni 5s)
        }


def main() -> None:
    AmrAdminApp().run()


if __name__ == "__main__":
    main()
