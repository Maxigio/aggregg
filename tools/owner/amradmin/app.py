"""App Textual — owner-tool DB-puro. v1: dashboard live (read-only).

Avvio reale (in un terminale):  tools/owner/.venv/bin/python -m amradmin
"""
from __future__ import annotations

import asyncio

from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Footer, Header, Static

from . import queries as Q
from . import render as R
from .db import Db
from .screens import (
    AccessLogScreen, CommandScreen, CoverageScreen, CrawlQueueScreen, HealthScreen,
    SuggesterScreen, WatchlistScreen,
)

REFRESH_SECONDS = 5


class AmrAdminApp(App):
    """Dashboard live del database Auto Moto Radar (sola lettura, v1)."""

    TITLE = "Auto Moto Radar — Owner"
    CSS = """
    #menu { dock: top; height: 1; }
    #ops { height: 1; }
    #counts, #lastrun { height: auto; }
    #nodes { height: auto; }
    .col { width: 1fr; }
    #status { dock: bottom; height: 1; color: $text-muted; }
    """
    BINDINGS = [
        ("w", "watchlist", "Watchlist"),
        ("c", "coverage", "Copertura"),
        ("s", "suggester", "Suggeriti"),
        ("k", "crawl_queue", "Coda"),
        ("h", "health", "Salute"),
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
        yield Static(R.menu_bar("home"), id="menu")
        with VerticalScroll():
            yield Static(id="ops")            # M-H: riga ops live (drainer/coda/bloccate)
            yield Static(id="counts")
            yield Static(id="lastrun")
            yield Static(id="nodes")
            with Horizontal():
                yield Static(id="fonti", classes="col")
                yield Static(id="suggester", classes="col")   # ex-#ramp (nome morto)
        yield Static(id="status")
        yield Footer()

    def on_mount(self) -> None:
        self.refresh_data()
        self.set_interval(REFRESH_SECONDS, self.refresh_data)

    def action_refresh(self) -> None:
        self.refresh_data()

    def _go(self, screen_type) -> None:
        """Nav laterale (M-H): già su quel tipo → no-op; su una sotto-schermata →
        switch (stack resta ≤1, esc torna sempre alla dashboard); sulla dashboard → push.
        Così i tasti gruppo (w/c/s/k/h/l/:) navigano da OVUNQUE senza impilare."""
        if isinstance(self.screen, screen_type):
            return
        if len(self.screen_stack) > 1:
            self.switch_screen(screen_type())
        else:
            self.push_screen(screen_type())

    def action_watchlist(self) -> None:
        self._go(WatchlistScreen)

    def action_accesslog(self) -> None:
        self._go(AccessLogScreen)

    def action_coverage(self) -> None:
        self._go(CoverageScreen)

    def action_crawl_queue(self) -> None:
        self._go(CrawlQueueScreen)

    def action_health(self) -> None:
        self._go(HealthScreen)

    def action_suggester(self) -> None:
        self._go(SuggesterScreen)

    def action_command(self) -> None:
        """Apre la schermata Comandi dedicata (M-D): input + storia + output + cheatsheet."""
        self._go(CommandScreen)

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
        for wid, key in (("#ops", "ops"), ("#counts", "counts"), ("#lastrun", "lastrun"),
                         ("#nodes", "nodes"), ("#fonti", "fonti"), ("#suggester", "suggester")):
            self.query_one(wid, Static).update(panels[key])
        self.last_status = f"DB ok · refresh {REFRESH_SECONDS}s  ·  tasti in fondo ↓"
        self.query_one("#status", Static).update(self.last_status)

    def _collect(self) -> dict:
        """Esegue tutte le query e costruisce i renderable (gira in un thread)."""
        db = self.db
        health = Q.health(db)   # una sola volta: serve sia alla riga ops sia ai nodi
        return {
            "ops": R.ops_line(Q.drainer_alive(db), Q.queue_counts(db), health),
            "counts": R.counts_panel(Q.counts(db)),
            "lastrun": R.last_run_line(Q.last_run(db, "imac")),
            "nodes": R.nodes_panel(Q.node_stats(db), health),
            "fonti": R.fonti_panel(Q.listings_by_fonte(db)),
            "suggester": R.suggester_panel(Q.suggestions(db, limit=8)),   # preview: solo 8 (no query pesante ogni 5s)
        }


def main() -> None:
    AmrAdminApp().run()


if __name__ == "__main__":
    main()
