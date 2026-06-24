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

REFRESH_SECONDS = 5


class AmrAdminApp(App):
    """Dashboard live del database Auto Moto Radar (sola lettura, v1)."""

    TITLE = "Auto Moto Radar — Owner"
    CSS = """
    #counts, #lastrun { height: auto; }
    #nodes { height: auto; }
    .col { width: 1fr; }
    #status { dock: bottom; height: 1; color: $text-muted; }
    """
    BINDINGS = [
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
        yield Static(id="status")
        yield Footer()

    def on_mount(self) -> None:
        self.refresh_data()
        self.set_interval(REFRESH_SECONDS, self.refresh_data)

    def action_refresh(self) -> None:
        self.refresh_data()

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
            "ramp": R.ramp_panel(Q.ramp_progress(db)),
        }


def main() -> None:
    AmrAdminApp().run()


if __name__ == "__main__":
    main()
