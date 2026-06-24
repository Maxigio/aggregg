"""Renderabili Rich per la dashboard (separati dalla logica Textual → testabili)."""
from __future__ import annotations

from datetime import datetime, timezone

from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from .constants import KNOWN_NODES


def _num(v) -> str:
    """Formatta un intero con separatore migliaia; None → '—' (priority è nullable)."""
    return f"{v:,}" if v is not None else "—"


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
        Text(f"{c['active']:,}", style="bold green"),
        Text(f"{c['pending']:,}", style="bold yellow"),
    )
    t.add_row(Text("target totali", style="dim"), Text("attivi", style="dim"),
              Text("in coda (ramp)", style="dim"))
    return Panel(t, title="Watchlist", border_style="cyan")


def nodes_panel(stats: list[dict], health: dict) -> Panel:
    # salute per (node,fonte) dalle righe crawl_health (NON dai tag rotti dell'admin)
    by_node: dict[str, list[dict]] = {}
    for row in health["nodi"]:
        by_node.setdefault(row["node"], []).append(row)
    stat_by = {s["node"]: s for s in stats}

    t = Table(expand=True, show_edge=False, pad_edge=False)
    t.add_column("nodo", style="bold")
    t.add_column("attività", justify="right")
    t.add_column("stato crawl", justify="left")
    t.add_column("fonti", justify="left")
    for node in KNOWN_NODES:
        s = stat_by.get(node, {})
        tot = s.get("total", 0)
        state = (f"[green]🟢{s.get('fresco',0)}[/] [yellow]🟡{s.get('due',0)}[/] "
                 f"[red]🔴{s.get('mai',0)}[/] [dim]⚪{s.get('coda',0)}[/]")
        pills = []
        for hr in by_node.get(node, []):
            color = "red" if hr.get("blocked") else ("yellow" if hr.get("degraded") else "green")
            pills.append(f"[{color}]{hr['fonte']}[/]")
        label = node + (" [dim](centrale)[/]" if node == "imac" else "")
        t.add_row(label, _ago(s.get("last_swept")) if tot else "—",
                  state if tot else "[dim]0 target[/]", " ".join(pills) or "[dim]—[/]")
    return Panel(t, title="Nodi", border_style="magenta")


def fonti_panel(rows: list[dict]) -> Panel:
    t = Table(expand=True)
    t.add_column("fonte", style="bold")
    t.add_column("attivi", justify="right", style="green")
    t.add_column("venduti", justify="right", style="dim")
    t.add_column("totale", justify="right")
    for r in rows:
        t.add_row(r["fonte"], f"{r['active']:,}", f"{r['gone']:,}", f"{r['total']:,}")
    return Panel(t, title="Annunci per fonte", border_style="blue")


def ramp_panel(rp: dict) -> Panel:
    t = Table(expand=True, show_edge=False)
    t.add_column("tipo", style="dim", width=5)
    t.add_column("prossimo target")
    t.add_column("priority", justify="right", style="cyan")
    for r in rp["next"][:8]:
        t.add_row(r["tipo"], f"{r['marca']} {r['modello']}", _num(r["priority"]))
    pct = (rp["active"] / rp["total"] * 100) if rp["total"] else 0
    title = f"Ramp · attivi {rp['active']:,}/{rp['total']:,} ({pct:.1f}%) · coda {rp['queue']:,}"
    return Panel(t, title=title, border_style="yellow")


def last_run_line(lr: dict | None) -> Text:
    if not lr:
        return Text("ultimo crawl iMac: mai avviato", style="dim")
    err = f" · ⚠️ {lr['errors']} errori" if lr.get("errors") else ""
    return Text(f"ultimo crawl iMac: {lr['written']:,} scritti su {lr['targets']} target "
                f"· {_ago(lr.get('finished_at') or lr.get('started_at'))}{err}",
                style="green" if not lr.get("errors") else "yellow")
