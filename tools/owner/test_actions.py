"""Test delle scritture watchlist (equivalenza/comportamento vs repo JS).
    tools/owner/.venv/bin/python tools/owner/test_actions.py

- Validazione: nessun DB (il raise avviene prima di toccare il db).
- Comportamento: righe SCRATCH (marca '__amrtest__') in una transazione
  ROLLED-BACK → la watchlist vera non viene MAI modificata.
"""
from __future__ import annotations

import psycopg
from psycopg.rows import dict_row

from amradmin import actions as A
from amradmin import queries as Q
from amradmin.db import Db, read_database_url

SENT = "__amrtest__"


def test_validation() -> None:
    assert A.valid_node(None) and A.valid_node("surface") and not A.valid_node("foo")
    # i raise scattano PRIMA dell'uso del db → db=None è sicuro qui
    for call in (
        lambda: A.set_node(None, 1, "foo"),
        lambda: A.assign_many(None, [1], "foo"),
        lambda: A.add_one(None, "camion", "x", "y"),
        lambda: A.add_one(None, "auto", "", "y"),
        lambda: A.auto_distribute(None, ["foo"]),
    ):
        try:
            call()
            assert False, "atteso ValueError"
        except ValueError:
            pass
    print("✔ validazione OK")


def test_actions_scratch() -> None:
    try:
        conn = psycopg.connect(read_database_url(), autocommit=False, row_factory=dict_row)
    except Exception as e:
        print(f"⤼ SKIP scratch: DB non raggiungibile ({e})")
        return
    db = Db()
    db._conn = conn   # inietta la connessione transazionale (test-only)
    node_of = lambda i: db.one("SELECT assigned_node FROM watchlist WHERE id=%s", (i,))["assigned_node"]
    try:
        ids = []
        for tipo, mod in [("auto", "__a1__"), ("auto", "__a2__"), ("moto", "__m1__"), ("moto", "__m2__")]:
            r = db.one("INSERT INTO watchlist (tipo,marca,modello) VALUES (%s,%s,%s) RETURNING id",
                       (tipo, SENT, mod))
            ids.append(r["id"])

        # set_enabled
        A.set_enabled(db, ids[0], False)
        assert db.one("SELECT enabled FROM watchlist WHERE id=%s", (ids[0],))["enabled"] is False

        # set_node + azzera a NULL (=imac) solo se la chiave è presente
        A.set_node(db, ids[0], "surface")
        assert node_of(ids[0]) == "surface"
        A.set_node(db, ids[0], None)
        assert node_of(ids[0]) is None

        # assign_many bulk
        assert A.assign_many(db, ids, "m2")["updated"] == 4
        assert all(node_of(i) == "m2" for i in ids)

        # toggle_enabled atomico (flip sul valore reale)
        e0 = db.one("SELECT enabled FROM watchlist WHERE id=%s", (ids[1],))["enabled"]
        assert A.toggle_enabled(db, ids[1])["enabled"] == (not e0)

        # cycle_node: imac(NULL)→surface→m2→massimo→imac(NULL)
        A.set_node(db, ids[1], None)
        seq = [A.cycle_node(db, ids[1])["assigned_node"] for _ in range(4)]
        assert seq == ["surface", "m2", "massimo", None], seq
        A.assign_many(db, [ids[1]], "m2")   # ripristina per i passi successivi

        # auto_distribute: ids NON vuoti ma tutti non-interi → NO-OP (fix review,
        # non "distribuisci tutti"). Rama come JS su ids.length raw.
        assert A.auto_distribute(db, ["imac", "surface"], ids=["abc", "x"])["total"] == 0

        # add_one idempotente: con None TIENE (COALESCE(NULL,'m2')), con nodo SOVRASCRIVE
        assert A.add_one(db, "auto", SENT, "__a1__", node=None)["assigned_node"] == "m2"
        assert A.add_one(db, "auto", SENT, "__a1__", node="surface")["assigned_node"] == "surface"
        # add_one nuovo
        newr = A.add_one(db, "auto", SENT, "__a3__", node="surface")
        assert newr["assigned_node"] == "surface"
        ids.append(newr["id"])

        # auto_distribute round-robin equo (diff ≤1)
        d = A.auto_distribute(db, ["imac", "surface"], ids)
        assert d["total"] == len(ids)
        counts = [a["count"] for a in d["assignments"]]
        assert max(counts) - min(counts) <= 1

        # remove_one
        assert A.remove_one(db, ids[0]) is True
        assert db.one("SELECT id FROM watchlist WHERE id=%s", (ids[0],)) is None

        # add_candidates: INSERT DO NOTHING + assign del nuovo
        assert A.add_candidates(db, [{"tipo": "moto", "marca": SENT, "modello": "__c1__"}],
                                node="surface")["added"] == 1

        # watchlist_rows filtra il nostro sentinel
        rows = Q.watchlist_rows(db, q=SENT, limit=100)
        assert rows and rows[0]["total"] >= 1
        print("✔ actions scratch OK (rollback → watchlist intatta)")
    finally:
        conn.rollback()
        conn.close()


def test_autocommit_paths() -> None:
    """Path PRODUZIONE (autocommit=True): auto_distribute fa un BEGIN/COMMIT reale,
    non savepoint (il test scratch usa autocommit=False). Righe sentinel + cleanup."""
    db = Db()
    try:
        db.conn()
    except Exception as e:
        print(f"⤼ SKIP autocommit paths: DB non raggiungibile ({e})")
        return
    SENT2 = "__txdist__"
    try:
        ids = [db.one("INSERT INTO watchlist (tipo,marca,modello) VALUES ('auto',%s,%s) RETURNING id",
                      (SENT2, f"__d{i}__"))["id"] for i in range(4)]
        # auto_distribute round-robin su 2 nodi
        d = A.auto_distribute(db, ["imac", "surface"], ids)
        assert d["total"] == 4
        counts = [a["count"] for a in d["assignments"]]
        assert max(counts) - min(counts) <= 1
        assert {db.one("SELECT assigned_node FROM watchlist WHERE id=%s", (i,))["assigned_node"]
                for i in ids} <= {"imac", "surface"}

        # atomicità di db.tx() su autocommit: 2° statement fallisce → 1° rolled back
        before = db.one("SELECT assigned_node FROM watchlist WHERE id=%s", (ids[0],))["assigned_node"]
        try:
            with db.tx():
                db.execute("UPDATE watchlist SET assigned_node='massimo' WHERE id=%s", (ids[0],))
                db.execute("UPDATE watchlist SET priority='NaN'::int WHERE id=%s", (ids[1],))  # boom
            assert False, "atteso errore nel tx"
        except Exception:
            pass
        after = db.one("SELECT assigned_node FROM watchlist WHERE id=%s", (ids[0],))["assigned_node"]
        assert after == before, f"tx NON atomica: {before!r} → {after!r}"
        print("✔ autocommit paths (auto_distribute BEGIN/COMMIT + atomicità) OK")
    finally:
        db.execute("DELETE FROM watchlist WHERE marca=%s", (SENT2,))


def test_queue_scratch() -> None:
    """Scritture coda (enqueue/dedupe/cancel/clear) su righe scratch in tx rolled-back."""
    try:
        conn = psycopg.connect(read_database_url(), autocommit=False, row_factory=dict_row)
    except Exception as e:
        print(f"⤼ SKIP queue scratch: DB non raggiungibile ({e})")
        return
    db = Db()
    db._conn = conn
    try:
        # validazione: tipo errato → ValueError PRIMA del DB
        try:
            A.enqueue(db, "camion", "x", "y"); assert False, "atteso ValueError"
        except ValueError:
            pass
        # enqueue + dedupe (unique parziale: 1 job attivo per tipo,marca,modello)
        id1 = A.enqueue(db, "auto", SENT, "__q1__")
        assert id1
        assert A.enqueue(db, "auto", SENT, "__q1__") is None, "dup attivo → None"
        # enqueue_rows: 1 valida + 1 dup (__q1__ ancora pending) + 1 invalida
        res = A.enqueue_rows(db, [
            {"tipo": "moto", "marca": SENT, "modello": "__q2__"},
            {"tipo": "auto", "marca": SENT, "modello": "__q1__"},      # dup
            {"tipo": "camion", "marca": SENT, "modello": "__q3__"},    # invalida
        ])
        assert res == {"queued": 1, "skipped": 2}, res
        # cancel pending → 'fail'
        assert A.cancel(db, id1) == "fail"
        # cancel di un running → 'cancel_requested'
        rid = db.one("INSERT INTO crawl_queue (tipo,marca,modello,status) "
                     "VALUES ('auto',%s,'__qr__','running') RETURNING id", (SENT,))["id"]
        assert A.cancel(db, rid) == "cancel_requested"
        # clear_pending: __q2__ (pending) → annullato
        assert A.clear_pending(db) >= 1
        assert db.one("SELECT status FROM crawl_queue WHERE marca=%s AND modello='__q2__'",
                      (SENT,))["status"] == "fail"
        print("✔ queue scratch OK (enqueue/dedupe/cancel/clear, rollback)")
    finally:
        conn.rollback()
        conn.close()


if __name__ == "__main__":
    test_validation()
    test_actions_scratch()
    test_autocommit_paths()
    test_queue_scratch()
    print("\nTEST OK")
