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
    for node in KNOWN_NODES:
        s = stat_by.get(node, {})
        tot = s.get("total", 0)
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
                  state if tot else "[dim]0 target[/]", " ".join(pills) or "[dim]—[/]")
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
    """Stato di un suggerimento. Con coverage (market_size): X% + manca. Senza
    ground-truth: 'da crawlare' (+ '(mai)' se proprio mai toccato; altrimenti era
    un vecchio crawl pre-copertura)."""
    pct = row.get("coverage_pct")
    if pct is not None:
        col = "red" if pct < 30 else ("yellow" if pct < 70 else "green")
        return f"[{col}]{pct}%[/] · manca {_num(row.get('manca'))}"
    return "[dim]da crawlare[/]" + (" [dim](mai)[/]" if row.get("mai") else "")


def suggester_panel(rows: list[dict]) -> Panel:
    """Ex-ramp → SUGGERITORE: prossimi da crawlare (gap noto prima, poi liquidità)."""
    t = Table(expand=True, show_edge=False)
    t.add_column("tipo", style="dim", width=5)
    t.add_column("prossimo da crawlare")
    t.add_column("stato", justify="right")
    for r in rows[:8]:
        t.add_row(safe(r["tipo"]), f"{safe(r['marca'])} {safe(r['modello'])}", sugg_state(r))
    return Panel(t, title=f"Da crawlare · top {min(len(rows), 8)} · [s] tutti", border_style="yellow")


def last_run_line(lr: dict | None) -> Text:
    if not lr:
        return Text("ultimo crawl iMac: mai avviato", style="dim")
    err = f" · ⚠️ {lr['errors']} errori" if lr.get("errors") else ""
    return Text(f"ultimo crawl iMac: {lr['written']:,} scritti su {lr['targets']} target "
                f"· {_ago(lr.get('finished_at') or lr.get('started_at'))}{err}",
                style="green" if not lr.get("errors") else "yellow")
