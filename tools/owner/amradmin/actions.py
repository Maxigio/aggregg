"""Write layer DB-puro — gestione watchlist.

Ogni funzione RISPECCHIA VERBATIM lo SQL del repo JS (citato): l'equivalenza è
strutturale (stesso statement), oltre che provata da test_actions.py su righe
scratch in transazione rolled-back. Validazione nodo/tipo come fa il server JS
(evita assigned_node orfani che nessun nodo crawlerebbe).
"""
from __future__ import annotations

from .constants import KNOWN_NODES, TIPI

_UNSET = object()


def valid_node(node) -> bool:
    """None (= iMac/NULL) oppure un nodo noto. Fonte: backend/server.js:358 isValidNode."""
    return node is None or node in KNOWN_NODES


def _require_node(node) -> None:
    if not valid_node(node):
        raise ValueError(f"nodo non valido: {node!r} (ammessi: {KNOWN_NODES} o None)")


def _clean_ids(ids) -> list[int]:
    """Solo interi veri (più RIGOROSO del parseInt JS, che farebbe '12abc'→12):
    qui '12abc' viene scartato. Sicuro perché gli id arrivano dal DB/griglia, già
    interi; non replico il footgun di parseInt di proposito."""
    out = []
    for i in ids or []:
        try:
            out.append(int(i))
        except (TypeError, ValueError):
            pass
    return out


def update_one(db, id, *, enabled=_UNSET, assigned_node=_UNSET) -> dict | None:
    """MIRROR watchlist-repo.js updateOne: enabled via COALESCE, assigned_node via
    CASE WHEN set (passare None lo azzera SOLO se la chiave è fornita)."""
    set_node = assigned_node is not _UNSET
    if set_node:
        _require_node(assigned_node)
    return db.one(
        """UPDATE watchlist
              SET enabled = COALESCE(%(en)s, enabled),
                  assigned_node = CASE WHEN %(setnode)s THEN %(node)s ELSE assigned_node END
            WHERE id = %(id)s
            RETURNING id, tipo, marca, modello, assigned_node, enabled""",
        {"id": id,
         "en": None if enabled is _UNSET else enabled,
         "node": assigned_node if set_node else None,
         "setnode": set_node},
    )


def set_enabled(db, id, enabled: bool) -> dict | None:
    return update_one(db, id, enabled=enabled)


def set_node(db, id, node) -> dict | None:
    return update_one(db, id, assigned_node=node)


# Affordance da TUI: flip/avanzamento ATOMICI in SQL (NON un mirror di updateOne).
# Atomici sul valore REALE nel DB → niente read-modify-write da stato a schermo stale.
_RET = "RETURNING id, tipo, marca, modello, assigned_node, enabled"


def toggle_enabled(db, id) -> dict | None:
    """Inverte enabled atomicamente (enabled = NOT enabled)."""
    return db.one(f"UPDATE watchlist SET enabled = NOT enabled WHERE id = %s {_RET}", (id,))


def cycle_node(db, id) -> dict | None:
    """Avanza assigned_node al successivo in KNOWN_NODES (…→massimo→imac=NULL),
    sul valore reale nel DB. CASE costruito dai nomi-nodo (costanti fidate)."""
    order = KNOWN_NODES
    whens = []
    for i, n in enumerate(order):
        nxt = order[(i + 1) % len(order)]
        whens.append(f"WHEN '{n}' THEN {'NULL' if nxt == 'imac' else repr(nxt)}")
    sql = (f"UPDATE watchlist SET assigned_node = "
           f"CASE COALESCE(assigned_node,'imac') {' '.join(whens)} ELSE NULL END "
           f"WHERE id = %s {_RET}")
    return db.one(sql, (id,))


def remove_one(db, id) -> bool:
    """MIRROR removeOne: DELETE (nessuna FK listings→watchlist, i listing restano)."""
    return db.execute("DELETE FROM watchlist WHERE id = %s", (id,)) > 0


def add_one(db, tipo: str, marca: str, modello: str, node=None) -> dict | None:
    """MIRROR addOne: idempotente su (tipo,marca,modello); on-conflict riempie
    assigned_node solo se era NULL (COALESCE)."""
    if tipo not in TIPI:
        raise ValueError(f"tipo non valido: {tipo!r} (ammessi {TIPI})")
    if not marca or not modello:
        raise ValueError("marca e modello obbligatori")
    _require_node(node)
    return db.one(
        """INSERT INTO watchlist (tipo, marca, modello, assigned_node)
               VALUES (%s,%s,%s,%s)
           ON CONFLICT (tipo, marca, modello)
               DO UPDATE SET assigned_node = COALESCE(EXCLUDED.assigned_node, watchlist.assigned_node)
           RETURNING id, tipo, marca, modello, assigned_node, enabled""",
        (tipo, marca, modello, node),
    )


def assign_many(db, ids, node) -> dict:
    """MIRROR assignMany: un UPDATE su molti id (node None = iMac/NULL)."""
    _require_node(node)
    clean = _clean_ids(ids)
    if not clean:
        return {"updated": 0}
    n = db.execute("UPDATE watchlist SET assigned_node = %s WHERE id = ANY(%s::int[])", (node, clean))
    return {"updated": n}


def auto_distribute(db, nodes, ids=None) -> dict:
    """MIRROR autoDistribute: round-robin per (tipo,marca,modello) → mix equo
    auto+moto (diff ≤1). ids assente = tutti gli enabled. TX: 1 UPDATE per nodo."""
    if not nodes:
        return {"assignments": [], "total": 0}
    # distribute richiede nodi ESPLICITI noti (no None) → NON riusare _require_node
    # (che ammette None: introdurrebbe un nodo-target nullo).
    for n in nodes:
        if n not in KNOWN_NODES:
            raise ValueError(f"nodo non valido: {n!r}")
    # MIRROR JS: rama su ids.length RAW (non sul cleaned) → ids non-vuoti ma tutti
    # non-interi danno ANY('{}') = 0 righe (no-op), NON "distribuisci tutti".
    if ids:
        rows = db.rows("SELECT id FROM watchlist WHERE id = ANY(%s::int[]) ORDER BY tipo, marca, modello", (_clean_ids(ids),))
    else:
        rows = db.rows("SELECT id FROM watchlist WHERE enabled = true ORDER BY tipo, marca, modello")
    buckets: list[list[int]] = [[] for _ in nodes]
    for i, r in enumerate(rows):
        buckets[i % len(nodes)].append(r["id"])
    with db.tx():
        for i, node in enumerate(nodes):
            if buckets[i]:
                db.execute("UPDATE watchlist SET assigned_node = %s WHERE id = ANY(%s::int[])", (node, buckets[i]))
    return {"assignments": [{"node": n, "count": len(buckets[i])} for i, n in enumerate(nodes)],
            "total": len(rows)}


def add_candidates(db, items, node=None) -> dict:
    """MIRROR addCandidates: INSERT ON CONFLICT DO NOTHING (NON riassegna gli
    esistenti); assign solo i NUOVI id al nodo."""
    _require_node(node)
    new_ids = []
    for it in items or []:
        tipo, marca, modello = it.get("tipo"), it.get("marca"), it.get("modello")
        if tipo not in TIPI or not marca or not modello:
            continue
        row = db.one(
            """INSERT INTO watchlist (tipo, marca, modello) VALUES (%s,%s,%s)
               ON CONFLICT (tipo, marca, modello) DO NOTHING RETURNING id""",
            (tipo, marca, modello),
        )
        if row:
            new_ids.append(row["id"])
    if new_ids and node:
        assign_many(db, new_ids, node)
    return {"added": len(new_ids)}


# ─────────────────────────── coda crawl (F60) ──────────────────────────────
# La TUI ENQUEUE; il drainer (scripts/crawl-once.js) DRENA. SQL rispecchiato da
# backend/db/crawl-queue-repo.js (enqueue: ON CONFLICT DO NOTHING = 1 job attivo).

def enqueue(db, tipo: str, marca: str, modello: str, *,
            watchlist_id=None, last_truncated=None, priority: int = 0, pages=None) -> int | None:
    """Mette in coda un target. MIRROR crawl-queue-repo.enqueue. Ritorna l'id, o
    None se già in coda/in corso (dedupe via unique parziale). Ad-hoc = watchlist_id None."""
    if tipo not in TIPI:
        raise ValueError(f"tipo non valido: {tipo!r} (ammessi {TIPI})")
    if not marca or not modello:
        raise ValueError("marca e modello obbligatori")
    # Canonicalizzazione: se l'ad-hoc combacia (case-insensitive) con una riga catalogo,
    # usa i suoi nomi CANONICI + watchlist_id → la copertura si aggancia al catalogo (no
    # orfani come 'audi a3' minuscolo che non matchava 'Audi A3'). markSwept dopo il crawl.
    if watchlist_id is None:
        cat = db.one(
            "SELECT id, marca, modello, last_truncated FROM watchlist "
            "WHERE tipo = %s AND lower(marca) = lower(%s) AND lower(modello) = lower(%s) LIMIT 1",
            (tipo, marca, modello))
        if cat:
            marca, modello, watchlist_id = cat["marca"], cat["modello"], cat["id"]
            if last_truncated is None:
                last_truncated = cat["last_truncated"]
    row = db.one(
        """INSERT INTO crawl_queue (tipo, marca, modello, watchlist_id, last_truncated, priority, pages)
               VALUES (%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT DO NOTHING RETURNING id""",
        (tipo, marca, modello, watchlist_id, last_truncated, priority, pages),
    )
    return row["id"] if row else None


def enqueue_rows(db, rows, *, priority: int = 0) -> dict:
    """Enqueue di molte righe (cursore/tutte-mostrate/due). Ogni riga: dict con
    tipo/marca/modello (+ watchlist_id/last_truncated opzionali). Ritorna
    {queued, skipped} (skipped = invalide o duplicati già in coda)."""
    queued = skipped = 0
    for r in rows or []:
        tipo, marca, modello = r.get("tipo"), r.get("marca"), r.get("modello")
        if tipo not in TIPI or not marca or not modello:
            skipped += 1
            continue
        rid = enqueue(db, tipo, marca, modello,
                      watchlist_id=r.get("watchlist_id"),
                      last_truncated=r.get("last_truncated"), priority=priority)
        queued += 1 if rid else 0
        skipped += 0 if rid else 1
    return {"queued": queued, "skipped": skipped}


def cancel(db, id) -> str | None:
    """Annulla un job: pending → 'fail' subito; running → 'cancel_requested' (il
    drainer lo chiude tra un target e l'altro). Ritorna il nuovo stato o None."""
    row = db.one(
        """UPDATE crawl_queue
              SET status = CASE WHEN status='pending' THEN 'fail' ELSE 'cancel_requested' END,
                  error = COALESCE(error, 'annullato'),
                  finished_at = CASE WHEN status='pending' THEN now() ELSE finished_at END
            WHERE id = %s AND status IN ('pending','running')
            RETURNING status""",
        (id,),
    )
    return row["status"] if row else None


def clear_pending(db) -> int:
    """Svuota i pending (stop della coda non ancora partita; il running corrente
    finisce). Ritorna quanti annullati."""
    return db.execute(
        "UPDATE crawl_queue SET status='fail', error='annullato', finished_at=now() WHERE status='pending'")
