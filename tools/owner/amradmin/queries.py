"""Read layer DB-puro.

Le funzioni "MIRROR:" replicano 1:1 lo SQL dei repo JS (citato) così i numeri del
tool combaciano col server. Le funzioni "NUOVO:" sono analitiche che l'admin web
non ha (coverage marca×regione, gap, ramp ETA, distribuzione prezzi, storico run).
"""
from __future__ import annotations

from .constants import STALE_HOURS

# ─────────────────────────── MIRROR dei repo JS ────────────────────────────


def counts(db) -> dict:
    """MIRROR backend/db/watchlist-repo.js counts(): {total, active, pending}."""
    return db.one(
        """SELECT count(*)::int total,
                  count(*) FILTER (WHERE activated_at IS NOT NULL)::int active,
                  count(*) FILTER (WHERE activated_at IS NULL)::int pending
             FROM watchlist"""
    ) or {"total": 0, "active": 0, "pending": 0}


def node_stats(db) -> list[dict]:
    """MIRROR watchlist-repo.js nodeStats(): per-nodo coda/mai/due/fresco/spenti.

    La finestra 20h è legata a STALE_HOURS via make_interval (= interval '20 hours').
    """
    return db.rows(
        """SELECT COALESCE(assigned_node, 'imac') node,
                  count(*)::int total,
                  count(*) FILTER (WHERE activated_at IS NULL)::int coda,
                  count(*) FILTER (WHERE activated_at IS NOT NULL AND last_swept IS NULL)::int mai,
                  count(*) FILTER (WHERE activated_at IS NOT NULL
                                   AND last_swept < now() - make_interval(hours => %(h)s))::int due,
                  count(*) FILTER (WHERE last_swept >= now() - make_interval(hours => %(h)s))::int fresco,
                  count(*) FILTER (WHERE NOT enabled)::int spenti,
                  max(last_swept) last_swept
             FROM watchlist
            GROUP BY COALESCE(assigned_node, 'imac')
            ORDER BY node""",
        {"h": STALE_HOURS},
    )


def listings_by_fonte(db) -> list[dict]:
    """MIRROR backend/server.js /api/admin/status listingsByFonte."""
    return db.rows(
        """SELECT fonte,
                  count(*)::int total,
                  count(*) FILTER (WHERE status='active')::int active,
                  count(*) FILTER (WHERE status='gone')::int gone
             FROM listings GROUP BY fonte ORDER BY fonte"""
    )


def watchlist_by_node(db) -> list[dict]:
    """MIRROR backend/server.js /api/admin/status watchlistByNode."""
    return db.rows(
        """SELECT COALESCE(assigned_node, 'imac') node,
                  count(*)::int total,
                  count(*) FILTER (WHERE last_swept IS NOT NULL)::int swept
             FROM watchlist GROUP BY COALESCE(assigned_node, 'imac') ORDER BY node"""
    )


def health(db) -> dict:
    """MIRROR backend/db/health-repo.js getHealth(): {ok, blocked[], degraded[], nodi[]}."""
    rows = db.rows("SELECT * FROM crawl_health ORDER BY node, fonte")
    blocked = [f"{r['node']}/{r['fonte']}" for r in rows if r.get("blocked")]
    degraded = [f"{r['node']}/{r['fonte']}" for r in rows if r.get("degraded")]
    return {"ok": not blocked, "blocked": blocked, "degraded": degraded, "nodi": rows}


def last_run(db, node: str = "imac") -> dict | None:
    """MIRROR backend/db/crawl-runs-repo.js lastRun(node). Delega a runs_history
    (stessa proiezione/ORDER BY in un solo posto)."""
    rows = runs_history(db, node, limit=1)
    return rows[0] if rows else None


# ─────────────────────────── NUOVO: analitiche ─────────────────────────────


def runs_history(db, node: str | None = None, limit: int = 20) -> list[dict]:
    """NUOVO: storico run (l'admin mostra solo l'ultimo iMac). idx_crawl_runs_node_started."""
    if node:
        return db.rows(
            """SELECT id, node, started_at, finished_at, targets, written, errors
                 FROM crawl_runs WHERE node=%s ORDER BY started_at DESC LIMIT %s""",
            (node, limit),
        )
    return db.rows(
        """SELECT id, node, started_at, finished_at, targets, written, errors
             FROM crawl_runs ORDER BY started_at DESC LIMIT %s""",
        (limit,),
    )


def coverage_marca_regione(db, tipo: str | None = None, limit: int = 30) -> list[dict]:
    """NUOVO: annunci ATTIVI per marca×regione (assente nell'admin). idx_listings_regione."""
    where = "status='active' AND regione IS NOT NULL"
    params: list = []
    if tipo:
        where += " AND tipo=%s"
        params.append(tipo)
    params.append(limit)
    return db.rows(
        f"""SELECT marca, regione, count(*)::int n
              FROM listings WHERE {where}
             GROUP BY marca, regione ORDER BY n DESC LIMIT %s""",
        params,
    )


def ramp_progress(db, limit: int = 12) -> dict:
    """NUOVO: avanzamento ramp. Coda/attivi globali + i prossimi target NELL'ORDINE
    in cui activateRamp li prenderebbe (MIRROR del suo ORDER BY interleave per tipo).
    NB: activateRamp ha una guardia 1×/20h (watchlist-repo.js:46) → in un giorno in
    cui ha già attivato, NON attiverebbe questi finché non scade la finestra; qui è
    una PREVIEW dell'ordine, non una promessa di attivazione imminente."""
    c = counts(db)
    nxt = db.rows(
        """SELECT tipo, marca, modello, priority
             FROM watchlist
            WHERE activated_at IS NULL AND enabled
            ORDER BY row_number() OVER (PARTITION BY tipo ORDER BY priority DESC NULLS LAST, id), tipo
            LIMIT %s""",
        (limit,),
    )
    return {"total": c["total"], "active": c["active"], "queue": c["pending"], "next": nxt}


def price_distribution(db, tipo: str, marca: str, modello: str) -> dict | None:
    """NUOVO: distribuzione prezzo (n, p25, mediana, p75, min, max) sugli annunci
    ATTIVI di un modello. Nessuna analitica simile nell'admin."""
    return db.one(
        """SELECT count(*)::int n,
                  percentile_cont(0.25) WITHIN GROUP (ORDER BY last_price)::int p25,
                  percentile_cont(0.50) WITHIN GROUP (ORDER BY last_price)::int mediana,
                  percentile_cont(0.75) WITHIN GROUP (ORDER BY last_price)::int p75,
                  min(last_price)::int minimo, max(last_price)::int massimo
             FROM listings
            WHERE status='active' AND last_price IS NOT NULL
              AND tipo=%s AND marca=%s AND modello=%s""",
        (tipo, marca, modello),
    )
