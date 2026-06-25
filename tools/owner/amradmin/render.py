"""Renderabili Rich per la dashboard (separati dalla logica Textual → testabili)."""
from __future__ import annotations

from datetime import datetime, timezone

from rich.markup import escape
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from .constants import FULL_PAGES, KNOWN_NODES, STALE_HOURS


def safe(v) -> str:
    """Escapa una stringa NON fidata per renderla letterale nel markup Rich.
    Senza, un valore utente con un tag (es. '[/]') solleva MarkupError e rompe la
    schermata (i campi del log — query/IP/user-agent — sono controllati dall'utente)."""
    return escape(str(v if v is not None else ""))


def _num(v) -> str:
    """Formatta un intero con separatore migliaia; None → '—' (priority è nullable)."""
    return f"{v:,}" if v is not None else "—"


def node_label(row: dict) -> str:
    return row.get("assigned_node") or "imac"


def state_label(row: dict) -> str:
    """Stato-crawl della riga watchlist su `last_swept` (coverage-driven). 'mai
    crawlato' = ⚪ to-do, NON 🔴 rosso (non è un errore!). `activated_at` (campo
    morto: niente più ramp) non più usato."""
    if not row.get("enabled"):
        return "[dim]spento[/]"
    ls = row.get("last_swept")
    if ls is None:
        return "[dim]⚪ mai[/]"
    age_h = (datetime.now(timezone.utc) - ls).total_seconds() / 3600
    return "[green]🟢 fresco[/]" if age_h < STALE_HOURS else "[yellow]🟡 da agg.[/]"


def cov_label(pct) -> str:
    """Percentuale copertura colorata: rosso <30, giallo <70, verde ≥70; None → —."""
    if pct is None:
        return "[dim]—[/]"
    p = float(pct)
    color = "red" if p < 30 else ("yellow" if p < 70 else "green")
    return f"[{color}]{p:.0f}%[/]"


def depth_label(pages) -> str:
    """Profondità per-run di un job: None→'default', ≥FULL_PAGES→'full', altrimenti 'Np'.
    UNICA fonte della soglia (app.py + screens.py la usano) → niente 200 sparso a mano.
    crawl_queue.pages tiene FULL_SENTINEL (9999) per 'full' → ricade in ≥FULL_PAGES."""
    if pages is None:
        return "default"
    return "full" if pages >= FULL_PAGES else f"{pages}p"


def health_state(row: dict) -> str:
    """Stato salute di una (node,fonte) da crawl_health: bloccato (back-off attivo) /
    degradato (transient consecutivi) / ok. Rosso SOLO per blocco reale (429/403/non-JSON)."""
    if row.get("blocked"):
        return "[red]🔴 bloccato[/]"
    if row.get("degraded"):
        return "[yellow]🟡 degradato[/]"
    return "[green]🟢 ok[/]"


def qstate_label(status) -> str:
    """Stato job della coda crawl, colorato."""
    return {"pending": "[yellow]⏳ in coda[/]", "running": "[cyan]▶ in corso[/]",
            "done": "[green]✓ fatto[/]", "fail": "[red]✗ errore[/]",
            "cancel_requested": "[magenta]✋ annullo[/]"}.get(status, safe(status) if status else "—")


def who_label(role) -> str:
    """role → chi (l'account demo non ha nome nel sistema: lo etichettiamo provademo2026)."""
    return {"full": "[bold]tu (owner)[/]", "demo": "[magenta]provademo2026[/]"}.get(role, "[dim]—[/]")


def event_label(event) -> str:
    return {"login_ok": "[green]login[/]", "login_fail": "[red]login KO[/]",
            "search": "[cyan]ricerca[/]"}.get(event, event or "—")


def search_label(query) -> str:
    """Rende leggibili i parametri di ricerca (robusto: non assume i nomi-chiave)."""
    if not isinstance(query, dict):
        return ""
    # i valori sono input utente → escape (no markup injection)
    head = " ".join(safe(query[k]) for k in ("marca", "modello", "versione") if query.get(k))
    tipo = query.get("tipo")
    rest = {k: v for k, v in query.items()
            if k not in ("marca", "modello", "versione", "tipo") and v not in (None, "", [])}
    tail = " · ".join(f"{safe(k)}={safe(v)}" for k, v in rest.items())
    out = []
    if tipo:
        out.append(f"[dim]{safe(tipo)}[/]")
    if head:
        out.append(head)
    if tail:
        out.append(f"[dim]{tail}[/]")
    return "  ".join(out) or "[dim](tutti)[/]"


def _ago(ts) -> str:
    if not ts:
        return "mai"
    now = datetime.now(timezone.utc)
    d = now - ts
    s = int(d.total_seconds())
    if s < 0:
        s = 0
    if s < 3600:
        return f"{s // 60}m fa"
    if s < 86400:
        return f"{s // 3600}h fa"
    return f"{s // 86400}g fa"


# ── nav raggruppata (M-H): UNA mappa = fonte sia della legenda sia dei gruppi ──
# (k, etichetta, chiave-attiva). 'home' = dashboard (esc). Tenere allineata alle
# BINDINGS in app.py (stessi tasti) — questa è la sola lista da cui nasce la legenda.
MENU_GROUPS = [
    ("STATO", [("esc", "home", "home"), ("h", "salute", "health"), ("l", "accessi", "accesslog")]),
    ("CRAWLA", [("s", "suggeriti", "suggester"), ("c", "copertura", "coverage"),
                ("w", "watchlist", "watchlist"), ("k", "coda", "queue")]),
    ("GESTISCI", [(":", "comandi", "command")]),
]


def menu_bar(active: str | None = None) -> Text:
    """Legenda di navigazione a 3 gruppi (docked in cima a ogni schermata). Evidenzia
    la voce attiva (reverse). I tasti sono i binding globali App: premerli da qualsiasi
    schermata naviga (i binding bubblano da una tabella a fuoco)."""
    out = Text(no_wrap=True, overflow="ellipsis")
    for gi, (group, items) in enumerate(MENU_GROUPS):
        if gi:
            out.append("   ")
        out.append(f"{group} ", style="bold magenta")
        for k, label, key in items:
            on = key is not None and key == active
            out.append(f" {k}", style="reverse cyan" if on else "bold cyan")
            out.append(f":{label}", style="white" if on else "dim")
    return out


def ops_line(alive: bool, counts: dict, health: dict) -> Text:
    """Riga ops live della dashboard: drainer on/off · coda+ETA · fonti bloccate.
    I 2 fatti operativi che prima costringevano ad andare in `k`/`h`."""
    drn = "[green]● drainer attivo[/]" if alive else "[dim]○ drainer fermo[/]"
    pend, run = counts.get("pending", 0), counts.get("running", 0)
    eta = pend * 27   # ~27s/target (1 IP, sequenziale)
    eta_s = f" (ETA ~{eta // 60}m{eta % 60:02d}s)" if eta else ""
    qpart = (f"[cyan]{run} in corso[/] · [yellow]{pend} in coda[/]{eta_s}"
             if (run or pend) else "[dim]coda vuota[/]")
    nb, nd = len(health.get("blocked", [])), len(health.get("degraded", []))
    hpart = f"[red]{nb} bloccate[/]" if nb else "[green]0 bloccate[/]"
    if nd:
        hpart += f" · [yellow]{nd} degradate[/]"
    return Text.from_markup(f"{drn}  ·  {qpart}  ·  fonti: {hpart}")


def command_cheatsheet() -> Panel:
    """Cheatsheet della schermata Comandi (M-D), sempre visibile in cima alla schermata."""
    t = Table.grid(padding=(0, 2))
    t.add_column(style="bold cyan", no_wrap=True)
    t.add_column()
    t.add_row(":run <auto|moto> <marca> <modello> [full|pN]",
              "accoda un crawl (ad-hoc anche fuori catalogo) · full=fino al cap · pN=N pagine")
    t.add_row(":add <auto|moto> <marca> <modello>", "aggiunge un target al catalogo watchlist (no crawl)")
    t.add_row(":run due", "accoda tutti i target 'due' (stantii)")
    t.add_row(":clear   ·   :stop", "svuota i pending della coda")
    t.add_row(":cancel <id>", "annulla un job (pending o in corso, tra un target e l'altro)")
    t.add_row("↑ / ↓", "richiama i comandi digitati")
    t.add_row("esc", "torna indietro")
    return Panel(t, title="Comandi disponibili", border_style="cyan")


def counts_panel(c: dict) -> Panel:
    t = Table.grid(expand=True)
    t.add_column(justify="center", ratio=1)
    t.add_column(justify="center", ratio=1)
    t.add_column(justify="center", ratio=1)
    t.add_row(
        Text(f"{c['total']:,}", style="bold cyan"),
        Text(f"{c['crawlati']:,}", style="bold green"),
        Text(f"{c['mai']:,}", style="bold yellow"),
    )
    t.add_row(Text("modelli totali", style="dim"), Text("crawlati", style="dim"),
              Text("mai crawlati", style="dim"))
    return Panel(t, title="Catalogo", border_style="cyan")


def nodes_panel(stats: list[dict], health: dict) -> Panel:
    # salute per (node,fonte) dalle righe crawl_health (NON dai tag rotti dell'admin)
    by_node: dict[str, list[dict]] = {}
    for row in health["nodi"]:
        by_node.setdefault(row["node"], []).append(row)
    stat_by = {s["node"]: s for s in stats}

    t = Table(expand=True, show_edge=False, pad_edge=False)
    t.add_column("nodo", style="bold")
    t.add_column("ultimo crawl", justify="right")
    t.add_column("stato crawl", justify="left")
    t.add_column("fonti", justify="left")
    # M-H: mostra SOLO i nodi con target (oggi solo 'imac' — assigned_node azzerato).
    # Gli altri KNOWN_NODES sono placeholder vuoti finché non c'è la Fase 3 (multi-nodo):
    # riassunti in una riga dim invece di 3 righe "0 target".
    active = [n for n in KNOWN_NODES if stat_by.get(n, {}).get("total", 0)] or ["imac"]
    for node in active:
        s = stat_by.get(node, {})
        # 🟢 fresco · 🟡 da agg. · ⚪ mai (to-do, NON rosso: "mai crawlato" non è un errore).
        state = (f"[green]🟢{s.get('fresco',0)}[/] [yellow]🟡{s.get('due',0)}[/] "
                 f"[dim]⚪{s.get('mai',0)}[/]")
        pills = []
        for hr in by_node.get(node, []):
            color = "red" if hr.get("blocked") else ("yellow" if hr.get("degraded") else "green")
            pills.append(f"[{color}]{hr['fonte']}[/]")
        label = node + (" [dim](centrale)[/]" if node == "imac" else "")
        # "ultimo crawl" = evento reale da crawl_runs (coerente col last_run_line in alto),
        # NON max(last_swept) (= freschezza catalogo, che un :run ad-hoc non muove).
        lr = s.get("last_run")
        t.add_row(label, _ago(lr) if lr else "—",
                  state, " ".join(pills) or "[dim]—[/]")
    others = len(KNOWN_NODES) - len(active)
    if others:
        t.add_row(f"[dim]+{others} nodi[/]", "", "[dim]spenti (Fase 3)[/]", "")
    return Panel(t, title="Nodi", border_style="magenta")


def fonti_panel(rows: list[dict]) -> Panel:
    t = Table(expand=True)
    t.add_column("fonte", style="bold")
    t.add_column("attivi", justify="right", style="green")
    t.add_column("spariti", justify="right", style="dim")
    t.add_column("totale", justify="right")
    for r in rows:
        t.add_row(r["fonte"], f"{r['active']:,}", f"{r['gone']:,}", f"{r['total']:,}")
    # "spariti" = non più online (≠ venduti): le fonti filtrano i venduti lato server,
    # noi vediamo solo presente/assente → è churn, non vendite.
    return Panel(t, title="Annunci per fonte · spariti = non più online", border_style="blue")


def sugg_state(row: dict) -> str:
    """Stato suggerimento (M-E 'tronca, NON manca'): mai-crawlato → 'da crawlare';
    tronca (cap pagine colpito = c'è davvero altro) → 'tronca → full'; altrimenti
    soddisfatto. coverage% è solo INFO (il gap count_all è rumore free-text, non il driver)."""
    if row.get("mai"):
        return "[dim]da crawlare (mai)[/]"
    pct = row.get("coverage_pct")
    cov = f" · {pct}%" if pct is not None else ""
    if row.get("last_truncated"):
        return f"[yellow]tronca → full[/]{cov}"
    return f"[green]✓ soddisfatto[/]{cov}"


# Fonti col tetto AFFIDABILE = query strutturata (make|model) → la copertura% è vera.
# autoscout (listingsByQueryString, ustate=U) è strutturato → un % basso = buco VERO
# (provato: Audi A3 usato 5555 ma ingeriti 1629 = 29%, tetto-paginazione AS24). subito/moto
# usano count_all/regex free-text (rumoroso: Audi A3 Subito 7194>6830) → NON allarmare.
COVERAGE_TRUSTED_FONTI = {"autoscout"}
COVERAGE_OK_PCT = 85.0   # ≥ soglia = preso il grosso del matchabile → soddisfatto


def cov_state(row: dict) -> str:
    """Badge copertura PER-FONTE (M-J): usa la coverage_pct della RIGA (fonte). Per una
    fonte AFFIDABILE (autoscout, query strutturata) una copertura davvero bassa è un buco
    VERO → '⚠ parziale N%', con **priorità sui flag per-TARGET** (saturo/tronca possono
    venire da un'ALTRA fonte dello stesso target → non devono mascherare il buco — fix
    review F2). Per subito/moto (tetto count_all/regex rumoroso) si resta tolleranti.
    NB: last_truncated/saturated_at sono per-TARGET; coverage_pct è per-fonte."""
    if row.get("last_swept") is None:
        return "[dim]mai[/]"
    pct = row.get("coverage_pct")
    p = float(pct) if pct is not None else None
    # F2: fonte affidabile + copertura BASSA = buco vero → 'parziale' PRIMA dei flag target
    # (un 'saturo'/'tronca' di un'altra fonte non deve nascondere un 29% reale di autoscout).
    if p is not None and p < COVERAGE_OK_PCT and row.get("fonte") in COVERAGE_TRUSTED_FONTI:
        return f"[yellow]⚠ parziale {p:.0f}%[/]"
    if row.get("saturated_at") is not None:
        return "[blue]≈ saturo[/]"            # stabile: 0 nuovi all'ultimo crawl
    if row.get("last_truncated"):
        return "[yellow]tronca → full[/]"     # cap pagine colpito → c'è altro (re-crawl full)
    if p is None:
        return "[green]✓ soddisfatto[/]"      # nessun tetto noto → niente da segnalare
    if p >= 99.5:
        return "[green]✓ 100%[/]"
    return "[green]✓ soddisfatto[/]"          # ≥ soglia, o fonte rumorosa → non allarmare


def suggester_panel(rows: list[dict]) -> Panel:
    """Ex-ramp → SUGGERITORE: prossimi da crawlare (gap noto prima, poi liquidità)."""
    t = Table(expand=True, show_edge=False)
    t.add_column("tipo", style="dim", width=5)
    t.add_column("prossimo da crawlare")
    t.add_column("stato", justify="right")
    for r in rows[:8]:
        t.add_row(safe(r["tipo"]), f"{safe(r['marca'])} {safe(r['modello'])}", sugg_state(r))
    return Panel(t, title=f"Da crawlare · top {min(len(rows), 8)} · [b]s[/] tutti", border_style="yellow")


def last_run_line(lr: dict | None) -> Text:
    if not lr:
        return Text("ultimo crawl iMac: mai avviato", style="dim")
    err = f" · ⚠️ {lr['errors']} errori" if lr.get("errors") else ""
    written = lr.get("written") or 0
    nuovi = lr.get("inserted")
    # M-E onestà: "X nuovi · Y aggiornati" (Y = upsert non-nuovi). Run pre-M-E (inserted
    # NULL) → fallback al vecchio "N scritti" (non sappiamo quanti erano nuovi).
    body = (f"{nuovi:,} nuovi · {max(written - nuovi, 0):,} aggiornati"
            if nuovi is not None else f"{written:,} scritti")
    return Text(f"ultimo crawl iMac: {body} su {lr['targets']} target "
                f"· {_ago(lr.get('finished_at') or lr.get('started_at'))}{err}",
                style="green" if not lr.get("errors") else "yellow")
