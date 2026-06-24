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
        base = Q.queue_counts(db)   # delta sui conteggi → robusto a righe prod preesistenti
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
        # pages (profondità per-run) propagata nel DB
        pid = A.enqueue(db, "auto", SENT, "__qpg__", pages=42)
        assert db.one("SELECT pages FROM crawl_queue WHERE id=%s", (pid,))["pages"] == 42
        # un fail REALE (errore scraper) per distinguerlo dalle cancellazioni
        db.one("INSERT INTO crawl_queue (tipo,marca,modello,status,error) "
               "VALUES ('auto',%s,'__qf__','fail','boom scraper') RETURNING id", (SENT,))
        # queue_counts ONESTO: annullati (id1 + __q2__) separati dal fail reale (__qf__);
        # rid è cancel_requested → conta come 'running'. Delta vs base = contributo del test.
        now = Q.queue_counts(db)
        assert now["annullati"] - base["annullati"] == 2, (base, now)
        assert now["fail"] - base["fail"] == 1, (base, now)
        assert now["running"] - base["running"] == 1, (base, now)
        print("✔ queue scratch OK (enqueue/dedupe/cancel/clear + conteggi onesti, rollback)")
    finally:
        conn.rollback()
        conn.close()


def test_suggestions_ranking() -> None:
    """suggestions(): 'da completare' (gap noto) PRIMA dei mai-crawlati; coverage_pct
    e manca corretti. Scratch tx rolled-back."""
    try:
        conn = psycopg.connect(read_database_url(), autocommit=False, row_factory=dict_row)
    except Exception as e:
        print(f"⤼ SKIP suggestions ranking: DB non raggiungibile ({e})")
        return
    db = Db()
    db._conn = conn
    try:
        # GAP: crawlato, tetto 100, 30 ingeriti attivi → manca 70, coverage 30%
        db.one("INSERT INTO watchlist (tipo,marca,modello,priority,last_swept) "
               "VALUES ('auto',%s,'gap',999999, now()) RETURNING id", (SENT,))
        db.execute("INSERT INTO market_size (tipo,marca,modello,fonte,total) "
                   "VALUES ('auto',%s,'gap','subito',100)", (SENT,))
        for k in range(30):
            db.execute("INSERT INTO listings (url,fonte,tipo,marca,modello,status) "
                       "VALUES (%s,'subito','auto',%s,'gap','active')", (f"__sgurl__{k}", SENT))
        # MAI crawlato, priority altissima (ma deve venire DOPO il gap)
        db.one("INSERT INTO watchlist (tipo,marca,modello,priority) "
               "VALUES ('auto',%s,'fresh',999999) RETURNING id", (SENT,))

        mine = [r for r in Q.suggestions(db, q=SENT, limit=50) if r["marca"] == SENT]
        assert len(mine) == 2, f"attesi 2 sentinel, {len(mine)}"
        assert mine[0]["modello"] == "gap", f"gap-known PRIMA del mai: {[m['modello'] for m in mine]}"
        assert mine[0]["tetto"] == 100 and mine[0]["manca"] == 70 and mine[0]["coverage_pct"] == 30, mine[0]
        assert mine[1]["modello"] == "fresh" and mine[1]["manca"] is None and mine[1]["mai"] is True, mine[1]
        print("✔ suggestions ranking OK (gap-first + coverage/manca, rollback)")
    finally:
        conn.rollback()
        conn.close()


def test_enqueue_canonicalize() -> None:
    """enqueue ad-hoc che combacia col catalogo (case-insensitive) → nome CANONICO +
    watchlist_id agganciato; novel (non in catalogo) → resta ad-hoc. Scratch rollback."""
    try:
        conn = psycopg.connect(read_database_url(), autocommit=False, row_factory=dict_row)
    except Exception as e:
        print(f"⤼ SKIP enqueue canonicalize: DB non raggiungibile ({e})")
        return
    db = Db()
    db._conn = conn
    try:
        M = "TestCanon"   # marca mixed-case → prova il match case-insensitive
        wid = db.one("INSERT INTO watchlist (tipo,marca,modello,last_truncated) "
                     "VALUES ('auto',%s,'Canon',true) RETURNING id", (M,))["id"]
        # ad-hoc MINUSCOLO → deve agganciarsi alla riga catalogo (nome canonico + id + last_truncated)
        qid = A.enqueue(db, "auto", "testcanon", "canon")
        r = db.one("SELECT marca,modello,watchlist_id,last_truncated FROM crawl_queue WHERE id=%s", (qid,))
        assert r["marca"] == M and r["modello"] == "Canon", f"nome non canonicalizzato: {r}"
        assert r["watchlist_id"] == wid, f"watchlist_id non agganciato: {r}"
        assert r["last_truncated"] is True, f"last_truncated dal catalogo non propagato: {r}"
        # NON in catalogo → resta ad-hoc (watchlist_id NULL, nomi as-typed)
        qid2 = A.enqueue(db, "auto", "__novelbrand__", "__novelmod__")
        r2 = db.one("SELECT marca,watchlist_id FROM crawl_queue WHERE id=%s", (qid2,))
        assert r2["marca"] == "__novelbrand__" and r2["watchlist_id"] is None, f"novel non ad-hoc: {r2}"
        print("✔ enqueue canonicalize OK (catalogo → canonico+watchlist_id · novel → ad-hoc)")
    finally:
        conn.rollback()
        conn.close()


if __name__ == "__main__":
    test_validation()
    test_actions_scratch()
    test_autocommit_paths()
    test_queue_scratch()
    test_suggestions_ranking()
    test_enqueue_canonicalize()
    print("\nTEST OK")
