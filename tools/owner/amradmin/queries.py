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
        """SELECT COALESCE(w.assigned_node, 'imac') node,
                  count(*)::int total,
                  count(*) FILTER (WHERE w.activated_at IS NULL)::int coda,
                  count(*) FILTER (WHERE w.activated_at IS NOT NULL AND w.last_swept IS NULL)::int mai,
                  count(*) FILTER (WHERE w.activated_at IS NOT NULL
                                   AND w.last_swept < now() - make_interval(hours => %(h)s))::int due,
                  count(*) FILTER (WHERE w.last_swept >= now() - make_interval(hours => %(h)s))::int fresco,
                  count(*) FILTER (WHERE NOT w.enabled)::int spenti,
                  max(w.last_swept) last_swept,
                  max(cr.last_run) last_run            -- ultimo CRAWL reale del nodo (crawl_runs), non la freschezza catalogo
             FROM watchlist w
             LEFT JOIN (SELECT node, max(started_at) last_run FROM crawl_runs GROUP BY node) cr
               ON cr.node = COALESCE(w.assigned_node, 'imac')
            GROUP BY COALESCE(w.assigned_node, 'imac')
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


def suggestions(db, *, q: str | None = None, limit: int = 300) -> list[dict]:
    """NUOVO (ex-ramp → SUGGERITORE): prossimi target da crawlare. 'Da completare'
    (gap noto da market_size, manca>0) PRIMA, ordinati per `manca` desc; poi 'da
    scoprire' (mai-crawlati) per liquidità brand (priority). Esclude i completi
    (manca=0) e i già in coda. Tasto g/G per accodarli. Coverage-driven, dati veri."""
    where = ["w.enabled"]
    params: dict = {"limit": limit}
    if q:
        where.append("(w.marca ILIKE %(q)s OR w.modello ILIKE %(q)s)")
        params["q"] = f"%{q}%"
    return db.rows(
        f"""WITH latest AS (
              SELECT DISTINCT ON (tipo, marca, modello, fonte) tipo, marca, modello, fonte, total
                FROM market_size ORDER BY tipo, marca, modello, fonte, ts DESC),
            ms AS (
              SELECT l.tipo, l.marca, l.modello,
                     sum(l.total)::int tetto,
                     sum(greatest(l.total - COALESCE(i.n, 0), 0))::int manca
                FROM latest l
                CROSS JOIN LATERAL (
                     SELECT count(*)::int n FROM listings li
                      WHERE li.fonte = l.fonte AND li.tipo = l.tipo
                        AND li.marca = l.marca AND li.modello = l.modello
                        AND li.status = 'active') i
               GROUP BY l.tipo, l.marca, l.modello)
            SELECT w.id, w.tipo, w.marca, w.modello, w.priority, w.last_swept, w.last_truncated,
                   ms.tetto, ms.manca,
                   CASE WHEN ms.tetto > 0 THEN round(100.0 * (ms.tetto - ms.manca) / ms.tetto)::int END coverage_pct,
                   (w.last_swept IS NULL) AS mai
              FROM watchlist w
              LEFT JOIN ms ON ms.tipo = w.tipo AND ms.marca = w.marca AND ms.modello = w.modello
             WHERE {' AND '.join(where)}
               AND COALESCE(ms.manca, 1) > 0          -- escludi i completi (manca=0); i mai-crawlati (ms NULL) restano
               AND NOT EXISTS (SELECT 1 FROM crawl_queue cq
                                WHERE cq.tipo = w.tipo AND cq.marca = w.marca AND cq.modello = w.modello
                                  AND cq.status IN ('pending','running','cancel_requested'))
             ORDER BY (ms.manca IS NOT NULL) DESC,     -- da completare (gap noto) prima
                      ms.manca DESC NULLS LAST,
                      w.priority DESC NULLS LAST, w.id
             LIMIT %(limit)s""",
        params,
    )


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
                   w.activated_at, w.last_swept, w.last_truncated, w.priority, w.leased_until,
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
    (scritto dal crawler, = annunci VIVI sulla fonte ora), ingeriti = `count(listings
    ATTIVI)` per fonte → confronto omogeneo: i `gone` archiviati NON gonfiano la copertura
    né azzerano `manca`. coverage_pct clampato a 100 (residua staleness del tetto). Ordinato
    per copertura PEGGIORE; i tetto=0 (niente da crawlare) vanno in CODA (NULLS LAST)."""
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
                   CASE WHEN m.total > 0 THEN least(round(100.0 * i.n / m.total, 1), 100) END AS coverage_pct,
                   greatest(m.total - i.n, 0) AS manca
              FROM latest m
              CROSS JOIN LATERAL (
                   SELECT count(*)::int n FROM listings l
                    WHERE l.fonte = m.fonte AND l.tipo = m.tipo
                      AND l.marca = m.marca AND l.modello = m.modello
                      AND l.status = 'active') i
              {where}
             ORDER BY coverage_pct ASC NULLS LAST, m.total DESC
             LIMIT %(limit)s""",
        params,
    )


def crawl_queue(db, *, limit: int = 200) -> list[dict]:
    """NUOVO: coda crawl manuale. Attivi (running, poi pending per priorità/FIFO) in
    cima, poi i conclusi recenti. Per la CrawlQueueScreen live. Scritta da TUI
    (enqueue) + drainer (scripts/crawl-once.js)."""
    return db.rows(
        """SELECT id, tipo, marca, modello, status, priority, watchlist_id,
                  enqueued_at, started_at, finished_at, written, error
             FROM crawl_queue
            ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1
                                 WHEN 'cancel_requested' THEN 1 ELSE 2 END,
                     priority DESC,
                     COALESCE(finished_at, started_at, enqueued_at) DESC
            LIMIT %(limit)s""",
        {"limit": limit},
    )


def queue_counts(db) -> dict:
    """Conteggi coda per stato (pending → ETA = pending × ~27s). Le cancellazioni
    (status='fail' con error 'annullato…') sono contate a parte da `fail` reali → conteggi onesti."""
    return db.one(
        """SELECT count(*) FILTER (WHERE status='pending')::int                  AS pending,
                  count(*) FILTER (WHERE status IN ('running','cancel_requested'))::int AS running,
                  count(*) FILTER (WHERE status='done')::int                     AS done,
                  count(*) FILTER (WHERE status='fail' AND error LIKE %(canc)s)::int AS annullati,
                  count(*) FILTER (WHERE status='fail' AND (error IS NULL OR error NOT LIKE %(canc)s))::int AS fail
             FROM crawl_queue""",
        {"canc": "annullato%"},
    ) or {"pending": 0, "running": 0, "done": 0, "fail": 0, "annullati": 0}


def due_targets(db, *, limit: int = 1000) -> list[dict]:
    """MIRROR backend/db/watchlist-repo.js dueTargets('imac'): attivati, enabled,
    mai-swept o >STALE_HOURS, non leased, nodo imac/NULL. Per il comando `:run due`."""
    return db.rows(
        f"""SELECT id AS watchlist_id, tipo, marca, modello, last_truncated
              FROM watchlist
             WHERE activated_at IS NOT NULL AND enabled = true
               AND (last_swept IS NULL OR last_swept < now() - interval '{STALE_HOURS} hours')
               AND (leased_until IS NULL OR leased_until < now())
               AND (assigned_node = 'imac' OR assigned_node IS NULL)
             ORDER BY last_swept NULLS FIRST, id
             LIMIT %(limit)s""",
        {"limit": limit},
    )


def drainer_alive(db) -> bool:
    """True se un drainer tiene l'advisory lock (key 414260060). Best-effort:
    per advisory bigint < 2^32, pg_locks → classid=0, objid=key, objsubid=1."""
    try:
        r = db.one(
            "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 "
            "AND objid=414260060 AND objsubid=1 LIMIT 1")
        return r is not None
    except Exception:
        return False


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
