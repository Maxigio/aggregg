"""Schermate secondarie del TUI. v1: WatchlistScreen (gestione target) + conferma."""
from __future__ import annotations

import asyncio

from textual import work
from textual.containers import Container, Horizontal
from textual.screen import ModalScreen, Screen
from textual.widgets import Button, DataTable, Footer, Header, Input, Label, RichLog, Static

from . import actions as A
from . import queries as Q
from . import render as R
from .db import Db


# ── coda crawl (F60): helper condivisi ──────────────────────────────────────
# Girano in thread (to_thread). Usano una Db PROPRIA a vita breve → niente contesa
# con la self.db (live-reload) dello schermo che li chiama.
def _enqueue_and_drain(rows: list[dict]) -> dict:
    """Enqueue di righe + avvio drainer. Ritorna {queued, skipped, drainer}.
    Spawn SEMPRE quando qualcosa è in coda — idempotente (il singolo drainer è
    garantito dall'advisory lock: un 2º esce subito). Così si chiude la race in cui
    un drainer in uscita farebbe saltare il re-spawn lasciando il job orfano."""
    with Db() as db:
        res = A.enqueue_rows(db, rows)
        if not res["queued"]:
            res["drainer"] = "—"
            return res
        try:
            from .drainer import spawn_drainer
            spawn_drainer()
            res["drainer"] = "attivo"
        except Exception as e:
            res["drainer"] = f"spawn KO ({e})"
    return res


def _wl_payload(r: dict) -> dict:
    """Riga watchlist → job coda (watchlist_id valorizzato → markSwept dopo)."""
    return {"tipo": r["tipo"], "marca": r["marca"], "modello": r["modello"],
            "watchlist_id": r.get("id"), "last_truncated": r.get("last_truncated")}


def _cov_payload(r: dict) -> dict:
    """Riga copertura → job coda AD-HOC (per (target,fonte) non c'è un id watchlist)."""
    return {"tipo": r["tipo"], "marca": r["marca"], "modello": r["modello"]}


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


class FilterTableScreen(Screen):
    """Base 'filtro + tabella' (M-H). La DataTable ha il focus al mount → i tasti
    azione per-riga e la nav globale funzionano SUBITO (niente Tab nascosto). '/'
    porta il focus al filtro; Invio/esc lo riportano alla tabella (i tasti tornano
    vivi). Le sottoclassi definiscono TABLE_ID/FILTER_ID/MENU_KEY + reload()/_populate().

    Prima del fix: l'Input filtro rubava il focus al mount → 'e/g/d/…' finivano come
    testo nel filtro e le azioni NON scattavano (provato headless). Ora il filtro è
    esplicito (`/`), tutto il resto è azione/navigazione."""

    DEFAULT_CSS = """
    #menu { dock: top; height: 1; }
    """
    BINDINGS = [
        ("escape", "back", "Indietro"),
        ("slash", "focus_filter", "Filtra"),
    ]
    TABLE_ID = "#grid"
    FILTER_ID = "#filter"
    MENU_KEY = ""

    def _focus_table(self) -> None:
        self.query_one(self.TABLE_ID, DataTable).focus()

    def action_focus_filter(self) -> None:
        self.query_one(self.FILTER_ID, Input).focus()

    def action_back(self) -> None:
        # esc 'smart': dal filtro torna alla tabella; dalla tabella esce dalla schermata.
        if isinstance(self.app.focused, Input):
            self._focus_table()
        else:
            self.app.pop_screen()

    def on_input_submitted(self, _e: Input.Submitted) -> None:
        # reload() è definita dalla sottoclasse (worker); poi ri-do il focus alla
        # tabella così i tasti globali/azione tornano attivi senza un Tab.
        self.reload()
        self._focus_table()


class WatchlistScreen(FilterTableScreen):
    """Gestione watchlist: tabella filtrabile + azioni per-riga (off-loop)."""

    CSS = """
    #menu { dock: top; height: 1; }
    #filter { dock: top; }
    #wstatus { dock: bottom; height: 1; color: $text-muted; }
    DataTable { height: 1fr; }
    """
    BINDINGS = [
        ("r", "reload", "Aggiorna"),
        ("e", "toggle_enabled", "On/Off"),
        ("n", "cycle_node", "Nodo→"),
        ("t", "cycle_tipo", "Tipo→"),
        ("d", "delete_row", "Elimina"),
        ("g", "enqueue_one", "Coda"),
        ("G", "enqueue_all", "Coda tutte"),
    ]
    TABLE_ID = "#grid"
    FILTER_ID = "#filter"
    MENU_KEY = "watchlist"

    def __init__(self, db: Db | None = None):
        super().__init__()
        self.db = db or Db()        # connessione propria → no contesa con la dashboard
        self._owns_db = db is None  # se l'ho creata io, la chiudo su unmount
        self.rows: list[dict] = []
        self._confirming = False    # guard anti-stacking del modale di conferma
        self._tipo: str | None = None   # filtro tipo: None=tutti (interleave) → auto → moto

    def on_unmount(self) -> None:
        if self._owns_db:
            self.db.close()

    def compose(self):
        yield Header(show_clock=True)
        yield Static(R.menu_bar(self.MENU_KEY), id="menu")
        yield Input(placeholder="filtro marca/modello… (Invio per aggiornare)", id="filter")
        yield DataTable(id="grid", cursor_type="row", zebra_stripes=True)
        yield Static(id="wstatus")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#grid", DataTable).add_columns(
            "tipo", "marca", "modello", "nodo", "stato", "annunci", "priority", "ultimo sweep")
        self.reload()
        self._focus_table()   # M-H: focus alla tabella (non al filtro) → azioni vive subito

    # ── helper sincroni (girano in thread via to_thread) ───────────────────
    def _load(self, q: str) -> list[dict]:
        return Q.watchlist_rows(self.db, q=q or None, tipo=self._tipo, limit=500)

    def _populate(self, rows: list[dict]) -> None:
        self.rows = rows
        t = self.query_one("#grid", DataTable)
        t.clear()
        for r in rows:
            t.add_row(r["tipo"], R.safe(r["marca"]), R.safe(r["modello"]), R.node_label(r),
                      R.state_label(r), str(r["annunci"]), R._num(r["priority"]),
                      R._ago(r["last_swept"]), key=str(r["id"]))
        total = rows[0]["total"] if rows else 0
        tipo_lbl = self._tipo or "tutti"
        self.query_one("#wstatus", Static).update(
            f"{len(rows)} mostrati / {total} totali · [b]tipo: {tipo_lbl}[/]  ·  tasti in fondo ↓")

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

    def action_cycle_tipo(self) -> None:
        # filtro VISTA (non muta il DB): tutti (interleave auto+moto) → auto → moto → tutti
        self._tipo = {None: "auto", "auto": "moto", "moto": None}[self._tipo]
        self.reload()

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

    # ── coda crawl: accoda la riga sotto il cursore o tutte le mostrate ────────
    def action_enqueue_one(self) -> None:
        r = self._current()
        if r:
            self._enqueue([_wl_payload(r)])

    def action_enqueue_all(self) -> None:
        if self.rows:
            self._enqueue([_wl_payload(r) for r in self.rows])

    @work(exclusive=True, group="wl-enqueue")
    async def _enqueue(self, rows) -> None:
        try:
            res = await asyncio.to_thread(_enqueue_and_drain, rows)
        except Exception as e:
            self.query_one("#wstatus", Static).update(f"[red]coda errore:[/] {R.safe(e)}")
            return
        self.query_one("#wstatus", Static).update(
            f"in coda: {res['queued']} · dup {res['skipped']} · drainer {res['drainer']}  ·  [b]k[/] coda")


class AccessLogScreen(FilterTableScreen):
    """Log eventi/accessi (sola lettura, live): chi si connette + cosa cerca.
    Scritto dal server Node in access_log; qui solo letto (DB-puro)."""

    CSS = """
    #menu { dock: top; height: 1; }
    #afilter { dock: top; }
    #astatus { dock: bottom; height: 1; color: $text-muted; }
    DataTable { height: 1fr; }
    """
    BINDINGS = [
        ("r", "reload", "Aggiorna"),
    ]
    TABLE_ID = "#alog"
    FILTER_ID = "#afilter"
    MENU_KEY = "accesslog"

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
        yield Static(R.menu_bar(self.MENU_KEY), id="menu")
        yield Input(placeholder="filtro: demo | full | search | login   (Invio)", id="afilter")
        yield DataTable(id="alog", cursor_type="row", zebra_stripes=True)
        yield Static(id="astatus")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#alog", DataTable).add_columns("quando", "chi", "evento", "ip", "dettaglio")
        self.reload()
        self.set_interval(5, self.reload)   # live: nuovi accessi/ricerche compaiono
        self._focus_table()   # M-H: focus alla tabella, filtro via '/'

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
            f"{len(rows)} eventi · filtri: demo/full/search/login  ·  tasti in fondo ↓")

    @work(exclusive=True, group="alog-reload")
    async def reload(self) -> None:
        token = self.query_one("#afilter", Input).value
        try:
            rows = await asyncio.to_thread(self._load, token)
        except Exception as e:
            self.query_one("#astatus", Static).update(f"[red]errore DB:[/] {e}")
            return
        self._populate(rows)


class CoverageScreen(FilterTableScreen):
    """Copertura ground-truth (sola lettura, live): per (target,fonte) tetto vs
    ingeriti vs %, ordinato per copertura peggiore. Il tetto lo scrive il crawler."""

    CSS = """
    #menu { dock: top; height: 1; }
    #cfilter { dock: top; }
    #cstatus { dock: bottom; height: 1; color: $text-muted; }
    DataTable { height: 1fr; }
    """
    BINDINGS = [
        ("r", "reload", "Aggiorna"),
        ("g", "enqueue_one", "Coda"),
        ("G", "enqueue_all", "Coda tutte"),
    ]
    TABLE_ID = "#cov"
    FILTER_ID = "#cfilter"
    MENU_KEY = "coverage"

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
        yield Static(R.menu_bar(self.MENU_KEY), id="menu")
        yield Input(placeholder="filtro fonte: subito | autoscout | moto   (Invio)", id="cfilter")
        yield DataTable(id="cov", cursor_type="row", zebra_stripes=True)
        yield Static(id="cstatus")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#cov", DataTable).add_columns(
            "tipo", "marca", "modello", "fonte", "tetto", "ingeriti", "copertura", "manca", "stato")
        self.reload()
        self.set_interval(10, self.reload)
        self._focus_table()   # M-H: focus alla tabella, filtro via '/'

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
            t.add_row(r["tipo"], R.safe(r["marca"]), R.safe(r["modello"]), R.safe(r["fonte"]),
                      R._num(r["tetto"]), R._num(r["ingeriti"]), R.cov_label(r["coverage_pct"]),
                      R._num(r["manca"]), R.cov_state(r))
        self.query_one("#cstatus", Static).update(
            f"{len(rows)} (target,fonte) · ordinati per copertura PEGGIORE · "
            f"filtro fonte: subito/autoscout/moto  ·  tasti in fondo ↓")

    @work(exclusive=True, group="cov-reload")
    async def reload(self) -> None:
        token = self.query_one("#cfilter", Input).value
        try:
            rows = await asyncio.to_thread(self._load, token)
        except Exception as e:
            self.query_one("#cstatus", Static).update(f"[red]errore DB:[/] {e}")
            return
        self._populate(rows)

    # ── coda crawl: accoda (ad-hoc) i target più scoperti ─────────────────────
    def _current(self) -> dict | None:
        t = self.query_one("#cov", DataTable)
        i = t.cursor_row
        return self.rows[i] if self.rows and 0 <= i < len(self.rows) else None

    def action_enqueue_one(self) -> None:
        r = self._current()
        if r:
            self._enqueue([_cov_payload(r)])

    def action_enqueue_all(self) -> None:
        if self.rows:
            self._enqueue([_cov_payload(r) for r in self.rows])

    @work(exclusive=True, group="cov-enqueue")
    async def _enqueue(self, rows) -> None:
        try:
            res = await asyncio.to_thread(_enqueue_and_drain, rows)
        except Exception as e:
            self.query_one("#cstatus", Static).update(f"[red]coda errore:[/] {R.safe(e)}")
            return
        self.query_one("#cstatus", Static).update(
            f"in coda: {res['queued']} · dup {res['skipped']} · drainer {res['drainer']}  ·  [b]k[/] coda")


class CrawlQueueScreen(Screen):
    """Coda crawl (live): la TUI enqueue, il drainer (scripts/crawl-once.js) drena.
    1 IP → sequenziale (~27s/target). [a] avvia drainer · [c] annulla riga ·
    [x] svuota i pending · [r] aggiorna. I crawl popolano anche la copertura."""

    CSS = """
    #menu { dock: top; height: 1; }
    #qstatus { dock: bottom; height: 1; color: $text-muted; }
    DataTable { height: 1fr; }
    """
    BINDINGS = [
        ("escape", "app.pop_screen", "Indietro"),
        ("r", "reload", "Aggiorna"),
        ("a", "start", "Avvia drainer"),   # M-H: 'g' liberato (= accoda altrove); qui 'a' = avvia
        ("c", "cancel_row", "Annulla"),
        ("x", "clear", "Svuota coda"),
    ]

    def __init__(self, db: Db | None = None):
        super().__init__()
        self.db = db or Db()          # usata SOLO dalla reload live (q-reload)
        self._owns_db = db is None
        self.rows: list[dict] = []

    def on_unmount(self) -> None:
        if self._owns_db:
            self.db.close()

    def compose(self):
        yield Header(show_clock=True)
        yield Static(R.menu_bar("queue"), id="menu")
        yield DataTable(id="q", cursor_type="row", zebra_stripes=True)
        yield Static(id="qstatus")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#q", DataTable).add_columns(
            "id", "stato", "tipo", "marca", "modello", "prio", "nuovi/scritti", "info")
        self.reload()
        self.set_interval(3, self.reload)   # live: la coda si svuota mentre il drainer gira

    def _load(self) -> tuple:
        return (Q.crawl_queue(self.db, limit=200), Q.queue_counts(self.db), Q.drainer_alive(self.db))

    def _populate(self, data) -> None:
        rows, counts, alive = data
        self.rows = rows
        t = self.query_one("#q", DataTable)
        t.clear()
        for r in rows:
            when = r["finished_at"] or r["started_at"] or r["enqueued_at"]
            info = R.safe(r["error"]) if r["status"] == "fail" and r.get("error") else R._ago(when)
            pg = r.get("pages")
            mod = R.safe(r["modello"]) + ("" if pg is None else f" [dim]·{R.depth_label(pg)}[/]")
            ins, wr = r.get("inserted"), r.get("written")
            ns = R._num(wr) if ins is None else f"{ins:,}/{wr:,}"   # nuovi/scritti (M-E onestà)
            t.add_row(str(r["id"]), R.qstate_label(r["status"]), r["tipo"],
                      R.safe(r["marca"]), mod, R._num(r["priority"]),
                      ns, info, key=str(r["id"]))
        eta = counts["pending"] * 27
        eta_s = f"~{eta // 60}m{eta % 60:02d}s" if eta else "0"
        drn = "[green]drainer attivo[/]" if alive else "[dim]drainer fermo[/]"
        self.query_one("#qstatus", Static).update(
            f"[cyan]{counts['running']} in corso[/] · [yellow]{counts['pending']} in attesa[/] "
            f"(ETA {eta_s}) · {counts['done']} fatti · {counts['fail']} ko · "
            f"{counts.get('annullati', 0)} annullati · {drn}  ·  tasti in fondo ↓")

    def _current(self) -> dict | None:
        t = self.query_one("#q", DataTable)
        i = t.cursor_row
        return self.rows[i] if self.rows and 0 <= i < len(self.rows) else None

    @work(exclusive=True, group="q-reload")
    async def reload(self) -> None:
        try:
            data = await asyncio.to_thread(self._load)
        except Exception as e:
            self.query_one("#qstatus", Static).update(f"[red]errore DB:[/] {R.safe(e)}")
            return
        self._populate(data)

    # azioni: Db PROPRIA (no contesa con la reload live su self.db)
    def action_start(self) -> None:
        self._act("start")

    def action_clear(self) -> None:
        self._act("clear")

    def action_cancel_row(self) -> None:
        r = self._current()
        if r:
            self._act("cancel", r["id"])

    @work(exclusive=True, group="q-act")
    async def _act(self, op, *args) -> None:
        try:
            msg = await asyncio.to_thread(self._do_op, op, args)
        except Exception as e:
            self.notify(f"errore: {e}", severity="error")
            return
        if msg:
            self.notify(msg)
        self.reload()

    @staticmethod
    def _do_op(op, args) -> str:
        with Db() as db:
            if op == "cancel":
                st = A.cancel(db, args[0])
                return f"job {args[0]}: {st or 'non attivo'}"
            if op == "clear":
                return f"coda svuotata: {A.clear_pending(db)} pending annullati"
            if op == "start":
                from .drainer import spawn_drainer
                spawn_drainer()   # idempotente (lock): se uno è già attivo, il nuovo esce subito
                return "drainer avviato"
        return ""


class SuggesterScreen(FilterTableScreen):
    """Suggeritore (ex-ramp): prossimi target da crawlare — 'da completare' (gap noto
    da market_size) prima, poi 'da scoprire' (mai-crawlati) per liquidità brand.
    [g] accoda riga · [G] accoda tutte le mostrate. Coverage-driven, dati veri."""

    CSS = """
    #menu { dock: top; height: 1; }
    #sfilter { dock: top; }
    #sstatus { dock: bottom; height: 1; color: $text-muted; }
    DataTable { height: 1fr; }
    """
    BINDINGS = [
        ("r", "reload", "Aggiorna"),
        ("g", "enqueue_one", "Coda"),
        ("G", "enqueue_all", "Coda tutte"),
    ]
    TABLE_ID = "#sugg"
    FILTER_ID = "#sfilter"
    MENU_KEY = "suggester"

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
        yield Static(R.menu_bar(self.MENU_KEY), id="menu")
        yield Input(placeholder="filtro marca/modello… (Invio)", id="sfilter")
        yield DataTable(id="sugg", cursor_type="row", zebra_stripes=True)
        yield Static(id="sstatus")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#sugg", DataTable).add_columns(
            "tipo", "marca", "modello", "stato", "tetto", "manca", "priority")
        self.reload()
        self.set_interval(15, self.reload)   # live: gli accodati/crawlati spariscono da soli (15s: query più grande)
        self._focus_table()   # M-H: focus alla tabella, filtro via '/'

    def _load(self, q: str) -> list[dict]:
        return Q.suggestions(self.db, q=q or None, limit=500)

    def _populate(self, rows: list[dict]) -> None:
        self.rows = rows
        t = self.query_one("#sugg", DataTable)
        t.clear()
        for r in rows:
            t.add_row(r["tipo"], R.safe(r["marca"]), R.safe(r["modello"]),
                      R.sugg_state(r), R._num(r.get("tetto")), R._num(r.get("manca")),
                      R._num(r.get("priority")), key=str(r["id"]))
        self.query_one("#sstatus", Static).update(
            f"{len(rows)} suggeriti · 'da completare' (gap) prima, poi liquidità  ·  tasti in fondo ↓")

    def _current(self) -> dict | None:
        t = self.query_one("#sugg", DataTable)
        i = t.cursor_row
        return self.rows[i] if self.rows and 0 <= i < len(self.rows) else None

    def action_enqueue_one(self) -> None:
        r = self._current()
        if r:
            self._enqueue([_wl_payload(r)])

    def action_enqueue_all(self) -> None:
        if self.rows:
            self._enqueue([_wl_payload(r) for r in self.rows])

    @work(exclusive=True, group="sugg-reload")
    async def reload(self) -> None:
        q = self.query_one("#sfilter", Input).value
        try:
            rows = await asyncio.to_thread(self._load, q)
        except Exception as e:
            self.query_one("#sstatus", Static).update(f"[red]errore DB:[/] {R.safe(e)}")
            return
        self._populate(rows)

    @work(exclusive=True, group="sugg-enqueue")
    async def _enqueue(self, rows) -> None:
        try:
            res = await asyncio.to_thread(_enqueue_and_drain, rows)
        except Exception as e:
            self.query_one("#sstatus", Static).update(f"[red]coda errore:[/] {R.safe(e)}")
            return
        self.query_one("#sstatus", Static).update(
            f"in coda: {res['queued']} · dup {res['skipped']} · drainer {res['drainer']}  ·  [b]k[/] coda")
        self.reload()   # gli accodati spariscono dai suggerimenti (NOT EXISTS sulla coda)


# ── M-D: schermata Comandi dedicata ─────────────────────────────────────────
class CommandScreen(Screen):
    """Centro comandi: input + storia/output persistente + cheatsheet. Riusa
    commands.parse_command + dispatch.dispatch (gli STESSI della vecchia barra `:`).
    Input sempre a fuoco; ↑/↓ richiamano i comandi digitati; l'output RESTA (a
    differenza del toast effimero della dashboard). DB-puro: il dispatch apre una Db
    propria a vita breve e spawna il drainer (idempotente via advisory lock)."""

    CSS = """
    #menu { dock: top; height: 1; }
    #cheat { dock: top; height: auto; }
    #cmdin { dock: bottom; }
    #out { height: 1fr; }
    """
    BINDINGS = [
        ("escape", "app.pop_screen", "Indietro"),
        ("up", "hist_prev", "Comando ↑"),
        ("down", "hist_next", "Comando ↓"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self._history: list[str] = []
        self._hidx = 0   # cursore nella storia; == len(history) = "riga nuova vuota"

    def compose(self):
        yield Header(show_clock=True)
        yield Static(R.menu_bar("command"), id="menu")
        yield Static(R.command_cheatsheet(), id="cheat")
        yield RichLog(id="out", markup=True, wrap=True, highlight=False)
        yield Input(id="cmdin",
                    placeholder=":run auto bmw serie 3 [full|pN]  ·  :add  ·  :run due  ·  :clear  ·  :cancel <id>")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#out", RichLog).write(
            "[dim]Centro comandi — digita un comando e Invio · ↑/↓ storia · esc indietro[/]")
        self.query_one("#cmdin", Input).focus()

    def action_hist_prev(self) -> None:
        if self._history:
            self._hidx = max(0, self._hidx - 1)
            self.query_one("#cmdin", Input).value = self._history[self._hidx]

    def action_hist_next(self) -> None:
        if not self._history:
            return
        self._hidx = min(len(self._history), self._hidx + 1)
        self.query_one("#cmdin", Input).value = (
            self._history[self._hidx] if self._hidx < len(self._history) else "")

    def on_input_submitted(self, e: Input.Submitted) -> None:
        from . import commands as C
        text = e.value
        e.input.value = ""
        if not text.strip():
            return
        self._history.append(text)
        self._hidx = len(self._history)
        out = self.query_one("#out", RichLog)
        out.write(f"[cyan]› {R.safe(text)}[/]")
        parsed = C.parse_command(text)
        if parsed["cmd"] == "noop":
            return
        if parsed["cmd"] == "error":
            out.write(f"  [yellow]{R.safe(parsed['msg'])}[/]")
            return
        self._run(parsed)

    @work(exclusive=True, group="cmd-screen")
    async def _run(self, parsed: dict) -> None:
        # dispatch è BLOCCANTE (psycopg) → to_thread; la write torna sul loop (worker async).
        from .dispatch import dispatch
        out = self.query_one("#out", RichLog)
        try:
            msg = await asyncio.to_thread(dispatch, parsed)
            out.write(f"  [green]{R.safe(msg)}[/]")
        except Exception as e:   # validazione/DB → riga rossa, niente crash
            out.write(f"  [red]{R.safe(e)}[/]")


# ── M-G: schermata Salute crawler (crawl_health) ────────────────────────────
class HealthScreen(Screen):
    """Salute crawler per (nodo,fonte) da crawl_health: blocco/degrado + contatori, live.
    Riusa Q.health (= getHealth JS). Il blocco scatta su 429/403/body-non-JSON (scraper
    taggano kind='blocked') → back-off 6h. 'mai' in ultimo blocco = mai bloccato (bene)."""

    CSS = """
    #menu { dock: top; height: 1; }
    #hstatus { dock: bottom; height: 1; color: $text-muted; }
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
        yield Static(R.menu_bar("health"), id="menu")
        yield DataTable(id="health", cursor_type="row", zebra_stripes=True)
        yield Static(id="hstatus")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#health", DataTable).add_columns(
            "nodo", "fonte", "stato", "ultimo ok", "ultimo blocco", "consec", "ok", "vuoti", "err", "blk")
        self.reload()
        self.set_interval(5, self.reload)   # live: un blocco compare in tempo reale

    def _load(self) -> dict:
        return Q.health(self.db)

    def _populate(self, data: dict) -> None:
        rows = data["nodi"]
        self.rows = rows
        t = self.query_one("#health", DataTable)
        t.clear()
        for r in rows:
            t.add_row(R.safe(r["node"]), R.safe(r["fonte"]), R.health_state(r),
                      R._ago(r.get("last_ok")), R._ago(r.get("last_blocked_at")),
                      R._num(r.get("consec_fail")), R._num(r.get("ok_count")),
                      R._num(r.get("empty_count")), R._num(r.get("error_count")),
                      R._num(r.get("blocked_count")), key=f"{r['node']}/{r['fonte']}")
        nb, nd = len(data["blocked"]), len(data["degraded"])
        self.query_one("#hstatus", Static).update(
            f"{len(rows)} fonti · [red]{nb} bloccate[/] · [yellow]{nd} degradate[/] · "
            f"blocco = 429/403/non-JSON → back-off 6h")

    @work(exclusive=True, group="health-reload")
    async def reload(self) -> None:
        try:
            data = await asyncio.to_thread(self._load)
        except Exception as e:
            self.query_one("#hstatus", Static).update(f"[red]errore DB:[/] {R.safe(e)}")
            return
        self._populate(data)
