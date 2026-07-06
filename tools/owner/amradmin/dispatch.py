"""Esecuzione di un comando GIÀ parsato (commands.parse_command) → coda crawl.

UNICO posto che lega parse → actions (DB) → drainer (spawn): usato sia dalla
schermata Comandi (M-D) sia da eventuali altri entry-point. Ritorna una stringa
d'esito (già pronta per l'UI). Gira in un thread (psycopg bloccante) con Db PROPRIA
→ nessuna contesa con i refresh live. Lo spawn del drainer resta l'UNICA azione
non-DB (isolata in drainer.py), idempotente via advisory lock.
"""
from __future__ import annotations

from . import actions as A
from . import queries as Q
from . import render as R
from .db import Db
from .drainer import spawn_drainer


def dispatch(parsed: dict) -> str:
    cmd = parsed["cmd"]
    with Db() as db:
        def drainer() -> str:
            # spawn SEMPRE (idempotente via advisory lock) → chiude la race di uscita
            try:
                spawn_drainer()
                return "attivo"
            except Exception as e:
                return f"spawn KO ({e})"
        if cmd == "run":
            pg = parsed.get("pages")
            rid = A.enqueue(db, parsed["tipo"], parsed["marca"], parsed["modello"], pages=pg)
            depth = R.depth_label(pg)
            if not rid:
                # già attivo: se 'pending', enqueue ha AGGIORNATO la profondità (override
                # esplicito) → dillo, non far credere che il depth sia stato ignorato.
                # review: rilancia comunque il drainer (idempotente via advisory lock): se il job
                # è 'pending' ma il drainer precedente è morto, senza questo resterebbe fermo.
                extra = f" — profondità → {depth}" if pg is not None else ""
                return f"già in coda: {parsed['marca']} {parsed['modello']}{extra} · drainer {drainer()}"
            return f"in coda: {parsed['tipo']} {parsed['marca']} {parsed['modello']} ({depth}) · drainer {drainer()}"
        if cmd == "run_due":
            res = A.enqueue_rows(db, Q.due_targets(db))
            if not res["queued"]:
                return f"niente di 'due' ora (dup {res['skipped']})"
            return f"due in coda: {res['queued']} (dup {res['skipped']}) · drainer {drainer()}"
        if cmd == "add":
            # aggiunge al catalogo watchlist (no crawl, no drainer).
            tipo, marca, modello = parsed["tipo"], parsed["marca"], parsed["modello"]
            # idempotenza CASE-insensitive: la UNIQUE(tipo,marca,modello) è case-sensitive →
            # 'Audi A3' e 'audi a3' sarebbero 2 righe. Se esiste già una variante-maiuscole,
            # NON creare il doppione: riporta il canonico (come fa la canonicalizzazione di :run).
            cat = db.one(
                "SELECT id, marca, modello FROM watchlist "
                "WHERE tipo=%s AND lower(marca)=lower(%s) AND lower(modello)=lower(%s) "
                "ORDER BY id LIMIT 1", (tipo, marca, modello))
            if cat:
                return f"già in watchlist: {tipo} {cat['marca']} {cat['modello']} (id {cat['id']}) · ':run' per crawlarlo"
            row = A.add_one(db, tipo, marca, modello)
            if not row:
                return "errore: target non aggiunto"
            return f"in watchlist: {row['tipo']} {row['marca']} {row['modello']} (id {row['id']}) · ':run' per crawlarlo"
        if cmd == "clear":
            return f"coda svuotata: {A.clear_pending(db)} pending annullati"
        if cmd == "cancel":
            st = A.cancel(db, parsed["id"])
            return f"job {parsed['id']}: {st or 'non trovato/non attivo'}"
    return "comando ignoto"
