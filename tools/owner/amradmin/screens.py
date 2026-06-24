"""Schermate secondarie del TUI. v1: WatchlistScreen (gestione target) + conferma."""
from __future__ import annotations

import asyncio

from textual import work
from textual.containers import Container, Horizontal
from textual.screen import ModalScreen, Screen
from textual.widgets import Button, DataTable, Footer, Header, Input, Label, Static

from . import actions as A
from . import queries as Q
from . import render as R
from .db import Db


class ConfirmScreen(ModalScreen[bool]):
    """Modale Sì/No. Ritorna True/False via dismiss."""

    CSS = """
    ConfirmScreen { align: center middle; }
    #dialog { width: 64; height: auto; border: thick $accent; background: $surface; padding: 1 2; }
    #buttons { height: auto; align: center middle; margin-top: 1; }
    Button { margin: 0 2; }
    """
    BINDINGS = [("escape", "cancel", "Annulla")]

    def __init__(self, question: str):
        super().__init__()
        self.question = question

    def compose(self):
        with Container(id="dialog"):
            yield Label(self.question)
            with Horizontal(id="buttons"):
                yield Button("Sì", variant="error", id="yes")
                yield Button("Annulla", id="no")

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.dismiss(e.button.id == "yes")

    def action_cancel(self) -> None:
        self.dismiss(False)


class WatchlistScreen(Screen):
    """Gestione watchlist: tabella filtrabile + azioni per-riga (off-loop)."""

    CSS = """
    #filter { dock: top; }
    #wstatus { dock: bottom; height: 1; color: $text-muted; }
    DataTable { height: 1fr; }
    """
    BINDINGS = [
        ("escape", "app.pop_screen", "Indietro"),
        ("r", "reload", "Aggiorna"),
        ("e", "toggle_enabled", "On/Off"),
        ("n", "cycle_node", "Nodo→"),
        ("d", "delete_row", "Elimina"),
    ]

    def __init__(self, db: Db | None = None):
        super().__init__()
        self.db = db or Db()        # connessione propria → no contesa con la dashboard
        self._owns_db = db is None  # se l'ho creata io, la chiudo su unmount
        self.rows: list[dict] = []
        self._confirming = False    # guard anti-stacking del modale di conferma

    def on_unmount(self) -> None:
        if self._owns_db:
            self.db.close()

    def compose(self):
        yield Header(show_clock=True)
        yield Input(placeholder="filtro marca/modello… (Invio per aggiornare)", id="filter")
        yield DataTable(id="grid", cursor_type="row", zebra_stripes=True)
        yield Static(id="wstatus")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#grid", DataTable).add_columns(
            "tipo", "marca", "modello", "nodo", "stato", "annunci", "priority", "ultimo sweep")
        self.reload()

    def on_input_submitted(self, _e: Input.Submitted) -> None:
        self.reload()

    # ── helper sincroni (girano in thread via to_thread) ───────────────────
    def _load(self, q: str) -> list[dict]:
        return Q.watchlist_rows(self.db, q=q or None, limit=500)

    def _populate(self, rows: list[dict]) -> None:
        self.rows = rows
        t = self.query_one("#grid", DataTable)
        t.clear()
        for r in rows:
            t.add_row(r["tipo"], R.safe(r["marca"]), R.safe(r["modello"]), R.node_label(r),
                      R.state_label(r), str(r["annunci"]), R._num(r["priority"]),
                      R._ago(r["last_swept"]), key=str(r["id"]))
        total = rows[0]["total"] if rows else 0
        self.query_one("#wstatus", Static).update(
            f"{len(rows)} mostrati / {total} totali · [e] on/off · [n] nodo · [d] elimina "
            f"· [r] aggiorna · [esc] indietro")

    def _current(self) -> dict | None:
        t = self.query_one("#grid", DataTable)
        i = t.cursor_row
        return self.rows[i] if self.rows and 0 <= i < len(self.rows) else None

    # ── workers (DB off event-loop) ────────────────────────────────────────
    # Gruppi distinti: reload e _apply NON si cancellano a vicenda (sennò un
    # reload manuale annullerebbe una scrittura in corso). exclusive dentro ciascun gruppo.
    @work(exclusive=True, group="wl-reload")
    async def reload(self) -> None:
        q = self.query_one("#filter", Input).value
        try:
            rows = await asyncio.to_thread(self._load, q)
        except Exception as e:
            self.query_one("#wstatus", Static).update(f"[red]errore DB:[/] {e}")
            return
        self._populate(rows)

    @work(exclusive=True, group="wl-mutate")
    async def _apply(self, fn, *args) -> None:
        try:
            await asyncio.to_thread(fn, self.db, *args)
            rows = await asyncio.to_thread(self._load, self.query_one("#filter", Input).value)
        except Exception as e:
            self.query_one("#wstatus", Static).update(f"[red]errore:[/] {e}")
            return
        self._populate(rows)

    # ── azioni sulla riga evidenziata ──────────────────────────────────────
    # toggle/cycle sono ATOMICI in SQL (sul valore reale nel DB) → niente
    # read-modify-write da self.rows (che può essere stale dopo una scrittura).
    def action_toggle_enabled(self) -> None:
        r = self._current()
        if r:
            self._apply(A.toggle_enabled, r["id"])

    def action_cycle_node(self) -> None:
        r = self._current()
        if r:
            self._apply(A.cycle_node, r["id"])

    def action_delete_row(self) -> None:
        if self._confirming:        # un modale è già aperto → non impilarne altri
            return
        r = self._current()
        if r:
            self._confirm_delete(r)

    @work
    async def _confirm_delete(self, r: dict) -> None:
        self._confirming = True
        try:
            ok = await self.app.push_screen_wait(
                ConfirmScreen(f"Eliminare «{r['marca']} {r['modello']}»?  (i listing già raccolti restano)"))
        finally:
            self._confirming = False
        if ok:
            self._apply(A.remove_one, r["id"])


class AccessLogScreen(Screen):
    """Log eventi/accessi (sola lettura, live): chi si connette + cosa cerca.
    Scritto dal server Node in access_log; qui solo letto (DB-puro)."""

    CSS = """
    #afilter { dock: top; }
    #astatus { dock: bottom; height: 1; color: $text-muted; }
    DataTable { height: 1fr; }
    """
    BINDINGS = [
        ("escape", "app.pop_screen", "Indietro"),
        ("r", "reload", "Aggiorna"),
    ]

    def __init__(self, db: Db | None = None):
        super().__init__()
        self.db = db or Db()
        self._owns_db = db is None
        self.rows: list[dict] = []

    def on_unmount(self) -> None:
        if self._owns_db:
            self.db.close()

    def compose(self):
        yield Header(show_clock=True)
        yield Input(placeholder="filtro: demo | full | search | login   (Invio)", id="afilter")
        yield DataTable(id="alog", cursor_type="row", zebra_stripes=True)
        yield Static(id="astatus")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#alog", DataTable).add_columns("quando", "chi", "evento", "ip", "dettaglio")
        self.reload()
        self.set_interval(5, self.reload)   # live: nuovi accessi/ricerche compaiono

    def on_input_submitted(self, _e: Input.Submitted) -> None:
        self.reload()

    @staticmethod
    def _filters(token: str) -> dict:
        t = (token or "").strip().lower()
        if t in ("full", "demo"):
            return {"role": t}
        if t == "search":
            return {"event": "search"}
        if t == "login":
            return {"event_like": "login%"}
        return {}

    def _load(self, token: str) -> list[dict]:
        return Q.access_log(self.db, limit=200, **self._filters(token))

    def _populate(self, rows: list[dict]) -> None:
        self.rows = rows
        t = self.query_one("#alog", DataTable)
        t.clear()
        for r in rows:
            quando = r["ts"].strftime("%d/%m %H:%M:%S") if r.get("ts") else "—"
            if r["event"] == "search":
                det = R.search_label(r.get("query"))
                if r.get("result_count") is not None:
                    det += f"  [dim]→ {r['result_count']}[/]"
            else:
                det = f"[dim]{R.safe((r.get('user_agent') or '')[:48])}[/]"
            t.add_row(quando, R.who_label(r.get("role")), R.event_label(r["event"]),
                      R.safe(r.get("ip") or "—"), det)
        self.query_one("#astatus", Static).update(
            f"{len(rows)} eventi · filtri: demo/full/search/login · [r] aggiorna · [esc] indietro")

    @work(exclusive=True, group="alog-reload")
    async def reload(self) -> None:
        token = self.query_one("#afilter", Input).value
        try:
            rows = await asyncio.to_thread(self._load, token)
        except Exception as e:
            self.query_one("#astatus", Static).update(f"[red]errore DB:[/] {e}")
            return
        self._populate(rows)


class CoverageScreen(Screen):
    """Copertura ground-truth (sola lettura, live): per (target,fonte) tetto vs
    ingeriti vs %, ordinato per copertura peggiore. Il tetto lo scrive il crawler."""

    CSS = """
    #cfilter { dock: top; }
    #cstatus { dock: bottom; height: 1; color: $text-muted; }
    DataTable { height: 1fr; }
    """
    BINDINGS = [
        ("escape", "app.pop_screen", "Indietro"),
        ("r", "reload", "Aggiorna"),
    ]

    def __init__(self, db: Db | None = None):
        super().__init__()
        self.db = db or Db()
        self._owns_db = db is None
        self.rows: list[dict] = []

    def on_unmount(self) -> None:
        if self._owns_db:
            self.db.close()

    def compose(self):
        yield Header(show_clock=True)
        yield Input(placeholder="filtro fonte: subito | autoscout | moto   (Invio)", id="cfilter")
        yield DataTable(id="cov", cursor_type="row", zebra_stripes=True)
        yield Static(id="cstatus")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#cov", DataTable).add_columns(
            "tipo", "marca", "modello", "fonte", "tetto", "ingeriti", "copertura", "manca")
        self.reload()
        self.set_interval(10, self.reload)

    def on_input_submitted(self, _e: Input.Submitted) -> None:
        self.reload()

    def _load(self, token: str) -> list[dict]:
        f = (token or "").strip().lower() or None
        if f not in (None, "subito", "autoscout", "moto"):
            f = None
        return Q.coverage(self.db, fonte=f, limit=300)

    def _populate(self, rows: list[dict]) -> None:
        self.rows = rows
        t = self.query_one("#cov", DataTable)
        t.clear()
        for r in rows:
            t.add_row(r["tipo"], R.safe(r["marca"]), R.safe(r["modello"]), r["fonte"],
                      R._num(r["tetto"]), R._num(r["ingeriti"]), R.cov_label(r["coverage_pct"]),
                      R._num(r["manca"]))
        self.query_one("#cstatus", Static).update(
            f"{len(rows)} (target,fonte) · ordinati per copertura PEGGIORE · "
            f"filtro fonte (subito/autoscout/moto) · [r] aggiorna · [esc] indietro")

    @work(exclusive=True, group="cov-reload")
    async def reload(self) -> None:
        token = self.query_one("#cfilter", Input).value
        try:
            rows = await asyncio.to_thread(self._load, token)
        except Exception as e:
            self.query_one("#cstatus", Static).update(f"[red]errore DB:[/] {e}")
            return
        self._populate(rows)
