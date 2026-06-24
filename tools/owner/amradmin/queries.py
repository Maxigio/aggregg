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


def watchlist_rows(db, *, q: str | None = None, tipo: str | None = None,
                   node: str | None = None, limit: int = 500) -> list[dict]:
    """NUOVO: griglia watchlist FILTRABILE server-side (l'admin caricava tutto
    client-side: con 14k righe non regge). `annunci` via subquery correlata
    sull'indice idx_listings_browse (no GROUP BY su 200k). count(*) OVER() = totale
    che matcha PRIMA del LIMIT. node 'imac' = assigned_node NULL o 'imac' (COALESCE)."""
    where = ["TRUE"]
    params: dict = {"limit": limit}
    if q:
        where.append("(w.marca ILIKE %(q)s OR w.modello ILIKE %(q)s)")
        params["q"] = f"%{q}%"
    if tipo:
        where.append("w.tipo = %(tipo)s")
        params["tipo"] = tipo
    if node:
        where.append("COALESCE(w.assigned_node, 'imac') = %(node)s")
        params["node"] = node
    return db.rows(
        f"""SELECT w.id, w.tipo, w.marca, w.modello, w.assigned_node, w.enabled,
                   w.activated_at, w.last_swept, w.priority, w.leased_until,
                   (SELECT count(*) FROM listings l
                      WHERE l.tipo=w.tipo AND l.marca=w.marca AND l.modello=w.modello)::int annunci,
                   count(*) OVER()::int total
              FROM watchlist w
             WHERE {' AND '.join(where)}
             ORDER BY w.tipo, w.marca, w.modello
             LIMIT %(limit)s""",
        params,
    )


def access_log(db, *, role: str | None = None, event: str | None = None,
               event_like: str | None = None, limit: int = 200) -> list[dict]:
    """NUOVO: log eventi/accessi (scritti dal server, tabella access_log). Eventi
    recenti filtrabili per ruolo/evento. `query` torna come dict (JSONB)."""
    where = ["TRUE"]
    params: dict = {"limit": limit}
    if role:
        where.append("role = %(role)s")
        params["role"] = role
    if event:
        where.append("event = %(event)s")
        params["event"] = event
    if event_like:
        where.append("event LIKE %(el)s")
        params["el"] = event_like
    return db.rows(
        f"""SELECT id, ts, event, role, ip, user_agent, query, result_count
              FROM access_log WHERE {' AND '.join(where)}
             ORDER BY ts DESC LIMIT %(limit)s""",
        params,
    )


def coverage(db, *, fonte: str | None = None, limit: int = 200) -> list[dict]:
    """NUOVO: copertura ground-truth per (target,fonte). Tetto = latest `market_size`
    (scritto dal crawler), ingeriti = `count(listings)` per fonte, % e quanto MANCA.
    Ordinato per copertura PEGGIORE (dove siamo più incompleti)."""
    where = ""
    params: dict = {"limit": limit}
    if fonte:
        where = "WHERE m.fonte = %(fonte)s"
        params["fonte"] = fonte
    return db.rows(
        f"""WITH latest AS (
              SELECT DISTINCT ON (tipo, marca, modello, fonte)
                     tipo, marca, modello, fonte, total, ts
                FROM market_size
               ORDER BY tipo, marca, modello, fonte, ts DESC)
            SELECT m.tipo, m.marca, m.modello, m.fonte, m.total AS tetto, m.ts,
                   i.n AS ingeriti,
                   CASE WHEN m.total > 0 THEN round(100.0 * i.n / m.total, 1) END AS coverage_pct,
                   greatest(m.total - i.n, 0) AS manca
              FROM latest m
              CROSS JOIN LATERAL (
                   SELECT count(*)::int n FROM listings l
                    WHERE l.fonte = m.fonte AND l.tipo = m.tipo
                      AND l.marca = m.marca AND l.modello = m.modello) i
              {where}
             ORDER BY coverage_pct ASC NULLS FIRST, m.total DESC
             LIMIT %(limit)s""",
        params,
    )


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
